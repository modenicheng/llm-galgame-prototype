/**
 * Tests for StoryState patch merging and validation.
 */

import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { mergePatches, validatePatch } from "./patch.js";
import type { StoryStatePatch } from "./types.js";

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
// mergePatches
// ---------------------------------------------------------------------------

describe("mergePatches", () => {
  it("merges two patches with b winning at every level", () => {
    const merged = mergePatches(
      {
        scene: { location: "酒馆" },
        canon: { gold: 50 },
        characters: { hero: { emotion: "平静" } },
        recent_summary: "旧摘要。",
      },
      {
        scene: { time: "night" },
        canon: { torch: true },
        characters: { hero: { location: "神殿" } },
        recent_summary: "新摘要。",
      },
    );

    expect(merged.scene).toEqual({ location: "酒馆", time: "night" });
    expect(merged.canon).toEqual({ gold: 50, torch: true });
    expect(merged.characters?.hero).toEqual({ emotion: "平静", location: "神殿" });
    expect(merged.recent_summary).toBe("新摘要。");
  });

  it("keeps thread status progression (no downgrade) when merging by id", () => {
    const merged = mergePatches(
      {
        open_threads: [
          { id: "t1", summary: "调查", status: "new", last_touched_turn: 1 },
        ],
      },
      {
        open_threads: [
          { id: "t1", summary: "调查", status: "active", last_touched_turn: 2 },
        ],
      },
    );

    expect(merged.open_threads?.[0]?.status).toBe("active");
  });

  it("appends threads from both patches when ids differ", () => {
    const merged = mergePatches(
      { open_threads: [{ id: "a", summary: "A", status: "new", last_touched_turn: 1 }] },
      { open_threads: [{ id: "b", summary: "B", status: "active", last_touched_turn: 2 }] },
    );

    expect(merged.open_threads).toHaveLength(2);
  });

  it("returns an empty patch when both inputs are empty", () => {
    expect(mergePatches({}, {})).toEqual({});
  });
});
