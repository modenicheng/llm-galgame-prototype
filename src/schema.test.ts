import { describe, it, expect } from "vitest";
import {
  PortraitSchema,
  DialogueDraftEventSchema,
  NarrationDraftEventSchema,
  ChoiceOptionSchema,
  ChoiceEventSchema,
  EndEventSchema,
  ModelEventSchema,
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
// ChoiceOptionSchema
// ---------------------------------------------------------------------------
describe("ChoiceOptionSchema", () => {
  it("accepts a valid option", () => {
    const result = ChoiceOptionSchema.safeParse({
      id: "opt1",
      text: "Go left",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty id", () => {
    const result = ChoiceOptionSchema.safeParse({
      id: "",
      text: "Go left",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = ChoiceOptionSchema.safeParse({
      id: "opt1",
      text: "",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChoiceEventSchema
// ---------------------------------------------------------------------------
describe("ChoiceEventSchema", () => {
  it("accepts a valid choice event with 2 options", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "What will you do?",
      options: [
        { id: "a", text: "Fight" },
        { id: "b", text: "Flee" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a choice event with 5 options", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "Choose:",
      options: [
        { id: "1", text: "A" },
        { id: "2", text: "B" },
        { id: "3", text: "C" },
        { id: "4", text: "D" },
        { id: "5", text: "E" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects fewer than 2 options", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "What now?",
      options: [{ id: "a", text: "Continue" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 5 options", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "Pick one:",
      options: [
        { id: "1", text: "A" },
        { id: "2", text: "B" },
        { id: "3", text: "C" },
        { id: "4", text: "D" },
        { id: "5", text: "E" },
        { id: "6", text: "F" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an option with empty id", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "Choose:",
      options: [
        { id: "", text: "Bad" },
        { id: "b", text: "Good" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an option with empty text", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      prompt: "Choose:",
      options: [
        { id: "a", text: "" },
        { id: "b", text: "Good" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("defaults prompt to '请选择：' when omitted", () => {
    const result = ChoiceEventSchema.safeParse({
      type: "choice",
      options: [
        { id: "a", text: "Yes" },
        { id: "b", text: "No" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prompt).toBe("请选择：");
    }
  });
});

// ---------------------------------------------------------------------------
// EndEventSchema
// ---------------------------------------------------------------------------
describe("EndEventSchema", () => {
  it("accepts a valid end event", () => {
    const result = EndEventSchema.safeParse({
      type: "end",
      ending_id: "good_ending",
      text: "They lived happily ever after.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty ending_id", () => {
    const result = EndEventSchema.safeParse({
      type: "end",
      ending_id: "",
      text: "The end.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = EndEventSchema.safeParse({
      type: "end",
      ending_id: "bad_end",
      text: "",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ModelEventSchema (discriminatedUnion)
// ---------------------------------------------------------------------------
describe("ModelEventSchema discriminatedUnion", () => {
  it("parses a dialogue event correctly", () => {
    const result = ModelEventSchema.safeParse({
      type: "dialogue",
      speaker: "bob",
      text: "Hey there!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("dialogue");
    }
  });

  it("parses a narration event correctly", () => {
    const result = ModelEventSchema.safeParse({
      type: "narration",
      text: "A long time ago...",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("narration");
    }
  });

  it("parses a choice event correctly", () => {
    const result = ModelEventSchema.safeParse({
      type: "choice",
      prompt: "What now?",
      options: [
        { id: "a", text: "Left" },
        { id: "b", text: "Right" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("choice");
    }
  });

  it("parses an interaction event correctly", () => {
    const result = ModelEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int001",
      prompt: "What do you say?",
      mode: "input",
      input: {
        kind: "free_text",
        placeholder: "Type here...",
        max_length: 200,
      },
      input_bridge: {
        events: [{ type: "narration", text: "She waits." }],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("interaction");
    }
  });

  it("parses an end event correctly", () => {
    const result = ModelEventSchema.safeParse({
      type: "end",
      ending_id: "fin",
      text: "Game over.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("end");
    }
  });

  it("rejects an unknown type", () => {
    const result = ModelEventSchema.safeParse({
      type: "unknown_event_type",
      data: "something",
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

  it("returns false for choice events", () => {
    const event: RuntimeModelEvent = {
      type: "choice",
      prompt: "Choose",
      options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
    };
    expect(isPlayableEvent(event)).toBe(false);
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
      input_bridge: {
        events: [{ type: "narration", text: "..." }],
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
// InteractionEventSchema (discriminated union with input_bridge)
// ---------------------------------------------------------------------------
const BRIDGE = { events: [{ type: "narration", text: "She waits." }] };

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
      options: [{ id: "a", text: "Option A" }],
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
      input_bridge: BRIDGE,
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
      input_bridge: BRIDGE,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid hybrid mode with options, input, and a bridge", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [{ id: "a", text: "Option A" }],
      input: {
        kind: "free_text",
        placeholder: "Type...",
        max_length: 200,
      },
      input_bridge: BRIDGE,
    });
    expect(result.success).toBe(true);
  });

  it("accepts input mode with input and a bridge", () => {
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
      input_bridge: BRIDGE,
    });
    expect(result.success).toBe(true);
  });

  it("rejects input mode without input field", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Type something!",
      mode: "input",
      input_bridge: BRIDGE,
    });
    expect(result.success).toBe(false);
  });

  it("rejects input mode without an input_bridge", () => {
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
    expect(result.success).toBe(false);
  });

  it("rejects hybrid mode without an input_bridge", () => {
    const result = InteractionEventSchema.safeParse({
      type: "interaction",
      interaction_id: "int1",
      prompt: "Choose or type!",
      mode: "hybrid",
      options: [{ id: "a", text: "A" }],
      input: {
        kind: "free_text",
        placeholder: "Type...",
        max_length: 200,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bridge with more than two events", () => {
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
      input_bridge: {
        events: [
          { type: "narration", text: "One." },
          { type: "narration", text: "Two." },
          { type: "narration", text: "Three." },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bridge containing a dialogue event", () => {
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
      input_bridge: {
        events: [{ type: "dialogue", speaker: "NPC", text: "Hi" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bridge containing a state_patch entry (no protocol entry)", () => {
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
      input_bridge: {
        events: [
          { type: "narration", text: "One." },
          { type: "state_patch", patch: { recent_summary: "nope" } },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});
