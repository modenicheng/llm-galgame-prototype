/**
 * Gal DSL line parser — parses ONE complete, already-trimmed line into a
 * DslLine (docs/llm-outputs-refactor.md §42).
 *
 * Grammar (in check order). 核心规则：**指令行一律以 @ 开头；不以 @ 开头
 * 的行只能是台词或旁白**。旧裸写法（`?`/`+`/`=`/`/?`/`beat`/`bg`/`bgm`/
 * `se`/`ch`）已完全废弃：不再被接受为别名，命中即抛 RETIRED_ALIAS——
 * 静默接受会把中文正文误吞成指令，静默降级成台词又会造出幻影发言人，
 * 唯一安全的去向是响亮报错。
 *   @end <nonce> <reason>        → segment_end
 *   @ending <档位> <结尾词>      → ending_epilogue（仅 ending 哨兵后合法）
 *   @/?                          → form_end
 *   @? <prompt>                  → form_start
 *   @+ <text>                    → form_option
 *   @= <placeholder>             → form_input
 *   @beat                        → beat
 *   @bg|@bgm|@se <id>            → background | bgm | sound_effect
 *   @ch <id>:<variant> [position]→ character_cue set
 *   @ch <id> hide|show|exit      → character_cue hide/show/exit
 *   <speaker>[<visual>](<name>): <text> → dialogue
 *   旁白[:：] <text>             → narration（「旁白」自标注标签剥离，
 *                                   见 stripNarrationLabel；「旁白」是注册
 *                                   说话人时不适用）
 *   otherwise                    → narration
 *
 * 以 @ 开头但不匹配任何指令的行**不再静默降级为旁白/台词**（历史事故：
 * `@¬end 4607 buffer` 被当旁白播出、`@ch raspberry: 台词` 造出幻影发言
 * 人），而是抛 UNKNOWN_COMMAND，由修复回路带着结构化细节重试。
 *
 * `knownSpeakers` (optional, from the character registry) gates the
 * full-width-colon normalization: 「苏遥：台词」 only converts to dialogue
 * when 苏遥 is a registered speaker. The parser itself stays pure — the
 * caller decides which names count.
 *
 * Pure text → structured data. No runtime, wire, or LLM dependencies.
 */
import type { CharacterPosition } from "../../presentation/types.js";
import { DslProtocolError, DSL_COMMAND_LIST, ENDING_GRADES } from "./types.js";
import type {
  DialogueNameSpec,
  DialogueVisualSpec,
  DslLine,
  EndingGrade,
  SegmentEndReason,
  SegmentEndingEpilogue,
} from "./types.js";

const CHARACTER_POSITIONS: ReadonlySet<string> = new Set([
  "far_left",
  "left",
  "center",
  "right",
  "far_right",
]);

function isCharacterPosition(token: string): token is CharacterPosition {
  return CHARACTER_POSITIONS.has(token);
}

/**
 * True when the line looks like `keyword` / `keyword <rest>` (reserved prefix).
 * 词边界用 \s（含全角空格 U+3000/NBSP）：`ch　suyao: 台词` 若只认 ASCII
 * 空格会绕过废弃守卫、解析出幻影说话人（2026-09-17 独立审计 A1）。
 */
function hasKeywordPrefix(line: string, keyword: string): boolean {
  if (line === keyword) return true;
  if (!line.startsWith(keyword)) return false;
  return /^\s/.test(line.slice(keyword.length));
}

/**
 * 旧裸写法（无 @ 前缀的 ?/+/=//?/beat/bg/bgm/se/ch）已废弃：不再解析为
 * 指令，也不再静默降级为正文——裸 `? 一句问话` 若被当旁白播出、裸
 * `ch suyao:anxious` 若被当台词解析（说话人变 "ch suyao"）都是玩家可见
 * 事故。命中即响亮报错，让修复回路带模型改写为 @ 形式。
 */
