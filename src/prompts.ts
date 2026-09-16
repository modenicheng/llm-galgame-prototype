import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// PromptBundle — static text prompts (.txt files)
// ---------------------------------------------------------------------------

export interface PromptBundle {
  characters: string;
  storyLine: string;
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
 * 里的 characters.txt / story_line.txt 优先，其余文件与未提供的段回退全局
 * `prompts/`——破坏性纪律：per-game 缺 story_line 且全局被 M3.7 删除后，
 * 缺失即大声报错，无静默回退。
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

  const [characters, storyLine, guideline, dslProtocol, rawYaml] = await Promise.all([
    readWithPerGameOverride("characters.txt"),
    readWithPerGameOverride("story_line.txt"),
    readRequiredFile(path.join(root, "guideline.txt")),
    readRequiredFile(path.join(root, "dsl-protocol.txt")),
    readFile(path.join(root, "instructions.yaml"), "utf8"),
  ]);

  const parsed: unknown = parse(rawYaml);
  const instructions = InstructionSetSchema.parse(parsed) as InstructionSet;

  return {
    bundle: { characters, storyLine, guideline, dslProtocol },
    instructions,
  };
}
