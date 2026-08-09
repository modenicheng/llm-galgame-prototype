/**
 * Tests for the narrative-memory operation validators and classifySetup
 * (Task 5: memory-validator.ts).
 *
 * Covers every rejection rule of validateThreadOp / validateSetupOp /
 * validateEpisodeOp, plus the three-branch classifySetup decision table.
 */

import { describe, it, expect } from "vitest";

import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";
import {
  validateThreadOp,
  validateSetupOp,
  validateEpisodeOp,
  classifySetup,
} from "./memory-validator.js";

import type { NarrativeConfig } from "../../config.js";
import type {
  PlotThread,
  SetupPayoff,
  NarrativeMemoryState,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "../../core/narrative/memory-operation.js";
import type { SetupDirective } from "../../core/narrative/narrative-brief.js";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<PlotThread> = {}): PlotThread {
  return {
    id: "thread-1",
    kind: "main",
    summary: "The lighthouse mystery",
    status: "developing",
    importance: "major",
    introducedAtCheckpoint: 12,
    lastTouchedAtCheckpoint: 40,
    source: "runtime",
    ...overrides,
  };
}

function makeSetup(overrides: Partial<SetupPayoff> = {}): SetupPayoff {
  return {
    id: "setup-1",
    kind: "object",
    setup: "The brass key under the floorboard",
    status: "seeded",
    reinforcementCount: 0,
    prerequisites: [],
    source: "author",
    ...overrides,
  };
}

function makeMemory(
  overrides: Partial<NarrativeMemoryState> = {},
): NarrativeMemoryState {
  return {
    revision: 1,
    consolidatedThroughEventSeq: 0,
    checkpointCount: 0,
    threads: {},
    setups: {},
    anchors: {},
    recentEpisodeIds: [],
    ...overrides,
  };
}

function makeConfig(overrides?: {
  maxMajorActive?: number;
  maxMinorActive?: number;
  maxActive?: number;
}): NarrativeConfig {
  const base = DEFAULT_NARRATIVE_CONFIG;
  return {
    ...base,
    threads: {
      ...base.threads,
      max_major_active: overrides?.maxMajorActive ?? base.threads.max_major_active,
      max_minor_active: overrides?.maxMinorActive ?? base.threads.max_minor_active,
    },
    setups: {
      ...base.setups,
      max_active: overrides?.maxActive ?? base.setups.max_active,
    },
  };
}

function expectRejected(reason: string | null): void {
  expect(reason).not.toBeNull();
}

function expectAccepted(reason: string | null): void {
  expect(reason).toBeNull();
}

// ---------------------------------------------------------------------------
// validateThreadOp
// ---------------------------------------------------------------------------

