import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions.js";
import type { AppConfig, AuthorConfig } from "../../config.js";
import {
  buildDslUserPrompt,
  buildSystemContext,
  serializeStoryContext,
  type ContextInput,
  type DslContextInput,
} from "../../story/context-builder.js";
import { toModelCatalog } from "../../core/assets/catalog.js";
import type { AssetCatalog, ModelAssetCatalog } from "../../core/assets/types.js";
import type { VisualState } from "../../core/presentation/types.js";
import { StreamLineDecoder } from "../../core/protocol/gal-dsl/stream-decoder.js";
import { parseDslLine } from "../../core/protocol/gal-dsl/line-parser.js";
import { DslSegmentParser } from "../../core/protocol/gal-dsl/segment-validator.js";
import {
  repairDslClosingLine,
  repairSwappedVisualSlots,
} from "../../core/protocol/gal-dsl/closing-repair.js";
import {
  DslProtocolError,
  formatDslErrorDetail,
  type DslLine,
  type EventGroupDraft,
  type SegmentEndReason,
  type SegmentEndStatus,
} from "../../core/protocol/gal-dsl/types.js";
import type { InstructionSet, PromptBundle } from "../../prompts.js";
import type { LLMRequestCounts } from "../../runtime/metrics.js";
import { Metrics } from "../../runtime/metrics.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  StoryContextEvent,
} from "../../schema.js";
import type { GenerationEnvelope, StoryState } from "../../story/types.js";
import {
  createGenerationHandle,
  type BranchPrefetchRequest,
  type ContinuationRequest,
  type GenerationHandle,
  type InputBridgeRequest,
  type InputResponseRequest,
  type OpeningRequest,
  type StoryGeneratorPort,
} from "../../core/ports/story-generator-port.js";

// ---------------------------------------------------------------------------
// Tiny template engine: replace {key} placeholders with values
// ---------------------------------------------------------------------------

function fill(template: string, vars: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

/**
 * Fresh 4-hex-char generation nonce for the DSL `@end <nonce> <reason>`
 * sentinel (docs/llm-outputs-refactor.md §45). Randomized per request so a
 * stale sentinel from a previous attempt can never satisfy this one.
 */
export function generateNonce(): string {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
}

export interface GenerationStreamOptions {
  /**
   * Called as soon as one complete EventGroup is committed and forwarded
   * (docs §36). The runtime may publish it immediately; a later failure
   * then preserves the already-forwarded prefix.
   */
  onGroup?: (group: EventGroupDraft) => void;
  /** Called once when the segment ends cleanly (docs §44–§51). */
  onSegmentEnd?: (status: SegmentEndStatus) => void;
  /**
   * §8.5: concrete reason for a Game-level repair (e.g. an interaction that
   * violated InteractionPolicy AFTER playable events were already published).
   * The Game repair loop passes the failing segment's error message here so
   * the model sees why its previous output was rejected; it is embedded in
   * the user prompt alongside provider-internal retry instructions.
   */
  repairReason?: string;
  /**
   * DSL mode: visual state at the tail the model continues from; serialized
   * into the user prompt as TAIL_VISUAL_STATE (docs §70).
   */
  tailVisualState?: VisualState;
  /**
   * Per-turn director briefing (actor-briefing product) rendered in the
   * in the user prompt (docs narrative-director §Task-10).
   */
  briefing?: string;
}

/**
 * Strip-and-continue 第二层修复（2026-09-17 设计定稿，自 campus 线移植）。
 *
 * 原则：任何以 @ 开头的残句都不允许影响玩家可见内容；无法解析的 @ 行不再
 * 直接断流报废，而是把该行从模型输出中剔除，然后利用模型的前缀续写能力
 * 补全后续内容。同一 DslSegmentParser 实例贯穿续写——待提交的舞台提示与
 * 打开中的表单状态原样存活（这是相对 fail→运行时修复链的核心增益）。
 *
 * 预算：每 attempt 最多剔除 1 次，防止模型反复写出同一坏行造成剔除循环；
 * 预算耗尽回退到原有的 rejectLine（retry/fail）路径。首行即坏（无可续写
 * 前缀）也回退原路径——空 assistant 前缀等于整段重发，徒增一跳。
 * （campus 的跨流 usage 折叠与 monitor 修复上报为 campus 专属，移植时剥离。）
 */

/** 允许剔除续写的错误码白名单：@ 锚定的、续写语义可恢复的失败。 */
const STRIP_CONTINUE_CODES: ReadonlySet<string> = new Set([
  "UNKNOWN_COMMAND",
  "INVALID_CH_CUE",
  "UNKNOWN_LINE",
  "EMPTY_FORM_PROMPT",
  // closeOpenInteraction 对"开了但零选项/零输入"的表单抛 EMPTY_FORM：
  // 剔除该行交续写补全表单（2026-09-17 独立审计 G3）。
  "EMPTY_FORM",
  "FORM_LINE_OUTSIDE_FORM",
  "FORM_END_WITHOUT_OPEN",
  "SENTINEL_MISSING_REASON",
  "SENTINEL_INVALID_REASON",
  "SENTINEL_NONCE_MISMATCH",
  "RETIRED_ALIAS",
]);

/**
 * Build the user-turn instruction that rides with the assistant raw-prefix
 * continuation after a line was stripped. The model sees its own exact
 * output (minus the offending line) and continues from the cut.
 */
function buildStripContinueInstruction(
  error: DslProtocolError,
  nonce: string,
  allowedReasons: readonly SegmentEndReason[],
): string {
  const parts = [
    "你上一段输出中有一行无法通过校验，系统已把它从你的输出中删除，输出在删除处中断。",
    `错误：${error.message}`,
  ];
  if (error.detail?.cause !== undefined) parts.push(`原因：${error.detail.cause}`);
  if (error.detail?.expected !== undefined) parts.push(`期望格式：${error.detail.expected}`);
  if (error.detail?.fix !== undefined) parts.push(`修正：${error.detail.fix}`);
  parts.push(
    [
      "请从删除位置直接续写：补全该处应有的合法内容，然后完成本段剩余部分。",
      "若是交互表单：@? 与提示文本必须写在同一行（`@? 提示文本`），随后写 @+ 选项行（2–5 个），最后用 @/? 收尾。",
      `最后必须逐字输出结束哨兵：@end ${nonce} ${allowedReasons.join("/")}。`,
      "不要重复删除位置之前已输出的任何内容，也不要再次输出被删除的那一行。",
    ].join("\n"),
  );
  return parts.join("\n");
}

/**
 * Terminal state of ONE streaming attempt. The retry policy (repair
 * instruction synthesis, attempt budget) lives one level up in
 * requestDslEnvelope; the mapping is:
 * - complete → resolve with the envelope;
 * - retry    → nothing forwarded yet, next attempt gets `reason` embedded;
 * - fail     → a forwarded prefix exists, the runtime repairs from the
 *   committed boundary (docs §8.5, §49).
 */
type DslAttemptOutcome =
  | { kind: "complete"; envelope: GenerationEnvelope }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; error: Error };

