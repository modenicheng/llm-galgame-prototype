/**
 * Gal DSL v2 line parser + 版本路由（C4，计划 §4.1）。
 *
 * v2 语法（逐条）：
 *   @say <characterId> <单行台词正文>
 *   @n <单行旁白正文>
 *   @name <characterId> set <单行名牌文本>
 *   @name <characterId> reset
 *   @ch <characterId> show [look=<lookId>] [position=<slot>]
 *   @ch <characterId> set look=<lookId> [position=<slot>]
 *   @ch <characterId> set position=<slot>
 *   @ch <characterId> hide | exit | reset
 *   @bg <backgroundId> / @bgm <bgmId|stop> / @se <soundEffectId> / @beat
 *   @? <交互问句> / @+ <选项正文> / @= <输入提示> / @/?
 *   @end <nonce> <buffer|interaction|ending>
 *   @ending <TE|HE|NE|BE> <结尾标题>（仅 ending 哨兵后，任务能力门控）
 *
 * 正文起点 = 固定数量 token 之后的剩余原文：不用 `:`、`[]`、`()` 识别
 * 角色或外观。冒号（含全角）、括号、`$&`、`@ch` 之类的片段在正文里都是
 * 普通文本，逐字保留、永不规范化。命令区只用 ASCII 命令名与空白 token
 * 分隔；行允许首尾空白与 CRLF（行级 trim，正文不 trim 内部）。
 *
 * 重复参数、未知参数、缺正文、非法 position、粘写命令 → 结构化报错
 * （MISSING_BODY / INVALID_CH_PARAMETER / INVALID_DISPLAY_LABEL /
 * UNKNOWN_COMMAND / UNKNOWN_LINE），绝不静默降级。
 *
 * v1 语法冻结在 legacy-line-parser.ts，只服务显式 legacy 请求；本文件的
 * parseDslLine 做按请求版本路由（缺省 1，服务端 dsl.protocol_version）。
 */
import type { CharacterPosition } from "../../presentation/types.js";
import { DslProtocolError, DSL_COMMAND_LIST_V2 } from "./types.js";
import type {
  AnyDslLine,
  DslLine,
  DslLineV2,
  DslParseOptions,
} from "./types.js";
import {
  matchEndSentinel,
  matchEndingEpilogueLine,
  parseDslV1Line,
} from "./legacy-line-parser.js";

// v1 冻结实现与助手继续从本模块 re-export：既有调用方（generator、
// closing-repair、segment-validator、text-pipeline、测试）的导入路径不变。
export {
  parseDslV1Line,
  normalizeDslCommandPrefix,
  interpretEndingEpilogue,
  ENDING_TITLE_MAX_CHARS,
} from "./legacy-line-parser.js";
export { parseDslV1Line as parseDslLegacyLine } from "./legacy-line-parser.js";

// ---------------------------------------------------------------------------
// 版本路由（计划 §4.1：协议版本按请求携带，不逐行猜 v1/v2）
// ---------------------------------------------------------------------------

interface ResolvedParseOptions {
  protocolVersion: 1 | 2;
  knownSpeakers?: ReadonlySet<string> | undefined;
}

function resolveParseOptions(
  arg?: DslParseOptions | ReadonlySet<string>,
): ResolvedParseOptions {
  if (arg === undefined) return { protocolVersion: 1 };
  // ReadonlySet（既有 v1 调用形状）或任何无 protocolVersion 字段的对象 → v1。
  if (typeof arg === "object" && "protocolVersion" in arg) {
    return { protocolVersion: arg.protocolVersion ?? 1, knownSpeakers: arg.knownSpeakers };
  }
  return { protocolVersion: 1, knownSpeakers: arg as ReadonlySet<string> };
}

/**
 * 版本路由入口：v2 请求（`{ protocolVersion: 2 }`）解析为 DslLineV2，
 * 其余一切调用形状（缺省、knownSpeakers 集合、`{ protocolVersion: 1 }`）
 * 都进 v1 冻结解析器。缺省版本 = 1（服务端 dsl.protocol_version 默认值，
 * 本任务不翻默认）。
 */
