import OpenAI from "openai";
import type { AppConfig, AuthorConfig } from "../../config.js";
import {
  buildDslUserPromptSegments,
  buildSystemContextSegments,
  joinPromptSegments,
  serializeStoryContext,
  type ContextInput,
  type DslContextInput,
  type PromptSegment,
} from "../../story/context-builder.js";
import { toModelCatalog } from "../../core/assets/catalog.js";
import type { AssetCatalog, ModelAssetCatalog } from "../../core/assets/types.js";
import type { VisualState } from "../../core/presentation/types.js";
import { StreamLineDecoder } from "../../core/protocol/gal-dsl/stream-decoder.js";
import { parseDslLine, stripNarrationLabel } from "../../core/protocol/gal-dsl/line-parser.js";
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

/**
 * DeepSeek thinking fragment for the chat-completions body: a TOP-LEVEL
 * `thinking` toggle plus an optional `reasoning_effort` ("low" | "high" |
 * "max"; server default is high). Returned as an opaque record because the
 * OpenAI SDK schema does not know provider extensions. Caveats when enabled:
 * the server ignores `temperature`, and reasoning tokens bill into the
 * completion-token budget.
 */
function thinkingRequestBody(
  thinking: AppConfig["generation"]["thinking"] | undefined,
): Record<string, unknown> {
  // `thinking` is schema-guaranteed in production; the ?. tolerates
  // hand-built test fixtures that omit the section.
  const type = thinking?.type ?? "disabled";
  const body: Record<string, unknown> = { thinking: { type } };
  if (type === "enabled" && thinking?.effort) {
    body.reasoning_effort = thinking.effort;
  }
  return body;
}

/**
 * Metrics tap around the monitor observer: counts DSL repairs and attempt
 * outcomes in one place instead of at every call site. Recording happens
 * before the (safe-wrapped) observer hooks, so monitor-side exceptions can
 * never skip a counter.
 */
function withMetricsTap(observer: DslStreamObserver, metrics?: Metrics): DslStreamObserver {
  if (!metrics) return observer;
  return {
    onAttemptStart: (info) => observer.onAttemptStart(info),
    onPrompt: (report) => observer.onPrompt?.(report),
    onDelta: (attemptId, text) => observer.onDelta(attemptId, text),
    onLine: (attemptId, lineIndex, parse) => observer.onLine(attemptId, lineIndex, parse),
    onGroup: (attemptId, groupIndex, kind, summary) =>
      observer.onGroup(attemptId, groupIndex, kind, summary),
    onRepair: (attemptId, repair) => {
      metrics.recordDslRepair(repair.kind);
      observer.onRepair?.(attemptId, repair);
    },
    onUsage: (attemptId, usage) => observer.onUsage?.(attemptId, usage),
    onAttemptEnd: (attemptId, outcome) => {
      metrics.recordWriterOutcome(outcome.state);
      observer.onAttemptEnd(attemptId, outcome);
    },
  };
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

// ---------------------------------------------------------------------------
// Strip-and-continue 第二层修复（2026-09-17 设计定稿）
//
// 原则：任何以 @ 开头的残句都不允许影响玩家可见内容；无法解析的 @ 行不再
// 直接断流报废，而是把该行从模型输出中剔除，然后利用模型的前缀续写能力
// 补全后续内容。同一 DslSegmentParser 实例贯穿续写——待提交的舞台提示与
// 打开中的表单状态原样存活（这是相对 fail→运行时修复链的核心增益）。
//
// 预算：每 attempt 最多剔除 1 次，防止模型反复写出同一坏行造成剔除循环；
// 预算耗尽回退到原有的 rejectLine（retry/fail）路径。首行即坏（无可续写
// 前缀）也回退原路径——空 assistant 前缀等于整段重发，徒增一跳。
// ---------------------------------------------------------------------------

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
  // @ending 出现在哨兵前（segment-validator 语义：交 strip-continue 剔除）。
  "ENDING_EPILOGUE_ORPHAN",
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
  /** 修复续写剩余行数预算：动态预算下续写也不得超支（含补写行）。 */
  remainingLines?: number,
): string {
  const parts = [
    "你上一段输出中有一行无法通过校验，系统已把它从你的输出中删除，输出在删除处中断。",
    `错误：${error.message}`,
  ];
  if (error.detail?.cause !== undefined) parts.push(`原因：${error.detail.cause}`);
  if (error.detail?.expected !== undefined) parts.push(`期望格式：${error.detail.expected}`);
  if (error.detail?.fix !== undefined) parts.push(`修正：${error.detail.fix}`);
  if (remainingLines !== undefined) {
    parts.push(
      remainingLines > 0
        ? `本段剩余正文行数上限：${remainingLines}（dialogue/narration 合计，含补写行），写完立即收束。`
        : "本段正文行数预算已用尽：删除处的合法内容补完后立即输出段结束哨兵，不要再写其他正文。",
    );
  }
  parts.push(
    [
      "请从删除位置直接续写：补全该处应有的合法内容，然后完成本段剩余部分。",
      "若是交互表单：@? 与提示文本必须写在同一行（`@? 提示文本`），随后写 @+ 选项行（2–5 个），最后用 @/? 收尾。",
      `最后必须逐字输出结束哨兵：@end ${nonce} ${allowedReasons.join("/")}。`,
      ...(allowedReasons.includes("ending")
        ? [
            "若本段以 ending 收束：哨兵后另起一行写 @ending <档位> <结尾词>（档位 TE|HE|NE|BE，结尾词是本局结局标题）。",
          ]
        : []),
      "不要重复删除位置之前已输出的任何内容，也不要再次输出被删除的那一行。",
    ].join("\n"),
  );
  return parts.join("\n");
}

