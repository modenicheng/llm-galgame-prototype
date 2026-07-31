import OpenAI from "openai";
import type { AppConfig, AuthorConfig } from "./config.js";
import {
  buildSystemContext,
  buildUserPrompt,
  type ContextInput,
} from "./story/context-builder.js";
import { parsePrefetchModelJsonl, parseTerminalModelJsonl, removeMarkdownFence, type ParsedJsonl } from "./jsonl.js";
import type { InstructionSet, PromptBundle } from "./prompts.js";
import type { LLMRequestCounts } from "./runtime/metrics.js";
import { Metrics } from "./runtime/metrics.js";
import { isStatePatchLine, ModelEventSchema, StatePatchLineSchema, type ChoiceEvent, type ChoiceOption, type InteractionEvent, type ModelEvent, type ModelPlayableEvent, type StoryContextEvent } from "./schema.js";
import type { AutocompleteResult, GenerationEnvelope, StoryState, StoryStatePatch } from "./story/types.js";
import { AutocompleteResultSchema } from "./story/types.js";
import { mergePatches } from "./story/patch.js";

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

export interface GenerationStreamOptions {
  /** Called as soon as one complete, schema-valid JSONL event arrives. */
  onEvent?: (event: ModelEvent) => void;
}

/** Strip runtime metadata fields that waste tokens when sent to the model. */
function stripRuntimeMeta(event: StoryContextEvent): Record<string, unknown> {
  const { seq, turn, timestamp, source, line_id, ...rest } = event as Record<string, unknown>;
  return rest;
}

// ---------------------------------------------------------------------------
// StoryGenerator
// ---------------------------------------------------------------------------

export class StoryGenerator {
  private readonly client: OpenAI;
  private readonly systemPrompt: string;
  private readonly prompts: PromptBundle;
  private readonly instructions: InstructionSet;

