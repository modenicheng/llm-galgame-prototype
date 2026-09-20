/**
 * 校园叙事种子目录与选择策略测试。
 *
 * 契约（spec 9.2/9.8）：
 * - 种子是描述性素材：只允许 id/title/seed/tags 及可选描述字段；
 *   任何流程化字段（required_rounds、success_path 等）导致加载失败。
 * - 选择策略：确定性（sessionId 稳定散列 → 种子下标），支持显式覆盖。
 * - 种子 → 初始故事状态：经 StoryStateSchema 校验合法。
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadScenarioSeedCatalog,
  selectScenarioSeed,
  scenarioSeedToInitialState,
} from "./scenario-seeds.js";
import { StoryStateSchema } from "../story/types.js";

const REAL_CATALOG = fileURLToPath(
  new URL("../../prompts/campus-ops.yaml", import.meta.url),
);

/** 与模块内部一致的 FNV-1a（测试用它推举期望下标）。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

describe("loadScenarioSeedCatalog", () => {
  it("loads the real prompts/campus-ops.yaml with unique ids", async () => {
    const catalog = await loadScenarioSeedCatalog(REAL_CATALOG);

    expect(catalog.version).toBe(1);
    expect(catalog.seeds.length).toBeGreaterThanOrEqual(1);
    const ids = catalog.seeds.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const seed of catalog.seeds) {
      expect(seed.title.length).toBeGreaterThan(0);
      // 种子是带人物与处境的叙事素材，不是一行工单标题。
      expect(seed.seed.trim().length).toBeGreaterThan(30);
    }
  });

  it("keeps real seed narration addressed to the player", async () => {
    const catalog = await loadScenarioSeedCatalog(REAL_CATALOG);

    for (const seed of catalog.seeds) {
      // 台词里的“你”不能代替正文视角；这里只做词面回归检查，视角仍需人工审阅。
      const narration = seed.seed.replace(/“[^”]*”/gu, "");
      expect(narration, seed.id).toContain("你");
      expect(seed.seed, seed.id).not.toMatch(/玩家|主角/u);
    }
  });

  it("rejects workflow fields such as success_path or required_rounds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "campus-seeds-"));
    try {
      const filePath = path.join(dir, "bad-catalog.yaml");
      await writeFile(
        filePath,
        [
          "version: 1",
          "seeds:",
          "  - id: bad-seed",
          "    title: 坏种子",
          "    seed: |",
          "      情境描述。",
          "    success_path: \"必须先排查再重启\"",
          "    required_rounds: 4",
        ].join("\n"),
        "utf8",
      );
      await expect(loadScenarioSeedCatalog(filePath)).rejects.toThrow(/success_path|required_rounds/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a catalog with duplicate seed ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "campus-seeds-"));
    try {
      const filePath = path.join(dir, "dup-catalog.yaml");
      await writeFile(
        filePath,
        [
          "version: 1",
          "seeds:",
          "  - id: same-id",
          "    title: 第一条",
          "    seed: 情境。",
          "  - id: same-id",
          "    title: 第二条",
          "    seed: 情境。",
        ].join("\n"),
        "utf8",
      );
      await expect(loadScenarioSeedCatalog(filePath)).rejects.toThrow(/重复/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("selectScenarioSeed", () => {
  it("is deterministic for a given session id and covers the catalog", async () => {
    const catalog = await loadScenarioSeedCatalog(REAL_CATALOG);

    const sessionId = "sess-20260908-abcd";
    const first = selectScenarioSeed(catalog, sessionId);
    const second = selectScenarioSeed(catalog, sessionId);
    expect(second.id).toBe(first.id);

    const expectedIndex = fnv1a(sessionId) % catalog.seeds.length;
    expect(first.id).toBe(catalog.seeds[expectedIndex]!.id);
  });

  it("honors an explicit seed id override and rejects unknown ids", async () => {
    const catalog = await loadScenarioSeedCatalog(REAL_CATALOG);
    const target = catalog.seeds[0]!;

    const picked = selectScenarioSeed(catalog, "sess-whatever", target.id);
    expect(picked.id).toBe(target.id);

    expect(() => selectScenarioSeed(catalog, "sess-whatever", "no-such-seed")).toThrow(
      /no-such-seed/,
    );
  });
});

describe("scenarioSeedToInitialState", () => {
  it("builds a valid StoryState carrying the seed as the scene purpose", async () => {
    const catalog = await loadScenarioSeedCatalog(REAL_CATALOG);
    const seed = selectScenarioSeed(catalog, "sess-xyz", catalog.seeds[0]!.id);

    const state = scenarioSeedToInitialState(seed);

    // 必须能通过运行时的状态校验（快照持久化/恢复都会用到）。
    expect(StoryStateSchema.parse(state)).toBeDefined();
    expect(state.scene.id).toBe(seed.id);
    expect(state.scene.location).toBe("校园");
    expect(state.scene.purpose).toBe(seed.seed.trim());
    expect(state.canon.scenario_seed).toBe(seed.id);
    expect(state.open_threads[0]?.summary).toBe(seed.title);
  });

  it("folds author-only seed fields into canon as model-only channels", () => {
    const state = scenarioSeedToInitialState({
      id: "wired-seed",
      title: "接线种子",
      seed: "你和树莓娘在文萃楼走廊核对一张便签上的三处资料入口。",
      tags: ["文萃楼走廊"],
      context: "情境借自公开课评社区的个人经历，均为虚构。",
      concerns: ["不把主观评价包装成客观排名", "保留追问空间"],
      boundaries: ["不虚构具体机构或教师"],
      angles: ["知道内容和找得到内容的差别", "把适合谁说具体"],
      keywords: ["课件", "资料共享"],
    });

    expect(StoryStateSchema.parse(state)).toBeDefined();
    expect(state.canon.scenario_context).toBe("情境借自公开课评社区的个人经历，均为虚构。");
    expect(state.canon.scenario_concerns).toBe("不把主观评价包装成客观排名；保留追问空间");
    expect(state.canon.scenario_boundaries).toBe("不虚构具体机构或教师");
    expect(state.canon.scenario_angles).toBe("知道内容和找得到内容的差别；把适合谁说具体");
    // keywords 是目录检索词，不进模型通道。
    expect(state.canon.scenario_keywords).toBeUndefined();
    expect(state.canon).not.toHaveProperty("keywords");
  });

  it("omits the author-only canon keys when the seed does not provide them", () => {
    const state = scenarioSeedToInitialState({
      id: "bare-seed",
      title: "裸种子",
      seed: "你和树莓娘在社团广场守着一个暂时没人来的招新摊位。",
      tags: [],
    });

    expect(StoryStateSchema.parse(state)).toBeDefined();
    expect(state.canon.scenario_seed).toBe("bare-seed");
    expect(state.canon.scenario_context).toBeUndefined();
    expect(state.canon.scenario_concerns).toBeUndefined();
    expect(state.canon.scenario_boundaries).toBeUndefined();
    expect(state.canon.scenario_angles).toBeUndefined();
  });
});
