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
import type { AppConfig } from "../config.js";
import type { Metrics } from "../runtime/metrics.js";

export interface RuntimeApplication {
  game: Game;
  audioCatalog: AudioCatalogService;
  ttsTasks: TtsTaskService;
  projection: UiProjectionStore;
  /** The loaded config the application was composed with. */
  config: AppConfig;
  /** Shared metrics collector (also fed to the Game). */
  metrics: Metrics;
  shutdown(): Promise<void>;
}

export interface RuntimeApplicationOptions {
  configPath?: string;
  /** Override host default from config (entrypoint decides). */
  sessionDir?: string;
  /** Already-loaded config; skips the disk reload when provided. */
  config?: AppConfig;
}


export interface CreateRuntimeApplication {
  (options?: RuntimeApplicationOptions): Promise<RuntimeApplication>;
}
