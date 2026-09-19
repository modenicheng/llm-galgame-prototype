/**
 * C5 §5.1 三个 projection 入口的单元测试（identity-stable event projection）。
 *
 * 覆盖：
 * - ProjectedEvent 形状（eventRef/seq/type/source/characterId/displayLabel）；
 * - 已提交 = event:<seq>，未提交预取 = attempt:<id>:<index>（seq 只属已提交）；
 * - dialogue/player_dialogue 必有 characterId；其他事件不伪造；
 * - 改名后 ID 稳定（投影不按今天的名字重解析昨天的名牌）；
 * - 旧事件身份不可判定 → unresolved_legacy_dialogue（保文本 + 原名牌，
 *   不作 @say 示例或记忆更新依据）；两角色同名 → 不猜；
 * - 动态英文角色 ID（main 向量）经 registry 解析回同一身份；
 * - player_input / player_dialogue 同一交互的两个视图按 interaction_id
 *   关联去重；去重不改原事件审计记录；
 * - memory evidence 只接受有真实 seq 的已提交事件，且排除
 *   unresolved_legacy_dialogue；
 * - renderProjectedEvents 逐行 JSON（JSONL），无 `名牌: 台词` 可误解析格式。
 */
import { describe, it, expect } from "vitest";
import type { AssetCatalog } from "../core/assets/types.js";
import type { CharacterDefinition } from "../core/characters/types.js";
import { buildCharacterRoster, createCharacterRegistry } from "../core/characters/registry.js";
import type { CharacterRegistry } from "../core/characters/types.js";
import type { StoredEvent, StoryContextEvent } from "../schema.js";
import {
  projectWriterHistory,
  projectMemoryEvidence,
  projectRecapSource,
  renderProjectedEvents,
} from "./event-projection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSETS: AssetCatalog = {
  guidance: "测试目录",
  backgrounds: {},
  bgm: {},
  soundEffects: {},
  spriteSets: {
    female_A: {
      id: "female_A",
      variants: { base: { id: "base", src: "a.png", description: "" } },
    },
    female_B: {
      id: "female_B",
      variants: { base: { id: "base", src: "b.png", description: "" } },
    },
  },
};

function rosterDef(): CharacterDefinition[] {
  return [
    {
      id: "player_one",
      name: "玩家",
      control: "player",
      initialLabel: "你",
      persona: "玩家本人。",
    },
    {
      id: "female_A",
      name: "许晚晴",
      control: "npc",
      initialLabel: "神秘女子",
      persona: "温柔学姐。",
      presentation: {
        defaultLook: "base",
        defaultPosition: "right",
        looks: { base: { spriteSet: "female_A", variant: "base" } },
      },
    },
    {
      // 与 female_B 同名：legacy 解析必须拒绝二义。
      id: "female_B",
      name: "林小满",
      control: "npc",
      initialLabel: "林小满",
      persona: "活泼同级生。",
      presentation: {
        defaultLook: "base",
        defaultPosition: "left",
        looks: { base: { spriteSet: "female_B", variant: "base" } },
      },
    },
    {
      id: "female_B2",
      name: "林小满",
      control: "npc",
      initialLabel: "小满（妹妹）",
      persona: "同名妹妹。",
    },
    {
      // main 动态英文角色：无立绘、无音色，身份不丢。
      id: "guest_01",
      name: "Guest",
      control: "npc",
      initialLabel: "Guest",
      persona: "动态来客。",
    },
  ];
}

function makeRegistry(): CharacterRegistry {
  const roster = buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "c5-projection-test",
    playerId: "player_one",
    characters: rosterDef(),
  });
  return createCharacterRegistry(roster, ASSETS);
}

/** 已提交的 v1 运行时形状对白（characterId 由编译层落在事件上）。 */
function storedDialogue(
  seq: number,
  characterId: string | undefined,
  speaker: string,
  text: string,
): StoredEvent {
  return {
    type: "dialogue",
    ...(characterId !== undefined ? { characterId } : {}),
    speaker,
    text,
    line_id: `line_${seq}`,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "model",
  };
}

function storedNarration(seq: number, text: string): StoredEvent {
  return {
    type: "narration",
    text,
    line_id: `line_${seq}`,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "model",
  };
}

function storedPlayerInput(seq: number, interactionId: string, text: string): StoredEvent {
  return {
    type: "player_input",
    interaction_id: interactionId,
    text,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "player",
  };
}

function storedPlayerDialogue(seq: number, interactionId: string, text: string): StoredEvent {
  return {
    type: "player_dialogue",
    interaction_id: interactionId,
    speaker: "你",
    text,
    line_id: `line_${seq}`,
    seq,
    turn: 1,
    timestamp: "2026-09-19T00:00:00.000Z",
    source: "player",
  };
}

// ---------------------------------------------------------------------------
// projectWriterHistory
// ---------------------------------------------------------------------------

