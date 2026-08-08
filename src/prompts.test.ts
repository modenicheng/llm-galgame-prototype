import { describe, it, expect, afterEach } from "vitest";
import { loadPrompts } from "./prompts.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MINIMAL_INSTRUCTIONS_YAML = [
  "output_protocol: '你是互动视觉小说的剧情生成器。'",
  "opening: '请从故事开场开始生成完整开场剧情。'",
  "branch_prefetch: '当前分支问题：{choice_prompt}。假设玩家选择：{option_text}。至少 {min_dialogue} 条 dialogue。'",
  "input_response: '交互点：{interaction_prompt}。玩家输入：{player_input}。生成 NPC 回应。'",
  "continuation: '预取片段：{prefetched_jsonl}。继续生成。'",
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

  it("successfully loads all four prompt files plus instructions from a directory", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "Alice: 勇敢的少女\nBob: 神秘的旅人",
      "story_line.txt": "这是一个关于冒险的故事。",
      "guideline.txt": "保持角色设定一致性。",
    });

    const { bundle, instructions } = await loadPrompts(dir);

    expect(bundle.characters).toBe("Alice: 勇敢的少女\nBob: 神秘的旅人");
    expect(bundle.storyLine).toBe("这是一个关于冒险的故事。");
    expect(bundle.guideline).toBe("保持角色设定一致性。");
    expect(bundle.dslProtocol).toContain("行式 Gal DSL");
    expect(instructions.output_protocol).toContain("互动视觉小说");
    expect(instructions.opening).toContain("开场");
    expect(instructions.input_bridge).toContain("narration");
    expect(instructions.recovery).toContain("repair_reason");
    expect(instructions.ending).toContain("ending");
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

  it("returns correct content for each prompt field", async () => {
    const dir = await createTempDir();
    const expectedChars = "角色A: 描述\n角色B: 描述";
    const expectedStory = "主线剧情大纲";
    const expectedGuide = "写作指导方针";

    await populateTempDir(dir, {
      "characters.txt": expectedChars,
      "story_line.txt": expectedStory,
      "guideline.txt": expectedGuide,
    });

    const { bundle, instructions } = await loadPrompts(dir);

    expect(bundle).toEqual({
      characters: expectedChars,
      storyLine: expectedStory,
      guideline: expectedGuide,
      dslProtocol: "你是互动视觉小说的编剧。输出行式 Gal DSL。",
    });
    expect(instructions.output_protocol).toBeTruthy();
  });

  it("handles files with surrounding whitespace (trimmed)", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "\n\n  Alice  \n\n",
      "story_line.txt": "  \tA story with padding\t  ",
      "guideline.txt": "\tguideline\t",
    });

    const { bundle } = await loadPrompts(dir);

    expect(bundle.characters).toBe("Alice");
    expect(bundle.storyLine).toBe("A story with padding");
    expect(bundle.guideline).toBe("guideline");
  });

  it("rejects instructions.yaml with missing required fields", async () => {
    const dir = await createTempDir();
    await populateTempDir(dir, {
      "characters.txt": "Alice",
      "story_line.txt": "Story",
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

    // output_protocol is now a short legacy-JSONL pointer, not the full
    // interaction protocol spec (which moved to dsl-protocol.txt).
    expect(instructions.output_protocol).toContain("严格 JSONL");
    expect(instructions.output_protocol).not.toContain('互动：{"type":"interaction"');
    expect(instructions.output_protocol).not.toContain("mode=hybrid");

    // The full DSL spec lives in prompts/dsl-protocol.txt.
    expect(bundle.dslProtocol).toContain("行式 Gal DSL");
    expect(bundle.dslProtocol).toContain("hybrid");
    expect(bundle.dslProtocol).toContain("@end <nonce> <reason>");

    // Opening and continuation forbid legacy choice.
    expect(instructions.opening).toContain("不得输出旧式 choice");
    expect(instructions.continuation).toContain("不得输出旧式 choice");

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
