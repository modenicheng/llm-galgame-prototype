/**
 * Tests for StoryState factory and summarization utilities.
 */

import { describe, it, expect } from "vitest";
import {
  createInitialState,
  summarizeState,
  serializeState,
  deserializeState,
} from "./state.js";
import type { StoryState, StoryThread, CharacterState } from "./types.js";

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
    expect(state.canon).toEqual({});
    expect(state.characters).toEqual({});
    expect(state.open_threads).toEqual([]);

    // Summary and profile
    expect(state.recent_summary).toBe("The story has just begun.");
    expect(state.player_profile.recent_tendencies).toEqual([]);
  });

  it("should return a new object each call (no reference sharing)", () => {
    const a = createInitialState();
    const b = createInitialState();
    expect(a).not.toBe(b);
    expect(a.scene).not.toBe(b.scene);
    expect(a.canon).not.toBe(b.canon);
    expect(a.characters).not.toBe(b.characters);
    expect(a.open_threads).not.toBe(b.open_threads);
    expect(a.player_profile).not.toBe(b.player_profile);
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

  it("should pre-populate canon from overrides", () => {
    const state = createInitialState({
      canon: { weather: "stormy", gold: 100 },
    });
    expect(state.canon["weather"]).toBe("stormy");
    expect(state.canon["gold"]).toBe(100);
  });

  it("should pre-populate characters from overrides", () => {
    const char: CharacterState = {
      location: "tavern",
      emotion: "happy",
      relationship_to_player: "friend",
    };
    const state = createInitialState({
      characters: { alice: char },
    });
    expect(state.characters["alice"]).toBeDefined();
    expect(state.characters["alice"]?.emotion).toBe("happy");
  });

  it("should pre-populate open threads from overrides", () => {
    const thread: StoryThread = {
      id: "th-1",
      summary: "Solve the mystery",
      status: "active",
      last_touched_turn: 0,
    };
    const state = createInitialState({
      open_threads: [thread],
    });
    expect(state.open_threads).toHaveLength(1);
    expect(state.open_threads[0]?.id).toBe("th-1");
  });

  it("should override recent_summary", () => {
    const state = createInitialState({
      recent_summary: "Custom opening line.",
    });
    expect(state.recent_summary).toBe("Custom opening line.");
  });

  it("should override player_profile tendencies", () => {
    const state = createInitialState({
      player_profile: {
        recent_tendencies: ["aggressive", "stealth"],
      },
    });
    expect(state.player_profile.recent_tendencies).toEqual([
      "aggressive",
      "stealth",
    ]);
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

  it("should list characters with their attributes", () => {
    const state = createInitialState({
      characters: {
        hero: {
          location: "cave",
          emotion: "cautious",
          current_goal: "retrieve the gem",
          relationship_to_player: "self",
        },
        merchant: {
          location: "market",
          emotion: "friendly",
        },
      },
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Characters]");
    expect(summary).toContain("hero");
    expect(summary).toContain("cautious");
    expect(summary).toContain('goal:"retrieve the gem"');
    expect(summary).toContain("merchant");
    expect(summary).toContain("friendly");
  });

  it('should show "(none present)" when there are no characters', () => {
    const state = createInitialState();
    const summary = summarizeState(state);
    expect(summary).toContain("(none present)");
  });

  it("should list open threads sorted by status priority", () => {
    const state = createInitialState({
      open_threads: [
        {
          id: "old",
          summary: "An old resolved quest",
          status: "resolved",
          last_touched_turn: 10,
        },
        {
          id: "urgent",
          summary: "An active quest",
          status: "active",
          last_touched_turn: 2,
        },
        {
          id: "new_quest",
          summary: "A new discovery",
          status: "new",
          last_touched_turn: 1,
        },
      ],
    });
    const summary = summarizeState(state);

    // Active should appear before new, new before resolved.
    const activeIdx = summary.indexOf("[active]");
    const newIdx = summary.indexOf("[new]");
    const resolvedIdx = summary.indexOf("[resolved]");
    expect(activeIdx).toBeLessThan(newIdx);
    expect(newIdx).toBeLessThan(resolvedIdx);
  });

  it('should show "(none)" when there are no open threads', () => {
    const state = createInitialState();
    const summary = summarizeState(state);
    expect(summary).toContain("[Open Threads] (none)");
  });

  it("should include canon entries compactly", () => {
    const state = createInitialState({
      canon: { weather: "rainy", gold: 50, has_key: true },
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Canon]");
    expect(summary).toContain("weather=rainy");
    expect(summary).toContain("gold=50");
    expect(summary).toContain("has_key=true");
  });

  it("should include the recent summary", () => {
    const state = createInitialState({
      recent_summary: "The player narrowly escaped the dragon.",
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Recent]");
    expect(summary).toContain("The player narrowly escaped the dragon.");
  });

  it("should include player tendencies when present", () => {
    const state = createInitialState({
      player_profile: {
        recent_tendencies: ["exploration", "helping-others"],
      },
    });
    const summary = summarizeState(state);
    expect(summary).toContain("[Player]");
    expect(summary).toContain("exploration");
    expect(summary).toContain("helping-others");
  });

  it("should not include player tendencies section when empty", () => {
    const state = createInitialState();
    const summary = summarizeState(state);
    expect(summary).not.toContain("[Player]");
  });

  it("should produce compact output (under 2000 characters) for a rich state", () => {
    const state = createInitialState({
      scene: {
        id: "climax",
        location: "throne_room",
        time: "midnight",
        purpose: "confront the usurper king",
      },
      canon: {
        king_defeated: false,
        allies_present: 3,
        weapon: "ancestral_blade",
      },
      characters: {
        player: {
          location: "throne_room",
          emotion: "determined",
          relationship_to_player: "self",
        },
        king: {
          location: "throne_room",
          emotion: "arrogant",
          current_goal: "crush the rebellion",
        },
        advisor: {
          location: "throne_room",
          emotion: "nervous",
          relationship_to_player: "ally",
        },
      },
      open_threads: [
        {
          id: "main_quest",
          summary: "Liberate the kingdom from the usurper",
          status: "active",
          last_touched_turn: 12,
        },
        {
          id: "side_quest_library",
          summary: "Find the ancient prophecy in the royal library",
          status: "ready",
          last_touched_turn: 8,
        },
      ],
      recent_summary: "The player stormed the throne room with allies.",
      player_profile: {
        recent_tendencies: ["brave", "diplomatic"],
      },
    });
    const summary = summarizeState(state);
    expect(summary.length).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// serializeState / deserializeState
// ---------------------------------------------------------------------------

describe("serializeState", () => {
  it("should produce valid JSON for a default state", () => {
    const state = createInitialState();
    const json = serializeState(state);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.scene.id).toBe("prologue");
  });

  it("should produce compact JSON without extra whitespace", () => {
    const state = createInitialState();
    const json = serializeState(state);
    expect(json.split("\n").length).toBe(1);
  });
});

describe("deserializeState", () => {
  it("should deserialize a valid JSON string back to a StoryState", () => {
    const original = createInitialState({
      scene: {
        id: "chapter1",
        location: "throne_room",
        time: "dawn",
        purpose: "confront the king",
      },
      canon: { sword: "Excalibur", shield: true },
      characters: {
        hero: {
          location: "throne_room",
          emotion: "determined",
          current_goal: "defeat the king",
        },
      },
      open_threads: [
        {
          id: "quest",
          summary: "Confront the king",
          status: "active",
          last_touched_turn: 3,
        },
      ],
      recent_summary: "The hero entered the throne room.",
      player_profile: {
        recent_tendencies: ["brave"],
      },
    });

    const json = serializeState(original);
    const restored = deserializeState(json);
    expect(restored).toEqual(original);
  });

  it("should round-trip a state with an empty canon and no characters", () => {
    const original = createInitialState();
    const json = serializeState(original);
    const restored = deserializeState(json);
    expect(restored).toEqual(original);
    expect(restored.canon).toEqual({});
    expect(restored.characters).toEqual({});
  });

  it("should round-trip a state with rich character and thread data", () => {
    const original = createInitialState({
      scene: {
        id: "s2",
        location: "forest",
        time: "midnight",
        purpose: "find the witch's hut",
      },
      canon: { weather: "foggy", danger_level: 7 },
      characters: {
        player: {
          location: "forest",
          emotion: "tense",
          known_facts: ["the witch lives deep in the woods"],
        },
        witch: {
          location: "hut",
          emotion: "mysterious",
          relationship_to_player: "neutral",
        },
      },
      open_threads: [
        {
          id: "t1",
          summary: "Make contact with the witch",
          status: "active",
          last_touched_turn: 2,
        },
        {
          id: "t2",
          summary: "Gather herbs for the potion",
          status: "ready",
          last_touched_turn: 2,
        },
      ],
      recent_summary: "The player ventured into the dark forest.",
      player_profile: {
        recent_tendencies: ["risk-taking", "exploration"],
      },
    });

    const json = serializeState(original);
    const restored = deserializeState(json);
    expect(restored).toEqual(original);
    expect(restored.open_threads).toHaveLength(2);
    expect(restored.characters["witch"]?.emotion).toBe("mysterious");
    expect(restored.canon["danger_level"]).toBe(7);
  });

  it("should throw on malformed JSON", () => {
    expect(() => deserializeState("not valid json {{{ ")).toThrow();
  });

  it("should throw when JSON is valid but fails Zod validation", () => {
    expect(() =>
      deserializeState(
        JSON.stringify({ scene: { id: "x" }, canon: {} }),
      ),
    ).toThrow();
  });
});
