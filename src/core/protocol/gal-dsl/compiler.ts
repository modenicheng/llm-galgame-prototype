/**
 * EventGroup compiler — resolves the parser-level EventGroupDraft into a
 * runtime-facing CompiledEventGroup (docs/llm-outputs-refactor.md §7–§16,
 * §36, §62).
 *
 * Responsibilities:
 * - resolve dialogue-header script names → stable character ids via the
 *   CharacterRegistry (docs §10);
 * - fold the dialogue's own `[...]` / `(...)` spec into a
 *   character_patch StageCue (docs §11–§16), applying first-touch
 *   initialization from character defaults when the character is not yet
 *   in the visual state (docs §6);
 * - compute the display name the player sees for each dialogue line
 *   (display-name override persists across lines, docs §10/§16);
 * - apply the pure VisualStateReducer so the returned `tailState` is the
 *   state the next generation must see (docs §54–§55).
 *
 * The compiler is pure: no DOM, no files, no runtime IDs.
 */
import type {
  CharacterPatchCue,
  CharacterPresentationState,
  CharacterRegistry,
  PatchValue,
  StageCue,
  VisualState,
  VisualStateReducer,
} from "../../presentation/types.js";
import type { AssetCatalog } from "../../assets/types.js";
import type {
  AssetDiagnostic,
  CompileEventGroupsOptions,
  CompileEventGroupsResult,
  CompiledEventGroup,
  CompiledMainEvent,
  DialogueNameSpec,
  DialogueVisualSpec,
  EventGroupDraft,
} from "./types.js";

function setOp<T>(value: T): PatchValue<T> {
  return { op: "set", value };
}

function resetOp(): { op: "reset" } {
  return { op: "reset" };
}

/** Resolve a character key (script name or id) to its stable id. */
function resolveCharacterKey(key: string, registry: CharacterRegistry): string {
  return (
    registry.resolveById(key)?.characterId ??
    registry.resolveByScriptName(key)?.characterId ??
    key
  );
}

interface ResolvedDialogue {
  characterId: string;
  speaker: string;
  cue: CharacterPatchCue | null;
}

/**
 * Resolve one dialogue line: character id, the display name the player
 * sees, and the character_patch cue that stages this line's presentation
 * (may be null when the line changes nothing).
 *
 * Display-name rules (docs §10, §13, §16):
 * - `(X)`        → speaker = X, displayName SET X
 * - `()`         → speaker = default displayName, displayName RESET
 * - otherwise    → speaker = current displayName (tail state, else default)
 *
 * Visual rules (docs §11–§16):
 * - first touch  → initialize the character from defaults, then apply the
 *   line's explicit spec;
 * - `[]`         → reset spriteSet/variant/position, visible = true;
 * - `[x]`, `[|p]`, `[s:x]`, `[s:x|p]` → SET the given fields.
 */
function resolveDialogue(
  speakerName: string,
  visual: DialogueVisualSpec,
  name: DialogueNameSpec,
  state: VisualState,
  registry: CharacterRegistry,
  defaultsFor: (id: string) => CharacterPresentationState | undefined,
  diagnostics?: AssetDiagnostic[],
): ResolvedDialogue {
  // Display-name overrides must be natural language. ASCII ids like
  // "mysterious" / "speaking_smile" mean the model confused the display-name
  // slot with a sprite id — treat the override as absent (stage label falls
  // back to the default) and diagnose.
  const displayNameOverride =
    name.displayName !== undefined && /\p{Script=Han}/u.test(name.displayName)
      ? name.displayName
      : undefined;
  if (name.displayName !== undefined && displayNameOverride === undefined) {
    diagnostics?.push({ code: "FORBIDDEN_DISPLAY_NAME", id: name.displayName });
  }
  const entry =
    registry.resolveByScriptName(speakerName) ?? registry.resolveById(speakerName);
  const characterId = entry?.characterId ?? speakerName;
  const defaults = entry
    ? {
        spriteSet: entry.spriteSet,
        variant: entry.defaultVariant,
        position: entry.defaultPosition,
        displayName: entry.displayName,
      }
    : undefined;

  const current = state.characters[characterId];

  let speaker: string;
  if (displayNameOverride !== undefined) {
    speaker = displayNameOverride;
  } else if (name.resetName) {
    speaker = defaults?.displayName ?? speakerName;
  } else {
    speaker = current?.displayName ?? defaults?.displayName ?? speakerName;
  }

  const cue: CharacterPatchCue = { type: "character_patch", character: characterId };
  let hasOps = false;

  // First touch: initialize from defaults so the renderer can show the
  // character (docs §6). Unknown characters (no registry entry) have no
  // art and are skipped — the line still plays with `speaker` as the label.
  if (current === undefined && defaults !== undefined) {
    cue.spriteSet = setOp(defaults.spriteSet);
    cue.variant = setOp(defaults.variant);
    cue.position = setOp(defaults.position);
    cue.visible = setOp(true);
    cue.displayName = setOp(defaults.displayName);
    hasOps = true;
  }

  if (visual.resetVisual) {
    cue.spriteSet = resetOp();
    cue.variant = resetOp();
    cue.position = resetOp();
    cue.visible = setOp(true);
    hasOps = true;
  } else {
    if (visual.spriteSet !== undefined) {
      cue.spriteSet = setOp(visual.spriteSet);
      hasOps = true;
    }
    if (visual.variant !== undefined) {
      cue.variant = setOp(visual.variant);
      hasOps = true;
    }
    if (visual.position !== undefined) {
      cue.position = setOp(visual.position);
      hasOps = true;
    }
  }

  if (displayNameOverride !== undefined) {
    cue.displayName = setOp(displayNameOverride);
    hasOps = true;
  } else if (name.resetName) {
    cue.displayName = resetOp();
    hasOps = true;
  }

  return { characterId, speaker, cue: hasOps ? cue : null };
}

