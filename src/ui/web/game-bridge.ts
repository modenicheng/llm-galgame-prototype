/**
 * GameBridge — connects the Game engine to the WebSocket server.
 *
 * Translates between the Game's blocking UI methods (implemented by WebUI)
 * and the browser's asynchronous WebSocket message protocol. Also manages
 * the autocomplete flow: debounced input from the browser is forwarded to
 * the AutocompleteManager, which calls the LLM and sends results back.
 */

import { Game } from "../../game.js";
import { StoryGenerator } from "../../llm.js";
import { AutocompleteManager } from "./autocomplete-manager.js";
import type { AppConfig } from "../../config.js";
import type { InteractionEvent } from "../../story/types.js";
import { WebServer } from "./server.js";
import { WebUI } from "./web-ui.js";
import type { WebSocket as WsImpl } from "ws";

export class GameBridge {
  private readonly server: WebServer;
  private readonly webUi: WebUI;
  private readonly autocomplete: AutocompleteManager;
  private readonly game: Game;

  constructor(
    config: AppConfig,
    generator: StoryGenerator,
    game: Game,
  ) {
    this.server = new WebServer();
    this.webUi = new WebUI(this.server);
    this.autocomplete = new AutocompleteManager(
      config.autocomplete,
      this.server,
      generator,
    );
    this.game = game;

    // Replace the Game's UI reference with the WebUI.
    (this.game as unknown as Record<string, unknown>).ui = this.webUi;

    this.setupMessageHandler();
  }

  /** Start the web server and the game. */
  async start(port: number): Promise<void> {
    await this.server.start(port);
    console.log(`Web UI available at http://localhost:${port}`);

    try {
      await this.game.run();
    } catch (error) {
      console.error("Game error:", error);
      this.server.broadcast({
        type: "log",
        message: `游戏运行错误：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Stop the server and clean up. */
  async stop(): Promise<void> {
    this.autocomplete.dispose();
    await this.server.stop();
  }

  // ---- Private: WebSocket message handling ----

  private setupMessageHandler(): void {
    this.server.onMessage((ws, msg) => {
      // Route input_change messages to the autocomplete handler
      if (msg.type === "input_change") {
        this.handleInputChange(ws, msg);
        return;
      }

      // Route composition state changes
      if (msg.type === "composition_start") {
        this.autocomplete.setComposing(true);
        return;
      }
      if (msg.type === "composition_end") {
        this.autocomplete.setComposing(false);
        return;
      }

      // All other messages are forwarded to WebUI
      this.webUi.routeMessage(msg);
    });
  }

  private handleInputChange(
    ws: WsImpl,
    msg: { text: string; interaction_id: string; revision: number },
  ): void {
    const ctx = this.game.getAutocompleteContext();
    const interaction = this.webUi.getCurrentInteraction();

    if (!interaction) return;

    this.autocomplete.onInputChange(
      ws,
      msg.text,
      msg.interaction_id,
      msg.revision,
      ctx.state,
      ctx.events,
      interaction,
    );
  }
}
