/**
 * v2 行解析器表驱动测试（C4，计划 §4.1 逐条语法）。
 *
 * 钉住的契约：
 * - §4.1 每条命令形式（成功形状 + 关键参数组合）；
 * - 正文 = 固定 token 数后的剩余原文：`： : [] () $& @ch` 在正文里逐字保留，
 *   不做任何角色/外观识别，也不规范化正文；
 * - 重复参数、未知参数、缺正文、非法 position、粘写/未知命令 → 结构化报错；
 * - 版本路由：v2 请求永不进入 v1 语法（冒号台词行在 v2 报错），v1 请求
 *   永不进入 v2 语法（@say 在 v1 是未知指令）；缺省版本 = 1。
 */
import { describe, it, expect } from "vitest";
import { parseDslV2Line, parseDslLine } from "./line-parser.js";
import { DslProtocolError } from "./types.js";
import type { DslErrorCode, DslLineV2 } from "./types.js";

function expectCode(line: string, code: DslErrorCode): void {
  let caught: unknown;
  try {
    parseDslV2Line(line);
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected "${line}" to throw ${code}`).toBeInstanceOf(DslProtocolError);
  expect((caught as DslProtocolError).code).toBe(code);
}

/** 成功形状表（§4.1 每条语法至少一行）。 */
const FORM_TABLE: readonly { raw: string; expected: DslLineV2 }[] = [
  // @say <characterId> <单行台词正文>
  { raw: "@say female_A 先别动，名单在我这里。", expected: { kind: "say", characterId: "female_A", text: "先别动，名单在我这里。" } },
  // @n <单行旁白正文>
  { raw: "@n 我把伸出去的手收了回来。", expected: { kind: "narration", text: "我把伸出去的手收了回来。" } },
  // @name <characterId> set <单行名牌文本>
  { raw: "@name female_A set 神秘女子", expected: { kind: "name_set", characterId: "female_A", label: "神秘女子" } },
  // @name <characterId> reset
  { raw: "@name female_A reset", expected: { kind: "name_reset", characterId: "female_A" } },
  // @ch show 全参数 / 仅 look / 仅 position / 无参数
  { raw: "@ch female_A show look=smile position=left", expected: { kind: "ch_show", characterId: "female_A", look: "smile", position: "left" } },
  { raw: "@ch female_A show position=right", expected: { kind: "ch_show", characterId: "female_A", position: "right" } },
  { raw: "@ch female_A show look=smile", expected: { kind: "ch_show", characterId: "female_A", look: "smile" } },
  { raw: "@ch female_A show", expected: { kind: "ch_show", characterId: "female_A" } },
  // @ch set look+position / 仅 position / 仅 look
  { raw: "@ch female_A set look=smile position=left", expected: { kind: "ch_set", characterId: "female_A", look: "smile", position: "left" } },
  { raw: "@ch female_A set position=center", expected: { kind: "ch_set", characterId: "female_A", position: "center" } },
  { raw: "@ch female_A set look=smile", expected: { kind: "ch_set", characterId: "female_A", look: "smile" } },
  // show 的参数顺序自由
  { raw: "@ch female_A show position=left look=smile", expected: { kind: "ch_show", characterId: "female_A", look: "smile", position: "left" } },
  // hide / exit / reset
  { raw: "@ch female_A hide", expected: { kind: "ch_hide", characterId: "female_A" } },
  { raw: "@ch female_A exit", expected: { kind: "ch_exit", characterId: "female_A" } },
  { raw: "@ch female_A reset", expected: { kind: "ch_reset", characterId: "female_A" } },
  // @bg / @bgm（含 stop）/ @se / @beat
  { raw: "@bg classroom_morning", expected: { kind: "background", assetId: "classroom_morning" } },
  { raw: "@bgm stop", expected: { kind: "bgm", assetId: "stop" } },
  { raw: "@bgm mystery_loop", expected: { kind: "bgm", assetId: "mystery_loop" } },
  { raw: "@se door_slam", expected: { kind: "sound_effect", assetId: "door_slam" } },
  { raw: "@beat", expected: { kind: "beat" } },
  // 表单（保留 v1 语义：提示可与 @? 粘写）
  { raw: "@? 我要先看哪一项？", expected: { kind: "form_start", prompt: "我要先看哪一项？" } },
  { raw: "@?我先看哪一项？", expected: { kind: "form_start", prompt: "我先看哪一项？" } },
  { raw: "@+ 名单", expected: { kind: "form_option", text: "名单" } },
  { raw: "@= 说出你想说的话", expected: { kind: "form_input", placeholder: "说出你想说的话" } },
  { raw: "@/?", expected: { kind: "form_end" } },
  // @end / @ending（形状同 v1；能力/位置门控在 validator/compiler）
  { raw: "@end 81ab buffer", expected: { kind: "segment_end", nonce: "81ab", reason: "buffer" } },
  { raw: "@end 81ab interaction", expected: { kind: "segment_end", nonce: "81ab", reason: "interaction" } },
  { raw: "@ending HE 樱花与约定的终章", expected: { kind: "ending_epilogue", raw: "HE 樱花与约定的终章" } },
];

describe("parseDslV2Line — §4.1 语法表", () => {
  for (const { raw, expected } of FORM_TABLE) {
    it(`形状：${raw}`, () => {
      expect(parseDslV2Line(raw)).toEqual(expected);
    });
  }

  it("行允许首尾空白与 CRLF 尾（trim 只作用于行边界）", () => {
    expect(parseDslV2Line("   @say female_A 你好\r\n")).toEqual({
      kind: "say",
      characterId: "female_A",
      text: "你好",
    });
    expect(parseDslV2Line("\t@n 旁白正文\t")).toEqual({ kind: "narration", text: "旁白正文" });
  });

  it("命令区允许多空白分隔；正文起点跳过一段分隔", () => {
    expect(parseDslV2Line("@name  female_A   set   神秘女子")).toEqual({
      kind: "name_set",
      characterId: "female_A",
      label: "神秘女子",
    });
  });
});

describe("parseDslV2Line — 正文逐字保留（不再用 :/[]/() 识别角色或外观）", () => {
  const LITERAL_TABLE: readonly { raw: string; text: string }[] = [
    { raw: "@say female_A 苏遥：你好", text: "苏遥：你好" },
    { raw: "@say female_A 系统提示: [警告]（重试）", text: "系统提示: [警告]（重试）" },
    { raw: "@say female_A @ch raspberry show 是正文不是指令", text: "@ch raspberry show 是正文不是指令" },
    { raw: "@say female_A $& 恒为字面替换符", text: "$& 恒为字面替换符" },
    { raw: "@n （旁白）[手稿]：混排也照抄", text: "（旁白）[手稿]：混排也照抄" },
    { raw: "@say female_A 半角:冒号 与全角：冒号都保留", text: "半角:冒号 与全角：冒号都保留" },
    { raw: "@say female_A emoji✓《》「」…—", text: "emoji✓《》「」…—" },
  ];

  for (const { raw, text } of LITERAL_TABLE) {
    it(`正文逐字：${raw}`, () => {
      const parsed = parseDslV2Line(raw);
      expect(
        parsed.kind === "say" || parsed.kind === "narration" || parsed.kind === "name_set",
      ).toBe(true);
      if (parsed.kind === "say") expect(parsed.text).toBe(text);
      if (parsed.kind === "narration") expect(parsed.text).toBe(text);
    });
  }

  it("正文起点跳过一段分隔（连续空白视为同一段，正文首字符不保留前导空白）", () => {
    const parsed = parseDslV2Line("@say female_A  emoji✓《》「》…—");
    expect(parsed.kind === "say" && parsed.text).toBe("emoji✓《》「》…—");
  });

  it("@name 的名牌文本同样逐字保留", () => {
    expect(parseDslV2Line("@name female_A set [神秘]女子（化名）：合法")).toEqual({
      kind: "name_set",
      characterId: "female_A",
      label: "[神秘]女子（化名）：合法",
    });
  });

  it("正文内的 look= 片段不会被当参数（@say 正文固定 token 数）", () => {
    expect(parseDslV2Line("@say female_A 把 look=smile position=left 当台词念出来")).toEqual({
      kind: "say",
      characterId: "female_A",
      text: "把 look=smile position=left 当台词念出来",
    });
  });
});

describe("parseDslV2Line — 结构化报错", () => {
  it("缺正文：@say 无 id / 无正文，@n 无正文", () => {
    expectCode("@say", "MISSING_BODY");
    expectCode("@say female_A", "MISSING_BODY");
    expectCode("@n", "MISSING_BODY");
  });

  it("@name：缺子命令 / 未知子命令 / set 缺名牌 / reset 带尾巴", () => {
    expectCode("@name female_A", "INVALID_DISPLAY_LABEL");
    expectCode("@name female_A rename 神秘女子", "INVALID_DISPLAY_LABEL");
    expectCode("@name female_A set", "INVALID_DISPLAY_LABEL");
    expectCode("@name female_A reset extra", "INVALID_DISPLAY_LABEL");
  });

  it("@ch：缺 id / 缺子命令 / 未知子命令 / set 零参数", () => {
    expectCode("@ch", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A appear", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A set", "INVALID_CH_PARAMETER");
  });

  it("@ch：重复参数 / 未知参数 / 非法 position / 非 key=value / hide 带参数", () => {
    expectCode("@ch female_A show look=a look=b", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A show position=left position=right", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A show mood=happy", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A show position=middle", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A set smile", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A set look=", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A hide look=smile", "INVALID_CH_PARAMETER");
    expectCode("@ch female_A exit now", "INVALID_CH_PARAMETER");
  });

  it("未知指令 / 粘写命令 / 全角命令 / 裸台词行（v1 语法）", () => {
    expectCode("@teleport basement", "UNKNOWN_COMMAND");
    expectCode("@sayfemale_A 你好", "UNKNOWN_COMMAND");
    expectCode("＠say female_A 你好", "UNKNOWN_COMMAND");
    expectCode("苏遥: 你好", "UNKNOWN_COMMAND");
    expectCode("苏遥：你好", "UNKNOWN_COMMAND");
    expectCode("一句旁白", "UNKNOWN_COMMAND");
    expectCode("旁白：一句旁白", "UNKNOWN_COMMAND");
    expectCode("?", "UNKNOWN_COMMAND");
    expectCode("/?", "UNKNOWN_COMMAND");
    expectCode("beat", "UNKNOWN_COMMAND");
    expectCode("ch female_A show", "UNKNOWN_COMMAND");
  });

  it("@bg/@bgm/@se：缺 id / 多 token", () => {
    expectCode("@bg", "UNKNOWN_LINE");
    expectCode("@bg a b", "UNKNOWN_LINE");
    expectCode("@bgm", "UNKNOWN_LINE");
    expectCode("@se", "UNKNOWN_LINE");
  });

  it("@end 哨兵形状（与 v1 同码同因）", () => {
    expectCode("@end", "SENTINEL_MISSING_REASON");
    expectCode("@end 81ab", "SENTINEL_MISSING_REASON");
    expectCode("@end 81ab forever", "SENTINEL_INVALID_REASON");
  });

  it("报错细节携带期望格式（结构化，不只靠 code）", () => {
    let caught: unknown;
    try {
      parseDslV2Line("@ch female_A show position=middle");
    } catch (err) {
      caught = err;
    }
    const error = caught as DslProtocolError;
    expect(error.detail?.expected).toContain("@ch");
    expect(error.message).toContain("middle");
  });
});

describe("parseDslLine — 版本路由（缺省 1；v2 请求不见 v1 语法，反之亦然）", () => {
  it("缺省路由到 v1：冒号台词行按 v1 解析为 dialogue", () => {
    const known = new Set(["苏遥"]);
    expect(parseDslLine("苏遥: 你好", known)).toMatchObject({ kind: "dialogue", speaker: "苏遥" });
  });

  it("v1 请求不见 v2 语法：@say 是未知指令", () => {
    let caught: unknown;
    try {
      parseDslLine("@say female_A 你好", { protocolVersion: 1 });
    } catch (err) {
      caught = err;
    }
    expect((caught as DslProtocolError).code).toBe("UNKNOWN_COMMAND");
  });

  it("v2 请求不见 v1 语法：冒号台词行报错、@n 正常", () => {
    let caught: unknown;
    try {
      parseDslLine("苏遥: 你好", { protocolVersion: 2 });
    } catch (err) {
      caught = err;
    }
    expect((caught as DslProtocolError).code).toBe("UNKNOWN_COMMAND");
    expect(parseDslLine("@n 你好", { protocolVersion: 2 })).toEqual({ kind: "narration", text: "你好" });
  });

  it("knownSpeakers 透传给 v1（既有调用形状不变）", () => {
    const known = new Set(["苏遥"]);
    expect(parseDslLine("苏遥：你好", known)).toMatchObject({ kind: "dialogue" });
  });
});
