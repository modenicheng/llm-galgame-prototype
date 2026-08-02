/**
 * createRuntimeApplication — the Node-side composition root (§7.1).
 *
 * Builds the entire runtime: config, prompts, LLM adapter, storage,
 * clock, IDs, media intent planner, audio catalog, TTS provider and
 * task service, UI projection, and the Game itself. Hosts (CLI, web)
 * consume the returned `RuntimeApplication` and differ only in their
 * presentation layer.
 */
import { loadApiKey, loadAuthorConfig, loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { loadVoices } from "../config/voices.js";
import { Game } from "../game.js";
import { StoryGenerator } from "../adapters/llm/openai-compatible-generator.js";
import { NodeJsonlSessionStore } from "../adapters/storage/node-jsonl-session-store.js";
import { ConsoleDiagnosticSink } from "../adapters/platform/console-diagnostic-sink.js";
import { SessionIdGenerator } from "../adapters/platform/session-id-generator.js";
import { SystemClock } from "../adapters/platform/system-clock.js";
import { loadPrompts } from "../prompts.js";
import { Metrics } from "../runtime/metrics.js";
import { RuntimeStatus } from "../status.js";
import { UiProjectionStoreImpl } from "../application/ui/ui-projection-store.js";
import { AudioCatalogServiceImpl } from "../application/audio/audio-catalog-service.js";
import { AudioDescriptorFactory } from "../application/audio/audio-descriptor-factory.js";
import { AudioIntentPlanner } from "../application/audio/audio-intent-planner.js";
import {
  TtsTaskServiceImpl,
  type TaskStatusEvent,
} from "../application/audio/tts-task-service.js";
import { PerformanceCompilerImpl } from "../application/audio/performance-compiler.js";
import { MockStreamingTtsProvider } from "../adapters/tts/mock-streaming-tts-provider.js";
import { DashScopeCosyVoiceProvider } from "../adapters/tts/dashscope-cosyvoice-provider.js";
import type { TtsProviderPort } from "../core/ports/tts-provider-port.js";
import type {
  RuntimeApplication,
  RuntimeApplicationOptions,
} from "../application/runtime-application.js";

/**
 * FNV-1a 32-bit hash — a deterministic, session-independent seed per
 * lineId. Same line → same seed → same recipe → same cacheKey.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export async function createRuntimeApplication(
  options: RuntimeApplicationOptions = {},
): Promise<RuntimeApplication> {
  const config: AppConfig =
    options.config ?? (await loadConfig(options.configPath ?? "config.yaml"));
  const authorConfig = await loadAuthorConfig("prompts/author.yaml");
  const { bundle, instructions } = await loadPrompts("prompts");
  const voices = await loadVoices("voices.yaml");
  const apiKey = loadApiKey(config);

  const status = new RuntimeStatus();
  const metrics = new Metrics();
  const generator = new StoryGenerator(
    config,
    bundle,
    instructions,
    apiKey,
    authorConfig,
    metrics,
  );

  // TTS provider wiring (§7.6): dashscope → real provider, mock → the
  // streaming mock, disabled/absent → null. With null the catalog still
  // receives descriptors but every synthesis request rejects with
  // "audio_disabled".
  const synthesis = config.media.audio.synthesis;
  let provider: TtsProviderPort | null;
  if (synthesis?.provider === "dashscope") {
    provider = new DashScopeCosyVoiceProvider({
      apiKey: process.env[synthesis.api_key_env] ?? "",
      timeoutMs: config.api.timeout_ms,
    });
  } else if (synthesis?.provider === "mock") {
    provider = new MockStreamingTtsProvider({ sampleRate: synthesis.sample_rate });
  } else {
    provider = null;
  }

  // Audio app layer (§7.3–7.5). Descriptors are built for every line even
  // when synthesis is disabled so the planner/catalog contract holds.
  const catalog = new AudioCatalogServiceImpl();
  const factory = new AudioDescriptorFactory({
    characters: config.characters,
    voices,
    // The factory needs a discriminator even when synthesis is disabled;
    // "mock" yields stable mock bindings for every speaker.
    provider: synthesis?.provider === "dashscope" ? "dashscope" : "mock",
    modelProfile: synthesis?.model_profile ?? "cosyvoice_v3_flash",
    sampleRate: synthesis?.sample_rate ?? 22050,
    format: "pcm_s16le",
    env: process.env,
    compiler: new PerformanceCompilerImpl(),
    seedFor: (lineId) => fnv1a(lineId),
  });
  const planner = new AudioIntentPlanner({
    catalog,
    factory,
    candidatePrefetchLines: config.media.audio.planner?.candidate_prefetch_lines ?? 1,
    maxActiveFutureLines: config.media.audio.planner?.max_active_future_lines ?? 4,
  });
  // TaskStatusEvent fan-out: hosts subscribe via app.taskStatusSubscribe.
  const taskStatusListeners = new Set<(event: TaskStatusEvent) => void>();
  const ttsTasks = new TtsTaskServiceImpl({
    catalog,
    provider,
    maxConcurrency: synthesis?.max_concurrency ?? 2,
    onStatus: (event) => {
      for (const listener of taskStatusListeners) listener(event);
    },
  });

  const projection = new UiProjectionStoreImpl();
  const store = new NodeJsonlSessionStore(options.sessionDir ?? config.game.sessions_dir);

  const game = new Game(config, generator, status, planner, metrics, {
    store,
    clock: new SystemClock(),
    ids: new SessionIdGenerator(),
    diagnostics: new ConsoleDiagnosticSink(),
  });

  // Every runtime output feeds the projection (§7.7) so a reconnecting
  // browser can restore the page without restarting the Game.
  game.subscribe((output) => projection.applyOutput(output));

  return {
    game,
    audioCatalog: catalog,
    ttsTasks,
    projection,
    config,
    metrics,
    taskStatusSubscribe: (listener) => {
      taskStatusListeners.add(listener);
      return () => taskStatusListeners.delete(listener);
    },
    shutdown: async () => {
      // Stop the run loop: the command wakes waitForCommand, which throws
      // RuntimeShutdownError out of game.run(). Yield one macrotask so the
      // unwinding completes before we resolve.
      game.dispatch({ type: "shutdown" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}