function retiredAlias(line: string, atForm: string): DslProtocolError {
  return new DslProtocolError(
    "RETIRED_ALIAS",
    `旧的无 @ 写法 "${line}" 已废弃：所有指令必须以 @ 开头。`,
    {
      expected: "指令一律以 @ 开头；台词和旁白不加任何前缀符号",
      cause: "这是旧协议的裸写法，新协议只认 @ 形式",
      fix: `若想表达该指令，写作 ${atForm}；若是台词或旁白，直接写正文，不要以这些符号开头`,
    },
  );
}

const STAGE_CUE_EXPECTED =
  "@bg <背景id>、@bgm <音乐id|stop>、@se <音效id>（背景/BGM/音效 id 逐字取自素材表）";

/** 非 ASCII 资产 id（立绘变体槽出现中文 = 模型把台词写进了 ch 指令）。 */
function containsHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

/** @ 后的全角标点 → 半角（@？提示 → @?提示；@／? → @/?）。 */
const FULLWIDTH_FORM_PUNCT: Readonly<Record<string, string>> = {
  "？": "?",
  "＋": "+",
  "＝": "=",
  "／": "/",
};

/**
 * 「旁白」自标注标签剥离。实测（2026-09-18 思考档对照局）模型会把旁白
 * 写成 `旁白：正文` / `旁白: 正文`：全角形式把标签播进玩家正文，半角
 * 形式更造出 speaker=「旁白」的台词名牌。旁白行本身没有名字，标签是纯
 * 泄漏记号——除非「旁白」真的是注册说话人，确定性剥掉标签收进旁白正文。
 * 返回 null 表示不适用（无冒号、正文为空、或「旁白」已注册），交回严格
 * 解析。纯函数：parser 与生成器的修复上报共用，勿在两处重写正则。
 */
export function stripNarrationLabel(
  line: string,
  knownSpeakers?: ReadonlySet<string>,
): string | null {
  if (knownSpeakers?.has("旁白") === true) return null;
  const match = /^旁白\s*[:：]\s*(.+)$/.exec(line);
  return match !== null ? match[1]! : null;
}

/**
 * 台词尾缀旁白检测（仅观测，不做任何改写）。实测（2026-09-19 真机局）模型
 * 会把动作旁白缀在台词同一行尾部（`树莓娘[joyful]: 定稿啦。她拈一颗塞进嘴
 * 里，又推两颗到我手边。`），叙述被当作台词用该角色配音念出。与「旁白：」
 * 标签不同，这里**无法**确定性拆分：句末后接「她/他」起句也可能是角色在说
 * 第三者（`你去问她。她会答应的。`），自动剥离会吃掉正常台词——所以只供
 * 监控计数，走 onRepair 通道上报（kind: "tail_narration"），播放不变、不触
 * 发修复重试。启发式刻意排除省略号边界（`……她走得也太快了` 是合法台词的
 * 实测误报类）；无代词形态（`定稿啦。窗外铃响了。`）检不出，接受漏报。
 * 纯函数：与生成器的上报共用，勿在两处重写正则。
 */
