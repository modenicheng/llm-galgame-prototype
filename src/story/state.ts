/**
 * StoryState factory, summarization, and serialization utilities.
 *
 * `createInitialState` produces a blank/default state at the start of a
 * new session. `summarizeState` compresses the state into a text block
 * suitable for inclusion in the LLM's context window.
 *
 * `serializeState` / `deserializeState` handle JSON round-tripping with
 * Zod validation. `saveStateSnapshot` is an async filesystem wrapper.
 */

import { writeFile } from "node:fs/promises";
import type { StoryState } from "./types.js";
import { StoryStateSchema } from "./types.js";

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
    canon: {},
    characters: {},
    open_threads: [],
    recent_summary: "The story has just begun.",
    player_profile: {
      recent_tendencies: [],
    },
  };

  if (!overrides) return defaults;

  return {
    scene: overrides.scene ?? defaults.scene,
    canon: overrides.canon ?? defaults.canon,
    characters: overrides.characters ?? defaults.characters,
    open_threads: overrides.open_threads ?? defaults.open_threads,
    recent_summary: overrides.recent_summary ?? defaults.recent_summary,
    player_profile:
      overrides.player_profile ?? defaults.player_profile,
  };
}

/**
 * Produce a compact text summary of the current story state for the LLM.
 *
 * The output is designed to fit within a small fraction of the context
 * window (typically 300–600 tokens) while conveying the most important
 * structural information: which scene we are in, who is present, what
 * threads are open, and the rolling recap of events that already slid
 * out of the raw history window ([Recap], maintained by src/story/recap.ts).
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
  const charIds = Object.keys(state.characters).filter(
    // 幻影角色（如历史坏行入库的 "@6ch raspberry"）不再回流进 prompt。
    (id) => !/[\s@]/.test(id),
  );
  if (charIds.length > 0) {
    lines.push("[Characters]");
    for (const id of charIds) {
      const char = state.characters[id]!;
      const parts: string[] = [id];
      if (char.location) parts.push(`loc:${char.location}`);
      if (char.emotion) parts.push(`mood:${char.emotion}`);
      if (char.current_goal) parts.push(`goal:"${char.current_goal}"`);
      if (char.relationship_to_player)
        parts.push(`rel:${char.relationship_to_player}`);
      lines.push(`  ${parts.join(" | ")}`);
    }
  } else {
    lines.push("[Characters] (none present)");
  }

  // Open threads
  if (state.open_threads.length > 0) {
    lines.push("[Open Threads]");
    const statusOrder: Record<string, number> = {
      active: 0,
      new: 1,
      ready: 2,
      resolved: 3,
      abandoned: 4,
    };
    const sorted = [...state.open_threads].sort(
      (a, b) =>
        (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5) ||
        b.last_touched_turn - a.last_touched_turn,
    );
    for (const thread of sorted) {
      lines.push(
        `  [${thread.status}] ${thread.id}: ${thread.summary} (turn ${thread.last_touched_turn})`,
      );
    }
  } else {
    lines.push("[Open Threads] (none)");
  }

  // Canon (compact) — 展示形态必须与系统提示词要求的 `{"键":"值"}` 同形：
  // 曾用 `键=值`，记忆代理会照抄该形态写出 `{"键=值"}`（成员缺值）的
  // 非法 JSON，整批状态更新被解析层丢弃（2026-09-19 实测 8/32 批次）。
  const canonKeys = Object.keys(state.canon);
  if (canonKeys.length > 0) {
    const canonEntries = canonKeys.map((k) => `${k}: "${String(state.canon[k])}"`);
    lines.push(`[Canon] ${canonEntries.join("; ")}`);
  }

  // Recent summary
  lines.push(`[Recap] ${state.recent_summary}`);

  // Player tendencies
  if (state.player_profile.recent_tendencies.length > 0) {
    lines.push(
      `[Player] Tendencies: ${state.player_profile.recent_tendencies.join(", ")}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a `StoryState` to a compact JSON string.
 */
export function serializeState(state: StoryState): string {
  return JSON.stringify(state);
}

/**
 * Deserialize a JSON string back into a `StoryState`, with Zod validation.
 * Throws if the JSON is malformed or the shape is invalid.
 */
export function deserializeState(json: string): StoryState {
  const parsed: unknown = JSON.parse(json);
  return StoryStateSchema.parse(parsed) as StoryState;
}

/**
 * Persist a `StoryState` snapshot to disk as a JSON file.
 */
export async function saveStateSnapshot(
  state: StoryState,
  filePath: string,
): Promise<void> {
  const json = serializeState(state);
  await writeFile(filePath, json, "utf8");
}
