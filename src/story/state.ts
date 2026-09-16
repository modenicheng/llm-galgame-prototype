/**
 * StoryState factory, summarization, and serialization utilities.
 *
 * `createInitialState` produces a blank/default state at the start of a
 * new session. `summarizeState` compresses the state into a text block
 * suitable for inclusion in the LLM's context window.
 * （MA-A2：serialize/deserialize 已随图存储接管序列化而删除。）
 */

import type { StoryState } from "./types.js";

/**
 * Create a fresh `StoryState` with sensible defaults.
 *
 * Every field is initialised so consumers never need to deal with
 * partially-populated state objects. Pass `overrides` to pre-seed
 * the state (e.g. from a saved session).
 */
export function createInitialState(
  overrides?: Partial<StoryState>,
): StoryState {
  const defaults: StoryState = {
    scene: {
      id: "prologue",
      location: "unknown",
      purpose: "establish setting and introduce characters",
    },
    characters: {},
    recent_summary: "The story has just begun.",
  };

  if (!overrides) return defaults;

  return {
    scene: overrides.scene ?? defaults.scene,
    characters: overrides.characters ?? defaults.characters,
    recent_summary: overrides.recent_summary ?? defaults.recent_summary,
  };
}

/**
 * Produce a compact text summary of the current story state for the LLM.
 *
 * The output is designed to fit within a small fraction of the context
 * window (typically 300–600 tokens) while conveying the most important
 * structural information: which scene we are in, who is present, what
 * threads are open, and what the player has been doing recently.
 */
export function summarizeState(state: StoryState): string {
  const lines: string[] = [];

  // Scene
  const timeStr = state.scene.time ? ` (${state.scene.time})` : "";
  lines.push(
    `[Scene] ID: ${state.scene.id} | Location: ${state.scene.location}${timeStr}`,
  );
  lines.push(`  Purpose: ${state.scene.purpose}`);

  // Characters present
  const charIds = Object.keys(state.characters);
  if (charIds.length > 0) {
    lines.push("[Characters]");
    for (const [id, char] of Object.entries(state.characters)) {
      const parts: string[] = [id];
      if (char.location) parts.push(`loc:${char.location}`);
      lines.push(`  ${parts.join(" | ")}`);
    }
  } else {
    lines.push("[Characters] (none present)");
  }

  // Recent summary
  lines.push(`[Recent] ${state.recent_summary}`);

  return lines.join("\n");
}
