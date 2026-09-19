/**
 * Tests for MemoryConsolidator (Task 8).
 *
 * The consolidation pipeline extracted from Task 6's
 * NarrativeDirectorService.consolidatePending(): truncation to
 * max_events_per_call, port invocation, validator filtering, episode id
 * generation (`ep_{revision+1}_{fromSeq}`), and rejection recording.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  NarrativeMemoryState,
  PlotThread,
  SetupPayoff,
} from "../../core/narrative/memory-types.js";
import type {
  ThreadOp,
  SetupOp,
  EpisodeSummaryOp,
} from "../../core/narrative/memory-operation.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";
import type { NarrativeConfig } from "../../config.js";
import type { StoredEvent } from "../../schema.js";
import { DEFAULT_NARRATIVE_CONFIG } from "../../config.js";

import { MemoryConsolidator } from "./memory-consolidator.js";
import type {
  MemoryConsolidatorPort,
  ConsolidationRequest,
  ConsolidationResult,
} from "./memory-consolidator.js";
import type { CharacterRegistry } from "../../core/characters/types.js";

// ---------------------------------------------------------------------------
// Fakes / fixtures
// ---------------------------------------------------------------------------

/** Minimal narration StoredEvent for tests. */
function makeEvent(seq: number, turn = 1): StoredEvent {
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

/** Dialogue StoredEvent with a stable characterId（身份视图证据登场）。 */
function makeDialogueEvent(
  seq: number,
  characterId: string,
  text: string,
): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "dialogue",
    speaker: characterId,
    characterId,
    text,
  } as unknown as StoredEvent;
}

function makeConfig(
  overrides: Partial<NarrativeConfig> = {},
): NarrativeConfig {
  return { ...DEFAULT_NARRATIVE_CONFIG, ...overrides };
}

