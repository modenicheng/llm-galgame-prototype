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
import type { TaskStatusEvent } from "./audio/tts-task-service.js";
import type { AppConfig } from "../config.js";
import type { Metrics } from "../runtime/metrics.js";
import type { AssetCatalog } from "../core/assets/types.js";

export interface RuntimeApplication {
  game: Game;
  audioCatalog: AudioCatalogService;
  ttsTasks: TtsTaskService;
  projection: UiProjectionStore;
  /** The loaded config the application was composed with. */
  config: AppConfig;
  /** Shared metrics collector (also fed to the Game). */
  metrics: Metrics;
  /** Loaded asset catalog (docs §57–§60); hosts expose it via manifest + /game-assets. */
  assetCatalog: AssetCatalog;
  shutdown(): Promise<void>;
  /** Subscribe to TTS task status events (hosts bridge these to the browser). */
  taskStatusSubscribe(listener: (event: TaskStatusEvent) => void): () => void;
}

export interface RuntimeApplicationOptions {
  configPath?: string;
  /** Override host default from config (entrypoint decides). */
  sessionDir?: string;
  /** Already-loaded config; skips the disk reload when provided. */
  config?: AppConfig;
  /** voices.yaml path (default "voices.yaml" in the cwd). */
  voicesPath?: string;
  /** story-plan.yaml path (default config.narrative.story_plan_path). */
  storyPlanPath?: string;
  /** Session id for narrative-memory files and the game session. When
   * omitted, one is generated. Explicit ids make tests deterministic. */
  sessionId?: string;
}


export interface CreateRuntimeApplication {
  (options?: RuntimeApplicationOptions): Promise<RuntimeApplication>;
}
