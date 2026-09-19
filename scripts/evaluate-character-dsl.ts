#!/usr/bin/env node
/**
 * 角色 DSL v2 离线评估 harness（main 分支版；V1 从校园脚本移植）。
 *
 * 机器与评估流程分支无关（campus scripts/evaluate-character-dsl.ts 同源）：
 * 契约向量回放、注入缺陷修复模拟、§10.2 发布门槛表与在线指标 schema
 * 原样复用；本文件换成 main 自己的 12 场景数据（静态 fallback 世界
 * player/linche/suyao + assets/resources.yaml + voices.yaml）与 main 的
 * 记忆向量（§6.2 validateCharacterTags 结构化拒绝，替代校园的
 * applyMemoryProposal 向量——main 无 story/memory-agent 泳道）。
 *
 * main 适配点（与校园脚本的差异，全部为内容/模块布局差异，非评估口径差异）：
 * - 内容包加载：loadCharacterPackRoster（src/adapters/static/character-pack-loader.ts），
 *   返回 CharacterRoster（校园 loadCharacterPackage 返回 {roster}）。
 * - 记忆向量 MAIN-MEMORY：buildMemoryIdentityView + validateCharacterTags
 *   （src/application/narrative/memory-validator.ts，C8/M2 请求侧身份视图）——
 *   显示名/未知 ID 提案必须以结构化 issues 显式拒绝，不得静默丢弃或凭空接受。
 * - 场景集：player（玩家契约）+ linche/suyao 双 NPC（槽位互斥/画外/化名/
 *   结局 @ending/文本保真），素材 id 取自 main assets/resources.yaml。
 *
 * 离线优先（replay/contract 评估，零模型调用、零费用）：
 * - 共享契约向量（src/test-support/character-contract-cases.ts）＋ main
 *   向量：R01/R02×2/R03/R09-pinned/MAIN-MEMORY，走真实公开 API。
 * - main 固定场景集（12 个）：v1 parseDslSegmentText+compileEventGroups 与
 *   v2 compileSegmentV2 双协议回放、serializeStoryContext 投影、
 *   AudioDescriptorFactory 音频身份（main roster + voices.yaml local 绑定）、
 *   名牌快照稳定性、文本保真。
 * - 注入缺陷修复模拟（compileSegmentV2WithRepair）：截断尾、未知 ID、
 *   坏 look、玩家代言、好改名+坏 look 同组（原子性）、能力越权。
 *
 * 可重复：同一输入 → 逐字节相同输出（规范 JSON 排序键、无时间戳、
 * 无随机源；报告带 sha256 摘要）。
 *
 * 输出：只写显式传入的 --out 目录（report.json + summary.md）；拒绝
 * sessions/games 路径；不带 --out 时只打印摘要，不写任何文件；永不写
 * 生产状态（sessions/games/config）。
 *
 * 在线评估（§10.1/§10.2）：显式 `--online --model <id> --max-calls <n>
 * --budget <n>` 门控，默认关闭——无参数运行 100% 离线免费。在线腿在
 * V2 gate 接线前是 NOT_ENABLED 桩，但指标 schema（按任务 × 内容包分组
 * 的 first-pass/repair/错误角色/串音/时延/token）已作为类型与报告段落
 * 存在。带齐参数调用在线桩会得到明确错误与用量说明，不会静默跑模型。
 *
 * 用法：
 *   npm exec tsx -- scripts/evaluate-character-dsl.ts [--out <dir>] \
 *     [--pack <characters.yaml>] [--voices <voices.yaml>] \
 *     [--assets <assets/resources.yaml>]
 *   npm exec tsx -- scripts/evaluate-character-dsl.ts --online --model <id> \
 *     --max-calls <n> --budget <n>
 *
 * （npm exec 需要 `--` 分隔符，否则 --out 等旗标会被 npm 自己吃掉。）
 *
 * 退出码：0=评估完成（已知红灯照常报告，不影响退出码）；2=用法/路径
 * 误用；3=在线腿未接线（NOT_ENABLED）；1=harness 内部错误。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  RENAME_IDENTITY_CASE,
  VOICE_PROFILE_STABILITY_CASE,
  TEMPLATE_LITERAL_CASE,
  PARSE_COLON_DIVERGENCE_CASE,
} from "../src/test-support/character-contract-cases.js";
import { parseDslLine } from "../src/core/protocol/gal-dsl/line-parser.js";
import { parseDslSegmentText } from "../src/core/protocol/gal-dsl/text-pipeline.js";
import {
  compileEventGroups,
  compileSegmentV2,
  compileSegmentV2WithRepair,
} from "../src/core/protocol/gal-dsl/compiler.js";
import { dslTaskCapability } from "../src/core/protocol/gal-dsl/capabilities.js";
import type {
  AssetDiagnostic,
  CompiledMainEvent,
  DslErrorCode,
  EventGroupDraft,
} from "../src/core/protocol/gal-dsl/types.js";
import type { BaseDslTaskType } from "../src/core/protocol/gal-dsl/capabilities.js";
import {
  buildCharacterRoster,
  createCharacterRegistry,
} from "../src/core/characters/registry.js";
import { createCharacterRuntimeState } from "../src/core/characters/types.js";
import type {
  CharacterRoster,
  CastContext,
} from "../src/core/characters/types.js";
import type { CharacterRegistryEntry } from "../src/core/presentation/types.js";
import {
  createDefaultsFromRegistry,
  createInitialVisualState,
  createPresentationDefaultsFromRoster,
} from "../src/core/presentation/defaults.js";
import { createVisualStateReducer } from "../src/core/presentation/reducer.js";
import { toCharacterRegistry } from "../src/core/assets/catalog.js";
import { loadCharacterPackRoster } from "../src/adapters/static/character-pack-loader.js";
import { loadAssetCatalog } from "../src/application/assets/asset-catalog-loader.js";
import { AudioDescriptorFactory } from "../src/application/audio/audio-descriptor-factory.js";
import type { PerformanceCompiler } from "../src/application/audio/performance-compiler.js";
import {
  buildMemoryIdentityView,
  validateCharacterTags,
} from "../src/application/narrative/memory-validator.js";
import { loadVoices } from "../src/config/voices.js";
import { serializeStoryContext } from "../src/story/context-builder.js";
import type { StoryContextEvent } from "../src/schema.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// CLI（显式输出目录；拒绝 sessions/games；在线门控默认关）
// ---------------------------------------------------------------------------

const USAGE = [
  "用法：npm exec tsx -- scripts/evaluate-character-dsl.ts [选项]",
  "",
  "离线 replay/contract 评估（默认，零模型调用）：",
  "  --out <dir>       评估输出目录（只写 report.json 与 summary.md）；",
  "                    不带 --out 则只打印摘要，不写任何文件。",
  "                    路径任一段为 sessions 或 games 时拒绝执行。",
  "  --pack <file>     角色内容包（默认 <repo>/characters.yaml）",
  "  --voices <file>   音色配置（默认 <repo>/voices.yaml）",
  "  --assets <file>   素材目录（默认 <repo>/assets/resources.yaml）",
  "",
  "在线评估（§10.1；必须显式启用并设预算，默认关闭）：",
  "  --online --model <id> --max-calls <n> --budget <n>",
  "                    在线腿在 V2 gate 接线前为 NOT_ENABLED 桩：拒绝执行",
  "                    并打印用量说明；普通测试/评估永不产生模型费用。",
  "",
  "退出码：0=评估完成；2=用法/路径误用；3=在线未接线；1=内部错误。",
].join("\n");

interface OfflineCliArgs {
  mode: "offline";
  outDir?: string;
  packPath: string;
  voicesPath: string;
  assetsPath: string;
}

interface OnlineCliArgs {
  mode: "online";
  model: string;
  maxCalls: number;
  budget: number;
}

type CliArgs =
  | OfflineCliArgs
  | OnlineCliArgs
  | { mode: "help" }
  | { mode: "error"; message: string };

function parseArgs(argv: readonly string[]): CliArgs {
  const args = [...argv];
  let outDir: string | undefined;
  let packPath = path.join(REPO_ROOT, "characters.yaml");
  let voicesPath = path.join(REPO_ROOT, "voices.yaml");
  let assetsPath = path.join(REPO_ROOT, "assets", "resources.yaml");
  let online = false;
  let model: string | undefined;
  let maxCalls: number | undefined;
  let budget: number | undefined;

  const nextValue = (flag: string): string => {
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} 需要一个取值（收到 "${value ?? "无"}"）`);
    }
    return value;
  };

  try {
    while (args.length > 0) {
      const flag = args.shift()!;
      switch (flag) {
        case "--help":
        case "-h":
          return { mode: "help" };
        case "--out":
          outDir = nextValue(flag);
          if (outDir === "") {
            throw new Error("--out 不允许为空（缺省会解析成当前目录）");
          }
          break;
        case "--pack":
          packPath = path.resolve(nextValue(flag));
          break;
        case "--voices":
          voicesPath = path.resolve(nextValue(flag));
          break;
        case "--assets":
          assetsPath = path.resolve(nextValue(flag));
          break;
        case "--online":
          online = true;
          break;
        case "--model":
          model = nextValue(flag);
          break;
        case "--max-calls": {
          const raw = nextValue(flag);
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`--max-calls 必须是非负整数（收到 "${raw}"）`);
          }
          maxCalls = parsed;
          break;
        }
        case "--budget": {
          const raw = nextValue(flag);
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`--budget 必须是非负整数（收到 "${raw}"）`);
          }
          budget = parsed;
          break;
        }
        default:
          throw new Error(`未知选项 "${flag}"`);
      }
    }
  } catch (error) {
    return {
      mode: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (online) {
    const missing: string[] = [];
    if (model === undefined) missing.push("--model <id>");
    if (maxCalls === undefined) missing.push("--max-calls <n>");
    if (budget === undefined) missing.push("--budget <n>");
    if (missing.length > 0) {
      return {
        mode: "error",
        message:
          "--online 需要同时显式提供 " +
          missing.join(" ") +
          "（在线评估必须由执行者明确启用并设预算；缺省 100% 离线免费）",
      };
    }
    return { mode: "online", model: model!, maxCalls: maxCalls!, budget: budget! };
  }

  if (outDir !== undefined && isForbiddenOutPath(outDir)) {
    return {
      mode: "error",
      message:
        `拒绝输出目录 "${outDir}"：评估输出不得触碰 sessions/games 生产状态，` +
        "请显式指定独立评估目录（--out <dir>）",
    };
  }

  return { mode: "offline", ...(outDir !== undefined ? { outDir } : {}), packPath, voicesPath, assetsPath };
}

/** 输出目录守卫：任何路径段都不得是 sessions / games（Windows 分隔符归一）。 */
function isForbiddenOutPath(outDir: string): boolean {
  const segments = outDir.split(/[\\/]/).map((segment) => segment.toLowerCase());
  return segments.includes("sessions") || segments.includes("games");
}