describe("projectWriterHistory — 写手历史投影", () => {
  it("已提交对白携带 event:<seq> 引用、稳定 characterId 与发射时刻名牌", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedNarration(1, "夜色沉下来。"),
      storedDialogue(2, "female_A", "神秘女子", "借过的那支笔，我还留着。"),
    ];
    const projected = projectWriterHistory(events, registry);
    expect(projected).toHaveLength(2);
    expect(projected[1]).toMatchObject({
      eventRef: "event:2",
      seq: 2,
      type: "dialogue",
      source: "model",
      characterId: "female_A",
      displayLabel: "神秘女子",
      text: "借过的那支笔，我还留着。",
    });
  });

  it("R01：改名前后同一角色的投影都携带 female_A；渲染不出现 `神秘女子: 台词` 可误解析格式", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedDialogue(1, "female_A", "许晚晴", "原名台词。"),
      storedDialogue(2, "female_A", "神秘女子", "改名后台词。"),
    ];
    const projected = projectWriterHistory(events, registry);
    expect(projected.map((event) => event.characterId)).toEqual(["female_A", "female_A"]);
    // 名牌按事件快照保留（不用今天的名字重写昨天的名牌）。
    expect(projected.map((event) => event.displayLabel)).toEqual(["许晚晴", "神秘女子"]);

    const rendered = renderProjectedEvents(projected);
    expect(rendered).toContain("female_A");
    // 冒号行头格式（半角/全角）一律不得出现——模型不可模仿为新角色行头。
    expect(rendered).not.toMatch(/神秘女子[:：]/);
    expect(rendered).not.toMatch(/许晚晴[:：]/);
  });

  it("未提交预取事件用 attempt:<id>:<index> 引用且没有 seq", () => {
    const registry = makeRegistry();
    const uncommitted: StoryContextEvent[] = [
      {
        type: "dialogue",
        characterId: "female_A",
        speaker: "神秘女子",
        text: "预取分支台词。",
        line_id: "line_prefetch_1",
      },
      {
        type: "dialogue",
        characterId: "female_B",
        speaker: "林小满",
        text: "第二分支台词。",
        line_id: "line_prefetch_2",
      },
    ];
    const projected = projectWriterHistory(uncommitted, registry);
    expect(projected.map((event) => event.eventRef)).toEqual([
      "attempt:line_prefetch_1:0",
      "attempt:line_prefetch_2:0",
    ]);
    for (const event of projected) {
      expect(event.seq).toBeUndefined();
    }
  });

  it("legacy 对白（无 characterId）：唯一 initialLabel/ID 命中可解析；二义或无命中 → unresolved_legacy_dialogue", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedDialogue(1, undefined, "神秘女子", "初始名牌可唯一解析。"), // female_A initialLabel
      storedDialogue(2, undefined, "guest_01", "英文 ID 直写。"), // ID 命中（main 动态角色）
      storedDialogue(3, undefined, "林小满", "两角色同名，不可猜。"), // 二义
      storedDialogue(4, undefined, "陌生人", "完全未注册。"), // 无命中
    ];
    const projected = projectWriterHistory(events, registry);
    expect(projected[0]).toMatchObject({ type: "dialogue", characterId: "female_A" });
    expect(projected[1]).toMatchObject({ type: "dialogue", characterId: "guest_01" });
    // 二义/无命中 → 显式 unresolved：保文本 + 原名牌，绝不伪造 characterId。
    expect(projected[2]).toMatchObject({
      type: "unresolved_legacy_dialogue",
      displayLabel: "林小满",
      text: "两角色同名，不可猜。",
    });
    expect(projected[2]!.characterId).toBeUndefined();
    expect(projected[3]).toMatchObject({ type: "unresolved_legacy_dialogue", displayLabel: "陌生人" });
  });

  it("player_input 与 player_dialogue 是同一交互的两个视图：按 interaction_id 去重关联，不当重复发言", () => {
    const registry = makeRegistry();
    const input = storedPlayerInput(3, "itx_1", "我推开门。");
    const dialogue = storedPlayerDialogue(4, "itx_1", "我推开门。");
    const frozenInput = Object.freeze({ ...input });
    const frozenDialogue = Object.freeze({ ...dialogue });
    const events: StoredEvent[] = [
      storedDialogue(1, "female_A", "许晚晴", "门后有人。"),
      frozenInput,
      frozenDialogue,
    ];

    const projected = projectWriterHistory(events, registry);
    const playerEntries = projected.filter((event) => event.source === "player");
    expect(playerEntries).toHaveLength(1);
    expect(playerEntries[0]).toMatchObject({
      type: "player_dialogue",
      characterId: "player_one",
      interactionId: "itx_1",
      linkedEventRef: "event:3",
      text: "我推开门。",
    });

    // 去重不改原事件审计记录。
    expect(frozenInput).toEqual(input);
    expect(frozenDialogue).toEqual(dialogue);
  });

  it("没有对应 player_dialogue 的孤立 player_input 仍保留（带控制角色 ID 与 interaction_id）", () => {
    const registry = makeRegistry();
    const projected = projectWriterHistory([storedPlayerInput(1, "itx_9", "只有输入。")], registry);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      type: "player_input",
      source: "player",
      characterId: "player_one",
      interactionId: "itx_9",
    });
  });

  it("narration 不伪造 characterId；choice/end 机器记录被跳过", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedNarration(1, "旁白。"),
      {
        type: "choice",
        choice_id: "c1",
        text: "走",
        seq: 2,
        turn: 1,
        timestamp: "t",
        source: "player",
      } as unknown as StoredEvent,
    ];
    const projected = projectWriterHistory(events, registry);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: "narration", source: "model" });
    expect(projected[0]!.characterId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// projectMemoryEvidence
// ---------------------------------------------------------------------------

describe("projectMemoryEvidence — 记忆证据投影", () => {
  it("只接受有真实 seq 的已提交事件；每条带 seq/角色 ID/来源", () => {
    const registry = makeRegistry();
    const mixed = [
      storedDialogue(1, "female_A", "许晚晴", "已提交。"),
      {
        type: "dialogue",
        characterId: "female_A",
        speaker: "许晚晴",
        text: "未提交预取。",
        line_id: "line_p",
      },
    ] as StoredEvent[];
    const evidence = projectMemoryEvidence(mixed, registry);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      eventRef: "event:1",
      seq: 1,
      source: "model",
      characterId: "female_A",
    });
  });

  it("unresolved_legacy_dialogue 不进入记忆证据（不作人物记忆更新依据）", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedDialogue(1, undefined, "林小满", "二义旧事件。"),
      storedDialogue(2, "female_A", "许晚晴", "可归因事件。"),
    ];
    const evidence = projectMemoryEvidence(events, registry);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.characterId).toBe("female_A");
  });

  it("玩家交互合并为单条证据视图（说话人 = 控制角色）", () => {
    const registry = makeRegistry();
    const evidence = projectMemoryEvidence(
      [storedPlayerInput(1, "itx_1", "我答应了她。"), storedPlayerDialogue(2, "itx_1", "我答应了她。")],
      registry,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      type: "player_dialogue",
      characterId: "player_one",
      source: "player",
      seq: 2,
      linkedEventRef: "event:1",
    });
  });
});

