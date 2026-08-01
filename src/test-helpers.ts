import type { AppConfig } from "./config.js";
import type { GamePorts } from "./game.js";
import type { ClockPort } from "./core/ports/clock-port.js";
import { silentDiagnosticSink } from "./core/ports/diagnostic-sink.js";
import type { IdGeneratorPort } from "./core/ports/id-generator-port.js";
import type {
  RuntimeSnapshot,
  SessionMetadata,
  SessionStorePort,
} from "./core/ports/session-store-port.js";
import type { StoredEvent } from "./schema.js";
import type { StoryState } from "./story/types.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Shared test fixture for a fully-populated AppConfig.
 *
 * Every test file that needs a Game / StoryGenerator / GameUI should
 * use this instead of inlining its own copy. Override individual sections
 * via `overrides` (deep partial, e.g. `{ game: { sessions_dir } }`).
 */
export function makeTestConfig(overrides?: DeepPartial<AppConfig>): AppConfig {
  return {
    api: {
      model: "test-model",
      base_url: "https://api.test.example.com",
      api_key_env: "TEST_KEY",
      timeout_ms: 5000,
      token_limit_field: "max_completion_tokens",
    },
    generation: {
      temperature: 1.0,
      max_tokens: 500,
      repair_attempts: 0,
    },
    prefetch: {
      branch_dialogue_lines: 2,
      branch_concurrency: 2,
    },
    media: {
      audio: {
        enabled: false,
        provider: "disabled",
        active_target_lines: 3,
        refill_threshold_lines: 2,
        branch_prefetch_lines: 2,
        batch_size: 2,
        max_concurrency: 2,
        mock_latency_ms: 800,
        output_dir: "assets/audio",
      },
    },
    game: {
      history_events: 80,
      sessions_dir: "sessions",
      show_line_ids: true,
    },
    ...overrides,
  } as AppConfig;
}

// ---------------------------------------------------------------------------
// In-memory ports for core tests
// ---------------------------------------------------------------------------

/** Session store that keeps everything in memory; no filesystem access. */
export class MemorySessionStore implements SessionStorePort {
  readonly location = "memory";
  readonly events: StoredEvent[] = [];
  readonly snapshots: StoryState[] = [];

  async initialize(_metadata: SessionMetadata): Promise<void> {}

  async append(event: StoredEvent): Promise<void> {
    this.events.push(event);
  }

  async saveSnapshot(snapshot: RuntimeSnapshot): Promise<void> {
    this.snapshots.push(snapshot.state);
  }
}

/** Deterministic clock: fixed start time, +1ms per read. */
export class FakeClock implements ClockPort {
  private now = 1700000000000;

  nowMs(): number {
    this.now += 1;
    return this.now - 1;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

/** Deterministic ID generator with per-instance counters. */
export class FakeIdGenerator implements IdGeneratorPort {
  private sessionCounter = 0;
  private lineCounter = 0;
  private generationCounter = 0;
  private previewCounter = 0;

  nextSessionId(): string {
    this.sessionCounter += 1;
    return `session_${this.sessionCounter}`;
  }

  nextLineId(sessionId: string): string {
    this.lineCounter += 1;
    return `line_${sessionId}_${this.lineCounter.toString().padStart(6, "0")}`;
  }

  nextGenerationId(kind: string): string {
    this.generationCounter += 1;
    return `${kind}:${this.generationCounter}`;
  }

  nextPreviewId(interactionId: string): string {
    this.previewCounter += 1;
    return `preview_${interactionId}_${this.previewCounter}`;
  }
}

/**
 * Default port set for tests: memory store, fake clock, fake IDs, and a
 * silent diagnostic sink. Override individual ports when a test needs a
 * real adapter (e.g. `{ store: new NodeJsonlSessionStore(dir) }`).
 */
export function makeTestPorts(
  overrides?: Partial<Pick<GamePorts, "store" | "clock" | "ids">>,
): GamePorts {
  return {
    store: new MemorySessionStore(),
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    diagnostics: silentDiagnosticSink,
    ...overrides,
  };
}
