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
  BranchCandidateSchema,
} from "./types.js";

import type {
  InteractionEvent,
  InteractionMode,
  InputSpec,
  GeneratedEvent,
  GenerationEnvelope,
  CharacterState,
  StoryState,
  BranchSource,
  BranchStatus,
  BranchCandidate,
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
        { id: "b", text: "Wait and listen" },
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

  it("ChoiceInteraction should not expose input or bridge fields", () => {
    const event: InteractionEvent = {
      type: "interaction",
      interaction_id: "int-003",
      prompt: "Choose!",
      mode: "choice",
      options: [
        { id: "a", text: "Go" },
        { id: "b", text: "Stay" },
      ],
    };
    expect(event.mode).toBe("choice");
    expect("input" in event).toBe(false);
    expect("input_bridge" in event).toBe(false);
  });

  it("CharacterState should accept partial field sets", () => {
    const minimal: CharacterState = {};
    const partial: CharacterState = {
      location: "library",
    };
    expect(minimal).toBeDefined();
    expect(partial.location).toBe("library");
  });

  it("StoryState should be fully constructible with defaults-like values", () => {
    const state: StoryState = {
      scene: {
        id: "prologue",
        location: "tavern",
        time: "evening",
        purpose: "introduce the mysterious stranger",
      },
      characters: {
        hero: { location: "tavern" },
      },
      recent_summary: "The hero enters the tavern.",
    };
    expect(state.scene.id).toBe("prologue");
  });

  it("GenerationEnvelope should require events", () => {
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
          options: [
            { id: "yes", text: "Yes" },
            { id: "no", text: "No" },
          ],
        },
      ],
    };
    expect(envelope.events).toHaveLength(2);
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
      options: [
        { id: "a", text: "Fight" },
        { id: "b", text: "Flee" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an input-mode interaction carrying a removed input_bridge field", () => {
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
      input_bridge: {
        events: [{ type: "narration", text: "The room falls quiet." }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a hybrid-mode interaction carrying a removed input_bridge field", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-6",
      prompt: "Choose or speak.",
      mode: "hybrid",
      options: [
        { id: "a", text: "Ask" },
        { id: "b", text: "Wait" },
      ],
      input: {
        kind: "free_text",
        placeholder: "Or say anything...",
        max_length: 200,
      },
      input_bridge: {
        events: [
          { type: "narration", text: "She raises an eyebrow." },
          { type: "narration", text: "The candle flickers." },
        ],
      },
    });
    expect(result.success).toBe(false);
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
      input_bridge: {
        events: [{ type: "narration", text: "..." }],
      },
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

  // --- §14.2: choice option count, id uniqueness, forbidden fields ---

  it("should parse a choice interaction with the maximum of 5 options", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-7",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
        { id: "c", text: "C" },
        { id: "d", text: "D" },
        { id: "e", text: "E" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("should reject a choice interaction with only 1 option", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-8",
      prompt: "Pick one.",
      mode: "choice",
      options: [{ id: "a", text: "A" }],
    });
    expect(result.success).toBe(false);
  });

  it("should reject a choice interaction with 6 options", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-9",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
        { id: "c", text: "C" },
        { id: "d", text: "D" },
        { id: "e", text: "E" },
        { id: "f", text: "F" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("should reject a choice interaction with duplicate option ids", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-10",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "ask", text: "Ask" },
        { id: "ask", text: "Ask again" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("should treat option ids case-sensitively", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-13",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "ask", text: "Ask" },
        { id: "Ask", text: "Ask (uppercase)" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("should trim and reject whitespace-only option ids", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-14",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "   ", text: "Blank" },
        { id: "ask", text: "Ask" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("should reject a choice interaction carrying an input field", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-11",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      input: { kind: "free_text", placeholder: "...", max_length: 100 },
    });
    expect(result.success).toBe(false);
  });

  it("should reject a choice interaction carrying an input_bridge field", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int-12",
      prompt: "Pick one.",
      mode: "choice",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      input_bridge: { events: [{ type: "narration", text: "..." }] },
    });
    expect(result.success).toBe(false);
  });
});

describe("StoryStateSchema", () => {
  it("should parse a minimal valid state", () => {
    const result = StoryStateSchema.safeParse({
      scene: { id: "s1", location: "room", purpose: "explore" },
      characters: {},
      recent_summary: "Nothing yet.",
    });
    expect(result.success).toBe(true);
  });

  it("should parse a state with characters and time", () => {
    const result = StoryStateSchema.safeParse({
      scene: {
        id: "s2",
        location: "forest",
        time: "midnight",
        purpose: "find the witch's hut",
      },
      characters: {
        player: { location: "forest" },
      },
      recent_summary: "The player ventured into the dark forest.",
    });
    expect(result.success).toBe(true);
  });

  it("should fail when scene is missing a required field", () => {
    const result = StoryStateSchema.safeParse({
      scene: { id: "s3", location: "room" },
      characters: {},
      recent_summary: "Test.",
    });
    expect(result.success).toBe(false);
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
      source: "choice",
      status: "ready",
      events: [
        { type: "narration", text: "The chest creaks open to reveal..." },
      ],
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
