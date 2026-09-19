/**
 * 任务协议卡生成（C6，计划 §5.2/§5.3/§5.4）——双分支可移植，无产品线内容。
 *
 * 每个请求按任务类型从**能力卡**（`capabilities.ts` 单源）派生一张协议卡：
 * 规则 + 可执行示例 + 来源信息（provenance）。示例人物与素材全部从实际
 * registry/资源目录选出——不硬编码内容包专名，不硬塞示例角色；空 NPC
 * cast 生成 narration-only 示例。`prompts/dsl-protocol.txt` 只作为语法
 * 说明的基座，本卡是任务级规则的唯一来源（不再有第二份手写 grammar）。
 *
 * 协议双版本：protocolVersion 1 → legacy 行式语法（台词头/旁白/裸行式
 * 指令）；2 → v2 显式 @ 指令。两版卡片语义同源（同一能力表），运行时翻
 * 版本时无需重写生成器。
 */
import {
  dslTaskCapability,
  protocolRepairCapability,
  type BaseDslTaskType,
  type DslTaskCapability,
  type DslV2Command,
} from "../../core/protocol/gal-dsl/capabilities.js";
import type {
  CastContext,
  CharacterDefinition,
  CharacterRegistry,
} from "../../core/characters/types.js";
import type { AssetCatalog } from "../../core/assets/types.js";

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export interface ProtocolCardInput {
  /** 任务类型（能力卡单源派生）。 */
  task: BaseDslTaskType;
  /** registry（characters.yaml / roster 真源；示例人物从这里选）。 */
  registry: CharacterRegistry;
  /** 本段 cast（允许发声/场景参与者；空 allowedSpeakerIds = 仅旁白）。 */
  cast: CastContext;
  /** 资源目录（示例素材 id 从这里选，不列文件路径）。 */
  assets: AssetCatalog;
  /** DSL 协议版本（1 = legacy 行式；2 = v2 显式指令）。 */
  protocolVersion: 1 | 2;
  /** 修复请求：按 protocolRepairCapability(task) 派生（继承原任务能力）。 */
  repair?: boolean;
}

export interface ProtocolCardExample {
  /** 示例用途（人类可读标签）。 */
  label: string;
  /** 可执行示例段（示例 nonce 以 <nonce> 占位；人物/素材为真实值）。 */
  text: string;
}

/** 来源信息（§5.4：显式携带来源版本，不做隐式拼接）。 */
export interface ProtocolCardProvenance {
  protocolVersion: 1 | 2;
  /** roster revision（身份版本，与本请求 GenerationIdentity 同源）。 */
  rosterRevision: string;
  scopeId: string;
  /** 能力卡来源任务（repair 卡为 protocol_repair，base 记录原任务）。 */
  capabilityTask: string;
  baseTask: BaseDslTaskType;
  /** 能力单源模块（审计定位）。 */
  capabilitySource: string;
  /** 示例引用的角色 ID（可追溯到 roster）。 */
  exampleCharacterIds: readonly string[];
  /** 示例引用的素材 ID（可追溯到资源目录）。 */
  exampleAssetIds: readonly string[];
}

export interface ProtocolCard {
  /** 卡对应的任务（repair 卡为 protocol_repair）。 */
  task: string;
  capability: DslTaskCapability;
  /** 规则正文（允许能力 + 结束方式；由能力卡生成，非手写）。 */
  rules: string;
  /** 可执行示例（每个示例都可被真实 parser/compiler 解析编译）。 */
  examples: readonly ProtocolCardExample[];
  provenance: ProtocolCardProvenance;
  /** 整卡文本（注入 prompt 的最终形态；组装规则固定，确定性输出）。 */
  text: string;
}

// ---------------------------------------------------------------------------
// v1 表面形态映射（能力命令名 → legacy 行式语法的说明）
// ---------------------------------------------------------------------------

/**
 * v1 没有 @say/@n/@name 指令：台词/旁白是裸行，改名槽在台词头。规则文本
 * 按 v1 表面形态描述同一能力集合（语义与能力卡一一对应，不新增第二份
 * grammar——只是同一能力表的两个表面映射）。
 */
const V1_SURFACE: Readonly<Record<DslV2Command, string>> = {
  "@say": "角色台词行（`角色名: 台词`，可带 `[立绘|位置]`/`(显示名)` 槽）",
  "@n": "旁白行（纯文本行，不加 `@`）",
  "@name": "台词头 `(显示名)` 改名槽（`()` 复位）",
  "@ch": "`@ch` 立绘独立指令（show/set/hide/exit）",
  "@bg": "`@bg <背景id>` 背景指令",
  "@bgm": "`@bgm <音乐id>` / `@bgm stop` 音乐指令",
  "@se": "`@se <音效id>` 音效指令",
  "@beat": "`@beat` 纯演出节点",
  "@?": "`@? 提示文本` 表单提示行",
  "@+": "`@+ 选项文本` 选项行",
  "@=": "`@= 输入框占位文本` 输入框行",
  "@/?": "`@/?` 表单收尾行",
  "@end": "`@end <nonce> <reason>` 段结束哨兵",
  "@ending": "`@ending <档位> <结尾词>` 结局行（仅 ending 哨兵后）",
};