const DIALOGUE_TAIL_NARRATION_RE = /[。！？][”’」』"']?\s*(?:她|他)/;

export function detectDialogueTailNarration(text: string): boolean {
  return DIALOGUE_TAIL_NARRATION_RE.test(text);
}

/**
 * 全角/半角指令前缀兼容（仅行首指令意图位）：＠→@，@ 后紧跟的全角
 * ？＋＝／ 转半角。正文行永不以 @/＠ 开头，普通 `？` 开头的旁白不受影响。
 */
export function normalizeDslCommandPrefix(line: string): string {
  if (line.startsWith("＠")) line = `@${line.slice(1)}`;
  if (line.startsWith("@") && line.length > 1) {
    const mapped = FULLWIDTH_FORM_PUNCT[line[1]!];
    if (mapped !== undefined) line = `@${mapped}${line.slice(2)}`;
  }
  return line;
}

const VISUAL_BRACKET_EXPECTED =
  "台词头只允许 [变体]、[spriteSet:变体]、[|位置]、[spriteSet:变体|位置] 或 []（复位）；位置只能是 far_left|left|center|right|far_right";

function invalidVisualBracket(content: string, why: string): DslProtocolError {
  return new DslProtocolError(
    "INVALID_VISUAL_BRACKET",
    `无效的视觉括号 "[${content}]"：${why}`,
    {
      expected: VISUAL_BRACKET_EXPECTED,
      fix: '例如 "苏遥[anxious|left]: 台词"；不需要变化时整个省略 [ ] 槽',
    },
  );
}

/** 变体槽出现已注册角色 id（如 `[raspberry|thinking]`）：两个槽写反了。 */
function swappedVisualSlots(content: string, speakerId: string): DslProtocolError {
  return new DslProtocolError(
    "INVALID_VISUAL_BRACKET",
    `无效的视觉括号 "[${content}]"：变体槽放了角色 id "${speakerId}"，它不是立绘变体。`,
    {
      expected: VISUAL_BRACKET_EXPECTED,
      cause: "两个槽写反了：竖线左侧应是立绘变体名（素材表英文 id），右侧应是位置词",
      fix: `去掉角色 id 槽，写成 "${speakerId}[变体]: 台词" 或 "${speakerId}[变体|位置]: 台词"`,
    },
  );
}

/**
 * Parse the `[ ... ]` visual slot of a dialogue header (docs §8–§9, §12, §15).
 * Undefined → no visual slot. "" (`[]`) → visual reset. Otherwise
 * `[variant]`, `[spriteSet:variant]`, `[|position]`, `[spriteSet:variant|position]`.
 */
function parseVisual(
  content: string | undefined,
  knownSpeakers?: ReadonlySet<string>,
): DialogueVisualSpec {
  if (content === undefined) {
    return { hasVisual: false, resetVisual: false };
  }
  if (content === "") {
    return { hasVisual: true, resetVisual: true };
  }
  const segments = content.split("|");
  // At most one "|"; a trailing "|" (`[a|]`) or an all-empty slot (`[|]`)
  // is forbidden. `[|position]` is the ONE allowed empty-first form.
  if (segments.length > 2) {
    throw invalidVisualBracket(content, "只允许一个竖线，左侧是立绘、右侧是位置");
  }
  const positionToken = segments[1];
  if (positionToken === "") {
    throw invalidVisualBracket(content, "竖线右侧（位置）不能为空");
  }
  const spec: DialogueVisualSpec = { hasVisual: true, resetVisual: false };
  const first = segments[0]!;
  if (first === "") {
    // `[|position]` — position-only form; positionToken must exist and be valid.
    if (positionToken === undefined || positionToken.includes(":")) {
      throw invalidVisualBracket(content, "位置段不能包含冒号");
    }
    if (!isCharacterPosition(positionToken)) {
      throw invalidVisualBracket(content, "位置必须是 far_left|left|center|right|far_right");
    }
    spec.position = positionToken;
    return spec;
  }
  const colonIndex = first.indexOf(":");
  if (colonIndex !== -1) {
    const spriteSet = first.slice(0, colonIndex);
    const variant = first.slice(colonIndex + 1);
    if (spriteSet === "" || variant === "" || variant.includes(":")) {
      throw invalidVisualBracket(content, "spriteSet:variant 中冒号必须恰好一个且两侧非空");
    }
    spec.spriteSet = spriteSet;
    spec.variant = variant;
  } else {
    spec.variant = first;
  }
  if (positionToken !== undefined) {
    if (positionToken.includes(":")) {
      throw invalidVisualBracket(content, "位置段不能包含冒号");
    }
    if (!isCharacterPosition(positionToken)) {
      if (knownSpeakers?.has(first) === true) {
        throw swappedVisualSlots(content, first);
      }
      throw invalidVisualBracket(content, "位置必须是 far_left|left|center|right|far_right");
    }
    spec.position = positionToken;
  } else if (knownSpeakers?.has(first) === true) {
    // `[raspberry]` — a registered id is never a variant name; catch it here
    // instead of letting the catalog silently drop the cue later.
    throw swappedVisualSlots(content, first);
  }
  return spec;
}

/**
 * Parse the `( ... )` name slot of a dialogue header (docs §10, §13).
 * Undefined → no name slot. "" (`()`) → name reset. Otherwise a display
 * name (non-empty after trim).
 */
function parseName(content: string | undefined): DialogueNameSpec {
  if (content === undefined) {
    return { hasName: false, resetName: false };
  }
  if (content === "") {
    return { hasName: true, resetName: true };
  }
  const displayName = content.trim();
  if (displayName === "") {
    throw new DslProtocolError(
      "INVALID_NAME_PAREN",
      `无效的名称括号 "(${content})"：只允许 (显示名) 或 () 复位。`,
      {
        expected: "(中文显示名) 覆盖玩家看到的名称；() 恢复默认名",
        fix: '例如 "苏遥(神秘女子): 台词"；不要把英文 id 放进名称槽',
      },
    );
  }
  return { hasName: true, resetName: false, displayName };
}

/**
 * Parse ONE complete DSL line into a DslLine. Throws DslProtocolError on
 * violations.
 *
 * `knownSpeakers`: registered speaker names (script names / character ids
 * from the asset registry). When provided, the full-width-colon
 * normalization only fires for a prefix that is a registered speaker —
 * 「苏遥：台词」 converts, 「警告：危险」 stays narration. Omit it to disable
 * the normalization entirely (conservative: no guessing).
 */
export function parseDslLine(rawLine: string, knownSpeakers?: ReadonlySet<string>): DslLine {
  // Callers are expected to trim, but be defensive (also strips "\r").
  const line = normalizeDslCommandPrefix(rawLine.trim());

  // 1. segment end sentinel: @end <nonce> <reason>
  const endMatch = /^@end\s+(\S+)(?:\s+(\S+))?\s*$/.exec(line);
  if (endMatch !== null) {
    const nonce = endMatch[1]!;
    const reasonToken = endMatch[2];
    if (reasonToken === undefined) {
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
    if (reasonToken !== "buffer" && reasonToken !== "interaction" && reasonToken !== "ending") {
      throw new DslProtocolError(
        "SENTINEL_INVALID_REASON",
        `@end 的 reason 必须是 buffer|interaction|ending，收到 "${reasonToken}"。`,
        {
          expected: "@end <nonce> <reason>，reason 取 buffer|interaction|ending 之一",
          fix: `把 "${reasonToken}" 换成 buffer、interaction 或 ending`,
        },
      );
    }
    const reason: SegmentEndReason = reasonToken;
    return { kind: "segment_end", nonce, reason };
  }

  // 1.5 ending epilogue: `@ending <档位> <结尾词>`。只允许紧跟在 ending
  // 哨兵之后（状态判定在 segment-validator）；这里只认行形状。前视断言
  // 保证 `@ending_title`、`@endingHE` 之类粘连写法不误匹配——它们落进
  // UNKNOWN_COMMAND（在 strip-continue 白名单里，可续写救回）。
  if (/^@ending(?:\s|$)/.test(line)) {
    return { kind: "ending_epilogue", raw: line.slice("@ending".length).trim() };
  }

  // 2. form end (exact) — the bare `/?` alias is retired.
  if (line === "@/?" || line === "/?") {
    if (line === "/?") throw retiredAlias(line, "`@/?`");
    return { kind: "form_end" };
  }

  // 3–5. form prefixes `@?` / `@+` / `@=`, then any whitespace, then the
  // rest. Empty rest is allowed here; the group builder rejects it later.
  // The bare `?`/`+`/`=` aliases are retired.
  if (line === "?" || hasKeywordPrefix(line, "?")) throw retiredAlias(line, "`@? <提示>`");
  if (line === "+" || hasKeywordPrefix(line, "+")) throw retiredAlias(line, "`@+ <选项>`");
  if (line === "=" || hasKeywordPrefix(line, "=")) throw retiredAlias(line, "`@= <占位文本>`");
  if (line.startsWith("@?")) return { kind: "form_start", prompt: line.slice(2).trim() };
  if (line.startsWith("@+")) return { kind: "form_option", text: line.slice(2).trim() };
  if (line.startsWith("@=")) return { kind: "form_input", placeholder: line.slice(2).trim() };

  // 6. beat — the bare `beat` alias is retired (exact word or word+space).
  if (line === "@beat") return { kind: "beat" };
  if (line === "beat" || hasKeywordPrefix(line, "beat")) throw retiredAlias(line, "`@beat`");

  // 7. stage cues: @bg / @bgm / @se (bgm stop is a valid assetId "stop").
  const bgMatch = /^@bg\s+(\S+)\s*$/.exec(line);
  if (bgMatch !== null) return { kind: "background", assetId: bgMatch[1]! };
  const bgmMatch = /^@bgm\s+(\S+)\s*$/.exec(line);
  if (bgmMatch !== null) return { kind: "bgm", assetId: bgmMatch[1]! };
  const seMatch = /^@se\s+(\S+)\s*$/.exec(line);
  if (seMatch !== null) return { kind: "sound_effect", assetId: seMatch[1]! };
  if (
    hasKeywordPrefix(line, "bg") ||
    hasKeywordPrefix(line, "bgm") ||
    hasKeywordPrefix(line, "se")
  ) {
    throw retiredAlias(line, "`@bg <背景id>` / `@bgm <音乐id>` / `@se <音效id>`");
  }
  if (
    hasKeywordPrefix(line, "@bg") ||
    hasKeywordPrefix(line, "@bgm") ||
    hasKeywordPrefix(line, "@se")
  ) {
    throw new DslProtocolError(
      "UNKNOWN_LINE",
      `无法解析的 bg/bgm/se 指令 "${line}"：缺少资源 id。`,
      {
        expected: STAGE_CUE_EXPECTED,
        cause: "指令与资源 id 之间必须有一个空格，且 id 只能是一个词",
        fix: '例如 "@bg classroom_morning"、"@bgm stop"',
      },
    );
  }

  // 8. character cue: @ch <id>:<variant> [position] | @ch <id> hide|show|exit.
  // The colon may carry surrounding whitespace — a frequent LLM slip
  // (`@ch raspberry: uneasy center`) — because variant/position can never
  // contain spaces, the tight form is always recoverable.
  const chSetMatch = /^@ch\s+([^:\s]+)\s*:\s*(\S+)(?:\s+(\S+))?\s*$/.exec(line);
  if (chSetMatch !== null) {
    const characterId = chSetMatch[1]!;
    const variant = chSetMatch[2]!;
    const positionToken = chSetMatch[3];
    if (knownSpeakers?.has(variant) === true || variant === characterId) {
      // Observed in the wild: `@ch raspberry:raspberry` — same swapped-slot
      // family as the dialogue-header bracket.
      throw new DslProtocolError(
        "INVALID_CH_CUE",
        `ch 指令的变体槽放了角色 id "${variant}"：它不是立绘变体。`,
        {
          expected: "@ch <角色内部id>:<立绘变体> [位置]",
          cause: "变体槽应是素材表里的英文表情 id（如 smile、angry），不是角色 id",
          fix: `例如 "@ch ${characterId}:smile"`,
        },
      );
    }
    if (containsHan(variant)) {
      // Observed failure: `@ch raspberry: 一句台词` — the model wanted a
      // dialogue line but reached for the ch command. Fail loudly with the
      // dialogue format instead of emitting a cue with a garbage variant.
      throw new DslProtocolError(
        "INVALID_CH_CUE",
        `ch 指令的立绘变体槽出现中文 "${variant}"：变体必须是素材表里的英文 id。`,
        {
          expected: "@ch <角色内部id>:<立绘变体> [位置]",
          cause: "这几乎总是一句被写成 ch 指令的台词——台词行不能以 @ 开头",
          fix: `台词请写成 "角色名[变体]: 台词"（不带 @），例如 "raspberry[smile]: 台词"；若确实是立绘指令，写 "@ch ${characterId}:<变体>"`,
        },
      );
    }
    if (positionToken !== undefined) {
      if (!isCharacterPosition(positionToken)) {
        throw new DslProtocolError(
          "INVALID_CH_CUE",
          `无效的 ch 位置 "${positionToken}"（@ch <id>:<variant> [position]）。`,
          {
            expected: "位置只能是 far_left|left|center|right|far_right",
            fix: `例如 "@ch ${characterId}:<变体> left"`,
          },
        );
      }
      return {
        kind: "character_cue",
        characterId,
        variant,
        position: positionToken,
        action: "set",
      };
    }
    return { kind: "character_cue", characterId, variant, action: "set" };
  }
  const chShowMatch = /^@ch\s+(\S+)\s+(hide|show|exit)\s*$/.exec(line);
  if (chShowMatch !== null) {
    const characterId = chShowMatch[1]!;
    const actionToken = chShowMatch[2]!;
    if (actionToken === "exit") {
      return { kind: "character_cue", characterId, action: "exit" };
    }
    const action: "hide" | "show" = actionToken === "hide" ? "hide" : "show";
    return { kind: "character_cue", characterId, action };
  }
  if (hasKeywordPrefix(line, "ch")) {
    // Bare `ch …` is a retired alias — never a dialogue speaker, never a
    // command (the @-less form once produced the phantom speaker "ch suyao").
    throw retiredAlias(
      line,
      "`@ch <角色内部id>:<立绘变体> [位置]` 或 `@ch <角色内部id> hide|show|exit`",
    );
  }
  if (hasKeywordPrefix(line, "@ch")) {
    throw new DslProtocolError(
      "INVALID_CH_CUE",
      `无效的 ch 指令 "${line}"。`,
      {
        expected: "@ch <角色内部id>:<立绘变体> [位置] 或 @ch <id> hide|show|exit",
        cause: "id 后必须紧跟冒号和变体（变体为素材表英文 id），或跟 hide/show/exit",
        fix: '例如 "@ch suyao:anxious left"、"@ch suyao exit"',
      },
    );
  }

  // Any other line starting with "@" claims command intent — it must never
  // degrade into dialogue or narration (historical incidents: `@¬end 4607
  // buffer` played as narration, `@ch raspberry: …` invented a phantom
  // speaker). Unknown @ lines fail loudly with the command list instead.
  if (line.startsWith("@")) {
    const dialogueShaped =
      /^@[^：:\s]{1,24}(?:\[[^\]]*\])?(?:\([^)]*\))?[:：]/.exec(line) !== null;
    throw new DslProtocolError(
      "UNKNOWN_COMMAND",
      `无法识别的 @ 指令 "${line}"。`,
      dialogueShaped
        ? {
            expected: DSL_COMMAND_LIST,
            cause: "台词行不能以 @ 开头——@ 只用于指令行",
            fix: "去掉行首的 @，写成 角色名[变体]: 台词（普通台词行没有前缀符号）",
          }
        : {
            expected: DSL_COMMAND_LIST,
            cause: "以 @ 开头的行必须是指令，且指令拼写逐字固定",
            fix: "核对指令拼写；如果是台词或旁白，去掉行首的 @ 直接写正文",
          },
    );
  }

  // 8.5 旁白自标注标签：`旁白：正文` 带标签播出、「旁白: 正文」造出
  // speaker=「旁白」的名牌——都在玩家面前泄漏机器记号。确定性剥离。
  const narrationLabel = stripNarrationLabel(line, knownSpeakers);
  if (narrationLabel !== null) {
    return { kind: "narration", text: narrationLabel };
  }

  // 9. dialogue: <speaker>[<visual>](<name>): <text>
  // A full-width "：" as the delimiter is a high-frequency Chinese LLM
  // output. When it sits exactly in the delimiter position AND the prefix
  // is a registered speaker (knownSpeakers), normalize it to ASCII —
  // otherwise the line silently degrades into narration and the
  // speaker/[visual] syntax leaks into player-visible text. Speaker
  // membership replaces the earlier text-shape heuristic, which could not
  // tell 「苏遥：台词」 from narration like 「警告：危险」. The replacement
  // targets the colon AT the delimiter position only, so a ： inside
  // [visual]/(name) neither tears the line nor blocks normalization.
  const fullwidthDelimiter =
    /^([^，。！？；、…："'‘’“”「」『』（）()[\]{},.]{1,24})(?:\[[^\]]*\])?(?:\([^)]*\))?：/;
  const delimiterMatch = fullwidthDelimiter.exec(line);
  const normalizeDelimiter =
    delimiterMatch !== null &&
    knownSpeakers !== undefined &&
    knownSpeakers.has(delimiterMatch[1]!.trim());
  const dialogueSource =
    delimiterMatch !== null && normalizeDelimiter
      ? `${delimiterMatch[0].slice(0, -1)}:${line.slice(delimiterMatch[0].length)}`
      : line;
  const dialogueMatch = /^([^\[\]:]+?)(?:\[([^\]]*)\])?(?:\(([^)]*)\))?:\s*(.+)$/.exec(
    dialogueSource,
  );
  if (dialogueMatch !== null) {
    const speaker = dialogueMatch[1]!.trim();
    const text = dialogueMatch[4]!;
    if (speaker === "旁白" && knownSpeakers?.has("旁白") !== true) {
      // 带括号槽的变体（`旁白[smile]: …`）逃过了 8.5 的标签正则——台词
      // 已解析成形，按说话人兜底，同样转旁白，「旁白」不上名牌。
      return { kind: "narration", text };
    }
    // A ： inside [visual]/(name) is the same LLM habit — normalize so
    // `苏遥[suit：calm]：你好` keeps its spriteSet:variant split.
    const visualSource = dialogueMatch[2]?.replace(/：/g, ":");
    const nameSource = dialogueMatch[3]?.replace(/：/g, ":");
    return {
      kind: "dialogue",
      speaker,
      text,
      visual: parseVisual(visualSource, knownSpeakers),
      name: parseName(nameSource),
    };
  }

  // 10. narration
  return { kind: "narration", text: line };
}

