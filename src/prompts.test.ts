import { describe, it, expect, afterEach } from "vitest";
import { loadPrompts } from "./prompts.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MINIMAL_INSTRUCTIONS_YAML = [
  "opening: '请从故事开场开始生成完整开场剧情。'",
  "branch_prefetch: '当前分支问题：{choice_prompt}。假设玩家选择：{option_text}。至少 {min_dialogue} 条 dialogue。'",
  "input_response: '交互点：{interaction_prompt}。玩家输入：{player_input}。生成 NPC 回应。'",
  "continuation: '预取片段：{prefetched}。继续生成。'",
  "input_bridge: '交互点：{interaction_prompt}。生成 1–2 条 narration 过渡。'",
  "recovery: '上一次输出被拒绝：{repair_reason}。请修正后继续。'",
  "ending: '剧情收束，用 @end {nonce} ending 结束。'",
].join("\n");

describe("loadPrompts", () => {
  const tempDirs: string[] = [];

  async function createTempDir(): Promise<string> {
    const dir = path.join(
      tmpdir(),
      `prompts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  async function populateTempDir(dir: string, txts: Record<string, string>): Promise<void> {
    for (const [name, content] of Object.entries(txts)) {
      await writeFile(path.join(dir, name), content, "utf8");
    }
    await writeFile(path.join(dir, "dsl-protocol.txt"), "你是互动视觉小说的编剧。输出行式 Gal DSL。", "utf8");
    await writeFile(path.join(dir, "instructions.yaml"), MINIMAL_INSTRUCTIONS_YAML, "utf8");
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("loads the bundle without storyLine when no per-game dir is given (M3.7)", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "Alice: 勇敢的少女\nBob: 神秘的旅人",
      // story_line.txt 写进全局目录也不会被读——M3.7 已删除全局注入。
      "story_line.txt": "全局残留（不应被读）",
      "guideline.txt": "保持角色设定一致性。",
    });

    const { bundle, instructions } = await loadPrompts(dir);

    expect(bundle.characters).toBe("Alice: 勇敢的少女\nBob: 神秘的旅人");
    expect(bundle.storyLine).toBeUndefined();
    expect(bundle.guideline).toBe("保持角色设定一致性。");
    expect(bundle.dslProtocol).toContain("行式 Gal DSL");
    expect(instructions.opening).toContain("开场");
    expect(instructions.input_bridge).toContain("narration");
    expect(instructions.recovery).toContain("repair_reason");
    expect(instructions.ending).toContain("ending");
  });

  it("reads story_line.txt only from the per-game dir when provided", async () => {
    const globalDir = await createTempDir();
    await populateTempDir(globalDir, {
      "characters.txt": "GLOBAL_CHAR",
      "story_line.txt": "GLOBAL_STORY（不应被读）",
      "guideline.txt": "Guide",
    });
    const perGameDir = await createTempDir();
    await writeFile(path.join(perGameDir, "story_line.txt"), "PER_GAME_STORY", "utf8");

    const { bundle } = await loadPrompts(globalDir, perGameDir);

    expect(bundle.storyLine).toBe("PER_GAME_STORY");
    // characters 仍走「per-game 优先、全局回退」。
    expect(bundle.characters).toBe("GLOBAL_CHAR");
  });

  it("throws loudly when the per-game dir lacks story_line.txt (no silent fallback)", async () => {
    const globalDir = await createTempDir();
    await populateTempDir(globalDir, {
      "characters.txt": "Alice",
      "story_line.txt": "GLOBAL_STORY（不能回退到它）",
      "guideline.txt": "Guide",
    });
    const perGameDir = await createTempDir();

    await expect(loadPrompts(globalDir, perGameDir)).rejects.toThrow(/story_line\.txt 缺失/);
  });

  it("throws when a file is missing (ENOENT)", async () => {
    const dir = await createTempDir();
    await writeFile(path.join(dir, "characters.txt"), "Alice", "utf8");
    await writeFile(path.join(dir, "story_line.txt"), "story", "utf8");
    await writeFile(path.join(dir, "instructions.yaml"), MINIMAL_INSTRUCTIONS_YAML, "utf8");
    // guideline.txt is intentionally missing

    await expect(loadPrompts(dir)).rejects.toThrow();
  });

  it("throws when a file is empty (empty string after trim)", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "   \n  ", // whitespace only
      "story_line.txt": "story content",
      "guideline.txt": "guideline content",
    });

    await expect(loadPrompts(dir)).rejects.toThrow(/为空/);
  });

  it("throws when the per-game story_line.txt is empty", async () => {
    const globalDir = await createTempDir();
    await populateTempDir(globalDir, {
      "characters.txt": "Alice",
      "guideline.txt": "Guide",
    });
    const perGameDir = await createTempDir();
    await writeFile(path.join(perGameDir, "story_line.txt"), "   \t  ", "utf8");

    await expect(loadPrompts(globalDir, perGameDir)).rejects.toThrow(/为空/);
  });

  it("trims the per-game story_line.txt", async () => {
    const globalDir = await createTempDir();
    await populateTempDir(globalDir, {
      "characters.txt": "Alice",
      "guideline.txt": "Guide",
    });
    const perGameDir = await createTempDir();
    await writeFile(path.join(perGameDir, "story_line.txt"), "  \t主线剧情\t \n", "utf8");

    const { bundle } = await loadPrompts(globalDir, perGameDir);
    expect(bundle.storyLine).toBe("主线剧情");
  });

  it("rejects instructions.yaml with missing required fields", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "Alice",
      "guideline.txt": "Guide",
    });
    // Overwrite with incomplete instructions
    await writeFile(path.join(dir, "instructions.yaml"), "opening: 'only one field'", "utf8");

    await expect(loadPrompts(dir)).rejects.toThrow();
  });

  it("real instructions.yaml is the DSL task-template set; the protocol spec lives in dsl-protocol.txt", async () => {
    const repoPrompts = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "prompts",
    );
    const { bundle, instructions } = await loadPrompts(repoPrompts);

    // M3.7：全局 story_line.txt 已删除——真实仓库目录装载时无 storyLine。
    expect(bundle.storyLine).toBeUndefined();

    // The full DSL protocol spec lives in prompts/dsl-protocol.txt.
    expect(bundle.dslProtocol).toContain("行式 Gal DSL");
    expect(bundle.dslProtocol).toContain("hybrid");
    expect(bundle.dslProtocol).toContain("@end <nonce> <reason>");

    // Input-response additions.
    expect(instructions.input_response).toContain(
      "玩家输入只是玩家尝试表达的内容",
    );
    expect(instructions.input_response).toContain(
      "NPC 可以质疑、拒绝、误解或要求证据",
    );

    // New DSL task templates exist with their placeholders.
    expect(instructions.input_bridge).toContain("{interaction_prompt}");
    expect(instructions.input_bridge).toContain("@end {nonce} buffer");
    expect(instructions.recovery).toContain("{repair_reason}");
    expect(instructions.ending).toContain("{nonce}");
  });
});
