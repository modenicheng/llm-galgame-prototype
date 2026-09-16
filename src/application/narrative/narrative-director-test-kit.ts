/**
 * Shared fakes and fixtures for the split NarrativeDirectorService
 * test files (MA-A hygiene prerequisite).
 */
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import type {
  EpisodeMemory,
  FactRecord,
  Lesson,
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
  EndingReport,
} from "../../core/narrative/memory-types.js";
import type { RejectedOp } from "../../core/narrative/memory-operation.js";
import type { DirectorPlan } from "../../core/narrative/director-plan.js";
import type { NarrativeMemoryStorePort } from "../../core/ports/narrative-memory-store-port.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { StoryPlan } from "../../adapters/static/story-plan-loader.js";

/** Minimal narration StoredEvent for tests. */
export function makeEvent(seq: number, turn = 1): StoredEvent {
  return {
    seq,
    turn,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `Event ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

export function makeConfig(
  overrides: Partial<NarrativeConfig> = {},
): NarrativeConfig {
  return { ...DEFAULT_NARRATIVE_CONFIG, ...overrides };
}

/** Recording in-memory NarrativeMemoryStorePort. */
export class FakeStore implements NarrativeMemoryStorePort {
  location = "test-memory";

  private state: NarrativeMemoryState = emptyState();
  private episodes: EpisodeMemory[] = [];
  private plan: DirectorPlan | null = null;

  // recording
  saveStateCalls: NarrativeMemoryState[] = [];
  appendEpisodesCalls: EpisodeMemory[][] = [];
  appendOpsCalls: RejectedOp[][] = [];
  savePlanCalls: DirectorPlan[] = [];

  // failure injection (audit finding 6: persistence failure atomicity)
  failNextSaveState = false;
  failNextAppendEpisodes = false;

  /**
   * Optional deferred saveState gate: when set, the next saveState awaits it
   * before persisting (consumed on first use). Lets a test block a writer
   * mid-critical-section — after it cloned/applied but before commit — so
   * concurrent writers genuinely overlap.
   */
  saveStateGate: Promise<void> | undefined;

  constructor(initialState?: NarrativeMemoryState, episodes?: EpisodeMemory[]) {
    if (initialState) this.state = initialState;
    if (episodes) this.episodes = episodes;
  }

  async load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }> {
    return { state: this.state, episodes: [...this.episodes] };
  }

  async saveState(state: NarrativeMemoryState): Promise<void> {
    if (this.failNextSaveState) {
      this.failNextSaveState = false;
      throw new Error("disk write failed (saveState)");
    }
    if (this.saveStateGate !== undefined) {
      const gate = this.saveStateGate;
      this.saveStateGate = undefined; // consume: blocks only the first writer
      await gate;
    }
    this.saveStateCalls.push(state);
    this.state = state;
  }

  async appendEpisodes(episodes: EpisodeMemory[]): Promise<void> {
    if (this.failNextAppendEpisodes) {
      this.failNextAppendEpisodes = false;
      throw new Error("disk write failed (appendEpisodes)");
    }
    this.appendEpisodesCalls.push(episodes);
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    this.appendOpsCalls.push(ops);
  }

  async loadPlan(): Promise<DirectorPlan | null> {
    return this.plan;
  }

  async savePlan(plan: DirectorPlan): Promise<void> {
    this.savePlanCalls.push(plan);
    this.plan = plan;
  }

  /** Seed a persisted plan so initialize() loads it. */
  seedPlan(plan: DirectorPlan): void {
    this.plan = plan;
  }

  // MA-A 通道（lessons/facts/ending-report）
  lessons: Lesson[] = [];
  facts: FactRecord[] = [];
  endingReports: EndingReport[] = [];

  async appendLessons(lessons: Lesson[]): Promise<void> {
    this.lessons.push(...lessons);
  }

  async loadLessons(): Promise<Lesson[]> {
    return [...this.lessons];
  }

  async appendFacts(records: FactRecord[]): Promise<void> {
    this.facts.push(...records);
  }

  async loadFacts(): Promise<FactRecord[]> {
    return [...this.facts];
  }

  async writeEndingReport(report: EndingReport): Promise<void> {
    this.endingReports.push(report);
  }
}

/** Empty state factory (returns a fresh object every time). */
export function emptyState(): NarrativeMemoryState {
  return {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    checkpointCount: 0,
    threads: {},
    setups: {},
    anchors: {},
    recentEpisodeIds: [],
    beliefs: [],
    facts: [],
  };
}

/** Recording DiagnosticSink. */
export class RecordingDiagnostics implements DiagnosticSink {
  infos: Array<{ scope: string; message: string }> = [];
  warns: Array<{ scope: string; message: string }> = [];

  info(scope: string, message: string): void {
    this.infos.push({ scope, message });
  }
  warn(scope: string, message: string): void {
    this.warns.push({ scope, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeThread(overrides: Partial<PlotThread> & { id: string }): PlotThread {
  return {
    kind: "main",
    summary: `${overrides.id} summary`,
    status: "open",
    importance: "major",
    introducedAtCheckpoint: 0,
    lastTouchedAtCheckpoint: 0,
    source: "author",
    ...overrides,
  };
}

export function makeSetup(overrides: Partial<SetupPayoff> & { id: string }): SetupPayoff {
  return {
    kind: "object",
    setup: `${overrides.id} setup`,
    intendedPayoff: `${overrides.id} payoff`,
    status: "planned",
    reinforcementCount: 0,
    prerequisites: [],
    source: "author",
    ...overrides,
  };
}

export function makeAnchor(overrides: Partial<StoryAnchorState> & { id: string }): StoryAnchorState {
  return {
    purpose: `${overrides.id} purpose`,
    prerequisites: [],
    required: false,
    status: "pending",
    ...overrides,
  };
}

export function makePlan(
  threads: PlotThread[] = [],
  setups: SetupPayoff[] = [],
  anchors: StoryAnchorState[] = [],
): StoryPlan {
  return { threads, setups, anchors };
}

// ---------------------------------------------------------------------------
// NarrativeDirectorService tests
// ---------------------------------------------------------------------------
