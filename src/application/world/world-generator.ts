/**
 * WorldGenerator（执行清单 M3.3 + M1 角色名册）——用户文本 → 编剧 → 校验
 * → 落盘 → 直通开玩。
 *
 * M1 纪律：任何正式世界文件（outline 修订、canon 脚手架、voice-design、
 * per-game prompts）落盘之前，先对 world draft 做完整角色校验（重复 ID、
 * 非法 ID、玩家数、非法 spriteBinding、动态-author 冲突、玩家音频画像）
 * ——结构化失败或修复后重试，绝不静默 last-wins 写半成品世界。
 *
 * 流程：OutlineWriter 产出 WorldDraft → 校验（fail-before-write）→
 * OutlineStore add 批写入初版大纲（revision 1）→ `world/canon.json` 脚手架
 * （worldSetting + characters 携带 control/initialLabel 权威元信息）→
 * voice-design.json（按 ID join，玩家角色无画像）→ per-game 派生 prompt
 * 文件（characters.txt 携带来源 revision；story_line.txt）→ 返回 gameId。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { CanonStore } from "../../adapters/storage/canon-store.js";
import { VoiceDesignStore } from "../../adapters/storage/voice-design-store.js";
import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js";
import type { DraftCharacter, CharacterVoiceDesign, OutlineWriterPort, WorldDraft } from "../outline/outline-writer.js";
import type { AssetCatalog } from "../../core/assets/types.js";
import type { CanonCharacter, CanonSnapshot } from "../../core/ports/canon-store-port.js";
import {
  canonCharactersFromDraft,
  canonRosterRevision,
  isRosterCapableCanon,
  validateWorldCharacters,
  WorldCharacterSetError,
} from "../characters/world-roster.js";

/** per-game prompt 覆盖目录（M3.3 ②；随卡新增，不改 §9 冻结布局）。 */
export const WORLD_PROMPTS_DIR = "world/prompts";

/**
 * 派生人物卡的来源标记头（M1）：`# derived-from: world/canon.json@<revision>`。
 * revision 是 canon 角色的 roster 规范化摘要——加载时校验，缺卡/过期由
 * canon 再生；身份从不依赖卡的存在。
 */
export const DERIVED_CARD_SOURCE_PREFIX = "# derived-from: world/canon.json@";

export interface WorldGenerationRequest {
  userText: string;
  seedStoryLine?: string;
}

export interface WorldGeneratorOptions {
  /** OutlineWriter port（M3.2 的单次 JSON 调用 adapter）。 */
  writer: OutlineWriterPort;
  /** 世界根目录（默认 "games"，与 bootstrap 同源）。 */
  gamesRoot?: string;
  /** gameId 生成器（缺省时间戳式，与 bootstrap 同一约定）。 */
  newGameId?: () => string;
  /**
   * M1：素材目录（提供时校验 spriteBinding 引用真实素材集；author 素材
   * 可被引用，缺素材集 = 非法绑定，创建前失败）。
   */
  assets?: AssetCatalog;
  /**
   * M1：author 角色表 ID（静态名册/资产目录兼容边界）。动态角色 ID 与之
   * 冲突 = 意图不明的同键覆盖，创建前失败（禁止 last-wins）。
   */
  authorCharacterIds?: readonly string[];
}

// ---------------------------------------------------------------------------
// 派生人物卡（canon → 卡投影）
// ---------------------------------------------------------------------------

/** 卡投影条目（canon 角色 ⊕ voice-design 按 ID join 的画像）。 */
export interface CharacterCardEntry {
  id: string;
  name: string;
  description: string;
  control?: "player" | "npc";
  initialLabel?: string;
  spriteBinding?: string;
  voice?: { timbre: string };
}

const PLAYER_CONTROL_LINE =
  "控制：玩家（模型不得替该角色生成台词、选择或确认对白；玩家话语只来自玩家输入）";
const NPC_CONTROL_LINE = "控制：NPC";