  constructor(
    private readonly config: AppConfig,
    prompts: PromptBundle,
    instructions: InstructionSet,
    apiKey: string,
    private readonly authorConfig?: AuthorConfig,
    private readonly metrics?: Metrics,
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
      outputProtocol: this.instructions.output_protocol,
    };
    if (this.authorConfig) {
      ctx.authorConfig = this.authorConfig;
    }
    return ctx;
  }

  generateOpening(
    turn: number,
    state: StoryState,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    const ctx = this.makeCtx(state, []);
    return this.requestEnvelope(
      "opening",
      buildUserPrompt(turn, ctx, this.instructions.opening),
      (text) => parseTerminalModelJsonl(text),
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
    const ctx = this.makeCtx(state, recentHistory);
    const extra = fill(this.instructions.branch_prefetch, {
      choice_prompt: choice.prompt,
      option_text: JSON.stringify(option),
      min_dialogue: this.config.prefetch.branch_dialogue_lines,
    });
    return this.requestEnvelope(
      "branch_prefetch",
      buildUserPrompt(turn, ctx, extra),
      (text) => ({
        events: parsePrefetchModelJsonl(
          text,
          this.config.prefetch.branch_dialogue_lines,
        ),
        patches: [],
      }),
      signal,
      options,
    );
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
    const ctx = this.makeCtx(state, recentHistory);
    const extra = fill(this.instructions.input_response, {
      interaction_prompt: interaction.prompt,
      player_input: playerInput,
    });
    return this.requestEnvelope(
      "continuation",
      buildUserPrompt(turn, ctx, extra),
      (text) => ({ events: parsePrefetchModelJsonl(text, 1), patches: [] }),
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
    const ctx = this.makeCtx(state, recentHistory);
    const extra = fill(this.instructions.continuation, {
      prefetched_jsonl: prefetchedEvents.map((e) => JSON.stringify(stripRuntimeMeta(e))).join("\n"),
    });
    return this.requestEnvelope(
      "continuation",
      buildUserPrompt(turn, ctx, extra),
      (text) => parseTerminalModelJsonl(text),
      signal,
      options,
    );
  }

  // -----------------------------------------------------------------------
  // Autocomplete
  // -----------------------------------------------------------------------

  async generateAutocomplete(
    state: StoryState,
    history: StoryContextEvent[],
    interaction: InteractionEvent,
    playerPrefix: string,
    signal?: AbortSignal,
  ): Promise<AutocompleteResult | null> {
    if (playerPrefix.trim().length < this.config.autocomplete.minimum_characters) {
      return null;
    }

    const recentHistory = history.slice(-6);
    const request = {
      model: this.config.api.model,
      temperature: 0.3,
      ...(this.config.api.token_limit_field === "max_tokens"
        ? { max_tokens: 80 }
        : { max_completion_tokens: 80 }),
      messages: [
        {
          role: "system" as const,
          content: fill(this.instructions.autocomplete_system, {
            max_suffix_characters: this.config.autocomplete.max_suffix_characters,
            confidence_threshold: this.config.autocomplete.confidence_threshold,
          }),
        },
        {
          role: "user" as const,
          content: this.buildAutocompletePrompt(state, recentHistory, interaction, playerPrefix),
        },
      ],
    };

    try {
      const completion = signal
        ? await this.client.chat.completions.create(request, { signal })
        : await this.client.chat.completions.create(request);

      const text = completion.choices[0]?.message.content;
      if (!text) return null;

      const cleaned = removeMarkdownFence(text);
      const parsed: unknown = JSON.parse(cleaned);
      const result = AutocompleteResultSchema.parse(parsed) as AutocompleteResult;

      if (result.confidence < this.config.autocomplete.confidence_threshold) return null;

      if (result.suffix.length > this.config.autocomplete.max_suffix_characters) {
        result.suffix = result.suffix.slice(0, this.config.autocomplete.max_suffix_characters);
      }

      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return null;
    }
  }

  /** Build the user-facing autocomplete prompt. Kept in code due to programmatic construction. */
  private buildAutocompletePrompt(
    state: StoryState,
    recentHistory: StoryContextEvent[],
    interaction: InteractionEvent,
    playerPrefix: string,
  ): string {
    const lines: string[] = [];
    const timeStr = state.scene.time ? ` (${state.scene.time})` : "";
    lines.push(`当前场景：${state.scene.location}${timeStr}`);

    const charIds = Object.keys(state.characters);
    if (charIds.length > 0) {
      const charDescs = charIds.map((id) => {
        const c = state.characters[id];
        const parts = [id];
        if (c?.emotion) parts.push(`情绪:${c.emotion}`);
        if (c?.location) parts.push(`位置:${c.location}`);
        return parts.join(" ");
      });
      lines.push(`在场角色：${charDescs.join("；")}`);
    }

    if (recentHistory.length > 0) {
      lines.push("最近对话：");
      for (const event of recentHistory.slice(-4)) {
        if (event.type === "dialogue") {
          lines.push(`  ${event.speaker}："${event.text.slice(0, 100)}"`);
        } else if (event.type === "narration") {
          lines.push(`  [旁白] ${event.text.slice(0, 80)}`);
        }
      }
    }

    lines.push(`当前提示：${interaction.prompt}`);
    lines.push(`玩家正在输入："${playerPrefix}"`);
    lines.push("请预测补全后缀。");

    return lines.join("\n");
  }

  // -----------------------------------------------------------------------
  // Private: streaming request + line-by-line parsing
  // -----------------------------------------------------------------------

  private parseGenerationEnvelope(
    text: string,
    fallbackParse: (text: string) => ParsedJsonl,
  ): ParsedJsonl {
    return fallbackParse(removeMarkdownFence(text));
  }

  /**
   * Yield complete lines from a streaming chat completion.
   * Buffers partial chunks until a newline arrives.
   */
  private async *streamLines(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  ): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (!text) continue;
      buffer += text;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  }

  private async requestEnvelope(
    type: LLMRequestCounts extends Record<infer K, number> ? K : never,
    userPrompt: string,
    fallbackParse: (text: string) => ParsedJsonl,
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    let lastError = "";
    const attempts = this.config.generation.repair_attempts + 1;
    const maxTokens = this.config.generation.max_tokens;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // On retry: add repair instruction describing the previous failure.
      const repairInstruction = lastError
        ? `\n上一份输出出错：${lastError}。请修正该问题后从失败位置继续，不要重复已输出的内容。`
        : "";

      const callStart = Date.now();
      let firstLineMs = 0;
      const rawLines: string[] = [];
      const events: ModelEvent[] = [];
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

      // Parsed JSONL events and in-band state patches.
      const patches: StoryStatePatch[] = [];

      try {
        const stream = await this.client.chat.completions.create(
          {
            model: this.config.api.model,
            temperature: this.config.generation.temperature,
            ...(this.config.api.token_limit_field === "max_tokens"
              ? { max_tokens: maxTokens }
              : { max_completion_tokens: maxTokens }),
            messages: [
              { role: "system" as const, content: this.systemPrompt },
              { role: "user" as const, content: `${userPrompt}${repairInstruction}` },
            ],
            stream: true,
          },
          { signal: controller.signal },
        );

        for await (const line of this.streamLines(stream)) {
          if (firstLineMs === 0) firstLineMs = Date.now();
          rawLines.push(line);

          // Tolerate markdown fence markers around the JSONL payload.
          const trimmed = line.trim();
          if (trimmed.startsWith("```") || trimmed.endsWith("```")) continue;

          // Parse each line immediately.
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch (error) {
            // Malformed line. Once events have been published (or patches
            // applied), the stream is corrupt — abort and preserve the
            // prefix so the runtime can keep what is already playable.
            // Otherwise retry the whole request (fence/JSONL shape errors
            // are fixed by the repair instruction on the next attempt).
            streamAborted = true;
            lastError = `第 ${rawLines.length} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
            controller.abort();
            break;
          }

          // In-band state update — validated here, applied by the runtime
          // after the request completes. Never enters the playback stream.
          if (isStatePatchLine(parsed)) {
            try {
              patches.push(StatePatchLineSchema.parse(parsed).patch as StoryStatePatch);
            } catch (error) {
              streamAborted = true;
              lastError = `第 ${rawLines.length} 行 state_patch 校验失败：${error instanceof Error ? error.message : String(error)}`;
              controller.abort();
              break;
            }
            continue;
          }

          try {
            const event = ModelEventSchema.parse(parsed) as ModelEvent;
            events.push(event);
            options?.onEvent?.(event);
            if (events.length === 1) {
              console.log(`[LLM] ${type} 首句 ${Date.now() - callStart}ms → ${event.type}`);
            }
          } catch (error) {
            streamAborted = true;
            lastError = `第 ${rawLines.length} 行事件校验失败：${error instanceof Error ? error.message : String(error)}`;
            controller.abort();
            break;
          }
        }

        signalCleanup();

        const latencyMs = Date.now() - callStart;

        // Collect usage from the final chunk (only available with include_usage)
        // We can't easily get this from the stream; estimate from raw text
        const outputChars = rawLines.join("\n").length;
        usage = { input: 0, output: Math.ceil(outputChars / 4) };
        console.log(`[LLM] ${type} ${latencyMs}ms lines=${rawLines.length} first=${firstLineMs ? firstLineMs - callStart : "?"}ms err=${lastError || "ok"}`);

        // If we aborted mid-stream due to a bad line, retry
        if (streamAborted) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          this.metrics?.recordSchemaValidationFailure();
          // Once events have been published to the runtime, retrying from the
          // beginning would duplicate already assigned line IDs and corrupt
          // the active playback path. Keep the partial stream and fail it so
          // the runtime can preserve what is already playable.
          if (options?.onEvent && (events.length > 0 || patches.length > 0)) {
            throw new Error(`JSONL 流在第 ${rawLines.length} 行校验失败：${lastError}`);
          }
          continue;
        }

        // No lines at all
        if (rawLines.length === 0) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          lastError = "模型返回空内容。";
          continue;
        }

        // Try to parse the result
        try {
          const fullText = rawLines.join("\n");
          if (events.length > 0) {
            // Events were parsed incrementally — validate the batch now
            // (terminal placement rules, etc.) and collect any patches.
            const result = fallbackParse(fullText);
            this.metrics?.recordLLMRequest(type, usage, latencyMs);
            return {
              events: result.events,
              state_patch: mergePatchesList([...result.patches, ...patches]),
            };
          }

          // No events were published — whole-text parse with fence stripping
          // (covers fence-wrapped or batched outputs that were not
          // line-parsable, e.g. a single chunk containing many lines).
          const result = this.parseGenerationEnvelope(fullText, fallbackParse);
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          return {
            events: result.events,
            state_patch: mergePatchesList([...result.patches, ...patches]),
          };
        } catch (error) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          this.metrics?.recordSchemaValidationFailure();
          if (options?.onEvent && (events.length > 0 || patches.length > 0)) {
            throw error;
          }
          lastError = error instanceof Error ? error.message : String(error);
        }
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