// ---------------------------------------------------------------------------
// 示例人物/素材选择（确定性：按 cast/资源目录声明顺序取首个可用项）
// ---------------------------------------------------------------------------

interface ExampleSpeaker {
  definition: CharacterDefinition;
  /** 缺省 look 的素材变体（无 presentation 时缺省）。 */
  variant?: string;
  /** 缺省位置（无 presentation 时缺省）。 */
  position?: string;
}

/**
 * 从允许发声 cast 里选示例角色：优先首个**带 presentation** 的 NPC
 * （能演示立绘槽），否则首个 NPC；空 cast / 全玩家 → undefined（生成
 * narration-only 示例，绝不硬塞示例角色）。
 */
function selectExampleSpeaker(input: ProtocolCardInput): ExampleSpeaker | undefined {
  const candidates: CharacterDefinition[] = [];
  let fallback: CharacterDefinition | undefined;
  for (const id of input.cast.allowedSpeakerIds) {
    const definition = input.registry.get(id);
    if (definition === undefined || definition.control !== "npc") continue;
    if (fallback === undefined) fallback = definition;
    if (definition.presentation !== undefined) candidates.push(definition);
  }
  const chosen = candidates[0] ?? fallback;
  if (chosen === undefined) return undefined;
  if (chosen.presentation === undefined) return { definition: chosen };
  const look = chosen.presentation.looks[chosen.presentation.defaultLook];
  if (look === undefined) return { definition: chosen };
  return {
    definition: chosen,
    variant: look.variant,
    position: chosen.presentation.defaultPosition,
  };
}

/** 首个可用资源 id（确定性：取目录声明顺序的第一个键；无则 undefined）。 */
function firstAssetId(assets: Record<string, unknown> | undefined): string | undefined {
  if (assets === undefined) return undefined;
  const keys = Object.keys(assets);
  return keys.length > 0 ? keys[0] : undefined;
}

// ---------------------------------------------------------------------------
// 规则正文
// ---------------------------------------------------------------------------