/** 角色卡渲染：`【名】(id)` + 控制类型 + 描述 + 可选名牌/立绘绑定与嗓音画像。 */
export function renderCharacters(characters: readonly CharacterCardEntry[]): string {
  return characters
    .map((c) =>
      [
        `【${c.name}】(${c.id})`,
        c.control === "player" ? PLAYER_CONTROL_LINE : NPC_CONTROL_LINE,
        c.description,
        ...(c.initialLabel !== undefined && c.initialLabel !== c.name
          ? [`初始名牌：${c.initialLabel}`]
          : []),
        ...(c.spriteBinding !== undefined ? [`立绘绑定：${c.spriteBinding}`] : []),
        ...(c.voice !== undefined ? [`嗓音：${c.voice.timbre}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}

/** 故事线渲染：世界设定 + 幕级目的链（不含结局文本，防剧透）。 */
export function renderStoryLine(draft: WorldDraft): string {
  const setting = `【世界设定】\n${draft.worldSetting}`;
  const acts = draft.outline
    .filter((n) => n.kind === "act")
    .map((n) => `- ${n.purpose}${n.location !== undefined ? `（${n.location}）` : ""}`);
  return `${setting}\n\n【剧情走向】\n${acts.join("\n")}`;
}

/**
 * 校验/再生派生人物卡（M1，加载路径）：
 * - 非 roster 世界（旧 canon 无 control 元信息）不动旧卡（legacy 边界）；
 * - 缺卡或来源 revision 过期 → 由 canon + voice-design（按 ID join）再生；
 * - 卡存在且 revision 一致 → 原样保留（手改内容不静默覆盖，但 revision
 *   过期时以 canon 为准重写——canon 是唯一真源）。
 */
export async function ensureDerivedCharacterCard(input: {
  gamesRoot: string;
  gameId: string;
  canon: CanonSnapshot;
  assets?: AssetCatalog;
}): Promise<void> {
  if (!isRosterCapableCanon(input.canon)) return;

  const scopeId = `world:${input.gameId}`;
  const revision = canonRosterRevision({
    scopeId,
    characters: input.canon.characters,
    ...(input.assets !== undefined ? { assets: input.assets } : {}),
  });
  const designs = await new VoiceDesignStore(input.gamesRoot, input.gameId).load();
  const entries: CharacterCardEntry[] = input.canon.characters.map((character) => {
    const design = designs?.characters[character.id];
    return {
      ...character,
      ...(design !== undefined ? { voice: design.voice } : {}),
    };
  });
  const expected = `${DERIVED_CARD_SOURCE_PREFIX}${revision}\n\n${renderCharacters(entries)}\n`;

  const cardPath = path.join(input.gamesRoot, input.gameId, WORLD_PROMPTS_DIR, "characters.txt");
  let current: string | undefined;
  try {
    current = await readFile(cardPath, "utf8");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
      throw err;
    }
  }
  if (current !== undefined) {
    const header = current.split("\n")[0] ?? "";
    // 来源 revision 一致 → 卡与 canon 同源，原样保留（revision 校验通过）。
    if (header === `${DERIVED_CARD_SOURCE_PREFIX}${revision}`) return;
  }
  await mkdir(path.dirname(cardPath), { recursive: true });
  await writeAtomic(cardPath, expected);
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

export class WorldGenerator {
  private readonly gamesRoot: string;

  constructor(private readonly options: WorldGeneratorOptions) {
    this.gamesRoot = options.gamesRoot ?? DEFAULT_GAMES_ROOT;
  }

  async generate(request: WorldGenerationRequest): Promise<{ gameId: string; draft: WorldDraft }> {
    if (request.userText.trim().length === 0) {
      throw new Error("世界描述不能为空");
    }

    const gameId =
      this.options.newGameId?.() ??
      `game_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const store = new OutlineStore(this.gamesRoot, gameId);
    await store.load();

    const draft = await this.options.writer.writeOutline({
      userText: request.userText,
      ...(request.seedStoryLine !== undefined ? { seedStoryLine: request.seedStoryLine } : {}),
    });

    // M1 创建前校验：任何正式世界文件落盘之前，draft 角色集必须合法
    //（结构化 issues 失败；修复由编剧重试完成，不写半成品世界）。
    const issues = validateWorldCharacters({
      characters: draft.characters,
      source: "draft",
      ...(this.options.assets !== undefined ? { assets: this.options.assets } : {}),
      ...(this.options.authorCharacterIds !== undefined && this.options.authorCharacterIds.length > 0
        ? { authorCharacterIds: this.options.authorCharacterIds }
        : {}),
    });
    if (issues.length > 0) {
      throw new WorldCharacterSetError(issues, `WorldGenerator.generate(${gameId})`);
    }

    // 初版大纲：整批 add（revision 1）。
    await store.applyRevision(
      draft.outline.map((node) => ({ type: "add" as const, node })),
      "编剧初版大纲（M3.3 世界生成）",
    );

    const gameDir = path.join(this.gamesRoot, gameId);
    // world/canon.json 脚手架（M3.6 CanonStore + M1 权威元信息：control/
    // initialLabel 必写）。canonCharactersFromDraft 内部再校验一次（防
    // 上面校验与转换之间的形状漂移）。
    const canonCharacters: CanonCharacter[] = canonCharactersFromDraft(draft, {
      ...(this.options.assets !== undefined ? { assets: this.options.assets } : {}),
      ...(this.options.authorCharacterIds !== undefined
        ? { authorCharacterIds: this.options.authorCharacterIds }
        : {}),
    });
    const canon = new CanonStore(this.gamesRoot, gameId);
    await canon.saveScaffold({
      worldSetting: draft.worldSetting,
      characters: canonCharacters,
    });

    // V2（角色音频特征设计 §3.1）：有音频画像的 NPC 落盘 voice-design.json
    //（世界创建期写一次，按 ID join）；玩家角色无画像（校验已拒绝）；
    // 无画像角色 → 不落盘（缺音色不丢身份）。
    const designed = draft.characters.filter(
      (c): c is DraftCharacter & { voice: CharacterVoiceDesign } => c.voice !== undefined,
    );
    if (designed.length > 0) {
      await new VoiceDesignStore(this.gamesRoot, gameId).save({
        version: 1,
        characters: Object.fromEntries(
          designed.map((c) => [c.id, { name: c.name, voice: c.voice }]),
        ),
      });
    }

    // per-game prompts（loadPrompts 优先读取，见 prompts.ts）：characters.txt
    // 是携带来源 revision 的派生卡（ensureDerivedCharacterCard 再生/校验）。
    const promptsDir = path.join(gameDir, WORLD_PROMPTS_DIR);
    await mkdir(promptsDir, { recursive: true });
    await ensureDerivedCharacterCard({
      gamesRoot: this.gamesRoot,
      gameId,
      canon: canon.getCanon(),
      ...(this.options.assets !== undefined ? { assets: this.options.assets } : {}),
    });
    await writeAtomic(path.join(promptsDir, "story_line.txt"), renderStoryLine(draft));

    return { gameId, draft };
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}
