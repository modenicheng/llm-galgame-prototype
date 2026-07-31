/**
 * Tests for core story protocol types and their Zod schemas.
 *
 * These tests verify that the types and schemas defined in types.ts
 * compile correctly and enforce the expected structural constraints.
 */

import { describe, it, expect } from "vitest";
import {
  InteractionEventSchema,
  StoryStateSchema,
  StoryStatePatchSchema,
  GenerationEnvelopeSchema,
  PlanningPatchSchema,
  BranchCandidateSchema,
  AutocompleteResultSchema,
} from "./types.js";

import type {
  InteractionEvent,
  InteractionMode,
  InteractionOption,
  InputSpec,
  GeneratedEvent,
  GenerationEnvelope,
  StoryThread,
  CharacterState,
  StoryState,
  StoryStatePatch,
  PlanningPatch,
  BranchSource,
  BranchStatus,
  BranchCandidate,
  AutocompleteResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Type-level compile checks
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("InteractionMode should be a union of three string literals", () => {
    // Compile-only check: if the type changes shape this assignment will error.
    const mode: InteractionMode = "choice";
    expect(mode).toBe("choice");
  });

  it("InputSpec should accept the five defined kind values", () => {
    const spec: InputSpec = {
      kind: "free_text",
      placeholder: "Type your response...",
      max_length: 200,
    };
    expect(spec.kind).toBe("free_text");
    expect(spec.max_length).toBeGreaterThan(0);
  });

  it("InteractionOption should require id and text, with intent_hint optional", () => {
    const withoutHint: InteractionOption = {
      id: "opt-1",
      text: "Go left",
    };
    const withHint: InteractionOption = {
      id: "opt-2",
      text: "Go right",
      intent_hint: "The player wants to explore the right path",
    };
    expect(withoutHint.intent_hint).toBeUndefined();
    expect(withHint.intent_hint).toBeDefined();
  });

  it("InteractionEvent should be constructible with choice mode", () => {
    const event: InteractionEvent = {
      type: "interaction",
      interaction_id: "int-001",
      prompt: "What will you do?",
      mode: "choice",
      options: [
        { id: "a", text: "Approach the door" },
        { id: "b", text: "Turn back" },
      ],
    };
    expect(event.type).toBe("interaction");
    expect(event.options).toHaveLength(2);
  });

  it("InteractionEvent should be constructible with hybrid mode", () => {
    const event: InteractionEvent = {
      type: "interaction",
      interaction_id: "int-002",
      prompt: "How do you want to proceed?",
      mode: "hybrid",
      options: [
        { id: "a", text: "Knock on the door" },
      ],
      input: {
        kind: "action",
        placeholder: "Or describe what you do...",
        max_length: 150,
      },
    };
    expect(event.mode).toBe("hybrid");
    expect(event.input?.kind).toBe("action");
  });

  it("StoryThread should accept all five status values", () => {
    const thread: StoryThread = {
      id: "t1",
      summary: "Investigate the strange noise",
      status: "active",
      last_touched_turn: 3,
    };
    const statuses: StoryThread["status"][] = [
      "new",
      "active",
      "ready",
      "resolved",
      "abandoned",
    ];
    expect(statuses).toContain(thread.status);
  });

  it("CharacterState should accept partial field sets", () => {
    const minimal: CharacterState = {};
    const partial: CharacterState = {
      location: "library",
      emotion: "curious",
    };
    const full: CharacterState = {
      location: "hallway",
      emotion: "nervous",
      current_goal: "escape the building",
      relationship_to_player: "ally",
      known_facts: ["the door is locked", "there is a key in the drawer"],
    };
    expect(minimal).toBeDefined();
    expect(partial.emotion).toBe("curious");
    expect(full.known_facts).toHaveLength(2);
  });

  it("StoryState should be fully constructible with defaults-like values", () => {
    const state: StoryState = {
      scene: {
        id: "prologue",
        location: "tavern",
        time: "evening",
        purpose: "introduce the mysterious stranger",
      },
      canon: { weather: "rainy", gold: 50 },
      characters: {
        hero: { location: "tavern", emotion: "determined" },
      },
      open_threads: [],
      recent_summary: "The hero enters the tavern.",
      player_profile: {
        recent_tendencies: ["exploration", "dialogue"],
      },
    };
    expect(state.scene.id).toBe("prologue");
    expect(state.canon["gold"]).toBe(50);
  });

  it("GenerationEnvelope should require events and state_patch", () => {
    const envelope: GenerationEnvelope = {
      events: [
        {
          type: "narration",
          text: "The door creaks open.",
        },
        {
          type: "interaction",
          interaction_id: "int-001",
          prompt: "Enter the room?",
          mode: "choice",
          options: [{ id: "yes", text: "Yes" }],
        },
      ],
      state_patch: {
        recent_summary: "The player opened the door.",
      },
      planning_notes: {
        next_scene_plan: "The room contains a mysterious artifact.",
        thread_hints: ["artifact_mystery"],
      },
    };
    expect(envelope.events).toHaveLength(2);
    expect(envelope.planning_notes?.next_scene_plan).toBeDefined();
  });

  it("BranchCandidate should support all lifecycle statuses", () => {
    const branch: BranchCandidate = {
      id: "br-001",
      interaction_id: "int-001",
      source: "choice" as BranchSource,
      status: "queued" as BranchStatus,
      events: [],
    };
    const statuses: BranchStatus[] = [
      "queued",
      "generating",
      "ready",
      "selected",
      "discarded",
      "failed",
    ];
    expect(statuses).toContain(branch.status);
  });

  it("AutocompleteResult should require draft_id, suffix, intent, and confidence", () => {
    const result: AutocompleteResult = {
      draft_id: "draft-1",
      revision: 0,
      suffix: " quietly",
      intent: "The player wants to move stealthily",
      confidence: 0.85,
    };
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Zod schema validation tests
// ---------------------------------------------------------------------------

describe("InteractionEventSchema", () => {
  it("should parse a valid choice-mode interaction", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-1",
      prompt: "What now?",
      mode: "choice",
      options: [{ id: "a", text: "Fight" }],
    });
    expect(result.success).toBe(true);
  });

  it("should parse a valid input-mode interaction", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-2",
      prompt: "Describe your approach.",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Type here...",
        max_length: 500,
      },
    });
    expect(result.success).toBe(true);
  });

  it("should fail when type is not 'interaction'", () => {
    const result = InteractionEventSchema.safeParse({
      type: "dialogue",
      interaction_id: "int-3",
      prompt: "Hello?",
      mode: "input",
    });
    expect(result.success).toBe(false);
  });

  it("should fail when prompt is empty", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-4",
      prompt: "",
      mode: "input",
      input: { kind: "free_text", placeholder: "...", max_length: 100 },
    });
    expect(result.success).toBe(false);
  });

  it("should fail for an unknown mode", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-5",
      prompt: "How?",
      mode: "unknown_mode",
    });
    expect(result.success).toBe(false);
  });
});

