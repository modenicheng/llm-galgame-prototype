/**
 * v2 段编译的流式与修复行为（C4，计划 §4.3）。
 *
 * 覆盖：任意切块（每个字符边界）、截断括号/命令、CRLF、无尾换行、仅
 * cue+beat、互动尾部、@ending 尾部；一次尾部修复（成功/二次失败/放弃）
 * ——重复失败不提交半组、不重复前缀、不改动已提交（分支）状态。
 */
import { describe, it, expect } from "vitest";
import type { AssetCatalog } from "../../assets/types.js";
import type { CharacterDefinition } from "../../characters/types.js";
import { createCharacterRuntimeState } from "../../characters/types.js";
import { buildCharacterRoster, createCharacterRegistry } from "../../characters/registry.js";
import { createVisualStateReducer } from "../../presentation/reducer.js";
import {
  createInitialVisualState,
  createPresentationDefaultsFromRoster,
} from "../../presentation/defaults.js";
import { StreamLineDecoder } from "./stream-decoder.js";
import {
  compileSegmentV2,
  compileSegmentV2WithRepair,
} from "./compiler.js";
import type { CompileSegmentV2Options } from "./compiler.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSETS: AssetCatalog = {
  guidance: "测试目录",
  backgrounds: { basement: { id: "basement", src: "b.jpg", description: "" } },
  bgm: { mystery: { id: "mystery", src: "m.mp3", description: "" } },
  soundEffects: { door_slam: { id: "door_slam", src: "d.mp3", description: "" } },
  spriteSets: {
    female_A: {
      id: "female_A",
      variants: {
        base: { id: "base", src: "a.png", description: "" },
        smile: { id: "smile", src: "a2.png", description: "" },
      },
    },
  },
  characters: {},
};

function makeDef(): CharacterDefinition[] {
  return [
    { id: "player_one", name: "玩家", control: "player", initialLabel: "你", persona: "玩家。" },
    {
      id: "female_A",
      name: "许晚晴",
      control: "npc",
      initialLabel: "神秘女子",
      persona: "学姐。",
      presentation: {
        defaultLook: "base",
        defaultPosition: "right",
        looks: {
          base: { spriteSet: "female_A", variant: "base" },
          smile: { spriteSet: "female_A", variant: "smile" },
        },
      },
    },
  ];
}

function makeOptions(overrides?: Partial<CompileSegmentV2Options>): CompileSegmentV2Options {
  const roster = buildCharacterRoster({
    schemaVersion: 2,
    scopeId: "c4-stream",
    playerId: "player_one",
    characters: makeDef(),
  });
  const registry = createCharacterRegistry(roster, ASSETS);
  return {
    text: "",
    expectedNonce: "81ab",
    task: "continuation",
    registry,
    cast: { allowedSpeakerIds: ["female_A"], sceneParticipantIds: ["player_one", "female_A"] },
    reduce: createVisualStateReducer(createPresentationDefaultsFromRoster(registry)),
    visualState: createInitialVisualState(),
    characterState: createCharacterRuntimeState(),
    catalog: ASSETS,
    ...overrides,
  };
}

const SEGMENT = [
  "@name female_A set 神秘女子",
  "@ch female_A show look=smile position=left",
  "@say female_A 先别动，名单在我这里。",
  "@n 我把伸出去的手收了回来。",
  "@bg basement",
  "@bgm mystery",
  "@se door_slam",
  "@beat",
  "@? 我要先看哪一项？",
  "@+ 名字",
  "@+ 时间",
  "@/?",
  "@end 81ab buffer",
].join("\n");

// ---------------------------------------------------------------------------
// 流式切块等价性
// ---------------------------------------------------------------------------

