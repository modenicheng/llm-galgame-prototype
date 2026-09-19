/**
 * v3 → v4 快照升级适配器测试（M3）：版本闸门（v1/v2 拒、未来版本拒）、
 * 身份键转换面（visualState 键 / belief characterId / fact scope.characters）、
 * digest 缺省补齐与身份块挂载、无法唯一解析 → 整档拒绝（原载荷不动）。
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { LegacyIdentityMapping } from "../characters/legacy-identity.js";
import type { SnapshotRosterSnapshot } from "../ports/identity-snapshot-port.js";
import { SNAPSHOT_IDENTITY_SCHEMA_VERSION } from "../ports/identity-snapshot-port.js";
import {
  assertSupportedSnapshotVersion,
  buildSnapshotIdentityState,
  readSnapshotVersion,
  SnapshotUpcastError,
  SnapshotVersionGateError,
  upcastSnapshotV3ToV4,
  SnapshotUpcastContext,
} from "./snapshot-upcast.js";
import { StateSnapshotSchema } from "./types.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../adapters/storage/fixtures/m3",
);

const ROSTER: SnapshotRosterSnapshot = {
  scopeId: "world:game_fixture_v3",
  revision: "rev-fixture-1",
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
};

const MAPPING: LegacyIdentityMapping = {
  scope: { scopeId: "world:game_fixture_v3", schemaVersion: 1 },
  scriptNames: [
    { scriptName: "苏遥", characterId: "suyao" },
    { scriptName: "林澈", characterId: "linche" },
  ],
};

const CONTEXT: SnapshotUpcastContext = {
  roster: ROSTER,
  dslProtocolVersion: 1,
  legacyMapping: MAPPING,
};

async function readFixtureSnapshot(name: string): Promise<unknown> {
  const raw = await readFile(
    path.join(FIXTURES, "graph-v3", "graph", "snapshots", name),
    "utf8",
  );
  return JSON.parse(raw);
}

describe("版本闸门（沿用 v1/v2 拒绝策略，不虚称兼容）", () => {
  it("readSnapshotVersion 读出自报版本；缺失为 undefined", () => {
    expect(readSnapshotVersion({ snapshotVersion: 3 })).toBe(3);
    expect(readSnapshotVersion({ snapshotVersion: "x" })).toBeUndefined();
    expect(readSnapshotVersion({})).toBeUndefined();
    expect(readSnapshotVersion(null)).toBeUndefined();
  });

  it.each([1, 2])("v%s 按既定策略读取即拒（dev 存档废弃，不做迁移）", (version) => {
    expect(() => assertSupportedSnapshotVersion(version)).toThrowError(
      SnapshotVersionGateError,
    );
    try {
      assertSupportedSnapshotVersion(version);
    } catch (error) {
      expect((error as SnapshotVersionGateError).foundVersion).toBe(version);
      expect((error as SnapshotVersionGateError).message).toContain("读取即拒");
    }
  });

  it("未来版本（v5）同样显式拒绝，不降级解析", () => {
    expect(() => assertSupportedSnapshotVersion(5)).toThrowError(/高于本程序支持/);
  });

  it("v3/v4 放行", () => {
    expect(() => assertSupportedSnapshotVersion(3)).not.toThrow();
    expect(() => assertSupportedSnapshotVersion(4)).not.toThrow();
  });
});

describe("upcastSnapshotV3ToV4 — fixture v3 快照升级", () => {
  it("v3 → v4：visualState 键/belief/fact 引用映射到稳定 ID，digest 补 []，身份块挂载", async () => {
    const payload = await readFixtureSnapshot("dc_old2.json");
    const frozen = structuredClone(payload);
    const snapshot = upcastSnapshotV3ToV4(payload, CONTEXT);

    // 原载荷对象不动（内存副本升级）。
    expect(payload).toEqual(frozen);

    // 版本 + 契约 schema 复核通过。
    expect(snapshot.snapshotVersion).toBe(4);
    expect(StateSnapshotSchema.safeParse(snapshot).success).toBe(true);

    // ① visualState 键：scriptName → 稳定 ID。
    expect(Object.keys(snapshot.visualState.characters).sort()).toEqual(["linche", "suyao"]);
    expect(snapshot.visualState.characters.suyao?.variant).toBe("wary");

    // ② belief characterId 映射；③ fact scope.characters 映射。
    expect(snapshot.memoryDigest.beliefs[0]?.characterId).toBe("suyao");
    expect([...(snapshot.memoryDigest.facts[0]?.scope?.characters ?? [])].sort()).toEqual([
      "linche",
      "suyao",
    ]);

    // digest 缺省补 []（v3 内该字段可选追加）。
    expect(snapshot.memoryDigest.consolidationFailedIntervals).toEqual([]);

    // 身份块：升级目标 = 当前 roster + 协议版本；名牌为空（v3 没有名牌状态）。
    expect(snapshot.identity).toEqual({
      identitySchemaVersion: SNAPSHOT_IDENTITY_SCHEMA_VERSION,
      dslProtocolVersion: 1,
      rosterScopeId: "world:game_fixture_v3",
      rosterRevision: "rev-fixture-1",
      characterLabels: {},
      cast: {
        allowedSpeakerIds: ["suyao", "linche"],
        sceneParticipantIds: ["player", "suyao", "linche"],
      },
    });
  });

  it("roster 内稳定 ID 键原样保留（不要求旧数据全是旧名字）", async () => {
    const payload = await readFixtureSnapshot("dc_old1.json");
    const withIds = structuredClone(payload) as {
      visualState: { characters: Record<string, unknown> };
      memoryDigest: { beliefs: unknown[] };
    };
    withIds.visualState.characters = {
      suyao: withIds.visualState.characters["苏遥"]!,
      林澈: withIds.visualState.characters["林澈"]!,
    };
    delete withIds.visualState.characters["苏遥"];
    const snapshot = upcastSnapshotV3ToV4(withIds, CONTEXT);
    expect(Object.keys(snapshot.visualState.characters).sort()).toEqual([
      "linche",
      "suyao",
    ]);
  });

  it("无法唯一解析（无映射的旧名字）→ 整档拒绝并携带全部引用；原载荷不动", async () => {
    const payload = await readFixtureSnapshot("dc_old2.json");
    const frozen = structuredClone(payload);
    try {
      upcastSnapshotV3ToV4(payload, {
        roster: ROSTER,
        dslProtocolVersion: 1,
        // 不登记 legacy 映射：旧名字不可解析。
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotUpcastError);
      const upcastError = error as SnapshotUpcastError;
      expect(upcastError.refs).toContain("visualState:林澈");
      expect(upcastError.refs).toContain("visualState:苏遥");
      expect(upcastError.refs).toContain("belief:belief_old_1:苏遥");
      expect(upcastError.refs).toContain("fact:fact_old_1:林澈");
      expect(upcastError.message).toContain("只读回放");
    }
    expect(payload).toEqual(frozen);
  });

  it("同名多义映射 → ambiguous 整档拒绝，不许任选其一", async () => {
    const payload = await readFixtureSnapshot("dc_old1.json");
    const ambiguous: LegacyIdentityMapping = {
      scope: { scopeId: "world:game_fixture_v3", schemaVersion: 1 },
      scriptNames: [
        { scriptName: "苏遥", characterId: "suyao" },
        { scriptName: "苏遥", characterId: "linche" },
        { scriptName: "林澈", characterId: "linche" },
      ],
    };
    expect(() =>
      upcastSnapshotV3ToV4(payload, {
        roster: ROSTER,
        dslProtocolVersion: 1,
        legacyMapping: ambiguous,
      }),
    ).toThrowError(SnapshotUpcastError);
  });

  it("跨世界映射 → scope 不一致拒绝", async () => {
    const payload = await readFixtureSnapshot("dc_old1.json");
    expect(() =>
      upcastSnapshotV3ToV4(payload, {
        roster: ROSTER,
        dslProtocolVersion: 1,
        legacyMapping: {
          ...MAPPING,
          scope: { scopeId: "another:world", schemaVersion: 1 },
        },
      }),
    ).toThrowError(/scopeId/);
  });

  it("v3 结构损坏（字段缺失）→ zod 大声失败（沿用结构损坏语义）", async () => {
    const payload = await readFixtureSnapshot("dc_old1.json");
    const broken = structuredClone(payload) as Record<string, unknown>;
    delete broken.memoryDigest;
    expect(() => upcastSnapshotV3ToV4(broken, CONTEXT)).toThrowError();
  });
});

describe("buildSnapshotIdentityState", () => {
  it("cast：NPC = 允许说话人，全体 = 场景参与者；名牌浅拷贝", () => {
    const labels = { suyao: "海边的她" };
    const identity = buildSnapshotIdentityState({
      roster: ROSTER,
      dslProtocolVersion: 2,
      characterLabels: labels,
    });
    expect(identity).toEqual({
      identitySchemaVersion: SNAPSHOT_IDENTITY_SCHEMA_VERSION,
      dslProtocolVersion: 2,
      rosterScopeId: "world:game_fixture_v3",
      rosterRevision: "rev-fixture-1",
      characterLabels: { suyao: "海边的她" },
      cast: {
        allowedSpeakerIds: ["suyao", "linche"],
        sceneParticipantIds: ["player", "suyao", "linche"],
      },
    });
    expect(identity.characterLabels).not.toBe(labels);
  });
});
