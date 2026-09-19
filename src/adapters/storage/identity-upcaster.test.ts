/**
 * F3 存储侧身份升级层测试（自校园线 identity-upcaster.test.ts 移植共用——
 * 事件升级链与诊断语义逐字对齐；校园版中围绕 RuntimeSnapshot 双轨的用例
 * 不适用于 main 的图快照，由 core/graph/snapshot-upcast.test.ts 承担对
 * 应覆盖）。
 *
 * 六类旧事件样本（每条带显式兼容预期，计划 §F3）：
 * (a) 已有正确 ID → 保持（identity_verified）；
 * (b) 只有唯一旧名字 → 唯一登记 legacy alias 命中（alias_resolved）；
 * (c) 化名与 ID 同时存在（且互相冲突）→ 已验证 ID 优先；
 * (d) 仅化名且无法唯一解析（同名多义）→ unresolved，只读回放；
 * (e) 未知 ID → 不因字符串存在就可信，unresolved，无跨世界兜底。
 *
 * 不变量：原事件/原载荷绝不修改；内容摘要迁移前后逐字节一致；unresolved
 * 台词绝不伪装 narrator、绝不强行归因。
 *
 * 本文件不含具体世界内容（roster/映射均为中性样本）。
 */
import { describe, it, expect } from "vitest";
import type { StoredEvent } from "../../schema.js";
import type { SnapshotRosterSnapshot } from "../../core/ports/identity-snapshot-port.js";
import { SNAPSHOT_DSL_PROTOCOL_VERSION, SNAPSHOT_IDENTITY_SCHEMA_VERSION } from "../../core/ports/identity-snapshot-port.js";
import type { LegacyIdentityMapping } from "../../core/characters/legacy-identity.js";
import {
  buildSnapshotIdentityEnvelope,
  IdentityUpcastScopeMismatchError,
  legacyEventContentSummary,
  noLegacyEventMigration,
  parseSnapshotRoster,
  CorruptV2SnapshotError,
  upcastLegacyEvents,
  type LegacyUpcastContext,
} from "./identity-upcaster.js";

// ---------------------------------------------------------------------------
// 中性样本作用域（roster + 显式登记的 legacy 映射）
// ---------------------------------------------------------------------------

const ROSTER: SnapshotRosterSnapshot = {
  scopeId: "test-world",
  revision: "rev-test-1",
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
      id: "female_A",
      name: "甲同学",
      control: "npc",
      initialLabel: "甲同学",
      persona: "测试角色甲。",
    },
    {
      id: "male_A",
      name: "乙同学",
      control: "npc",
      initialLabel: "乙同学",
      persona: "测试角色乙。",
    },
  ],
};

/**
 * "神秘同学" 故意登记到两个 ID：同名多义必须报 ambiguous（C2 语义），
 * 不许任选其一；"路过的第三人" 不登记：不许按文本猜。
 */
const MAPPING: LegacyIdentityMapping = {
  scope: { scopeId: "test-world", schemaVersion: 1 },
  scriptNames: [
    { scriptName: "甲同学", characterId: "female_A" },
    { scriptName: "乙同学", characterId: "male_A" },
    { scriptName: "神秘同学", characterId: "female_A" },
    { scriptName: "神秘同学", characterId: "male_A" },
  ],
};

const CONTEXT: LegacyUpcastContext = { roster: ROSTER, legacyMapping: MAPPING };

// ---------------------------------------------------------------------------
// 旧事件样本（seq 连续；期望写在每条样本上）
// ---------------------------------------------------------------------------

function dialogueEvent(fields: {
  seq: number;
  speaker: string;
  text: string;
  characterId?: string;
}): StoredEvent {
  return {
    seq: fields.seq,
    turn: 1,
    timestamp: "2026-09-18T00:00:00.000Z",
    source: "model",
    type: "dialogue",
    speaker: fields.speaker,
    text: fields.text,
    line_id: `line-${fields.seq}`,
    ...(fields.characterId !== undefined ? { characterId: fields.characterId } : {}),
  } as StoredEvent;
}

