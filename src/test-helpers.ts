import type { AppConfig } from "./config.js";
import { DEFAULT_NARRATIVE_CONFIG } from "./config.js";
import type { Game, GamePorts } from "./game.js";
import type { ClockPort } from "./core/ports/clock-port.js";
import { silentDiagnosticSink } from "./core/ports/diagnostic-sink.js";
import type { IdGeneratorPort } from "./core/ports/id-generator-port.js";
import type {
  EdgeChoice,
  RunGraphPort,
  RunResume,
} from "./core/ports/run-graph-port.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import type { RuntimeOutput } from "./core/runtime/runtime-output.js";
import type { StoredEvent } from "./schema.js";
import type { RuntimePlayableEvent } from "./schema.js";
import type { StoryState } from "./story/types.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Shared test fixture for a fully-populated AppConfig.
 *
 * Every test file that needs a Game / StoryGenerator / ports should
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
      protocol: "jsonl",
      temperature: 1.0,
      max_tokens: 500,
      repair_attempts: 0,
    },
    text_buffer: {
      start_threshold_lines: 2,
      target_lines: 6,
      refill_threshold_lines: 3,
    },
    assets: {
      catalog: "assets/resources.yaml",
    },
    prefetch: {
      branch_dialogue_lines: 2,
      branch_concurrency: 2,
      input_bridge: {
        enabled: true,
        min_events: 1,
        max_events: 2,
        only_narration: true,
      },
    },
    input: {
      kind: "dialogue",
      require_preview_confirmation: true,
      show_generation_status: false,
    },
    debug: {
      runtime_status: false,
    },
    media: {
      audio: {},
    },
    game: {
      sessions_dir: "sessions",
      show_line_ids: true,
    },
    interaction: {
      allowed_modes: ["choice", "hybrid", "input"],
      default_mode: "hybrid",
      options: { min_count: 2, max_count: 5 },
      input: { max_length: 500, max_consecutive_pure_input: 1 },
      legacy_choice: { allow_runtime_compatibility: true, allow_model_output: false },
    },
    narrative: DEFAULT_NARRATIVE_CONFIG,
    ...overrides,
  } as AppConfig;
}

// ---------------------------------------------------------------------------
// In-memory ports for core tests
// ---------------------------------------------------------------------------

/**
 * 剧情图运行时的调用记录型 test double：只记录 Game 发出的图操作序列，
 * 不复现 RunGraphCoordinator 的状态机（后者配真实 GameGraphStore 另测）。
 */
export class MemoryRunGraph implements RunGraphPort {
  currentOutlineRevision(): number {
    return 0;
  }
  readonly location = "memory-graph";
  rootRunsStarted = 0;
  readonly begunEdges: EdgeChoice[] = [];
  readonly appendedBatches: StoredEvent[][] = [];
  readonly decisions: Array<{
    modelSceneId: string;
    form: unknown;
    moment: unknown;
  }> = [];
  readonly endings: Array<{ endingId: string; moment: unknown }> = [];
  /** 可编程的恢复结果；fresh（默认）会顺带登记一次 root run。 */
  resume: RunResume = { kind: "fresh", nextSeq: 1 };
  private idCounter = 0;

  async restoreOrCreateRun(_options?: { restart?: boolean }): Promise<RunResume> {
    if (this.resume.kind === "fresh") await this.startRootRun();
    return this.resume;
  }

  async startRootRun(): Promise<string> {
    this.rootRunsStarted += 1;
    this.idCounter += 1;
    return `run_test${this.idCounter}`;
  }

  async beginEdge(choice: EdgeChoice): Promise<void> {
    this.begunEdges.push(structuredClone(choice));
  }

  async appendEdgeEvents(events: readonly StoredEvent[]): Promise<void> {
    this.appendedBatches.push([...events]);
  }

  async openDecision(input: {
    modelSceneId: string;
    form: unknown;
    moment: unknown;
  }): Promise<string> {
    this.decisions.push(structuredClone(input));
    this.idCounter += 1;
    return `dc_test${this.idCounter}`;
  }

