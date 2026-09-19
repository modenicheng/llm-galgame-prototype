/**
 * 任务协议能力卡（C4，计划 §5.2）——命令能力、结束方式的唯一数据源。
 *
 * 每个请求由任务类型派生一张卡；实际 validator（compileSegmentV2 的
 * 任务能力校验步）与修复指令模板都引用同一份定义，禁止在 task template
 * 另写一份矛盾的完整 DSL（prompt 侧注入归 C6，本模块只提供数据）。
 *
 * 表（计划 §5.2 逐行）：
 * | 任务 | 文本/舞台能力 | 结束约束 |
 * | opening | @say/@n、本场角色操作、场景资源、表单 | interaction 或 ending，不使用 buffer |
 * | continuation | 与 opening 同一语法 | buffer / interaction / ending |
 * | branch_prefetch | 台词、旁白、受控舞台；不生成表单 | buffer |
 * | input_response | 台词、旁白、既有输入回应允许的角色/音效操作 | buffer |
 * | input_bridge | 仅旁白及原有 bridge 明确允许的过渡能力；不代玩家发声 | 保留 bridge 当前协议收束方式（buffer 哨兵），显式声明而非借完整 writer 卡 |
 * | protocol/closing repair | 继承原任务能力，限定未提交尾部 | 不改变 nonce、玩家选择或已提交前缀 |
 *
 * memory/director/recap 任务不获得 actor DSL 生成职责（各自结构化协议），
 * 不在本表内。
 */
import type { DslDiagnosticV2, DslLineV2, SegmentEndReason } from "./types.js";

/** v2 语法命令名全集（计划 §4.1 逐条）。 */
export const DSL_V2_COMMANDS = [
  "@say",
  "@n",
  "@name",
  "@ch",
  "@bg",
  "@bgm",
  "@se",
  "@beat",
  "@?",
  "@+",
  "@=",
  "@/?",
  "@end",
  "@ending",
] as const;

export type DslV2Command = (typeof DSL_V2_COMMANDS)[number];

/** actor 写手任务类型（memory/director/recap 不在此列）。 */
export type DslTaskType =
  | "opening"
  | "continuation"
  | "branch_prefetch"
  | "input_response"
  | "input_bridge"
  | "protocol_repair";

/** 一张任务协议卡：该任务允许的 v2 命令与结束方式。 */
export interface DslTaskCapability {
  task: DslTaskType;
  /** 允许的 v2 命令（其余命令在该任务中是能力违规）。 */
  commands: readonly DslV2Command[];
  /** 允许的 @end reason（哨兵校验与能力校验共用）。 */
  endReasons: readonly SegmentEndReason[];
  /** 是否允许 @ending（等价于 endReasons 含 "ending"；卡片上显式声明，C6 消费）。 */
  ending: boolean;
  /** 能力范围的人类可读描述（卡片/修复模板用；不含人物卡内容）。 */
  scope: string;
}

const WRITER_TEXT_STAGE: readonly DslV2Command[] = [
  "@say",
  "@n",
  "@name",
  "@ch",
  "@bg",
  "@bgm",
  "@se",
  "@beat",
];
const FORM_COMMANDS: readonly DslV2Command[] = ["@?", "@+", "@=", "@/?"];
const CLOSE_COMMANDS: readonly DslV2Command[] = ["@end", "@ending"];

/** opening：@say/@n、本场角色操作、场景资源、表单；interaction 或 ending（不用 buffer）。 */
const OPENING: DslTaskCapability = {
  task: "opening",
  commands: [...WRITER_TEXT_STAGE, ...FORM_COMMANDS, ...CLOSE_COMMANDS],
  endReasons: ["interaction", "ending"],
  ending: true,
  scope: "台词、旁白、本场角色操作、场景资源与交互表单",
};

/** continuation：与 opening 同一语法；buffer / interaction / ending。 */
const CONTINUATION: DslTaskCapability = {
  ...OPENING,
  task: "continuation",
  endReasons: ["buffer", "interaction", "ending"],
  scope: "与 opening 同一语法（台词、旁白、角色操作、场景资源、表单）",
};

/** branch_prefetch：台词、旁白、受控舞台；不生成表单；buffer。 */
const BRANCH_PREFETCH: DslTaskCapability = {
  task: "branch_prefetch",
  commands: [...WRITER_TEXT_STAGE, "@end"],
  endReasons: ["buffer"],
  ending: false,
  scope: "台词、旁白与受控舞台；不生成表单",
};

/**
 * input_response：台词、旁白、既有输入回应允许的角色/音效操作；buffer。
 * （场景资源 @bg/@bgm 不在表内——玩家刚做出输入，镜头不应被回应段改写。）
 */
