/**
 * WebUI — implements the GameUI interface for browser-based interaction.
 *
 * Instead of reading from stdin and writing to stdout, this class
 * communicates with the browser via WebSocket messages. Each blocking
 * UI method (choose, inputEditor, etc.) sends a message to the browser
 * and returns a Promise that resolves when the browser responds.
 */

import type { GameUI } from "../../ui.js";
import type {
  ChoiceEvent,
  ChoiceOption,
  InteractionEvent,
  RuntimeDialogueEvent,
  RuntimeNarrationEvent,
  EndEvent,
} from "../../schema.js";
import type { RuntimeStatus, RuntimeStatusSnapshot } from "../../status.js";
import type {
  DisplayEvent,
  InteractionPayload,
  UIStatePayload,
} from "./server.js";
import type { WebServer } from "./server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDisplayEvent(event: RuntimeDialogueEvent | RuntimeNarrationEvent | EndEvent): DisplayEvent {
  if (event.type === "narration") {
    return { type: "narration", line_id: event.line_id, text: event.text };
  }
  if (event.type === "dialogue") {
    return {
      type: "dialogue",
      line_id: event.line_id,
      text: event.text,
      speaker: event.speaker,
      portrait: event.portrait ?? null,
    };
  }
  return {
    type: "end",
    text: event.text,
    ending_id: event.ending_id,
  };
}

function buildStatePayload(snapshot: RuntimeStatusSnapshot): UIStatePayload {
  return {
    phase: snapshot.phase,
    message: snapshot.message,
    buffered_events: snapshot.bufferedEvents,
    buffered_dialogue_lines: snapshot.bufferedDialogueLines,
  };
}

// ---------------------------------------------------------------------------
// WebUI
// ---------------------------------------------------------------------------

export class WebUI implements GameUI {
  private currentResolver: ((value: unknown) => void) | null = null;
  private currentRejecter: ((reason: Error) => void) | null = null;
  private currentInteraction: InteractionEvent | null = null;

  constructor(private readonly server: WebServer) {
    // Message routing is set up externally by GameBridge via routeMessage()
  }

  /** Get the interaction event currently being handled (for autocomplete context). */
  getCurrentInteraction(): InteractionEvent | null {
    return this.currentInteraction;
  }

  /** Route an incoming WebSocket message from the bridge. */
  routeMessage(msg: { type: string; [key: string]: unknown }): void {
    this.handleMessage(msg);
  }

  // ---- GameUI implementation ----

  printSession(sessionId: string, filePath: string): void {
    console.log(`会话已创建：${sessionId}`);
    console.log(`记录文件：${filePath}`);
    this.server.broadcast({
      type: "log",
      message: `会话已创建：${sessionId}`,
    });
  }

  async renderNarration(
    event: RuntimeNarrationEvent,
    status: RuntimeStatus,
  ): Promise<void> {
    this.sendStatus(status);
    this.server.broadcast({
      type: "display",
      events: [buildDisplayEvent(event)],
    });
    await this.waitForAdvance(status);
  }

  async renderDialogue(
    event: RuntimeDialogueEvent,
    status: RuntimeStatus,
  ): Promise<void> {
    this.sendStatus(status);
    this.server.broadcast({
      type: "display",
      events: [buildDisplayEvent(event)],
    });
    await this.waitForAdvance(status);
  }

  renderEnd(event: EndEvent): void {
    this.server.broadcast({
      type: "display",
      events: [buildDisplayEvent(event)],
    });
  }

  async choose(event: ChoiceEvent, status: RuntimeStatus): Promise<ChoiceOption> {
    this.currentInteraction = null;
    this.sendStatus(status);
    const payload: InteractionPayload = {
      interaction_id: `choice_${event.options.map((o) => o.id).join("_")}`,
      prompt: event.prompt,
      mode: "choice",
      options: event.options.map((o) => ({ id: o.id, text: o.text })),
    };
    this.server.broadcast({ type: "interaction", interaction: payload });

    const result = await this.waitForClientMessage<{ option_id: string }>("option_select");
    const selected = event.options.find((o) => o.id === result.option_id);
    if (!selected) throw new Error(`未找到选项：${result.option_id}`);
    return selected;
  }

  async inputEditor(
    interaction: InteractionEvent,
    initialText: string,
    status: RuntimeStatus,
  ): Promise<{ action: "confirm" | "cancel"; text: string }> {
    this.currentInteraction = interaction;
    this.sendStatus(status);
    const payload: InteractionPayload = {
      interaction_id: interaction.interaction_id,
      prompt: interaction.prompt,
      mode: interaction.mode,
      options: interaction.options?.map((o) => ({ id: o.id, text: o.text })),
      input: interaction.input
        ? {
            kind: interaction.input.kind,
            placeholder: interaction.input.placeholder,
            max_length: interaction.input.max_length,
          }
        : undefined,
      draft: initialText,
      preview_phase: false,
    };
    this.server.broadcast({ type: "interaction", interaction: payload });

    const result = await this.waitForClientMessage<
      { action: "confirm" | "cancel"; text: string }
    >("input_confirm", "input_cancel");

    if (result._msgType === "input_cancel") {
      return { action: "cancel", text: result.text ?? "" };
    }
    return { action: "confirm", text: result.text ?? "" };
  }

