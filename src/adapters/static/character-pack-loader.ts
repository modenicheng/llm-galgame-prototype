/**
 * 静态角色名册内容包加载器（M1）——main 自己的 `characters.yaml` →
 * C2 `CharacterRoster`。
 *
 * main 静态 fallback 世界的身份真源（计划 §3.2）：registry、人物卡投影
 * （prompts/characters.txt）与音频绑定（voiceProfileId，与 voices.yaml
 * 按 ID join）都从本文件派生。与校园侧共享 loader 的文件级统一在 C4/V1；
 * 本加载器按 C2 共享核心 schema 实现，不引入中文别名副本。
 *
 * revision 由加载器按 C2 规范化投影计算；文件内手写 revision 与计算值
 * 不符时大声报错（防手工拼接/篡改名册）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { buildCharacterRoster } from "../../core/characters/registry.js";
import type { CharacterRoster } from "../../core/characters/types.js";
import { CharacterDefinitionSchema } from "../../core/characters/types.js";

/** 内容包 YAML 形状（revision 可选，仅作防篡改校验）。 */
const CharacterPackFileSchema = z
  .object({
    schemaVersion: z.literal(2),
    scopeId: z.string().min(1),
    playerId: z.string().min(1),
    revision: z.string().min(1).optional(),
    characters: z.array(CharacterDefinitionSchema).min(1),
  })
  .strict();

/**
 * 读取并校验静态角色名册内容包。任何失败（缺文件、YAML 损坏、schema
 * 不符、玩家契约、revision 篡改）都大声抛错——身份真源缺失或损坏不是
 * 「空名册」。
 */
export async function loadCharacterPackRoster(filePath: string): Promise<CharacterRoster> {
  const absolutePath = path.resolve(filePath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取角色名册内容包 ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(
      `角色名册内容包 YAML 解析失败 ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = CharacterPackFileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`角色名册内容包校验失败 ${absolutePath}: ${detail}`);
  }

  const file = result.data;
  const draft = {
    schemaVersion: 2 as const,
    scopeId: file.scopeId,
    playerId: file.playerId,
    characters: file.characters,
  };
  const roster = buildCharacterRoster(draft);
  if (file.revision !== undefined && file.revision !== roster.revision) {
    throw new Error(
      `角色名册内容包 revision 与内容不一致 ${absolutePath}：文件声明 ${file.revision}，计算得 ${roster.revision}（revision 由加载器计算，请勿手写）`,
    );
  }
  return roster;
}
