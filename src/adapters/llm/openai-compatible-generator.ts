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
  DslProtocolError,
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
   * EventGroupDrafts via options.onGroup. A structurally invalid line with
   * already-forwarded groups fails the request (the runtime preserves the
   * prefix); otherwise the outcome is repairable. A truncated tail without
   * a trailing newline is dropped (docs §49–§50).
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

    const controller = new AbortController();
    const signalCleanup = signal
      ? (() => {
          const onAbort = () => controller.abort();
          signal.addEventListener("abort", onAbort, { once: true });
          return () => signal.removeEventListener("abort", onAbort);
        })()
      : () => {};

    // Original error behind a mid-stream abort. Chained as the `cause` of
    // the wrap thrown to the runtime so error-class detection survives it.
    let streamError: unknown = undefined;

    try {
      const stream = await this.client.chat.completions.create(
        this.buildStreamRequest(maxTokens, userPrompt),
        { signal: controller.signal },
      );

      const decoder = new StreamLineDecoder();
      const parser = new DslSegmentParser({ expectedNonce: nonce, allowedReasons });

      // SSE chunks → complete lines as a named async-generator transform:
      // first-line timing and char counting live here, out of the parse
      // loop below. The decoder stays outside so the consumer can flush
      // the truncated tail after the stream ends.
      const lines = (async function* (): AsyncGenerator<string> {
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content;
          if (!content) continue;
          if (firstLineMs === 0) firstLineMs = Date.now();
          streamChars += content.length;
          yield* decoder.push(content);
        }
      })();

      const emit = (emitted: EventGroupDraft[]): void => {
        allGroups.push(...emitted);
        for (const group of emitted) {
          options?.onGroup?.(group);
        }
      };

      // Shared handling for parse/validation rejections: with a forwarded
      // prefix the attempt FAILS (runtime repairs from the committed
      // boundary); without one it is repairable → retry with the reason.
      // The framing strings reproduce the legacy messages byte-for-byte
      // (they ride into the model's repair instruction): `第 N 行不是合法
      // DSL：` has no space after 行, `第 N 行 DSL 校验失败：` has one —
      // hence the load-bearing leading space below.
      const rejectLine = (framing: string, error: DslProtocolError): void => {
        streamAborted = true;
        if (options?.onGroup && allGroups.length > 0) {
          streamError = error;
          failureReason = `DSL 流在第 ${lineIndex} 行校验失败：${error.message}`;
        } else {
          failureReason = `第 ${lineIndex} 行${framing}：${error.message}`;
        }
        controller.abort();
      };

      for await (const rawLine of lines) {
        lineIndex += 1;

        // Tolerate markdown fence markers around the DSL payload.
        const trimmed = rawLine.trim();
        if (trimmed.startsWith("```") || trimmed.endsWith("```")) continue;

        let parsed: DslLine;
        try {
          parsed = parseDslLine(trimmed);
        } catch (error) {
          if (error instanceof DslProtocolError) {
            rejectLine("不是合法 DSL", error);
            break;
          }
          throw error;
        }

        let emitted: EventGroupDraft[];
        try {
          emitted = parser.pushLine(parsed);
        } catch (error) {
          if (error instanceof DslProtocolError) {
            rejectLine(" DSL 校验失败", error);
            break;
          }
          throw error;
        }

        if (emitted.length > 0) emit(emitted);
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
            const emitted = parser.pushLine(parseDslLine(trimmed));
            if (emitted.length > 0) emit(emitted);
          } catch (error) {
            if (error instanceof DslProtocolError) {
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
      // carries the "DSL 流在第 N 行校验失败：…" framing in that case.
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
            `DSL 流在第 ${lineIndex} 行校验失败：段结束时没有 @end 哨兵（截断）`,
          ),
        };
      }
      return { kind: "retry", reason: "段结束时没有 @end 哨兵（截断）" };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      this.metrics?.recordLLMRequest(type, usage, Date.now() - callStart);
      throw error;
    } finally {
      signalCleanup();
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