// ---------------------------------------------------------------------------
// StoryGenerator
// ---------------------------------------------------------------------------

export class StoryGenerator {
  private readonly client: OpenAI;
  private readonly systemPrompt: string;
  private readonly prompts: PromptBundle;
  private readonly instructions: InstructionSet;
  /** Model-facing asset catalog projection (logical ids only, docs §59). */
  private readonly modelCatalog: ModelAssetCatalog | undefined;
  /** Registered speaker names (script names + character ids) — gates the
   * full-width-colon dialogue normalization in the DSL line parser. */
  private readonly knownSpeakers: ReadonlySet<string> | undefined;

  constructor(
    private readonly config: AppConfig,
    prompts: PromptBundle,
    instructions: InstructionSet,
    apiKey: string,
    private readonly authorConfig?: AuthorConfig,
    private readonly metrics?: Metrics,
    catalog?: AssetCatalog,
  ) {
    this.client = new OpenAI({
      apiKey,
      ...(config.api.base_url ? { baseURL: config.api.base_url } : {}),
      timeout: config.api.timeout_ms,
    });
    this.prompts = prompts;
    this.instructions = instructions;
    this.systemPrompt = buildSystemContext(
      this.makeCtx(null as unknown as StoryState, []),
    );
    this.modelCatalog = catalog ? toModelCatalog(catalog) : undefined;
    if (catalog !== undefined) {
      const speakers = new Set<string>();
      for (const [characterId, binding] of Object.entries(catalog.characters)) {
        speakers.add(binding.scriptName);
        speakers.add(characterId);
      }
      this.knownSpeakers = speakers;
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Build a ContextInput, handling exactOptionalPropertyTypes for authorConfig. */
  private makeCtx(state: StoryState, recentEvents: StoryContextEvent[]): ContextInput {
    const ctx: ContextInput = {
      prompts: this.prompts,
      state,
      recentEvents,
    };
    if (this.authorConfig) {
      ctx.authorConfig = this.authorConfig;
    }
    return ctx;
  }

  /** Build the DSL-mode context input (docs §70). */
  private buildDslCtx(
    state: StoryState,
    recentEvents: StoryContextEvent[],
    taskType: string,
    nonce: string,
    options?: GenerationStreamOptions,
  ): DslContextInput {
    const ctx: DslContextInput = {
      ...this.makeCtx(state, recentEvents),
      taskType,
      generationNonce: nonce,
      targetLines: this.config.text_buffer.target_lines,
    };
    if (options?.tailVisualState) {
      ctx.tailVisualState = options.tailVisualState;
    }
    if (options?.briefing !== undefined && options.briefing !== "") {
      ctx.actorBriefing = options.briefing;
    }
    if (this.modelCatalog) {
      ctx.modelAssetCatalog = this.modelCatalog;
    }
    return ctx;
  }

  generateOpening(
    turn: number,
    state: StoryState,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, [], "opening", nonce, options);
    return this.requestDslEnvelope(
      "opening",
      "opening",
      ["buffer", "interaction", "ending"],
      nonce,
      buildDslUserPrompt(turn, ctx, fill(this.instructions.opening, { nonce })),
      signal,
      options,
    );
  }

  generateBranchPrefetch(
    turn: number,
    state: StoryState,
    history: StoryContextEvent[],
    choice: ChoiceEvent,
    option: ChoiceOption,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, history, "branch_prefetch", nonce, options);
    const extra = fill(this.instructions.branch_prefetch, {
      choice_prompt: choice.prompt,
      option_text: JSON.stringify(option),
      min_dialogue: String(this.config.prefetch.branch_dialogue_lines),
      nonce,
    });
    return this.requestDslEnvelope(
      "branch_prefetch",
      "branch_prefetch",
      ["buffer"],
      nonce,
      buildDslUserPrompt(turn, ctx, extra),
      signal,
      options,
    ).then((envelope) => {
      const dialogueCount = (envelope.groups ?? []).filter(
        (group) => group.main.type === "dialogue",
      ).length;
      if (dialogueCount < this.config.prefetch.branch_dialogue_lines) {
        throw new Error(
          `分支预取片段只包含 ${dialogueCount} 条台词，至少需要 ${this.config.prefetch.branch_dialogue_lines} 条。`,
        );
      }
      return envelope;
    });
  }

