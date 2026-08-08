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
   * Used when `generation.protocol === "dsl"`; the JSONL legacy protocol
   * keeps using `InstructionSet.output_protocol`.
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
  /** System prompt: output format protocol + hard rules for the model. */
  output_protocol: string;
  /** Extra instruction for opening generation. */
  opening: string;
  /** Template for branch prefetch. Placeholders: {choice_prompt}, {option_text}, {min_dialogue} */
  branch_prefetch: string;
  /** Template for free-text input NPC response. Placeholders: {interaction_prompt}, {player_input} */
  input_response: string;
  /** Template for continuation after prefetch playthrough. Placeholder: {prefetched_jsonl} */
  continuation: string;
  /** Template for input bridge narration (DSL). Placeholder: {interaction_prompt} */
  input_bridge: string;
  /** Template for recovery continuation (DSL). Placeholder: {repair_reason} */
  recovery: string;
  /** Template for ending wrap-up (DSL). Placeholder: {nonce} */
  ending: string;
}

const InstructionSetSchema = z.object({
  output_protocol: z.string().min(1),
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

export async function loadPrompts(promptDir = "prompts"): Promise<LoadedPrompts> {
  const root = path.resolve(promptDir);

  const [characters, storyLine, guideline, dslProtocol, rawYaml] = await Promise.all([
    readRequiredFile(path.join(root, "characters.txt")),
    readRequiredFile(path.join(root, "story_line.txt")),
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
