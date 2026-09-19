import { describe, it, expect, afterEach, vi } from "vitest";
import { loadPrompts } from "./prompts.js";
import { dslTaskCapability } from "./core/protocol/gal-dsl/capabilities.js";
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

  // ---------------------------------------------------------------------
  // C6 配置清理（port 自 campus 0b8de2e）：instructions.ending 死入口
  // 删除 + 一次性弃用诊断。
  // ---------------------------------------------------------------------
  describe("instructions.ending 弃用诊断（C6）", () => {
    async function populateDeprecatedDir(withEnding: boolean): Promise<string> {
      const dir = path.join(
        tmpdir(),
        `prompts-test-${withEnding ? "deprecated" : "clean"}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "characters.txt"), "Alice", "utf8");
      await writeFile(path.join(dir, "guideline.txt"), "Guide", "utf8");
      await writeFile(path.join(dir, "dsl-protocol.txt"), "协议", "utf8");
      await writeFile(
        path.join(dir, "instructions.yaml"),
        withEnding
          ? `${MINIMAL_INSTRUCTIONS_YAML}\nending: '旧结局模板'`
          : MINIMAL_INSTRUCTIONS_YAML,
        "utf8",
      );
      return dir;
    }

    it("旧配置携带 ending 键：加载成功，给出一次弃用提示后忽略", async () => {
      const dir = await populateDeprecatedDir(true);
      try {
        const warnings: string[] = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
          warnings.push(args.join(" "));
        });
        const { instructions } = await loadPrompts(dir);
        // 加载成功（不因旧键失败），字段被忽略。
        expect(instructions.opening).toContain("开场");
        expect(instructions).not.toHaveProperty("ending");
        // 一次性弃用诊断。
        expect(warnings.some((w) => w.includes("ending") && w.includes("弃用"))).toBe(true);
        spy.mockRestore();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("新配置没有 ending 键：无弃用提示", async () => {
      const dir = await populateDeprecatedDir(false);
      try {
        const warnings: string[] = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
          warnings.push(args.join(" "));
        });
        await loadPrompts(dir);
        expect(warnings).toEqual([]);
        spy.mockRestore();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
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

    // Input-response additions（C6：玩家输入以结构化数据块插入）。
    expect(instructions.input_response).toContain("source=player");
    expect(instructions.input_response).toContain(
      "NPC 可以质疑、拒绝、误解或要求证据",
    );
    expect(instructions.input_response).toContain("{player_input}");

    // New DSL task templates exist with their placeholders.
    expect(instructions.input_bridge).toContain("{interaction_prompt}");
    expect(instructions.input_bridge).toContain("@end {nonce} buffer");
    expect(instructions.recovery).toContain("{repair_reason}");
    // C6 死入口清理：ending 模板已删除。
    expect(instructions).not.toHaveProperty("ending");
  });

  it("公共协议模板不含内容包专名；任务级规则交给任务协议卡（C6 §5.4）", async () => {
    // 共享模板（dsl-protocol.txt / instructions.yaml）是派生基座：示例
    // 人物与素材 id 由任务协议卡从实际 roster/资源目录生成，模板里不得
    // 手写内容包人名或资源 id（内容包自身文件 characters.txt 等可保留
    // 真实姓名）。
    const { bundle, instructions } = await loadPrompts(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts"),
    );
    const PACK_NAMES = [
      "苏遥",
      "许晚晴",
      "林澈",
      "树莓娘",
      "林小满",
      "夏一鸣",
      "韩澈",
      "suyao",
      "linche",
      "raspberry",
      "wencui",
      "female_A",
      "male_A",
    ];
    for (const template of [bundle.dslProtocol, instructions.opening,
      instructions.continuation, instructions.branch_prefetch,
      instructions.input_response, instructions.input_bridge, instructions.recovery]) {
      for (const name of PACK_NAMES) {
        expect(template, `共享模板不得出现内容包专名 ${name}`).not.toContain(name);
      }
    }
    // dsl-protocol 是语法基座：任务级能力/收束规则声明由任务协议卡携带
    //（它按任务从能力表派生——不再有第二份手写 grammar）。
    expect(bundle.dslProtocol).toContain("任务协议卡");
  });

  // ---------------------------------------------------------------------
  // C6 校准（计划 §5.2，port 自 campus fbb84b0）：先把 main bridge /
  // input_response 的实际允许集合按 as-built 钉死在测试里，再要求 v2
  // 能力卡表达同一集合。
  // v1 的任务能力约束活在任务模板文本（runtime 无逐命令门禁），所以
  // “实际允许集合”以模板原文为准；能力卡收紧到同一集合，绝不借重构
  // 扩权。v1 表面形态 → v2 命令名映射：dialogue（含台词头 (显示名) 改名
  // 槽）→ @say+@name；narration → @n；@ch/@se 原名。
  // ---------------------------------------------------------------------
  describe("bridge / input_response as-built 允许集合（C6 校准固定）", () => {
    const repoPrompts = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "prompts",
    );

    it("input_bridge v1 模板 as-built：仅旁白，禁止背景/立绘/BGM/音效/表单", async () => {
      const { instructions } = await loadPrompts(repoPrompts);
      const bridge = instructions.input_bridge;
      // 只生成 narration（不代玩家发声、无台词）。
      expect(bridge).toContain("生成 1–2 条 narration");
      // 场景资源全部禁止——bridge 没有 @bg/@bgm/@se/@ch 能力。
      expect(bridge).toContain("不得改变背景/立绘/BGM");
      expect(bridge).toContain("不得产生音效");
      expect(bridge).toContain("不得创建新的交互点");
      // 唯一收束：@end {nonce} buffer。
      expect(bridge).toContain("@end {nonce} buffer");
    });

    it("input_bridge v2 能力卡 = 同一集合（@n + @end，无场景资源/表单/台词）", () => {
      expect(dslTaskCapability("input_bridge").commands).toEqual(["@n", "@end"]);
      expect(dslTaskCapability("input_bridge").endReasons).toEqual(["buffer"]);
    });

    it("input_response v1 模板 as-built：dialogue / narration / @ch / @se", async () => {
      const { instructions } = await loadPrompts(repoPrompts);
      const response = instructions.input_response;
      expect(response).toContain("允许 dialogue / narration / @ch / @se");
      // 不开新表单、不切场景资源（@bg/@bgm 不在集合内）。
      expect(response).toContain("不得生成交互表单");
      expect(response).toContain("@end {nonce} buffer");
    });

    it("input_response v2 能力卡 = 同一集合（dialogue 台词头改名槽 → @name 并入）", () => {
      // v1 台词行天然携带 (显示名) 改名槽（R01 改名机制的载体），所以 v2
      // 的等价集合包含 @name；@beat 不在 v1 允许清单里，不得保留。
      expect(dslTaskCapability("input_response").commands).toEqual([
        "@say",
        "@n",
        "@name",
        "@ch",
        "@se",
        "@end",
      ]);
      expect(dslTaskCapability("input_response").endReasons).toEqual(["buffer"]);
    });
  });
});