const SAMPLES = [
  {
    id: "(a) 已有正确 ID",
    event: dialogueEvent({ seq: 1, speaker: "甲同学", text: "带 ID 的台词。", characterId: "female_A" }),
    expectation: "identity_verified：当前作用域 roster 内的已验证 ID 原样保持，displayLabel 补名牌快照。",
  },
  {
    id: "(b) 只有唯一旧名字",
    event: dialogueEvent({ seq: 2, speaker: "乙同学", text: "只有旧名字的台词。" }),
    expectation: "alias_resolved：唯一登记的 legacy alias 命中 → male_A；speaker 不改写。",
  },
  {
    id: "(c) 化名与 ID 同时存在（冲突）",
    event: dialogueEvent({ seq: 3, speaker: "甲同学", text: "化名与 ID 冲突。", characterId: "male_A" }),
    expectation: "identity_verified：已验证 ID 优先于名字解析 → male_A；名牌快照仍是「甲同学」。",
  },
  {
    id: "(d) 仅化名无法唯一解析",
    event: dialogueEvent({ seq: 4, speaker: "神秘同学", text: "同名多义的台词。" }),
    expectation: "unresolved_ambiguous：原引用返回（只读回放），不补 characterId，绝不任选候选。",
  },
  {
    id: "(e) 未知 ID",
    event: dialogueEvent({ seq: 5, speaker: "路过的第三人", text: "陌生 ID 的台词。", characterId: "stranger_x" }),
    expectation: "unresolved_unknown_id：ID 字符串存在不等于可信，不做跨世界同名兜底。",
  },
] as const;

function nonDialogue(seq: number): StoredEvent {
  return {
    seq,
    turn: 1,
    timestamp: "2026-09-18T00:00:00.000Z",
    source: "model",
    type: "narration",
    text: `旁白 ${seq}。`,
    line_id: `line-${seq}`,
  } as StoredEvent;
}

// ---------------------------------------------------------------------------
// 事件升级：优先级链与六类样本
// ---------------------------------------------------------------------------

