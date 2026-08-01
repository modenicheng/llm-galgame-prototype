/**
 * CLI controller: the only bridge between the terminal and the runtime.
 *
 * Subscribes to RuntimeOutput events, renders them through the pure-I/O
 * TerminalUI, and converts key/line input into RuntimeCommands. It never
 * reads runtime internals.
 */
import type { RuntimeCommand } from "../../core/runtime/runtime-command.js";
import type {
  RuntimeInteractionEvent,
  RuntimeOutput,
} from "../../core/runtime/runtime-output.js";
import type { Game } from "../../game.js";
import type { ChoiceEvent, HybridInteraction, RuntimePlayableEvent } from "../../schema.js";
import { TerminalUI } from "./terminal-ui.js";

export class CliController {
  private game: Game | null = null;

  constructor(private readonly ui: TerminalUI) {}

  attach(game: Game): void {
    this.game = game;
    game.subscribe((output) => {
      void this.onOutput(output);
    });
  }

  /** Run the game to completion (Ctrl+C propagates as UserExitError). */
  async run(): Promise<void> {
    if (!this.game) throw new Error("CliController: attach() 必须在 run() 之前调用");
    await this.game.run();
  }

  private async onOutput(output: RuntimeOutput): Promise<void> {
    switch (output.type) {
      case "session_started":
        this.ui.printSession(output.sessionId, output.location);
        break;
      case "playback_ready":
        await this.playPlayable(output.event);
        break;
      case "interaction_opened":
        await this.handleInteraction(output.interactionId, output.interaction);
        break;
      case "input_preview_opened":
        await this.handlePreview(output.previewId, output.text);
        break;
      case "status_changed":
        this.ui.setStatus(output.status);
        break;
      case "session_ended":
        this.ui.renderEnd(output.ending);
        break;
      case "runtime_error":
        this.ui.renderError(output.message);
        break;
      default:
        // input_preview_canceled / input_committed — the runtime handles
        // the state transition; no CLI rendering required.
        break;
    }
  }

  private async playPlayable(event: RuntimePlayableEvent): Promise<void> {
    if (event.type === "narration") {
      this.ui.renderNarration(event);
    } else {
      this.ui.renderDialogue(event);
    }
    await this.ui.waitForAdvance();
    this.dispatch({ type: "advance" });
  }

  private async handleInteraction(
    interactionId: string,
    interaction: RuntimeInteractionEvent,
  ): Promise<void> {
    if (interaction.type === "choice") {
      const selected = await this.ui.choose(interaction);
      this.dispatch({ type: "select_choice", interactionId, optionId: selected.id });
      return;
    }

    if (interaction.mode === "choice") {
      const choice: ChoiceEvent = {
        type: "choice",
        prompt: interaction.prompt,
        options: interaction.options!.map((option) => ({
          id: option.id,
          text: option.text,
        })),
      };
      const selected = await this.ui.choose(choice);
      this.dispatch({ type: "select_choice", interactionId, optionId: selected.id });
      return;
    }

    if (interaction.mode === "hybrid") {
      while (true) {
        const result = await this.ui.renderHybridInteraction(interaction as HybridInteraction);
        // Cancels just re-prompt; no runtime command involved.
        if (result.type === "cancel") continue;
        if (result.type === "choice") {
          this.dispatch({ type: "select_choice", interactionId, optionId: result.optionId });
        } else {
          this.dispatch({ type: "preview_input", interactionId, text: result.text });
        }
        return;
      }
    }

    // input mode: line editor loop until non-empty text is submitted.
    while (true) {
      const result = await this.ui.inputEditor(interaction);
      if (result.action === "cancel" || result.text.length === 0) continue;
      this.dispatch({ type: "preview_input", interactionId, text: result.text });
      return;
    }
  }

  private async handlePreview(previewId: string, text: string): Promise<void> {
    const job = this.ui.getStatus()?.jobs["input-response"];
    const generating = job?.state === "running" || job?.state === "queued";
    const result = await this.ui.inputPreview(text, generating);
    if (result.action === "confirm") {
      this.dispatch({ type: "confirm_input", previewId });
    } else {
      this.dispatch({ type: "cancel_input", previewId });
    }
  }

  private dispatch(command: RuntimeCommand): void {
    this.game?.dispatch(command);
  }
}