// ---------------------------------------------------------------------------
// 规范 JSON（确定性）：键排序、无空格、数组保序
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// 在线评估指标 schema（§10.1：按任务 × 内容包分组；V2 gate 接线）
// ---------------------------------------------------------------------------

/** §10.1 采样设计常量：24 确定输入 × 每版本重复 3 次 = 144 次主生成。 */
export const SAMPLE_DESIGN = {
  deterministicInputs: 24,
  campusScenarios: 12,
  mainScenarios: 12,
  repeatsPerVersion: 3,
  totalPrimaryGenerations: 144,
  repairLimitPerGeneration: 1,
} as const;

/** 在线实验配置（正式 A/B 固定其他变量：模型、temperature、seed/重复条件）。 */
export interface OnlineExperimentConfig {
  model: string;
  maxCalls: number;
  budget: number;
  /** 模型支持 seed 时固定；否则记录重复采样条件（§V2）。 */
  seed: number | null;
  temperature: number | null;
  repeatsPerCase: number;
  /** 与冻结旧版本做配对比较；不同时改模型/temperature/核心内容。 */
  pairedBaseline: string;
  /** 实验配置分组（DSL 改造 / 提示词清理 / 两者组合），避免内容分布混淆。 */
  variant: "dsl-only" | "prompt-cleanup-only" | "dsl-plus-prompt";
}

/** 按任务 × 内容包分组的一次在线采样指标（§10.1 采集清单）。 */
export interface OnlineTaskPackMetrics {
  task: string;
  contentPack: string;
  n: number;
  firstPassValid: number;
  afterRepairValid: number;
  repairCount: number;
  /** 分项错误统计（错误角色/错误类型），不能只用整体通过率掩盖。 */
  errorRoles: Record<string, number>;
  crosstalkCount: number;
  /** 最小脱敏复现（归属不明错误必须保留，§V2）。 */
  minimalRedactions: string[];
  latencyMs: {
    firstPlayableP50: number;
    firstPlayableP95: number;
    fullSegmentP50: number;
    fullSegmentP95: number;
  };
  tokens: { promptP50: number; completionP50: number };
}

export interface OnlineEvaluationReport {
  status: "not_run" | "insufficient_sample" | "complete";
  reason: string;
  config?: OnlineExperimentConfig;
  metrics: OnlineTaskPackMetrics[];
}

/** 空在线报告（离线运行的占位段落：schema 存在，值未采集）。 */
export function emptyOnlineReport(): OnlineEvaluationReport {
  return {
    status: "not_run",
    reason:
      "NOT_ENABLED：在线腿需显式 --online --model <id> --max-calls <n> " +
      "--budget <n>，并在 V2 gate 接线后运行；普通离线评估零模型调用。",
    metrics: [],
  };
}

/**
 * 在线评估桩（V2 gate 接线）。带齐参数也拒绝执行：接线前绝不产生模型
 * 调用或费用；错误信息带用量说明（§10.1 预算/重复采样设计）。
 */
export async function runOnlineEvaluation(
  config: OnlineExperimentConfig,
): Promise<OnlineEvaluationReport> {
  void config;
  throw new Error(
    "ONLINE_EVALUATION_NOT_ENABLED：在线评估尚未接线（V2 gate）。" +
      `采样设计：${SAMPLE_DESIGN.deterministicInputs} 个确定输入 × ` +
      `${SAMPLE_DESIGN.repeatsPerVersion} 次 = ${SAMPLE_DESIGN.totalPrimaryGenerations} 次主生成，` +
      `repair 每次 ≤${SAMPLE_DESIGN.repairLimitPerGeneration}，另计预算；` +
      "接线时须与冻结旧版本配对比较并固定 seed/重复条件。",
  );
}

// ---------------------------------------------------------------------------
// 共享契约向量（＋ main 向量）——真实公开 API 回放
// ---------------------------------------------------------------------------

export interface VectorResult {
  id: string;
  requirement: string;
  name: string;
  /** expected-pass=断言期望行为；expected-red=规格红灯（转绿即进度）；pinned-current=固定当前缺陷行为。 */
  expectation: "expected-pass" | "expected-red" | "pinned-current";
  status: "pass" | "fail";
  knownRed: boolean;
  detail: string;
}

/**
 * 声明当前已知红灯向量（红灯即规格；对应任务落地后转绿并从表中移除）。
 * 当前为空：R01/R02×2/R03 在 C5–C7 落地后已绿；MAIN-MEMORY 自移植起
 * 即为期望通过（main 的 §6.2 校验链在 C8/M2 已闭环）。
 */
export const EXPECTED_RED_VECTOR_IDS: ReadonlySet<string> = new Set<string>([]);

const FEMALE_A_ENTRY: CharacterRegistryEntry = {
  characterId: RENAME_IDENTITY_CASE.characterId,
  scriptName: RENAME_IDENTITY_CASE.scriptName,
  displayName: RENAME_IDENTITY_CASE.scriptName,
  spriteSet: RENAME_IDENTITY_CASE.characterId,
  defaultVariant: "base",
  defaultPosition: "right",
  allowedSpriteSets: [RENAME_IDENTITY_CASE.characterId],
};

function r01PresentationRegistry() {
  const byId = new Map([[FEMALE_A_ENTRY.characterId, FEMALE_A_ENTRY]]);
  return {
    resolveByScriptName(name: string) {
      return FEMALE_A_ENTRY.scriptName === name ? FEMALE_A_ENTRY : undefined;
    },
    resolveById(id: string) {
      return byId.get(id);
    },
    entries() {
      return [FEMALE_A_ENTRY];
    },
  };
}

function r01RosterRegistry() {
  const emptyAssets = {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets: {},
  };
  return createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "r01-contract",
      playerId: "player_one",
      characters: [
        {
          id: "player_one",
          name: "玩家",
          control: "player",
          initialLabel: "你",
          persona: "玩家本人（契约向量）。",
        },
        {
          id: RENAME_IDENTITY_CASE.characterId,
          name: RENAME_IDENTITY_CASE.scriptName,
          control: "npc",
          initialLabel: RENAME_IDENTITY_CASE.scriptName,
          persona: "契约向量角色。",
        },
      ],
    }),
    emptyAssets,
  );
}

/** R01：v1 行头 → parseDslLine → compileEventGroups（与运行时一致）。 */
function r01CompileDialogueLine(line: string): CompiledMainEvent | null {
  const known = new Set([FEMALE_A_ENTRY.scriptName, FEMALE_A_ENTRY.characterId]);
  const parsed = parseDslLine(line, known);
  if (parsed.kind !== "dialogue") return null;
  const draft: EventGroupDraft = {
    prelude: [],
    main: {
      type: "dialogue",
      speaker: parsed.speaker,
      text: parsed.text,
      visual: parsed.visual,
      name: parsed.name,
    },
  };
  const registry = r01PresentationRegistry();
  const defaults = createDefaultsFromRegistry(registry);
  const { groups } = compileEventGroups([draft], {
    registry,
    tailState: createInitialVisualState(),
    reduce: createVisualStateReducer(defaults),
    defaultsFor: defaults.defaultFor.bind(defaults),
  });
  return groups[0]?.main ?? null;
}

const stubPerformanceCompiler: PerformanceCompiler = {
  compile: () => ({
    rate: 1,
    pitch: 1,
    volume: 1,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }),
};

function r02ContractVoices() {
  return {
    version: 3 as const,
    profiles: {
      [VOICE_PROFILE_STABILITY_CASE.voiceProfile]: {
        semantic: {
          base_description: "温柔娴静的学姐声",
          allowed_delivery: ["gentle"],
          forbidden_delivery: ["cold"],
        },
        providers: {
          dashscope: {
            model: "cosyvoice-v2",
            voice_id_env: VOICE_PROFILE_STABILITY_CASE.voiceIdEnv,
            voice_revision: 2,
            instruction_mode: "free" as const,
          },
        },
      },
    },
  };
}

function r02Factory() {
  const emptyAssets = {
    guidance: "",
    backgrounds: {},
    bgm: {},
    soundEffects: {},
    spriteSets: {},
  };
  const registry = createCharacterRegistry(
    buildCharacterRoster({
      schemaVersion: 2,
      scopeId: "r02-contract",
      playerId: "player_one",
      characters: [
        {
          id: "player_one",
          name: "玩家",
          control: "player",
          initialLabel: "你",
          persona: "玩家本人（R02 契约向量）。",
        },
        {
          id: RENAME_IDENTITY_CASE.characterId,
          name: VOICE_PROFILE_STABILITY_CASE.ttsConfigName,
          control: "npc",
          initialLabel: VOICE_PROFILE_STABILITY_CASE.ttsConfigName,
          persona: "契约向量角色。",
          voiceProfileId: VOICE_PROFILE_STABILITY_CASE.voiceProfile,
        },
      ],
    }),
    emptyAssets,
  );
  return new AudioDescriptorFactory({
    registry,
    voices: r02ContractVoices(),
    provider: "dashscope",
    modelProfile: "cosyvoice_v3_flash",
    sampleRate: 22050,
    format: "pcm_s16le",
    env: { [VOICE_PROFILE_STABILITY_CASE.voiceIdEnv]: VOICE_PROFILE_STABILITY_CASE.voiceId },
    compiler: stubPerformanceCompiler,
    seedFor: () => 42,
  });
}