const INPUT_RESPONSE: DslTaskCapability = {
  task: "input_response",
  commands: ["@say", "@n", "@name", "@ch", "@se", "@beat", "@end"],
  endReasons: ["buffer"],
  ending: false,
  scope: "台词、旁白与既有输入回应允许的角色/音效操作",
};

/**
 * input_bridge：仅旁白及原有 bridge 明确允许的过渡能力；不代玩家发声。
 * bridge 收束保留当前协议方式（@end nonce buffer，唯一固定尾）；过渡能力
 * 按两侧现状保守固定为旁白 + 节拍 + 场景资源，C6 落地 bridge 实际允许集
 * 合的测试固定时再按需收紧/放宽（不借此次重构扩大 bridge 权限）。
 */
const INPUT_BRIDGE: DslTaskCapability = {
  task: "input_bridge",
  commands: ["@n", "@beat", "@bg", "@bgm", "@se", "@end"],
  endReasons: ["buffer"],
  ending: false,
  scope: "仅旁白与过渡场景资源；不代玩家发声",
};

const CAPABILITIES: Readonly<Record<DslTaskType, DslTaskCapability>> = {
  opening: OPENING,
  continuation: CONTINUATION,
  branch_prefetch: BRANCH_PREFETCH,
  input_response: INPUT_RESPONSE,
  input_bridge: INPUT_BRIDGE,
  // protocol_repair 经 protocolRepairCapability(base) 派生，不单发整卡；
  // 占位指向 opening 仅为类型完整，直接调用应走派生函数。
  protocol_repair: { ...OPENING, task: "protocol_repair", scope: "继承原任务能力（经派发函数）" },
};

/** 任务能力卡（单源数据；validator 与修复模板同源引用）。 */
export function dslTaskCapability(task: DslTaskType): DslTaskCapability {
  return CAPABILITIES[task];
}

/**
 * 协议/收尾修复卡：**继承原任务能力**，限定未提交尾部——不新增命令、
 * 不改变 nonce、玩家选择或已提交前缀。endReasons 与命令集原样继承；
 * @ending 仅当原任务允许 ending 收束时保留。
 */
export function protocolRepairCapability(baseTask: DslTaskType): DslTaskCapability {
  const base = dslTaskCapability(baseTask);
  return {
    ...base,
    task: "protocol_repair",
    scope: `继承 ${baseTask} 的能力，仅限未提交尾部；不改变 nonce、玩家选择或已提交前缀`,
  };
}

/** 行 → 命令名（能力校验的映射；@name 两种形式都映射到 @name）。 */
export function commandOfDslLineV2(line: DslLineV2): DslV2Command {
  switch (line.kind) {
    case "say":
      return "@say";
    case "narration":
      return "@n";
    case "name_set":
    case "name_reset":
      return "@name";
    case "ch_show":
    case "ch_set":
    case "ch_hide":
    case "ch_exit":
    case "ch_reset":
      return "@ch";
    case "background":
      return "@bg";
    case "bgm":
      return "@bgm";
    case "sound_effect":
      return "@se";
    case "beat":
      return "@beat";
    case "form_start":
      return "@?";
    case "form_option":
      return "@+";
    case "form_input":
      return "@=";
    case "form_end":
      return "@/?";
    case "ending_epilogue":
      return "@ending";
    case "segment_end":
      return "@end";
  }
}

/** 该任务是否允许此命令（validator 的任务能力校验步）。 */
export function capabilityAllowsCommand(
  capability: DslTaskCapability,
  command: DslV2Command,
): boolean {
  return capability.commands.includes(command);
}

/**
 * 从能力卡 + 诊断生成修复指令（§4.3：修复模板从同一 capability card
 * 生成，不硬编码示例角色）。只引用有界合法值，不携带人物卡。
 */
export function formatV2RepairInstruction(
  capability: DslTaskCapability,
  diagnostics: readonly DslDiagnosticV2[],
  expectedNonce: string,
): string {
  const lines: string[] = [
    `你上一段输出未通过 ${capability.task} 任务的协议校验，请只重写未提交的尾部，不要重复已提交内容。`,
    `本任务允许的指令：${capability.commands.join(" ")}；结束哨兵：@end <nonce> ${capability.endReasons.join("|")}（nonce 原样照抄 ${expectedNonce}）。`,
  ];
  if (capability.ending) {
    lines.push("若以 ending 收束：哨兵后另起一行 @ending <TE|HE|NE|BE> <结尾标题>，之后不能再输出其他行。");
  }
  for (const diagnostic of diagnostics.slice(0, 3)) {
    const legal =
      diagnostic.legalValues !== undefined && diagnostic.legalValues.length > 0
        ? `；合法取值：${diagnostic.legalValues.slice(0, 12).join("、")}`
        : "";
    lines.push(
      `第 ${diagnostic.line} 行 [${diagnostic.code}] ${diagnostic.message}${legal}。`,
    );
  }
  return lines.join("\n");
}