describe("validateThreadOp", () => {
  it("accepts create when the id is new and the major budget is free", () => {
    const memory = makeMemory({
      threads: { "t-1": makeThread({ id: "t-1", importance: "major" }) },
    });
    const op: ThreadOp = { type: "create", id: "t-new" };
    expectAccepted(validateThreadOp(op, memory, makeConfig()));
  });

  it("rejects create when the id already exists", () => {
    const memory = makeMemory({ threads: { "thread-1": makeThread() } });
    const op: ThreadOp = { type: "create", id: "thread-1" };
    const reason = validateThreadOp(op, memory, makeConfig());
    expectRejected(reason);
    expect(reason).toContain("thread-1");
  });

  it("rejects create when active major threads reach max_major_active", () => {
    const memory = makeMemory({
      threads: {
        "t-1": makeThread({ id: "t-1", status: "open", importance: "major" }),
        "t-2": makeThread({ id: "t-2", status: "developing", importance: "major" }),
      },
    });
    const op: ThreadOp = { type: "create", id: "t-new" };
    expectRejected(validateThreadOp(op, memory, makeConfig({ maxMajorActive: 2 })));
  });

  it("rejects create when active minor threads reach max_minor_active", () => {
    const memory = makeMemory({
      threads: {
        "t-1": makeThread({ id: "t-1", status: "open", importance: "minor" }),
        "t-2": makeThread({ id: "t-2", status: "developing", importance: "minor" }),
        "t-3": makeThread({
          id: "t-3",
          status: "ready_to_resolve",
          importance: "minor",
        }),
      },
    });
    const op: ThreadOp = { type: "create", id: "t-new" };
    const reason = validateThreadOp(op, memory, makeConfig({ maxMinorActive: 3 }));
    expectRejected(reason);
    expect(reason).toContain("minor");
  });

  it("counts only active minor threads (and never major ones) for the minor budget", () => {
    const memory = makeMemory({
      threads: {
        "t-major": makeThread({ id: "t-major", importance: "major", status: "open" }),
        "t-minor-1": makeThread({
          id: "t-minor-1",
          importance: "minor",
          status: "open",
        }),
        "t-resolved": makeThread({
          id: "t-resolved",
          importance: "minor",
          status: "resolved",
        }),
        "t-abandoned": makeThread({
          id: "t-abandoned",
          importance: "minor",
          status: "abandoned",
        }),
      },
    });
    const op: ThreadOp = { type: "create", id: "t-new" };
    // Only t-minor-1 counts as an active minor; budget 2 is free.
    expectAccepted(
      validateThreadOp(op, memory, makeConfig({ maxMinorActive: 2 })),
    );
    // With budget 1 the single active minor blocks creation.
    expectRejected(
      validateThreadOp(op, memory, makeConfig({ maxMinorActive: 1 })),
    );
  });

  it("counts only active (open/developing/ready_to_resolve) major threads", () => {
    const memory = makeMemory({
      threads: {
        "t-minor-1": makeThread({ id: "t-minor-1", importance: "minor", status: "open" }),
        "t-minor-2": makeThread({ id: "t-minor-2", importance: "minor", status: "developing" }),
        "t-resolved": makeThread({ id: "t-resolved", importance: "major", status: "resolved" }),
        "t-1": makeThread({ id: "t-1", importance: "major", status: "open" }),
      },
    });
    const op: ThreadOp = { type: "create", id: "t-new" };
    // Only t-1 counts as an active major; budget 2 is free.
    expectAccepted(validateThreadOp(op, memory, makeConfig({ maxMajorActive: 2 })));
    // With budget 1 the single active major blocks creation.
    expectRejected(validateThreadOp(op, memory, makeConfig({ maxMajorActive: 1 })));
  });

  it("rejects touch/advance/resolve/abandon on an unknown id", () => {
    const memory = makeMemory();
    const ops: ThreadOp[] = [
      { type: "touch", id: "ghost" },
      { type: "advance", id: "ghost" },
      { type: "resolve", id: "ghost" },
      { type: "abandon", id: "ghost" },
    ];
    for (const op of ops) {
      expectRejected(validateThreadOp(op, memory, makeConfig()));
    }
  });

  it("accepts touch on an existing thread", () => {
    const memory = makeMemory({ threads: { "thread-1": makeThread() } });
    expectAccepted(
      validateThreadOp({ type: "touch", id: "thread-1" }, memory, makeConfig()),
    );
  });

  it("accepts advance on a non-terminal thread", () => {
    const memory = makeMemory({
      threads: { "thread-1": makeThread({ status: "open" }) },
    });
    expectAccepted(
      validateThreadOp({ type: "advance", id: "thread-1" }, memory, makeConfig()),
    );
  });

  it("rejects advance on a terminal thread (resolved/abandoned)", () => {
    for (const status of ["resolved", "abandoned"] as const) {
      const memory = makeMemory({
        threads: { "thread-1": makeThread({ status }) },
      });
      const reason = validateThreadOp(
        { type: "advance", id: "thread-1" },
        memory,
        makeConfig(),
      );
      expectRejected(reason);
      expect(reason).toContain(status);
    }
  });

  it("accepts resolve/abandon on non-terminal threads", () => {
    const memory = makeMemory({
      threads: {
        "thread-1": makeThread({ status: "developing" }),
        "t-2": makeThread({ id: "t-2", status: "ready_to_resolve" }),
      },
    });
    expectAccepted(
      validateThreadOp({ type: "resolve", id: "thread-1" }, memory, makeConfig()),
    );
    expectAccepted(
      validateThreadOp({ type: "abandon", id: "t-2" }, memory, makeConfig()),
    );
  });

  it("rejects resolve/abandon when the current status is terminal", () => {
    const memory = makeMemory({
      threads: {
        "t-resolved": makeThread({ id: "t-resolved", status: "resolved" }),
        "t-abandoned": makeThread({ id: "t-abandoned", status: "abandoned" }),
      },
    });
    expectRejected(
      validateThreadOp({ type: "resolve", id: "t-resolved" }, memory, makeConfig()),
    );
    expectRejected(
      validateThreadOp({ type: "resolve", id: "t-abandoned" }, memory, makeConfig()),
    );
    expectRejected(
      validateThreadOp({ type: "abandon", id: "t-resolved" }, memory, makeConfig()),
    );
    expectRejected(
      validateThreadOp({ type: "abandon", id: "t-abandoned" }, memory, makeConfig()),
    );
  });
});