interface AudioIdentityObservation {
  available: boolean;
  speakerId: string | null;
  voiceId: string | null;
  voiceRevision: number | null;
  reason?: string;
}

/** 用某个 factory 观察一条对白的音频身份（可用性/speakerId/音色）。 */
function observeAudioIdentity(
  factory: AudioDescriptorFactory,
  lineId: string,
  characterId: string,
  label: string,
  text: string,
): AudioIdentityObservation {
  const built = factory.build(
    {
      type: "dialogue",
      speaker: label,
      displayLabel: label,
      text,
      line_id: lineId,
      characterId,
    },
    { type: "active" },
    "current",
  );
  if (built === null) {
    return { available: false, speakerId: null, voiceId: null, voiceRevision: null, reason: "narration" };
  }
  if (built.voiceAvailability !== "available") {
    return {
      available: false,
      speakerId: null,
      voiceId: null,
      voiceRevision: null,
      reason: built.reason,
    };
  }
  return {
    available: true,
    speakerId: built.descriptor.speakerId,
    voiceId: built.recipe.voiceId,
    voiceRevision: built.recipe.voiceRevision,
  };
}

async function evaluateContractVectors(): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  const push = (result: Omit<VectorResult, "knownRed">): void => {
    results.push({
      ...result,
      knownRed: result.status === "fail" && EXPECTED_RED_VECTOR_IDS.has(result.id),
    });
  };

  // --- R01：改名后发给模型的上下文仍携带稳定 characterId ---
  {
    const original = r01CompileDialogueLine(RENAME_IDENTITY_CASE.originalLine);
    const renamed = r01CompileDialogueLine(RENAME_IDENTITY_CASE.renamedLine);
    const compileOk =
      original !== null &&
      original.type === "dialogue" &&
      original.characterId === RENAME_IDENTITY_CASE.characterId &&
      original.speaker === RENAME_IDENTITY_CASE.scriptName &&
      renamed !== null &&
      renamed.type === "dialogue" &&
      renamed.characterId === RENAME_IDENTITY_CASE.characterId;
    const projected =
      renamed !== null && renamed.type === "dialogue"
        ? serializeStoryContext(
            [
              {
                type: "dialogue",
                characterId: renamed.characterId,
                speaker: RENAME_IDENTITY_CASE.renamedLabel,
                text: renamed.text,
                line_id: "contract_line_1",
              },
            ],
            r01RosterRegistry(),
          )
        : "";
    const projectionOk = projected.includes(RENAME_IDENTITY_CASE.characterId);
    push({
      id: "R01",
      requirement: "R01",
      name: "改名后 writer 上下文仍携带 female_A（投影不丢稳定 id）",
      expectation: "expected-pass",
      status: compileOk && projectionOk ? "pass" : "fail",
      detail:
        `compile: original/renamed characterId=${renamed !== null && renamed.type === "dialogue" ? renamed.characterId : "n/a"}；` +
        `projection 携带稳定 id=${projectionOk}`,
    });
  }

  // --- R02（共享向量）：改名标签事件的音色等于原姓名版本 ---
  {
    const factory = r02Factory();
    const base = {
      type: "dialogue" as const,
      text: RENAME_IDENTITY_CASE.dialogueText,
      line_id: VOICE_PROFILE_STABILITY_CASE.lineId,
      characterId: RENAME_IDENTITY_CASE.characterId,
    };
    const original = factory.build(
      { ...base, speaker: VOICE_PROFILE_STABILITY_CASE.ttsConfigName },
      { type: "active" },
      "current",
    );
    const renamed = factory.build(
      { ...base, speaker: RENAME_IDENTITY_CASE.renamedLabel },
      { type: "active" },
      "current",
    );
    const originalOk =
      original !== null && original.voiceAvailability === "available" && original.recipe.voiceId === VOICE_PROFILE_STABILITY_CASE.voiceId;
    const renamedOk =
      renamed !== null &&
      renamed.voiceAvailability === "available" &&
      original !== null &&
      original.voiceAvailability === "available" &&
      renamed.recipe.voiceId === original.recipe.voiceId &&
      renamed.recipe.voiceRevision === original.recipe.voiceRevision &&
      renamed.descriptor.speakerId === RENAME_IDENTITY_CASE.characterId;
    push({
      id: "R02-shared",
      requirement: "R02",
      name: "音色跨标签稳定（共享契约 fixture：contractVoices + female_A→xuwanqing_main）",
      expectation: "expected-pass",
      status: originalOk && renamedOk ? "pass" : "fail",
      detail:
        `original available=${originalOk}；renamed speakerId=` +
        `${renamed !== null && renamed.voiceAvailability === "available" ? renamed.descriptor.speakerId : "n/a"}；` +
        `voiceId 一致=${originalOk && renamedOk}`,
    });
  }

  return results;
}

