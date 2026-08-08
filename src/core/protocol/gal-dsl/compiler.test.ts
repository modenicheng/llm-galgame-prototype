/**
 * Compiler tests — EventGroupDraft → CompiledEventGroup resolution
 * (docs/llm-outputs-refactor.md §7–§16, §36, §62).
 */
import { describe, it, expect } from "vitest";
import { compileEventGroup, compileEventGroups } from "./compiler.js";
import type { DialogueNameSpec, DialogueVisualSpec, EventGroupDraft } from "./types.js";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
  StageCue,
  VisualState,
} from "../../presentation/types.js";
import { createDefaultsFromRegistry, createInitialVisualState } from "../../presentation/defaults.js";
import { createVisualStateReducer } from "../../presentation/reducer.js";

const SUYAO: CharacterRegistryEntry = {
  characterId: "suyao",
  scriptName: "苏遥",
  displayName: "苏遥",
  spriteSet: "suyao",
  defaultVariant: "normal",
  defaultPosition: "left",
};

function makeRegistry(): CharacterRegistry {
  const entries = [SUYAO];
  return {
    resolveByScriptName(name: string): CharacterRegistryEntry | undefined {
      return entries.find((e) => e.scriptName === name);
    },
    resolveById(id: string): CharacterRegistryEntry | undefined {
      return entries.find((e) => e.characterId === id || e.scriptName === id);
    },
    entries(): CharacterRegistryEntry[] {
      return entries;
    },
  };
}

function makeCtx(tailState: VisualState = createInitialVisualState()) {
  const registry = makeRegistry();
  const defaults = createDefaultsFromRegistry(registry);
  return {
    registry,
    tailState,
    reduce: createVisualStateReducer(defaults),
    defaultsFor: defaults.defaultFor.bind(defaults),
  };
}

function dialogue(speaker: string, text: string): EventGroupDraft {
  return {
    prelude: [],
    main: {
      type: "dialogue",
      speaker,
      text,
      visual: { hasVisual: false, resetVisual: false },
      name: { hasName: false, resetName: false },
    },
  };
}

function visualSpec(partial: Partial<DialogueVisualSpec>): DialogueVisualSpec {
  return {
    hasVisual: partial.hasVisual ?? false,
    resetVisual: partial.resetVisual ?? false,
    ...(partial.spriteSet !== undefined ? { spriteSet: partial.spriteSet } : {}),
    ...(partial.variant !== undefined ? { variant: partial.variant } : {}),
    ...(partial.position !== undefined ? { position: partial.position } : {}),
  };
}

function nameSpec(partial: Partial<DialogueNameSpec>): DialogueNameSpec {
  return {
    hasName: partial.hasName ?? false,
    resetName: partial.resetName ?? false,
    ...(partial.displayName !== undefined ? { displayName: partial.displayName } : {}),
  };
}

function dialogueWith(
  speaker: string,
  text: string,
  partial: { visual?: Partial<DialogueVisualSpec>; name?: Partial<DialogueNameSpec> } = {},
): EventGroupDraft {
  return {
    prelude: [],
    main: {
      type: "dialogue",
      speaker,
      text,
      visual: visualSpec(partial.visual ?? {}),
      name: nameSpec(partial.name ?? {}),
    },
  };
}

function characterCue(character: string, ops: Record<string, unknown>): StageCue {
  return { type: "character_patch", character, ...ops } as StageCue;
}

