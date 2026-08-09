/**
 * Tests for the pure visual-state reducer (docs §11–§19, §52–§53).
 */

import { describe, expect, it } from "vitest";
import type {
  CharacterPatchCue,
  CharacterPresentationState,
  PresentationDefaults,
  StageCue,
  VisualState,
} from "./types.js";
import { createVisualStateReducer } from "./reducer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUYAO_DEFAULTS: CharacterPresentationState = {
  spriteSet: "suyao",
  variant: "normal",
  position: "left",
  displayName: "苏遥",
  visible: true,
};

function makeTestDefaults(): PresentationDefaults {
  const entries: Record<string, CharacterPresentationState> = {
    suyao: SUYAO_DEFAULTS,
    sasha: {
      spriteSet: "placeholder_char",
      variant: "normal",
      position: "center",
      displayName: "莎莎",
      visible: true,
    },
  };
  return { defaultFor: (id) => entries[id] };
}

function charPatch(
  character: string,
  fields: Partial<Omit<CharacterPatchCue, "type" | "character">> = {},
): CharacterPatchCue {
  return { type: "character_patch", character, ...fields };
}

function reduce(cues: StageCue[], state: VisualState = { characters: {} }): VisualState {
  return createVisualStateReducer(makeTestDefaults())(state, cues);
}

function suyaoState(overrides: Partial<CharacterPresentationState> = {}): VisualState {
  return {
    characters: {
      suyao: { ...SUYAO_DEFAULTS, ...overrides },
    },
  };
}

/** Non-null access to the suyao entry (Record access is unchecked-indexed). */
function suyao(state: VisualState): CharacterPresentationState {
  return state.characters.suyao!;
}

// ---------------------------------------------------------------------------
// Background / bgm
// ---------------------------------------------------------------------------

describe("background cues", () => {
  it("sets the background", () => {
    const next = reduce([{ type: "background", assetId: "basement" }]);
    expect(next.background).toBe("basement");
  });

  it("replaces the previous background", () => {
    const next = reduce([
      { type: "background", assetId: "basement" },
      { type: "background", assetId: "classroom_day" },
    ]);
    expect(next.background).toBe("classroom_day");
  });
});

describe("bgm cues", () => {
  it("sets the bgm", () => {
    const next = reduce([{ type: "bgm", assetId: "mystery" }]);
    expect(next.bgm).toBe("mystery");
  });

  it("clears the bgm on stop", () => {
    const next = reduce([
      { type: "bgm", assetId: "mystery" },
      { type: "bgm", assetId: "stop" },
    ]);
    expect(next.bgm).toBeUndefined();
  });

  it("keeps bgm absent when stopping with no bgm playing", () => {
    const next = reduce([{ type: "bgm", assetId: "stop" }]);
    expect(next.bgm).toBeUndefined();
  });
});

