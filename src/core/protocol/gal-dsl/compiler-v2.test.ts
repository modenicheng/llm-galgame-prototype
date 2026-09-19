/**
 * v2 compiler 语义测试（C4，计划 §4.2 状态表逐行 + §4.3 原子提交/预测隔离）。
 *
 * 覆盖：
 * - §4.2 每一行状态转移（hide 后发言仍 hidden、exit 保留 label、show 恢复
 *   默认 look、reset 不公开正式姓名）；
 * - @say 纯文本身份（未知 ID / 中文名冒充 ID / 玩家代言 / 超出 cast）；
 * - 组原子性（坏 look + 好改名同组 → 两者都不提交）；
 * - 预测状态隔离（编译永不污染已提交状态）；
 * - 冗余去重与 @se 永不去重；
 * - 结构化诊断（任务/attempt/行号/有界合法值）。
 */
import { describe, it, expect } from "vitest";
import type { AssetCatalog } from "../../assets/types.js";
import type {
  CharacterDefinition,
  CharacterRoster,
} from "../../characters/types.js";
import { buildCharacterRoster, createCharacterRegistry } from "../../characters/registry.js";
import { createCharacterRuntimeState } from "../../characters/types.js";
import { createVisualStateReducer } from "../../presentation/reducer.js";
import { createPresentationDefaultsFromRoster } from "../../presentation/defaults.js";
import { createInitialVisualState } from "../../presentation/defaults.js";
import type { VisualState } from "../../presentation/types.js";
import {
  compileEventGroupV2,
  compileSegmentV2,
} from "./compiler.js";
import type { EventGroupDraftV2 } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures（与 core/characters/registry.test.ts 同风格）
// ---------------------------------------------------------------------------

const ASSETS: AssetCatalog = {
  guidance: "测试目录",
  backgrounds: { basement: { id: "basement", src: "b.jpg", description: "地下室" } },
  bgm: { mystery: { id: "mystery", src: "m.mp3", description: "悬疑" } },
  soundEffects: { door_slam: { id: "door_slam", src: "d.mp3", description: "关门" } },
  spriteSets: {
    female_A: {
      id: "female_A",
      variants: {
        base: { id: "base", src: "a.png", description: "" },
        smile: { id: "smile", src: "a2.png", description: "" },
      },
    },
    female_B: {
      id: "female_B",
      variants: {
        base: { id: "base", src: "b.png", description: "" },
      },
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
      // 正式姓名 ≠ 初始名牌：reset 恢复 initialLabel（神秘女子），不是姓名。
      id: "female_A",
      name: "许晚晴",
      control: "npc",
      initialLabel: "神秘女子",
      persona: "温柔学姐。",
      presentation: {
        defaultLook: "base",
        defaultPosition: "right",
        looks: {
          base: { spriteSet: "female_A", variant: "base" },
          smile: { spriteSet: "female_A", variant: "smile" },
        },
      },
    },
    {
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
      // 无立绘 NPC：合法说话/改名，@ch 必须报 CHARACTER_HAS_NO_PRESENTATION。
      id: "phone_voice",
      name: "电话里的声音",
      control: "npc",
      initialLabel: "？？？",
      persona: "画外角色。",
    },
  ];
}

function makeRoster(): CharacterRoster {
  return buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "c4-test",
    playerId: "player_one",
    characters: rosterDef(),
  });
}

const CAST = {
  allowedSpeakerIds: ["female_A", "female_B", "phone_voice"],
  sceneParticipantIds: ["player_one", "female_A", "female_B", "phone_voice"],
};

function makeHarness() {
  const roster = makeRoster();
  const registry = createCharacterRegistry(roster, ASSETS);
  const reduce = createVisualStateReducer(createPresentationDefaultsFromRoster(registry));
  return { roster, registry, reduce };
}

function segmentOptions(overrides?: Partial<Parameters<typeof compileSegmentV2>[0]>) {
  const { registry, reduce } = makeHarness();
  return {
    expectedNonce: "81ab",
    task: "continuation" as const,
    registry,
    cast: CAST,
    reduce,
    visualState: createInitialVisualState(),
    characterState: createCharacterRuntimeState(),
    catalog: ASSETS,
    ...overrides,
  };
}

function compile(text: string, overrides?: Partial<Parameters<typeof compileSegmentV2>[0]>) {
  return compileSegmentV2({ ...segmentOptions(overrides), text });
}

function groupOf(prelude: EventGroupDraftV2["prelude"], main: EventGroupDraftV2["main"]): EventGroupDraftV2 {
  return { prelude, main };
}

