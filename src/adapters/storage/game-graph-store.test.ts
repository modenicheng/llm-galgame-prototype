/**
 * GameGraphStore 测试（§9 布局 / M1.2）——真源拆分、latest-wins、
 * 损坏容忍与结构级抛错的边界；M3：快照 v4 契约与 v3→v4 兼容读取的
 * fixture 矩阵（固定 fixture 只读拷贝，原文件永不改写）。
 */
import { describe, expect, it } from "vitest";
import { appendFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GameGraphStore } from "./game-graph-store.js";
import { RunGraphCoordinator } from "../../application/graph/run-graph-coordinator.js";
import { FakeClock } from "../../test-helpers.js";
import { buildCharacterRoster } from "../../core/characters/registry.js";
import type { CharacterRoster } from "../../core/characters/types.js";
import type { LegacyIdentityMapping } from "../../core/characters/legacy-identity.js";
import type { GraphIdentityContext } from "../../core/ports/identity-snapshot-port.js";
import {
  SnapshotUpcastError,
  SnapshotVersionGateError,
} from "../../core/graph/snapshot-upcast.js";
import { legacyEventContentSummary } from "./identity-upcaster.js";
import { isRosterCapableCanon } from "../../application/characters/world-roster.js";
import { CanonStore } from "./canon-store.js";
import { VoiceDesignStore } from "./voice-design-store.js";
import { mergeVoiceDesignViews } from "../../application/audio/voice-design-views.js";
import { GAME_STORAGE_LAYOUT, decisionSnapshotPath, edgePayloadPath, rosterBlobPath } from "../../core/graph/ids.js";
import { makeDecision, makeEdge, makeIdentity, makeSnapshot } from "../../core/graph/testing.js";
import type { StoredEvent } from "../../schema.js";

function makeStoredEvent(seq: number): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: new Date().toISOString(),
    source: "model",
    type: "narration",
    text: `Event ${seq}`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

const GAME_ID = "game_test1";

/** 每个用例独立的临时 game 目录。 */
async function makeStore(): Promise<{ store: GameGraphStore; gameDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "galgame-graph-"));
  const store = new GameGraphStore(root, GAME_ID);
  await store.initialize();
  return { store, gameDir: path.join(root, GAME_ID) };
}