export function parseDslLine(
  line: string,
  options: DslParseOptions & { protocolVersion: 2 },
): DslLineV2;
export function parseDslLine(
  line: string,
  options?: DslParseOptions | ReadonlySet<string>,
): DslLine;
export function parseDslLine(
  line: string,
  options?: DslParseOptions | ReadonlySet<string>,
): AnyDslLine {
  const resolved = resolveParseOptions(options);
  return resolved.protocolVersion === 2
    ? parseDslV2Line(line)
    : parseDslV1Line(line, resolved.knownSpeakers);
}

// ---------------------------------------------------------------------------
// v2 解析器
// ---------------------------------------------------------------------------

const V2_CHARACTER_POSITIONS: ReadonlySet<string> = new Set([
  "far_left",
  "left",
  "center",
  "right",
  "far_right",
]);

function isV2CharacterPosition(token: string): token is CharacterPosition {
  return V2_CHARACTER_POSITIONS.has(token);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/** 命令词判定：整词匹配，或后跟一个空白分隔（命令区 token 分隔，禁粘写）。 */
function hasCommandWord(line: string, word: string): boolean {
  if (line === word) return true;
  return line.startsWith(word) && line.length > word.length && isSpace(line[word.length]!);
}

/**
 * 从命令词之后的原文取固定数量 token，再跳过**一段**空白分隔，剩余全部
 * 作为正文逐字返回（不 trim 内部、不做任何归一化）。token 缺位时对应
 * 槽位为空串，由调用方按命令形状报错。
 */
function takeTokens(source: string, tokenCount: number): { tokens: string[]; body: string } {
  const tokens: string[] = [];
  let i = 0;
  for (let n = 0; n < tokenCount; n += 1) {
    while (i < source.length && isSpace(source[i]!)) i += 1;
    const start = i;
    while (i < source.length && !isSpace(source[i]!)) i += 1;
    tokens.push(source.slice(start, i));
  }
  let j = i;
  while (j < source.length && isSpace(source[j]!)) j += 1;
  return { tokens, body: source.slice(j) };
}

function missingBody(what: string, rawLine: string): DslProtocolError {
  return new DslProtocolError(
    "MISSING_BODY",
    `${what}缺少正文："${rawLine}"。`,
    {
      expected: "@say <角色id> <台词正文> / @n <旁白正文>（正文 = 固定 token 之后的剩余原文，逐字保留）",
      cause: "命令后的正文为空",
      fix: "在命令与参数之后写上单行正文",
    },
  );
}

function unknownV2Command(rawLine: string): DslProtocolError {
  return new DslProtocolError(
    "UNKNOWN_COMMAND",
    `无法识别的 v2 指令行 "${rawLine}"。`,
    {
      expected: DSL_COMMAND_LIST_V2,
      cause: "v2 每行都必须是 @ 指令；台词用 @say，旁白用 @n，正文里不再用冒号/括号标记角色",
      fix: "台词写 @say <角色id> <正文>；旁白写 @n <正文>；若是指令请核对拼写（命令区只用 ASCII）",
    },
  );
}

function invalidChParameter(message: string, rawLine: string): DslProtocolError {
  return new DslProtocolError(
    "INVALID_CH_PARAMETER",
    `${message}："${rawLine}"。`,
    {
      expected:
        "@ch <角色id> show [look=<外观id>] [position=<位置>]、" +
        "@ch <角色id> set look=<外观id> [position=<位置>]、" +
        "@ch <角色id> set position=<位置>、@ch <角色id> hide|exit|reset",
      cause: "参数必须是 key=value（只认 look/position），子命令与位置词逐字固定",
      fix: '例如 "@ch female_A show look=smile position=left"、"@ch female_A set position=center"',
    },
  );
}

function invalidDisplayNameLabel(message: string, rawLine: string): DslProtocolError {
  return new DslProtocolError(
    "INVALID_DISPLAY_LABEL",
    `${message}："${rawLine}"。`,
    {
      expected: "@name <角色id> set <单行名牌文本> / @name <角色id> reset",
      fix: '例如 "@name female_A set 神秘女子"；恢复初始名牌用 "@name female_A reset"',
    },
  );
}

/** @ch 参数区解析：key=value、只认 look/position、拒绝重复/未知/非法值。 */
function parseChParams(
  paramTokens: readonly string[],
  rawLine: string,
): { look?: string; position?: CharacterPosition } {
  let look: string | undefined;
  let position: CharacterPosition | undefined;
  for (const token of paramTokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      throw invalidChParameter(`ch 参数 "${token}" 不是 key=value 形式`, rawLine);
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (value === "") {
      throw invalidChParameter(`ch 参数 ${key}= 缺少取值`, rawLine);
    }
    if (key === "look") {
      if (look !== undefined) {
        throw invalidChParameter("look 参数重复出现", rawLine);
      }
      look = value;
    } else if (key === "position") {
      if (position !== undefined) {
        throw invalidChParameter("position 参数重复出现", rawLine);
      }
      if (!isV2CharacterPosition(value)) {
        throw invalidChParameter(
          `位置 "${value}" 非法（只能是 far_left|left|center|right|far_right）`,
          rawLine,
        );
      }
      position = value;
    } else {
      throw invalidChParameter(`未知 ch 参数 "${key}"（只允许 look/position）`, rawLine);
    }
  }
  return { ...(look !== undefined ? { look } : {}), ...(position !== undefined ? { position } : {}) };
}

/**
 * 解析一行完整的 v2 DSL（行允许首尾空白与 CRLF；正文逐字保留）。
 * 语法违规抛 DslProtocolError；任务能力与身份/资源语义在 compiler 校验。
 */
export function parseDslV2Line(rawLine: string): DslLineV2 {
  const line = rawLine.trim();
  if (line === "") {
    throw missingBody("空行", rawLine);
  }
  if (!line.startsWith("@")) {
    // v2 没有裸台词/裸旁白：冒号定位角色的旧写法是 v1 语法，v2 请求永不
    // 走 v1 语法（也不降级成旁白——降级会静默丢说话人）。
    throw new DslProtocolError(
      "UNKNOWN_COMMAND",
      `v2 指令行必须以 @ 开头，收到 "${line}"。`,
      {
        expected: DSL_COMMAND_LIST_V2,
        cause: "台词/旁白在 v2 也要带 @ 指令头；正文里不再用冒号标记说话人",
        fix: "台词写 @say <角色id> <正文>；旁白写 @n <正文>",
      },
    );
  }

  // 1. 表单三兄弟（v1 语义保留：提示可与 @? 粘写，全文 trim）。
  if (line.startsWith("@?")) return { kind: "form_start", prompt: line.slice(2).trim() };
  if (line.startsWith("@+")) return { kind: "form_option", text: line.slice(2).trim() };
  if (line.startsWith("@=")) return { kind: "form_input", placeholder: line.slice(2).trim() };
  if (line === "@/?") return { kind: "form_end" };

  // 2. 结束哨兵与结局行（与 v1 共享的冻结形状助手，两版语义不漂移）。
  const endSentinel = matchEndSentinel(line);
  if (endSentinel !== null) {
    return { kind: "segment_end", ...endSentinel };
  }
  const endingRaw = matchEndingEpilogueLine(line);
  if (endingRaw !== null) {
    return { kind: "ending_epilogue", raw: endingRaw };
  }
  if (hasCommandWord(line, "@end")) {
    throw new DslProtocolError(
      "SENTINEL_MISSING_REASON",
      `@end 缺少 reason（buffer|interaction|ending）："${line}"。`,
      {
        expected: "@end <nonce> <reason>，reason 取 buffer|interaction|ending 之一",
        cause: "end 后面必须跟 nonce 和 reason 两个词",
        fix: "从任务提示原样照抄 nonce，例如 @end 81ab buffer",
      },
    );
  }

  // 3. beat（精确匹配；带尾随内容即未知指令）。
  if (line === "@beat") return { kind: "beat" };

  // 4. 单资产参数指令（语义与 v1 相同）。
  const bgMatch = /^@bg\s+(\S+)\s*$/.exec(line);
  if (bgMatch !== null) return { kind: "background", assetId: bgMatch[1]! };
  const bgmMatch = /^@bgm\s+(\S+)\s*$/.exec(line);
  if (bgmMatch !== null) return { kind: "bgm", assetId: bgmMatch[1]! };
  const seMatch = /^@se\s+(\S+)\s*$/.exec(line);
  if (seMatch !== null) return { kind: "sound_effect", assetId: seMatch[1]! };
  if (line.startsWith("@bg") || line.startsWith("@bgm") || line.startsWith("@se")) {
    throw new DslProtocolError(
      "UNKNOWN_LINE",
      `无法解析的 bg/bgm/se 指令 "${line}"：缺少资源 id 或多了额外 token。`,
      {
        expected: "@bg <背景id>、@bgm <音乐id|stop>、@se <音效id>（id 逐字取自素材表，且只能是一个词）",
        cause: "指令与资源 id 之间必须有一个空格，id 后不能再有其他内容",
        fix: '例如 "@bg classroom_morning"、"@bgm stop"',
      },
    );
  }

  // 5. @say <characterId> <单行台词正文>（正文 = 1 个固定 token 后的剩余原文）。
  if (hasCommandWord(line, "@say")) {
    const { tokens, body } = takeTokens(line.slice("@say".length), 1);
    if (tokens[0] === "") throw missingBody("@say 缺少角色 id", rawLine);
    if (body === "") throw missingBody("@say 缺少台词正文", rawLine);
    return { kind: "say", characterId: tokens[0]!, text: body };
  }

  // 6. @n <单行旁白正文>。
  if (hasCommandWord(line, "@n")) {
    const { body } = takeTokens(line.slice("@n".length), 0);
    if (body === "") throw missingBody("@n 缺少旁白正文", rawLine);
    return { kind: "narration", text: body };
  }

  // 7. @name <characterId> set <名牌文本> | @name <characterId> reset。
  if (hasCommandWord(line, "@name")) {
    const { tokens, body } = takeTokens(line.slice("@name".length), 2);
    const characterId = tokens[0]!;
    const sub = tokens[1]!;
    if (characterId === "") {
      throw invalidDisplayNameLabel("@name 缺少角色 id", rawLine);
    }
    if (sub === "") {
      throw invalidDisplayNameLabel(`@name ${characterId} 缺少 set/reset 子命令`, rawLine);
    }
    if (sub === "reset") {
      if (body !== "") {
        throw invalidDisplayNameLabel(
          `@name ${characterId} reset 之后不能有其他内容（收到 "${body}"）`,
          rawLine,
        );
      }
      return { kind: "name_reset", characterId };
    }
    if (sub === "set") {
      if (body === "") {
        throw invalidDisplayNameLabel(`@name ${characterId} set 缺少名牌文本`, rawLine);
      }
      return { kind: "name_set", characterId, label: body };
    }
    throw invalidDisplayNameLabel(
      `@name 的子命令只能是 set 或 reset，收到 "${sub}"`,
      rawLine,
    );
  }

  // 8. @ch <characterId> <show|set|hide|exit|reset> [参数]。
  if (hasCommandWord(line, "@ch")) {
    const { tokens, body } = takeTokens(line.slice("@ch".length), 2);
    const characterId = tokens[0]!;
    const sub = tokens[1]!;
    if (characterId === "") {
      throw invalidChParameter("@ch 缺少角色 id", rawLine);
    }
    if (sub === "") {
      throw invalidChParameter(`@ch ${characterId} 缺少子命令（show|set|hide|exit|reset）`, rawLine);
    }
    const paramTokens = body === "" ? [] : body.split(/\s+/);
    if (sub === "hide" || sub === "exit" || sub === "reset") {
      if (paramTokens.length > 0) {
        throw invalidChParameter(`@ch ${characterId} ${sub} 不接受任何参数`, rawLine);
      }
      return { kind: `ch_${sub}` as "ch_hide" | "ch_exit" | "ch_reset", characterId };
    }
    if (sub === "show" || sub === "set") {
      const params = parseChParams(paramTokens, rawLine);
      if (sub === "set" && params.look === undefined && params.position === undefined) {
        throw invalidChParameter(
          `@ch ${characterId} set 至少要一个参数（look=… 或 position=…）`,
          rawLine,
        );
      }
      return { kind: sub === "show" ? "ch_show" : "ch_set", characterId, ...params };
    }
    throw invalidChParameter(
      `@ch 的子命令只能是 show|set|hide|exit|reset，收到 "${sub}"`,
      rawLine,
    );
  }

  // 9. 其余一切 @ 行（含粘写命令、全角命令、v1 独有语法）→ 响亮报错。
  throw unknownV2Command(line);
}
