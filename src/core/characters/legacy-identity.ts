/**
 * 作用域内旧身份解析（C2 §3.2「旧世界/会话」兼容行）。
 *
 * 只服务于兼容/过渡边界：旧 scriptName（台词行头写出的名字）与旧 TTS
 * 配置键到稳定 CharacterId 的映射带版本与作用域，歧义必须可诊断。
 *
 * ⚠ 新生成路径不得调用本模块——新生成一律使用 CharacterRoster /
 * CharacterRegistry 的稳定 ID；旧名字不再暴露给新 writer。
 */
import type { CharacterId } from "./types.js";
import { isValidCharacterId } from "./types.js";

/** 兼容映射的版本：旧世界/旧会话数据固定为 1，不与新 roster v2 混用。 */
export interface LegacyIdentityScope {
  scopeId: string;
  schemaVersion: 1;
}

export interface LegacyScriptNameBinding {
  /** 旧台词行头/旧注册表里的名字（显示名，可能是中文名）。 */
  scriptName: string;
  characterId: CharacterId;
}

export interface LegacyTtsKeyBinding {
  /** 旧 TTS 配置键（键空间与资产 id 不同源，如 xuwanqing ≠ female_A）。 */
  ttsKey: string;
  characterId: CharacterId;
}

export interface LegacyIdentityMapping {
  scope: LegacyIdentityScope;
  scriptNames: readonly LegacyScriptNameBinding[];
  ttsKeys?: readonly LegacyTtsKeyBinding[];
}

export type LegacyIdentityVia = "scriptName" | "ttsKey";

/**
 * 解析结果一律结构化：resolved / ambiguous（同名多义，不许任选其一）/
 * unknown（不“猜一次姓名”）/ invalid（绑定本身非法，如危险键 ID）。
 * 每个结果携带 scopeId，跨世界同 ID 不共用解析。
 */
export type LegacyIdentityResolution =
  | {
      status: "resolved";
      via: LegacyIdentityVia;
      scopeId: string;
      matched: string;
      characterId: CharacterId;
    }
  | {
      status: "ambiguous";
      via: LegacyIdentityVia;
      scopeId: string;
      matched: string;
      candidates: readonly CharacterId[];
      diagnostic: string;
    }
  | {
      status: "unknown";
      via: LegacyIdentityVia;
      scopeId: string;
      matched: string;
      diagnostic: string;
    }
  | {
      status: "invalid";
      via: LegacyIdentityVia;
      scopeId: string;
      matched: string;
      diagnostic: string;
    };

export interface LegacyIdentityResolver {
  readonly scope: LegacyIdentityScope;
  resolveScriptName(scriptName: string): LegacyIdentityResolution;
  resolveTtsKey(ttsKey: string): LegacyIdentityResolution;
}

interface LegacyBindingTable {
  readonly via: LegacyIdentityVia;
  /** 名字 → 候选 ID 集合（Map + Set：成员检查不走原型链）。 */
  readonly entries: ReadonlyMap<string, ReadonlySet<CharacterId>>;
}

function buildTable(
  bindings: ReadonlyArray<{ key: string; characterId: CharacterId }>,
  via: LegacyIdentityVia,
): LegacyBindingTable {
  const entries = new Map<string, Set<CharacterId>>();
  for (const binding of bindings) {
    let candidates = entries.get(binding.key);
    if (candidates === undefined) {
      candidates = new Set<CharacterId>();
      entries.set(binding.key, candidates);
    }
    candidates.add(binding.characterId);
  }
  return { via, entries };
}

function resolveFromTable(
  table: LegacyBindingTable,
  scopeId: string,
  matched: string,
): LegacyIdentityResolution {
  const candidates = table.entries.get(matched);
  if (candidates === undefined) {
    return {
      status: "unknown",
      via: table.via,
      scopeId,
      matched,
      diagnostic: `旧身份表（scopeId=${scopeId}）中没有 ${JSON.stringify(matched)} 的映射；不允许按当前文本猜姓名`,
    };
  }
  const sorted = [...candidates].sort();
  if (sorted.length > 1) {
    return {
      status: "ambiguous",
      via: table.via,
      scopeId,
      matched,
      candidates: sorted,
      diagnostic: `旧身份 ${JSON.stringify(matched)} 在 scopeId=${scopeId} 内有 ${sorted.length} 个候选（${sorted.join(
        ", ",
      )}）；需要人工或显式 upcaster 消歧，不许任选其一`,
    };
  }
  const characterId = sorted[0]!;
  if (!isValidCharacterId(characterId)) {
    return {
      status: "invalid",
      via: table.via,
      scopeId,
      matched,
      diagnostic: `旧身份表把 ${JSON.stringify(matched)} 绑定到非法 ID ${JSON.stringify(characterId)}（危险键或格式不符）`,
    };
  }
  return { status: "resolved", via: table.via, scopeId, matched, characterId };
}

/**
 * 构造作用域内旧身份解析器。同名绑定到同一 ID 会去重（不算歧义）；
 * 同名绑定到多个 ID 在解析时报告 ambiguous 并给出全部候选。
 */
export function createLegacyIdentityResolver(
  mapping: LegacyIdentityMapping,
): LegacyIdentityResolver {
  const scopeId = mapping.scope.scopeId;
  const scriptNameTable = buildTable(
    mapping.scriptNames.map((binding) => ({
      key: binding.scriptName,
      characterId: binding.characterId,
    })),
    "scriptName",
  );
  const ttsKeyTable = buildTable(
    (mapping.ttsKeys ?? []).map((binding) => ({
      key: binding.ttsKey,
      characterId: binding.characterId,
    })),
    "ttsKey",
  );

  return {
    scope: mapping.scope,
    resolveScriptName(scriptName: string): LegacyIdentityResolution {
      return resolveFromTable(scriptNameTable, scopeId, scriptName);
    },
    resolveTtsKey(ttsKey: string): LegacyIdentityResolution {
      return resolveFromTable(ttsKeyTable, scopeId, ttsKey);
    },
  };
}