// ---------------------------------------------------------------------------
// validateSetupOp
// ---------------------------------------------------------------------------

describe("validateSetupOp", () => {
  it("rejects any op type on an unknown id", () => {
    const memory = makeMemory();
    const ops: SetupOp[] = [
      { type: "seed", id: "ghost" },
      { type: "reinforce", id: "ghost" },
      { type: "payoff", id: "ghost" },
      { type: "hold", id: "ghost" },
      { type: "drop", id: "ghost" },
    ];
    for (const op of ops) {
      expectRejected(validateSetupOp(op, memory, makeConfig()));
    }
  });

  it("rejects seed when the setup status is not planned", () => {
    const memory = makeMemory({
      setups: { "setup-1": makeSetup({ status: "seeded" }) },
    });
    const reason = validateSetupOp(
      { type: "seed", id: "setup-1" },
      memory,
      makeConfig(),
    );
    expectRejected(reason);
    expect(reason).toContain("setup-1");
  });

  it("accepts seed on a planned setup when the active budget is free", () => {
    const memory = makeMemory({
      setups: {
        "setup-1": makeSetup({ status: "planned" }),
        "s-active": makeSetup({ id: "s-active", status: "seeded" }),
      },
    });
    expectAccepted(
      validateSetupOp({ type: "seed", id: "setup-1" }, memory, makeConfig({ maxActive: 2 })),
    );
  });

  it("rejects seed when active setups reach max_active", () => {
    const memory = makeMemory({
      setups: {
        "setup-1": makeSetup({ status: "planned" }),
        "s-a": makeSetup({ id: "s-a", status: "seeded" }),
        "s-b": makeSetup({ id: "s-b", status: "reinforced" }),
      },
    });
    expectRejected(
      validateSetupOp({ type: "seed", id: "setup-1" }, memory, makeConfig({ maxActive: 2 })),
    );
  });

  it("accepts evidence event ids inside the committed range, rejects outside (spec §5)", () => {
    const memory = makeMemory({ setups: { "setup-1": makeSetup({ status: "planned" }) } });
    // Batch covers up to seq 10 → evidence 10 is inside, 11 is not.
    expectAccepted(
      validateSetupOp(
        { type: "seed", id: "setup-1", evidenceEventIds: ["10"] },
        memory,
        makeConfig(),
        10,
      ),
    );
    const reason = validateSetupOp(
      { type: "seed", id: "setup-1", evidenceEventIds: ["11"] },
      memory,
      makeConfig(),
      10,
    );
    expectRejected(reason);
    expect(reason).toContain("不在已提交范围");
  });

  it("rejects non-numeric or zero evidence event ids", () => {
    const memory = makeMemory({ setups: { "setup-1": makeSetup({ status: "planned" }) } });
    for (const id of ["abc", "0", "-3", "10.5"]) {
      expectRejected(
        validateSetupOp(
          { type: "seed", id: "setup-1", evidenceEventIds: [id] },
          memory,
          makeConfig(),
          10,
        ),
      );
    }
  });

  it("counts only active setups (seeded/reinforced/ready) for the seed budget", () => {
    const memory = makeMemory({
      setups: {
        "setup-1": makeSetup({ status: "planned" }),
        "s-active": makeSetup({ id: "s-active", status: "seeded" }),
        "s-planned": makeSetup({ id: "s-planned", status: "planned" }),
        "s-paid": makeSetup({ id: "s-paid", status: "paid_off" }),
        "s-dropped": makeSetup({ id: "s-dropped", status: "dropped" }),
      },
    });
    // Only s-active counts: budget 2 is free even though 5 setups exist.
    expectAccepted(
      validateSetupOp({ type: "seed", id: "setup-1" }, memory, makeConfig({ maxActive: 2 })),
    );
  });

  it("reinforce accepts only seeded|reinforced", () => {
    for (const status of ["seeded", "reinforced"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectAccepted(
        validateSetupOp({ type: "reinforce", id: "setup-1" }, memory, makeConfig()),
      );
    }
    for (const status of ["planned", "ready", "paid_off", "dropped"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      const reason = validateSetupOp(
        { type: "reinforce", id: "setup-1" },
        memory,
        makeConfig(),
      );
      expectRejected(reason);
      expect(reason).toContain(status);
    }
  });

  it("payoff accepts only reinforced|ready", () => {
    for (const status of ["reinforced", "ready"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectAccepted(
        validateSetupOp({ type: "payoff", id: "setup-1" }, memory, makeConfig()),
      );
    }
    for (const status of ["planned", "seeded", "paid_off", "dropped"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectRejected(
        validateSetupOp({ type: "payoff", id: "setup-1" }, memory, makeConfig()),
      );
    }
  });

  it("drop accepts any non-terminal status", () => {
    for (const status of ["planned", "seeded", "reinforced", "ready"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectAccepted(
        validateSetupOp({ type: "drop", id: "setup-1" }, memory, makeConfig()),
      );
    }
    for (const status of ["paid_off", "dropped"] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectRejected(
        validateSetupOp({ type: "drop", id: "setup-1" }, memory, makeConfig()),
      );
    }
  });

  it("hold passes for every status as long as the id exists", () => {
    for (const status of [
      "planned",
      "seeded",
      "reinforced",
      "ready",
      "paid_off",
      "dropped",
    ] as const) {
      const memory = makeMemory({ setups: { "setup-1": makeSetup({ status }) } });
      expectAccepted(
        validateSetupOp({ type: "hold", id: "setup-1" }, memory, makeConfig()),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// validateEpisodeOp
// ---------------------------------------------------------------------------

describe("validateEpisodeOp", () => {
  function validOp(): EpisodeSummaryOp {
    return {
      summary: "Aiko confronts her father in the study",
      characters: ["aiko"],
      locations: ["lighthouse_study"],
      threads: ["thread-1"],
      setups: [],
      importance: "normal",
    };
  }

  it("accepts a well-formed episode summary op", () => {
    expectAccepted(validateEpisodeOp(validOp()));
  });

  it("rejects an empty summary", () => {
    const reason = validateEpisodeOp({ ...validOp(), summary: "" });
    expectRejected(reason);
    expect(reason).toContain("summary");
  });

  it("accepts a summary of exactly 200 characters and rejects 201", () => {
    expectAccepted(validateEpisodeOp({ ...validOp(), summary: "x".repeat(200) }));
    const reason = validateEpisodeOp({ ...validOp(), summary: "x".repeat(201) });
    expectRejected(reason);
  });

  it("rejects empty-string elements in every array field", () => {
    for (const field of [
      "characters",
      "locations",
      "threads",
      "setups",
    ] as const) {
      const reason = validateEpisodeOp({ ...validOp(), [field]: ["", "aiko"] });
      expectRejected(reason);
      expect(reason).toContain(field);
    }
  });

  it("rejects more than 20 unique elements per array field", () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `item-${i}`);
    for (const field of [
      "characters",
      "locations",
      "threads",
      "setups",
    ] as const) {
      const reason = validateEpisodeOp({ ...validOp(), [field]: twentyOne });
      expectRejected(reason);
      expect(reason).toContain(field);
    }
  });

  it("accepts exactly 20 unique elements per array field", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    for (const field of [
      "characters",
      "locations",
      "threads",
      "setups",
    ] as const) {
      expectAccepted(validateEpisodeOp({ ...validOp(), [field]: twenty }));
    }
  });

  it("counts duplicates only once (25 entries / 20 unique pass)", () => {
    const withDuplicates = [
      ...Array.from({ length: 20 }, (_, i) => `item-${i}`),
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
    ];
    expect(withDuplicates).toHaveLength(25);
    expectAccepted(
      validateEpisodeOp({ ...validOp(), characters: withDuplicates }),
    );
  });
});

// ---------------------------------------------------------------------------
// classifySetup
// ---------------------------------------------------------------------------

describe("classifySetup", () => {
  it("returns undefined for paid_off even when the anchor matches", () => {
    const item = makeSetup({
      status: "paid_off",
      payoffBeforeAnchor: "anchor-x",
      lastTouchedAtCheckpoint: 0,
    });
    expect(classifySetup(item, 10, "anchor-x")).toBeUndefined();
  });

  it("returns undefined for dropped", () => {
    const item = makeSetup({ status: "dropped", lastTouchedAtCheckpoint: 0 });
    expect(classifySetup(item, 10, undefined)).toBeUndefined();
  });

  it("returns payoff/now when payoffBeforeAnchor matches the current anchor", () => {
    const item = makeSetup({
      status: "seeded",
      payoffBeforeAnchor: "anchor-x",
      lastTouchedAtCheckpoint: 0,
    });
    expect(classifySetup(item, 10, "anchor-x")).toEqual({
      id: "setup-1",
      action: "payoff",
      urgency: "now",
    });
  });

  it("returns payoff/now for reinforced/ready setups whose anchor matches", () => {
    for (const status of ["reinforced", "ready"] as const) {
      const item = makeSetup({
        status,
        payoffBeforeAnchor: "anchor-x",
        lastTouchedAtCheckpoint: 0,
      });
      expect(classifySetup(item, 10, "anchor-x")).toEqual({
        id: "setup-1",
        action: "payoff",
        urgency: "now",
      });
    }
  });

  it("anchor payoff takes precedence over staleness", () => {
    const item = makeSetup({
      status: "seeded",
      payoffBeforeAnchor: "anchor-x",
      lastTouchedAtCheckpoint: 0,
      seededAtCheckpoint: 0,
    });
    // checkpoint - lastTouchedAtCheckpoint = 10 >= 2, but the anchor match wins.
    expect(classifySetup(item, 10, "anchor-x")).toEqual({
      id: "setup-1",
      action: "payoff",
      urgency: "now",
    });
  });

  it("does not payoff when payoffBeforeAnchor does not match the current anchor", () => {
    const item = makeSetup({
      status: "seeded",
      payoffBeforeAnchor: "anchor-x",
      lastTouchedAtCheckpoint: 9,
    });
    expect(classifySetup(item, 10, "anchor-y")).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("never issues payoff/now for a planned setup even when the anchor matches (validator would reject it)", () => {
    const item = makeSetup({
      status: "planned",
      payoffBeforeAnchor: "anchor-x",
    });
    expect(classifySetup(item, 10, "anchor-x")).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("ignores payoffBeforeAnchor when the current anchor is undefined (no anchor reached yet in step 1+2)", () => {
    const item = makeSetup({
      status: "seeded",
      payoffBeforeAnchor: "anchor-x",
      lastTouchedAtCheckpoint: 9,
    });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("returns reinforce/soon for a stale seeded setup (gap >= 2)", () => {
    const item = makeSetup({ status: "seeded", lastTouchedAtCheckpoint: 8 });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "reinforce",
      urgency: "soon",
    });
  });

  it("uses seededAtCheckpoint when lastTouchedAtCheckpoint is absent", () => {
    const item = makeSetup({ status: "seeded", seededAtCheckpoint: 7 });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "reinforce",
      urgency: "soon",
    });
  });

  it("returns hold/normal for a fresh seeded setup (gap < 2)", () => {
    const item = makeSetup({ status: "seeded", lastTouchedAtCheckpoint: 9 });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("returns hold/normal when seededAtCheckpoint and lastTouchedAtCheckpoint are both absent", () => {
    const item = makeSetup({ status: "seeded" });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("returns hold/normal for non-seeded active statuses even when stale", () => {
    for (const status of ["reinforced", "ready"] as const) {
      const item = makeSetup({ status, lastTouchedAtCheckpoint: 0 });
      expect(classifySetup(item, 10, undefined)).toEqual({
        id: "setup-1",
        action: "hold",
        urgency: "normal",
      });
    }
  });

  it("returns hold/normal for planned setups with no anchor dependency", () => {
    const item = makeSetup({ status: "planned" });
    expect(classifySetup(item, 10, undefined)).toEqual({
      id: "setup-1",
      action: "hold",
      urgency: "normal",
    });
  });

  it("carries the item id through in every directive branch", () => {
    const directive: SetupDirective = classifySetup(
      makeSetup({ id: "custom-id", status: "seeded", lastTouchedAtCheckpoint: 8 }),
      10,
      undefined,
    ) as SetupDirective;
    expect(directive.id).toBe("custom-id");
  });
});
