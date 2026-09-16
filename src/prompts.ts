import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// PromptBundle — static text prompts (.txt files)
// ---------------------------------------------------------------------------

export interface PromptBundle {
  characters: string;
  /**
   * M3.7：storyLine 只来自 per-game `world/prompts/story_line.txt`——全局
   * `prompts/story_line.txt` 与 dev 注入路径已删除。无世界启动（宿主首屏
   * 创建表单流程）时为 undefined；世界目录缺该文件 = 大声报错，无静默回退。
   */
  storyLine?: string;
  guideline: string;
  /**
   * Gal DSL output protocol system prompt (prompts/dsl-protocol.txt).
   * The single supported model output protocol.
   */
  dslProtocol: string;
}

async function readRequiredFile(filePath: string): Promise<string> {
  const content = (await readFile(filePath, "utf8")).trim();
  if (!content) {
    throw new Error(`提示词文件为空：${filePath}`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// InstructionSet — fourth-layer instruction templates (instructions.yaml)
// ---------------------------------------------------------------------------

export interface InstructionSet {
  /** Extra instruction for opening generation. */
  opening: string;
  /** Template for branch prefetch. Placeholders: {choice_prompt}, {option_text}, {min_dialogue} */
  branch_prefetch: string;
  /** Template for free-text input NPC response. Placeholders: {interaction_prompt}, {player_input} */
  input_response: string;
  /** Template for continuation after prefetch playthrough. Placeholder: {prefetched} */
  continuation: string;
  /** Template for input bridge narration (DSL). Placeholder: {interaction_prompt} */
  input_bridge: string;
  /** Template for recovery continuation (DSL). Placeholder: {repair_reason} */
  recovery: string;
  /** Template for ending wrap-up (DSL). Placeholder: {nonce} */
  ending: string;
}

const InstructionSetSchema = z.object({
  opening: z.string().min(1),
  branch_prefetch: z.string().min(1),
  input_response: z.string().min(1),
  continuation: z.string().min(1),
  input_bridge: z.string().min(1),
  recovery: z.string().min(1),
  ending: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Loader — reads everything from the prompts directory
// ---------------------------------------------------------------------------

export interface LoadedPrompts {
  bundle: PromptBundle;
  instructions: InstructionSet;
}

/**
 * 装载提示词。M3.3 ②：`perGamePromptDir`（`games/<gameId>/world/prompts`）
 * 里的 characters.txt 优先，其余文件回退全局 `prompts/`。M3.7 破坏性纪律：
 * story_line.txt 只读 per-game（全局文件已删除，无回退）；世界目录缺它
 * 即大声报错；未提供 perGamePromptDir（无世界启动）→ storyLine 缺省。
 */
export async function loadPrompts(
  promptDir = "prompts",
  perGamePromptDir?: string,
): Promise<LoadedPrompts> {
  const root = path.resolve(promptDir);

  const readWithPerGameOverride = async (fileName: string): Promise<string> => {
    if (perGamePromptDir !== undefined) {
      const perGamePath = path.join(path.resolve(perGamePromptDir), fileName);
      try {
        return await readRequiredFile(perGamePath);
      } catch (err) {
        if (
          !(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")
        ) {
          throw err;
        }
        // ENOENT → 回退全局
      }
    }
    return readRequiredFile(path.join(root, fileName));
  };

  const readPerGameStoryLine = async (): Promise<string | undefined> => {
    if (perGamePromptDir === undefined) return undefined;
    const storyLinePath = path.join(path.resolve(perGamePromptDir), "story_line.txt");
    try {
      return await readRequiredFile(storyLinePath);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `story_line.txt 缺失：${storyLinePath}（M3.7：storyLine 只来自 per-game world/prompts，无全局回退）`,
        );
      }
      throw err;
    }
  };

  const [characters, storyLine, guideline, dslProtocol, rawYaml] = await Promise.all([
    readWithPerGameOverride("characters.txt"),
    readPerGameStoryLine(),
    readRequiredFile(path.join(root, "guideline.txt")),
    readRequiredFile(path.join(root, "dsl-protocol.txt")),
    readFile(path.join(root, "instructions.yaml"), "utf8"),
  ]);

  const parsed: unknown = parse(rawYaml);
  const instructions = InstructionSetSchema.parse(parsed) as InstructionSet;

  return {
    bundle: {
      characters,
      ...(storyLine !== undefined ? { storyLine } : {}),
      guideline,
      dslProtocol,
    },
    instructions,
  };
}