describe("sound_effect cues", () => {
  it("leaves no residue in the visual state", () => {
    const state = suyaoState();
    const next = reduce([{ type: "sound_effect", assetId: "terminal_beep" }], state);
    expect(next).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// Character patches
// ---------------------------------------------------------------------------

describe("character first-touch", () => {
  it("initializes a brand-new character from defaults", () => {
    const next = reduce([charPatch("suyao")]);
    expect(suyao(next)).toEqual(SUYAO_DEFAULTS);
  });

  it("initializes from defaults and applies a SET in the same cue", () => {
    const next = reduce([
      charPatch("suyao", { variant: { op: "set", value: "anxious" } }),
    ]);
    expect(suyao(next)).toEqual({
      ...SUYAO_DEFAULTS,
      variant: "anxious",
    });
  });
});

describe("character SET", () => {
  it("sets the variant, keeping every other field", () => {
    const state = suyaoState();
    const next = reduce(
      [charPatch("suyao", { variant: { op: "set", value: "anxious" } })],
      state,
    );
    expect(suyao(next)).toEqual({ ...SUYAO_DEFAULTS, variant: "anxious" });
  });

  it("sets the position", () => {
    const next = reduce(
      [charPatch("suyao", { position: { op: "set", value: "right" } })],
      suyaoState(),
    );
    expect(suyao(next).position).toBe("right");
  });

  it("sets the sprite set", () => {
    const next = reduce(
      [charPatch("suyao", { spriteSet: { op: "set", value: "placeholder_char" } })],
      suyaoState(),
    );
    expect(suyao(next).spriteSet).toBe("placeholder_char");
  });

  it("hides the character", () => {
    const next = reduce(
      [charPatch("suyao", { visible: { op: "set", value: false } })],
      suyaoState(),
    );
    expect(suyao(next).visible).toBe(false);
  });

  it("shows a hidden character again, reusing the hidden state", () => {
    const hidden = reduce(
      [charPatch("suyao", { visible: { op: "set", value: false } })],
      suyaoState({ variant: "anxious", position: "right" }),
    );
    expect(suyao(hidden).visible).toBe(false);
    const shown = reduce(
      [charPatch("suyao", { visible: { op: "set", value: true } })],
      hidden,
    );
    expect(suyao(shown)).toEqual({
      ...SUYAO_DEFAULTS,
      variant: "anxious",
      position: "right",
      visible: true,
    });
  });
});

describe("stage occupancy (§19)", () => {
  const bothAtLeft = (): VisualState => ({
    characters: {
      suyao: { ...SUYAO_DEFAULTS, position: "left", visible: true },
      sasha: {
        spriteSet: "placeholder_char",
        variant: "normal",
        position: "left",
        displayName: "莎莎",
        visible: true,
      },
    },
  });

  it("a character becoming visible at an occupied slot hides the previous occupant", () => {
    const next = reduce([charPatch("suyao", { position: { op: "set", value: "left" } })], bothAtLeft());
    expect(suyao(next).visible).toBe(true);
    expect(suyao(next).position).toBe("left");
    expect(next.characters.sasha!.visible).toBe(false);
  });

  it("evicts when a hidden character is shown at an occupied slot", () => {
    const state: VisualState = {
      characters: {
        suyao: { ...SUYAO_DEFAULTS, position: "left" as const, visible: false },
        sasha: {
          spriteSet: "placeholder_char",
          variant: "normal",
          position: "left" as const,
          displayName: "莎莎",
          visible: true,
        },
      },
    };
    const next = reduce([charPatch("suyao", { visible: { op: "set", value: true } })], state);
    expect(suyao(next).visible).toBe(true);
    expect(next.characters.sasha!.visible).toBe(false);
  });

  it("no eviction when the characters occupy different slots", () => {
    const state: VisualState = {
      characters: {
        suyao: { ...SUYAO_DEFAULTS, position: "left" as const },
        sasha: {
          spriteSet: "placeholder_char",
          variant: "normal",
          position: "right" as const,
          displayName: "莎莎",
          visible: true,
        },
      },
    };
    const next = reduce(
      [charPatch("suyao", { position: { op: "set", value: "left" } })],
      state,
    );
    expect(suyao(next).visible).toBe(true);
    expect(next.characters.sasha!.visible).toBe(true);
  });

  it("a hide does not evict anyone (the character is leaving, not claiming)", () => {
    const next = reduce(
      [charPatch("suyao", { visible: { op: "set", value: false } })],
      bothAtLeft(),
    );
    expect(suyao(next).visible).toBe(false);
    expect(next.characters.sasha!.visible).toBe(true);
  });

  it("an invisible character does not occupy its slot", () => {
    const state: VisualState = {
      characters: {
        suyao: { ...SUYAO_DEFAULTS, position: "left" as const, visible: true },
        sasha: {
          spriteSet: "placeholder_char",
          variant: "normal",
          position: "left" as const,
          displayName: "莎莎",
          visible: false,
        },
      },
    };
    const next = reduce([charPatch("sasha", { visible: { op: "set", value: true } })], state);
    // sasha claims left; suyao (left) is evicted — sasha had no claim.
    expect(next.characters.sasha!.visible).toBe(true);
    expect(suyao(next).visible).toBe(false);
  });
});

describe("character exit (§19)", () => {
  it("exit removes the character from the stage entirely", () => {
    const next = reduce([charPatch("suyao", { exit: true })], suyaoState());
    expect(next.characters.suyao).toBeUndefined();
  });

  it("exit of a character not on stage is a no-op", () => {
    const next = reduce([charPatch("suyao", { exit: true })], { characters: {} });
    expect(next.characters).toEqual({});
  });

  it("exit leaves other characters untouched", () => {
    const state: VisualState = {
      characters: {
        suyao: { ...SUYAO_DEFAULTS, position: "left" as const },
        sasha: {
          spriteSet: "placeholder_char",
          variant: "normal",
          position: "right" as const,
          displayName: "莎莎",
          visible: true,
        },
      },
    };
    const next = reduce([charPatch("suyao", { exit: true })], state);
    expect(next.characters.suyao).toBeUndefined();
    expect(next.characters.sasha!.visible).toBe(true);
  });
});

describe("character RESET", () => {
  it("resets all visual fields via all-reset cue ([]-style), keeping displayName", () => {
    const state = suyaoState({
      spriteSet: "placeholder_char",
      variant: "angry",
      position: "right",
      displayName: "神秘女子",
      visible: false,
    });
    const next = reduce(
      [
        charPatch("suyao", {
          spriteSet: { op: "reset" },
          variant: { op: "reset" },
          position: { op: "reset" },
          visible: { op: "reset" },
        }),
      ],
      state,
    );
    expect(suyao(next)).toEqual({
      spriteSet: "suyao",
      variant: "normal",
      position: "left",
      displayName: "神秘女子",
      visible: true,
    });
  });

  it("resets the display name via ()-style reset, keeping the visuals", () => {
    const state = suyaoState({
      variant: "anxious",
      position: "right",
      displayName: "神秘女子",
    });
    const next = reduce(
      [charPatch("suyao", { displayName: { op: "reset" } })],
      state,
    );
    expect(suyao(next)).toEqual({
      ...SUYAO_DEFAULTS,
      variant: "anxious",
      position: "right",
    });
  });

  it("fully resets via []()-style cue (all fields reset)", () => {
    const state = suyaoState({
      spriteSet: "placeholder_char",
      variant: "angry",
      position: "far_right",
      displayName: "神秘女子",
      visible: false,
    });
    const next = reduce(
      [
        charPatch("suyao", {
          spriteSet: { op: "reset" },
          variant: { op: "reset" },
          position: { op: "reset" },
          visible: { op: "reset" },
          displayName: { op: "reset" },
        }),
      ],
      state,
    );
    expect(suyao(next)).toEqual(SUYAO_DEFAULTS);
  });
});

describe("character KEEP", () => {
  it("preserves fields when the cue omits them", () => {
    const state = suyaoState({
      variant: "anxious",
      position: "right",
      displayName: "神秘女子",
      visible: false,
    });
    const next = reduce([charPatch("suyao")], state);
    expect(suyao(next)).toEqual(state.characters.suyao);
  });

  it("preserves fields for an explicit keep op", () => {
    const state = suyaoState({ variant: "anxious" });
    const next = reduce(
      [charPatch("suyao", { variant: { op: "keep" } })],
      state,
    );
    expect(suyao(next)).toEqual(state.characters.suyao);
  });
});

describe("unknown characters", () => {
  it("treats a patch for an unknown character as a no-op", () => {
    const state: VisualState = { characters: {} };
    const next = reduce([charPatch("ghost", { variant: { op: "set", value: "x" } })], state);
    expect(next.characters).toEqual({});
    expect(next).toEqual(state);
  });

  it("applies other cues but skips the unknown character", () => {
    const next = reduce([
      { type: "background", assetId: "basement" },
      charPatch("ghost"),
    ]);
    expect(next.background).toBe("basement");
    expect(next.characters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("immutability", () => {
  it("never mutates the input state or its characters map", () => {
    const state: VisualState = {
      background: "basement",
      bgm: "mystery",
      characters: {
        suyao: { ...SUYAO_DEFAULTS },
      },
    };
    const snapshot: VisualState = structuredClone(state);

    const next = reduce(
      [
        { type: "background", assetId: "rooftop" },
        { type: "bgm", assetId: "stop" },
        charPatch("suyao", {
          variant: { op: "set", value: "angry" },
          position: { op: "set", value: "right" },
        }),
        charPatch("sasha"),
      ],
      state,
    );

    expect(state).toEqual(snapshot);
    expect(state.background).toBe("basement");
    expect(state.bgm).toBe("mystery");
    expect(suyao(state).variant).toBe("normal");
    expect(state.characters).toEqual(snapshot.characters);

    expect(next.background).toBe("rooftop");
    expect(next.bgm).toBeUndefined();
    expect(suyao(next).variant).toBe("angry");
    expect(suyao(next).position).toBe("right");
    expect(next.characters.sasha).toEqual({
      spriteSet: "placeholder_char",
      variant: "normal",
      position: "center",
      displayName: "莎莎",
      visible: true,
    });
    // The original character object is untouched even after patching.
    expect(suyao(next)).not.toBe(state.characters.suyao);
  });
});
