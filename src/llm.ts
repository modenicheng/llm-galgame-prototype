import OpenAI from "openai";
import type { AppConfig, AuthorConfig } from "./config.js";
import {
  buildSystemContext,
  buildUserPrompt,
  type ContextInput,
} from "./story/context-builder.js";
import { parsePrefetchModelJsonl, parseTerminalModelJsonl } from "./jsonl.js";
import type { InstructionSet, PromptBundle } from "./prompts.js";
import type { LLMRequestCounts } from "./runtime/metrics.js";
import { Metrics } from "./runtime/metrics.js";
import {
  ModelEventSchema,
  type ChoiceEvent,
  type ChoiceOption,
  type InteractionEvent,
  type ModelEvent,
  type ModelPlayableEvent,
  type StoryContextEvent,
} from "./schema.js";
import type {
  AutocompleteResult,
  GenerationEnvelope,
  StoryState,
} from "./story/types.js";
import { AutocompleteResultSchema, GenerationEnvelopeSchema } from "./story/types.js";

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

function removeMarkdownFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:jsonl|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

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
      (text) => parseTerminalModelJsonl(text, this.config.game.max_events_per_segment),
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
      (text) =>
        parsePrefetchModelJsonl(
          text,
          this.config.prefetch.branch_max_events,
          this.config.prefetch.branch_dialogue_lines,
        ),
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
      (text) =>
        parsePrefetchModelJsonl(text, this.config.prefetch.branch_max_events, 1),
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
      (text) => parseTerminalModelJsonl(text, this.config.game.max_events_per_segment),
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
    fallbackParse: (text: string) => ModelEvent[],
  ): GenerationEnvelope {
    const cleaned = removeMarkdownFence(text);
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "events" in (parsed as Record<string, unknown>)
      ) {
        const envelope = GenerationEnvelopeSchema.parse(parsed) as GenerationEnvelope;
        const terminalIndexes = envelope.events
          .map((e, i) => (e.type === "choice" || e.type === "end" || e.type === "interaction" ? i : -1))
          .filter((i) => i >= 0);
        if (terminalIndexes.length > 0) {
          const lastTerminal = terminalIndexes[terminalIndexes.length - 1]!;
          if (lastTerminal !== envelope.events.length - 1 || terminalIndexes.length > 1) {
            throw new Error("envelope 中 terminal 事件必须且只能出现在末尾。");
          }
        }
        return envelope;
      }
    } catch { /* fall through */ }
    const events = fallbackParse(text);
    return { events, state_patch: {} };
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
    fallbackParse: (text: string) => ModelEvent[],
    signal?: AbortSignal,
    options?: GenerationStreamOptions,
  ): Promise<GenerationEnvelope> {
    let lastError = "";
    const attempts = this.config.generation.repair_attempts + 1;
    const maxTokens = this.config.generation.max_tokens;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      // On retry: add repair instruction + prefix hint
      const repairInstruction = lastError
        ? `\n上一份输出在第 ${lastError} 行出错。请从上一行之后继续，不要重复已输出的内容。`
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

          // Detect envelope format: single JSON object with "events" key
          if (events.length === 0 && rawLines.length === 1 && line.startsWith('{"events"')) {
            // Envelope mode — buffer all lines, parse at end
            continue;
          }

          // JSONL mode — parse each line immediately
          try {
            const parsed: unknown = JSON.parse(line);
            const event = ModelEventSchema.parse(parsed) as ModelEvent;
            events.push(event);
            options?.onEvent?.(event);
            if (events.length === 1) {
              console.log(`[LLM] ${type} 首句 ${Date.now() - callStart}ms → ${event.type}`);
            }
          } catch (error) {
            // Bad line — abort stream immediately. Keep the precise reason in
            // diagnostics; callers need to distinguish malformed JSON from a
            // schema violation when a live branch is being adopted.
            streamAborted = true;
            lastError = error instanceof Error ? error.message : String(error);
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
          if (options?.onEvent && events.length > 0) {
            throw new Error(`JSONL 第 ${events.length + 1} 行校验失败：${lastError}`);
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
          // If we parsed events incrementally (JSONL mode), validate as a batch
          if (events.length > 0) {
            const result = fallbackParse(rawLines.join("\n"));
            this.metrics?.recordLLMRequest(type, usage, latencyMs);
            return { events: result, state_patch: {} };
          }

          // Envelope mode — parse the full text
          const fullText = rawLines.join("\n");
          const envelope = this.parseGenerationEnvelope(fullText, fallbackParse);
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          return envelope;
        } catch (error) {
          this.metrics?.recordLLMRequest(type, usage, latencyMs);
          this.metrics?.recordSchemaValidationFailure();
          if (options?.onEvent && events.length > 0) {
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
