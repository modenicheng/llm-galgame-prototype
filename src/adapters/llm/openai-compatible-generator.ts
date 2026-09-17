import OpenAI from "openai";
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
import {
  repairDslClosingLine,
  repairSwappedVisualSlots,
} from "../../core/protocol/gal-dsl/closing-repair.js";
import { DslSegmentParser } from "../../core/protocol/gal-dsl/segment-validator.js";
import {
  DslProtocolError,
  formatDslErrorDetail,
  type DslLine,
  type EventGroupDraft,
  type SegmentEndReason,
  type SegmentEndStatus,
} from "../../core/protocol/gal-dsl/types.js";
import type { InstructionSet, PromptBundle } from "../../prompts.js";
import type { DslStreamObserver } from "../../core/ports/dsl-stream-observer.js";
import type { LLMRequestType } from "../../runtime/metrics.js";
import { Metrics } from "../../runtime/metrics.js";
import { parseLLMUsage, type LLMUsageReading } from "./llm-usage.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  StoryContextEvent,
} from "../../schema.js";
import type { NarrativeBrief } from "../../core/narrative/narrative-brief.js";
import type { GenerationEnvelope, StoryState, StoryStatePatch } from "../../story/types.js";
import { mergePatches } from "../../story/patch.js";
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

/** One-line preview of a committed group for the monitor stream (capped). */
function monitorGroupSummary(group: EventGroupDraft): string {
  const main = group.main;
  switch (main.type) {
    case "dialogue":
      return `${main.speaker}：${main.text}`.slice(0, 80);
    case "narration":
      return main.text.slice(0, 80);
    case "interaction":
      return `${main.interaction.mode} 表单：${main.interaction.prompt}`.slice(0, 80);
    case "beat":
      return "beat";
  }
}

/**
 * Fresh 4-hex-char generation nonce for the DSL `@end <nonce> <reason>`
 * sentinel (docs/llm-outputs-refactor.md §45). Randomized per request so a
 * stale sentinel from a previous attempt can never satisfy this one.
 */
export function generateNonce(): string {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
}

/**
 * Event mode 收束/节奏指引（docs §70 附加指令）。全部追加在 user prompt
 * 末尾——这些内容逐请求变化，必须位于稳定前缀（素材/历史/状态）之后，
 * 否则会打破 provider 前缀缓存。endingRequired（L3 保险丝）优先于
 * endingPhase（L1/L2）。`{nonce}` 在此替换为请求的真实 nonce：此前该行
 * 在 fill() 之后以字面量 `{nonce}` 下发，模型回显后哨兵校验必然失败。
 */
