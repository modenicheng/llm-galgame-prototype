/**
 * Tests for the narrative memory layer's core types and zod schemas
 * (Task 1: memory-types.ts, memory-operation.ts, narrative-brief.ts).
 *
 * These tests verify that every schema parses legal states, rejects
 * missing required fields, the transition maps are total and terminal
 * statuses map to [], and NarrativeBrief round-trips all fields.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  PlotThreadSchema,
  SetupPayoffSchema,
  StoryAnchorStateSchema,
  EpisodeMemorySchema,
  NarrativeMemoryStateSchema,
  VALID_THREAD_TRANSITIONS,
  VALID_SETUP_TRANSITIONS,
} from "./memory-types.js";
import {
  ThreadOpSchema,
  SetupOpSchema,
  EpisodeSummaryOpSchema,
} from "./memory-operation.js";
import { NarrativeBriefSchema } from "./narrative-brief.js";

import type {
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
  EpisodeMemory,
  NarrativeMemoryState,
  PlotThreadStatus,
  SetupStatus,
} from "./memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "./memory-operation.js";
import type { NarrativeBrief } from "./narrative-brief.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts that removing any single required key makes safeParse fail. */
function expectMissingFieldRejected<T extends object>(
  schema: z.ZodTypeAny,
  valid: T,
  requiredKeys: Array<keyof T & string>,
): void {
  for (const key of requiredKeys) {
    const { [key]: _removed, ...rest } = valid;
    const result = schema.safeParse(rest);
    expect(result.success, `expected rejection when "${key}" is missing`).toBe(
      false,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validThread: PlotThread = {
  id: "thread-1",
  kind: "main",
  summary: "The lighthouse mystery",
  status: "developing",
  importance: "major",
  introducedAt: 12,
  lastTouchedAt: 40,
  nextPressure: "Reveal the keeper's log",
  source: "runtime",
};

const minimalThread: PlotThread = {
  id: "thread-2",
  kind: "character",
  summary: "Aiko's estranged father",
  status: "open",
  importance: "minor",
  introducedAt: 3,
  lastTouchedAt: 3,
  source: "author",
};

const validSetup: SetupPayoff = {
  id: "setup-1",
  kind: "object",
  setup: "The brass key under the floorboard",
  intendedPayoff: "Opens the locked chest in the study",
  status: "seeded",
  threadId: "thread-1",
  reinforcementCount: 2,
  seededAt: 20,
  lastTouchedAt: 34,
  payoffAt: 80,
  prerequisites: ["player_seen_key", "player_owns_key"],
  payoffBeforeAnchor: "anchor-study-reveal",
  source: "author",
};

const minimalSetup: SetupPayoff = {
  id: "setup-2",
  kind: "foreshadow",
  setup: "The wind dies every time the lamp is lit",
  status: "planned",
  reinforcementCount: 0,
  prerequisites: [],
  source: "runtime",
};

const validAnchor: StoryAnchorState = {
  id: "anchor-1",
  purpose: "Reveal the keeper's identity",
  prerequisites: ["thread-1 resolved"],
  required: true,
  status: "pending",
};

const validEpisode: EpisodeMemory = {
  id: "ep-7",
  fromEventSeq: 61,
  toEventSeq: 75,
  summary: "Aiko and Kenji argue about the lighthouse log",
  characters: ["aiko", "kenji"],
  locations: ["lighthouse_study"],
  threads: ["thread-1"],
  setups: ["setup-1"],
  importance: "major",
};

const validMemoryState: NarrativeMemoryState = {
  revision: 4,
  consolidatedThroughEventSeq: 60,
  checkpointCount: 2,
  threads: { "thread-1": validThread },
  setups: { "setup-1": validSetup },
  anchors: { "anchor-1": validAnchor },
  recentEpisodeIds: ["ep-6", "ep-5"],
};

const validThreadOp: ThreadOp = {
  type: "advance",
  id: "thread-1",
  progress: "Keeper's log found",
};

const validSetupOp: SetupOp = {
  type: "reinforce",
  id: "setup-1",
  evidenceEventIds: ["ev-70"],
};

const validSummaryOp: EpisodeSummaryOp = {
  summary: "Aiko confronts her father in the study",
  characters: ["aiko"],
  locations: ["lighthouse_study"],
  threads: ["thread-1"],
  setups: [],
  importance: "normal",
};

const validBrief: NarrativeBrief = {
  revision: 4,
  consolidatedThroughEventSeq: 60,
  currentEventSeq: 75,
  checkpointCount: 2,
  location: "lighthouse_study",
  characters: ["aiko", "kenji"],
  activeThreads: [
    {
      id: "thread-1",
      kind: "mystery",
      summary: "The lighthouse mystery",
      status: "developing",
      importance: "major",
      lastTouchedAt: 40,
      nextPressure: "Reveal the keeper's log",
    },
  ],
  setupDirectives: [
    { id: "setup-1", action: "reinforce", urgency: "soon" },
  ],
  relevantEpisodes: [validEpisode],
  anchors: [validAnchor],
  revealLocks: [],
};

// ---------------------------------------------------------------------------
// memory-types.ts
// ---------------------------------------------------------------------------

describe("PlotThreadSchema", () => {
  it("parses a fully-populated thread and round-trips all fields", () => {
    expect(PlotThreadSchema.parse(validThread)).toEqual(validThread);
  });

  it("parses a thread with optional fields omitted", () => {
    expect(PlotThreadSchema.parse(minimalThread)).toEqual(minimalThread);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(PlotThreadSchema, validThread, [
      "id",
      "kind",
      "summary",
      "status",
      "importance",
      "introducedAt",
      "lastTouchedAt",
      "source",
    ]);
  });

  it("rejects empty strings and unknown enum values", () => {
    expect(PlotThreadSchema.safeParse({ ...validThread, id: "" }).success).toBe(
      false,
    );
    expect(
      PlotThreadSchema.safeParse({ ...validThread, summary: "" }).success,
    ).toBe(false);
    expect(
      PlotThreadSchema.safeParse({
        ...validThread,
        kind: "side_quest",
      }).success,
    ).toBe(false);
    expect(
      PlotThreadSchema.safeParse({ ...validThread, status: "done" }).success,
    ).toBe(false);
  });
});

describe("SetupPayoffSchema", () => {
  it("parses a fully-populated setup and round-trips all fields", () => {
    expect(SetupPayoffSchema.parse(validSetup)).toEqual(validSetup);
  });

  it("parses a minimal setup with optional fields omitted", () => {
    expect(SetupPayoffSchema.parse(minimalSetup)).toEqual(minimalSetup);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(SetupPayoffSchema, validSetup, [
      "id",
      "kind",
      "setup",
      "status",
      "reinforcementCount",
      "prerequisites",
      "source",
    ]);
  });

  it("rejects empty strings and unknown enum values", () => {
    expect(SetupPayoffSchema.safeParse({ ...validSetup, setup: "" }).success).toBe(
      false,
    );
    expect(
      SetupPayoffSchema.safeParse({
        ...validSetup,
        status: "resolved",
      }).success,
    ).toBe(false);
  });
});

describe("StoryAnchorStateSchema", () => {
  it("parses a valid anchor and round-trips all fields", () => {
    expect(StoryAnchorStateSchema.parse(validAnchor)).toEqual(validAnchor);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(StoryAnchorStateSchema, validAnchor, [
      "id",
      "purpose",
      "prerequisites",
      "required",
      "status",
    ]);
  });

  it("rejects unknown status values", () => {
    expect(
      StoryAnchorStateSchema.safeParse({ ...validAnchor, status: "done" })
        .success,
    ).toBe(false);
  });
});

describe("EpisodeMemorySchema", () => {
  it("parses a valid episode and round-trips all fields", () => {
    expect(EpisodeMemorySchema.parse(validEpisode)).toEqual(validEpisode);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(EpisodeMemorySchema, validEpisode, [
      "id",
      "fromEventSeq",
      "toEventSeq",
      "summary",
      "characters",
      "locations",
      "threads",
      "setups",
      "importance",
    ]);
  });

  it("rejects empty strings and unknown importance values", () => {
    expect(EpisodeMemorySchema.safeParse({ ...validEpisode, id: "" }).success).toBe(
      false,
    );
    expect(
      EpisodeMemorySchema.safeParse({ ...validEpisode, importance: "huge" })
        .success,
    ).toBe(false);
  });
});

describe("NarrativeMemoryStateSchema", () => {
  it("parses a valid memory state and round-trips all fields", () => {
    expect(NarrativeMemoryStateSchema.parse(validMemoryState)).toEqual(
      validMemoryState,
    );
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(NarrativeMemoryStateSchema, validMemoryState, [
      "revision",
      "consolidatedThroughEventSeq",
      "checkpointCount",
      "threads",
      "setups",
      "anchors",
      "recentEpisodeIds",
    ]);
  });
});

describe("VALID_THREAD_TRANSITIONS", () => {
  it("has exactly one entry per PlotThreadStatus", () => {
    const statuses: PlotThreadStatus[] = [
      "open",
      "developing",
      "ready_to_resolve",
      "resolved",
      "abandoned",
    ];
    expect(Object.keys(VALID_THREAD_TRANSITIONS).sort()).toEqual(
      [...statuses].sort(),
    );
  });

  it("maps the documented transitions", () => {
    expect(VALID_THREAD_TRANSITIONS.open).toEqual([
      "developing",
      "resolved",
      "abandoned",
    ]);
    expect(VALID_THREAD_TRANSITIONS.developing).toEqual([
      "ready_to_resolve",
      "resolved",
      "abandoned",
    ]);
    expect(VALID_THREAD_TRANSITIONS.ready_to_resolve).toEqual([
      "resolved",
      "abandoned",
    ]);
  });

  it("marks resolved and abandoned as terminal (empty transition lists)", () => {
    expect(VALID_THREAD_TRANSITIONS.resolved).toEqual([]);
    expect(VALID_THREAD_TRANSITIONS.abandoned).toEqual([]);
  });
});

describe("VALID_SETUP_TRANSITIONS", () => {
  it("has exactly one entry per SetupStatus", () => {
    const statuses: SetupStatus[] = [
      "planned",
      "seeded",
      "reinforced",
      "ready",
      "paid_off",
      "dropped",
    ];
    expect(Object.keys(VALID_SETUP_TRANSITIONS).sort()).toEqual(
      [...statuses].sort(),
    );
  });

  it("maps the documented transitions", () => {
    expect(VALID_SETUP_TRANSITIONS.planned).toEqual(["seeded", "dropped"]);
    expect(VALID_SETUP_TRANSITIONS.seeded).toEqual([
      "reinforced",
      "ready",
      "paid_off",
      "dropped",
    ]);
    expect(VALID_SETUP_TRANSITIONS.reinforced).toEqual([
      "ready",
      "paid_off",
      "dropped",
    ]);
    expect(VALID_SETUP_TRANSITIONS.ready).toEqual(["paid_off", "dropped"]);
  });

  it("marks paid_off and dropped as terminal (empty transition lists)", () => {
    expect(VALID_SETUP_TRANSITIONS.paid_off).toEqual([]);
    expect(VALID_SETUP_TRANSITIONS.dropped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// memory-operation.ts
// ---------------------------------------------------------------------------

describe("ThreadOpSchema", () => {
  it("parses a valid op and round-trips all fields", () => {
    expect(ThreadOpSchema.parse(validThreadOp)).toEqual(validThreadOp);
  });

  it("parses ops without the optional progress field", () => {
    const { progress: _progress, ...minimal } = validThreadOp;
    expect(ThreadOpSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects missing required fields and unknown op types", () => {
    expectMissingFieldRejected(ThreadOpSchema, validThreadOp, ["type", "id"]);
    expect(
      ThreadOpSchema.safeParse({ ...validThreadOp, type: "pause" }).success,
    ).toBe(false);
  });
});

describe("SetupOpSchema", () => {
  it("parses a valid op and round-trips all fields", () => {
    expect(SetupOpSchema.parse(validSetupOp)).toEqual(validSetupOp);
  });

  it("parses ops without the optional evidenceEventIds field", () => {
    const { evidenceEventIds: _evidence, ...minimal } = validSetupOp;
    expect(SetupOpSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects missing required fields and unknown op types", () => {
    expectMissingFieldRejected(SetupOpSchema, validSetupOp, ["type", "id"]);
    expect(
      SetupOpSchema.safeParse({ ...validSetupOp, type: "pause" }).success,
    ).toBe(false);
  });
});

describe("EpisodeSummaryOpSchema", () => {
  it("parses a valid op and round-trips all fields", () => {
    expect(EpisodeSummaryOpSchema.parse(validSummaryOp)).toEqual(validSummaryOp);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(EpisodeSummaryOpSchema, validSummaryOp, [
      "summary",
      "characters",
      "locations",
      "threads",
      "setups",
      "importance",
    ]);
  });

  it("rejects empty summaries and unknown importance values", () => {
    expect(
      EpisodeSummaryOpSchema.safeParse({ ...validSummaryOp, summary: "" })
        .success,
    ).toBe(false);
    expect(
      EpisodeSummaryOpSchema.safeParse({ ...validSummaryOp, importance: "huge" })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// narrative-brief.ts
// ---------------------------------------------------------------------------

describe("NarrativeBriefSchema", () => {
  it("round-trips all fields of a fully-populated brief", () => {
    expect(NarrativeBriefSchema.parse(validBrief)).toEqual(validBrief);
  });

  it("rejects missing required fields", () => {
    expectMissingFieldRejected(NarrativeBriefSchema, validBrief, [
      "revision",
      "consolidatedThroughEventSeq",
      "currentEventSeq",
      "checkpointCount",
      "location",
      "characters",
      "activeThreads",
      "setupDirectives",
      "relevantEpisodes",
      "anchors",
      "revealLocks",
    ]);
  });

  it("rejects an empty activeThreads member and bad directive fields", () => {
    const badBrief = {
      ...validBrief,
      activeThreads: [
        { ...validBrief.activeThreads[0]!, summary: "" },
      ],
    };
    expect(NarrativeBriefSchema.safeParse(badBrief).success).toBe(false);

    const badDirective = {
      ...validBrief,
      setupDirectives: [
        { id: "setup-1", action: "drop", urgency: "normal" },
      ],
    };
    expect(NarrativeBriefSchema.safeParse(badDirective).success).toBe(false);
  });
});
