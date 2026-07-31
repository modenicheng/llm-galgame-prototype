/**
 * Tests for StoryState patch application and validation.
 */

import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { applyPatch, validatePatch } from "./patch.js";
import { createInitialState } from "./state.js";
import type { StoryState, StoryStatePatch, StoryThread } from "./types.js";

// ---------------------------------------------------------------------------
// validatePatch
// ---------------------------------------------------------------------------

describe("validatePatch", () => {
  it("should accept an empty object as a valid patch", () => {
    expect(() => validatePatch({})).not.toThrow();
    const result = validatePatch({});
    expect(result).toEqual({});
  });

  it("should accept a patch with only recent_summary", () => {
    const patch = validatePatch({
      recent_summary: "A brief update.",
    });
    expect(patch.recent_summary).toBe("A brief update.");
  });

  it("should accept a patch with scene partial fields", () => {
    const patch = validatePatch({
      scene: {
        id: "new_scene",
        location: "beach",
      },
    });
    expect(patch.scene?.id).toBe("new_scene");
    expect(patch.scene?.location).toBe("beach");
  });

  it("should accept a patch with new open threads", () => {
    const patch = validatePatch({
      open_threads: [
        {
          id: "th-1",
          summary: "Investigate the cave",
          status: "new",
          last_touched_turn: 3,
        },
      ],
    });
    expect(patch.open_threads).toHaveLength(1);
  });

  it("should accept a patch with character updates", () => {
    const patch = validatePatch({
      characters: {
        alice: {
          emotion: "surprised",
          location: "garden",
        },
      },
    });
    expect(patch.characters?.["alice"]?.emotion).toBe("surprised");
  });

  it("should accept a full patch with all fields", () => {
    const patch = validatePatch({
      scene: {
        id: "chapter2",
        location: "dungeon",
        time: "midnight",
        purpose: "find the escape route",
      },
      canon: { torch_lit: true, keys_collected: 2 },
      characters: {
        hero: {
          location: "dungeon",
          emotion: "focused",
          current_goal: "escape",
          relationship_to_player: "self",
          known_facts: ["the guard patrols every 10 minutes"],
        },
      },
      open_threads: [
        {
          id: "escape",
          summary: "Find a way out of the dungeon",
          status: "active",
          last_touched_turn: 5,
        },
      ],
      recent_summary: "The hero broke free from the cell.",
      player_profile: {
        recent_tendencies: ["stealth"],
      },
    });
    expect(patch).toBeDefined();
  });

  it("should throw ZodError for a scene.location that is empty string", () => {
    expect(() =>
      validatePatch({ scene: { location: "" } }),
    ).toThrow(ZodError);
  });

  it("should throw ZodError for an open_thread with invalid status", () => {
    expect(() =>
      validatePatch({
        open_threads: [
          {
            id: "bad",
            summary: "Bad thread",
            status: "invalid_status",
            last_touched_turn: 1,
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it("should throw ZodError for non-object input", () => {
    expect(() => validatePatch(null)).toThrow(ZodError);
    expect(() => validatePatch("string")).toThrow(ZodError);
    expect(() => validatePatch(42)).toThrow(ZodError);
  });
});

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

describe("applyPatch", () => {
  it("should return a new object (immutable)", () => {
    const state = createInitialState();
    const patched = applyPatch(state, {});
    expect(patched).not.toBe(state);
    expect(patched.scene).not.toBe(state.scene);
  });

  it("should leave state unchanged for an empty patch", () => {
    const state = createInitialState();
    const patched = applyPatch(state, {});
    expect(patched).toEqual(state);
  });

  describe("scene", () => {
    it("should replace individual scene fields while preserving others", () => {
      const state = createInitialState();
      const patched = applyPatch(state, {
        scene: { location: "castle" },
      });
      expect(patched.scene.id).toBe(state.scene.id); // preserved
      expect(patched.scene.location).toBe("castle"); // updated
      expect(patched.scene.purpose).toBe(state.scene.purpose); // preserved
    });

    it("should replace all scene fields when all are provided", () => {
      const state = createInitialState();
      const patched = applyPatch(state, {
        scene: {
          id: "epilogue",
          location: "throne_room",
          time: "noon",
          purpose: "crowning ceremony",
        },
      });
      expect(patched.scene.id).toBe("epilogue");
      expect(patched.scene.location).toBe("throne_room");
      expect(patched.scene.time).toBe("noon");
      expect(patched.scene.purpose).toBe("crowning ceremony");
    });
  });

  describe("canon", () => {
    it("should shallow-merge canon keys (patch overrides existing)", () => {
      const state = createInitialState({
        canon: { a: 1, b: 2 },
      });
      const patched = applyPatch(state, {
        canon: { b: 99, c: 3 },
      });
      expect(patched.canon).toEqual({ a: 1, b: 99, c: 3 });
    });

    it("should not remove existing canon keys not in the patch", () => {
      const state = createInitialState({
        canon: { weather: "sunny", gold: 100 },
      });
      const patched = applyPatch(state, {
        canon: { gold: 200 },
      });
      expect(patched.canon["weather"]).toBe("sunny");
      expect(patched.canon["gold"]).toBe(200);
    });
  });

  describe("characters", () => {
    it("should shallow-merge per-character fields", () => {
      const state = createInitialState({
        characters: {
          alice: {
            location: "tavern",
            emotion: "happy",
            relationship_to_player: "friend",
          },
        },
      });
      const patched = applyPatch(state, {
        characters: {
          alice: { emotion: "sad", current_goal: "leave town" },
        },
      });
      const alice = patched.characters["alice"];
      expect(alice?.location).toBe("tavern"); // preserved
      expect(alice?.emotion).toBe("sad"); // updated
      expect(alice?.current_goal).toBe("leave town"); // added
      expect(alice?.relationship_to_player).toBe("friend"); // preserved
    });

    it("should add new characters not previously in state", () => {
      const state = createInitialState();
      const patched = applyPatch(state, {
        characters: {
          bob: {
            location: "market",
            emotion: "curious",
          },
        },
      });
      expect(patched.characters["bob"]).toBeDefined();
      expect(patched.characters["bob"]?.location).toBe("market");
    });

    it("should keep existing characters when adding new ones", () => {
      const state = createInitialState({
        characters: {
          alice: { location: "home", emotion: "calm" },
        },
      });
      const patched = applyPatch(state, {
        characters: {
          bob: { location: "garden", emotion: "playful" },
        },
      });
      expect(patched.characters["alice"]).toBeDefined();
      expect(patched.characters["bob"]).toBeDefined();
    });

    it("should not remove characters not mentioned in patch", () => {
      const state = createInitialState({
        characters: {
          alice: { location: "home" },
          bob: { location: "work" },
        },
      });
      const patched = applyPatch(state, {
        characters: {
          alice: { emotion: "tired" },
        },
      });
      expect(patched.characters["bob"]).toBeDefined();
      expect(patched.characters["bob"]?.location).toBe("work");
    });
  });

  describe("open_threads", () => {
    it("should merge threads by id (patch overrides existing)", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "quest",
            summary: "Old quest description",
            status: "active" as const,
            last_touched_turn: 1,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "quest",
            summary: "Updated quest description",
            status: "ready" as const,
            last_touched_turn: 5,
          },
        ],
      });
      expect(patched.open_threads).toHaveLength(1);
      expect(patched.open_threads[0]?.summary).toBe(
        "Updated quest description",
      );
      expect(patched.open_threads[0]?.status).toBe("ready");
      expect(patched.open_threads[0]?.last_touched_turn).toBe(5);
    });

    it("should add new threads alongside existing ones", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "old",
            summary: "Old thread",
            status: "active" as const,
            last_touched_turn: 1,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "new_one",
            summary: "A new thread appears",
            status: "new" as const,
            last_touched_turn: 3,
          },
        ],
      });
      expect(patched.open_threads).toHaveLength(2);
      expect(
        patched.open_threads.find((t) => t.id === "old"),
      ).toBeDefined();
      expect(
        patched.open_threads.find((t) => t.id === "new_one"),
      ).toBeDefined();
    });

    it("should not downgrade active thread to new", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "t1",
            summary: "Active thread",
            status: "active" as const,
            last_touched_turn: 3,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "t1",
            summary: "Updated but with wrong status",
            status: "new" as const,
            last_touched_turn: 5,
          },
        ],
      });
      expect(patched.open_threads[0]?.status).toBe("active");
      expect(patched.open_threads[0]?.summary).toBe("Updated but with wrong status");
      expect(patched.open_threads[0]?.last_touched_turn).toBe(5);
    });

    it("should not downgrade ready thread to new", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "t1",
            summary: "Ready thread",
            status: "ready" as const,
            last_touched_turn: 3,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "t1",
            summary: "Updated",
            status: "new" as const,
            last_touched_turn: 5,
          },
        ],
      });
      expect(patched.open_threads[0]?.status).toBe("ready");
    });

    it("should not downgrade ready thread to active", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "t1",
            summary: "Ready thread",
            status: "ready" as const,
            last_touched_turn: 3,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "t1",
            summary: "Updated",
            status: "active" as const,
            last_touched_turn: 5,
          },
        ],
      });
      expect(patched.open_threads[0]?.status).toBe("ready");
    });

    it("should allow upgrading new thread to active", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "t1",
            summary: "New thread",
            status: "new" as const,
            last_touched_turn: 1,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "t1",
            summary: "Now active",
            status: "active" as const,
            last_touched_turn: 3,
          },
        ],
      });
      expect(patched.open_threads[0]?.status).toBe("active");
    });

    it("should allow reactivating a resolved thread", () => {
      const state = createInitialState({
        open_threads: [
          {
            id: "t1",
            summary: "Resolved thread",
            status: "resolved" as const,
            last_touched_turn: 5,
          },
        ],
      });
      const patched = applyPatch(state, {
        open_threads: [
          {
            id: "t1",
            summary: "Reopened!",
            status: "active" as const,
            last_touched_turn: 7,
          },
        ],
      });
      // Terminal states (resolved/abandoned) can be reactivated
      expect(patched.open_threads[0]?.status).toBe("active");
      expect(patched.open_threads[0]?.summary).toBe("Reopened!");
    });
  });

  describe("recent_summary", () => {
    it("should replace the recent_summary when provided", () => {
      const state = createInitialState({
        recent_summary: "The story just started.",
      });
      const patched = applyPatch(state, {
        recent_summary: "Something dramatic happened.",
      });
      expect(patched.recent_summary).toBe("Something dramatic happened.");
    });

    it("should preserve the recent_summary when not provided", () => {
      const state = createInitialState({
        recent_summary: "The story just started.",
      });
      const patched = applyPatch(state, {
        scene: { location: "forest" },
      });
      expect(patched.recent_summary).toBe("The story just started.");
    });

    it("should preserve the summary when empty string is passed", () => {
      // Empty string is still `!== undefined`, so it should override.
      const state = createInitialState({
        recent_summary: "The story just started.",
      });
      const patched = applyPatch(state, {
        recent_summary: "",
      });
      expect(patched.recent_summary).toBe("");
    });
  });

  describe("player_profile", () => {
    it("should shallow-merge player_profile fields", () => {
      const state = createInitialState({
        player_profile: {
          recent_tendencies: ["exploration"],
        },
      });
      const patched = applyPatch(state, {
        player_profile: {
          recent_tendencies: ["exploration", "diplomacy"],
        },
      });
      expect(patched.player_profile.recent_tendencies).toEqual([
        "exploration",
        "diplomacy",
      ]);
    });
  });

  describe("combined patches", () => {
    it("should apply multiple patch fields simultaneously", () => {
      const state = createInitialState({
        canon: { gold: 100 },
        characters: {
          hero: { location: "village", emotion: "calm" },
        },
        open_threads: [
          {
            id: "intro",
            summary: "Introduce the world",
            status: "active" as const,
            last_touched_turn: 0,
          },
        ],
        recent_summary: "The hero is in the village.",
      });

      const patched = applyPatch(state, {
        scene: { location: "dungeon", time: "night" },
        canon: { gold: 50, torch: true },
        characters: {
          hero: { location: "dungeon", emotion: "tense" },
          guard: { location: "dungeon", emotion: "alert" },
        },
        open_threads: [
          {
            id: "intro",
            summary: "Introduce the world",
            status: "resolved" as const,
            last_touched_turn: 3,
          },
          {
            id: "escape",
            summary: "Escape the dungeon",
            status: "active" as const,
            last_touched_turn: 3,
          },
        ],
        recent_summary: "The hero was captured and thrown in the dungeon.",
      });

      expect(patched.scene.location).toBe("dungeon");
      expect(patched.scene.time).toBe("night");
      expect(patched.canon).toEqual({ gold: 50, torch: true });
      expect(patched.characters["hero"]?.emotion).toBe("tense");
      expect(patched.characters["guard"]).toBeDefined();
      expect(
        patched.open_threads.find((t) => t.id === "intro")?.status,
      ).toBe("resolved");
      expect(
        patched.open_threads.find((t) => t.id === "escape"),
      ).toBeDefined();
      expect(patched.recent_summary).toBe(
        "The hero was captured and thrown in the dungeon.",
      );
    });
  });
});