describe("GameGraphStore 布局", () => {
  it("rejects an invalid gameId", () => {
    expect(() => new GameGraphStore("/tmp", "bad-id")).toThrow();
  });

  it("creates payloads and snapshots dirs under games/<gameId>", async () => {
    const { gameDir } = await makeStore();
    try {
      expect(existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.payloadsDir))).toBe(true);
      expect(existsSync(path.join(gameDir, GAME_STORAGE_LAYOUT.snapshotsDir))).toBe(true);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("决策节点：快照唯一真源", () => {
  it("roundtrips a decision node through index + snapshot files", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const node = makeDecision({ id: "dc_a1", sceneId: "sc_s1" });
      await store.putDecision(node);

      expect(await store.getDecision("dc_a1")).toEqual(node);
      expect(existsSync(path.join(gameDir, decisionSnapshotPath("dc_a1")))).toBe(true);
      // 索引行不含 entryState（entryState 唯一物理真源 = 快照文件）
      const decisionsRaw = await readFile(path.join(gameDir, GAME_STORAGE_LAYOUT.decisions), "utf8");
      expect(decisionsRaw).not.toContain("entryState");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("returns null for an unknown decision and throws when the snapshot is missing", async () => {
    const { store, gameDir } = await makeStore();
    try {
      expect(await store.getDecision("dc_none")).toBeNull();

      await store.putDecision(makeDecision({ id: "dc_x1" }));
      await rm(path.join(gameDir, decisionSnapshotPath("dc_x1")));
      await expect(store.getDecision("dc_x1")).rejects.toThrow(/快照缺失/);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("lists decisions with composed entry states", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_b1" }));
      await store.putDecision(makeDecision({ id: "dc_b2" }));
      const nodes = await store.listDecisions();
      expect(nodes.map((n) => n.id).sort()).toEqual(["dc_b1", "dc_b2"]);
      expect(nodes[0]?.entryState.snapshotVersion).toBe(4);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("边：endState 派生与门禁", () => {
  it("accepts an edge whose endState equals the successor entry snapshot", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const entry = makeSnapshot({ outlineRevision: 4 });
      await store.putDecision(makeDecision({ id: "dc_c1" }));
      await store.putDecision(makeDecision({ id: "dc_c2", entryState: entry }));
      await store.putEdge(
        makeEdge({
          id: "eg_c1",
          from: "dc_c1",
          to: { kind: "decision", id: "dc_c2" },
          endState: entry,
        }),
      );

      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.endState).toEqual(entry);
      expect(edges[0]?.to).toEqual({ kind: "decision", id: "dc_c2" });
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("throws when the endState diverges from the successor snapshot", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_d1" }));
      await store.putDecision(
        makeDecision({ id: "dc_d2", entryState: makeSnapshot({ outlineRevision: 9 }) }),
      );
      await expect(
        store.putEdge(
          makeEdge({
            id: "eg_d1",
            from: "dc_d1",
            to: { kind: "decision", id: "dc_d2" },
            endState: makeSnapshot({ outlineRevision: 1 }),
          }),
        ),
      ).rejects.toThrow(/不一致/);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("keeps a confluence edge's true inline endState (≈ successor entry) without the equality gate", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const entry = makeSnapshot({ outlineRevision: 4 });
      const trueEnd = makeSnapshot({ outlineRevision: 7 });
      await store.putDecision(makeDecision({ id: "dc_g1" }));
      await store.putDecision(makeDecision({ id: "dc_g2", entryState: entry }));
      // 汇流边的真实末态 ≠ 后继入口（§3.3 只保证 ≈）：内联保存，不设门禁。
      await store.putEdge(
        makeEdge({
          id: "eg_g1",
          from: "dc_g1",
          to: { kind: "decision", id: "dc_g2" },
          endState: trueEnd,
          confluence: {
            matchedNode: "dc_g2",
            judgedBy: "director-llm",
            confidence: 0.8,
            rationale: "殊途同归：两条路径的舞台与关系状态等价",
          },
        }),
      );
      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.endState).toEqual(trueEnd);
      expect(edges[0]?.confluence?.matchedNode).toBe("dc_g2");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("stores an ending-pointed edge inline and composes it back", async () => {
    const { store, gameDir } = await makeStore();
    try {
      const endState = makeSnapshot({ outlineRevision: 2 });
      await store.putDecision(makeDecision({ id: "dc_e1" }));
      await store.putEdge(
        makeEdge({
          id: "eg_e1",
          from: "dc_e1",
          to: { kind: "ending", id: "end_e1" },
          endState,
        }),
      );
      const edges = await store.listEdges();
      expect(edges[0]?.to).toEqual({ kind: "ending", id: "end_e1" });
      expect(edges[0]?.endState).toEqual(endState);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("keeps the latest record when an edge id is written twice (latest-wins)", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.putDecision(makeDecision({ id: "dc_f1" }));
      await store.putDecision(makeDecision({ id: "dc_f2" }));
      const endState = makeSnapshot();
      await store.putEdge(
        makeEdge({ id: "eg_f1", from: "dc_f1", to: { kind: "decision", id: "dc_f2" }, endState }),
      );
      await store.putEdge(
        makeEdge({
          id: "eg_f1",
          from: "dc_f1",
          to: { kind: "decision", id: "dc_f2" },
          endState,
          confluence: {
            matchedNode: "dc_f2",
            judgedBy: "director",
            confidence: 0.9,
            rationale: "同末态",
          },
        }),
      );
      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.confluence?.judgedBy).toBe("director");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

describe("payload 与游标", () => {
  it("appends, reads, and deletes edge payload events in order", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.appendPayload("eg_p1", makeStoredEvent(3));
      await store.appendPayload("eg_p1", makeStoredEvent(4));
      expect((await store.readPayload("eg_p1")).map((e) => e.seq)).toEqual([3, 4]);
      expect(await store.readPayload("eg_missing")).toEqual([]);

      expect(existsSync(path.join(gameDir, edgePayloadPath("eg_p1")))).toBe(true);
      await store.deletePayload("eg_p1");
      expect(existsSync(path.join(gameDir, edgePayloadPath("eg_p1")))).toBe(false);
      await expect(store.deletePayload("eg_p1")).resolves.toBeUndefined();
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("skips malformed payload lines without hiding the rest", async () => {
    const { store, gameDir } = await makeStore();
    try {
      await store.appendPayload("eg_g1", makeStoredEvent(1));
      await appendFile(path.join(gameDir, edgePayloadPath("eg_g1")), "{broken\n", "utf8");
      await store.appendPayload("eg_g1", makeStoredEvent(2));
      expect((await store.readPayload("eg_g1")).map((e) => e.seq)).toEqual([1, 2]);
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("roundtrips stored interaction events (envelope fields must not break the payload guard)", async () => {
    const { store, gameDir } = await makeStore();
    try {
      // 回归（M1.4）：存储行 = 交互体 + seq/turn/timestamp/source 信封，
      // strictObject 的 InteractionEventSchema 只验交互体。
      const interaction = {
        type: "interaction",
        interaction_id: "interaction_2",
        prompt: "去留：",
        mode: "choice",
        options: [{ id: "interaction_2_opt_0", text: "留下" }, { id: "interaction_2_opt_1", text: "离开" }],
        seq: 5,
        turn: 2,
        timestamp: new Date().toISOString(),
        source: "model",
      } as StoredEvent;
      await store.appendPayload("eg_i1", makeStoredEvent(4));
      await store.appendPayload("eg_i1", interaction);
      const events = await store.readPayload("eg_i1");
      expect(events.map((event) => event.seq)).toEqual([4, 5]);
      expect(events[1]?.type).toBe("interaction");
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });

  it("roundtrips the cursor and reads a missing or corrupt cursor as null", async () => {
    const { store, gameDir } = await makeStore();
    try {
      expect(await store.loadCursor()).toBeNull();
      await store.putRun({ id: "run_r1", origin: { kind: "root" }, startedAt: "t1" });
      await store.saveCursor({ runId: "run_r1", position: "dc_p1" });
      expect(await store.loadCursor()).toEqual({ runId: "run_r1", position: "dc_p1" });
      expect((await store.getRun("run_r1"))?.origin).toEqual({ kind: "root" });
      expect(await store.getRun("run_none")).toBeNull();

      await writeFile(path.join(gameDir, GAME_STORAGE_LAYOUT.cursor), "{oops", "utf8");
      expect(await store.loadCursor()).toBeNull();
    } finally {
      await rm(path.dirname(gameDir), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// M3：快照 v4 契约与 v3→v4 兼容读取（固定 fixture 矩阵）
// ---------------------------------------------------------------------------

const M3_FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/m3",
);
const FIXTURE_GAME_ID = "game_fixture_v3";

/** fixture 世界 roster（revision 由 buildCharacterRoster 规范化计算）。 */
function fixtureRoster(): CharacterRoster {
  return buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "world:game_fixture_v3",
    playerId: "player",
    characters: [
      {
        id: "player",
        name: "玩家",
        control: "player",
        initialLabel: "你",
        persona: "测试玩家人设。",
      },
      {
        id: "suyao",
        name: "苏遥",
        control: "npc",
        initialLabel: "苏遥",
        persona: "总在天台看海的三年级学生。",
      },
      {
        id: "linche",
        name: "林澈",
        control: "npc",
        initialLabel: "林澈",
        persona: "刚转学来的二年级学生。",
      },
    ],
  });
}

const FIXTURE_MAPPING: LegacyIdentityMapping = {
  scope: { scopeId: "world:game_fixture_v3", schemaVersion: 1 },
  scriptNames: [
    { scriptName: "苏遥", characterId: "suyao" },
    { scriptName: "林澈", characterId: "linche" },
  ],
};

function fixtureIdentityContext(
  overrides?: Partial<GraphIdentityContext>,
): GraphIdentityContext {
  const roster = fixtureRoster();
  return {
    roster: () => roster,
    dslProtocolVersion: () => 1,
    legacyMapping: FIXTURE_MAPPING,
    ...overrides,
  };
}

/** 把固定 fixture 世界拷贝到临时目录（fixture 原件只读，永不改写）。 */
async function copyFixtureWorld(): Promise<{ root: string; gameDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "galgame-m3-"));
  const gameDir = path.join(root, FIXTURE_GAME_ID);
  await cp(path.join(M3_FIXTURES, "graph-v3"), gameDir, { recursive: true });
  return { root, gameDir };
}

/** 目录内全部文件的字节指纹（断言「原始 fixture 拷贝不被迁移改写」）。 */
async function dirFingerprint(dir: string): Promise<Record<string, string>> {
  const fingerprint: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        fingerprint[path.relative(dir, full).replace(/\\/g, "/")] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
      }
    }
  };
  await walk(dir);
  return fingerprint;
}

describe("M3 快照 v4 与 v3→v4 兼容读取（fixture 矩阵，R24/R25）", () => {
  it("v3 fixture + 身份上下文：读取即 v4（键/belief/fact 已映射，digest 补 []），原文件字节不变", async () => {
    const { root, gameDir } = await copyFixtureWorld();
    try {
      const before = await dirFingerprint(gameDir);
      const store = new GameGraphStore(root, FIXTURE_GAME_ID, {
        identity: fixtureIdentityContext(),
      });

      const decision = await store.getDecision("dc_old2");
      expect(decision?.entryState.snapshotVersion).toBe(4);
      expect(Object.keys(decision?.entryState.visualState.characters ?? {}).sort()).toEqual([
        "linche",
        "suyao",
      ]);
      expect(decision?.entryState.memoryDigest.beliefs[0]?.characterId).toBe("suyao");
      expect(decision?.entryState.memoryDigest.consolidationFailedIntervals).toEqual([]);
      expect(decision?.entryState.identity.rosterScopeId).toBe("world:game_fixture_v3");

      // 普通决策端点的 endState 由后继入口快照派生——同一条升级路径。
      const edges = await store.listEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0]?.endState).toEqual(decision?.entryState);

      // 兼容读取只在内存副本上完成：fixture 拷贝字节不变。
      expect(await dirFingerprint(gameDir)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("v3 fixture 无身份上下文：显式报错（不按某套身份猜读）", async () => {
    const { root } = await copyFixtureWorld();
    try {
      const store = new GameGraphStore(root, FIXTURE_GAME_ID);
      await expect(store.getDecision("dc_old2")).rejects.toThrow(/身份上下文/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([["snapshot-v1.json", "1"], ["snapshot-v2.json", "2"]] as const)(
    "v%s fixture：沿用读取即拒策略（不虚称兼容所有历史格式）",
    async (fixtureName, _version) => {
      const { root, gameDir } = await copyFixtureWorld();
      try {
        const raw = await readFile(path.join(M3_FIXTURES, fixtureName), "utf8");
        const target = path.join(gameDir, decisionSnapshotPath("dc_reject"));
        await writeFile(target, raw, "utf8");
        const store = new GameGraphStore(root, FIXTURE_GAME_ID, {
          identity: fixtureIdentityContext(),
        });
        const decisionIndex = {
          id: "dc_reject",
          sceneId: "sc_old1",
          form: { mode: "choice", prompt: "？", options: ["a"] },
        };
        await appendFile(
          path.join(gameDir, GAME_STORAGE_LAYOUT.decisions),
          `${JSON.stringify(decisionIndex)}\n`,
          "utf8",
        );
        await expect(store.getDecision("dc_reject")).rejects.toThrow(
          SnapshotVersionGateError,
        );
        await expect(store.getDecision("dc_reject")).rejects.toThrow(/读取即拒/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("roster blob：v4 写入按 revision 落盘一份（幂等），读取可还原", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m3blob-"));
    try {
      const roster = fixtureRoster();
      const context = fixtureIdentityContext({ roster: () => roster });
      const store = new GameGraphStore(root, "game_blob", { identity: context });
      await store.initialize();
      const identity = makeIdentity({
        rosterScopeId: roster.scopeId,
        rosterRevision: roster.revision,
      });
      await store.putDecision(
        makeDecision({ id: "dc_b1", entryState: makeSnapshot({ identity }) }),
      );
      await store.putDecision(
        makeDecision({ id: "dc_b2", entryState: makeSnapshot({ identity }) }),
      );

      const blobPath = path.join(
        root,
        "game_blob",
        rosterBlobPath(roster.revision),
      );
      expect(existsSync(blobPath)).toBe(true);
      expect(await store.getRosterBlob(roster.revision)).toEqual(roster);
      expect(await store.getRosterBlob("rev-none")).toBeNull();
      // 幂等：第二个决策不产生第二份 blob（同 revision 只落一次）。
      const rosterFiles = await readdir(path.join(root, "game_blob", GAME_STORAGE_LAYOUT.rostersDir));
      expect(rosterFiles).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("干净 v4 世界恢复：RestorePoint 不携带 migration（无发现零报告，干净读回无诊断噪音）", async () => {
    // M3 minor（V1 补测）：migration-on-findings 的另一半——干净 v4 读回
    // 必须 migration === undefined，而不是空报告对象（报告仅在出现
    // alias 升级或 unresolved 时携带；否则恢复方无从区分「干净」与
    // 「有发现但计数恰为零」）。
    const root = await mkdtemp(path.join(tmpdir(), "galgame-m3clean-"));
    try {
      const roster = fixtureRoster();
      const context = fixtureIdentityContext({ roster: () => roster });
      const store = new GameGraphStore(root, "game_v4clean", { identity: context });
      await store.initialize();
      const identity = makeIdentity({
        rosterScopeId: roster.scopeId,
        rosterRevision: roster.revision,
      });
      await store.putDecision(
        makeDecision({ id: "dc_clean", entryState: makeSnapshot({ identity }) }),
      );
      await store.putRun({
        id: "run_clean",
        origin: { kind: "root" },
        startedAt: "2026-09-01T10:00:00.000Z",
      });
      await store.saveCursor({ runId: "run_clean", position: "dc_clean" });

      const coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}v4c`, {
        identity: context,
      });
      const resume = await coordinator.restoreOrCreateRun();
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);
      expect(resume.restore.migration).toBeUndefined();
      expect(resume.restore.pathEvents).toEqual([]);
      expect(resume.restore.decision.id).toBe("dc_clean");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("旧边负载升级：恢复路径的对白补 characterId（内容摘要不变），migration 报告仅在发现异常时携带", async () => {
    const { root } = await copyFixtureWorld();
    try {
      const context = fixtureIdentityContext();
      const store = new GameGraphStore(root, FIXTURE_GAME_ID, { identity: context });
      const coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}m3a`, {
        identity: context,
      });
      const resume = await coordinator.restoreOrCreateRun();
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);

      // 旧对白（seq 2，speaker-only）升级：characterId 补齐 + 名牌快照。
      const dialogue = resume.restore.pathEvents.find((event) => event.seq === 2);
      expect(dialogue).toMatchObject({
        type: "dialogue",
        speaker: "苏遥",
        characterId: "suyao",
        displayLabel: "苏遥",
      });

      // 内容摘要与磁盘负载逐字节一致（升级只补身份，不改内容）。
      const rawPayload = await store.readPayload("eg_old1");
      expect(legacyEventContentSummary(resume.restore.pathEvents)).toBe(
        legacyEventContentSummary(rawPayload),
      );

      // migration-on-findings：alias 升级是发现 → 携带报告。
      expect(resume.restore.migration?.events.byCategory.alias_resolved).toBe(1);
      expect(resume.restore.migration?.events.unresolvedRefs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unresolved 旧对白：只读回放（不补 guessed ID），报告可数可诊断，恢复不中断", async () => {
    const { root, gameDir } = await copyFixtureWorld();
    try {
      // 在**拷贝**的旧负载尾追一条未登记说话人的旧对白（fixture 原件不动）：
      // 快照键可解析（图可升级），但这条台词无法唯一解析 → 只读回放。
      await appendFile(
        path.join(gameDir, edgePayloadPath("eg_old1")),
        `${JSON.stringify({
          seq: 5,
          turn: 1,
          timestamp: "2026-09-01T10:00:05.000Z",
          source: "model",
          type: "dialogue",
          speaker: "神秘转学生",
          text: "（角落里忽然有人开口……）",
          line_id: "line_old_5",
        })}
`,
        "utf8",
      );
      const context = fixtureIdentityContext();
      const store = new GameGraphStore(root, FIXTURE_GAME_ID, { identity: context });
      const coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}m3b`, {
        identity: context,
      });
      const resume = await coordinator.restoreOrCreateRun();
      if (resume.kind !== "active") throw new Error(`expected active, got ${resume.kind}`);
      const unresolved = resume.restore.pathEvents.find((event) => event.seq === 5);
      expect(unresolved).toMatchObject({ type: "dialogue", speaker: "神秘转学生" });
      expect(unresolved).not.toHaveProperty("characterId");
      expect(resume.restore.migration?.events.byCategory.alias_resolved).toBe(1);
      expect(resume.restore.migration?.events.byCategory.unresolved_unregistered).toBe(1);
      expect(resume.restore.migration?.events.unresolvedRefs).toEqual(["event:5"]);
      expect(resume.restore.migration?.events.unresolvedReasons[0]).toContain("只读回放");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("无法唯一 upcast 的图：恢复显式迁移错误，原图只读不改写（重开不伪装成功）", async () => {
    const { root, gameDir } = await copyFixtureWorld();
    try {
      const before = await dirFingerprint(gameDir);
      const ambiguous = fixtureIdentityContext({
        legacyMapping: {
          scope: { scopeId: "world:game_fixture_v3", schemaVersion: 1 },
          scriptNames: [
            { scriptName: "苏遥", characterId: "suyao" },
            { scriptName: "苏遥", characterId: "linche" },
            { scriptName: "林澈", characterId: "linche" },
          ],
        },
      });
      const store = new GameGraphStore(root, FIXTURE_GAME_ID, { identity: ambiguous });
      const coordinator = new RunGraphCoordinator(store, new FakeClock(), (p) => `${p}m3c`, {
        identity: ambiguous,
      });
      // 恢复显式失败（不是静默新局，也不是伪造的“成功继续”）。
      await expect(coordinator.restoreOrCreateRun()).rejects.toThrow(SnapshotUpcastError);
      await expect(coordinator.restoreOrCreateRun()).rejects.toThrow(/无法唯一升级/);
      // 原图只读：无任何文件被迁移改写；游标原样。
      expect(await dirFingerprint(gameDir)).toEqual(before);
      expect(await store.loadCursor()).toEqual({ runId: "run_old1", position: "dc_old2" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("旧 canon / 旧 voice-design fixture：宽容读取；动态声音不可用不阻止世界身份恢复", async () => {
    const { root } = await copyFixtureWorld();
    try {
      // 旧 canon（pre-M1，无 control 权威元信息）：宽容读取，roster 侧
      // 显式判 legacy（不猜测玩家/不掺 fallback cast）。
      const canonStore = new CanonStore(root, FIXTURE_GAME_ID);
      const canon = await canonStore.load();
      expect(canon.characters.map((character) => character.id)).toEqual(["su_yao", "lin_che"]);
      expect(canon.characters.every((character) => character.control === undefined)).toBe(true);
      expect(isRosterCapableCanon(canon)).toBe(false);

      // 旧 voice-design（v1 文件）：原样读取；roster 内无该绑定键的角色
      // （键不在 roster / 无 voiceProfileId）→ 合并视图静默降级为无声，
      // 身份（roster）不受影响——缺资源不丢身份。
      const voiceDesign = await new VoiceDesignStore(root, FIXTURE_GAME_ID).load();
      expect(voiceDesign?.version).toBe(1);
      const merged = mergeVoiceDesignViews({
        roster: fixtureRoster(),
        authorVoices: { version: 3, profiles: {} },
        designFile: voiceDesign,
        provider: "mock",
        dashscopeModelProfile: "cosyvoice_v3_flash",
        fallbackVoiceId: "",
      });
      expect(Object.keys(merged.characters)).toEqual([]); // roster 无绑定键 → 不注入
      expect(merged.designs["su_yao"]).toBeDefined(); // 画像索引保留（诊断可用）
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