/** Empty state factory (returns a fresh object every time). */
function emptyState(): NarrativeMemoryState {
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
class RecordingDiagnostics implements DiagnosticSink {
  infos: Array<{ scope: string; message: string }> = [];
  warns: Array<{ scope: string; message: string }> = [];

  info(scope: string, message: string): void {
    this.infos.push({ scope, message });
  }
  warn(scope: string, message: string): void {
    this.warns.push({ scope, message });
  }
}

function makeThread(overrides: Partial<PlotThread> & { id: string }): PlotThread {
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

function makeSetup(overrides: Partial<SetupPayoff> & { id: string }): SetupPayoff {
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

/** A valid episode summary op. */
function makeEpisodeOp(
  overrides: Partial<EpisodeSummaryOp> = {},
): EpisodeSummaryOp {
  return {
    summary: "An episode",
    characters: ["aiko"],
    locations: ["study"],
    threads: [],
    setups: [],
    importance: "normal",
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<ConsolidationResult> = {},
): ConsolidationResult {
  return {
    episode: makeEpisodeOp(),
    threadOps: [],
    setupOps: [],
    factOps: [],
    beliefOps: [],
    findings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MemoryConsolidator tests
// ---------------------------------------------------------------------------

describe("MemoryConsolidator", () => {
  let diag: RecordingDiagnostics;

  beforeEach(() => {
    diag = new RecordingDiagnostics();
  });

  function makeConsolidator(
    port: MemoryConsolidatorPort | undefined,
    config: NarrativeConfig = makeConfig(),
  ): MemoryConsolidator {
    return new MemoryConsolidator({
      port,
      config,
      diagnostics: diag,
    });
  }

  // -----------------------------------------------------------------------
  // Success path
  // -----------------------------------------------------------------------
  describe("consolidate — success path", () => {
    it("calls the port with events, active threads, non-terminal setups, and state", async () => {
      const consolidate = vi.fn().mockResolvedValue(makeResult());
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.revision = 2;
      memory.threads = {
        t1: makeThread({ id: "t1", status: "open" }),
        t2: makeThread({ id: "t2", status: "resolved" }), // terminal → excluded
      };
      memory.setups = {
        s1: makeSetup({ id: "s1", status: "planned" }),
        s2: makeSetup({ id: "s2", status: "paid_off" }), // terminal → excluded
      };

      const outcome = await consolidator.consolidate(
        [makeEvent(10), makeEvent(11)],
        memory,
        "study",
        ["aiko"],
      );

      expect(consolidate).toHaveBeenCalledTimes(1);
      const request: ConsolidationRequest = consolidate.mock
        .calls[0]![0] as ConsolidationRequest;
      expect(request.events.map((e) => e.seq)).toEqual([10, 11]);
      expect(request.threads.map((t) => t.id)).toEqual(["t1"]);
      expect(request.setups.map((s) => s.id)).toEqual(["s1"]);
      expect(request.stateLocation).toBe("study");
      expect(request.stateCharacters).toEqual(["aiko"]);
    });

    it("returns the raw result and builds a validated episode with the generated id", async () => {
      const result = makeResult({
        episode: makeEpisodeOp({
          summary: "A new episode",
          characters: ["aiko"],
          locations: ["study"],
          threads: ["t1"],
          setups: ["s1"],
          importance: "major",
        }),
      });
      const consolidate = vi.fn().mockResolvedValue(result);
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.revision = 2;
      // episode.threads/setups 引用权威清单中的 id（活跃线程/非终结伏笔）。
      memory.threads = { t1: makeThread({ id: "t1", status: "open" }) };
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10), makeEvent(11), makeEvent(12)],
        memory,
        "",
        [],
      );

      // Raw result passes through unchanged
      expect(outcome.result).toBe(result);
      // Episode id = `ep_{revision+1}_{fromSeq}`, from/to from the batch
      expect(outcome.episode).not.toBeNull();
      expect(outcome.episode!.id).toBe("ep_3_10");
      expect(outcome.episode!.fromEventSeq).toBe(10);
      expect(outcome.episode!.toEventSeq).toBe(12);
      expect(outcome.episode!.summary).toBe("A new episode");
      expect(outcome.episode!.characters).toEqual(["aiko"]);
      expect(outcome.episode!.locations).toEqual(["study"]);
      expect(outcome.episode!.threads).toEqual(["t1"]);
      expect(outcome.episode!.setups).toEqual(["s1"]);
      expect(outcome.episode!.importance).toBe("major");
      // Nothing rejected
      expect(outcome.rejected).toEqual([]);
    });

    it("passes validated thread/setup ops through to the outcome", async () => {
      const threadOps: ThreadOp[] = [
        { type: "touch", id: "t1", progress: "new summary" },
        { type: "advance", id: "t1" },
      ];
      const setupOps: SetupOp[] = [
        { type: "seed", id: "s1" },
        { type: "hold", id: "s1" },
      ];
      const consolidate = vi
        .fn()
        .mockResolvedValue(makeResult({ threadOps, setupOps }));
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = { t1: makeThread({ id: "t1", status: "open" }) };
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.threadOps).toEqual(threadOps);
      expect(outcome.setupOps).toEqual(setupOps);
      expect(outcome.rejected).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // §6.2 identity/reference validation (C8) — explicit ValidatedProposal,
  // no silent tag filtering. main 接线：身份视图由 MemoryConsolidator 从
  // registry + 批事件构造并随 REQUEST 携带（campus 经 port 结果回传），
  // 测试以注入 registry 的方式驱动 identity 模式。
  // -----------------------------------------------------------------------
  describe("consolidate — §6.2 identity validation", () => {
    /** Minimal hand-rolled CharacterRegistry（只覆盖身份视图读取的面）。 */
    function makeRegistry(
      characters: Array<{ id: string; name: string; initialLabel?: string }>,
    ): CharacterRegistry {
      const definitions = characters.map((c) => ({
        id: c.id,
        name: c.name,
        control: "npc" as const,
        initialLabel: c.initialLabel ?? c.name,
        persona: `persona of ${c.id}`,
      }));
      const byId = new Map(definitions.map((d) => [d.id, d] as const));
      return {
        roster: {
          schemaVersion: 2,
          scopeId: "test-scope",
          revision: "v2-testrev",
          playerId: "player",
          characters: definitions,
        },
        get: (id: string) => byId.get(id),
        require: (id: string) => {
          const found = byId.get(id);
          if (found === undefined) {
            throw new Error(`角色 ${id} 未注册`);
          }
          return found;
        },
      };
    }

    /** 含同名双胞胎的注册表（twin_ayaka/twin_aoi 都叫「绫香」）。 */
    const REGISTRY = makeRegistry([
      { id: "player", name: "玩家" },
      { id: "suyao", name: "苏遥" },
      { id: "linche", name: "林澈" },
      { id: "twin_ayaka", name: "绫香" },
      { id: "twin_aoi", name: "绫香" },
    ]);

    const TWIN_REGISTRY = makeRegistry([
      { id: "player", name: "玩家" },
      { id: "twin_ayaka", name: "绫香" },
      { id: "twin_aoi", name: "绫香" },
    ]);

    function makeConsolidatorWithRegistry(
      port: MemoryConsolidatorPort,
      registry: CharacterRegistry | undefined,
    ): MemoryConsolidator {
      return new MemoryConsolidator({
        port,
        config: makeConfig(),
        // exactOptionalPropertyTypes：缺席时不传键（undefined 不是可选值）。
        ...(registry !== undefined ? { registry } : {}),
        diagnostics: diag,
      });
    }

    it("carries the identity view on the REQUEST: allowed = evidence ∪ scene cast ∩ registry, evidenceEvents ride along", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(makeResult()),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      await consolidator.consolidate(
        [
          makeDialogueEvent(1, "suyao", "这条线索不对劲。"),
          makeDialogueEvent(2, "player", "我们去查证。"),
        ],
        emptyState(),
        "clubroom",
        // 场景名单含非注册表字符串（legacy 残留）：请求侧归一只留 linche。
        ["linche", "神秘女子"],
      );

      const request = port.consolidate.mock.calls[0]![0] as ConsolidationRequest;
      expect(request.identity).toBeDefined();
      const view = request.identity!;
      expect(view.rosterRevision).toBe("v2-testrev");
      expect([...view.knownCharacterIds].sort()).toEqual([
        "linche",
        "player",
        "suyao",
        "twin_aoi",
        "twin_ayaka",
      ]);
      // 允许集合 = 证据登场（suyao/player）∪ 场景名单∩注册表（linche）。
      expect([...view.allowedCharacterIds].sort()).toEqual([
        "linche",
        "player",
        "suyao",
      ]);
      expect([...view.evidenceCharacterIds].sort()).toEqual(["player", "suyao"]);
      // 证据区间覆盖已提交 seq。
      expect(view.evidenceSeqRange).toEqual({ min: 1, max: 2 });
      expect([...view.canonicalLocations!]).toEqual(["clubroom"]);
      // 显示名 → ID 只作诊断，同名绝不合并。
      expect(view.charactersByDisplayName.get("苏遥")).toEqual(["suyao"]);
      expect(view.charactersByDisplayName.get("绫香")).toEqual([
        "twin_ayaka",
        "twin_aoi",
      ]);
      // 证据投影随请求携带（adapter 直接渲染，不各自投影）。
      expect(request.evidenceEvents).toHaveLength(2);
    });

    it("legacy (no registry): the request carries no identity view and no evidence projection", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(makeResult()),
      };
      const consolidator = makeConsolidatorWithRegistry(port, undefined);

      await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );

      const request = port.consolidate.mock.calls[0]![0] as ConsolidationRequest;
      expect(request.identity).toBeUndefined();
      expect(request.evidenceEvents).toBeUndefined();
    });

    it("accepts legal stable IDs and returns an accepted episode proposal with empty issues", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "苏遥与林澈在社团室整理线索。",
              characters: ["suyao", "linche"],
              locations: ["clubroom"],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1), makeEvent(2)],
        emptyState(),
        "clubroom",
        ["suyao", "linche"],
      );

      expect(outcome.validationMode).toBe("identity");
      expect(outcome.episodeProposal!.status).toBe("accepted");
      if (outcome.episodeProposal!.status === "accepted") {
        expect(outcome.episodeProposal!.issues).toEqual([]);
        expect(outcome.episodeProposal!.value.characters).toEqual(["suyao", "linche"]);
      }
      expect(outcome.episode?.characters).toEqual(["suyao", "linche"]);
      expect(outcome.identityIssues).toEqual([]);
      expect(outcome.rejected).toEqual([]);
    });

    it("treats a legal EMPTY proposal as an accepted no-op (empty characters pass)", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "只有环境描写的过场。",
              characters: [],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "clubroom",
        ["suyao"],
      );

      // 合法空提案 = accepted no-op（水位推进由 director 决定，这里只报结果）。
      expect(outcome.episodeProposal!.status).toBe("accepted");
      expect(outcome.episode?.characters).toEqual([]);
      expect(outcome.rejected).toEqual([]);
      expect(outcome.identityIssues).toEqual([]);
    });

    it("rejects a display-name misfill with UNKNOWN_CHARACTER_ID — never silently filters", async () => {
      const episode = {
        summary: "苏遥在终端前发现了异常。",
        characters: ["苏遥", "linche"],
        locations: ["clubroom"],
        threads: [],
        setups: [],
        importance: "normal" as const,
      };
      const port = {
        consolidate: vi.fn().mockResolvedValue(makeResult({ episode })),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1), makeEvent(2)],
        emptyState(),
        "clubroom",
        ["suyao", "linche"],
      );

      // 整案拒绝：不用过滤后的 ["linche"] 伪装成功。
      expect(outcome.episode).toBeNull();
      expect(outcome.episodeProposal!.status).toBe("rejected");
      expect(outcome.episodeProposal!.issues).toEqual([
        {
          code: "UNKNOWN_CHARACTER_ID",
          path: "episode.characters[0]",
          value: "苏遥",
        },
      ]);
      expect(outcome.identityIssues).toEqual(outcome.episodeProposal!.issues);
      // RejectedOp 携带结构化 issues（字段路径 + 违规值），不掩盖原提案错误。
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("episode");
      expect(outcome.rejected[0]!.op).toBe(episode);
      expect(outcome.rejected[0]!.issues).toEqual([
        { code: "UNKNOWN_CHARACTER_ID", path: "episode.characters[0]", value: "苏遥" },
      ]);
      expect(outcome.rejected[0]!.reason).toContain("苏遥");
    });

    it("rejects an unknown character ID with UNKNOWN_CHARACTER_ID", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "有人在暗处窥视。",
              characters: ["ghost_x"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.episode).toBeNull();
      expect(outcome.identityIssues).toEqual([
        { code: "UNKNOWN_CHARACTER_ID", path: "episode.characters[0]", value: "ghost_x" },
      ]);
    });

    it("rejects a registered character outside allowed ∪ evidence with KNOWLEDGE_NOT_SUPPORTED", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "林澈没有出场却被写进了记忆。",
              characters: ["linche"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        // 允许集合与证据都只有 suyao：linche 已注册但无获知依据。
        ["suyao"],
      );

      expect(outcome.episode).toBeNull();
      expect(outcome.identityIssues).toEqual([
        { code: "KNOWLEDGE_NOT_SUPPORTED", path: "episode.characters[0]", value: "linche" },
      ]);
    });

    it("keeps an EMPTY allowed set strictly empty — any character tag is rejected, not unrestricted", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "纯旁白批次。",
              characters: ["suyao"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );

      // 注册表里明明有 suyao，但允许集合为空：不退化为「全部注册角色可用」。
      expect(outcome.episode).toBeNull();
      expect(outcome.identityIssues).toEqual([
        { code: "KNOWLEDGE_NOT_SUPPORTED", path: "episode.characters[0]", value: "suyao" },
      ]);
    });

    it("same-name twins never merge: display name rejected, both distinct IDs accepted", async () => {
      // 「绫香」是两个角色的显示名 → 拒绝，绝不解析为其中之一。
      const misfillPort = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "绫香出现了。",
              characters: ["绫香"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const misfillOutcome = await makeConsolidatorWithRegistry(
        misfillPort,
        TWIN_REGISTRY,
      ).consolidate(
        [
          makeDialogueEvent(1, "twin_ayaka", "姐姐。"),
          makeDialogueEvent(2, "twin_aoi", "妹妹。"),
        ],
        emptyState(),
        "",
        [],
      );
      expect(misfillOutcome.episode).toBeNull();
      expect(misfillOutcome.identityIssues).toEqual([
        { code: "UNKNOWN_CHARACTER_ID", path: "episode.characters[0]", value: "绫香" },
      ]);

      // 两个稳定 ID 独立通过，互不合并（证据登场双胞胎 → 允许集合并列）。
      const distinctPort = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "两个绫香同场。",
              characters: ["twin_ayaka", "twin_aoi"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const distinctOutcome = await makeConsolidatorWithRegistry(
        distinctPort,
        TWIN_REGISTRY,
      ).consolidate(
        [
          makeDialogueEvent(1, "twin_ayaka", "姐姐。"),
          makeDialogueEvent(2, "twin_aoi", "妹妹。"),
        ],
        emptyState(),
        "",
        [],
      );
      expect(distinctOutcome.episodeProposal!.status).toBe("accepted");
      expect(distinctOutcome.episode?.characters).toEqual(["twin_ayaka", "twin_aoi"]);
    });

    it("aggregates every issue across fields in ONE rejection (never masks later errors)", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "多字段违规。",
              characters: ["苏遥", "ghost_x"],
              locations: ["basement"],
              threads: ["t-ghost"],
              setups: ["s-ghost"],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "clubroom",
        ["suyao", "linche"],
      );

      expect(outcome.episode).toBeNull();
      expect(
        outcome.identityIssues!.map((i) => [i.code, i.path, i.value]),
      ).toEqual([
        ["UNKNOWN_CHARACTER_ID", "episode.characters[0]", "苏遥"],
        ["UNKNOWN_CHARACTER_ID", "episode.characters[1]", "ghost_x"],
        ["INVALID_REFERENCE", "episode.locations[0]", "basement"],
        ["INVALID_REFERENCE", "episode.threads[0]", "t-ghost"],
        ["INVALID_REFERENCE", "episode.setups[0]", "s-ghost"],
      ]);
    });

    it("rejects setup evidence refs outside the committed range with EVIDENCE_OUT_OF_RANGE", async () => {
      const memory = emptyState();
      memory.setups = { s1: makeSetup({ id: "s1", status: "seeded" }) };
      const op = {
        type: "hold" as const,
        id: "s1",
        evidenceEventIds: ["2", "99", "x"],
      };
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: makeEpisodeOp({ characters: ["suyao"], locations: ["clubroom"] }),
            setupOps: [op],
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(1), makeEvent(2)],
        memory,
        "",
        ["suyao"],
      );

      // 证据非法的 op 整条拒绝，不静默丢弃证据字段。
      expect(outcome.setupOps).toEqual([]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("setup");
      expect(outcome.rejected[0]!.issues).toEqual([
        { code: "EVIDENCE_OUT_OF_RANGE", path: "setupOps[0].evidenceEventIds[1]", value: "99" },
        { code: "EVIDENCE_OUT_OF_RANGE", path: "setupOps[0].evidenceEventIds[2]", value: "x" },
      ]);
      expect(outcome.identityIssues!.map((i) => [i.code, i.path])).toEqual([
        ["EVIDENCE_OUT_OF_RANGE", "setupOps[0].evidenceEventIds[1]"],
        ["EVIDENCE_OUT_OF_RANGE", "setupOps[0].evidenceEventIds[2]"],
      ]);
    });

    it("accepts a thread tag created by a same-batch create op, rejects a dead thread tag", async () => {
      // episode.threads 引用同批 create 的新线程 → 合法。
      const createPort = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "新线索出现。",
              characters: [],
              locations: [],
              threads: ["t-new"],
              setups: [],
              importance: "normal",
            },
            threadOps: [
              { type: "create" as const, id: "t-new", kind: "mystery" as const, importance: "minor" as const },
            ],
          }),
        ),
      };
      const createOutcome = await makeConsolidatorWithRegistry(
        createPort,
        REGISTRY,
      ).consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );
      expect(createOutcome.episodeProposal!.status).toBe("accepted");
      expect(createOutcome.episode?.threads).toEqual(["t-new"]);

      // episode.threads 引用不存在的线程 → INVALID_REFERENCE（legacy 模式
      // 也没有豁免：请求线程清单就是权威）。
      const deadPort = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "引用了幽灵线程。",
              characters: [],
              locations: [],
              threads: ["t-ghost"],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const deadOutcome = await makeConsolidatorWithRegistry(
        deadPort,
        REGISTRY,
      ).consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );
      expect(deadOutcome.episode).toBeNull();
      expect(deadOutcome.episodeProposal!.issues).toEqual([
        { code: "INVALID_REFERENCE", path: "episode.threads[0]", value: "t-ghost" },
      ]);
    });

    it("legacy (no registry): keeps tags as-is and runs no identity validation", async () => {
      const port = {
        consolidate: vi.fn().mockResolvedValue(
          makeResult({
            episode: {
              summary: "新角色登场。",
              characters: ["神秘女子"],
              locations: [],
              threads: [],
              setups: [],
              importance: "normal",
            },
          }),
        ),
      };
      const consolidator = makeConsolidatorWithRegistry(port, undefined);

      const outcome = await consolidator.consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.validationMode).toBe("legacy");
      expect(outcome.episode?.characters).toEqual(["神秘女子"]);
      expect(outcome.identityIssues).toEqual([]);
    });

    it("shape-invalid episode stays rejected with the rule reason (identity issues reported separately)", async () => {
      const badEpisode = makeEpisodeOp({ summary: "", characters: [], locations: [] });
      const port = {
        consolidate: vi.fn().mockResolvedValue(makeResult({ episode: badEpisode })),
      };
      const consolidator = makeConsolidatorWithRegistry(port, REGISTRY);

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.episode).toBeNull();
      expect(outcome.episodeProposal!.status).toBe("rejected");
      // 形状（summary 为空）不是身份问题：issues 为空，原因在 rejected[].reason。
      expect(outcome.episodeProposal!.issues).toEqual([]);
      expect(outcome.rejected[0]!.reason).toContain("episode summary");
      expect(outcome.rejected[0]!.rule).toBe("EPISODE_EMPTY_SUMMARY");
    });
  });

  // -----------------------------------------------------------------------
  // Rejection paths
  // -----------------------------------------------------------------------
  describe("consolidate — rejection paths", () => {
    it("moves invalid threadOps into rejected and keeps valid ones", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          threadOps: [
            { type: "touch", id: "t1" }, // valid
            { type: "touch", id: "ghost" }, // invalid: does not exist
          ],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = { t1: makeThread({ id: "t1", status: "open" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.threadOps).toEqual([{ type: "touch", id: "t1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("thread");
      expect(outcome.rejected[0]!.op).toEqual({ type: "touch", id: "ghost" });
      expect(outcome.rejected[0]!.reason).toContain("ghost");
    });

    it("moves invalid setupOps into rejected and keeps valid ones", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          setupOps: [
            { type: "seed", id: "s1" }, // valid
            { type: "seed", id: "ghost-s" }, // invalid: does not exist
          ],
          factOps: [],
          beliefOps: [],
          findings: [],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("setup");
      expect(outcome.rejected[0]!.op).toEqual({ type: "seed", id: "ghost-s" });
      expect(outcome.rejected[0]!.reason).toContain("ghost-s");
    });

    it("validates ops transactionally against a shadow: same-batch state changes are visible (audit finding 4)", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          // Two creates in ONE batch. With max_minor_active: 3 and 2 active
          // minor threads already, only the first may pass — the second
          // must see the first's shadow application.
          threadOps: [
            { type: "create", id: "rt1", kind: "character", importance: "minor" },
            { type: "create", id: "rt2", kind: "character", importance: "minor" },
          ],
          // Two seeds of the SAME setup: the second must be rejected
          // (status is seeded after the first applied to the shadow).
          setupOps: [
            { type: "seed", id: "s1" },
            { type: "seed", id: "s1" },
          ],
          factOps: [],
          beliefOps: [],
          findings: [],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      memory.threads = {
        existing1: makeThread({ id: "existing1", status: "open", importance: "minor" }),
        existing2: makeThread({ id: "existing2", status: "open", importance: "minor" }),
      };
      memory.setups = { s1: makeSetup({ id: "s1", status: "planned" }) };

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      // First create passes (2 + 1 = 3, at the cap); second rejected.
      expect(outcome.threadOps).toEqual([
        { type: "create", id: "rt1", kind: "character", importance: "minor" },
      ]);
      expect(outcome.rejected).toHaveLength(2);
      expect(outcome.rejected[0]!.op).toEqual({
        type: "create",
        id: "rt2",
        kind: "character",
        importance: "minor",
      });
      expect(outcome.rejected[0]!.reason).toContain("上限");
      // First seed passes; second rejected (s1 is already seeded in shadow).
      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected[1]!.op).toEqual({ type: "seed", id: "s1" });
      expect(outcome.rejected[1]!.reason).toContain("只有 planned 可以 seed");
    });

    it("rejects a setup budget overflow across same-batch seeds", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          setupOps: [
            { type: "seed", id: "s1" },
            { type: "seed", id: "s2" },
          ],
          factOps: [],
          beliefOps: [],
          findings: [],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });
      const memory = emptyState();
      // max_active: 6; 5 already active → s1 fits (6), s2 must be rejected.
      memory.setups = {
        s1: makeSetup({ id: "s1", status: "planned" }),
        s2: makeSetup({ id: "s2", status: "planned" }),
      };
      for (let i = 0; i < 5; i++) {
        memory.setups[`active_${i}`] = makeSetup({
          id: `active_${i}`,
          status: "seeded",
        });
      }

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        memory,
        "",
        [],
      );

      expect(outcome.setupOps).toEqual([{ type: "seed", id: "s1" }]);
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.op).toEqual({ type: "seed", id: "s2" });
      expect(outcome.rejected[0]!.reason).toContain("上限");
    });

    it("rejects an invalid episode op and records it", async () => {
      const badEpisode = makeEpisodeOp({ summary: "" });
      const consolidate = vi
        .fn()
        .mockResolvedValue(makeResult({ episode: badEpisode }));
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      // Result still returned; episode filtered out and recorded as rejected
      expect(outcome.result).toBeDefined();
      expect(outcome.episode).toBeNull();
      expect(outcome.rejected).toHaveLength(1);
      expect(outcome.rejected[0]!.kind).toBe("episode");
      expect(outcome.rejected[0]!.op).toBe(badEpisode);
      expect(outcome.rejected[0]!.reason).toContain("episode summary");
    });

    it("records rejections in Task 6 order: episode, thread, setup", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          episode: makeEpisodeOp({ summary: "" }), // rejected
          threadOps: [{ type: "touch", id: "ghost" }], // rejected
          setupOps: [{ type: "seed", id: "ghost-s" }], // rejected
          factOps: [],
          beliefOps: [],
          findings: [],
        }),
      );
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.rejected.map((r) => r.kind)).toEqual([
        "episode",
        "thread",
        "setup",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Port failure
  // -----------------------------------------------------------------------
  describe("consolidate — port failure", () => {
    it("returns a null result without throwing and emits a warning", async () => {
      const consolidate = vi
        .fn()
        .mockRejectedValue(new Error("LLM timeout"));
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.threadOps).toEqual([]);
      expect(outcome.setupOps).toEqual([]);
      expect(outcome.rejected).toEqual([]);
      // Diagnostic warning emitted (same pipeline behavior as Task 6)
      expect(diag.warns.length).toBeGreaterThanOrEqual(1);
      expect(diag.warns[0]!.message).toContain("consolidation failed");
    });
  });

  // -----------------------------------------------------------------------
  // Truncation
  // -----------------------------------------------------------------------
  describe("consolidate — event truncation", () => {
    it("sends at most max_events_per_call events to the port, keeping the OLDEST N (FIFO)", async () => {
      const consolidate = vi.fn().mockResolvedValue(makeResult());
      // Cap of 4; 10 events → only seqs 1..4 reach the port
      const consolidator = makeConsolidator({ consolidate }, makeConfig({
        consolidation: {
          batch_min_events: 4,
          max_events_per_call: 4,
          min_checkpoint_gap_ms: 0,
        },
      }));

      const events = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((seq) =>
        makeEvent(seq),
      );
      const outcome = await consolidator.consolidate(
        events,
        emptyState(),
        "",
        [],
      );

      expect(consolidate).toHaveBeenCalledTimes(1);
      const request = consolidate.mock.calls[0]![0] as ConsolidationRequest;
      expect(request.events).toHaveLength(4);
      expect(request.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      // Overflow drop is reported via diagnostics (Task 6 behavior)
      expect(diag.infos.some((i) => i.message.includes("Dropping 6 newer overflow"))).toBe(true);
      // Episode fromSeq is the first seq of the CAPPED batch
      expect(outcome.episode!.fromEventSeq).toBe(1);
      expect(outcome.episode!.toEventSeq).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("consolidate — edge cases", () => {
    it("returns an empty outcome without calling anything when port is undefined", async () => {
      const consolidator = makeConsolidator(undefined);

      const outcome = await consolidator.consolidate(
        [makeEvent(10)],
        emptyState(),
        "",
        [],
      );

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.threadOps).toEqual([]);
      expect(outcome.setupOps).toEqual([]);
      expect(outcome.rejected).toEqual([]);
      // Nothing logged (no truncation, no failure)
      expect(diag.infos).toEqual([]);
      expect(diag.warns).toEqual([]);
    });

    it("returns an empty outcome without calling the port when events are empty", async () => {
      const consolidate = vi.fn();
      const consolidator = makeConsolidator({ consolidate });

      const outcome = await consolidator.consolidate([], emptyState(), "", []);

      expect(outcome.result).toBeNull();
      expect(outcome.episode).toBeNull();
      expect(outcome.rejected).toEqual([]);
      expect(consolidate).not.toHaveBeenCalled();
    });
  });
  // -----------------------------------------------------------------------
  // MA-B：facts / beliefs / findings 分流与预算
  // -----------------------------------------------------------------------
  describe("consolidate — MA-B facts/beliefs/findings", () => {
    it("passes validated factOps and enforces the establish budget (≤3/batch)", async () => {
      const events = [1, 2, 3, 4, 5].map((n) => makeEvent(n));
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          factOps: [
            { type: "establish", content: "事实一", evidenceEventSeqs: [1] },
            { type: "establish", content: "事实二", evidenceEventSeqs: [2] },
            { type: "establish", content: "事实三", evidenceEventSeqs: [3] },
            { type: "establish", content: "事实四（超预算）", evidenceEventSeqs: [4] },
          ],
        }),
      );
      const outcome = await makeConsolidator({ consolidate }).consolidate(
        events,
        emptyState(),
        "",
        [],
      );

      expect(outcome.factOps).toHaveLength(3);
      const budgetRejected = outcome.rejected.find(
        (r) => r.rule === "FACT_BUDGET_EXCEEDED",
      );
      expect(budgetRejected).toBeDefined();
    });

    it("rejects amend referencing an unknown or already-superseded fact", async () => {
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          factOps: [
            { type: "amend", id: "ghost", content: "修订不存在的事实", evidenceEventSeqs: [1] },
          ],
        }),
      );
      const outcome = await makeConsolidator({ consolidate }).consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );
      expect(outcome.factOps).toHaveLength(0);
      expect(outcome.rejected[0]?.rule).toBe("FACT_AMEND_UNKNOWN_ID");
    });

    it("applies accepted facts to the validation shadow (amend chain in one batch)", async () => {
      // 第一条 establish 落影子后，同批 amend 才能引用…… establish 的 id 由
      // 应用方生成，同批 establish 不可被 amend 引用（无 id）——这里只验证
      // amend 指向既有快照中的 fact 时被接受并传递。
      const memory = emptyState();
      memory.facts.push({
        id: "fact_1_1",
        content: "旧事实",
        evidenceEventSeqs: [1],
        checkpoint: 1,
        superseded: false,
      });
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          factOps: [
            { type: "amend", id: "fact_1_1", content: "新事实", evidenceEventSeqs: [1], importance: "major" },
          ],
        }),
      );
      const outcome = await makeConsolidator({ consolidate }).consolidate(
        [makeEvent(1)],
        memory,
        "",
        [],
      );
      expect(outcome.factOps).toHaveLength(1);
      expect(outcome.factOps[0]!.type).toBe("amend");
    });

    it("rejects beliefOps for unknown characters and enforces per-character budget", async () => {
      const events = [1, 2, 3].map((n) => makeEvent(n));
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          beliefOps: [
            { type: "learn", characterId: "苏遥", content: "c1", evidenceEventSeqs: [1] },
            { type: "learn", characterId: "苏遥", content: "c2", evidenceEventSeqs: [1] },
            { type: "learn", characterId: "苏遥", content: "c3", evidenceEventSeqs: [1] },
            { type: "learn", characterId: "路人", content: "c4", evidenceEventSeqs: [1] },
          ],
        }),
      );
      const outcome = await makeConsolidator({ consolidate }).consolidate(
        events,
        emptyState(),
        "",
        ["苏遥"],
      );

      expect(outcome.beliefOps).toHaveLength(2);
      const rules = outcome.rejected.map((r) => r.rule);
      expect(rules).toContain("BELIEF_BUDGET_EXCEEDED");
      expect(rules).toContain("BELIEF_UNKNOWN_CHARACTER");
    });

    it("passes findings through and rejects batches exceeding the findings cap", async () => {
      const finding = {
        dimension: "fact-conflict" as const,
        severity: "major" as const,
        content: "与既有事实矛盾",
        evidenceEventSeqs: [1],
      };
      const consolidate = vi.fn().mockResolvedValue(
        makeResult({
          findings: [finding],
        }),
      );
      const ok = await makeConsolidator({ consolidate }).consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );
      expect(ok.findings).toHaveLength(1);

      const six = Array.from({ length: 6 }, () => finding);
      const consolidate2 = vi.fn().mockResolvedValue(makeResult({ findings: six }));
      const over = await makeConsolidator({ consolidate: consolidate2 }).consolidate(
        [makeEvent(1)],
        emptyState(),
        "",
        [],
      );
      expect(over.findings).toHaveLength(5);
      expect(over.rejected.map((r) => r.rule)).toContain("FINDING_BATCH_EXCEEDED");
    });
  });
});
