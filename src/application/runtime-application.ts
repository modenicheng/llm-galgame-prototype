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
import type { CharacterRegistryProvider } from "../core/characters/registry.js";

export interface RuntimeApplication {
  game: Game;
  /**
   * 世界 id（games/<gameId>/ 目录名，§9）。显式传入或启动时生成；
   * local-web 用它维护 games/.last-game（M5.0）。
   */
  gameId: string;
  audioCatalog: AudioCatalogService;
  ttsTasks: TtsTaskService;
  projection: UiProjectionStore;
  /** The loaded config the application was composed with. */
  config: AppConfig;
  /** Shared metrics collector (also fed to the Game). */
  metrics: Metrics;
  /** Loaded asset catalog (docs §57–§60); hosts expose it via manifest + /game-assets. */
  assetCatalog: AssetCatalog;
  /**
   * M1 角色注册表端口。生成世界 = 当前游戏 canon 构建的 roster；无世界/
   * 空 canon 启动 = main 静态 fallback 世界 roster（characters.yaml）；旧
   * 世界（pre-M1 canon）= 显式 legacy 兼容模式（身份走资产目录注册表）。
   */
  characterRegistry: CharacterRegistryProvider;
  shutdown(): Promise<void>;
  /**
   * 结束当前会话并重建整个运行时（新 session id、新开场）。
   * 返回同一 RuntimeApplication（game 已原地替换）；调用方只需重新
   * 调用其 game.run() 即可开始新会话。
   */
  restart(): Promise<RuntimeApplication>;
  /** Subscribe to TTS task status events (hosts bridge these to the browser). */
  taskStatusSubscribe(listener: (event: TaskStatusEvent) => void): () => void;
}

export interface RuntimeApplicationOptions {
  configPath?: string;
  /** Override host default from config (entrypoint decides). */
  sessionDir?: string;
  /** v2 剧情图根目录（games/<gameId>/ 的父目录，§9）。默认 "games"。 */
  gamesRoot?: string;
  /**
   * v2 世界 id（games/<gameId> 目录名）。世界身份跨启动固定——「继续
   * 游戏」传同一 id 即指向同一张剧情图；缺省每次启动生成新世界。
   */
  gameId?: string;
  /** Already-loaded config; skips the disk reload when provided. */
  config?: AppConfig;
  /** voices.yaml path (default "voices.yaml" in the cwd). */
  voicesPath?: string;
  /**
   * M1：静态 fallback 世界角色名册内容包路径（默认 "characters.yaml"，即
   * main 根目录内容包）。生成世界不受此参数影响（roster 来自当前游戏
   * canon）。
   */
  charactersPath?: string;
  /** story-plan.yaml path (default config.narrative.story_plan_path). */
  storyPlanPath?: string;
  /** Session id for narrative-memory files and the game session. When
   * omitted, one is generated. Explicit ids make tests deterministic. */
  sessionId?: string;
}