  generateInputResponse(
    turn: number,
    state: StoryState,
    history: StoryContextEvent[],
    interaction: InteractionEvent,
    playerInput: string,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, history, "input_response", nonce, options);
    const extra = fill(this.instructions.input_response, {
      interaction_prompt: interaction.prompt,
      player_input: playerInput,
      nonce,
    });
    return this.requestDslEnvelope(
      "continuation",
      "input_response",
      ["buffer"],
      nonce,
      buildDslUserPrompt(turn, ctx, extra),
      signal,
      options,
    ).then((envelope) => {
      const dialogueCount = (envelope.groups ?? []).filter(
        (group) => group.main.type === "dialogue",
      ).length;
      if (dialogueCount < 1) {
        throw new Error(`输入回应片段只包含 ${dialogueCount} 条台词，至少需要 1 条。`);
      }
      return envelope;
    });
  }

  /**
   * Generate the scene-transition narration played after the player
   * confirms a free-text input and before the NPC response arrives
   * (docs §32–§34). Prefetched as a separate task from the interaction.
   */
  generateInputBridge(
    turn: number,
    state: StoryState,
    interaction: InteractionEvent,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, [], "input_bridge", nonce, options);
    const extra = fill(this.instructions.input_bridge, {
      interaction_prompt: interaction.prompt,
      nonce,
    });
    return this.requestDslEnvelope(
      "continuation",
      "input_bridge",
      ["buffer"],
      nonce,
      buildDslUserPrompt(turn, ctx, extra),
      signal,
      options,
    );
  }

  generateContinuation(
    turn: number,
    state: StoryState,
    history: StoryContextEvent[],
    prefetchedEvents: StoryContextEvent[],
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, history, "continuation", nonce, options);
    let extra = fill(this.instructions.continuation, {
      nonce,
      target_lines: String(this.config.text_buffer.target_lines),
      prefetched: serializeStoryContext(prefetchedEvents),
    });
    return this.requestDslEnvelope(
      "continuation",
      "continuation",
      ["buffer", "interaction", "ending"],
      nonce,
      buildDslUserPrompt(turn, ctx, extra),
      signal,
      options,
    );
  }

  /**
   * Repair prompt appended on retries: the provider-internal failure and the
   * Game-level repair reason (docs §47–§48).
   */
  private buildRepairInstruction(lastError: string, repairReason?: string): string {
    const parts = [lastError, repairReason].filter((reason): reason is string =>
      Boolean(reason),
    );
    if (parts.length === 0) return "";
    // Wording matters per path: this request carries no assistant replay,
    // so for provider-internal retries the model cannot see its previous
    // output — asking it to "continue from where it failed" would push it
    // to start mid-segment. Only the Game-level path serializes the failed
    // segment's playable events into the user prompt, where continuing
    // from the failure point is meaningful.
    return `\n${[
      lastError
        ? // With a Game-level repairReason the user prompt serializes the
          // failed segment's playable prefix, so continuing from the
          // failure point is meaningful for BOTH reasons; without it the
          // model never saw its previous output and must re-emit whole.
          `上一份输出出错：${lastError}。请修正该问题${
            repairReason
              ? "后从失败位置继续，不要重复已输出的内容。"
              : "，重新完整输出本段全部内容（不要省略开头）。"
          }`
        : "",
      repairReason
        ? `上一份输出出错：${repairReason}。请修正该问题后从失败位置继续，不要重复已输出的内容。`
        : "",
    ]
      .filter(Boolean)
      .join("\n")}`;
  }

  /** OpenAI streaming request body (DeepSeek thinking toggle as TOP-LEVEL field). */
  private buildStreamRequest(
    maxTokens: number,
    userContent: string,
  ): ChatCompletionCreateParamsStreaming {
    return {
      model: this.config.api.model,
      temperature: this.config.generation.temperature,
      ...(this.config.api.token_limit_field === "max_tokens"
        ? { max_tokens: maxTokens }
        : { max_completion_tokens: maxTokens }),
      ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
      messages: [
        { role: "system" as const, content: this.systemPrompt },
        { role: "user" as const, content: userContent },
      ],
      stream: true,
    };
  }

  /**
   * DSL-mode streaming request (docs §40–§51).
   *
   * Retry-policy layer: drives per-attempt `attemptDslStream` and decides
   * between repair-and-retry, fail-preserving-prefix, and success. All
   * error strings are load-bearing — they double as the repair instruction
   * for the next attempt and are asserted by tests verbatim.
   */
  private async requestDslEnvelope(
    type: LLMRequestCounts extends Record<infer K, number> ? K : never,
    taskType: string,
    allowedReasons: readonly SegmentEndReason[],
    nonce: string,
    userPrompt: string,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    let lastError = "";
    const attempts = this.config.generation.repair_attempts + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // On retry: add repair instruction describing the previous failure
      // (provider-internal `lastError` and/or Game-level options.repairReason).
      const repairInstruction = this.buildRepairInstruction(lastError, options?.repairReason);

      const outcome = await this.attemptDslStream(
        type,
        taskType,
        allowedReasons,
        nonce,
        `${userPrompt}${repairInstruction}`,
        signal,
        options,
        lastError,
      );
      if (outcome.kind === "complete") return outcome.envelope;
      if (outcome.kind === "fail") throw outcome.error;
      lastError = outcome.reason;
    }

    throw new Error(`模型输出连续校验失败：${lastError}`);
  }

  /**
   * One streaming attempt: send the request, decode SSE chunks into
   * complete DSL lines, parse/validate incrementally, and forward committed
   * EventGroupDrafts via options.onGroup. A structurally invalid line is —
   * while whitelisted and budget remains — STRIPPED and the model asked to
   * continue from the exact cut with the SAME parser instance
   * (strip-and-continue; committed groups, pending cues and any open form
   * survive). Budget spent / not eligible: with already-forwarded groups the
   * attempt FAILS (the runtime preserves the prefix), otherwise it is
   * repairable → retry. A truncated tail without a trailing newline is
   * dropped (docs §49–§50).
   */
  private async attemptDslStream(
    type: LLMRequestCounts extends Record<infer K, number> ? K : never,
    taskType: string,
    allowedReasons: readonly SegmentEndReason[],
    nonce: string,
    userPrompt: string,
    signal: AbortSignal | undefined,
    options: GenerationStreamOptions | undefined,
    /** Failure reason of the PREVIOUS attempt — only for the err= log field. */
    priorFailure: string,
  ): Promise<DslAttemptOutcome> {
    const maxTokens = this.config.generation.max_tokens;
    const callStart = Date.now();
    let firstLineMs = 0;
    let lineIndex = 0;
    let streamChars = 0;
    const allGroups: EventGroupDraft[] = [];
    let streamAborted = false;
    let failureReason = "";
    let usage = { input: 0, output: 0 };

    // Strip-continue state: the raw model lines consumed so far (the
    // continuation replays them verbatim as an assistant prefix), a deferred
    // bare `@?` awaiting its next line, and the per-attempt strip budget.
    const rawLines: string[] = [];
    let pendingFormStart: { lineIndex: number; rawIndex: number } | null = null;
    let stripBudget = 1;
    // ending 哨兵的 epilogue 窗口收齐（@ending 已捕获或窗口被杂行关闭）后
    // 置位：此后的一切都是结局残留，不解析、不触发修复。
    let endingSettled = false;
    // Which SSE stream is currently authoritative; the outer abort signal
    // always bridges to the active one (a strip-continue swaps controllers).
    let activeController = new AbortController();
    const onAbort = () => activeController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    // Original error behind a mid-stream abort. Chained as the `cause` of
    // the wrap thrown to the runtime so error-class detection survives it.
    let streamError: unknown = undefined;

    try {
      const createStream = async (
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      ) =>
        this.client.chat.completions.create(
          {
            model: this.config.api.model,
            temperature: this.config.generation.temperature,
            ...(this.config.api.token_limit_field === "max_tokens"
              ? { max_tokens: maxTokens }
              : { max_completion_tokens: maxTokens }),
            // DeepSeek reasoning models: thinking toggle as a TOP-LEVEL field.
            ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
            messages,
            stream: true,
          } as ChatCompletionCreateParamsStreaming,
          { signal: activeController.signal },
        );

      const stream = await createStream([
        { role: "system" as const, content: this.systemPrompt },
        { role: "user" as const, content: userPrompt },
      ]);

      const parser = new DslSegmentParser({ expectedNonce: nonce, allowedReasons });

      // SSE chunks → complete lines as a named async-generator transform:
      // first-line timing and char counting live here, out of the parse
      // loop below. One decoder+generator per stream; a strip-continue swaps
      // in a fresh pair while the parser (and its pending cues / open form)
      // carries over.
      const makeLineStream = (
        sse: AsyncIterable<{ choices?: Array<{ delta?: { content?: string | null } }>}>,
        lineDecoder: StreamLineDecoder,
      ): AsyncGenerator<string> =>
        (async function* (): AsyncGenerator<string> {
          for await (const chunk of sse) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (!content) continue;
            if (firstLineMs === 0) firstLineMs = Date.now();
            streamChars += content.length;
            yield* lineDecoder.push(content);
          }
        })();

      let decoder = new StreamLineDecoder();
      let lines = makeLineStream(stream, decoder);

      /**
       * Strip-and-continue: delete the offending line from the model's raw
       * output and let it continue from the exact cut with the SAME parser
       * instance. Returns false when not eligible (code not whitelisted,
       * budget spent, or nothing to continue from) — the caller falls back
       * to rejectLine.
       */
      const tryStripContinue = async (
        error: DslProtocolError,
        rawIndex: number,
        atLineIndex: number,
      ): Promise<boolean> => {
        if (stripBudget <= 0 || !STRIP_CONTINUE_CODES.has(error.code)) return false;
        // Stale-deferred fold（独立审计 S1）：被剔除行不是延迟行自身时，未
        // 合并的裸 @? 必须一并从前缀消失——否则它坐在续写前缀尾部，模型
        // 写出正确的 `@? 提示` 反而撞上 stale deferred 被强制空提示，预算
        // 已耗 → fail。主循环内延迟行必为被剔除行的紧邻上一行，两者之间
        // 没有好行，故前缀边界直接退到 pending.rawIndex。
        const staleDeferred =
          pendingFormStart !== null &&
          pendingFormStart.rawIndex !== rawIndex &&
          pendingFormStart.rawIndex < rawIndex
            ? pendingFormStart
            : null;
        const prefixEnd = staleDeferred !== null ? staleDeferred.rawIndex : rawIndex;
        const prefix = rawLines.slice(0, prefixEnd).join("\n");
        if (prefix.trim() === "") return false;
        stripBudget -= 1;
        this.metrics?.recordSchemaValidationFailure();
        if (staleDeferred !== null) {
          console.warn(`[LLM] ${type} 连带剔除未合并的裸 @?（第 ${staleDeferred.lineIndex} 行）`);
        }
        console.warn(
          `[LLM] ${type} 剔除续写：第 ${atLineIndex} 行 "${rawLines[rawIndex] ?? ""}" [${error.code}]`,
        );
        // The canonical output is everything except the deleted lines. 先删
        // 后面的坏行（大索引）再删 pending（小索引），互不影响。
        rawLines.splice(rawIndex, 1);
        if (staleDeferred !== null) {
          rawLines.splice(staleDeferred.rawIndex, 1);
          pendingFormStart = null;
        }
        const previousController = activeController;
        activeController = new AbortController();
        previousController.abort();
        const continuationInstruction = buildStripContinueInstruction(error, nonce, allowedReasons);
        const continuation = await createStream([
          { role: "system" as const, content: this.systemPrompt },
          { role: "user" as const, content: userPrompt },
          { role: "assistant" as const, content: `${prefix}\n` },
          {
            role: "user" as const,
            content: continuationInstruction,
          },
        ]);
        decoder = new StreamLineDecoder();
        lines = makeLineStream(continuation, decoder);
        return true;
      };

      const emit = (emitted: EventGroupDraft[]): void => {
        allGroups.push(...emitted);
        for (const group of emitted) {
          options?.onGroup?.(group);
        }
      };

      // Shared handling for parse/validation rejections: with a forwarded
      // prefix the attempt FAILS (runtime repairs from the committed
      // boundary); without one it is repairable → retry with the reason.
      // The reason is the FastAPI-style detail block (code, offending line,
      // cause, expected format, fix) — it rides into the next request as the
      // model's repair instruction.
      const recentRawLines: string[] = [];

      const rejectLine = (error: DslProtocolError, rawLine: string, atLineIndex = lineIndex): void => {
        streamAborted = true;
        console.warn(
          `[LLM] ${type} 校验拒绝，末尾原始行：${JSON.stringify(recentRawLines.concat(rawLine).slice(-4))}`,
        );
        const detail = formatDslErrorDetail(error, atLineIndex, rawLine);
        if (options?.onGroup && allGroups.length > 0) {
          streamError = error;
          failureReason = `DSL 流校验失败，已保留前面可播放的内容。${detail}`;
        } else {
          failureReason = detail;
        }
        activeController.abort();
      };

      // 跨流主循环：strip-continue 会换入一段续写流并从头进入 for-await，
      // 行号、parser 状态（待提交提示/打开中的表单）与已提交组全部延续。
      outer: while (true) {
        for await (const rawLine of lines) {
          if (endingSettled) break;
          lineIndex += 1;

          // Tolerate markdown fence markers around the DSL payload.
          const trimmed = rawLine.trim();
          if (trimmed.startsWith("```") || trimmed.endsWith("```")) continue;
          rawLines.push(rawLine);

          recentRawLines.push(trimmed);
          if (recentRawLines.length > 3) recentRawLines.shift();

          const closingRepair = repairDslClosingLine(trimmed, nonce, allowedReasons);

          // Swapped dialogue-header bracket (`苏遥[suyao|smug]: …`) — a
          // registered id in the variant slot is dropped deterministically.
          // @-prefixed lines (@+/@= form rows) carry free text in the same
          // shape and must never be "repaired".
          const swapRepair = trimmed.startsWith("@")
            ? null
            : repairSwappedVisualSlots(trimmed, this.knownSpeakers);

          let parsed: DslLine;
          try {
            parsed = parseDslLine(
              swapRepair?.line ?? closingRepair?.line ?? trimmed,
              this.knownSpeakers,
            );
          } catch (error) {
            if (error instanceof DslProtocolError) {
              if (await tryStripContinue(error, rawLines.length - 1, lineIndex)) continue outer;
              rejectLine(error, trimmed);
              break;
            }
            throw error;
          }

          // 裸 `@?` 不立刻入 parser：模型高频把表单提示写在下一行（实测
          // deepseek 每次表单都如此），直接入 parser 会在空提示上炸掉整段。
          // 延迟一行等待：下一行是旁白 → 合并为 `@? 提示`；否则按空提示
          // 报错走剔除续写。
          if (
            pendingFormStart === null &&
            parsed.kind === "form_start" &&
            parsed.prompt === "" &&
            !parser.hasOpenInteraction()
          ) {
            pendingFormStart = { lineIndex, rawIndex: rawLines.length - 1 };
            continue;
          }
          if (pendingFormStart !== null) {
            if (parsed.kind === "narration" && parsed.text.trim() !== "") {
              const deferred = pendingFormStart;
              pendingFormStart = null;
              console.warn(
                `[LLM] ${type} 表单提示写在了 @? 的下一行（第 ${deferred.lineIndex} 行），已合并。`,
              );
              parsed = { kind: "form_start", prompt: parsed.text };
            } else if (parsed.kind === "form_start" && parsed.prompt === "") {
              // 双裸 @?（模型连写两个空提示表单头）：第二个顶替第一个成为
              // 延迟行，第一个从 rawLines 删除——否则它留在 prefix 尾部，
              // 续写里模型写出正确的 `@? 提示` 会撞上 stale deferred 被强制
              // 空提示（2026-09-17 独立审计 S2，已实证复现）。
              const deferred = pendingFormStart;
              rawLines.splice(deferred.rawIndex, 1);
              pendingFormStart = { lineIndex, rawIndex: rawLines.length - 1 };
              console.warn(
                `[LLM] ${type} 连续两个裸 @?（第 ${deferred.lineIndex}/${lineIndex} 行），已去重为后者。`,
              );
              continue;
            } else if (parsed.kind !== "form_start" || parsed.prompt !== "") {
              // 空白行（parse 成空 narration）不消耗延迟态也不烧剔除预算，
              // 直接跳过等待下一行。
              if (parsed.kind === "narration" && parsed.text.trim() === "") {
                continue;
              }
              // 下一行不是旁白：裸 @? 的空提示无从弥补，先推入延迟行，
              // 让 EMPTY_FORM_PROMPT 触发剔除续写（当前行随后由续写重写）。
              const deferred = pendingFormStart;
              pendingFormStart = null;
              try {
                parser.pushLine({ kind: "form_start", prompt: "" });
              } catch (error) {
                if (error instanceof DslProtocolError) {
                  if (await tryStripContinue(error, deferred.rawIndex, deferred.lineIndex)) {
                    continue outer;
                  }
                  rejectLine(error, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
                  break;
                }
                throw error;
              }
            }
          }

          let emitted: EventGroupDraft[];
          try {
            if (
              parsed.kind === "segment_end" &&
              parsed.reason === "interaction" &&
              parsed.nonce === nonce &&
              allowedReasons.includes(parsed.reason) &&
              parser.hasOpenInteraction()
            ) {
              const closed = parser.closeOpenInteraction();
              console.warn(`[LLM] ${type} 交互表单缺少 @/?，已在 interaction 段尾前补齐。`);
              if (closed.length > 0) emit(closed);
            }
            emitted = parser.pushLine(parsed);
          } catch (error) {
            if (error instanceof DslProtocolError) {
              // A bare `@?` with an empty prompt while a form is already open
              // is almost always a botched `@/?` (observed in the wild) —
              // close the form instead of failing. Without an open form the
              // same line throws EMPTY_FORM_PROMPT, which is not inferrable
              // and stays a real error.
              if (
                error.code === "FORM_ALREADY_OPEN" &&
                parsed.kind === "form_start" &&
                parsed.prompt === "" &&
                parser.hasOpenInteraction()
              ) {
                let closed: EventGroupDraft[];
                try {
                  closed = parser.closeOpenInteraction();
                } catch (closeError) {
                  if (closeError instanceof DslProtocolError) {
                    // 空表单（@? 提示在、零选项/零输入）收不了尾：本调用在
                    // catch 处理器内，closeError 若不接住会穿透 outer 循环
                    // 绕过整个修复信封（独立复核 N1）。剔除当前裸 @? 行，
                    // EMPTY_FORM 在白名单内 → 续写补全选项后收尾。
                    if (await tryStripContinue(closeError, rawLines.length - 1, lineIndex)) {
                      continue outer;
                    }
                    rejectLine(closeError, trimmed);
                    break;
                  }
                  throw closeError;
                }
                console.warn(`[LLM] ${type} 已将空提示的 @? 视为表单结束 @/?。`);
                if (closed.length > 0) emit(closed);
                continue;
              }
              if (await tryStripContinue(error, rawLines.length - 1, lineIndex)) continue outer;
              rejectLine(error, trimmed);
              break;
            }
            throw error;
          }

          if (emitted.length > 0) emit(emitted);
          // epilogue 窗口收齐：@ending 已捕获（或窗口被杂行关闭）。立即停止
          // 读取——模型在结局之后的任何续写都是残留。
          if (parser.isEndingSettled()) {
            endingSettled = true;
            break;
          }
        }

        // ---- 当前流结束：处理无换行尾行 + 延迟的裸 @? ----
        // 尾行处理失败若命中剔除续写，会换入续写流并重走外层循环
        //（行号与 parser 状态延续），因此整块放在 while 内。
        const tail = endingSettled ? null : decoder.flush();
        let tailConsumedByMerge = false;
        if (!streamAborted && tail !== null) {
          rawLines.push(tail);
          const tailIndex = lineIndex + 1;
          const trimmed = tail.trim();
          if (
            trimmed.length > 0 &&
            !trimmed.startsWith("```") &&
            !trimmed.endsWith("```")
          ) {
            // 流结束仍挂着裸 @?：尾行是旁白 → 合并为表单提示；否则按
            // 空提示报错走剔除续写（模型停在 @? 的场景）。
            if (pendingFormStart !== null) {
              let tailParsed: DslLine | null = null;
              let tailError: DslProtocolError | null = null;
              try {
                tailParsed = parseDslLine(trimmed, this.knownSpeakers);
              } catch (error) {
                if (error instanceof DslProtocolError) tailError = error;
                else throw error;
              }
              const deferred = pendingFormStart;
              if (tailParsed?.kind === "narration" && tailParsed.text.trim() !== "") {
                pendingFormStart = null;
                tailConsumedByMerge = true;
                console.warn(
                  `[LLM] ${type} 表单提示写在了 @? 的下一行（第 ${deferred.lineIndex} 行），已合并。`,
                );
                try {
                  parser.pushLine({ kind: "form_start", prompt: tailParsed.text });
                } catch (error) {
                  if (error instanceof DslProtocolError) {
                    if (await tryStripContinue(error, deferred.rawIndex, deferred.lineIndex)) {
                      continue outer;
                    }
                    rejectLine(error, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
                    break;
                  }
                  throw error;
                }
                // 尾行已消费：行号推进，缺哨兵报错不再少算一行（审计 S6）。
                lineIndex = tailIndex;
              } else if (tailParsed !== null || tailError !== null) {
                pendingFormStart = null;
                const emptyPromptError = new DslProtocolError(
                  "EMPTY_FORM_PROMPT",
                  "交互表单的提示语不能为空。",
                  {
                    expected:
                      "@? 与提示文本必须写在同一行：`@? 提示文本`（提示不能拆到下一行，也不能为空）",
                    fix: '例如 "@? 你打算怎么回应？"',
                  },
                );
                if (await tryStripContinue(emptyPromptError, deferred.rawIndex, deferred.lineIndex)) {
                  continue outer;
                }
                rejectLine(emptyPromptError, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
                break;
              }
            }
            if (!tailConsumedByMerge) {
              try {
                const tailClosingRepair = repairDslClosingLine(trimmed, nonce, allowedReasons);
                const tailSwap = repairSwappedVisualSlots(trimmed, this.knownSpeakers);
                const tailParsed = parseDslLine(
                  tailSwap?.line ?? tailClosingRepair?.line ?? trimmed,
                  this.knownSpeakers,
                );
                if (
                  tailParsed.kind === "segment_end" &&
                  tailParsed.reason === "interaction" &&
                  tailParsed.nonce === nonce &&
                  allowedReasons.includes(tailParsed.reason) &&
                  parser.hasOpenInteraction()
                ) {
                  const closed = parser.closeOpenInteraction();
                  console.warn(`[LLM] ${type} 交互表单缺少 @/?，已在 interaction 段尾前补齐。`);
                  if (closed.length > 0) emit(closed);
                }
                const emitted = parser.pushLine(tailParsed);
                if (emitted.length > 0) emit(emitted);
                lineIndex = tailIndex;
              } catch (error) {
                if (error instanceof DslProtocolError) {
                  if (await tryStripContinue(error, rawLines.length - 1, tailIndex)) continue outer;
                  this.metrics?.recordSchemaValidationFailure();
                  console.warn(
                    `[LLM] ${type} 输出在末尾被截断，已丢弃残片（截断于第 ${tailIndex} 行）`,
                  );
                } else {
                  throw error;
                }
              }
            }
          }
        }
        if (pendingFormStart !== null && !streamAborted && !endingSettled) {
          // 流结束仍挂着裸 @? 且没有尾行可合并：模型在 @? 处停笔。
          // 剔除该行让模型续写完整表单（EMPTY_FORM_PROMPT 白名单内）。
          const deferred = pendingFormStart;
          pendingFormStart = null;
          const emptyPromptError = new DslProtocolError(
            "EMPTY_FORM_PROMPT",
            "交互表单的提示语不能为空。",
            {
              expected:
                "@? 与提示文本必须写在同一行：`@? 提示文本`（提示不能拆到下一行，也不能为空）",
              fix: '例如 "@? 你打算怎么回应？"',
            },
          );
          if (await tryStripContinue(emptyPromptError, deferred.rawIndex, deferred.lineIndex)) {
            continue outer;
          }
          rejectLine(emptyPromptError, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
          break;
        }
        break;
      }

      const latencyMs = Date.now() - callStart;
      usage = { input: 0, output: Math.ceil(streamChars / 4) };
      // err= mirrors the legacy cross-attempt semantics: the failure of the
      // PREVIOUS attempt when this one succeeds — that is how operators
      // identify a successful repair retry in the logs.
      console.log(
        `[LLM] ${type}(${taskType}) ${latencyMs}ms lines=${lineIndex} first=${firstLineMs ? firstLineMs - callStart : "?"}ms err=${failureReason || priorFailure || "ok"}`,
      );

      // Structurally invalid line with nothing forwarded yet → retry with
      // the repair instruction; with forwarded groups → fail and preserve
      // the prefix for the runtime's repair path. `failureReason` already
      // carries the FastAPI-style detail in that case.
      if (streamAborted) {
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        this.metrics?.recordSchemaValidationFailure();
        if (options?.onGroup && allGroups.length > 0) {
          return {
            kind: "fail",
            error: new Error(failureReason, { cause: streamError }),
          };
        }
        return { kind: "retry", reason: failureReason };
      }

      // Empty output — nothing at all (fences alone do not count).
      if (lineIndex === 0 && allGroups.length === 0) {
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        return { kind: "retry", reason: "模型返回空内容。" };
      }

      const result = parser.finish();
      if (result.status.kind === "complete") {
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        options?.onSegmentEnd?.(result.status);
        return {
          kind: "complete",
          envelope: {
            events: [],
            groups: allGroups,
            segmentEnd: result.status,
          },
        };
      }

      // No @end sentinel → truncated segment (docs §49). With forwarded
      // groups the prefix is playable: fail so the Game repairs from the
      // committed boundary. Otherwise retry from scratch.
      this.metrics?.recordLLMRequest(type, usage, latencyMs);
      if (options?.onGroup && allGroups.length > 0) {
        return {
          kind: "fail",
          error: new Error(
            `DSL 流在第 ${lineIndex} 行之后结束但没有 @end 哨兵（输出被截断或漏写）。最后一行必须是 @end ${nonce} <reason>（nonce 原样照抄任务提示，reason 取 ${allowedReasons.join("/")}）`,
          ),
        };
      }
      return {
        kind: "retry",
        reason: `本段缺少结束哨兵 @end：输出可能在末尾被截断，或写完正文就停笔。最后一行必须是 @end ${nonce} <reason>（nonce 原样照抄任务提示，reason 取 ${allowedReasons.join("/")}）`,
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      this.metrics?.recordLLMRequest(type, usage, Date.now() - callStart);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}


// ---------------------------------------------------------------------------
// StoryGeneratorPort facade
//
// Adapts the promise + onEvent API above into the handle-based port used by
// future core consumers, without rewriting the streaming request pipeline.
// ---------------------------------------------------------------------------

export class GeneratorPortFacade implements StoryGeneratorPort {
  constructor(private readonly inner: StoryGenerator) {}

  generateOpening(request: OpeningRequest): GenerationHandle {
    return createGenerationHandle(`opening:${request.turn}`, (signal, onGroup) =>
      this.inner.generateOpening(request.turn, request.state, signal, {
        onGroup,
        ...(request.briefing !== undefined && request.briefing !== "" ? { briefing: request.briefing } : {}),
        ...(request.tailVisualState
          ? { tailVisualState: request.tailVisualState }
          : {}),
      }),
    );
  }

  generateContinuation(request: ContinuationRequest): GenerationHandle {
    return createGenerationHandle(`continuation:${request.turn}`, (signal, onGroup) =>
      this.inner.generateContinuation(
        request.turn,
        request.state,
        request.history,
        request.prefetchedEvents,
        signal,
        {
          onGroup,
          ...(request.briefing !== undefined && request.briefing !== "" ? { briefing: request.briefing } : {}),
          ...(request.tailVisualState
            ? { tailVisualState: request.tailVisualState }
            : {}),
          ...(request.repairReason
            ? { repairReason: request.repairReason }
            : {}),
        },
      ),
    );
  }

  generateBranchPrefetch(request: BranchPrefetchRequest): GenerationHandle {
    return createGenerationHandle(`branch:${request.option.id}`, (signal, onGroup) =>
      this.inner.generateBranchPrefetch(
        request.turn,
        request.state,
        request.history,
        request.choice,
        request.option,
        signal,
        {
          onGroup,
          ...(request.briefing !== undefined && request.briefing !== "" ? { briefing: request.briefing } : {}),
          ...(request.tailVisualState
            ? { tailVisualState: request.tailVisualState }
            : {}),
        },
      ),
    );
  }

  generateInputResponse(request: InputResponseRequest): GenerationHandle {
    return createGenerationHandle(`input:${request.interaction.interaction_id}`, (signal, onGroup) =>
      this.inner.generateInputResponse(
        request.turn,
        request.state,
        request.history,
        request.interaction,
        request.playerInput,
        signal,
        {
          onGroup,
          ...(request.briefing !== undefined && request.briefing !== "" ? { briefing: request.briefing } : {}),
          ...(request.tailVisualState
            ? { tailVisualState: request.tailVisualState }
            : {}),
        },
      ),
    );
  }

  generateInputBridge(request: InputBridgeRequest): GenerationHandle {
    return createGenerationHandle(
      `bridge:${request.interaction.interaction_id}`,
      (signal, onGroup) =>
        this.inner.generateInputBridge(
          request.turn,
          request.state,
          request.interaction,
          signal,
          {
            onGroup,
            ...(request.briefing !== undefined && request.briefing !== "" ? { briefing: request.briefing } : {}),
            ...(request.tailVisualState
              ? { tailVisualState: request.tailVisualState }
              : {}),
          },
        ),
    );
  }
}