describe("compileEventGroup — dialogue resolution", () => {
  it("resolves script name to characterId and initializes from defaults on first touch", () => {
    const ctx = makeCtx();
    const { group, tailState } = compileEventGroup(dialogue("苏遥", "别碰它。"), ctx);

    expect(group.main).toMatchObject({ type: "dialogue", characterId: "suyao", speaker: "苏遥", text: "别碰它。" });
    expect(group.prelude).toEqual([
      {
        type: "character_patch",
        character: "suyao",
        spriteSet: { op: "set", value: "suyao" },
        variant: { op: "set", value: "normal" },
        position: { op: "set", value: "left" },
        visible: { op: "set", value: true },
        displayName: { op: "set", value: "苏遥" },
      },
    ]);
    expect(tailState.characters["suyao"]).toMatchObject({
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      displayName: "苏遥",
      visible: true,
    });
  });

  it("KEEPs presentation on a plain second line (no cue, same speaker)", () => {
    const ctx = makeCtx();
    const first = compileEventGroup(dialogue("苏遥", "A"), ctx);
    const second = compileEventGroup(dialogue("苏遥", "B"), { ...ctx, tailState: first.tailState });

    expect(second.group.prelude).toEqual([]);
    expect(second.group.main).toMatchObject({ type: "dialogue", characterId: "suyao", speaker: "苏遥", text: "B" });
    expect(second.tailState.characters["suyao"]).toMatchObject({ variant: "normal" });
  });

  it("sets only the variant with [variant]", () => {
    const ctx = makeCtx();
    const { group, tailState } = compileEventGroup(
      dialogueWith("苏遥", "等等。", { visual: { hasVisual: true, variant: "anxious" } }),
      ctx,
    );

    const cue = group.prelude[0] as { variant?: { op: string; value: string } };
    expect(cue.variant).toEqual({ op: "set", value: "anxious" });
    expect(tailState.characters["suyao"]!.variant).toBe("anxious");
  });

  it("sets only the position with [|position] (init fills defaults)", () => {
    const ctx = makeCtx();
    const { group, tailState } = compileEventGroup(
      dialogueWith("苏遥", "站远一点。", { visual: { hasVisual: true, position: "right" } }),
      ctx,
    );

    const cue = group.prelude[0] as { position?: { op: string; value: string } };
    expect(cue.position).toEqual({ op: "set", value: "right" });
    expect(tailState.characters["suyao"]!.position).toBe("right");
    // The first-touch init fills defaults; only position is overridden.
    expect(tailState.characters["suyao"]!.variant).toBe("normal");
  });

  it("overrides the sprite set with [placeholder_char:anxious]", () => {
    const ctx = makeCtx();
    const { group } = compileEventGroup(
      dialogueWith("苏遥", "你是谁？", { visual: { hasVisual: true, spriteSet: "placeholder_char", variant: "anxious" } }),
      ctx,
    );

    const cue = group.prelude[0] as {
      spriteSet?: { op: string; value: string };
      variant?: { op: string; value: string };
    };
    expect(cue.spriteSet).toEqual({ op: "set", value: "placeholder_char" });
    expect(cue.variant).toEqual({ op: "set", value: "anxious" });
  });

  it("resets visual fields with []", () => {
    const ctx = makeCtx();
    const first = compileEventGroup(
      dialogueWith("苏遥", "A", { visual: { hasVisual: true, spriteSet: "placeholder_char", variant: "anxious", position: "right" } }),
      ctx,
    );
    const second = compileEventGroup(
      dialogueWith("苏遥", "B", { visual: { hasVisual: true, resetVisual: true } }),
      { ...ctx, tailState: first.tailState },
    );

    const cue = second.group.prelude[0] as {
      spriteSet?: { op: string };
      variant?: { op: string };
      position?: { op: string };
      visible?: { op: string; value: boolean };
    };
    expect(cue.spriteSet?.op).toBe("reset");
    expect(cue.variant?.op).toBe("reset");
    expect(cue.position?.op).toBe("reset");
    expect(cue.visible).toEqual({ op: "set", value: true });
    expect(second.tailState.characters["suyao"]).toMatchObject({
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      visible: true,
    });
  });

  it("uses the display-name override for the speaker and persists it", () => {
    const ctx = makeCtx();
    const first = compileEventGroup(
      dialogueWith("苏遥", "别动。", { name: { hasName: true, displayName: "神秘女子" } }),
      ctx,
    );

    expect(first.group.main).toMatchObject({ type: "dialogue", characterId: "suyao", speaker: "神秘女子" });
    const cue = first.group.prelude[0] as { displayName?: { op: string; value: string } };
    expect(cue.displayName).toEqual({ op: "set", value: "神秘女子" });

    const second = compileEventGroup(dialogue("苏遥", "现在离开还来得及。"), {
      ...ctx,
      tailState: first.tailState,
    });
    expect(second.group.main).toMatchObject({ speaker: "神秘女子" });
    expect(second.group.prelude).toEqual([]);
  });

  it("resets the display name with ()", () => {
    const ctx = makeCtx();
    const first = compileEventGroup(
      dialogueWith("苏遥", "A", { name: { hasName: true, displayName: "神秘女子" } }),
      ctx,
    );
    const second = compileEventGroup(
      dialogueWith("苏遥", "B", { name: { hasName: true, resetName: true } }),
      { ...ctx, tailState: first.tailState },
    );

    expect(second.group.main).toMatchObject({ speaker: "苏遥" });
    const cue = second.group.prelude[0] as { displayName?: { op: string } };
    expect(cue.displayName?.op).toBe("reset");
  });

  it("leaves an unknown character unresolved without a cue", () => {
    const ctx = makeCtx();
    const { group, tailState } = compileEventGroup(dialogue("路人", "让开。"), ctx);

    expect(group.main).toMatchObject({ type: "dialogue", characterId: "路人", speaker: "路人" });
    expect(group.prelude).toEqual([]);
    expect(tailState.characters["路人"]).toBeUndefined();
  });
});