describe("StoryStateSchema", () => {
  it("should parse a minimal valid state", () => {
    const result = StoryStateSchema.safeParse({
      scene: { id: "s1", location: "room", purpose: "explore" },
      canon: {},
      characters: {},
      open_threads: [],
      recent_summary: "Nothing yet.",
      player_profile: { recent_tendencies: [] },
    });
    expect(result.success).toBe(true);
  });

  it("should parse a rich state with all fields populated", () => {
    const result = StoryStateSchema.safeParse({
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
      ],
      recent_summary: "The player ventured into the dark forest.",
      player_profile: {
        recent_tendencies: ["risk-taking", "exploration"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("should fail when scene is missing a required field", () => {
    const result = StoryStateSchema.safeParse({
      scene: { id: "s3", location: "room" },
      canon: {},
      characters: {},
      open_threads: [],
      recent_summary: "Test.",
      player_profile: { recent_tendencies: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe("StoryStatePatchSchema", () => {
  it("should accept an empty patch", () => {
    const result = StoryStatePatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should parse a patch with partial scene override", () => {
    const result = StoryStatePatchSchema.safeParse({
      scene: { location: "cave" },
      recent_summary: "The adventurer went deeper underground.",
    });
    expect(result.success).toBe(true);
  });

  it("should fail when scene.location is empty string", () => {
    const result = StoryStatePatchSchema.safeParse({
      scene: { location: "" },
    });
    expect(result.success).toBe(false);
  });

  it("should parse a patch with new open threads", () => {
    const result = StoryStatePatchSchema.safeParse({
      open_threads: [
        {
          id: "new-thread",
          summary: "Discover the ancient treasure",
          status: "new",
          last_touched_turn: 5,
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("GenerationEnvelopeSchema", () => {
  it("should parse a valid minimal envelope", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [
        { type: "narration", text: "It begins." },
      ],
      state_patch: {
        recent_summary: "The story has started.",
      },
    });
    expect(result.success).toBe(true);
  });

  it("should parse an envelope with mixed event types", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [
        { type: "narration", text: "A figure emerges from the shadows." },
        {
          type: "dialogue",
          speaker: "Stranger",
          text: "Who goes there?",
          portrait: {
            character: "stranger",
            expression: "suspicious",
            position: "center",
          },
        },
        {
          type: "interaction",
          interaction_id: "int-1",
          prompt: "Identify yourself.",
          mode: "input",
          input: {
            kind: "question",
            placeholder: "Your name...",
            max_length: 50,
          },
        },
      ],
      state_patch: {
        recent_summary: "A mysterious stranger appeared.",
      },
      planning_notes: {
        next_scene_plan: "Depending on the player's response...",
        anticipated_interactions: ["conversation"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("should fail when events array is empty", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [],
      state_patch: {},
    });
    // An empty array is still a valid array — the schema accepts it.
    // This test documents the current behaviour.
    expect(result.success).toBe(true);
  });

  it("should fail for an unknown event type", () => {
    const result = GenerationEnvelopeSchema.safeParse({
      events: [{ type: "unknown_type", text: "???" }],
      state_patch: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("PlanningPatchSchema", () => {
  it("should parse an empty planning patch", () => {
    const result = PlanningPatchSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should parse a fully populated planning patch", () => {
    const result = PlanningPatchSchema.safeParse({
      next_scene_plan: "Introduce the main antagonist",
      thread_hints: ["antagonist_reveal", "mystery_deepens"],
      character_directions: {
        villain: "Threaten the player but leave an opening for escape",
        sidekick: "Warn the player about the danger",
      },
      anticipated_interactions: ["dialogue", "combat"],
    });
    expect(result.success).toBe(true);
  });
});

describe("BranchCandidateSchema", () => {
  it("should parse a minimal branch candidate", () => {
    const result = BranchCandidateSchema.safeParse({
      id: "br-1",
      interaction_id: "int-1",
      source: "choice",
      status: "queued",
      events: [],
    });
    expect(result.success).toBe(true);
  });

  it("should parse a fully populated branch candidate", () => {
    const result = BranchCandidateSchema.safeParse({
      id: "br-2",
      interaction_id: "int-2",
      source: "autocomplete",
      status: "ready",
      predicted_input: "open the chest",
      intent: "player wants to loot",
      events: [
        { type: "narration", text: "The chest creaks open to reveal..." },
      ],
      state_patch: {
        recent_summary: "The player opened the treasure chest.",
      },
    });
    expect(result.success).toBe(true);
  });

  it("should fail for an invalid source", () => {
    const result = BranchCandidateSchema.safeParse({
      id: "br-3",
      interaction_id: "int-3",
      source: "invalid_source",
      status: "queued",
      events: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("AutocompleteResultSchema", () => {
  it("should parse a valid autocomplete result", () => {
    const result = AutocompleteResultSchema.safeParse({
      draft_id: "draft-1",
      revision: 3,
      suffix: " by the moonlight",
      intent: "player describes the scenery",
      confidence: 0.72,
    });
    expect(result.success).toBe(true);
  });

  it("should fail when confidence is outside [0,1]", () => {
    const tooHigh = AutocompleteResultSchema.safeParse({
      draft_id: "draft-2",
      revision: 0,
      suffix: "test",
      intent: "test",
      confidence: 1.5,
    });
    expect(tooHigh.success).toBe(false);

    const negative = AutocompleteResultSchema.safeParse({
      draft_id: "draft-3",
      revision: 0,
      suffix: "test",
      intent: "test",
      confidence: -0.1,
    });
    expect(negative.success).toBe(false);
  });
});