function renderRules(
  capability: DslTaskCapability,
  protocolVersion: 1 | 2,
  repair: boolean,
): string {
  const lines: string[] = [];
  lines.push(`能力范围：${capability.scope}。`);
  if (protocolVersion === 2) {
    lines.push(`本任务允许的指令（其余指令一律不要输出）：${capability.commands.join(" ")}。`);
  } else {
    lines.push("本任务允许的输出形态（其余一律不要输出）：");
    for (const command of capability.commands) {
      lines.push(`- ${V1_SURFACE[command]}`);
    }
  }
  lines.push(
    `结束方式：本段最后一行逐字输出 @end <nonce> ${capability.endReasons.join("|")}（nonce 原样照抄任务提示，不得编造）。`,
  );
  if (capability.ending) {
    lines.push(
      "以 ending 收束时，哨兵后另起一行写 @ending <TE|HE|NE|BE> <结尾标题>，之后不再输出任何内容。",
    );
  } else {
    lines.push("本任务不得以 ending 收束，也不得输出 @ending 行。");
  }
  if (repair) {
    lines.push(
      "修复收尾：只重写未提交的尾部；不改变 nonce、玩家选择或已提交前缀，不得重复已提交内容。",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 可执行示例
// ---------------------------------------------------------------------------

/** 示例正文文案（内容无关的占位台词/旁白，逐字固定保证确定性）。 */
const EXAMPLE_DIALOGUE_TEXT = "（示例台词）这一行演示本任务允许的台词写法。";
const EXAMPLE_NARRATION_TEXT = "（示例旁白）这一行演示本任务允许的旁白写法。";

function allows(capability: DslTaskCapability, command: DslV2Command): boolean {
  return capability.commands.includes(command);
}

function renderExamples(
  capability: DslTaskCapability,
  speaker: ExampleSpeaker | undefined,
  assets: AssetCatalog,
  protocolVersion: 1 | 2,
): { examples: ProtocolCardExample[]; characterIds: string[]; assetIds: string[] } {
  const examples: ProtocolCardExample[] = [];
  const characterIds: string[] = [];
  const assetIds: string[] = [];
  const primaryReason = capability.endReasons[0] ?? "buffer";
  const canSay = allows(capability, "@say") && speaker !== undefined;

  // —— 主示例：本任务的最小合法段（台词/旁白 + 哨兵）——
  const mainLines: string[] = [];
  if (canSay && speaker !== undefined) {
    characterIds.push(speaker.definition.id);
    if (protocolVersion === 2) {
      mainLines.push(`@say ${speaker.definition.id} ${EXAMPLE_DIALOGUE_TEXT}`);
    } else if (speaker.variant !== undefined && speaker.position !== undefined) {
      mainLines.push(
        `${speaker.definition.name}[${speaker.variant}|${speaker.position}]: ${EXAMPLE_DIALOGUE_TEXT}`,
      );
    } else {
      mainLines.push(`${speaker.definition.name}: ${EXAMPLE_DIALOGUE_TEXT}`);
    }
  }
  if (allows(capability, "@n")) {
    mainLines.push(protocolVersion === 2 ? `@n ${EXAMPLE_NARRATION_TEXT}` : EXAMPLE_NARRATION_TEXT);
  }
  // 场景资源示例（能力允许且目录有资源时并入主示例首行）。
  if (allows(capability, "@bg")) {
    const bgId = firstAssetId(assets.backgrounds);
    if (bgId !== undefined) {
      mainLines.unshift(`@bg ${bgId}`);
      assetIds.push(bgId);
    }
  }
  // 主示例的收束 = 能力表的第一个结束方式；该方式是 interaction 时表单
  // 是段的一部分，必须并入主示例（哨兵前完整闭合），不能只给裸哨兵。
  if (primaryReason === "interaction") {
    mainLines.push("@? 你打算怎么办？", "@+ 选项一", "@+ 选项二", "@/?");
  }
  mainLines.push(`@end <nonce> ${primaryReason}`);
  examples.push({
    label: canSay ? "最小段示例（台词 + 旁白 + 收束）" : "最小段示例（仅旁白 + 收束）",
    text: mainLines.join("\n"),
  });

  // —— 交互表单示例（允许 interaction 收束但主示例用其他收束时单列）——
  if (capability.endReasons.includes("interaction") && primaryReason !== "interaction") {
    examples.push({
      label: "交互表单示例（到交互点时的固定尾部）",
      text: [
        "@? 你打算怎么办？",
        "@+ 选项一",
        "@+ 选项二",
        "@/?",
        "@end <nonce> interaction",
      ].join("\n"),
    });
  }

  // —— 结局收束示例（能力允许 ending）——
  if (capability.ending && allows(capability, "@ending")) {
    examples.push({
      label: "结局收束示例（仅故事应当结束时）",
      text: ["@end <nonce> ending", "@ending HE 示例结尾标题"].join("\n"),
    });
  }

  return { examples, characterIds, assetIds };
}

// ---------------------------------------------------------------------------
// buildProtocolCard
// ---------------------------------------------------------------------------

/**
 * 生成任务协议卡。纯函数、确定性输出（同输入 → 逐字节同卡）；示例人物/
 * 素材从实际 registry/资源目录选出，不含内容包专名（专名只可能来自调用
 * 方传入的 roster 本身——那是它的内容，不是共享模板的内容）。
 */
export function buildProtocolCard(input: ProtocolCardInput): ProtocolCard {
  const repair = input.repair === true;
  const capability = repair
    ? protocolRepairCapability(input.task)
    : dslTaskCapability(input.task);
  const speaker = selectExampleSpeaker(input);
  const { examples, characterIds, assetIds } = renderExamples(
    capability,
    speaker,
    input.assets,
    input.protocolVersion,
  );
  const rules = renderRules(capability, input.protocolVersion, repair);

  const provenance: ProtocolCardProvenance = {
    protocolVersion: input.protocolVersion,
    rosterRevision: input.registry.roster.revision,
    scopeId: input.registry.roster.scopeId,
    capabilityTask: capability.task,
    baseTask: input.task,
    capabilitySource: "src/core/protocol/gal-dsl/capabilities.ts",
    exampleCharacterIds: characterIds,
    exampleAssetIds: assetIds,
  };

  const header = repair
    ? `【任务协议卡：${capability.task}（基于 ${input.task}，仅限未提交尾部）】`
    : `【任务协议卡：${capability.task}】`;
  const meta = `DSL 协议版本 ${input.protocolVersion}；身份版本 roster:${input.registry.roster.revision}`;
  const exampleBlock =
    examples.length > 0
      ? [
          "可执行示例（人物与素材 id 均来自本局名册与资源目录；<nonce> 处照抄任务提示里的真实 nonce）：",
          ...examples.map((example) => `${example.label}：\n${example.text}`),
        ].join("\n\n")
      : "（本任务无可执行示例。）";
  const text = [`${header}${meta}`, rules, exampleBlock].join("\n\n");

  return {
    task: capability.task,
    capability,
    rules,
    examples,
    provenance,
    text,
  };
}

/** 把卡内 `<nonce>` 占位替换为真实 nonce（字面单遍，无重求值）。 */
export function bindProtocolCardNonce(text: string, nonce: string): string {
  // `<nonce>` 不是模板变量语法（`<` 不在变量字符集内），逐字面替换。
  return text.split("<nonce>").join(nonce);
}
