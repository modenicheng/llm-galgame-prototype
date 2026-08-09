import { describe, it, expect } from "vitest";
import {
  PortraitSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  InteractionEventSchema,
  isPlayableEvent,
} from "./schema.js";
import type { RuntimeModelEvent, RuntimePlayableEvent } from "./schema.js";

// ---------------------------------------------------------------------------
// PortraitSchema
// ---------------------------------------------------------------------------
describe("PortraitSchema", () => {
  it("accepts a valid portrait", () => {
    const result = PortraitSchema.safeParse({
      character: "alice",
      expression: "smile",
      position: "left",
    });
    expect(result.success).toBe(true);
  });

  it("defaults position to center when omitted", () => {
    const result = PortraitSchema.safeParse({
      character: "alice",
      expression: "happy",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.position).toBe("center");
    }
  });

  it("rejects an invalid position", () => {
    const result = PortraitSchema.safeParse({
      character: "alice",
      expression: "smile",
      position: "behind",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty character", () => {
    const result = PortraitSchema.safeParse({
      character: "",
      expression: "smile",
      position: "left",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty expression", () => {
    const result = PortraitSchema.safeParse({
      character: "alice",
      expression: "",
      position: "left",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DialogueDraftEventSchema
// ---------------------------------------------------------------------------
describe("DialogueDraftEventSchema", () => {
  it("accepts a valid dialogue event", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a dialogue event with a portrait", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      portrait: {
        character: "alice",
        expression: "smile",
        position: "left",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a dialogue event with explicit null portrait", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
      portrait: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a dialogue event with omitted portrait (nullish)", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hello!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing speaker", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      text: "Hello!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty speaker", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "",
      text: "Hello!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid portrait position", () => {
    const result = DialogueDraftEventSchema.safeParse({
      type: "dialogue",
      speaker: "alice",
      text: "Hi",
      portrait: {
        character: "alice",
        expression: "smile",
        position: "offscreen",
      },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NarrationDraftEventSchema
// ---------------------------------------------------------------------------
describe("NarrationDraftEventSchema", () => {
  it("accepts a valid narration event", () => {
    const result = NarrationDraftEventSchema.safeParse({
      type: "narration",
      text: "The sun set over the horizon.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty text", () => {
    const result = NarrationDraftEventSchema.safeParse({
      type: "narration",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = NarrationDraftEventSchema.safeParse({
      type: "narration",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPlayableEvent
// ---------------------------------------------------------------------------
describe("isPlayableEvent", () => {
  it("returns true for dialogue events", () => {
    const event: RuntimeModelEvent = {
      type: "dialogue",
      speaker: "alice",
      text: "Hi",
      line_id: "L001",
    };
    expect(isPlayableEvent(event)).toBe(true);
  });

  it("returns true for narration events", () => {
    const event: RuntimeModelEvent = {
      type: "narration",
      text: "It was dark.",
      line_id: "L002",
    };
    expect(isPlayableEvent(event)).toBe(true);
  });

  it("returns false for interaction events", () => {
    const event: RuntimeModelEvent = {
      type: "interaction",
      interaction_id: "int1",
      prompt: "What?",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "...",
        max_length: 100,
      },
    };
    expect(isPlayableEvent(event)).toBe(false);
  });

  it("returns false for end events", () => {
    const event: RuntimeModelEvent = {
      type: "end",
      ending_id: "end1",
      text: "The end.",
    };
    expect(isPlayableEvent(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InteractionEventSchema (discriminated union)
// ---------------------------------------------------------------------------

describe("InteractionEventSchema union", () => {
  it("rejects choice mode without options", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose!",
      mode: "choice",
    });
    expect(result.success).toBe(false);
  });

  it("rejects choice mode with empty options array", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose!",
      mode: "choice",
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts choice mode with options and no bridge", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose!",
      mode: "choice",
      options: [
        { id: "a", text: "Option A" },
        { id: "b", text: "Option B" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects hybrid mode without options", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      input: {
        kind: "free_text",
        placeholder: "...",
        max_length: 100,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects hybrid mode without input", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [{ id: "a", text: "A" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid hybrid mode with options and input", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [
        { id: "a", text: "Option A" },
        { id: "b", text: "Option B" },
      ],
      input: {
        kind: "free_text",
        placeholder: "Type...",
        max_length: 200,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts input mode with input", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Your answer...",
        max_length: 100,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects input mode without input field", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
    });
    expect(result.success).toBe(false);
  });

  it("accepts input mode without an input_bridge (bridge is a prefetch task)", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Your answer...",
        max_length: 100,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts hybrid mode without an input_bridge (bridge is a prefetch task)", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      input: {
        kind: "free_text",
        placeholder: "Type...",
        max_length: 200,
      },
    });
    expect(result.success).toBe(true);
  });




  // --- §14.2: hybrid id uniqueness / bridge bounds ---

  it("rejects hybrid mode with duplicate option ids", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [
        { id: "a", text: "A" },
        { id: "a", text: "A again" },
      ],
      input: {
        kind: "free_text",
        placeholder: "Type...",
        max_length: 200,
      },
    });
    expect(result.success).toBe(false);
  });


  // --- §14.2: input forbidden fields / InputSpec limits ---

  it("rejects input mode carrying options", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      input: {
        kind: "free_text",
        placeholder: "Your answer...",
        max_length: 100,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects input mode with max_length 0", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Your answer...",
        max_length: 0,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects input mode with max_length above 2000", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Your answer...",
        max_length: 2001,
      },
    });
    expect(result.success).toBe(false);
  });
});