/** 收尾模式给模型的原始输出尾部行数：含残句即可，无需全文。 */
const RAW_TAIL_LINES = 3;

/** Game 级 fail 错误形态：附带原始输出尾部（收尾模式补残句用，§8.5）。 */
export interface DslFailError extends Error {
  rawTail?: string;
}

/** 构造带 rawTail 的 fail 错误：Game 层窄化读取后透传进修复收尾请求。 */
function failWithRawTail(
  message: string,
  rawLines: readonly string[],
  cause?: unknown,
): Error {
  const error = new Error(message, ...(cause !== undefined ? [{ cause }] : [])) as DslFailError;
  error.rawTail = rawLines.slice(-RAW_TAIL_LINES).join("\n");
  return error;
}

/**
 * Event mode 收束/节奏指引（docs §70 附加指令）。全部追加在 user prompt
 * 末尾——这些内容逐请求变化，必须位于稳定前缀（素材/历史/状态）之后，
 * 否则会打破 provider 前缀缓存。endingRequired（L3 保险丝）优先于
 * endingPhase（L1/L2）。`{nonce}` 在此替换为请求的真实 nonce：此前该行
 * 在 fill() 之后以字面量 `{nonce}` 下发，模型回显后哨兵校验必然失败。
 */
/**
 * Event mode 收束/节奏指引分段（docs §70 附加指令）。每段返回无分隔符
 * 文本 + 审计标签；字符串路径（appendEventModeGuidance）与监控分段路径
 * 共用此处，保证两路产出逐字节一致。
 */
export function eventModeGuidancePieces(
  nonce: string,
  options?: GenerationStreamOptions,
): { label: string; text: string }[] {
  const pieces: { label: string; text: string }[] = [];
  // 长回合护栏与收束指令的互斥（2026-09-17 实测发现）：closing/L3 明确
  // "不要再打开交互表单"，此时再附"尽快打开交互表单"会让同一 prompt
  // 包含两条相反指令——护栏只在还允许交互的阶段（无收束/仅 L1 wrapup）
  // 生效。
  const interactionAllowed = !(
    options?.endingRequired === true || options?.endingPhase === "closing"
  );
  if (interactionAllowed && options?.requestInteraction === true) {
    pieces.push({
      label: "长回合护栏（催交互表单）",
      text: "本回合已连续输出较长内容：请在合适的位置尽快打开玩家交互表单（`@? ... @/?`），把话语权交还玩家。",
    });
  }
  if (options?.endingRequired === true) {
    pieces.push({
      label: "收束指令（L3 强制结局）",
      text: `本段必须收束结局：用 @end ${nonce} ending 结束，不得打开新的交互表单。`,
    });
  } else if (options?.endingPhase === "closing") {
    pieces.push({
      label: "收束指令（L2 closing）",
      text: `剧情已进入最后收束阶段：不要再打开新的交互表单，直接收拢当前线索，用 @end ${nonce} ending 结束本段。`,
    });
  } else if (options?.endingPhase === "wrapup") {
    // L1 是软提示：只引导"开始收拢、面向收尾"，把"不得再开表单/必须
    // ending"的硬措辞留给 L2（closing）——否则结局会固定落在 wrapup+1
    // 次交互，分级收束形同虚设（audit 2026-09-17 #3）。
    const { count, target } = options.interactionProgress ?? {};
    if (count !== undefined && target !== undefined && count > target) {
      pieces.push({
        label: "收束指令（L1 wrapup · 已超目标）",
        text: `收束阶段提示（交互数 ${count} 已超过收束目标 ${target}）：请加快节奏，把剧情收向本局结局；除非收尾确实需要，不要再打开新的交互表单，也不要引入新话题、新角色或新支线。`,
      });
    } else {
      pieces.push({
        label: "收束指令（L1 wrapup）",
        text: "剧情已进入收束阶段（本次游玩时长已经足够）：请开始收拢当前线索，接下来的交互应面向收尾（例如让玩家决定如何结束、和谁道别），而不是新的情节转折；不要再引入新话题、新角色或新支线。",
      });
    }
  }
  return pieces;
}