describe("upcastLegacyEvents — 旧事件六类样本（R24/R25 共用向量）", () => {
  it("每类样本得到其显式兼容预期（计数 + 逐条断言）", () => {
    const originals = [...SAMPLES.map((s) => s.event), nonDialogue(6)];
    const frozen = originals.map((event) => structuredClone(event));
    const { events, diagnostics } = upcastLegacyEvents(originals, CONTEXT);

    // 计数可诊断：每类各 1，非对白 1。
    expect(diagnostics.totalEvents).toBe(6);
    expect(diagnostics.dialogueEvents).toBe(5);
    expect(diagnostics.byCategory).toEqual({
      identity_verified: 2, // (a) + (c)
      alias_resolved: 1,    // (b)
      unresolved_ambiguous: 1, // (d)
      unresolved_unknown_id: 1, // (e)
      unresolved_unregistered: 0,
      non_model_dialogue_untouched: 1,
    });

    // (a) 正确 ID 保持 + displayLabel 补齐。
    expect(events[0]).toMatchObject({
      type: "dialogue",
      characterId: "female_A",
      speaker: "甲同学",
      displayLabel: "甲同学",
      text: "带 ID 的台词。",
    });
    // (b) 唯一旧名字 → 唯一登记 alias。
    expect(events[1]).toMatchObject({ characterId: "male_A", speaker: "乙同学" });
    // (c) ID 优先于化名；名牌快照保留。
    expect(events[2]).toMatchObject({ characterId: "male_A", speaker: "甲同学", displayLabel: "甲同学" });
    // (d) 同名多义：原引用只读回放，不补 ID、不改类型（不伪装 narrator）。
    expect(events[3]).toBe(originals[3]);
    expect(events[3]).not.toHaveProperty("characterId");
    expect(events[3]!.type).toBe("dialogue");
    // (e) 未知 ID：原引用返回，绝不因字符串存在而信任。
    expect(events[4]).toBe(originals[4]);
    expect((events[4] as { characterId?: string }).characterId).toBe("stranger_x"); // 原字段原样保留（不清洗、不升级）
    // 非对白透传。
    expect(events[5]).toBe(originals[5]);

    // unresolved 引用与诊断同序可数。
    expect(diagnostics.unresolvedRefs).toEqual(["event:4", "event:5"]);
    expect(diagnostics.unresolvedReasons).toHaveLength(2);
    expect(diagnostics.unresolvedReasons[0]).toContain("2 个候选");
    expect(diagnostics.unresolvedReasons[1]).toContain("stranger_x");
    expect(diagnostics.unresolvedReasons[1]).toContain("不跨世界同名兜底");

    // 原事件绝不修改（deep-equal 冻结副本）。
    expect(originals).toEqual(frozen);
  });

  it("内容摘要迁移前后逐字节一致（升级只补身份，不改内容）", () => {
    const originals = [...SAMPLES.map((s) => s.event), nonDialogue(6)];
    const before = legacyEventContentSummary(originals);
    const { events } = upcastLegacyEvents(structuredClone(originals), CONTEXT);
    const after = legacyEventContentSummary(events);
    expect(after).toBe(before);
  });

  it("未登记名字（无 ID）→ unresolved_unregistered，不猜", () => {
    const event = dialogueEvent({ seq: 9, speaker: "路过的第三人", text: "完全陌生。" });
    const { events, diagnostics } = upcastLegacyEvents([event], CONTEXT);
    expect(events[0]).toBe(event);
    expect(diagnostics.byCategory.unresolved_unregistered).toBe(1);
    expect(diagnostics.unresolvedReasons[0]).toContain("没有");
  });

  it("优先级链：不可信 ID 回落唯一登记 alias（链第 2 步）", () => {
    const event = dialogueEvent({
      seq: 10,
      speaker: "乙同学",
      text: "ID 陌生但名字唯一登记。",
      characterId: "stranger_x",
    });
    const { events, diagnostics } = upcastLegacyEvents([event], CONTEXT);
    expect(events[0]).toMatchObject({ characterId: "male_A", speaker: "乙同学" });
    expect(diagnostics.byCategory.alias_resolved).toBe(1);
  });

  it("跨世界映射直接拒绝（scope 不一致抛错，不做同名兜底）", () => {
    const foreignMapping: LegacyIdentityMapping = {
      ...MAPPING,
      scope: { scopeId: "another-world", schemaVersion: 1 },
    };
    expect(() =>
      upcastLegacyEvents([], { roster: ROSTER, legacyMapping: foreignMapping }),
    ).toThrowError(IdentityUpcastScopeMismatchError);
  });
});

// ---------------------------------------------------------------------------
// 零迁移报告与信封构造（migration-on-findings 的拼装件）
// ---------------------------------------------------------------------------

describe("noLegacyEventMigration / buildSnapshotIdentityEnvelope", () => {
  it("零迁移报告：六类计数恒 0，totalEvents 记录读回规模", () => {
    const report = noLegacyEventMigration(7);
    expect(report).toEqual({
      totalEvents: 7,
      dialogueEvents: 0,
      byCategory: {
        identity_verified: 0,
        alias_resolved: 0,
        unresolved_ambiguous: 0,
        unresolved_unknown_id: 0,
        unresolved_unregistered: 0,
        non_model_dialogue_untouched: 0,
      },
      unresolvedRefs: [],
      unresolvedReasons: [],
    });
  });

  it("信封由 roster + 名牌构造（浅拷贝，不共享可变引用）", () => {
    const labels = { female_A: "化名·甲" };
    const envelope = buildSnapshotIdentityEnvelope(ROSTER, labels);
    expect(envelope.identitySchemaVersion).toBe(SNAPSHOT_IDENTITY_SCHEMA_VERSION);
    expect(envelope.dslProtocolVersion).toBe(SNAPSHOT_DSL_PROTOCOL_VERSION);
    expect(envelope.roster.scopeId).toBe("test-world");
    expect(envelope.characterLabels).toEqual({ female_A: "化名·甲" });
    expect(envelope.characterLabels).not.toBe(labels);
  });

  it("parseSnapshotRoster：roster 快照损坏 → 拒绝解析（身份不可恢复）", () => {
    expect(parseSnapshotRoster(ROSTER)).toEqual(ROSTER);
    expect(() => parseSnapshotRoster({ scopeId: "test-world" })).toThrowError(
      CorruptV2SnapshotError,
    );
  });
});