// ---------------------------------------------------------------------------
// projectRecapSource
// ---------------------------------------------------------------------------

describe("projectRecapSource — 前情梗概源投影", () => {
  it("已提交事件逐条投影；unresolved 旧记录保留（带标记，供压缩器如实记录）", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedDialogue(1, undefined, "陌生人", "很久以前的一句话。"),
      storedNarration(2, "雨停了。"),
    ];
    const source = projectRecapSource(events, registry);
    expect(source).toHaveLength(2);
    expect(source[0]).toMatchObject({ type: "unresolved_legacy_dialogue", displayLabel: "陌生人" });
    expect(source[1]).toMatchObject({ type: "narration" });
  });

  it("玩家交互合并为单条；interaction 提示保留（截断到 80 字）", () => {
    const registry = makeRegistry();
    const longPrompt = "很长的题干".repeat(40);
    const events: StoredEvent[] = [
      {
        type: "interaction",
        interaction_id: "itx_2",
        prompt: `  第一问\n  第二问  ${longPrompt}  `,
        mode: "choice",
        options: [
          { id: "a", text: "好" },
          { id: "b", text: "不" },
        ],
        seq: 1,
        turn: 1,
        timestamp: "t",
        source: "model",
      },
      storedPlayerInput(2, "itx_3", "输入。"),
      storedPlayerDialogue(3, "itx_3", "输入。"),
    ];
    const source = projectRecapSource(events, registry);
    expect(source).toHaveLength(2);
    expect(source[0]).toMatchObject({ type: "interaction", interactionId: "itx_2" });
    expect(source[0]!.text).toHaveLength(80 + 1); // 80 + 省略号
    expect(source[0]!.text!.endsWith("…")).toBe(true);
    expect(source[1]).toMatchObject({ type: "player_dialogue", interactionId: "itx_3" });
  });
});

// ---------------------------------------------------------------------------
// renderProjectedEvents
// ---------------------------------------------------------------------------

describe("renderProjectedEvents — JSONL 渲染", () => {
  it("每行都是可解析 JSON；键序固定 eventRef 在首位；换行文本不破行", () => {
    const registry = makeRegistry();
    const events: StoredEvent[] = [
      storedNarration(1, "第一行\n第二行"),
      storedDialogue(2, "female_A", "神秘女子", "台词"),
    ];
    const rendered = renderProjectedEvents(projectWriterHistory(events, registry));
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines[0]!.startsWith('{"eventRef":"event:1"')).toBe(true);
    const dialogue = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(dialogue["characterId"]).toBe("female_A");
    expect(dialogue["displayLabel"]).toBe("神秘女子");
    expect(JSON.parse(lines[0]!)["text"]).toBe("第一行\n第二行");
  });
});
