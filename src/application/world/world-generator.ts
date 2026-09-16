/**
 * WorldGenerator（执行清单 M3.3）——用户文本 → 编剧 → 落盘 → 直通开玩。
 *
 * 流程：OutlineWriter 产出 WorldDraft → OutlineStore 以 add 批写入初版
 * 大纲（revision 1）→ `world/canon.json` 脚手架（worldSetting + characters，
 * 形状与 M3.6 对齐）→ per-game prompt 文件 `world/prompts/characters.txt +
 * story_line.txt` → 返回 gameId（复用 M5.0 世界身份约定）。生成失败大声
 * 抛错，不静默回退全局 story_line。
 */

import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { OutlineStore } from "../../adapters/storage/outline-store.js";
import { CanonStore } from "../../adapters/storage/canon-store.js";
import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js";
import type { OutlineWriterPort, WorldDraft } from "../outline/outline-writer.js";

/** per-game prompt 覆盖目录（M3.3 ②；随卡新增，不改 §9 冻结布局）。 */
export const WORLD_PROMPTS_DIR = "world/prompts";

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
}

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

    // 初版大纲：整批 add（revision 1）。
    await store.applyRevision(
      draft.outline.map((node) => ({ type: "add" as const, node })),
      "编剧初版大纲（M3.3 世界生成）",
    );

    const gameDir = path.join(this.gamesRoot, gameId);
    // world/canon.json 脚手架（M3.6 CanonStore：形状唯一真源；拒绝覆写）。
    const canon = new CanonStore(this.gamesRoot, gameId);
    await canon.saveScaffold({
      worldSetting: draft.worldSetting,
      characters: draft.characters,
    });

    // per-game prompts（loadPrompts 优先读取，见 prompts.ts）。
    const promptsDir = path.join(gameDir, WORLD_PROMPTS_DIR);
    await mkdir(promptsDir, { recursive: true });
    await writeAtomic(path.join(promptsDir, "characters.txt"), renderCharacters(draft));
    await writeAtomic(path.join(promptsDir, "story_line.txt"), renderStoryLine(draft));

    return { gameId, draft };
  }
}

/** 角色卡渲染：`【名】(id)` + 描述 + 可选立绘绑定。 */
export function renderCharacters(draft: WorldDraft): string {
  return draft.characters
    .map((c) =>
      [
        `【${c.name}】(${c.id})`,
        c.description,
        ...(c.spriteBinding !== undefined ? [`立绘绑定：${c.spriteBinding}`] : []),
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

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