/**
 * 素材语义校验（spec §7）：未知 id/variant 的 cue 被丢弃（降级为保持现状），
 * 剧情继续；诊断写入 diagnostics。保持确定性。
 *
 * §15 sprite-set 禁令：character_patch 显式换用非该角色 allowed_sprite_sets
 * 内的素材组（如 `苏遥[linche:calm]`）会被丢弃——普通角色
 * 只能使用自己的素材组，换装/伪装需要角色绑定里显式列 allowed_sprite_sets。
 */
function filterInvalidCues(
  cues: StageCue[],
  state: VisualState,
  catalog: AssetCatalog,
  registry: CharacterRegistry,
  diagnostics: AssetDiagnostic[] | undefined,
): StageCue[] {
  const kept: StageCue[] = [];
  for (const cue of cues) {
    let keep = true;
    if (cue.type === "background") {
      keep = cue.assetId in catalog.backgrounds;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BACKGROUND", id: cue.assetId });
    } else if (cue.type === "bgm") {
      // `bgm stop` is a control cue (reducer clears bgm), not an asset id.
      keep = cue.assetId === "stop" || cue.assetId in catalog.bgm;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BGM", id: cue.assetId });
    } else if (cue.type === "sound_effect") {
      keep = cue.assetId in catalog.soundEffects;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_SOUND_EFFECT", id: cue.assetId });
    } else if (cue.type === "character_patch") {
      // §15: cross-character spriteSet swaps require an explicit allow-list.
      const entry = registry.resolveById(cue.character);
      if (
        cue.spriteSet !== undefined &&
        cue.spriteSet.op === "set" &&
        entry !== undefined &&
        !entry.allowedSpriteSets.includes(cue.spriteSet.value)
      ) {
        keep = false;
        diagnostics?.push({
          code: "FORBIDDEN_SPRITE_SET",
          id: cue.spriteSet.value,
        });
      } else if (cue.variant !== undefined && cue.variant.op === "set") {
        const effectiveSet =
          cue.spriteSet !== undefined && cue.spriteSet.op === "set"
            ? cue.spriteSet.value
            : state.characters[cue.character]?.spriteSet ??
              // Not mounted yet (first touch) — fall back to the character's
              // registry-bound default set so UNKNOWN_SPRITE_VARIANT is not
              // raised for a legal variant on a not-yet-on-stage character.
              registry.resolveById(cue.character)?.spriteSet;
        const variants =
          effectiveSet !== undefined ? catalog.spriteSets[effectiveSet]?.variants : undefined;
        if (variants === undefined || !Object.hasOwn(variants, cue.variant.value)) {
          keep = false;
          diagnostics?.push({ code: "UNKNOWN_SPRITE_VARIANT", id: cue.variant.value });
        }
      }
    }
    if (keep) kept.push(cue);
  }
  return kept;
}

/**
 * Compile ONE draft group against the given tail state. Returns the
 * compiled group and the new tail state after applying all cues.
 */
export function compileEventGroup(
  group: EventGroupDraft,
  options: CompileEventGroupsOptions,
): { group: CompiledEventGroup; tailState: VisualState } {
  const { registry, tailState, reduce, defaultsFor } = options;

  const prelude: StageCue[] = [];
  for (const cue of group.prelude) {
    if (cue.type === "character_patch") {
      prelude.push({ ...cue, character: resolveCharacterKey(cue.character, registry) });
    } else {
      prelude.push(cue);
    }
  }

  let main: CompiledMainEvent;
  let dialogueCue: CharacterPatchCue | null = null;

  switch (group.main.type) {
    case "dialogue": {
      const resolved = resolveDialogue(
        group.main.speaker,
        group.main.visual,
        group.main.name,
        tailState,
        registry,
        defaultsFor,
        options.diagnostics,
      );
      main = {
        type: "dialogue",
        characterId: resolved.characterId,
        speaker: resolved.speaker,
        text: group.main.text,
      };
      dialogueCue = resolved.cue;
      break;
    }
    case "narration":
      main = { type: "narration", text: group.main.text };
      break;
    case "interaction":
      main = { type: "interaction", interaction: group.main.interaction };
      break;
    case "beat":
      main = { type: "beat" };
      break;
  }

  // Ordering: the dialogue's own patch applies FIRST so that explicit
  // `ch` cues written before the line (hide/show/set) take effect AFTER
  // first-touch initialization — a hidden speaker stays hidden (§19).
  const allCues: StageCue[] = dialogueCue ? [dialogueCue, ...prelude] : prelude;
  const filteredCues =
    options.catalog !== undefined
      ? filterInvalidCues(allCues, tailState, options.catalog, options.registry, options.diagnostics)
      : allCues;
  const nextState = reduce(tailState, filteredCues);

  return { group: { prelude: filteredCues, main }, tailState: nextState };
}

/** Compile a whole segment's draft groups, chaining the tail state. */
export function compileEventGroups(
  groups: EventGroupDraft[],
  options: CompileEventGroupsOptions,
): CompileEventGroupsResult {
  let tailState = options.tailState;
  const compiled: CompiledEventGroup[] = [];
  for (const group of groups) {
    const result = compileEventGroup(group, { ...options, tailState });
    compiled.push(result.group);
    tailState = result.tailState;
  }
  return { groups: compiled, tailState };
}
