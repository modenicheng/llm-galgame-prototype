/**
 * RuntimeApplication — the unified composition root contract.
 *
 * `createRuntimeApplication()` builds the entire Node-side runtime
 * (config, prompts, LLM adapter, storage, clock, IDs, media intent
 * planner, audio catalog, TTS tasks, UI projection, and the Game itself).
 * Both CLI and Web entrypoints consume this and differ only in their Host.
 */
import type { Game } from "../game.js";
import type { UiProjectionStore } from "./ui/ui-projection-store.js";
import type { AudioCatalogService } from "./audio/audio-catalog-service.js";
import type { TtsTaskService } from "./audio/tts-task-service.js";

export interface RuntimeApplication {
  game: Game;
  audioCatalog: AudioCatalogService;
  ttsTasks: TtsTaskService;
  projection: UiProjectionStore;
  shutdown(): Promise<void>;
}

export interface RuntimeApplicationOptions {
  configPath?: string;
  /** Override host default from config (entrypoint decides). */
  sessionDir?: string;
}

export interface CreateRuntimeApplication {
  (options?: RuntimeApplicationOptions): Promise<RuntimeApplication>;
}
