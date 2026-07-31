/**
 * AutocompleteManager — manages the autocomplete request lifecycle.
 *
 * Responsibilities:
 * - Debounce input changes (default 350ms)
 * - Track revision numbers to ignore stale responses
 * - Suppress requests during IME composition
 * - Call the LLM's generateAutocomplete method
 * - Emit results to the WebSocket
 */

import type { StoryGenerator } from "../../llm.js";
import type { AutocompleteConfig } from "../../config.js";
import type { StoryState, InteractionEvent, AutocompleteResult } from "../../story/types.js";
import type { StoryContextEvent } from "../../schema.js";
import type { WebServer } from "./server.js";
import type { WebSocket as WsImpl } from "ws";

interface PendingRequest {
  interactionId: string;
  revision: number;
  timer: ReturnType<typeof setTimeout>;
}

export class AutocompleteManager {
  private pending: PendingRequest | null = null;
  private composing = false;
  private latestRevision = 0;
  private abortController: AbortController | null = null;

  constructor(
    private readonly config: AutocompleteConfig,
    private readonly server: WebServer,
    private readonly generator: StoryGenerator,
  ) {}

  /** Mark that IME composition is in progress — suppress autocomplete. */
  setComposing(active: boolean): void {
    this.composing = active;
  }

  /**
   * Handle an input_change event from the browser.
   *
   * Debounces for config.debounce_ms then fires an autocomplete request if
   * the text is long enough.
   */
  onInputChange(
    ws: WsImpl,
    text: string,
    interactionId: string,
    revision: number,
    state: StoryState,
    history: StoryContextEvent[],
    interaction: InteractionEvent,
  ): void {
    this.latestRevision = Math.max(this.latestRevision, revision);

    // Clear any pending timer
    this.clearPending();

    // Cancel any in-flight request
    this.abortController?.abort();
    this.abortController = null;

    if (text.length < this.config.minimum_characters) {
      // Too short — send null to clear any existing suggestion
      this.server.send(ws, { type: "autocomplete", result: null });
      return;
    }

    this.pending = {
      interactionId,
      revision,
      timer: setTimeout(() => {
        this.pending = null;
        this.fireRequest(ws, text, interactionId, revision, state, history, interaction);
      }, this.config.debounce_ms),
    };
  }

  /** Dispose of the manager, cancelling all pending work. */
  dispose(): void {
    this.clearPending();
    this.abortController?.abort();
    this.abortController = null;
  }

  // ---- Private ----

  private clearPending(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
  }

  private async fireRequest(
    ws: WsImpl,
    text: string,
    interactionId: string,
    revision: number,
    state: StoryState,
    history: StoryContextEvent[],
    interaction: InteractionEvent,
  ): Promise<void> {
    if (this.composing) return;

    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      const result = await this.generator.generateAutocomplete(
        state,
        history,
        interaction,
        text,
        signal,
      );

      // Only emit if this is still the latest revision
      if (revision >= this.latestRevision && result) {
        this.server.send(ws, {
          type: "autocomplete",
          result: {
            suffix: result.suffix,
            intent: result.intent,
            confidence: result.confidence,
            revision: result.revision,
          },
        });
      } else if (revision >= this.latestRevision && !result) {
        this.server.send(ws, { type: "autocomplete", result: null });
      }
    } catch (error) {
      // Aborted or generation error — ignore silently
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        return;
      }
      // For other errors, send null to clear any stale suggestion
      if (revision >= this.latestRevision) {
        this.server.send(ws, { type: "autocomplete", result: null });
      }
    }
  }
}