export function appendEventModeGuidance(
  extra: string,
  nonce: string,
  options?: GenerationStreamOptions,
): string {
  let result = extra;
  for (const piece of eventModeGuidancePieces(nonce, options)) {
    result += `\n\n${piece.text}`;
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
   * 修复续写剩余行数预算（target_lines − 已保留前缀文本行数）。>0 时
   * 续写模板与任务头用该值；≤0 时进入收尾模式（recovery 模板）。
   */
  remainingLines?: number;
  /** 失败段原始输出尾部（含残句）；仅收尾模式使用。 */
  rawTail?: string;
  /** 生成片 id（monitor 分组）：修复续写与原段共享，缺省各占一片。 */
  sliceId?: string;
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
  /** Labeled segmentation of `systemPrompt` (monitor audit view). */
  private readonly systemSegments: PromptSegment[];
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
    this.systemSegments = buildSystemContextSegments(
      this.makeCtx(null as unknown as StoryState, []),
    );
    this.systemPrompt = joinPromptSegments(this.systemSegments);
    this.modelCatalog = catalog ? toModelCatalog(catalog) : undefined;
    this.observer = observer ? withMetricsTap(observer, this.metrics) : observer;
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
    /** 任务头行数上限（修复续写传剩余预算）；缺省全额 target_lines。 */
    targetLines = this.config.text_buffer.target_lines,
  ): DslContextInput {
    const ctx: DslContextInput = {
      ...this.makeCtx(state, recentEvents),
      taskType,
      generationNonce: nonce,
      targetLines,
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

  /** The filled task template as one labeled trailing prompt section. */
  private templateSegment(taskType: string, text: string): PromptSegment {
    return { source: `prompts/instructions.yaml#${taskType}`, label: "任务指令模板", text };
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
      buildDslUserPromptSegments(turn, ctx, [
        this.templateSegment("opening", fill(this.instructions.opening, { nonce })),
      ]),
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
    const template = fill(this.instructions.branch_prefetch, {
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
      buildDslUserPromptSegments(turn, ctx, [this.templateSegment("branch_prefetch", template)]),
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
    const template = fill(this.instructions.input_response, {
      interaction_prompt: interaction.prompt,
      player_input: playerInput,
      nonce,
    });
    return this.requestDslEnvelope(
      "input_response",
      "input_response",
      ["buffer"],
      nonce,
      buildDslUserPromptSegments(turn, ctx, [this.templateSegment("input_response", template)]),
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
    const template = fill(this.instructions.input_bridge, {
      interaction_prompt: interaction.prompt,
      nonce,
    });
    return this.requestDslEnvelope(
      "input_bridge",
      "input_bridge",
      ["buffer"],
      nonce,
      buildDslUserPromptSegments(turn, ctx, [this.templateSegment("input_bridge", template)]),
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
    // 修复续写动态预算：剩余行数 > 0 只用剩余预算（防失败级联——每次
    // 全额续写会再造一段等长剧情）；剩余 ≤ 0（前缀已达上限）进入收尾
    // 模式：改用 recovery 模板，只允许补全残句（至多一行）并立即以
    // @end/表单收束，不推进新剧情。非修复请求缺省全额 target_lines。
    const remaining = options?.remainingLines;
    const wrapUp = remaining !== undefined && remaining <= 0;
    const effectiveTarget = wrapUp ? 0 : (remaining ?? this.config.text_buffer.target_lines);
    const ctx = this.buildDslCtx(
      state,
      recentHistory,
      "continuation",
      nonce,
      options,
      effectiveTarget,
    );
    const template = wrapUp
      ? fill(this.instructions.recovery, {
          nonce,
          repair_reason: options?.repairReason ?? "上一段输出未能正常结束。",
          prefetched: serializeStoryContext(prefetchedEvents),
          raw_tail: options?.rawTail ?? "（原始尾部不可用）",
        })
      : fill(this.instructions.continuation, {
          nonce,
          target_lines: String(effectiveTarget),
          prefetched: serializeStoryContext(prefetchedEvents),
        });
    const extra: PromptSegment[] = [
      this.templateSegment(wrapUp ? "recovery" : "continuation", template),
    ];
    for (const piece of eventModeGuidancePieces(nonce, options)) {
      extra.push({ source: "runtime/event-mode-guidance", label: piece.label, text: piece.text });
    }
    return this.requestDslEnvelope(
      "continuation",
      "continuation",
      ["buffer", "interaction", "ending"],
      nonce,
      buildDslUserPromptSegments(turn, ctx, extra),
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
    userSegments: readonly PromptSegment[],
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
      // The exact user message for this attempt: the base prompt plus the
      // repair instruction as its own labeled segment (its text already
      // starts with "\n" — raw append, no "\n\n" section separator).
      const attemptSegments: PromptSegment[] = [...userSegments];
      if (repairInstruction !== "") {
        attemptSegments.push({
          source: "runtime/repair",
          label: `修复指令（第 ${attempt} 次重试）`,
          text: repairInstruction,
        });
      }
      this.observer?.onAttemptStart({
        attemptId,
        taskId: requestId,
        taskType,
        index: attempt,
        ...(options?.sliceId ? { sliceId: options.sliceId } : {}),
      });
      this.observer?.onPrompt?.({
        attemptId,
        requestIndex: 0,
        messages: [
          { role: "system", segments: this.systemSegments },
          { role: "user", segments: attemptSegments },
        ],
      });
      let outcome: DslAttemptOutcome;
      try {
        outcome = await this.attemptDslStream(
          type,
          taskType,
          allowedReasons,
          nonce,
          attemptSegments,
          signal,
          options,
          lastError,
          attemptId,
        );
      } catch (error) {
        // Cancellation (branch discarded / active path replaced / restart)
        // and transport errors used to skip onAttemptEnd, leaving the
        // monitor attempt "streaming" forever (ghost 生成中 in the status
        // bar and the continuous document).
        this.observer?.onAttemptEnd(
          attemptId,
          signal?.aborted || isAbortError(error)
            ? { state: "cancelled", error: "请求已取消" }
            : { state: "failed", error: error instanceof Error ? error.message : String(error) },
        );
        throw error;
      }
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
    userSegments: readonly PromptSegment[],
    signal: AbortSignal | undefined,
    options: GenerationStreamOptions | undefined,
    /** Failure reason of the PREVIOUS attempt — only for the err= log field. */
    priorFailure: string,
    /** Monitor identity of this attempt (requestId#attemptIndex). */
    attemptId: string,
  ): Promise<DslAttemptOutcome> {
    // The exact user message this attempt sends — derived from the labeled
    // segments so the audit view and the wire bytes cannot diverge.
    const userPrompt = joinPromptSegments(userSegments);
    const observer = this.observer;
    const metrics = this.metrics;
    const maxTokens = this.config.generation.max_tokens;
    const callStart = Date.now();
    let firstLineMs = 0;
    let firstReasoningMs = 0;
    let reasoningChars = 0;
    let lineIndex = 0;
    let openFormStartLine: number | null = null;
    let streamChars = 0;
    const allGroups: EventGroupDraft[] = [];
    let streamAborted = false;
    let failureReason = "";
    let usage: { input: number; output: number; cachedInput?: number; reasoningTokens?: number } = {
      input: 0,
      output: 0,
    };
    // Real counters reported by the provider on the final stream chunk;
    // null when the gateway strips usage (estimate fallback below). Read via
    // reportedUsage(): assignments happen inside the lines generator below,
    // which TS control-flow analysis cannot see (it would narrow to never).
    // A strip-continue folds the current reading into `foldedUsage` and starts
    // over for the continuation stream — the attempt's usage is the sum.
    // 已知少计（2026-09-17 独立审计 S4）：流 1 的 usage 挂在最终 chunk，
    // 而 strip 发生时 lines 生成器被提前 return()，final usage chunk 读不到
    // → foldedUsage 实践中恒为 null，被中止流的 API 计数在指标里缺失。
    // 接受少计（不崩溃、不重复计）；如需精确，可在 strip 时用字符数估算兜底。
    let apiUsage: LLMUsageReading | null = null;
    let foldedUsage: LLMUsageReading | null = null;
    const reportedUsage = (): LLMUsageReading | null => {
      if (apiUsage === null) return foldedUsage;
      if (foldedUsage === null) return apiUsage;
      const reasoning =
        foldedUsage.reasoningTokens !== undefined || apiUsage.reasoningTokens !== undefined
          ? (foldedUsage.reasoningTokens ?? 0) + (apiUsage.reasoningTokens ?? 0)
          : undefined;
      return {
        input: foldedUsage.input + apiUsage.input,
        output: foldedUsage.output + apiUsage.output,
        cachedInput: (foldedUsage.cachedInput ?? 0) + (apiUsage.cachedInput ?? 0),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      };
    };

    // Strip-continue state: the raw model lines consumed so far (the
    // continuation replays them verbatim as an assistant prefix), a deferred
    // bare `@?` awaiting its next line, and the per-attempt strip budget.
    const rawLines: string[] = [];
    let pendingFormStart: { lineIndex: number; rawIndex: number } | null = null;
    let stripBudget = 1;
    // ending 哨兵的 epilogue 窗口收齐（@ending 已捕获或窗口被杂行关闭）后
    // 置位：停止消费模型输出——此后的一切都是结局残留，不解析、不进监控
    // 行号、不触发修复，也不再烧 token。
    let endingSettled = false;
    // Which SSE stream is currently authoritative; the outer abort signal
    // always bridges to the active one (a strip-continue swaps controllers).
    let activeController = new AbortController();
    const onAbort = () => activeController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    // Original error behind a mid-stream abort. Chained as the `cause` of
    // the wrap thrown to the runtime so error-class detection survives it.
    let streamError: unknown = undefined;

    // Provider end-of-stream signal (SSE finish_reason, rides the final
    // chunk): "stop" = the model finished on its own; "length" = cut by the
    // token budget; null/absent = gateway stripped it. Gates the
    // deterministic sentinel autoclose at finish() below.
    let finishReason: string | null = null;

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
            // DeepSeek thinking toggle (+ optional effort) as TOP-LEVEL fields.
            ...thinkingRequestBody(this.config.generation.thinking),
            messages,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: activeController.signal },
        );

      const stream = await createStream([
        { role: "system" as const, content: this.systemPrompt },
        { role: "user" as const, content: userPrompt },
      ]);

      const parser = new DslSegmentParser({ expectedNonce: nonce, allowedReasons });

      // SSE chunks → complete lines as a named async-generator transform:
      // usage capture, first-line timing and char counting live here, out of
      // the parse loop below. One decoder+generator per stream; a
      // strip-continue swaps in a fresh pair while the parser (and its
      // pending cues / open form) carries over.
      const makeLineStream = (
        sse: AsyncIterable<{
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null };
            finish_reason?: string | null;
          }>;
          usage?: unknown;
        }>,
        lineDecoder: StreamLineDecoder,
      ): AsyncGenerator<string> =>
        (async function* (): AsyncGenerator<string> {
          for await (const chunk of sse) {
            // Usage rides the final chunk, which usually carries empty choices —
            // capture it before the content check skips empty chunks.
            const chunkUsage = parseLLMUsage(chunk.usage);
            if (chunkUsage) apiUsage = chunkUsage;
            // finish_reason rides the final chunk (usually beside empty
            // choices); capture it before the content check skips the chunk.
            const chunkFinish = chunk.choices?.[0]?.finish_reason;
            if (chunkFinish) finishReason = chunkFinish;
            // Thinking deltas ride a sibling field (DeepSeek reasoning_content);
            // they must never reach the line decoder (DSL grammar) — counted
            // here for the usage report only.
            const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
            if (reasoning) {
              if (firstReasoningMs === 0) firstReasoningMs = Date.now();
              reasoningChars += reasoning.length;
            }
            const content = chunk.choices?.[0]?.delta?.content;
            if (!content) continue;
            if (firstLineMs === 0) {
              firstLineMs = Date.now();
              metrics?.recordFirstToken(firstLineMs - callStart);
            }
            streamChars += content.length;
            observer?.onDelta(attemptId, content);
            yield* lineDecoder.push(content);
          }
        })();

      let decoder = new StreamLineDecoder();
      let lines = makeLineStream(stream, decoder);

      /**
       * Strip-and-continue: delete the offending line from the model's raw
       * output and let it continue from the exact cut with the SAME parser
       * instance (committed groups, pending cues and any open form survive).
       * Returns false when not eligible (code not whitelisted, budget spent,
       * or nothing to continue from) — the caller falls back to rejectLine.
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
        observer?.onRepair?.(attemptId, {
          kind: "strip_continue",
          lineIndex: atLineIndex,
          message: `第 ${atLineIndex} 行无法解析，已剔除并让模型从断点续写：${error.message.slice(0, 100)}`,
        });
        if (staleDeferred !== null) {
          observer?.onRepair?.(attemptId, {
            kind: "strip_continue",
            lineIndex: staleDeferred.lineIndex,
            message: "连带剔除未合并的裸 @?（其提示缺失，交由续写补全）。",
          });
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
        foldedUsage = reportedUsage();
        apiUsage = null;
        // 续写流成为新的权威输出：被中止流的 finish_reason 作废。
        finishReason = null;
        const previousController = activeController;
        activeController = new AbortController();
        previousController.abort();
        const continuationInstruction = buildStripContinueInstruction(
          error,
          nonce,
          allowedReasons,
          options?.remainingLines,
        );
        // Audit: the strip-continue follow-up sends a different message list
        // (assistant prefix + continuation instruction) — report it as a
        // second request on the same attempt.
        observer?.onPrompt?.({
          attemptId,
          requestIndex: 1,
          messages: [
            { role: "system", segments: this.systemSegments },
            { role: "user", segments: [...userSegments] },
            {
              role: "assistant",
              segments: [
                { source: "writer-output/prefix", label: "续写前缀（本 attempt 已输出）", text: `${prefix}\n` },
              ],
            },
            {
              role: "user",
              segments: [
                { source: "runtime/strip-continue", label: "剔除续写指令", text: continuationInstruction },
              ],
            },
          ],
        });
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
          if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
            observer?.onLine(attemptId, lineIndex, { kind: null });
            continue;
          }
          rawLines.push(rawLine);

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
          // @-prefixed lines (@+/@= form rows) carry free text in the same
          // shape and must never be "repaired".
          const swapRepair = trimmed.startsWith("@")
            ? null
            : repairSwappedVisualSlots(trimmed, this.knownSpeakers);
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
              labelStripped ?? swapRepair?.line ?? closingRepair?.line ?? trimmed,
              this.knownSpeakers,
            );
          } catch (error) {
            if (error instanceof DslProtocolError) {
          // 旁白自标注标签（`旁白：正文` / `旁白: 正文`）——确定性剥掉，
          // 标签不进玩家正文、不造「旁白」名牌，上报监控计为修复。
          const labelStripped = trimmed.startsWith("旁白")
            ? stripNarrationLabel(trimmed, this.knownSpeakers)
            : null;
          if (labelStripped !== null) {
            observer?.onRepair?.(attemptId, {
              kind: "narration_label",
              lineIndex,
              message: `已剥离旁白自标注前缀：“${trimmed.slice(0, 40)}” → “${labelStripped.slice(0, 40)}”。`,
            });
          }

              observer?.onLine(attemptId, lineIndex, { kind: null, error: error.message });
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
            observer?.onLine(attemptId, lineIndex, { kind: "form_start" });
            continue;
          }
          if (pendingFormStart !== null) {
            if (parsed.kind === "narration" && parsed.text.trim() !== "") {
              const deferred = pendingFormStart;
              pendingFormStart = null;
              observer?.onRepair?.(attemptId, {
                kind: "form_prompt_merge",
                lineIndex: deferred.lineIndex,
                message: `表单提示写在了 @? 的下一行，已合并为 "@? ${parsed.text.slice(0, 40)}"。`,
              });
              observer?.onLine(attemptId, lineIndex, { kind: "form_start" });
              parsed = { kind: "form_start", prompt: parsed.text };
              openFormStartLine = deferred.lineIndex;
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
              observer?.onLine(attemptId, lineIndex, { kind: "form_start" });
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
                  observer?.onLine(attemptId, deferred.lineIndex, {
                    kind: null,
                    error: error.message,
                  });
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
                let closed: EventGroupDraft[];
                try {
                  closed = parser.closeOpenInteraction();
                } catch (closeError) {
                  if (closeError instanceof DslProtocolError) {
                    // 空表单（@? 提示在、零选项/零输入）收不了尾：本调用在
                    // catch 处理器内，closeError 若不接住会穿透 outer 循环
                    // 绕过整个修复信封（独立复核 N1）。剔除当前裸 @? 行，
                    // EMPTY_FORM 在白名单内 → 续写补全选项后收尾。
                    observer?.onLine(attemptId, lineIndex, {
                      kind: null,
                      error: closeError.message,
                    });
                    if (await tryStripContinue(closeError, rawLines.length - 1, lineIndex)) {
                      continue outer;
                    }
                    rejectLine(closeError, trimmed);
                    break;
                  }
                  throw closeError;
                }
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
              if (await tryStripContinue(error, rawLines.length - 1, lineIndex)) continue outer;
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
        // 结局残留：epilogue 窗口收齐后，无换行尾行与挂起的裸 @? 都不再
        // 处理——它们属于被丢弃的模型续写，不修复、不续写。
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
                observer?.onRepair?.(attemptId, {
                  kind: "form_prompt_merge",
                  lineIndex: deferred.lineIndex,
                  message: `表单提示写在了 @? 的下一行，已合并为 "@? ${tailParsed.text.slice(0, 40)}"。`,
                });
                observer?.onLine(attemptId, tailIndex, { kind: "form_start" });
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
                openFormStartLine = deferred.lineIndex;
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
                observer?.onLine(attemptId, deferred.lineIndex, {
                  kind: null,
                  error: emptyPromptError.message,
                });
                if (await tryStripContinue(emptyPromptError, deferred.rawIndex, deferred.lineIndex)) {
                  continue outer;
                }
                rejectLine(emptyPromptError, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
                break;
              }
            }
            if (!tailConsumedByMerge) {
              try {
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
                  tailLabel ?? tailSwap?.line ?? closingRepair?.line ?? trimmed,
                  this.knownSpeakers,
                );
                if (
                  tailParsed.kind === "segment_end" &&
                  tailParsed.reason === "interaction" &&
                  tailParsed.nonce === nonce &&
                const tailLabel = trimmed.startsWith("旁白")
                  ? stripNarrationLabel(trimmed, this.knownSpeakers)
                  : null;
                if (tailLabel !== null) {
                  observer?.onRepair?.(attemptId, {
                    kind: "narration_label",
                    lineIndex: tailIndex,
                    message: `已剥离旁白自标注前缀：“${trimmed.slice(0, 40)}” → “${tailLabel.slice(0, 40)}”。`,
                  });
                }
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
                lineIndex = tailIndex;
              } catch (error) {
                if (error instanceof DslProtocolError) {
                  observer?.onLine(attemptId, tailIndex, { kind: null, error: error.message });
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
          observer?.onLine(attemptId, deferred.lineIndex, {
            kind: null,
            error: emptyPromptError.message,
          });
          if (await tryStripContinue(emptyPromptError, deferred.rawIndex, deferred.lineIndex)) {
            continue outer;
          }
          rejectLine(emptyPromptError, rawLines[deferred.rawIndex] ?? "", deferred.lineIndex);
          break;
        }
        break;
      }

      const latencyMs = Date.now() - callStart;
      const reported = reportedUsage();
      // Thinking observability: duration spans the first reasoning delta to
      // the first content delta; tokens prefer the api-reported breakdown
      // and fall back to the legacy ~4 chars/token estimate.
      const thinkingMs =
        firstReasoningMs > 0 && firstLineMs > 0 ? firstLineMs - firstReasoningMs : undefined;
      if (thinkingMs !== undefined) metrics?.recordThinkingMs(thinkingMs);
      const reasoningTokens =
        reported?.reasoningTokens ?? (reasoningChars > 0 ? Math.ceil(reasoningChars / 4) : undefined);
      if (reported) {
        usage = {
          input: reported.input,
          output: reported.output,
          cachedInput: reported.cachedInput,
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        };
      } else {
        // Provider didn't report usage: keep the legacy char-based estimate.
        // Input is estimated from the prompt (~4 chars/token) so dashboards
        // do not read a genuine "0 input".
        usage = {
          input: Math.ceil(userPrompt.length / 4),
          output: Math.ceil(streamChars / 4),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        };
      }
      observer?.onUsage?.(attemptId, {
        input: usage.input,
        output: usage.output,
        cachedInput: usage.cachedInput ?? 0,
        source: reported ? "api" : "estimated",
        latencyMs,
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        ...(reasoningChars > 0 ? { reasoningChars } : {}),
      });
      // err= mirrors the legacy cross-attempt semantics: the failure of the
      // PREVIOUS attempt when this one succeeds — that is how operators
      // identify a successful repair retry in the logs.
      console.log(
        `[LLM] ${type}(${taskType}) ${latencyMs}ms lines=${lineIndex} in=${usage.input} out=${usage.output} cached=${usage.cachedInput ?? 0} src=${reported ? "api" : "est"} first=${firstLineMs ? firstLineMs - callStart : "?"}ms${reasoningTokens !== undefined ? ` think=${thinkingMs ?? "?"}ms/${reasoningTokens}tok` : ""} err=${failureReason || priorFailure || "ok"}`,
      );

      // Structurally invalid line with nothing forwarded yet → retry with
      // the repair instruction; with forwarded groups → fail and preserve
      // the prefix for the runtime's repair path. `failureReason` already
      // carries the "DSL 流在第 N 行校验失败：…" framing in that case.
      if (streamAborted) {
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        this.metrics?.recordSchemaValidationFailure();
        if (options?.onGroup && allGroups.length > 0) {
          return {
            kind: "fail",
            error: failWithRawTail(failureReason, rawLines, streamError),
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
            state_patch: {},
            groups: allGroups,
            segmentEnd: result.status,
          },
        };
      }

      // 确定性补哨兵（2026-09-18 实验 E2）：输出自然结束（finish_reason=stop，
      // 非预算截断）、全部行解析合法、parser 只差段尾哨兵、且本任务收束理由
      // 唯一（固定尾 buffer 类小任务：input_bridge / input_response /
      // branch_prefetch）时，本地合成哨兵行补完。这类任务的哨兵除 nonce 回显
      // 外不携带任何信息，漏写是纯形式性缺失；而 fail 路径的代价实测严重——
      // 桥接旁白整段废弃（玩家丢过渡）、分支预取降级为选中时重造（延迟）。
      // 截断（length / 缺失）与多理由任务不补：前者可能是真截断，后者的
      // reason（interaction/buffer/ending）承载语义，不可替模型决定。
      if (
        finishReason === "stop" &&
        allowedReasons.length === 1 &&
        pendingFormStart === null &&
        !parser.hasOpenInteraction()
      ) {
        const fixedReason = allowedReasons[0]!;
        const synthLine = `@end ${nonce} ${fixedReason}`;
        try {
          parser.pushLine({ kind: "segment_end", nonce, reason: fixedReason });
          const closed = parser.finish();
          if (closed.status.kind === "complete") {
            lineIndex += 1;
            rawLines.push(synthLine);
            observer?.onLine(attemptId, lineIndex, { kind: "segment_end" });
            observer?.onRepair?.(attemptId, {
              kind: "sentinel_autoclose",
              lineIndex,
              message: `输出自然结束但漏写段尾哨兵，已本地补「${synthLine}」（理由取本任务固定尾部）。`,
            });
            this.metrics?.recordLLMRequest(type, usage, latencyMs);
            options?.onSegmentEnd?.(closed.status);
            return {
              kind: "complete",
              envelope: {
                events: [],
                state_patch: {},
                groups: allGroups,
                segmentEnd: closed.status,
              },
            };
          }
        } catch {
          // 合成行被 parser 拒绝（理论不可达：nonce/reason 均来自本任务
          // 自身参数）——parser 状态未被消费，落回下方原 fail/retry 路径。
        }
      }

      // No @end sentinel → truncated segment (docs §49). With forwarded
      // groups the prefix is playable: fail so the Game repairs from the
      // committed boundary. Otherwise retry from scratch.
      this.metrics?.recordLLMRequest(type, usage, latencyMs);
      if (options?.onGroup && allGroups.length > 0) {
        return {
          kind: "fail",
          error: failWithRawTail(
            `DSL 流在第 ${lineIndex} 行之后结束但没有 @end 哨兵（输出被截断或漏写）。最后一行必须是 @end ${nonce} <reason>（nonce 原样照抄任务提示，reason 取 ${allowedReasons.join("/")}）`,
            rawLines,
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
        ...(request.sliceId ? { sliceId: request.sliceId } : {}),
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
          ...(request.remainingLines !== undefined
            ? { remainingLines: request.remainingLines }
            : {}),
          ...(request.rawTail ? { rawTail: request.rawTail } : {}),
          ...(request.sliceId ? { sliceId: request.sliceId } : {}),
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