// ---------------------------------------------------------------------------
// @ending epilogue token walk (结局元数据)
// ---------------------------------------------------------------------------

/** 结尾词硬上限：超长截断，不报错（元数据永远不炸段）。 */
export const ENDING_TITLE_MAX_CHARS = 32;

/**
 * 哨兵 reason 词的回声：模型偶发把整条哨兵格式抄进 @ending 行
 * （`@ending 81ab ending 樱花`）。在结尾词开始之前，这些词与 nonce
 * 一样静默跳过。
 */
const EPILOGUE_ECHO_TOKENS: ReadonlySet<string> = new Set([
  "buffer",
  "interaction",
  "ending",
]);

/**
 * 把 `@ending` 行的剩余原文解析成档位/结尾词（确定性、宽容，永不报错）：
 *
 *   @ending HE 樱花与约定的终章   → { grade: "HE", title: "樱花与约定的终章" }
 *   @ending 樱花与约定的终章      → { title: "…" }（档位走缺省 NE）
 *   @ending 81ab HE 樱花          → nonce 回声跳过 → { grade: "HE", title: "樱花" }
 *   @ending HE                    → { grade: "HE" }（结尾词回退「剧终」）
 *   @ending                       → {}（两项全缺省）
 *
 * 从左到右走 token：档位未定时命中词表 → 记档位；结尾词未开始时命中
 * nonce / reason 回声 → 跳过；第一个其他 token 起，全部（含该 token）
 * 作为结尾词——结尾词一旦开始就不再吃档位，标题里出现 HE/BE 等词也不会
 * 被劫走。结尾词超长按码点截断到 ENDING_TITLE_MAX_CHARS。
 */
export function interpretEndingEpilogue(
  raw: string,
  expectedNonce: string,
): SegmentEndingEpilogue {
  const tokens = raw.trim().split(/\s+/).filter((token) => token !== "");
  let grade: EndingGrade | undefined;
  const titleTokens: string[] = [];
  for (const token of tokens) {
    if (titleTokens.length === 0) {
      if (grade === undefined && (ENDING_GRADES as readonly string[]).includes(token)) {
        grade = token as EndingGrade;
        continue;
      }
      if (token === expectedNonce || EPILOGUE_ECHO_TOKENS.has(token)) {
        continue;
      }
    }
    titleTokens.push(token);
  }
  if (titleTokens.length === 0) {
    return grade !== undefined ? { grade } : {};
  }
  const joined = titleTokens.join(" ");
  const title =
    [...joined].length > ENDING_TITLE_MAX_CHARS
      ? [...joined].slice(0, ENDING_TITLE_MAX_CHARS).join("")
      : joined;
  return { ...(grade !== undefined ? { grade } : {}), title };
}
