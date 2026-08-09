/**
 * Compiler tests — EventGroupDraft → CompiledEventGroup resolution
 * (docs/llm-outputs-refactor.md §7–§16, §36, §62).
 */
import { describe, it, expect } from "vitest";
import { compileEventGroup, compileEventGroups } from "./compiler.js";
import type {
  AssetDiagnostic,
  DialogueNameSpec,
  DialogueVisualSpec,
  EventGroupDraft,
} from "./types.js";
import type { AssetCatalog } from "../../assets/types.js";
import type {
  CharacterRegistry,
  CharacterRegistryEntry,
  CharacterPatchCue,
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
  allowedSpriteSets: ["suyao"],
};

/** Suyao with an explicit disguise allowance (§15 explicit allow-list). */
const DISGUISED_SUYAO: CharacterRegistryEntry = {
  ...SUYAO,
  allowedSpriteSets: ["suyao", "mysterious_woman"],
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

// ---------------------------------------------------------------------------
// Asset semantic validation (spec §7) — unknown ids / variants are dropped
// (graceful degradation: keep current state) and reported as diagnostics.
// ---------------------------------------------------------------------------

const CATALOG: AssetCatalog = {
  guidance: "",
  backgrounds: {
    basement: { id: "basement", src: "backgrounds/basement.jpg", description: "" },
  },
  bgm: {
    mystery: { id: "mystery", src: "audio/bgm/mystery.mp3", description: "" },
  },
  soundEffects: {
    beep: { id: "beep", src: "audio/se/beep.ogg", description: "" },
  },
  spriteSets: {
    suyao: {
      id: "suyao",
      variants: {
        normal: { id: "normal", src: "characters/suyao/normal.png" },
        anxious: { id: "anxious", src: "characters/suyao/anxious.png" },
      },
    },
    mysterious_woman: {
      id: "mysterious_woman",
      variants: {
        gentle_smile: { id: "gentle_smile", src: "characters/mysterious_woman/gentle_smile.png" },
      },
    },
  },
  characters: {},
};

function withBackground(background: string): VisualState {
  return { background, characters: {} };
}

function withCharacter(
  characterId: string,
  state: {
    spriteSet: string;
    variant: string;
    position: "far_left" | "left" | "center" | "right" | "far_right";
    displayName: string;
    visible: boolean;
  },
): VisualState {
  return { characters: { [characterId]: state } };
}

describe("compileEventGroup — sprite-set binding (§15)", () => {
  it("drops a cross-character spriteSet swap (FORBIDDEN_SPRITE_SET) unless allowed", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const ctx = makeCtx();
    const { group, tailState } = compileEventGroup(
      {
        prelude: [],
        main: {
          type: "dialogue",
          speaker: "苏遥",
          text: "你认错人了。",
          visual: {
            hasVisual: true,
            resetVisual: false,
            spriteSet: "mysterious_woman",
            variant: "gentle_smile",
          },
          name: { hasName: false, resetName: false },
        },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    // The whole cue is dropped (degradation: keep current state, story
    // continues) — the forbidden cross-set never reaches the stage.
    expect(group.prelude).toHaveLength(0);
    expect(tailState.characters["suyao"]).toBeUndefined();
    expect(diagnostics).toEqual([{ code: "FORBIDDEN_SPRITE_SET", id: "mysterious_woman" }]);
  });

  it("keeps an allowed spriteSet swap when the binding explicitly allows it", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const registry: CharacterRegistry = {
      resolveByScriptName(name: string): CharacterRegistryEntry | undefined {
        return name === "苏遥" ? DISGUISED_SUYAO : undefined;
      },
      resolveById(id: string): CharacterRegistryEntry | undefined {
        return id === "suyao" || id === "苏遥" ? DISGUISED_SUYAO : undefined;
      },
      entries(): CharacterRegistryEntry[] {
        return [DISGUISED_SUYAO];
      },
    };
    const defaults = createDefaultsFromRegistry(registry);
    const ctx = {
      registry,
      tailState: createInitialVisualState(),
      reduce: createVisualStateReducer(defaults),
      defaultsFor: defaults.defaultFor.bind(defaults),
    };
    const { group, tailState } = compileEventGroup(
      {
        prelude: [],
        main: {
          type: "dialogue",
          speaker: "苏遥",
          text: "（易容后的伪装）",
          visual: {
            hasVisual: true,
            resetVisual: false,
            spriteSet: "mysterious_woman",
            variant: "gentle_smile",
          },
          name: { hasName: false, resetName: false },
        },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    expect(diagnostics).toEqual([]);
    const patch = group.prelude[0] as CharacterPatchCue;
    expect(patch.spriteSet).toEqual({ op: "set", value: "mysterious_woman" });
    expect(patch.variant).toEqual({ op: "set", value: "gentle_smile" });
    expect(tailState.characters["suyao"]!.spriteSet).toBe("mysterious_woman");
    expect(tailState.characters["suyao"]!.variant).toBe("gentle_smile");
  });
});

describe("compileEventGroup — asset semantic validation (spec §7)", () => {
  it("drops an unknown background cue, records UNKNOWN_BACKGROUND, keeps state", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const ctx = makeCtx(withBackground("basement"));
    const { group, tailState } = compileEventGroup(
      {
        prelude: [{ type: "background", assetId: "nope" }],
        main: { type: "narration", text: "她推开了那扇门。" },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    expect(group.prelude).toHaveLength(0);
    expect(tailState.background).toBe("basement");
    expect(diagnostics).toEqual([{ code: "UNKNOWN_BACKGROUND", id: "nope" }]);
  });

  it("drops unknown bgm / sound_effect cues (UNKNOWN_BGM / UNKNOWN_SOUND_EFFECT)", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const ctx = makeCtx(withBackground("basement"));
    const { group, tailState } = compileEventGroup(
      {
        prelude: [
          { type: "bgm", assetId: "wrong" },
          { type: "sound_effect", assetId: "buzz" },
        ],
        main: { type: "narration", text: "脚步声在走廊里回荡。" },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    expect(group.prelude).toHaveLength(0);
    expect(tailState.bgm).toBeUndefined();
    expect(diagnostics).toEqual([
      { code: "UNKNOWN_BGM", id: "wrong" },
      { code: "UNKNOWN_SOUND_EFFECT", id: "buzz" },
    ]);
  });

  it("drops a character_patch with an unknown variant (=keep), text plays on", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const start = withCharacter("suyao", {
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      displayName: "苏遥",
      visible: true,
    });
    const ctx = makeCtx(start);
    const { group, tailState } = compileEventGroup(
      {
        prelude: [
          { type: "character_patch", character: "suyao", variant: { op: "set", value: "embarrassed" } },
        ],
        main: { type: "narration", text: "她低下头，没有说话。" },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    expect(group.prelude).toHaveLength(0);
    expect(tailState.characters["suyao"]?.variant).toBe("normal");
    expect(diagnostics).toEqual([{ code: "UNKNOWN_SPRITE_VARIANT", id: "embarrassed" }]);
  });

  it("rejects prototype-chain keys (constructor) as variant ids", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const start = withCharacter("suyao", {
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      displayName: "苏遥",
      visible: true,
    });
    const ctx = makeCtx(start);
    const { group, tailState } = compileEventGroup(
      {
        prelude: [
          { type: "character_patch", character: "suyao", variant: { op: "set", value: "constructor" } },
        ],
        main: { type: "narration", text: "她低着头，没有看过来。" },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    // "constructor" 在 Object.prototype 上，in 会误判为命中；hasOwn 必须拒绝。
    expect(group.prelude).toHaveLength(0);
    expect(tailState.characters["suyao"]?.variant).toBe("normal");
    expect(diagnostics).toEqual([{ code: "UNKNOWN_SPRITE_VARIANT", id: "constructor" }]);
  });

  it("passes valid ids / variants through with no diagnostics", () => {
    const diagnostics: AssetDiagnostic[] = [];
    const ctx = makeCtx();
    const { group } = compileEventGroup(
      {
        prelude: [{ type: "background", assetId: "basement" }],
        main: {
          type: "dialogue",
          speaker: "苏遥",
          text: "等等。",
          visual: { hasVisual: true, resetVisual: false, variant: "anxious" },
          name: { hasName: false, resetName: false },
        },
      },
      { ...ctx, catalog: CATALOG, diagnostics },
    );

    expect(group.prelude.length).toBeGreaterThan(0);
    expect(diagnostics).toHaveLength(0);
  });

  it("does not validate when no catalog is passed (backward compatible)", () => {
    const ctx = makeCtx();
    const { group } = compileEventGroup(
      {
        prelude: [{ type: "background", assetId: "nope" }],
        main: { type: "narration", text: "她推开了那扇门。" },
      },
      ctx,
    );

    expect(group.prelude).toHaveLength(1); // kept verbatim
  });
});