describe("v2 段编译 — 流式任意切块等价", () => {
  it("每个字符边界切块：流式分行 + 编译 == 整文编译", () => {
    const baseline = compileSegmentV2({ ...makeOptions(), text: SEGMENT });
    expect(baseline.ok).toBe(true);

    for (let split = 0; split <= SEGMENT.length; split += 1) {
      const chunks = [SEGMENT.slice(0, split), SEGMENT.slice(split)];
      const decoder = new StreamLineDecoder();
      const lines: string[] = [];
      for (const chunk of chunks) {
        lines.push(...decoder.push(chunk));
      }
      const tail = decoder.flush();
      if (tail !== null) lines.push(tail);
      const streamed = compileSegmentV2({ ...makeOptions(), text: lines.join("\n") });
      expect(streamed.ok, `split=${split}`).toBe(true);
      expect(JSON.stringify(streamed.groups), `split=${split}`).toBe(
        JSON.stringify(baseline.groups),
      );
      expect(JSON.stringify(streamed.visualState), `split=${split}`).toBe(
        JSON.stringify(baseline.visualState),
      );
    }
  });

  it("CRLF 行尾与整文一致；无尾换行不丢最后一行（哨兵可解析）", () => {
    const crlf = SEGMENT.replace(/\n/g, "\r\n");
    const crlfResult = compileSegmentV2({ ...makeOptions(), text: crlf });
    const lfResult = compileSegmentV2({ ...makeOptions(), text: SEGMENT });
    expect(crlfResult.ok).toBe(true);
    expect(JSON.stringify(crlfResult.groups)).toBe(JSON.stringify(lfResult.groups));

    const noTrailingNewline = compileSegmentV2({
      ...makeOptions(),
      text: ["@n 旁白。", "@end 81ab buffer"].join("\n"), // 无尾换行
    });
    expect(noTrailingNewline.ok).toBe(true);
    expect(noTrailingNewline.status).toMatchObject({ kind: "complete", reason: "buffer" });
  });

  it("仅 cue+beat：一个组（prelude=场景 cue，main=beat）可提交", () => {
    const result = compileSegmentV2({
      ...makeOptions(),
      text: ["@bg basement", "@bgm mystery", "@beat", "@end 81ab buffer"].join("\n"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.main).toEqual({ type: "beat" });
    expect(result.groups[0]!.prelude.map((cue) => cue.type)).toEqual(["background", "bgm"]);
    expect(result.visualState.background).toBe("basement");
    expect(result.visualState.bgm).toBe("mystery");
  });

  it("互动尾部：表单组在哨兵前冲刷；@ending 尾部：哨兵后至多一行，残留静默丢弃", () => {
    const interaction = compileSegmentV2({
      ...makeOptions(),
      text: [
        "@say female_A 台词。",
        "@? 要走哪边？",
        "@+ 左",
        "@+ 右",
        "@/?",
        "@end 81ab interaction",
      ].join("\n"),
    });
    expect(interaction.ok).toBe(true);
    if (!interaction.ok) return;
    expect(interaction.groups).toHaveLength(2);
    expect(interaction.groups[1]!.main.type).toBe("interaction");
    expect(interaction.status).toMatchObject({ kind: "complete", reason: "interaction" });

    const ending = compileSegmentV2({
      ...makeOptions(),
      text: [
        "@n 尾声。",
        "@end 81ab ending",
        "@ending HE 樱花与约定的终章",
        "@say female_A 哨兵后的残留。",
        "@end 81ab buffer",
      ].join("\n"),
    });
    expect(ending.ok).toBe(true);
    if (!ending.ok) return;
    expect(ending.status).toMatchObject({
      kind: "complete",
      reason: "ending",
      epilogue: { grade: "HE", title: "樱花与约定的终章" },
    });
    expect(ending.groups).toHaveLength(1); // 残留全部丢弃，不炸段
  });

  it("截断命令（流末尾无换行的半条指令）→ 结构化诊断，不静默接受", () => {
    const truncated = compileSegmentV2({
      ...makeOptions(),
      text: ["@n 旁白。", "@ch female_A sh"].join("\n"), // 尾行截断且无哨兵
    });
    expect(truncated.ok).toBe(false);
    expect(truncated.diagnostics[0]!.code).toBe("INVALID_CH_PARAMETER");
    expect(truncated.diagnostics[0]!.line).toBe(2);
  });

  it("截断括号：正文里的未闭合 [ 逐字保留（不再解析括号）", () => {
    const result = compileSegmentV2({
      ...makeOptions(),
      text: ["@say female_A 名单在[哪来着……", "@end 81ab buffer"].join("\n"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const main = result.groups[0]!.main;
    expect(main.type === "dialogue" && main.text).toBe("名单在[哪来着……");
  });
});

// ---------------------------------------------------------------------------
// 一次尾部修复
// ---------------------------------------------------------------------------

describe("compileSegmentV2WithRepair — 一次未提交尾部修复", () => {
  it("首次错误 → 修复尾部一次 → 成功；前缀不重复、不重放", async () => {
    const options = makeOptions();
    const text = [
      "@say female_A 第一句（前缀，已提交）。",
      "@ch female_A show look=laugh", // 坏 look
      "@say female_A 第二句（修复后应出现）。",
      "@end 81ab buffer",
    ].join("\n");

    let repairCalls = 0;
    let seenTail = "";
    let seenInstruction = "";
    const result = await compileSegmentV2WithRepair({ ...options, text }, (diagnostics, tail) => {
      repairCalls += 1;
      seenTail = tail.text;
      seenInstruction = tail.instruction;
      expect(diagnostics[0]!.code).toBe("UNKNOWN_LOOK");
      expect(diagnostics[0]!.line).toBe(2);
      // 修复模型只需重写未提交尾部（坏 look 行起的全部行）。
      return Promise.resolve(
        ["@ch female_A show look=smile", "@say female_A 第二句（修复后应出现）。", "@end 81ab buffer"].join("\n"),
      );
    });

    expect(repairCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.repairAttempted).toBe(true);
    // 尾部 = 未提交部分（不含已提交前缀第一行）。
    expect(seenTail).not.toContain("第一句");
    expect(seenTail).toContain("look=laugh");
    // 修复指令来自能力卡。
    expect(seenInstruction).toContain("continuation");
    expect(seenInstruction).toContain("81ab");
    if (!result.ok) return;
    // 前缀恰好一次 + 修复尾部的内容。
    const dialogues = result.groups
      .map((g) => (g.main.type === "dialogue" ? g.main.text : null))
      .filter((t): t is string => t !== null);
    expect(dialogues).toEqual(["第一句（前缀，已提交）。", "第二句（修复后应出现）。"]);
    // 状态连续性：前缀与尾部在同一预测状态链上。
    expect(result.visualState.characters["female_A"]!.variant).toBe("smile");
  });

  it("二次失败：不提交半组、不重复前缀、已提交状态零污染", async () => {
    const committedVisual = createInitialVisualState();
    committedVisual.background = "basement";
    const committedLabels = createCharacterRuntimeState();
    committedLabels.labels["female_A"] = "已提交名牌";
    const visualSnapshot = JSON.stringify(committedVisual);
    const labelsSnapshot = JSON.stringify(committedLabels.labels);

    const options = makeOptions({
      visualState: committedVisual,
      characterState: committedLabels,
    });
    const text = [
      "@n 前缀旁白（已提交）。",
      "@ch female_A show look=laugh", // 第一次错误
      "@name female_A set 好改名",
      "@beat",
      "@end 81ab buffer",
    ].join("\n");

    let repairCalls = 0;
    const result = await compileSegmentV2WithRepair({ ...options, text }, () => {
      repairCalls += 1;
      // 修复尾部仍写同一个坏 look：第二次失败。
      return Promise.resolve(
        ["@ch female_A show look=laugh", "@name female_A set 好改名", "@beat", "@end 81ab buffer"].join("\n"),
      );
    });

    expect(repairCalls).toBe(1); // 只修一次
    expect(result.ok).toBe(false);
    expect(result.repairAttempted).toBe(true);
    expect(result.diagnostics[0]!.code).toBe("UNKNOWN_LOOK");
    // 可播放前缀只有原前缀（修复尾部零提交）——无重复、无半组。
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.main).toEqual({ type: "narration", text: "前缀旁白（已提交）。" });
    expect(result.characterState.labels["female_A"]).toBe("已提交名牌"); // 好改名未落地
    expect(result.visualState.characters["female_A"]).toBeUndefined(); // 舞台未动
    // 调用方已提交状态零污染（分支隔离）。
    expect(JSON.stringify(committedVisual)).toBe(visualSnapshot);
    expect(JSON.stringify(committedLabels.labels)).toBe(labelsSnapshot);
  });

  it("修复方放弃（null）：维持首次失败结果，repairAttempted=false", async () => {
    const result = await compileSegmentV2WithRepair(makeOptions(), () => Promise.resolve(null));
    expect(result.ok).toBe(false);
    expect(result.repairAttempted).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("首次即成功：不发起修复", async () => {
    let calls = 0;
    const result = await compileSegmentV2WithRepair(
      { ...makeOptions(), text: ["@n 一句旁白。", "@end 81ab buffer"].join("\n") },
      () => {
        calls += 1;
        return Promise.resolve(null);
      },
    );
    expect(calls).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.repairAttempted).toBe(false);
  });

  it("缺哨兵（截断段）：组已提交，尾部为空，修复只补收束", async () => {
    const result = await compileSegmentV2WithRepair(
      { ...makeOptions(), text: ["@say female_A 说到一半被截断。"].join("\n") },
      (diagnostics, tail) => {
        expect(diagnostics[0]!.code).toBe("SENTINEL_MISSING");
        expect(tail.text).toBe(""); // 台词组已提交，未提交尾部为空
        return Promise.resolve("@end 81ab buffer");
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups).toHaveLength(1);
    const dialogues = result.groups.filter((g) => g.main.type === "dialogue");
    expect(dialogues).toHaveLength(1); // 不重复前缀
  });
});