  async reachEnding(input: { endingId: string; moment: unknown }): Promise<string> {
    this.endings.push(structuredClone(input));
    this.idCounter += 1;
    return `end_test${this.idCounter}`;
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
 * Default port set for tests: in-memory graph runtime, fake clock, fake
 * IDs, and a silent diagnostic sink. Override individual ports when a test
 * needs a real adapter (e.g. `{ graph: new RunGraphCoordinator(...) }`).
 */
export function makeTestPorts(
  overrides?: Partial<Omit<GamePorts, "graph" | "clock" | "ids" | "diagnostics">> &
    Partial<Pick<GamePorts, "graph" | "clock" | "ids" | "diagnostics">>,
): GamePorts {
  return {
    graph: new MemoryRunGraph(),
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    diagnostics: silentDiagnosticSink,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory runtime controller
// ---------------------------------------------------------------------------

export type InteractionOpenedOutput = Extract<
  RuntimeOutput,
  { type: "interaction_opened" }
>;
export type InputPreviewOpenedOutput = Extract<
  RuntimeOutput,
  { type: "input_preview_opened" }
>;

/**
 * Default behaviors when no handler is given:
 * - playback_ready → dispatch `advance`
 * - input_preview_opened → dispatch `confirm_input`
 * - interaction_opened → nothing (the test drives selection/input)
 */
export interface MemoryControllerHandlers {
  onPlaybackReady?: (
    event: RuntimePlayableEvent,
    controller: MemoryController,
  ) => void | Promise<void>;
  onInteractionOpened?: (
    output: InteractionOpenedOutput,
    controller: MemoryController,
  ) => void | Promise<void>;
  onInputPreviewOpened?: (
    output: InputPreviewOpenedOutput,
    controller: MemoryController,
  ) => void | Promise<void>;
}

/**
 * In-memory driver for the runtime: records RuntimeOutputs and can
 * auto-respond with commands, letting tests drive full sessions without
 * any terminal UI.
 */
export class MemoryController {
  readonly outputs: RuntimeOutput[] = [];
  private game: Game | null = null;

  constructor(private readonly handlers: MemoryControllerHandlers = {}) {}

  attach(game: Game): void {
    this.game = game;
    game.subscribe((output) => {
      this.outputs.push(output);
      void this.handle(output);
    });
  }

  // ------------------------------------------------------------------
  // Assertion helpers
  // ------------------------------------------------------------------

  count(type: RuntimeOutput["type"]): number {
    return this.outputs.filter((output) => output.type === type).length;
  }

  countPlayback(type: "narration" | "dialogue"): number {
    return this.outputs.filter(
      (output) => output.type === "playback_ready" && output.event.type === type,
    ).length;
  }

  playbackEvents(): Array<RuntimeOutput & { type: "playback_ready" }> {
    return this.outputs.filter(
      (output): output is RuntimeOutput & { type: "playback_ready" } =>
        output.type === "playback_ready",
    );
  }

  ended(): boolean {
    return this.outputs.some((output) => output.type === "session_ended");
  }

  // ------------------------------------------------------------------
  // Command helpers
  // ------------------------------------------------------------------

  dispatch(command: RuntimeCommand): void {
    this.game?.dispatch(command);
  }

  advance(): void {
    this.dispatch({ type: "advance" });
  }

  select(interactionId: string, optionId: string): void {
    this.dispatch({ type: "select_choice", interactionId, optionId });
  }

  submitInput(interactionId: string, text: string): void {
    this.dispatch({ type: "preview_input", interactionId, text });
  }

  confirm(previewId: string): void {
    this.dispatch({ type: "confirm_input", previewId });
  }

  cancel(previewId: string): void {
    this.dispatch({ type: "cancel_input", previewId });
  }

  // ------------------------------------------------------------------
  // Async wait helpers
  // ------------------------------------------------------------------

  /** Wait until `predicate` holds over the recorded outputs. */
  private async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 5);
      await promise;
    }
  }

  /**
   * Wait until the Nth playback_ready event has been emitted.
   * With the default onPlaybackReady handler each playback is auto-advanced;
   * with a custom handler that suppresses advancing, this waits for
   * playback only.
   */
  async advanceUntilPlayed(count: number): Promise<void> {
    await this.waitFor(() => this.count("playback_ready") >= count);
  }

  /** Wait until an interaction opens or the session ends. */
  async advanceUntilInteractionOrEnd(): Promise<void> {
    await this.waitFor(() => this.ended() || this.count("interaction_opened") > 0);
  }

  private async handle(output: RuntimeOutput): Promise<void> {
    switch (output.type) {
      case "playback_ready":
        if (this.handlers.onPlaybackReady) {
          await this.handlers.onPlaybackReady(output.event, this);
        } else {
          this.dispatch({ type: "advance" });
        }
        break;
      case "interaction_opened":
        if (this.handlers.onInteractionOpened) {
          await this.handlers.onInteractionOpened(output, this);
        }
        break;
      case "input_preview_opened":
        if (this.handlers.onInputPreviewOpened) {
          await this.handlers.onInputPreviewOpened(output, this);
        } else {
          this.dispatch({ type: "confirm_input", previewId: output.previewId });
        }
        break;
      default:
        break;
    }
  }
}
