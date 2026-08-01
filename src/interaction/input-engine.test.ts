import { describe, it, expect, beforeEach } from "vitest";
import { InputEngine } from "./input-engine.js";
import type { InputSession } from "./input-engine.js";
import type { InputInteraction } from "../schema.js";

function makeInteraction(overrides: Partial<InputInteraction> = {}): InputInteraction {
  return {
    type: "interaction",
    interaction_id: "int-test-001",
    prompt: "What do you say?",
    mode: "input",
    input: {
      kind: "free_text",
      placeholder: "Type your response...",
      max_length: 200,
    },
    input_bridge: {
      events: [{ type: "narration", text: "She waits for your answer." }],
    },
    ...overrides,
  };
}

describe("InputEngine", () => {
  let engine: InputEngine;
  let interaction: InputInteraction;
  let session: InputSession;

  beforeEach(() => {
    engine = new InputEngine();
    interaction = makeInteraction();
    session = engine.startEditing(interaction);
  });

  // -----------------------------------------------------------------------
  // Lifecycle: editing -> preview -> commit
  // -----------------------------------------------------------------------

  it("starts in editing phase with empty draft", () => {
    expect(session.phase).toBe("editing");
    expect(session.draft).toBe("");
    expect(session.revision).toBe(0);
    expect(session.preview_text).toBe("");
    expect(session.interaction_id).toBe("int-test-001");
    expect(session.created_at).toBeGreaterThan(0);
  });

  it("updates draft and increments revision", () => {
    const r0 = session.revision;
    engine.updateDraft(session, "Hello there");
    expect(session.draft).toBe("Hello there");
    expect(session.revision).toBe(r0 + 1);

    engine.updateDraft(session, "Hello world");
    expect(session.draft).toBe("Hello world");
    expect(session.revision).toBe(r0 + 2);
  });

  it("transitions editing -> preview on requestPreview", () => {
    engine.updateDraft(session, "I want to go left.");
    const revBefore = session.revision;

    engine.requestPreview(session);

    expect(session.phase).toBe("preview");
    expect(session.preview_text).toBe("I want to go left.");
    expect(session.revision).toBe(revBefore + 1);
    expect(session.previewed_at).toBeGreaterThan(0);
    expect(session.committed_at).toBeUndefined();

    // Draft should still be the same (frozen as preview)
    expect(session.draft).toBe("I want to go left.");
  });

  it("transitions preview -> committed on commit", () => {
    engine.updateDraft(session, "Final answer");
    engine.requestPreview(session);
    const revBefore = session.revision;

    engine.commit(session);

    expect(session.phase).toBe("committed");
    expect(session.revision).toBe(revBefore + 1);
    expect(session.committed_at).toBeGreaterThan(0);
    expect(engine.getCommittedText(session)).toBe("Final answer");
  });

  it("full lifecycle from start to commit", () => {
    engine.updateDraft(session, "A complete thought");
    engine.requestPreview(session);
    engine.commit(session);

    expect(session.phase).toBe("committed");
    expect(engine.getCommittedText(session)).toBe("A complete thought");
  });

  // -----------------------------------------------------------------------
  // Cancel
  // -----------------------------------------------------------------------

  it("cancels from preview back to editing", () => {
    engine.updateDraft(session, "Something to cancel");
    engine.requestPreview(session);
    expect(session.phase).toBe("preview");

    engine.cancel(session);

    expect(session.phase).toBe("editing");
    // Draft should still be available for editing
    expect(session.draft).toBe("Something to cancel");
    // Response events should be cleared
    expect(session.response_events).toBeUndefined();
  });

  it("cancel increments revision", () => {
    engine.updateDraft(session, "Test");
    engine.requestPreview(session);
    const revBefore = session.revision;

    engine.cancel(session);

    expect(session.revision).toBe(revBefore + 1);
  });

  it("can edit after cancel and recommit", () => {
    engine.updateDraft(session, "First attempt");
    engine.requestPreview(session);
    engine.cancel(session);

    // Edit the draft
    engine.updateDraft(session, "Second attempt");
    engine.requestPreview(session);
    engine.commit(session);

    expect(session.phase).toBe("committed");
    expect(engine.getCommittedText(session)).toBe("Second attempt");
  });

  // -----------------------------------------------------------------------
  // getDisplayText
  // -----------------------------------------------------------------------

  it("getDisplayText returns draft in editing phase", () => {
    engine.updateDraft(session, "Current draft");
    expect(engine.getDisplayText(session)).toBe("Current draft");
  });

  it("getDisplayText returns preview_text in preview phase", () => {
    engine.updateDraft(session, "Frozen text");
    engine.requestPreview(session);
    expect(engine.getDisplayText(session)).toBe("Frozen text");
  });

  it("getDisplayText returns draft in editing after cancel", () => {
    engine.updateDraft(session, "After cancel");
    engine.requestPreview(session);
    engine.cancel(session);
    expect(engine.getDisplayText(session)).toBe("After cancel");
  });

  // -----------------------------------------------------------------------
  // Phase guard assertions
  // -----------------------------------------------------------------------

  it("throws when updating draft in preview phase", () => {
    engine.updateDraft(session, "text");
    engine.requestPreview(session);
    expect(() => engine.updateDraft(session, "new text")).toThrow(
      /expected phase "editing"/
    );
  });

  it("throws when requesting preview twice", () => {
    engine.requestPreview(session);
    expect(() => engine.requestPreview(session)).toThrow(
      /expected phase "editing"/
    );
  });

  it("throws when committing from editing", () => {
    expect(() => engine.commit(session)).toThrow(
      /expected phase "preview"/
    );
  });

  it("throws when cancelling from editing", () => {
    expect(() => engine.cancel(session)).toThrow(
      /expected phase "preview"/
    );
  });

  it("throws when getting committed text from non-committed phase", () => {
    expect(() => engine.getCommittedText(session)).toThrow(
      /expected phase "committed"/
    );
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles empty draft commit", () => {
    // Empty draft should be allowed (player might just press Enter)
    engine.requestPreview(session);
    engine.commit(session);
    expect(engine.getCommittedText(session)).toBe("");
  });

  it("handles rapid preview-commit sequence", () => {
    engine.updateDraft(session, "Quick");
    engine.requestPreview(session);
    engine.commit(session);
    expect(session.phase).toBe("committed");
  });

  it("handles rapid preview-cancel-edit-preview-commit", () => {
    engine.updateDraft(session, "Fast1");
    engine.requestPreview(session);
    engine.cancel(session);
    engine.updateDraft(session, "Fast2");
    engine.requestPreview(session);
    engine.commit(session);
    expect(engine.getCommittedText(session)).toBe("Fast2");
  });

  it("starting a new session for same interaction_id replaces old", () => {
    engine.updateDraft(session, "Old session");
    const newSession = engine.startEditing(interaction);
    expect(newSession.draft).toBe("");
    expect(newSession.revision).toBe(0);
  });

  it("revision counter is monotonically increasing", () => {
    const revs: number[] = [];
    revs.push(session.revision);

    engine.updateDraft(session, "a");
    revs.push(session.revision);

    engine.updateDraft(session, "ab");
    revs.push(session.revision);

    engine.requestPreview(session);
    revs.push(session.revision);

    engine.cancel(session);
    revs.push(session.revision);

    engine.updateDraft(session, "abc");
    revs.push(session.revision);

    engine.requestPreview(session);
    revs.push(session.revision);

    engine.commit(session);
    revs.push(session.revision);

    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBeGreaterThan(revs[i - 1]!);
    }
  });

  // -----------------------------------------------------------------------
  // setResponseEvents
  // -----------------------------------------------------------------------

  it("attaches and retrieves response events", () => {
    engine.updateDraft(session, "Hello");
    engine.requestPreview(session);

    const events = [
      {
        type: "dialogue" as const,
        speaker: "NPC",
        text: "Hello to you too!",
        line_id: "line_test_001",
      },
    ];

    engine.setResponseEvents(session, events);
    expect(session.response_events).toEqual(events);
  });

  it("clears response events on cancel", () => {
    engine.updateDraft(session, "Hi");
    engine.requestPreview(session);
    engine.setResponseEvents(session, [
      {
        type: "narration" as const,
        text: "The NPC nods.",
        line_id: "line_test_002",
      },
    ]);
    expect(session.response_events).toBeDefined();

    engine.cancel(session);
    expect(session.response_events).toBeUndefined();
  });
});
