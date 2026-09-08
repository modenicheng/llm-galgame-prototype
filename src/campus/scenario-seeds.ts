/**
 * 校园分支 —— 叙事种子（scenario seed）目录加载与选择。
 *
 * 语义约束（docs/superpowers/specs/2026-09-06-campus-ops-event-design.md §9）：
 * - 种子是"描述性素材"，只提供本局起点情境；schema 用 strictObject，
 *   任何流程化字段（required_rounds、success_path、ending_count…）都会
 *   让目录加载失败，从结构上禁止把种子变成状态机。
 * - 选择策略是确定性的：FNV-1a(sessionId) % seeds.length。同一 session
 *   必得同一种子；`restart_session` 产生新 session id → 自然轮换种子。
 *   显式指定 seed id 时必须存在（展位工作人员可用环境变量指定演示种子）。
 *
 * 本模块是校园分支专属内容通道；通用运行时只感知
 * `GamePorts.initialStoryState`（见 src/game.ts），不出现校园专名。
 */

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { createInitialState } from "../story/state.js";
import type { StoryState } from "../story/types.js";

// ---------------------------------------------------------------------------
// Catalog schema（strict —— 未知字段即校验失败）
// ---------------------------------------------------------------------------

const ScenarioSeedSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能是小写字母、数字和中划线"),
    title: z.string().min(1),
    seed: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    context: z.string().optional(),
    concerns: z.array(z.string()).optional(),
    boundaries: z.array(z.string()).optional(),
    angles: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
  });

export type ScenarioSeed = z.infer<typeof ScenarioSeedSchema>;

const ScenarioSeedCatalogSchema = z
  .strictObject({
    version: z.number().int().min(1),
    guidance: z.string().default(""),
    seeds: z.array(ScenarioSeedSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, seed] of value.seeds.entries()) {
      if (seen.has(seed.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["seeds", index, "id"],
          message: `种子 id 重复：${seed.id}`,
        });
      }
      seen.add(seed.id);
    }
  });

export interface ScenarioSeedCatalog {
  version: number;
  guidance: string;
  seeds: ScenarioSeed[];
}

// ---------------------------------------------------------------------------

/** FNV-1a 32-bit 稳定散列（与 audio 描述符种子同族算法）。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 加载并校验叙事种子目录 YAML。 */
export async function loadScenarioSeedCatalog(filePath: string): Promise<ScenarioSeedCatalog> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取叙事种子目录 ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(
      `叙事种子目录 YAML 解析失败 ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = ScenarioSeedCatalogSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`叙事种子目录校验失败 ${filePath}: ${detail}`);
  }
  return result.data;
}

/**
 * 选择本局种子：显式 seedId 优先（必须存在），否则按 sessionId 稳定散列
 * 轮换。确定性选择使 selection 可测试，也让同一次会话的重连/恢复
 * 不会悄悄换种子。
 */
export function selectScenarioSeed(
  catalog: ScenarioSeedCatalog,
  sessionId: string,
  explicitSeedId?: string,
): ScenarioSeed {
  if (explicitSeedId !== undefined && explicitSeedId !== "") {
    const seed = catalog.seeds.find((candidate) => candidate.id === explicitSeedId);
    if (seed === undefined) {
      throw new Error(
        `指定的叙事种子不存在：${explicitSeedId}（目录中共有 ${catalog.seeds.length} 个种子）`,
      );
    }
    return seed;
  }
  const index = fnv1a(sessionId) % catalog.seeds.length;
  return catalog.seeds[index]!;
}

/**
 * 把种子写成初始故事状态：种子全文进入场景目标（Purpose，开场生成会
 * 读到），种子 id/标题进入 canon（本局可追溯），标题作为初始线索线程。
 * 只写"起点"，不写路线、轮数或结局。
 */
export function scenarioSeedToInitialState(seed: ScenarioSeed): StoryState {
  return createInitialState({
    scene: {
      id: seed.id,
      location: "校园技术社团（网络开拓者协会）",
      purpose: seed.seed.trim(),
    },
    canon: {
      scenario_seed: seed.id,
      scenario_title: seed.title,
      ...(seed.tags.length > 0 ? { scenario_tags: seed.tags.join("、") } : {}),
    },
    open_threads: [
      { id: "seed-situation", summary: seed.title, status: "new", last_touched_turn: 0 },
    ],
    recent_summary: `本局从叙事种子开始：${seed.title}。`,
  });
}