export function appendEventModeGuidance(
  extra: string,
  nonce: string,
  options?: GenerationStreamOptions,
): string {
  let result = extra;
  // 长回合护栏与收束指令的互斥（2026-09-17 实测发现）：closing/L3 明确
  // "不要再打开交互表单"，此时再附"尽快打开交互表单"会让同一 prompt
  // 包含两条相反指令——护栏只在还允许交互的阶段（无收束/仅 L1 wrapup）
  // 生效。
  const interactionAllowed = !(
    options?.endingRequired === true || options?.endingPhase === "closing"
  );
  if (interactionAllowed && options?.requestInteraction === true) {
    result +=
      "\n\n本回合已连续输出较长内容：请在合适的位置尽快打开玩家交互表单（`? ... /?`），把话语权交还玩家。";
  }
  if (options?.endingRequired === true) {
    result += `\n\n本段必须收束结局：用 @end ${nonce} ending 结束，不得打开新的交互表单。`;
  } else if (options?.endingPhase === "closing") {
    result += `\n\n剧情已进入最后收束阶段：不要再打开新的交互表单，直接收拢当前线索，用 @end ${nonce} ending 结束本段。`;
  } else if (options?.endingPhase === "wrapup") {
    // L1 是软提示：只引导"开始收拢、面向收尾"，把"不得再开表单/必须
    // ending"的硬措辞留给 L2（closing）——否则结局会固定落在 wrapup+1
    // 次交互，分级收束形同虚设（audit 2026-09-17 #3）。
    const { count, target } = options.interactionProgress ?? {};
    if (count !== undefined && target !== undefined && count > target) {
      result += `\n\n收束阶段提示（交互数 ${count} 已超过收束目标 ${target}）：请加快节奏，把剧情收向本局结局；除非收尾确实需要，不要再打开新的交互表单，也不要引入新话题、新角色或新支线。`;
    } else {
      result += `\n\n剧情已进入收束阶段（本次游玩时长已经足够）：请开始收拢当前线索，接下来的交互应面向收尾（例如让玩家决定如何结束、和谁道别），而不是新的情节转折；不要再引入新话题、新角色或新支线。`;
    }
  }
  return result;
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
   * Per-turn narrative director brief injected as a director note section
   * in the user prompt (docs narrative-director §Task-10).
   */
  brief?: NarrativeBrief;
  /** Event mode：本段必须以 @end ending 收束（L3 保险丝，audit P2-10）。 */
  endingRequired?: boolean;
  /** Event mode 分级收束：wrapup = L1 软提示；closing = L2 强提示（endingRequired 优先）。 */
  endingPhase?: "wrapup" | "closing";
  /** Event mode 长回合护栏：本回合文本事件超限，附"尽快打开交互表单"提示。 */
  requestInteraction?: boolean;
  /** Event mode 交互进度（注入任务头，让模型感知收束节奏）。 */
  interactionProgress?: { count: number; target?: number };
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
  /** Read-only monitor tap (monitor dashboard); absent in tests/CLI. */
  private readonly observer: DslStreamObserver | undefined;

  constructor(
    private readonly config: AppConfig,
    prompts: PromptBundle,
    instructions: InstructionSet,
    apiKey: string,
    private readonly authorConfig?: AuthorConfig,
    private readonly metrics?: Metrics,
    catalog?: AssetCatalog,
    observer?: DslStreamObserver,
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
    this.observer = observer;
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
    if (options?.brief) {
      ctx.directorBrief = options.brief;
    }
    if (options?.interactionProgress) {
      ctx.interactionProgress = options.interactionProgress;
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

  /**
   * History window guard. The Game passes a bounded, prefix-stable window
   * (generationHistory()); re-slicing to the last `history_events` here
   * would shift the window start on every commit and defeat provider prefix
   * caching. Only enforce a generous safety bound for raw callers.
   */
  private boundHistory(history: StoryContextEvent[]): StoryContextEvent[] {
    const cap = this.config.game.history_events;
    return history.length > cap * 4 ? history.slice(-cap) : history;
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
    const recentHistory = this.boundHistory(history);
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, recentHistory, "branch_prefetch", nonce, options);
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
    const recentHistory = this.boundHistory(history);
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, recentHistory, "input_response", nonce, options);
    const extra = fill(this.instructions.input_response, {
      interaction_prompt: interaction.prompt,
      player_input: playerInput,
      nonce,
    });
    return this.requestDslEnvelope(
      "input_response",
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
      "input_bridge",
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
    const recentHistory = this.boundHistory(history);
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, recentHistory, "continuation", nonce, options);
    let extra = fill(this.instructions.continuation, {
      nonce,
      target_lines: String(this.config.text_buffer.target_lines),
      prefetched: serializeStoryContext(prefetchedEvents),
    });
    extra = appendEventModeGuidance(extra, nonce, options);
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
   * DSL-mode streaming request (docs §40–§51).
   *
   * Retry-policy layer: drives per-attempt `attemptDslStream` and decides
   * between repair-and-retry, fail-preserving-prefix, and success. All
   * error strings are load-bearing — they double as the repair instruction
   * for the next attempt and are asserted by tests verbatim.
   */
  private async requestDslEnvelope(
    type: LLMRequestType,
    taskType: string,
    allowedReasons: readonly SegmentEndReason[],
    nonce: string,
    userPrompt: string,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    let lastError = "";
    const attempts = this.config.generation.repair_attempts + 1;
    // Monitor identity: the nonce is unique per request, so `${taskType}-${nonce}`
    // disambiguates concurrent branch prefetches and successive turns.
    const requestId = `${taskType}-${nonce}`;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // On retry: add repair instruction describing the previous failure
      // (provider-internal `lastError` and/or Game-level options.repairReason).
      // Wording matters per path: this request carries no assistant replay,
      // so for provider-internal retries the model cannot see its previous
      // output — asking it to "continue from where it failed" would push it
      // to start mid-segment. Only the Game-level path serializes the failed
      // segment's playable events into the user prompt, where continuing
      // from the failure point is meaningful.
      const repairParts = [lastError, options?.repairReason].filter(
        (reason): reason is string => Boolean(reason),
      );
      const repairInstruction = repairParts.length
        ? `\n${[
            lastError
              ? // With a Game-level repairReason the user prompt serializes the
                // failed segment's playable prefix, so continuing from the
                // failure point is meaningful for BOTH reasons; without it the
                // model never saw its previous output and must re-emit whole.
                `上一份输出出错：${lastError}。请修正该问题${
                  options?.repairReason
                    ? "后从失败位置继续，不要重复已输出的内容。"
                    : "，重新完整输出本段全部内容（不要省略开头）。"
                }`
              : "",
            options?.repairReason
              ? `上一份输出出错：${options.repairReason}。请修正该问题后从失败位置继续，不要重复已输出的内容。`
              : "",
          ]
            .filter(Boolean)
            .join("\n")}`
        : "";

      const attemptId = `${requestId}#${attempt}`;
      this.observer?.onAttemptStart({ attemptId, taskId: requestId, taskType, index: attempt });
      const outcome = await this.attemptDslStream(
        type,
        taskType,
        allowedReasons,
        nonce,
        `${userPrompt}${repairInstruction}`,
        signal,
        options,
        lastError,
        attemptId,
      );
      if (outcome.kind === "complete") {
        const reason =
          outcome.envelope.segmentEnd?.kind === "complete"
            ? outcome.envelope.segmentEnd.reason
            : undefined;
        this.observer?.onAttemptEnd(attemptId, {
          state: "done",
          ...(reason !== undefined ? { segmentEnd: reason } : {}),
        });
        return outcome.envelope;
      }
      if (outcome.kind === "fail") {
        this.observer?.onAttemptEnd(attemptId, { state: "failed", error: outcome.error.message });
        throw outcome.error;
      }
      this.observer?.onAttemptEnd(attemptId, { state: "retried", error: outcome.reason });
      lastError = outcome.reason;
    }

    throw new Error(`模型输出连续校验失败：${lastError}`);
  }

  /**
   * One streaming attempt: send the request, decode SSE chunks into
   * complete DSL lines, parse/validate incrementally, and forward committed
   * EventGroupDrafts via options.onGroup. A structurally invalid line with
   * already-forwarded groups fails the request (the runtime preserves the
   * prefix); otherwise the outcome is repairable. A truncated tail without
   * a trailing newline is dropped (docs §49–§50).
   */
  private async attemptDslStream(
    type: LLMRequestType,
    taskType: string,
    allowedReasons: readonly SegmentEndReason[],
    nonce: string,
    userPrompt: string,
    signal: AbortSignal | undefined,
    options: GenerationStreamOptions | undefined,
    /** Failure reason of the PREVIOUS attempt — only for the err= log field. */
    priorFailure: string,
    /** Monitor identity of this attempt (requestId#attemptIndex). */
    attemptId: string,
  ): Promise<DslAttemptOutcome> {
    const observer = this.observer;
    const maxTokens = this.config.generation.max_tokens;
    const callStart = Date.now();
    let firstLineMs = 0;
    let lineIndex = 0;
    let openFormStartLine: number | null = null;
    let streamChars = 0;
    const allGroups: EventGroupDraft[] = [];
    let streamAborted = false;
    let failureReason = "";
    let usage: { input: number; output: number; cachedInput?: number } = {
      input: 0,
      output: 0,
    };
    // Real counters reported by the provider on the final stream chunk;
    // null when the gateway strips usage (estimate fallback below). Read via
    // reportedUsage(): assignments happen inside the lines generator below,
    // which TS control-flow analysis cannot see (it would narrow to never).
    let apiUsage: LLMUsageReading | null = null;
    const reportedUsage = (): LLMUsageReading | null => apiUsage;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    // Original error behind a mid-stream abort. Chained as the `cause` of
    // the wrap thrown to the runtime so error-class detection survives it.
    let streamError: unknown = undefined;

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.api.model,
          temperature: this.config.generation.temperature,
          ...(this.config.api.token_limit_field === "max_tokens"
            ? { max_tokens: maxTokens }
            : { max_completion_tokens: maxTokens }),
          // DeepSeek reasoning models: thinking toggle as a TOP-LEVEL field.
          ...(({ thinking: { type: "disabled" } }) as unknown as Record<string, unknown>),
          messages: [
            { role: "system" as const, content: this.systemPrompt },
            { role: "user" as const, content: userPrompt },
          ],
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: controller.signal },
      );

      const decoder = new StreamLineDecoder();
      const parser = new DslSegmentParser({ expectedNonce: nonce, allowedReasons });

      // SSE chunks → complete lines as a named async-generator transform:
      // usage capture, first-line timing and char counting live here, out of
      // the parse loop below. The decoder stays outside so the consumer can
      // flush the truncated tail after the stream ends.
      const lines = (async function* (): AsyncGenerator<string> {
        for await (const chunk of stream) {
          // Usage rides the final chunk, which usually carries empty choices —
          // capture it before the content check skips empty chunks.
          const chunkUsage = parseLLMUsage(chunk.usage);
          if (chunkUsage) apiUsage = chunkUsage;
          const content = chunk.choices[0]?.delta?.content;
          if (!content) continue;
          if (firstLineMs === 0) firstLineMs = Date.now();
          streamChars += content.length;
          observer?.onDelta(attemptId, content);
          yield* decoder.push(content);
        }
      })();

      const emit = (emitted: EventGroupDraft[], sourceLineIndex: number): void => {
        for (const group of emitted) {
          const sourced: EventGroupDraft = {
            ...group,
            source: { attemptId, lineIndex: sourceLineIndex },
          };
          const groupIndex = allGroups.length;
          allGroups.push(sourced);
          observer?.onGroup(attemptId, groupIndex, sourced.main.type, monitorGroupSummary(sourced));
          options?.onGroup?.(sourced);
        }
      };

      // Shared handling for parse/validation rejections: with a forwarded
      // prefix the attempt FAILS (runtime repairs from the committed
      // boundary); without one it is repairable → retry with the reason.
      // The reason is the FastAPI-style detail block (code, offending line,
      // cause, expected format, fix) — it rides into the next request as the
      // model's repair instruction.
      // Protocol forensics: the last few raw model lines around a rejection —
      // without them a mangled-line fix is guesswork (2026-09-17 audit).
      const recentRawLines: string[] = [];

      const rejectLine = (error: DslProtocolError, rawLine: string): void => {
        streamAborted = true;
        console.warn(
          `[LLM] ${type} 校验拒绝，末尾原始行：${JSON.stringify(recentRawLines.concat(rawLine).slice(-4))}`,
        );
        const detail = formatDslErrorDetail(error, lineIndex, rawLine);
        if (options?.onGroup && allGroups.length > 0) {
          streamError = error;
          failureReason = `DSL 流校验失败，已保留前面可播放的内容。${detail}`;
        } else {
          failureReason = detail;
        }
        controller.abort();
      };

      for await (const rawLine of lines) {
        lineIndex += 1;

        // Tolerate markdown fence markers around the DSL payload.
        const trimmed = rawLine.trim();
        if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
          observer?.onLine(attemptId, lineIndex, { kind: null });
          continue;
        }

        recentRawLines.push(trimmed);
        if (recentRawLines.length > 3) recentRawLines.shift();

        const closingRepair = repairDslClosingLine(trimmed, nonce, allowedReasons);
        if (closingRepair !== null) {
          observer?.onRepair?.(attemptId, {
            kind: closingRepair.kind,
            lineIndex,
            message: `已将“${trimmed}”规范化为“${closingRepair.line}”。`,
          });
        }

        // Swapped dialogue-header bracket (`树莓娘[raspberry|smug]: …`) — a
        // registered id in the variant slot is dropped deterministically.
        const swapRepair = repairSwappedVisualSlots(trimmed, this.knownSpeakers);
        if (swapRepair !== null) {
          observer?.onRepair?.(attemptId, {
            kind: "visual_swap",
            lineIndex,
            message: `已将台词头 ${swapRepair.from} 规范化为 ${swapRepair.to}（角色 id 不是立绘变体）。`,
          });
        }

        let parsed: DslLine;
        try {
          parsed = parseDslLine(
            swapRepair?.line ?? closingRepair?.line ?? trimmed,
            this.knownSpeakers,
          );
        } catch (error) {
          if (error instanceof DslProtocolError) {
            observer?.onLine(attemptId, lineIndex, { kind: null, error: error.message });
            rejectLine(error, trimmed);
            break;
          }
          throw error;
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
            observer?.onRepair?.(attemptId, {
              kind: "form_close",
              lineIndex,
              message: "交互表单缺少 @/?，已在 interaction 段尾前补齐。",
            });
            if (closed.length > 0) emit(closed, openFormStartLine ?? lineIndex);
            openFormStartLine = null;
          }
          emitted = parser.pushLine(parsed);
        } catch (error) {
          if (error instanceof DslProtocolError) {
            // A bare `@?` with an empty prompt while a form is already open
            // is almost always a botched `@/?` (observed in the wild,
            // sim-rambler 2026-09-17) — close the form instead of failing.
            // Without an open form the same line throws EMPTY_FORM_PROMPT,
            // which is not inferrable and stays a real error.
            if (
              error.code === "FORM_ALREADY_OPEN" &&
              parsed.kind === "form_start" &&
              parsed.prompt === "" &&
              parser.hasOpenInteraction()
            ) {
              const closed = parser.closeOpenInteraction();
              observer?.onRepair?.(attemptId, {
                kind: "form_close",
                lineIndex,
                message: "已将空提示的 @? 视为表单结束 @/?。",
              });
              if (closed.length > 0) emit(closed, openFormStartLine ?? lineIndex);
              openFormStartLine = null;
              observer?.onLine(attemptId, lineIndex, { kind: "form_end" });
              continue;
            }
            observer?.onLine(attemptId, lineIndex, { kind: parsed.kind, error: error.message });
            rejectLine(error, trimmed);
            break;
          }
          throw error;
        }

        observer?.onLine(attemptId, lineIndex, { kind: parsed.kind });
        if (parsed.kind === "form_start") openFormStartLine = lineIndex;
        if (emitted.length > 0) {
          emit(emitted, parsed.kind === "form_end" ? (openFormStartLine ?? lineIndex) : lineIndex);
        }
        if (parsed.kind === "form_end") openFormStartLine = null;
      }

      // Truncated tail without a trailing newline: try it, but drop the
      // partial when it is structurally invalid (docs §49–§50). A valid
      // tail that still lacks the sentinel lands in the incomplete branch
      // below — never a hard failure with already-forwarded groups.
      const tail = decoder.flush();
      if (!streamAborted && tail !== null) {
        const trimmed = tail.trim();
        if (
          trimmed.length > 0 &&
          !trimmed.startsWith("```") &&
          !trimmed.endsWith("```")
        ) {
          try {
            const tailIndex = lineIndex + 1;
            const closingRepair = repairDslClosingLine(trimmed, nonce, allowedReasons);
            if (closingRepair !== null) {
              observer?.onRepair?.(attemptId, {
                kind: closingRepair.kind,
                lineIndex: tailIndex,
                message: `已将“${trimmed}”规范化为“${closingRepair.line}”。`,
              });
            }
            const tailSwap = repairSwappedVisualSlots(trimmed, this.knownSpeakers);
            if (tailSwap !== null) {
              observer?.onRepair?.(attemptId, {
                kind: "visual_swap",
                lineIndex: tailIndex,
                message: `已将台词头 ${tailSwap.from} 规范化为 ${tailSwap.to}（角色 id 不是立绘变体）。`,
              });
            }
            const tailParsed = parseDslLine(
              tailSwap?.line ?? closingRepair?.line ?? trimmed,
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
              observer?.onRepair?.(attemptId, {
                kind: "form_close",
                lineIndex: tailIndex,
                message: "交互表单缺少 @/?，已在 interaction 段尾前补齐。",
              });
              if (closed.length > 0) emit(closed, openFormStartLine ?? tailIndex);
              openFormStartLine = null;
            }
            const emitted = parser.pushLine(tailParsed);
            observer?.onLine(attemptId, tailIndex, { kind: tailParsed.kind });
            if (tailParsed.kind === "form_start") openFormStartLine = tailIndex;
            if (emitted.length > 0) {
              emit(
                emitted,
                tailParsed.kind === "form_end" ? (openFormStartLine ?? tailIndex) : tailIndex,
              );
            }
            if (tailParsed.kind === "form_end") openFormStartLine = null;
          } catch (error) {
            if (error instanceof DslProtocolError) {
              observer?.onLine(attemptId, lineIndex + 1, { kind: null, error: error.message });
              this.metrics?.recordSchemaValidationFailure();
              console.warn(
                `[LLM] ${type} 输出在末尾被截断，已丢弃残片（截断于第 ${lineIndex + 1} 行）`,
              );
            } else {
              throw error;
            }
          }
        }
      }

      const latencyMs = Date.now() - callStart;
      const reported = reportedUsage();
      if (reported) {
        usage = {
          input: reported.input,
          output: reported.output,
          cachedInput: reported.cachedInput,
        };
      } else {
        // Provider didn't report usage: keep the legacy char-based estimate.
        usage = { input: 0, output: Math.ceil(streamChars / 4) };
      }
      observer?.onUsage?.(attemptId, {
        input: usage.input,
        output: usage.output,
        cachedInput: usage.cachedInput ?? 0,
        source: reported ? "api" : "estimated",
        latencyMs,
      });
      // err= mirrors the legacy cross-attempt semantics: the failure of the
      // PREVIOUS attempt when this one succeeds — that is how operators
      // identify a successful repair retry in the logs.
      console.log(
        `[LLM] ${type}(${taskType}) ${latencyMs}ms lines=${lineIndex} in=${usage.input} out=${usage.output} cached=${usage.cachedInput ?? 0} src=${reported ? "api" : "est"} first=${firstLineMs ? firstLineMs - callStart : "?"}ms err=${failureReason || priorFailure || "ok"}`,
      );

      // Structurally invalid line with nothing forwarded yet → retry with
      // the repair instruction; with forwarded groups → fail and preserve
      // the prefix for the runtime's repair path. `failureReason` already
      // carries the "DSL 流在第 N 行校验失败：…" framing in that case.
      if (streamAborted) {
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        this.metrics?.recordSchemaValidationFailure();
        if (options?.onGroup && allGroups.length > 0) {
          return { kind: "fail", error: new Error(failureReason, { cause: streamError }) };
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
            state_patch: {},
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

function mergePatchesList(patches: StoryStatePatch[]): StoryStatePatch {
  let merged: StoryStatePatch = {};
  for (const patch of patches) merged = mergePatches(merged, patch);
  return merged;
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
        ...(request.brief ? { brief: request.brief } : {}),
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
          ...(request.brief ? { brief: request.brief } : {}),
          ...(request.tailVisualState
            ? { tailVisualState: request.tailVisualState }
            : {}),
          ...(request.repairReason
            ? { repairReason: request.repairReason }
            : {}),
          ...(request.endingRequired
            ? { endingRequired: request.endingRequired }
            : {}),
          ...(request.endingPhase ? { endingPhase: request.endingPhase } : {}),
          ...(request.requestInteraction
            ? { requestInteraction: request.requestInteraction }
            : {}),
          ...(request.interactionProgress
            ? { interactionProgress: request.interactionProgress }
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
          ...(request.brief ? { brief: request.brief } : {}),
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
          ...(request.brief ? { brief: request.brief } : {}),
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
            ...(request.brief ? { brief: request.brief } : {}),
            ...(request.tailVisualState
              ? { tailVisualState: request.tailVisualState }
              : {}),
          },
        ),
    );
  }
}
