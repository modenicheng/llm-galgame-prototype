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
   * Per-turn narrative director brief injected as a director note section
   * in the user prompt (docs narrative-director §Task-10).
   */
  brief?: NarrativeBrief;
}

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
    if (options?.brief) {
      ctx.directorBrief = options.brief;
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
    const recentHistory = history.slice(-this.config.game.history_events);
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
    const recentHistory = history.slice(-this.config.game.history_events);
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, recentHistory, "input_response", nonce, options);
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
    const recentHistory = history.slice(-this.config.game.history_events);
    const nonce = generateNonce();
    const ctx = this.buildDslCtx(state, recentHistory, "continuation", nonce, options);
    const extra = fill(this.instructions.continuation, {
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
   * DSL-mode streaming request (docs §40–§51).
   * retry/abort/metrics skeleton, but each line is parsed by the Gal DSL
   * pipeline: fence markers are skipped, parseDslLine + DslSegmentParser
   * validate incrementally, and committed EventGroupDrafts are forwarded via
   * options.onGroup. A structurally invalid line with already-forwarded
   * groups fails the request (the runtime preserves the prefix); otherwise
   * the attempt is repaired and retried. A truncated tail without a trailing
   * newline is dropped (docs §49–§50).
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
    const maxTokens = this.config.generation.max_tokens;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // On retry: add repair instruction describing the previous failure
      // (provider-internal `lastError` and/or Game-level options.repairReason).
      const repairParts = [lastError, options?.repairReason].filter(
        (reason): reason is string => Boolean(reason),
      );
      const repairInstruction = repairParts.length
        ? `\n${repairParts
            .map(
              (reason) =>
                `上一份输出出错：${reason}。请修正该问题后从失败位置继续，不要重复已输出的内容。`,
            )
            .join("\n")}`
        : "";

      const callStart = Date.now();
      let firstLineMs = 0;
      let lineIndex = 0;
      let streamChars = 0;
      const allGroups: EventGroupDraft[] = [];
      let streamAborted = false;
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
              { role: "user" as const, content: `${userPrompt}${repairInstruction}` },
            ],
            stream: true,
          },
          { signal: controller.signal },
        );

        const decoder = new StreamLineDecoder();
        const parser = new DslSegmentParser({ expectedNonce: nonce, allowedReasons });

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content;
          if (!content) continue;
          if (firstLineMs === 0) firstLineMs = Date.now();
          streamChars += content.length;

          for (const rawLine of decoder.push(content)) {
            lineIndex += 1;

            // Tolerate markdown fence markers around the DSL payload.
            const trimmed = rawLine.trim();
            if (trimmed.startsWith("```") || trimmed.endsWith("```")) continue;

            let parsed: DslLine;
            try {
              parsed = parseDslLine(trimmed);
            } catch (error) {
              if (error instanceof DslProtocolError) {
                streamAborted = true;
                if (options?.onGroup && allGroups.length > 0) {
                  streamError = error;
                  lastError = `DSL 流在第 ${lineIndex} 行校验失败：${error.message}`;
                } else {
                  lastError = `第 ${lineIndex} 行不是合法 DSL：${error.message}`;
                }
                controller.abort();
                break;
              }
              throw error;
            }

            let emitted: EventGroupDraft[];
            try {
              emitted = parser.pushLine(parsed);
            } catch (error) {
              if (error instanceof DslProtocolError) {
                streamAborted = true;
                if (options?.onGroup && allGroups.length > 0) {
                  streamError = error;
                  lastError = `DSL 流在第 ${lineIndex} 行校验失败：${error.message}`;
                } else {
                  lastError = `第 ${lineIndex} 行 DSL 校验失败：${error.message}`;
                }
                controller.abort();
                break;
              }
              throw error;
            }

            if (emitted.length > 0) {
              allGroups.push(...emitted);
              for (const group of emitted) {
                options?.onGroup?.(group);
              }
            }
          }
          if (streamAborted) break;
        }

        signalCleanup();

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
              const parsed = parseDslLine(trimmed);
              const emitted = parser.pushLine(parsed);
              if (emitted.length > 0) {
                allGroups.push(...emitted);
                for (const group of emitted) {
                  options?.onGroup?.(group);
                }
              }
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
        console.log(
          `[LLM] ${type}(${taskType}) ${latencyMs}ms lines=${lineIndex} first=${firstLineMs ? firstLineMs - callStart : "?"}ms err=${lastError || "ok"}`,
        );

        // Structurally invalid line with nothing forwarded yet → retry with
        // the repair instruction; with forwarded groups → fail and preserve
        // the prefix for the runtime's repair path. `lastError` already
        // carries the "DSL 流在第 N 行校验失败：…" framing in that case.
        if (streamAborted) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          this.metrics?.recordSchemaValidationFailure();
          if (options?.onGroup && allGroups.length > 0) {
            throw new Error(lastError, { cause: streamError });
          }
          continue;
        }

        // Empty output — nothing at all (fences alone do not count).
        if (lineIndex === 0 && allGroups.length === 0) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          lastError = "模型返回空内容。";
          continue;
        }

        const result = parser.finish();
        if (result.status.kind === "complete") {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          options?.onSegmentEnd?.(result.status);
          return {
            events: [],
            state_patch: {},
            groups: allGroups,
            segmentEnd: result.status,
          };
        }

        // No @end sentinel → truncated segment (docs §49). With forwarded
        // groups the prefix is playable: fail so the Game repairs from the
        // committed boundary. Otherwise retry from scratch.
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        if (options?.onGroup && allGroups.length > 0) {
          throw new Error(
            `DSL 流在第 ${lineIndex} 行校验失败：段结束时没有 @end 哨兵（截断）`,
          );
        }
        lastError = "段结束时没有 @end 哨兵（截断）";
      } catch (error) {
        signalCleanup();
        if (signal?.aborted || isAbortError(error)) throw error;
        const latencyMs = Date.now() - callStart;
        this.metrics?.recordLLMRequest(type, usage, latencyMs);
        throw error;
      }
    }

    throw new Error(`模型输出连续校验失败：${lastError}`);
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