  async inputPreview(
    text: string,
    interaction: InteractionEvent,
    status: RuntimeStatus,
    generatingResponse: boolean,
  ): Promise<{ action: "confirm" | "cancel" }> {
    this.sendStatus(status);
    const payload: InteractionPayload = {
      interaction_id: interaction.interaction_id,
      prompt: interaction.prompt,
      mode: interaction.mode,
      input: interaction.input
        ? {
            kind: interaction.input.kind,
            placeholder: interaction.input.placeholder,
            max_length: interaction.input.max_length,
          }
        : undefined,
      preview_phase: true,
      preview_text: text,
      generating_response: generatingResponse,
    };
    this.server.broadcast({ type: "interaction", interaction: payload });

    const result = await this.waitForClientMessage<
      { action: "confirm" | "cancel" }
    >("preview_confirm", "preview_cancel");

    return { action: result._msgType === "preview_cancel" ? "cancel" : "confirm" };
  }

  async renderHybridInteraction(
    event: InteractionEvent & {
      options: NonNullable<InteractionEvent["options"]>;
      input: NonNullable<InteractionEvent["input"]>;
    },
    status: RuntimeStatus,
  ): Promise<
    | { type: "choice"; optionId: string }
    | { type: "input"; text: string }
    | { type: "cancel" }
  > {
    this.currentInteraction = event;
    this.sendStatus(status);
    const payload: InteractionPayload = {
      interaction_id: event.interaction_id,
      prompt: event.prompt,
      mode: "hybrid",
      options: event.options.map((o) => ({ id: o.id, text: o.text })),
      input: {
        kind: event.input.kind,
        placeholder: event.input.placeholder,
        max_length: event.input.max_length,
      },
      draft: "",
      preview_phase: false,
    };
    this.server.broadcast({ type: "interaction", interaction: payload });

    const result = await this.waitForClientMessage<
      | { type: "choice"; option_id: string }
      | { type: "input"; text: string }
      | { type: "cancel" }
    >("hybrid_choice", "hybrid_input", "hybrid_cancel");

    if (result._msgType === "hybrid_cancel") {
      return { type: "cancel" };
    }
    if (result._msgType === "hybrid_choice") {
      const choiceResult = result as unknown as { option_id: string };
      return { type: "choice", optionId: choiceResult.option_id };
    }
    const inputResult = result as unknown as { text: string };
    return { type: "input", text: inputResult.text ?? "" };
  }

  async waitForTask<T>(
    promise: Promise<T>,
    label: string,
    status: RuntimeStatus,
  ): Promise<T> {
    this.server.broadcast({
      type: "log",
      message: label,
    });
    this.sendStatus(status);
    try {
      return await promise;
    } finally {
      this.sendStatus(status);
    }
  }

  // ---- Internal helpers ----

  private async waitForAdvance(status: RuntimeStatus): Promise<void> {
    this.currentInteraction = null;
    this.sendStatus(status);
    await this.waitForClientMessage("advance");
  }

  private sendStatus(status: RuntimeStatus): void {
    const snapshot = status.snapshot();
    this.server.broadcast({
      type: "state",
      state: buildStatePayload(snapshot),
    });
  }

  /**
   * Wait for a specific client message type, returning the parsed payload.
   *
   * Uses a generic one-shot resolver pattern: each call sets up a Promise
   * and the message handler resolves it when a matching message arrives.
   *
   * Returns the raw message with an extra `_msgType` field for dispatch.
   */
  private waitForClientMessage<T>(
    ...types: string[]
  ): Promise<T & { _msgType: string }> {
    if (this.currentResolver) {
      throw new Error("WebUI: overlapping waitForClientMessage calls");
    }

    return new Promise<T & { _msgType: string }>((resolve, reject) => {
      this.currentResolver = (value) => {
        const msg = value as T & { _msgType: string };
        if (types.includes(msg._msgType)) {
          this.currentResolver = null;
          this.currentRejecter = null;
          resolve(msg);
        }
      };
      this.currentRejecter = reject;
    });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    // Route messages to the current resolver if applicable.
    // The resolver checks if the message type matches its expected types;
    // non-matching messages are silently dropped (the resolver stays in place).
    if (this.currentResolver) {
      this.currentResolver({ ...msg, _msgType: msg.type });
    }
  }
}
