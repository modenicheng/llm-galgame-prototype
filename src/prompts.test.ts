import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { loadPrompts, type InstructionSet, type PromptBundle } from "./prompts.js";
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

  // ---------------------------------------------------------------------
  // 真实提示词（prompts/ 目录）的测试策略：只钉"运行时契约"和"身份锚点"，
  // 不钉文案措辞。
  // - 写死：占位符（fill() 契约，双向）、哨兵 reason（解析器枚举）、协议
  //   字面量、人物身份与事实分层锚点。
  // - 谨慎：踩坑沉淀的行为规则只钉一个关键片段（措辞可调、规则不可删）。
  // - 不钉：人设细节、看点描述、写作风格等纯文案——它们应可自由迭代。
  // ---------------------------------------------------------------------
  describe("real prompts (repo prompts/ directory)", () => {
    let bundle: PromptBundle;
    let instructions: InstructionSet;

    beforeAll(async () => {
      const repoPrompts = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "prompts",
      );
      ({ bundle, instructions } = await loadPrompts(repoPrompts));
    });

    it("dsl-protocol.txt keeps the wire literals that the parser and model both depend on", () => {
      expect(bundle.dslProtocol).toContain("行式 Gal DSL");
      // 哨兵格式与 reason 枚举：协议文本必须与解析器认的三个值一一对应。
      expect(bundle.dslProtocol).toContain("@end <nonce> <reason>");
      for (const reason of ["buffer", "interaction", "ending"] as const) {
        expect(bundle.dslProtocol).toContain(reason);
      }
      // 表单结束行是逐字解析的字面量。
      expect(bundle.dslProtocol).toContain("@/?");
      // @ 前缀总规则是历史事故根因（指令行漏 @ 会被当台词播出）：语义必须保留，措辞可调。
      expect(bundle.dslProtocol).toMatch(/以 `@` 开头/);
    });

    it("task templates keep the fill() placeholder contract in both directions", () => {
      // 镜像 openai-compatible-generator.ts 各 fill() 调用点的变量表。
      // recovery 在收尾模式（remainingLines ≤ 0）有运行时消费者；ending
      // 模板当前仍没有运行时消费者，不参与校验。
      const FILL_VARS: Record<string, readonly string[]> = {
        opening: ["nonce"],
        continuation: ["nonce", "target_lines", "prefetched"],
        recovery: ["nonce", "repair_reason", "prefetched", "raw_tail"],
        branch_prefetch: ["choice_prompt", "option_text", "min_dialogue", "nonce"],
        input_response: ["interaction_prompt", "player_input", "nonce"],
        input_bridge: ["interaction_prompt", "nonce"],
      };

      for (const [task, vars] of Object.entries(FILL_VARS)) {
        const template = instructions[task as keyof InstructionSet];
        for (const name of vars) {
          expect(
            template,
            `${task} 模板缺少占位符 {${name}}（fill() 会静默跳过，对应运行时约束随之失效）`,
          ).toContain(`{${name}}`);
        }
        // 反向：模板里出现 fill() 不替换的占位符，会被模型原样回显（历史事故）。
        const extras = new Set(
          [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!),
        );
        for (const name of vars) {
          extras.delete(name);
        }
        expect(
          [...extras],
          `${task} 模板出现 fill() 不替换的占位符，模型会原样回显`,
        ).toEqual([]);
      }

      // opening 引用的状态块字段名必须与 summarizeState 的输出一致
      //（story/state.ts 打印 "Purpose:"，中文标签可自由改写）。
      expect(instructions.opening).toContain("Purpose");
    });

    it("task templates keep per-task sentinel reasons aligned with the generator", () => {
      // 与 generator 各任务的 allowedReasons 对应。交互尾两行必须逐字：
      // 校验器要求表单最后一行是 @/? 且紧跟哨兵。
      expect(instructions.opening).toContain("@/?\n@end {nonce} interaction");
      expect(instructions.continuation).toContain("@/?\n@end {nonce} interaction");
      expect(instructions.continuation).toContain("@end {nonce} buffer");
      expect(instructions.continuation).toContain("@end {nonce} ending");
      expect(instructions.branch_prefetch).toContain("@end {nonce} buffer");
      expect(instructions.input_response).toContain("@end {nonce} buffer");
      expect(instructions.input_bridge).toContain("@end {nonce} buffer");

      // 反轻信规则（玩家输入≠世界事实）是踩坑沉淀：只钉关键片段，措辞可调。
      expect(instructions.input_response).toContain("质疑、拒绝、误解");
    });

    it("campus persona keeps identity anchors and stays clear of the old storyline", () => {
      // 身份锚点：改名属全分支级变更，应当让测试红掉。
      expect(bundle.characters).toContain("树莓娘");
      expect(bundle.characters).toContain("网络开拓者协会");
      // 官方事实与本项目演绎必须分层标注，不可混写。
      expect(bundle.characters).toContain("已核对事实");
      expect(bundle.characters).toContain("本项目演绎");
      // 结局依据已确认事实收束的活载体是 guideline
      //（instructions.ending 模板当前没有运行时消费者）。
      expect(bundle.guideline).toContain("已经确认的事实");
      // 旧长线人物不得回流校园分支。
      expect(bundle.characters).not.toContain("苏遥");
      expect(bundle.characters).not.toContain("林澈");
      expect(bundle.storyLine).not.toContain("旧终端");
    });
  });
});