describe("compileEventGroup — ch cues and ordering", () => {
  it("resolves ch cue keys to character ids", () => {
    const ctx = makeCtx();
    const group: EventGroupDraft = {
      prelude: [characterCue("suyao", { visible: { op: "set", value: false } })],
      main: { type: "narration", text: "她消失了。" },
    };
    const { group: compiled } = compileEventGroup(group, ctx);
    expect(compiled.prelude[0]).toMatchObject({ type: "character_patch", character: "suyao" });
  });

  it("hidden speaker stays hidden (ch hide + plain dialogue → visible false)", () => {
    const ctx = makeCtx();
    const group: EventGroupDraft = {
      prelude: [characterCue("suyao", { visible: { op: "set", value: false } })],
      main: {
        type: "dialogue",
        speaker: "苏遥",
        text: "别回头。",
        visual: { hasVisual: false, resetVisual: false },
        name: { hasName: false, resetName: false },
      },
    };
    const { tailState } = compileEventGroup(group, ctx);
    expect(tailState.characters["suyao"]!.visible).toBe(false);
  });

  it("first-touch init then ch hide → hidden (dialogue patch applies first)", () => {
    const ctx = makeCtx();
    const group: EventGroupDraft = {
      prelude: [characterCue("suyao", { visible: { op: "set", value: false } })],
      main: {
        type: "dialogue",
        speaker: "苏遥",
        text: "别回头。",
        visual: { hasVisual: true, resetVisual: false, variant: "normal" },
        name: { hasName: false, resetName: false },
      },
    };
    const { tailState } = compileEventGroup(group, ctx);
    expect(tailState.characters["suyao"]!.visible).toBe(false);
  });
});

describe("compileEventGroups — tail state chaining", () => {
  it("chains tail state across groups and returns the final state", () => {
    const ctx = makeCtx();
    const groups: EventGroupDraft[] = [
      dialogueWith("苏遥", "A", { visual: { hasVisual: true, variant: "anxious" } }),
      dialogue("苏遥", "B"),
      dialogueWith("苏遥", "C", { visual: { hasVisual: true, position: "right" } }),
    ];

    const { groups: compiled, tailState } = compileEventGroups(groups, ctx);
    expect(compiled).toHaveLength(3);
    expect(tailState.characters["suyao"]).toMatchObject({ variant: "anxious", position: "right" });
  });

  it("initializes a character seen in an earlier committed segment from tail state", () => {
    const priorTail: VisualState = {
      characters: {
        suyao: {
          spriteSet: "suyao",
          variant: "angry",
          position: "center",
          displayName: "神秘女子",
          visible: true,
        },
      },
    };
    const ctx = makeCtx(priorTail);
    const { group } = compileEventGroup(dialogue("苏遥", "我说，出去。"), ctx);

    // Character already on stage: no init cue, no change; speaker = current display name.
    expect(group.prelude).toEqual([]);
    expect(group.main).toMatchObject({ speaker: "神秘女子" });
  });
});