// ---------------------------------------------------------------------------
// §4.2 状态表逐行
// ---------------------------------------------------------------------------

describe("compileSegmentV2 — §4.2 状态表", () => {
  it("@say：允许的 NPC 用当时 label 快照；不自动登台、不自动显示、不换表情", () => {
    const result = compile(
      [
        "@ch female_A set look=smile",
        "@name female_A set 夜晚的声音",
        "@say female_A 我在暗处说话。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ch set 初始化为隐藏 → 台词不隐式显示：say 后角色仍在台上但 hidden。
    const stage = result.visualState.characters["female_A"]!;
    expect(stage.visible).toBe(false);
    expect(stage.variant).toBe("smile"); // ch set 应用的 look，say 不改表情
    const main = result.groups[0]!.main;
    expect(main).toEqual({
      type: "dialogue",
      characterId: "female_A",
      displayLabel: "夜晚的声音",
      text: "我在暗处说话。",
    });
    // 台词不生成任何 presentation side-effect（无 cue patch）。
    expect(result.groups[0]!.prelude).toHaveLength(1); // 仅 ch set 的 patch
  });

  it("hide 后发言仍 hidden（画外对白合法，无自动登台兜底）", () => {
    const result = compile(
      [
        "@ch female_A show",
        "@ch female_A hide",
        "@say female_A 我已经退到幕后了。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_A"]!.visible).toBe(false);
    expect(result.groups[0]!.main.type).toBe("dialogue");
  });

  it("@name set：设置 label，不触碰外观/位置/可见性；无立绘角色合法", () => {
    const result = compile(
      [
        "@ch female_A show look=smile",
        "@name female_A set 夜巡者",
        "@name phone_voice set 电话那头的人",
        "@say female_A 收到了。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.characterState.labels["female_A"]).toBe("夜巡者");
    expect(result.characterState.labels["phone_voice"]).toBe("电话那头的人");
    const stage = result.visualState.characters["female_A"]!;
    expect(stage.variant).toBe("smile"); // 外观未被触碰
    expect(stage.visible).toBe(true);
    // 无立绘角色没有产生任何舞台条目/伪 sprite。
    expect(result.visualState.characters["phone_voice"]).toBeUndefined();
    // 名牌快照跟随后续 say。
    const main = result.groups[0]!.main;
    expect(main.type === "dialogue" && main.displayLabel).toBe("夜巡者");
  });

  it("@name reset：恢复 initialLabel，不是强行公开正式姓名", () => {
    const result = compile(
      [
        "@name female_A set 夜巡者",
        "@name female_A reset",
        "@say female_A 现在可以看了。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.characterState.labels["female_A"]).toBeUndefined();
    const main = result.groups[0]!.main;
    expect(main.type === "dialogue" && main.displayLabel).toBe("神秘女子"); // initialLabel，不是 许晚晴
  });

  it("@ch show（不存在）：按默认 look/position 初始化并显示", () => {
    const result = compile(
      ["@ch female_A show", "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.visualState.characters["female_A"]!;
    expect(entry.visible).toBe(true);
    expect(entry.spriteSet).toBe("female_A");
    expect(entry.variant).toBe("base");
    expect(entry.position).toBe("right");
  });

  it("@ch show（存在）：保持原 look/position，应用显式参数后显示", () => {
    const first = compile(
      ["@ch female_A show look=smile position=left", "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(first.ok).toBe(true);
    const second = compile(
      ["@ch female_A hide", "@ch female_A show", "@say female_A 回来了。", "@end 81ab buffer"].join("\n"),
      // first.ok 已由上方 expect 钉死；这里窄化给 exactOptionalPropertyTypes。
      { visualState: first.ok ? first.visualState : createInitialVisualState() },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const entry = second.visualState.characters["female_A"]!;
    expect(entry.visible).toBe(true);
    expect(entry.variant).toBe("smile"); // 原 look 保持
    expect(entry.position).toBe("left"); // 原 position 保持
  });

  it("@ch set（不存在）：初始化为隐藏并应用字段，不隐式显示", () => {
    const result = compile(
      ["@ch female_A set look=smile", "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.visualState.characters["female_A"]!;
    expect(entry.visible).toBe(false);
    expect(entry.variant).toBe("smile");
  });

  it("@ch set（存在）：应用字段，可见性不变（隐藏的保持隐藏）", () => {
    const result = compile(
      [
        "@ch female_A show",
        "@ch female_A hide",
        "@ch female_A set look=smile",
        "@beat",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.visualState.characters["female_A"]!;
    expect(entry.visible).toBe(false);
    expect(entry.variant).toBe("smile");
  });

  it("@ch hide（不存在）：no-op（不建条目、不产生诊断）", () => {
    const result = compile(["@ch female_B hide", "@end 81ab buffer"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_B"]).toBeUndefined();
    expect(result.assetDiagnostics).toEqual([]);
  });

  it("@ch hide（存在）：visible=false，身份/名牌/记忆保留", () => {
    const result = compile(
      [
        "@ch female_A show",
        "@name female_A set 夜巡者",
        "@ch female_A hide",
        "@beat",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_A"]!.visible).toBe(false);
    expect(result.characterState.labels["female_A"]).toBe("夜巡者");
  });

  it("@ch exit：移除立绘条目；名牌与身份保留；重返用默认外观", () => {
    const first = compile(
      [
        "@ch female_A show look=smile",
        "@name female_A set 夜巡者",
        "@ch female_A exit",
        "@beat",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.visualState.characters["female_A"]).toBeUndefined();
    expect(first.characterState.labels["female_A"]).toBe("夜巡者"); // 退场 ≠ 忘记化名
    // 重返：默认外观（不是 smile）。
    const second = compile(
      ["@ch female_A show", "@beat", "@end 81ab buffer"].join("\n"),
      {
        visualState: first.visualState,
        characterState: first.characterState,
      },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const entry = second.visualState.characters["female_A"]!;
    expect(entry.variant).toBe("base");
    expect(entry.visible).toBe(true);
    // 名牌在重返后仍然保留。
    expect(second.characterState.labels["female_A"]).toBe("夜巡者");
  });

  it("@ch reset：恢复默认 look/position，保留 visibility；不存在时 no-op", () => {
    const result = compile(
      [
        "@ch female_A show look=smile position=left",
        "@ch female_A hide",
        "@ch female_A reset",
        "@ch female_B reset",
        "@beat",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.visualState.characters["female_A"]!;
    expect(entry.variant).toBe("base"); // 默认 look
    expect(entry.position).toBe("right"); // 默认 position
    expect(entry.visible).toBe(false); // visibility 保留
    expect(result.visualState.characters["female_B"]).toBeUndefined(); // no-op
  });

  it("无 presentation 的角色用 @ch → CHARACTER_HAS_NO_PRESENTATION；@say/@name 仍合法", () => {
    const bad = compile(
      ["@ch phone_voice show", "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics[0]!.code).toBe("CHARACTER_HAS_NO_PRESENTATION");
    expect(bad.diagnostics[0]!.task).toBe("continuation");
    expect(bad.diagnostics[0]!.attempt).toBe("attempt:0");
    expect(bad.diagnostics[0]!.line).toBe(1);

    const good = compile(
      [
        "@name phone_voice set 电话那头",
        "@say phone_voice 喂？听得见吗？",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(good.ok).toBe(true);
  });

  it("槽位互斥：后一个 show 占用槽位时，原可见角色隐藏并保留其状态", () => {
    const result = compile(
      [
        "@ch female_A show position=left",
        "@ch female_B show position=left",
        "@beat",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_B"]!.visible).toBe(true);
    const displaced = result.visualState.characters["female_A"]!;
    expect(displaced.visible).toBe(false); // 被顶替隐藏
    expect(displaced.variant).toBe("base"); // 状态保留（下一次视觉投影可见）
    expect(Object.hasOwn(result.visualState.characters, "female_A")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// @say 纯文本身份
// ---------------------------------------------------------------------------

describe("compileSegmentV2 — @say 身份校验（不降级、不猜 ID）", () => {
  it("未知 ID → UNKNOWN_CHARACTER_ID（含中文名冒充 ID），带合法 ID 有界列表", () => {
    const unknown = compile(
      ["@say female_Z 台词", "@end 81ab buffer"].join("\n"),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics[0]!.code).toBe("UNKNOWN_CHARACTER_ID");
    expect(unknown.diagnostics[0]!.legalValues).toContain("female_A");
    expect(unknown.diagnostics[0]!.legalValues).not.toContain("persona");

    const chineseName = compile(
      ["@say 许晚晴 台词", "@end 81ab buffer"].join("\n"),
    );
    expect(chineseName.ok).toBe(false);
    expect(chineseName.diagnostics[0]!.code).toBe("UNKNOWN_CHARACTER_ID");
  });

  it("玩家代言 → PLAYER_SPEECH_FORBIDDEN", () => {
    const result = compile(
      ["@say player_one 我来替玩家说话。", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("PLAYER_SPEECH_FORBIDDEN");
    expect(result.diagnostics[0]!.legalValues).toContain("female_A");
  });

  it("超出 allowedSpeakerIds → CHARACTER_NOT_ALLOWED（即使知道该角色）", () => {
    const result = compile(
      ["@say female_A 台词", "@end 81ab buffer"].join("\n"),
      { cast: { allowedSpeakerIds: ["female_B"], sceneParticipantIds: CAST.sceneParticipantIds } },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("CHARACTER_NOT_ALLOWED");
    expect(result.diagnostics[0]!.legalValues).toEqual(["female_B"]);
  });

  it("@name/@ch 越权 sceneParticipants → CHARACTER_NOT_ALLOWED", () => {
    const narrowed = { allowedSpeakerIds: CAST.allowedSpeakerIds, sceneParticipantIds: ["player_one", "female_A"] as string[] };
    const rename = compile(
      ["@name female_B set 有人吗", "@beat", "@end 81ab buffer"].join("\n"),
      { cast: narrowed },
    );
    expect(rename.ok).toBe(false);
    expect(rename.diagnostics[0]!.code).toBe("CHARACTER_NOT_ALLOWED");

    const stage = compile(
      ["@ch female_B show", "@beat", "@end 81ab buffer"].join("\n"),
      { cast: narrowed },
    );
    expect(stage.ok).toBe(false);
    expect(stage.diagnostics[0]!.code).toBe("CHARACTER_NOT_ALLOWED");
  });

  it("非法 look → UNKNOWN_LOOK，带该角色 look 有界列表", () => {
    const result = compile(
      ["@ch female_A show look=laugh", "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("UNKNOWN_LOOK");
    expect(result.diagnostics[0]!.line).toBe(1);
    expect(result.diagnostics[0]!.legalValues).toEqual(["base", "smile"]);
  });

  it("非法名牌文本（超长）→ INVALID_DISPLAY_LABEL", () => {
    const longLabel = "长".repeat(65);
    const result = compile(
      [`@name female_A set ${longLabel}`, "@beat", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("INVALID_DISPLAY_LABEL");
  });
});

// ---------------------------------------------------------------------------
// 原子提交与预测状态隔离
// ---------------------------------------------------------------------------

describe("compileSegmentV2 — 原子性与预测状态隔离", () => {
  it("坏 look 与好改名同组 → 两者都不提交（也不提交主事件）", () => {
    const committedVisual: VisualState = createInitialVisualState();
    const committedLabels = createCharacterRuntimeState();
    const options = segmentOptions({ visualState: committedVisual, characterState: committedLabels });
    const result = compileSegmentV2({
      ...options,
      text: [
        "@say female_A 第一句（先提交）。",
        "@ch female_A show look=laugh",
        "@name female_A set 夜巡者",
        "@say female_A 第二句（不该提交）。",
        "@end 81ab buffer",
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("UNKNOWN_LOOK");
    expect(result.diagnostics[0]!.line).toBe(2);
    // 前组保持提交。
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.main.type).toBe("dialogue");
    // 坏组整体不落地：改名没进名牌，舞台没动。
    expect(result.characterState.labels["female_A"]).toBeUndefined();
    expect(result.visualState.characters["female_A"]).toBeUndefined();
  });

  it("编译预测状态是副本：即使零变化也不是传入对象；已提交状态永不被污染", () => {
    const committedVisual: VisualState = {
      background: "basement",
      characters: {},
    };
    const committedLabels = createCharacterRuntimeState();
    committedLabels.labels["female_A"] = "原名牌";
    const visualSnapshot = JSON.stringify(committedVisual);
    const labelsSnapshot = JSON.stringify(committedLabels.labels);

    const ok = compileSegmentV2({
      ...segmentOptions({ visualState: committedVisual, characterState: committedLabels }),
      text: ["@n 只有旁白。", "@end 81ab buffer"].join("\n"),
    });
    expect(ok.ok).toBe(true);
    expect(ok.visualState).not.toBe(committedVisual);
    expect(ok.characterState).not.toBe(committedLabels);

    const failed = compileSegmentV2({
      ...segmentOptions({ visualState: committedVisual, characterState: committedLabels }),
      text: ["@say nobody 台词", "@end 81ab buffer"].join("\n"),
    });
    expect(failed.ok).toBe(false);
    expect(failed.visualState).not.toBe(committedVisual);
    expect(failed.characterState).not.toBe(committedLabels);
    expect(JSON.stringify(committedVisual)).toBe(visualSnapshot);
    expect(JSON.stringify(committedLabels.labels)).toBe(labelsSnapshot);
  });

  it("同组 @ch/@name 按出现顺序生效（先改名后登台 → 首触名牌用新名）", () => {
    const result = compile(
      [
        "@name female_A set 夜巡者",
        "@ch female_A show",
        "@say female_A 按顺序生效。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_A"]!.displayName).toBe("夜巡者");
    const main = result.groups[0]!.main;
    expect(main.type === "dialogue" && main.displayLabel).toBe("夜巡者");
  });
});

// ---------------------------------------------------------------------------
// 冗余去重与一次性效果
// ---------------------------------------------------------------------------

describe("compileSegmentV2 — cue 去重规则", () => {
  it("无变化 cue 去重（软诊断），@se 一次性效果永不去重", () => {
    const result = compile(
      [
        "@bg basement",
        "@bg basement",
        "@se door_slam",
        "@se door_slam",
        "@n 正文。",
        "@end 81ab buffer",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prelude = result.groups[0]!.prelude;
    const backgrounds = prelude.filter((cue) => cue.type === "background");
    const ses = prelude.filter((cue) => cue.type === "sound_effect");
    expect(backgrounds).toHaveLength(1);
    expect(ses).toHaveLength(2); // @se 不得被当成冗余删除
    expect(result.assetDiagnostics).toContainEqual({
      code: "REDUNDANT_STAGE_CUE",
      id: "basement",
    });
    expect(result.assetDiagnostics.filter((d) => d.code === "REDUNDANT_STAGE_CUE" && d.id === "door_slam")).toHaveLength(0);
  });

  it("未知素材 id：cue 丢弃 + 软诊断（保持现状，不中断）", () => {
    const result = compile(
      ["@bg nowhere_land", "@say female_A 台词。", "@end 81ab buffer"].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups[0]!.prelude).toHaveLength(0);
    expect(result.assetDiagnostics[0]).toEqual({ code: "UNKNOWN_BACKGROUND", id: "nowhere_land" });
  });
});

// ---------------------------------------------------------------------------
// 任务能力校验
// ---------------------------------------------------------------------------

describe("compileSegmentV2 — 任务能力校验（capabilities 单源）", () => {
  it("branch_prefetch 里写表单 → COMMAND_NOT_ALLOWED_FOR_TASK", () => {
    const result = compile(
      ["@? 要选哪个？", "@+ 甲", "@+ 乙", "@/?", "@end 81ab buffer"].join("\n"),
      { task: "branch_prefetch" },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("COMMAND_NOT_ALLOWED_FOR_TASK");
    expect(result.diagnostics[0]!.line).toBe(1);
    expect(result.diagnostics[0]!.legalValues).toContain("@say");
    expect(result.diagnostics[0]!.legalValues).not.toContain("@?");
  });

  it("opening 不允许 buffer 收束（能力卡 endReasons 即哨兵 allowedReasons）", () => {
    const result = compile(
      ["@n 开场。", "@end 81ab buffer"].join("\n"),
      { task: "opening" },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("SENTINEL_INVALID_REASON");
  });

  it("input_bridge 里写 @say → 能力违规", () => {
    const result = compile(
      ["@say female_A 台词。", "@end 81ab buffer"].join("\n"),
      { task: "input_bridge" },
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("COMMAND_NOT_ALLOWED_FOR_TASK");
  });
});

// ---------------------------------------------------------------------------
// 单组入口（流式消费用）
// ---------------------------------------------------------------------------

describe("compileEventGroupV2 — 单组入口", () => {
  it("成功：返回编译组与预测状态副本", () => {
    const { registry, reduce } = makeHarness();
    const input = createInitialVisualState();
    const result = compileEventGroupV2(
      groupOf(
        [{ kind: "ch_show", characterId: "female_A" }],
        { type: "beat" },
      ),
      {
        registry,
        cast: CAST,
        reduce,
        visualState: input,
        characterState: createCharacterRuntimeState(),
        task: "continuation",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.visualState.characters["female_A"]!.visible).toBe(true);
    expect(result.visualState).not.toBe(input);
    expect(result.group.main).toEqual({ type: "beat" });
  });

  it("失败：输入状态原样奉还（组内零落地）", () => {
    const { registry, reduce } = makeHarness();
    const input = createInitialVisualState();
    const inputLabels = createCharacterRuntimeState();
    const result = compileEventGroupV2(
      groupOf(
        [
          { kind: "label_set", characterId: "female_A", label: "改名" },
          { kind: "ch_show", characterId: "female_A", look: "laugh" },
        ],
        { type: "beat" },
      ),
      {
        registry,
        cast: CAST,
        reduce,
        visualState: input,
        characterState: inputLabels,
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(inputLabels.labels)).toBe("{}");
    expect(input.characters).toEqual({});
  });
});
