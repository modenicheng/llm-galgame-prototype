/**
 * Patch application and validation for StoryState.
 *
 * `applyPatch` performs a deep merge of a `StoryStatePatch` into a
 * `StoryState`, preserving unmentioned fields. `validatePatch` checks
 * an unknown value against the `StoryStatePatchSchema`.
 */

import { StoryStatePatchSchema } from "./types.js";
import type { StoryState, StoryStatePatch, StoryThread } from "./types.js";

/**
 * Validate an unknown value as a `StoryStatePatch`.
 *
 * Throws `ZodError` if the shape is invalid. Returns the parsed patch
 * on success.
 */
export function validatePatch(value: unknown): StoryStatePatch {
  return StoryStatePatchSchema.parse(value) as StoryStatePatch;
}

/**
 * Merge two partial patches into one, preserving the semantics of applying
 * them in sequence. `b` wins over `a` at every level; open_threads are
 * merged by id with `b` taking precedence.
 */
export function mergePatches(
  a: StoryStatePatch,
  b: StoryStatePatch,
): StoryStatePatch {
  const scene =
    a.scene || b.scene
      ? { ...(a.scene ?? {}), ...(b.scene ?? {}) }
      : undefined;
  const canon =
    a.canon || b.canon
      ? { ...(a.canon ?? {}), ...(b.canon ?? {}) }
      : undefined;
  const characters: NonNullable<StoryStatePatch["characters"]> = {};
  let hasCharacters = false;
  for (const [charId, charPatch] of Object.entries(a.characters ?? {})) {
    characters[charId] = { ...(characters[charId] ?? {}), ...charPatch };
    hasCharacters = true;
  }
  for (const [charId, charPatch] of Object.entries(b.characters ?? {})) {
    characters[charId] = { ...(characters[charId] ?? {}), ...charPatch };
    hasCharacters = true;
  }

  let open_threads = b.open_threads ?? a.open_threads;
  if (a.open_threads && b.open_threads) {
    const map = new Map(a.open_threads.map((t) => [t.id, t] as const));
    for (const thread of b.open_threads) map.set(thread.id, thread);
    open_threads = [...map.values()];
  }

  const result: StoryStatePatch = {};
  if (scene !== undefined) result.scene = scene;
  if (canon !== undefined) result.canon = canon;
  if (hasCharacters) result.characters = characters;
  if (open_threads !== undefined) result.open_threads = open_threads;
  if (b.recent_summary !== undefined) result.recent_summary = b.recent_summary;
  else if (a.recent_summary !== undefined) result.recent_summary = a.recent_summary;
  if (b.player_profile !== undefined) result.player_profile = b.player_profile;
  else if (a.player_profile !== undefined) result.player_profile = a.player_profile;
  return result;
}

/** Status priority for thread merging (higher = further progressed). */
const STATUS_PRIORITY: Record<StoryThread["status"], number> = {
  new: 0,
  active: 1,
  ready: 2,
  resolved: 3,
  abandoned: 3,
};

/**
 * Merge a patch thread into an existing thread, preserving the existing
 * status if it is further progressed than the patch status.
 *
 * Terminal states ("resolved", "abandoned") can be overridden by any
 * non-terminal status — this allows the model to reactivate a thread.
 */
function mergeThreadStatus(
  existing: StoryThread,
  patch: StoryThread,
): StoryThread {
  // Allow reactivation of terminal threads
  const isTerminal =
    existing.status === "resolved" || existing.status === "abandoned";
  if (isTerminal) {
    return patch;
  }

  const existingPriority = STATUS_PRIORITY[existing.status];
  const patchPriority = STATUS_PRIORITY[patch.status];

  // If existing status is further progressed, keep it.
  // This prevents the model from accidentally downgrading an "active"
  // thread back to "new".
  if (existingPriority > patchPriority) {
    return { ...patch, status: existing.status };
  }
  return patch;
}

/**
 * Apply a `StoryStatePatch` to a `StoryState`, returning a new state object.
 *
 * Merge rules (shallow-merge at each level, never mutates `state`):
 *
 * - **scene**:        top-level keys are replaced individually.
 * - **canon**:        keys are shallow-merged (patch keys override).
 * - **characters**:   per-character keys are shallow-merged; missing
 *                      characters are added.
 * - **open_threads**: threads are merged by `id`: existing threads are
 *                      updated, new threads are prepended.
 * - **recent_summary**: replaced if provided.
 * - **player_profile**: top-level keys are shallow-merged.
 */
export function applyPatch(
  state: StoryState,
  patch: StoryStatePatch,
): StoryState {
  // scene
  const scene = patch.scene
    ? { ...state.scene, ...patch.scene }
    : { ...state.scene };

  // canon
  const canon = patch.canon
    ? { ...state.canon, ...patch.canon }
    : { ...state.canon };

  // characters
  let characters = state.characters;
  if (patch.characters) {
    characters = { ...state.characters };
    for (const [charId, charPatch] of Object.entries(patch.characters)) {
      const existing = characters[charId];
      characters[charId] = existing
        ? { ...existing, ...charPatch }
        : (charPatch as StoryState["characters"][string]);
    }
  }

  // open_threads — merge by id; patch threads override existing,
  // but status is never downgraded (e.g. "active" won't become "new")
  let open_threads = state.open_threads;
  if (patch.open_threads) {
    const existingMap = new Map(
      state.open_threads.map((t) => [t.id, t] as const),
    );
    for (const thread of patch.open_threads) {
      const existing = existingMap.get(thread.id);
      if (existing) {
        existingMap.set(thread.id, mergeThreadStatus(existing, thread));
      } else {
        existingMap.set(thread.id, thread);
      }
    }
    open_threads = [...existingMap.values()];
  }

  // recent_summary
  const recent_summary =
    patch.recent_summary !== undefined
      ? patch.recent_summary
      : state.recent_summary;

  // player_profile
  const player_profile = patch.player_profile
    ? { ...state.player_profile, ...patch.player_profile }
    : { ...state.player_profile };

  return {
    scene,
    canon,
    characters,
    open_threads,
    recent_summary,
    player_profile,
  };
}
