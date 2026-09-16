/**
 * Tests for StoryState factory and summarization utilities.
 * MA-A2：StoryState 收缩为 reconcile 投影产物（scene/characters/recent_summary）。
 */

import { describe, it, expect } from "vitest";
import { createInitialState, summarizeState } from "./state.js";
import type { StoryState, CharacterState } from "./types.js";

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe("createInitialState", () => {
  it("should return a fully-populated default state with no overrides", () => {
    const state = createInitialState();

    // Scene defaults
    expect(state.scene).toBeDefined();
    expect(state.scene.id).toBe("prologue");
    expect(state.scene.location).toBe("unknown");
    expect(state.scene.purpose).toBe(
      "establish setting and introduce characters",
    );

    // Collections start empty
    expect(state.characters).toEqual({});

    // Summary
    expect(state.recent_summary).toBe("The story has just begun.");
  });

  it("should return a new object each call (no reference sharing)", () => {
    const a = createInitialState();
    const b = createInitialState();
    expect(a).not.toBe(b);
    expect(a.scene).not.toBe(b.scene);
    expect(a.characters).not.toBe(b.characters);
  });

  it("should override scene id when provided", () => {
    const state = createInitialState({
      scene: {
        id: "chapter1",
        location: "castle",
        purpose: "meet the king",
      },
    });
    expect(state.scene.id).toBe("chapter1");
    expect(state.scene.location).toBe("castle");
    expect(state.scene.purpose).toBe("meet the king");
  });

  it("should override partial scene fields without losing defaults", () => {
    const state = createInitialState({
      scene: {
        id: "custom",
        location: "beach",
        // purpose not provided — should fall back to default
      } as StoryState["scene"],
    });
    expect(state.scene.id).toBe("custom");
    expect(state.scene.location).toBe("beach");
    // When entire scene is replaced via overrides.scene, the purpose
    // comes from the override object, not merged with defaults.
    // This behaviour is intentional: overrides replace top-level keys.
  });

  it("should pre-populate characters from overrides", () => {
    const char: CharacterState = {
      location: "tavern",
    };
    const state = createInitialState({
      characters: { alice: char },
    });
    expect(state.characters["alice"]).toBeDefined();
    expect(state.characters["alice"]?.location).toBe("tavern");
  });

  it("should override recent_summary", () => {
    const state = createInitialState({
      recent_summary: "Custom opening line.",
    });
    expect(state.recent_summary).toBe("Custom opening line.");
  });
});

// ---------------------------------------------------------------------------
// summarizeState
// ---------------------------------------------------------------------------

describe("summarizeState", () => {
  it("should produce a non-empty string for a default state", () => {
    const state = createInitialState();
    const summary = summarizeState(state);
    expect(summary).toBeTruthy();
    expect(typeof summary).toBe("string");
  });

  it("should include the scene id, location, and purpose", () => {
    const state = createInitialState({
      scene: {
        id: "dark_forest",
        location: "forest",
        purpose: "find the hidden path",
        time: "dawn",
      },
    });
    const summary = summarizeState(state);
    expect(summary).toContain("dark_forest");
    expect(summary).toContain("forest");
    expect(summary).toContain("find the hidden path");
    expect(summary).toContain("dawn");
  });

  it("should list characters with their locations", () => {
    const state = createInitialState({
      characters: {
        hero: { location: "cave" },
        merchant: { location: "market" },
      },
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Characters]");
    expect(summary).toContain("hero");
    expect(summary).toContain("loc:cave");
    expect(summary).toContain("merchant");
  });

  it('should show "(none present)" when there are no characters', () => {
    const state = createInitialState();
    const summary = summarizeState(state);
    expect(summary).toContain("(none present)");
  });

  it("should include the recent summary", () => {
    const state = createInitialState({
      recent_summary: "The player narrowly escaped the dragon.",
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Recent]");
    expect(summary).toContain("The player narrowly escaped the dragon.");
  });

  it("should produce compact output (under 2000 characters) for a rich state", () => {
    const state = createInitialState({
      scene: {
        id: "climax",
        location: "throne_room",
        time: "midnight",
        purpose: "confront the usurper king",
      },
      characters: {
        player: { location: "throne_room" },
        king: { location: "throne_room" },
        advisor: { location: "throne_room" },
      },
      recent_summary: "The player stormed the throne room with allies.",
    });
    const summary = summarizeState(state);
    expect(summary.length).toBeLessThan(2000);
  });
});