/** R02（main roster 变体）＋ R03/R09/MAIN-MEMORY 需要 main 上下文。 */
async function evaluateMainVectors(
  roster: CharacterRoster,
  factory: AudioDescriptorFactory,
  registry: ReturnType<typeof createCharacterRegistry>,
): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  const push = (result: Omit<VectorResult, "knownRed">): void => {
    results.push({
      ...result,
      knownRed: result.status === "fail" && EXPECTED_RED_VECTOR_IDS.has(result.id),
    });
  };

  // --- R02（main roster 变体）：真实 characters.yaml + voices.yaml ---
  // main 静态世界绑定：suyao → suyao_main（voices.yaml local 注册表键 suyao）。
  {
    const rosterCharacterId = "suyao";
    const rosterLabel = "苏遥";
    const aliasLabel = "神秘女子";
    const definition = roster.characters.find(
      (candidate) => candidate.id === rosterCharacterId,
    );
    const rosterBindingOk = definition?.voiceProfileId === "suyao_main";
    const original = observeAudioIdentity(
      factory,
      `${VOICE_PROFILE_STABILITY_CASE.lineId}-main-original`,
      rosterCharacterId,
      rosterLabel,
      RENAME_IDENTITY_CASE.dialogueText,
    );
    const renamed = observeAudioIdentity(
      factory,
      `${VOICE_PROFILE_STABILITY_CASE.lineId}-main-renamed`,
      rosterCharacterId,
      aliasLabel,
      RENAME_IDENTITY_CASE.dialogueText,
    );
    const pass =
      rosterBindingOk &&
      original.available &&
      renamed.available &&
      original.speakerId === rosterCharacterId &&
      renamed.speakerId === rosterCharacterId &&
      original.voiceId === renamed.voiceId &&
      original.voiceRevision === renamed.voiceRevision;
    push({
      id: "R02-main",
      requirement: "R02",
      name: "音色跨标签稳定（main roster + voices.yaml 真配置：suyao_main）",
      expectation: "expected-pass",
      status: pass ? "pass" : "fail",
      detail:
        `roster 绑定 ${definition?.voiceProfileId ?? "无"}；` +
        `original(${original.voiceId ?? original.reason}) vs renamed(${renamed.voiceId ?? renamed.reason})；` +
        `speakerId=${renamed.speakerId ?? "n/a"}`,
    });
  }

  // --- R03：renderTemplate 字面单遍替换（动态导入计划模块） ---
  {
    let pass = false;
    let detail = "";
    try {
      const moduleUrl = new URL(`../src/${TEMPLATE_LITERAL_CASE.plannedModule.replace("./", "")}`, import.meta.url).href;
      const module: { renderTemplate: (template: string, values: Record<string, string>) => string } =
        await import(/* @vite-ignore */ moduleUrl);
      const rendered = module.renderTemplate(
        TEMPLATE_LITERAL_CASE.template,
        TEMPLATE_LITERAL_CASE.values,
      );
      pass = rendered === TEMPLATE_LITERAL_CASE.expected;
      detail = `rendered=${JSON.stringify(pass ? rendered : rendered)}（期望 ${JSON.stringify(TEMPLATE_LITERAL_CASE.expected)}）`;
    } catch (error) {
      pass = false;
      detail = `计划模块不可用：${error instanceof Error ? error.message : String(error)}`;
    }
    push({
      id: "R03",
      requirement: "R03",
      name: "renderTemplate 字面单遍替换（$& 与 {nonce} 不二次展开）",
      expectation: "expected-pass",
      status: pass ? "pass" : "fail",
      detail,
    });
  }

  // --- R09：冒号全半角解析分歧（固定当前行为，待消除） ---
  {
    const ascii = parseDslLine(PARSE_COLON_DIVERGENCE_CASE.asciiColonLine);
    const fullwidth = parseDslLine(PARSE_COLON_DIVERGENCE_CASE.fullwidthColonLine);
    const pinned = PARSE_COLON_DIVERGENCE_CASE.pinnedAsciiOutcome;
    const asciiMatches =
      ascii.kind === "dialogue" &&
      ascii.speaker === pinned.speaker &&
      ascii.text === PARSE_COLON_DIVERGENCE_CASE.dialogueText;
    const fullwidthMatches =
      fullwidth.kind === "narration" &&
      fullwidth.text === PARSE_COLON_DIVERGENCE_CASE.fullwidthColonLine;
    push({
      id: "R09-pinned",
      requirement: "R09",
      name: "未注册说话人冒号全半角解析分歧（固定当前缺陷行为，待消除）",
      expectation: "pinned-current",
      status: asciiMatches && fullwidthMatches ? "pass" : "fail",
      detail: asciiMatches && fullwidthMatches
        ? "与固定快照一致（半角→dialogue 幻影身份；全角→narration 降级）"
        : "固定快照漂移：行为已变化，需更新向量（这正是待消除缺陷被修复的信号）",
    });
  }

  // --- MAIN-MEMORY：显示名/未知 ID 提案被拒须有结构化显式诊断 ---
  // （main 的 §6.2 请求侧身份校验；校园向量用 applyMemoryProposal——main
  //   无该泳道，等价口径 = validateCharacterTags 的结构化 issues。）
  {
    const view = buildMemoryIdentityView({
      events: [],
      registry,
      stateCharacters: ["suyao"],
      stateLocation: "",
    });
    const aliasTag = "神秘女子";
    const issues = validateCharacterTags([aliasTag, "suyao"], view, "episode.characters");
    const aliasRejected = issues.some(
      (issue) =>
        issue.code === "UNKNOWN_CHARACTER_ID" &&
        issue.path === "episode.characters[0]" &&
        issue.value === aliasTag,
    );
    const stableIdAccepted = !issues.some((issue) => issue.value === "suyao");
    const rosterRevisionCarried = view.rosterRevision === roster.revision;
    push({
      id: "MAIN-MEMORY",
      requirement: "main-memory",
      name: "记忆提案显示名标签被拒须有结构化诊断；稳定 ID 通过（§6.2）",
      expectation: "expected-pass",
      status: aliasRejected && stableIdAccepted && rosterRevisionCarried ? "pass" : "fail",
      detail: aliasRejected
        ? stableIdAccepted
          ? `拒绝带结构化 issues（UNKNOWN_CHARACTER_ID ${aliasTag}）；suyao 通过；revision ${view.rosterRevision.slice(0, 12)}…`
          : "稳定 ID 误拒——允许集/证据视图接线回归"
        : "显示名提案被静默接受或无结构化诊断（P0）",
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// main 固定场景集（12 个；确定性数据，无随机；覆盖玩家契约/双 NPC/
// 槽位互斥/化名/画外发声/玩家自由输入/结局/文本保真——素材 id 取自
// assets/resources.yaml，looks 取自 characters.yaml roster）
// ---------------------------------------------------------------------------

export interface ScenarioSpec {
  id: string;
  focus: string;
  task: BaseDslTaskType;
  expectedNonce: string;
  v2Text: string;
  v1Text: string;
  /** 期望名牌快照序列（S07 化名用；缺省不校验）。 */
  expectedLabelSnapshots?: readonly string[];
  /** 文本保真探针（S12 用；缺省不校验）。 */
  expectedTextSubstrings?: readonly string[];
  /** 槽位互斥观察（S06 用）。 */
  expectSlotExclusivity?: { hidden: string; visible: string };
  /** 画外/隐藏说话观察（S10 用）。 */
  expectHiddenSpeaker?: string;
  /** 玩家事件投影探针（S08 用：玩家输入/对白不得伪造 NPC 身份）。 */
  expectPlayerProjectionClean?: boolean;
}

export function mainScenarioSet(): ScenarioSpec[] {
  return [
    {
      id: "S01-suyao-opening",
      focus: "配角覆盖：苏遥（opening：舞台+表单+interaction 收束）",
      task: "opening",
      expectedNonce: "7f3a",
      v2Text: [
        "@bg hideout_on",
        "@bgm calm",
        "@ch suyao show look=neutral position=left",
        "@n 藏据点的旧终端还亮着一格微光，风扇声比心跳还轻。",
        "@say suyao 你来了——先别开灯，让我把这一行看完。",
        "@ch suyao set look=speaking_smile",
        "@say suyao 不用紧张，我只是想让你帮我确认一件事。",
        "@? 接下来怎么做？",
        "@+ 先看她说的那一行",
        "@+ 问她这台终端的来历",
        "@= 或者，你自己说",
        "@/?",
        "@end 7f3a interaction",
      ].join("\n"),
      v1Text: [
        "@bg hideout_on",
        "@bgm calm",
        "@ch suyao:neutral left",
        "藏据点的旧终端还亮着一格微光，风扇声比心跳还轻。",
        "苏遥: 你来了——先别开灯，让我把这一行看完。",
        "@ch suyao:speaking_smile",
        "苏遥: 不用紧张，我只是想让你帮我确认一件事。",
        "@? 接下来怎么做？",
        "@+ 先看她说的那一行",
        "@+ 问她这台终端的来历",
        "@= 或者，你自己说",
        "@/?",
        "@end 7f3a interaction",
      ].join("\n"),
    },
    {
      id: "S02-linche-continuation",
      focus: "配角覆盖：林澈（continuation buffer 收束）",
      task: "continuation",
      expectedNonce: "9c21",
      v2Text: [
        "@bg hallway_day",
        "@ch linche show look=calm position=right",
        "@say linche 白天的走廊没有第二个人影，这对我们都有利。",
        "@ch linche set look=gentle_smile",
        "@say linche 你先说结论，过程我自己会补全。",
        "@end 9c21 buffer",
      ].join("\n"),
      v1Text: [
        "@bg hallway_day",
        "@ch linche:calm right",
        "林澈: 白天的走廊没有第二个人影，这对我们都有利。",
        "@ch linche:gentle_smile",
        "林澈: 你先说结论，过程我自己会补全。",
        "@end 9c21 buffer",
      ].join("\n"),
    },
    {
      id: "S03-suyao-guarded",
      focus: "配角覆盖：苏遥警觉态（guarded → speaking_smile）",
      task: "continuation",
      expectedNonce: "b207",
      v2Text: [
        "@say suyao 这件事我不打算解释第二遍。",
        "@ch suyao show look=guarded position=left",
        "@say suyao 但你可以继续问——我不一定回答。",
        "@end b207 buffer",
      ].join("\n"),
      v1Text: [
        "苏遥: 这件事我不打算解释第二遍。",
        "@ch suyao:guarded left",
        "苏遥: 但你可以继续问——我不一定回答。",
        "@end b207 buffer",
      ].join("\n"),
    },
    {
      id: "S04-linche-serious",
      focus: "配角覆盖：林澈认真态（serious → sly_smile + 旁白）",
      task: "continuation",
      expectedNonce: "4e88",
      v2Text: [
        "@bgm relax",
        "@ch linche show look=serious position=center",
        "@say linche 把时间线再对一遍：谁先到的，谁后走的。",
        "@ch linche set look=sly_smile",
        "@n 她问得很轻，落点却一个比一个准。",
        "@end 4e88 buffer",
      ].join("\n"),
      v1Text: [
        "@bgm relax",
        "@ch linche:serious center",
        "林澈: 把时间线再对一遍：谁先到的，谁后走的。",
        "@ch linche:sly_smile",
        "她问得很轻，落点却一个比一个准。",
        "@end 4e88 buffer",
      ].join("\n"),
    },
    {
      id: "S05-suyao-uneasy",
      focus: "配角覆盖：苏遥不安→释然（uneasy → content）",
      task: "continuation",
      expectedNonce: "d410",
      v2Text: [
        "@ch suyao show look=uneasy position=left",
        "@say suyao ……你真的什么都不记得了吗？",
        "@ch suyao set look=content",
        "@say suyao 也好。有些事情，不知道比较安全。",
        "@end d410 buffer",
      ].join("\n"),
      v1Text: [
        "@ch suyao:uneasy left",
        "苏遥: ……你真的什么都不记得了吗？",
        "@ch suyao:content",
        "苏遥: 也好。有些事情，不知道比较安全。",
        "@end d410 buffer",
      ].join("\n"),
    },
    {
      id: "S06-two-npc-slot-exclusivity",
      focus: "双 NPC 边界：同槽位互斥（后者占位，前者隐藏、状态保留）",
      task: "continuation",
      expectedNonce: "a55f",
      v2Text: [
        "@bg clubroom_evening",
        "@ch suyao show look=neutral position=right",
        "@ch linche show look=calm position=right",
        "@say suyao 学姐也在？那正好，省得我说两遍。",
        "@say linche 你先说，我只补时间。",
        "@end a55f buffer",
      ].join("\n"),
      v1Text: [
        "@bg clubroom_evening",
        "@ch suyao:neutral right",
        "@ch linche:calm right",
        "苏遥: 学姐也在？那正好，省得我说两遍。",
        "林澈: 你先说，我只补时间。",
        "@end a55f buffer",
      ].join("\n"),
      expectSlotExclusivity: { hidden: "suyao", visible: "linche" },
    },
    {
      id: "S07-alias-label-snapshot",
      focus: "化名/名牌快照：set→快照为化名；reset→恢复 initialLabel；音色恒定",
      task: "continuation",
      expectedNonce: "c9d2",
      v2Text: [
        "@ch suyao show look=neutral position=left",
        "@name suyao set 神秘女子",
        "@say suyao 别抬头，走廊的灯还没灭。",
        "@say suyao 时间是 12:30（别迟到）。",
        "@name suyao reset",
        "@say suyao ……好了，现在可以看我了。",
        "@end c9d2 buffer",
      ].join("\n"),
      v1Text: [
        "@ch suyao:neutral left",
        "suyao(神秘女子): 别抬头，走廊的灯还没灭。",
        "suyao(神秘女子): 时间是 12:30（别迟到）。",
        "suyao(): ……好了，现在可以看我了。",
        "@end c9d2 buffer",
      ].join("\n"),
      expectedLabelSnapshots: ["神秘女子", "神秘女子", "苏遥"],
    },
    {
      id: "S08-player-free-input-response",
      focus: "玩家自由输入形状：input_response 回应不代玩家发声；玩家事件投影不造身份",
      task: "input_response",
      expectedNonce: "e8b0",
      expectPlayerProjectionClean: true,
      v2Text: [
        "@n 你把问题原样递了回去，活动室安静了两秒。",
        "@say suyao ……问得直接。那我也直接答：不知道。",
        "@se terminal_beep",
        "@end e8b0 buffer",
      ].join("\n"),
      v1Text: [
        "你把问题原样递了回去，活动室安静了两秒。",
        "苏遥: ……问得直接。那我也直接答：不知道。",
        "@se terminal_beep",
        "@end e8b0 buffer",
      ].join("\n"),
    },
    {
      id: "S09-ending-epilogue",
      focus: "结局：@ending 档位+标题，opening 任务 ending 收束",
      task: "opening",
      expectedNonce: "0b4d",
      v2Text: [
        "@bg hallway_night_off",
        "@bgm mountain",
        "@ch suyao show look=content position=left",
        "@n 走廊尽头的灯彻底熄了，只剩两个人的脚步声对齐。",
        "@say suyao 今天……就到这里吧。剩下的，明天再说。",
        "@end 0b4d ending",
        "@ending TE 藏据点的一夜",
      ].join("\n"),
      v1Text: [
        "@bg hallway_night_off",
        "@bgm mountain",
        "@ch suyao:content left",
        "走廊尽头的灯彻底熄了，只剩两个人的脚步声对齐。",
        "苏遥: 今天……就到这里吧。剩下的，明天再说。",
        "@end 0b4d ending",
        "@ending TE 藏据点的一夜",
      ].join("\n"),
    },
    {
      id: "S10-offstage-hidden-speaker",
      focus: "画外/隐藏角色说话合法，身份不依赖可见性",
      task: "continuation",
      expectedNonce: "f1c3",
      v2Text: [
        "@ch suyao show look=neutral position=left",
        "@ch suyao hide",
        "@say suyao （画外）等一下——终端的电源，别拔。",
        "@end f1c3 buffer",
      ].join("\n"),
      v1Text: [
        "@ch suyao:neutral left",
        "@ch suyao hide",
        "suyao: （画外）等一下——终端的电源，别拔。",
        "@end f1c3 buffer",
      ].join("\n"),
      expectHiddenSpeaker: "suyao",
    },
    {
      id: "S11-branch-prefetch-buffer",
      focus: "预取隔离：branch_prefetch 无表单、buffer 收束",
      task: "branch_prefetch",
      expectedNonce: "51aa",
      v2Text: [
        "@n 如果你先回藏据点，走廊尽头的门会先一步合上。",
        "@say linche 我在原地等你，别绕路。",
        "@end 51aa buffer",
      ].join("\n"),
      v1Text: [
        "如果你先回藏据点，走廊尽头的门会先一步合上。",
        "林澈: 我在原地等你，别绕路。",
        "@end 51aa buffer",
      ].join("\n"),
    },
    {
      id: "S12-text-fidelity",
      focus: "自由文本形状：冒号/括号/$&/{nonce}/伪命令正文逐字保真",
      task: "continuation",
      expectedNonce: "77e1",
      v2Text: [
        "@say suyao 时间是 12:30（别迟到）。",
        "@n 她说：先等等——地址是 \"hideout alley #7\"，别写成 #1。",
        "@say linche 那个口叫啥来着，圆的那个——@ch 什么的？我忘了。",
        "@n 价格 15$，省 100%&更多 {$&} {nonce}",
        "@end 77e1 buffer",
      ].join("\n"),
      v1Text: [
        "苏遥: 时间是 12:30（别迟到）。",
        "她说：先等等——地址是 \"hideout alley #7\"，别写成 #1。",
        "林澈: 那个口叫啥来着，圆的那个——@ch 什么的？我忘了。",
        "@end 77e1 buffer",
      ].join("\n"),
      expectedTextSubstrings: [
        "12:30（别迟到）",
        "\"hideout alley #7\"",
        "——@ch 什么的？我忘了。",
        "{$&} {nonce}",
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 注入缺陷修复模拟（compileSegmentV2WithRepair；脚本化确定性修复）
// ---------------------------------------------------------------------------

export interface DefectSpec {
  id: string;
  label: string;
  task: BaseDslTaskType;
  expectedNonce: string;
  text: string;
  expectFirstPassCode: DslErrorCode;
  /** 确定性脚本修复：重写未提交尾部（须自带合法哨兵）。 */
  repair: (tail: string) => string;
}

export function injectedDefectSet(): DefectSpec[] {
  return [
    {
      id: "D1-truncated-tail",
      label: "截断尾：段末缺哨兵（SENTINEL_MISSING）→ 补哨兵修复",
      task: "continuation",
      expectedNonce: "e2d1",
      text: [
        "@ch suyao show look=neutral position=left",
        "@say suyao 这件事我不打算解释第二遍。",
        "@n 走廊的灯闪了一下。",
      ].join("\n"),
      expectFirstPassCode: "SENTINEL_MISSING",
      repair: (tail) => `${tail}\n@end e2d1 buffer`,
    },
    {
      id: "D2-unknown-speaker-id",
      label: "未知 ID：@say stranger（UNKNOWN_CHARACTER_ID，不猜名字）",
      task: "continuation",
      expectedNonce: "d2f7",
      text: [
        "@n 楼道里传来一个陌生的声音。",
        "@say stranger 你不该来这里。",
        "@end d2f7 buffer",
      ].join("\n"),
      expectFirstPassCode: "UNKNOWN_CHARACTER_ID",
      repair: (tail) => tail.replace("@say stranger ", "@say suyao "),
    },
    {
      id: "D3-bad-look",
      label: "坏 look：look=smirk 不在 looks 清单（UNKNOWN_LOOK）",
      task: "continuation",
      expectedNonce: "c3a9",
      text: [
        "@ch suyao show look=smirk position=left",
        "@say suyao 我看看你的笔记。",
        "@end c3a9 buffer",
      ].join("\n"),
      expectFirstPassCode: "UNKNOWN_LOOK",
      repair: (tail) => tail.replace("look=smirk", "look=neutral"),
    },
    {
      id: "D4-player-speech",
      label: "玩家代言：@say player（PLAYER_SPEECH_FORBIDDEN，repair 改旁白）",
      task: "continuation",
      expectedNonce: "b4e0",
      text: [
        "@n 你把想法在脑子里过了一遍。",
        "@say player 我觉得是有人拿错了。",
        "@end b4e0 buffer",
      ].join("\n"),
      expectFirstPassCode: "PLAYER_SPEECH_FORBIDDEN",
      repair: (tail) => tail.replace("@say player 我觉得是有人拿错了。", "@n 你说：\u201c我觉得是有人拿错了。\u201d"),
    },
    {
      id: "D5-atomic-rename-plus-bad-look",
      label: "原子性：好改名+坏 look 同组（UNKNOWN_LOOK；改名不得先落地）",
      task: "continuation",
      expectedNonce: "a5d1",
      text: [
        "@name suyao set 神秘女子",
        "@ch suyao set look=smirk",
        "@say suyao 先别开灯。",
        "@end a5d1 buffer",
      ].join("\n"),
      expectFirstPassCode: "UNKNOWN_LOOK",
      repair: (tail) => tail.replace("look=smirk", "look=neutral"),
    },
    {
      id: "D6-capability-violation",
      label: "能力越权：branch_prefetch 里出表单（COMMAND_NOT_ALLOWED_FOR_TASK）",
      task: "branch_prefetch",
      expectedNonce: "96cc",
      text: [
        "@n 如果你先回藏据点，走廊尽头的门会先一步合上。",
        "@? 要不要先回藏据点？",
        "@+ 先回去拔电源",
        "@/?",
        "@say linche 我在原地等你，别绕路。",
        "@end 96cc buffer",
      ].join("\n"),
      expectFirstPassCode: "COMMAND_NOT_ALLOWED_FOR_TASK",
      repair: (tail) =>
        tail
          .split("\n")
          .filter((line) => !line.startsWith("@?") && !line.startsWith("@+") && !line.startsWith("@/?"))
          .join("\n"),
    },
  ];
}

// ---------------------------------------------------------------------------
// 离线评估报告
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  id: string;
  focus: string;
  task: string;
  expectedNonce: string;
  speakersCovered: string[];
  v2: {
    firstPassOk: boolean;
    diagnosticCodes: string[];
    groupCount: number;
    dialogueGroups: { characterId: string; displayLabel: string; text: string }[];
    assetDiagnosticCodes: string[];
    labelSnapshots: string[];
    labelSnapshotsMatch: boolean | null;
    slotExclusivityObserved: boolean | null;
    hiddenSpeakerObserved: boolean | null;
    playerProjectionClean: boolean | null;
  };
  v1: {
    firstPassOk: boolean;
    sentinelComplete: boolean;
    dialogueCharacterIds: string[];
    identityPreserved: boolean;
  };
  identity: {
    characterIdKnown: boolean;
    characterIdAllowedToSpeak: boolean;
    projectionCarriesStableIds: boolean;
    projectionFreeOfBareLabelHeads: boolean;
    audioSpeakerIdMatchesCharacter: boolean;
    voiceSingletonPerCharacter: boolean;
    aliasVoiceStable: boolean | null;
  };
  textFidelity: { expected: string[]; allPresent: boolean } | null;
  passed: boolean;
  notes: string[];
}

export interface DefectResult {
  id: string;
  label: string;
  firstPassCode: string;
  firstPassCodeMatches: boolean;
  repairRequested: boolean;
  repairApplied: boolean;
  finalOk: boolean;
  finalDiagnosticCodes: string[];
  committedPrefixGroups: number;
  totalGroupsAfterRepair: number;
  /** D5：首次失败后坏组的好改名未落地（原子性）。 */
  atomicRenameWithheld: boolean | null;
  /** D2：首次失败的可播放前缀不含幻影身份对白。 */
  noPhantomIdentityInPrefix: boolean | null;
  passed: boolean;
}

export interface GateRow {
  metric: string;
  offlineComputable: boolean;
  howMeasured: string;
  offlineValue: string;
}

export interface OfflineEvaluationReport {
  schema: "character-dsl-v2-evaluation/1";
  mode: "offline-replay";
  meta: {
    harness: "scripts/evaluate-character-dsl.ts";
    branchAgnostic: true;
    inputs: { pack: { path: string; sha256: string }; voices: { path: string; sha256: string }; assets: { path: string; sha256: string } };
    roster: { scopeId: string; revision: string; characterIds: string[]; playerId: string };
    sampleDesign: typeof SAMPLE_DESIGN;
    pipeline: string[];
  };
  contractVectors: VectorResult[];
  scenarios: ScenarioResult[];
  repairSim: DefectResult[];
  online: OnlineEvaluationReport;
  summary: {
    gateTable: GateRow[];
    totals: {
      vectorTotal: number;
      vectorPass: number;
      vectorFail: number;
      knownRed: string[];
      unexpectedFail: string[];
      turnedGreen: string[];
      scenarioTotal: number;
      scenarioPass: number;
      firstPassReplayRate: string;
      defectTotal: number;
      defectDetected: number;
      repairSuccessRate: string;
      acceptedUnknownSpeakerOrPlayerSpeech: number;
      aliasVoiceIncidents: number;
      namingDriftCount: number;
      assetDiagnosticCounts: Record<string, number>;
      memoryRejectionDiagnosticsObserved: number;
    };
  };
  reportHash: string;
}

interface MainContext {
  roster: CharacterRoster;
  registry: ReturnType<typeof createCharacterRegistry>;
  catalog: Awaited<ReturnType<typeof loadAssetCatalog>>;
  voices: Awaited<ReturnType<typeof loadVoices>>;
  factory: AudioDescriptorFactory;
  presentationRegistry: ReturnType<typeof toCharacterRegistry>;
  v1Defaults: ReturnType<typeof createDefaultsFromRegistry>;
  v1Reduce: ReturnType<typeof createVisualStateReducer>;
  v2Reduce: ReturnType<typeof createVisualStateReducer>;
}

function mainCast(roster: CharacterRoster): CastContext {
  const npcIds = roster.characters
    .filter((definition) => definition.control === "npc")
    .map((definition) => definition.id);
  return {
    allowedSpeakerIds: npcIds,
    sceneParticipantIds: [roster.playerId, ...npcIds],
  };
}

async function buildMainContext(
  packPath: string,
  voicesPath: string,
  assetsPath: string,
): Promise<MainContext> {
  const roster = await loadCharacterPackRoster(packPath);
  const catalog = await loadAssetCatalog(assetsPath);
  const voices = await loadVoices(voicesPath);
  const registry = createCharacterRegistry(roster, catalog);
  const presentationRegistry = toCharacterRegistry(roster);
  const v1Defaults = createDefaultsFromRegistry(presentationRegistry);
  const v2Defaults = createPresentationDefaultsFromRoster(registry);
  return {
    roster,
    registry,
    catalog,
    voices,
    factory: new AudioDescriptorFactory({
      registry,
      voices,
      provider: "local",
      modelProfile: "local-qwen3-tts",
      sampleRate: 24000,
      format: "pcm_s16le",
      env: {},
      compiler: stubPerformanceCompiler,
      seedFor: () => 42,
    }),
    presentationRegistry,
    v1Defaults,
    v1Reduce: createVisualStateReducer(v1Defaults),
    v2Reduce: createVisualStateReducer(v2Defaults),
  };
}

function evaluateScenario(ctx: MainContext, spec: ScenarioSpec): ScenarioResult {
  const rosterIds = new Set(ctx.roster.characters.map((definition) => definition.id));
  const cast = mainCast(ctx.roster);
  const allowed = new Set(cast.allowedSpeakerIds);
  const notes: string[] = [];

  // --- v2：真实段级编译（解析→分组→能力→身份/资源语义→原子提交） ---
  const v2 = compileSegmentV2({
    text: spec.v2Text,
    expectedNonce: spec.expectedNonce,
    task: spec.task,
    registry: ctx.registry,
    cast,
    reduce: ctx.v2Reduce,
    visualState: createInitialVisualState(),
    characterState: createCharacterRuntimeState(),
    catalog: ctx.catalog,
  });

  const dialogueGroups = v2.groups
    .filter((group) => group.main.type === "dialogue")
    .map((group) => group.main)
    .map((main) =>
      main.type === "dialogue"
        ? { characterId: main.characterId, displayLabel: main.displayLabel, text: main.text }
        : { characterId: "", displayLabel: "", text: "" },
    );
  const labelSnapshots = dialogueGroups.map((group) => group.displayLabel);
  const assetDiagnosticCodes = v2.assetDiagnostics.map((diagnostic: AssetDiagnostic) => diagnostic.code);

  const slotExclusivityObserved =
    spec.expectSlotExclusivity !== undefined && v2.ok
      ? (() => {
          const hidden = v2.visualState.characters[spec.expectSlotExclusivity.hidden];
          const visible = v2.visualState.characters[spec.expectSlotExclusivity.visible];
          return hidden !== undefined && hidden.visible === false && visible !== undefined && visible.visible === true;
        })()
      : null;
  const hiddenSpeakerObserved =
    spec.expectHiddenSpeaker !== undefined && v2.ok
      ? (() => {
          const character = v2.visualState.characters[spec.expectHiddenSpeaker];
          return character !== undefined && character.visible === false;
        })()
      : null;

  // --- 玩家事件投影探针（S08：玩家输入/对白不得伪造 NPC 身份） ---
  let playerProjectionClean: boolean | null = null;
  if (spec.expectPlayerProjectionClean === true) {
    const playerEvents: StoryContextEvent[] = [
      {
        type: "player_input",
        interaction_id: `${spec.id}-interaction-1`,
        text: "那我就直说了：终端到底是谁的？",
      },
      {
        type: "player_dialogue",
        interaction_id: `${spec.id}-interaction-1`,
        speaker: "你",
        text: "我觉得是有人拿错了。",
        line_id: `${spec.id}-player-1`,
      },
    ];
    const playerProjection = serializeStoryContext(playerEvents, ctx.registry);
    playerProjectionClean = ctx.roster.characters
      .filter((definition) => definition.control === "npc")
      .every((definition) => !playerProjection.includes(`"characterId":"${definition.id}"`));
  }

  // --- v1：真实整文管线（parseDslSegmentText → compileEventGroups） ---
  let v1Result: ScenarioResult["v1"] = {
    firstPassOk: false,
    sentinelComplete: false,
    dialogueCharacterIds: [],
    identityPreserved: false,
  };
  try {
    const knownSpeakers = new Set([
      ...ctx.roster.characters.map((definition) => definition.name),
      ...rosterIds,
    ]);
    const parsed = parseDslSegmentText(spec.v1Text, {
      expectedNonce: spec.expectedNonce,
      allowedReasons: dslTaskCapability(spec.task).endReasons,
      knownSpeakers,
    });
    const compiled = compileEventGroups(parsed.groups, {
      registry: ctx.presentationRegistry,
      tailState: createInitialVisualState(),
      reduce: ctx.v1Reduce,
      defaultsFor: ctx.v1Defaults.defaultFor.bind(ctx.v1Defaults),
    });
    const v1DialogueIds = compiled.groups
      .map((group) => group.main)
      .filter((main): main is Extract<CompiledMainEvent, { type: "dialogue" }> => main.type === "dialogue")
      .map((main) => main.characterId);
    v1Result = {
      firstPassOk: parsed.status.kind === "complete",
      sentinelComplete: parsed.status.kind === "complete",
      dialogueCharacterIds: v1DialogueIds,
      identityPreserved: v1DialogueIds.every((id) => rosterIds.has(id)),
    };
  } catch (error) {
    notes.push(`v1 回放异常：${error instanceof Error ? error.message : String(error)}`);
  }

  // --- 投影（serializeStoryContext：身份稳定事件 JSON） ---
  const storedEvents: StoryContextEvent[] = dialogueGroups.map((group, index) => ({
    type: "dialogue",
    characterId: group.characterId,
    speaker: group.displayLabel,
    displayLabel: group.displayLabel,
    text: group.text,
    line_id: `${spec.id}-line-${index + 1}`,
  }));
  const projected =
    storedEvents.length > 0 ? serializeStoryContext(storedEvents, ctx.registry) : "";
  const projectionCarriesStableIds = dialogueGroups.every((group) =>
    projected.includes(`"characterId":"${group.characterId}"`),
  );
  const projectionFreeOfBareLabelHeads = dialogueGroups.every(
    (group) => !new RegExp(`^${escapeRegExp(group.displayLabel)}: `, "m").test(projected),
  );

  // --- 音频身份（main roster + voices.yaml local 绑定） ---
  const voiceByCharacter = new Map<string, Set<string>>();
  let audioSpeakerIdMatchesCharacter = dialogueGroups.length > 0;
  let voiceSingletonPerCharacter = true;
  for (let i = 0; i < dialogueGroups.length; i += 1) {
    const group = dialogueGroups[i]!;
    const observation = observeAudioIdentity(
      ctx.factory,
      `${spec.id}-audio-${i + 1}`,
      group.characterId,
      group.displayLabel,
      group.text,
    );
    if (!observation.available || observation.speakerId !== group.characterId) {
      audioSpeakerIdMatchesCharacter = false;
      notes.push(
        `音频身份不匹配（${group.characterId}/${group.displayLabel}）：` +
          `${observation.available ? observation.speakerId : observation.reason}`,
      );
    }
    if (observation.available) {
      const key = `${observation.voiceId}@${observation.voiceRevision}`;
      const set = voiceByCharacter.get(group.characterId) ?? new Set<string>();
      set.add(key);
      voiceByCharacter.set(group.characterId, set);
    } else {
      voiceSingletonPerCharacter = false;
      notes.push(`音色不可用（${group.characterId}）：${observation.reason}`);
    }
  }
  for (const [characterId, keys] of voiceByCharacter) {
    if (keys.size !== 1) {
      voiceSingletonPerCharacter = false;
      notes.push(`音色漂移（${characterId}）：${[...keys].join(" | ")}`);
    }
  }
  /** 化名段（带 expectedLabelSnapshots 的场景）：每个角色的音色身份必须是单例。 */
  const aliasCharacterIds =
    spec.expectedLabelSnapshots !== undefined
      ? new Set(dialogueGroups.map((group) => group.characterId))
      : new Set<string>();
  const aliasVoiceStable =
    spec.expectedLabelSnapshots !== undefined
      ? [...aliasCharacterIds].every((id) => (voiceByCharacter.get(id)?.size ?? 0) === 1)
      : null;

  // --- 文本保真探针 ---
  const allGroupTexts = v2.groups
    .map((group) => group.main)
    .map((main) => (main.type === "dialogue" || main.type === "narration" ? main.text : ""))
    .join("\n");
  const textFidelity =
    spec.expectedTextSubstrings !== undefined
      ? {
          expected: [...spec.expectedTextSubstrings],
          allPresent: spec.expectedTextSubstrings.every((probe) => allGroupTexts.includes(probe)),
        }
      : null;

  const labelSnapshotsMatch =
    spec.expectedLabelSnapshots === undefined ||
    (labelSnapshots.length === spec.expectedLabelSnapshots.length &&
      labelSnapshots.every((label, index) => label === spec.expectedLabelSnapshots![index]));

  const identity = {
    characterIdKnown: dialogueGroups.every((group) => rosterIds.has(group.characterId)),
    characterIdAllowedToSpeak: dialogueGroups.every((group) => allowed.has(group.characterId)),
    projectionCarriesStableIds,
    projectionFreeOfBareLabelHeads,
    audioSpeakerIdMatchesCharacter,
    voiceSingletonPerCharacter,
    aliasVoiceStable,
  };

  const passed =
    v2.ok &&
    v1Result.firstPassOk &&
    v1Result.identityPreserved &&
    identity.characterIdKnown &&
    identity.characterIdAllowedToSpeak &&
    identity.projectionCarriesStableIds &&
    identity.projectionFreeOfBareLabelHeads &&
    identity.audioSpeakerIdMatchesCharacter &&
    identity.voiceSingletonPerCharacter &&
    (aliasVoiceStable ?? true) &&
    labelSnapshotsMatch &&
    (textFidelity?.allPresent ?? true) &&
    (slotExclusivityObserved ?? true) &&
    (hiddenSpeakerObserved ?? true) &&
    (playerProjectionClean ?? true);

  return {
    id: spec.id,
    focus: spec.focus,
    task: spec.task,
    expectedNonce: spec.expectedNonce,
    speakersCovered: [...new Set(dialogueGroups.map((group) => group.characterId))].sort(),
    v2: {
      firstPassOk: v2.ok,
      diagnosticCodes: v2.diagnostics.map((diagnostic) => diagnostic.code),
      groupCount: v2.groups.length,
      dialogueGroups,
      assetDiagnosticCodes,
      labelSnapshots,
      labelSnapshotsMatch,
      slotExclusivityObserved,
      hiddenSpeakerObserved,
      playerProjectionClean,
    },
    v1: v1Result,
    identity,
    textFidelity,
    passed,
    notes,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function evaluateDefect(ctx: MainContext, spec: DefectSpec): Promise<DefectResult> {
  const cast = mainCast(ctx.roster);
  const baseOptions = {
    text: spec.text,
    expectedNonce: spec.expectedNonce,
    task: spec.task,
    registry: ctx.registry,
    cast,
    reduce: ctx.v2Reduce,
    visualState: createInitialVisualState(),
    characterState: createCharacterRuntimeState(),
    catalog: ctx.catalog,
  };
  const first = compileSegmentV2(baseOptions);
  const firstCode = first.diagnostics[0]?.code ?? (first.ok ? "OK" : "UNKNOWN");

  const result = await compileSegmentV2WithRepair(baseOptions, async (_diagnostics, tail) =>
    spec.repair(tail.text),
  );

  // D5 原子性：首次失败时坏组的改名不得落地。
  const atomicRenameWithheld =
    spec.id === "D5-atomic-rename-plus-bad-look"
      ? first.characterState.labels["suyao"] === undefined
      : null;
  // D2 前缀纯净：首次失败的可播放前缀不含幻影身份对白。
  const noPhantomIdentityInPrefix =
    spec.id === "D2-unknown-speaker-id"
      ? first.groups.every(
          (group) => !(group.main.type === "dialogue" && group.main.characterId === "stranger"),
        )
      : null;

  const passed =
    firstCode === spec.expectFirstPassCode &&
    result.repairRequested &&
    result.repairApplied &&
    result.ok &&
    (atomicRenameWithheld ?? true) &&
    (noPhantomIdentityInPrefix ?? true);

  return {
    id: spec.id,
    label: spec.label,
    firstPassCode: firstCode,
    firstPassCodeMatches: firstCode === spec.expectFirstPassCode,
    repairRequested: result.repairRequested,
    repairApplied: result.repairApplied,
    finalOk: result.ok,
    finalDiagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
    committedPrefixGroups: first.groups.length,
    totalGroupsAfterRepair: result.groups.length,
    atomicRenameWithheld,
    noPhantomIdentityInPrefix,
    passed,
  };
}

function buildGateTable(report: Omit<OfflineEvaluationReport, "reportHash">): GateRow[] {
  const totals = report.summary.totals;
  const knownRedText =
    totals.knownRed.length > 0 ? `已知红灯 ${totals.knownRed.join("、")}` : "无已知红灯";
  return [
    {
      metric: "离线身份、语法、存储与隔离契约",
      offlineComputable: true,
      howMeasured: "契约向量（共享+main）＋ 12 场景双协议回放/投影/音频身份全链路",
      offlineValue: `向量 ${totals.vectorPass}/${totals.vectorTotal} 绿（${knownRedText}）；场景 ${totals.scenarioPass}/${totals.scenarioTotal} 绿`,
    },
    {
      metric: "线上已接受事件的身份完整率",
      offlineComputable: false,
      howMeasured: "TBD-online：在线配对评估；离线代理 = 场景投影/音频身份完整性",
      offlineValue: `TBD-online（离线代理：${totals.scenarioPass}/${totals.scenarioTotal}）`,
    },
    {
      metric: "未注册角色/越权玩家对白被接受",
      offlineComputable: true,
      howMeasured: "注入缺陷 D2/D4：首次编译必须拒绝（不“凑一个角色”）",
      offlineValue: `${totals.acceptedUnknownSpeakerOrPlayerSpeech} 起被接受`,
    },
    {
      metric: "有已配置可用音色时，因化名导致静音/串音",
      offlineComputable: true,
      howMeasured: "R02 双向量（共享 fixture + main 真配置）＋ S07 化名段音色恒定",
      offlineValue: `${totals.aliasVoiceIncidents} 起`,
    },
    {
      metric: "first-pass 协议有效率",
      offlineComputable: true,
      howMeasured: "离线固定语料回放（12 场景）；在线 n/失败类型/旧版对照 TBD-online",
      offlineValue: `离线回放 ${totals.firstPassReplayRate}（固定语料，非模型指标）；在线 TBD-online`,
    },
    {
      metric: "最多 1 次 repair 后有效率",
      offlineComputable: true,
      howMeasured: "注入缺陷脚本化修复模拟（≤1 次）；在线 TBD-online",
      offlineValue: `修复模拟 ${totals.repairSuccessRate}；在线 TBD-online（采样小不得声称生产 SLA）`,
    },
    {
      metric: "命名漂移、非法素材、重复前缀、记忆非法引用",
      offlineComputable: true,
      howMeasured: "分项计数：名牌快照 vs 期望 / assetDiagnostics 码 / 记忆拒绝诊断",
      offlineValue:
        `命名漂移 ${totals.namingDriftCount}；素材诊断 ` +
        `${JSON.stringify(totals.assetDiagnosticCounts)}；记忆拒绝诊断 ` +
        `${totals.memoryRejectionDiagnosticsObserved}（MAIN-MEMORY 红灯期间为 0）`,
    },
    {
      metric: "prompt token",
      offlineComputable: false,
      howMeasured: "TBD-online：相同人物信息预算下公共规则/重复目录部分目标下降 ≥25%",
      offlineValue: "TBD-online",
    },
    {
      metric: "时延",
      offlineComputable: false,
      howMeasured: "TBD-online：首个可播放组与完整段 p50/p95",
      offlineValue: "TBD-online",
    },
    {
      metric: "内容质量",
      offlineComputable: false,
      howMeasured: "TBD-online：人工盲审角色辨识度/自然程度/玩家控制/演员知情边界",
      offlineValue: "TBD-online",
    },
  ];
}

export interface OfflineEvaluationInput {
  packPath: string;
  voicesPath: string;
  assetsPath: string;
}

/** 构建完整离线评估报告（确定性：同输入 → 同字节）。 */
export async function buildOfflineEvaluation(
  input: OfflineEvaluationInput,
): Promise<OfflineEvaluationReport> {
  const ctx = await buildMainContext(input.packPath, input.voicesPath, input.assetsPath);

  const sharedVectors = await evaluateContractVectors();
  const mainVectors = await evaluateMainVectors(ctx.roster, ctx.factory, ctx.registry);
  const contractVectors = [...sharedVectors, ...mainVectors];

  const scenarios = mainScenarioSet().map((spec) => evaluateScenario(ctx, spec));
  const repairSim: DefectResult[] = [];
  for (const defect of injectedDefectSet()) {
    repairSim.push(await evaluateDefect(ctx, defect));
  }

  const knownRed = contractVectors.filter((vector) => vector.knownRed).map((vector) => vector.id);
  const unexpectedFail = contractVectors
    .filter((vector) => vector.status === "fail" && !vector.knownRed && vector.expectation !== "pinned-current")
    .map((vector) => vector.id);
  const turnedGreen = contractVectors
    .filter((vector) => vector.status === "pass" && EXPECTED_RED_VECTOR_IDS.has(vector.id))
    .map((vector) => vector.id);

  const assetDiagnosticCounts: Record<string, number> = {};
  for (const scenario of scenarios) {
    for (const code of scenario.v2.assetDiagnosticCodes) {
      assetDiagnosticCounts[code] = (assetDiagnosticCounts[code] ?? 0) + 1;
    }
  }

  const defectDetected = repairSim.filter((defect) => defect.firstPassCodeMatches).length;
  const repairSuccessRate = `${repairSim.filter((defect) => defect.finalOk).length}/${repairSim.length}`;
  const scenarioPass = scenarios.filter((scenario) => scenario.passed).length;
  const aliasVoiceIncidents =
    (contractVectors.find((vector) => vector.id === "R02-shared")?.status === "fail" ? 1 : 0) +
    (contractVectors.find((vector) => vector.id === "R02-main")?.status === "fail" ? 1 : 0) +
    (scenarios.find((scenario) => scenario.id === "S07-alias-label-snapshot")?.identity.aliasVoiceStable ===
    false
      ? 1
      : 0);

  const partial: Omit<OfflineEvaluationReport, "reportHash"> = {
    schema: "character-dsl-v2-evaluation/1",
    mode: "offline-replay",
    meta: {
      harness: "scripts/evaluate-character-dsl.ts",
      branchAgnostic: true,
      inputs: {
        pack: { path: path.basename(input.packPath), sha256: await sha256File(input.packPath) },
        voices: { path: path.basename(input.voicesPath), sha256: await sha256File(input.voicesPath) },
        assets: {
          path: input.assetsPath.split(/[\\/]/).slice(-2).join("/"),
          sha256: await sha256File(input.assetsPath),
        },
      },
      roster: {
        scopeId: ctx.roster.scopeId,
        revision: ctx.roster.revision,
        characterIds: ctx.roster.characters.map((definition) => definition.id),
        playerId: ctx.roster.playerId,
      },
      sampleDesign: SAMPLE_DESIGN,
      pipeline: [
        "parseDslLine/parseDslSegmentText（v1 冻结语法）",
        "parseDslV2Line + DslSegmentParserV2（v2）",
        "compileEventGroups（v1 presentation registry）",
        "compileSegmentV2 / compileSegmentV2WithRepair（v2 roster registry）",
        "serializeStoryContext（C5 身份稳定投影）",
        "AudioDescriptorFactory.build（main roster + voices.yaml local 绑定）",
      ],
    },
    contractVectors,
    scenarios,
    repairSim,
    online: emptyOnlineReport(),
    summary: {
      gateTable: [],
      totals: {
        vectorTotal: contractVectors.length,
        vectorPass: contractVectors.filter((vector) => vector.status === "pass").length,
        vectorFail: contractVectors.filter((vector) => vector.status === "fail").length,
        knownRed,
        unexpectedFail,
        turnedGreen,
        scenarioTotal: scenarios.length,
        scenarioPass,
        firstPassReplayRate: `${scenarioPass}/${scenarios.length}`,
        defectTotal: repairSim.length,
        defectDetected,
        repairSuccessRate,
        acceptedUnknownSpeakerOrPlayerSpeech: repairSim.filter(
          (defect) =>
            (defect.id === "D2-unknown-speaker-id" || defect.id === "D4-player-speech") &&
            defect.firstPassCode === "OK",
        ).length,
        aliasVoiceIncidents,
        namingDriftCount: scenarios.filter(
          (scenario) => scenario.v2.labelSnapshotsMatch === false,
        ).length,
        assetDiagnosticCounts,
        memoryRejectionDiagnosticsObserved: contractVectors.find(
          (vector) => vector.id === "MAIN-MEMORY",
        )?.knownRed
          ? 0
          : 1,
      },
    },
  };

  const gateTable = buildGateTable(partial);
  const withGate = { ...partial, summary: { ...partial.summary, gateTable } };
  const reportHash = sha256(stableStringify(withGate));
  return { ...withGate, reportHash };
}

// ---------------------------------------------------------------------------
// 摘要渲染（console + markdown）
// ---------------------------------------------------------------------------

export function renderConsoleSummary(report: OfflineEvaluationReport): string {
  const t = report.summary.totals;
  const lines: string[] = [];
  lines.push("角色 DSL v2 离线评估（replay/contract，零模型调用）");
  lines.push("=".repeat(56));
  lines.push(`内容包：${report.meta.roster.scopeId}（revision ${report.meta.roster.revision.slice(0, 12)}…）`);
  lines.push(
    `契约向量：${t.vectorPass}/${t.vectorTotal} 绿` +
      (t.knownRed.length > 0 ? `；已知红灯（红灯即规格）：${t.knownRed.join("、")}` : "") +
      (t.unexpectedFail.length > 0 ? `；意外失败：${t.unexpectedFail.join("、")}` : ""),
  );
  lines.push(`场景回放：${t.scenarioPass}/${t.scenarioTotal} 绿（v1+v2 双协议、投影、音频身份）`);
  lines.push(
    `注入缺陷：检出 ${t.defectDetected}/${t.defectTotal}，修复成功率 ${t.repairSuccessRate}`,
  );
  lines.push("");
  lines.push("§10.2 发布门槛（离线可计算行）：");
  for (const row of report.summary.gateTable) {
    if (!row.offlineComputable) continue;
    lines.push(`  - ${row.metric}`);
    lines.push(`      ${row.offlineValue}`);
  }
  lines.push("");
  lines.push(`报告摘要 sha256：${report.reportHash}`);
  return lines.join("\n");
}

export function renderSummaryMarkdown(report: OfflineEvaluationReport): string {
  const t = report.summary.totals;
  const lines: string[] = [];
  lines.push("# 角色 DSL v2 离线评估报告（replay/contract）");
  lines.push("");
  lines.push("- 模式：离线回放（零模型调用、零费用）；在线腿 NOT_ENABLED（V2 gate 接线）");
  lines.push(
    `- 输入：${report.meta.inputs.pack.path}（${report.meta.inputs.pack.sha256.slice(0, 12)}…）、` +
      `${report.meta.inputs.voices.path}、${report.meta.inputs.assets.path}`,
  );
  lines.push(`- roster：${report.meta.roster.scopeId}，revision ${report.meta.roster.revision}`);
  lines.push(`- 报告摘要 sha256：\`${report.reportHash}\``);
  lines.push("");
  lines.push("## 契约向量");
  lines.push("");
  lines.push("| 向量 | 要求 | 期望 | 结果 | 说明 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const vector of report.contractVectors) {
    lines.push(
      `| ${vector.id} | ${vector.requirement} | ${vector.expectation} | ` +
        `${vector.status === "pass" ? "绿" : vector.knownRed ? "红（已知，红灯即规格）" : "红（意外）"} | ${vector.detail} |`,
    );
  }
  lines.push("");
  lines.push("## 场景回放（12 固定场景）");
  lines.push("");
  lines.push("| 场景 | 任务 | 首过(v2) | 首过(v1) | 说话人 | 通过 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.id} | ${scenario.task} | ${scenario.v2.firstPassOk ? "绿" : "红"} | ` +
        `${scenario.v1.firstPassOk ? "绿" : "红"} | ${scenario.speakersCovered.join(", ")} | ` +
        `${scenario.passed ? "绿" : "红"} |`,
    );
  }
  lines.push("");
  lines.push("## 注入缺陷修复模拟");
  lines.push("");
  lines.push("| 缺陷 | 首过错误码 | 匹配 | 修复请求 | 修复采纳 | 最终 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const defect of report.repairSim) {
    lines.push(
      `| ${defect.id} | ${defect.firstPassCode} | ${defect.firstPassCodeMatches ? "是" : "否"} | ` +
        `${defect.repairRequested ? "是" : "否"} | ${defect.repairApplied ? "是" : "否"} | ` +
        `${defect.finalOk ? "绿" : "红"} |`,
    );
  }
  lines.push("");
  lines.push("## §10.2 发布门槛（离线可计算行）");
  lines.push("");
  lines.push("| 指标 | 离线可测 | 如何测量 | 本次结果 |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of report.summary.gateTable) {
    lines.push(
      `| ${row.metric} | ${row.offlineComputable ? "是" : "否"} | ${row.howMeasured} | ${row.offlineValue} |`,
    );
  }
  lines.push("");
  lines.push("## 在线评估（未运行）");
  lines.push("");
  lines.push(`- 状态：${report.online.status}`);
  lines.push(`- 原因：${report.online.reason}`);
  lines.push(
    "- 采样设计：24 确定输入（校园 12 + main 12）× 每版本 3 次 = 144 次主生成；repair 每次 ≤1，另计预算。",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.mode === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.mode === "error") {
    process.stderr.write(`参数错误：${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.mode === "online") {
    try {
      await runOnlineEvaluation({
        model: parsed.model!,
        maxCalls: parsed.maxCalls!,
        budget: parsed.budget!,
        seed: null,
        temperature: null,
        repeatsPerCase: SAMPLE_DESIGN.repeatsPerVersion,
        pairedBaseline: "frozen-legacy",
        variant: "dsl-plus-prompt",
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
      return 3;
    }
    return 0;
  }

  const report = await buildOfflineEvaluation({
    packPath: parsed.packPath,
    voicesPath: parsed.voicesPath,
    assetsPath: parsed.assetsPath,
  });

  process.stdout.write(`${renderConsoleSummary(report)}\n`);

  if (parsed.outDir !== undefined) {
    const outDir = path.resolve(parsed.outDir);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "report.json"), `${stableStringify(report)}\n`, "utf8");
    await writeFile(path.join(outDir, "summary.md"), `${renderSummaryMarkdown(report)}\n`, "utf8");
    process.stdout.write(`\n已写入：${path.join(outDir, "report.json")} 与 summary.md\n`);
  } else {
    process.stdout.write("\n（未传 --out：只打印摘要，未写任何文件）\n");
  }
  return 0;
}

/** 入口判定：作为 CLI 运行时才执行 main（vitest 动态导入不触发）。 */
const invokedAsCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`评估 harness 内部错误：${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
