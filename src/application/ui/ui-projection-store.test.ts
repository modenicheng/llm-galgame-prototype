/**
 * UiProjectionStore tests — the server-side projection is maintained
 * purely from RuntimeOutput events (§7.7 / plan §14.6).
 */
import { describe, expect, it } from "vitest";
import type {
  RuntimeInteractionEvent,
  RuntimeOutput,
} from "../../core/runtime/runtime-output.js";
import type { RuntimePlayableEvent } from "../../schema.js";
import { UiProjectionStoreImpl } from "./ui-projection-store.js";

const choiceInteraction: RuntimeInteractionEvent = {
  type: "choice",
  prompt: "怎么做？",
  options: [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
};

const line: RuntimePlayableEvent = { type: "narration", text: "继续。", line_id: "line_1" };
function opened(interactionId = "int_1"): RuntimeOutput {
  return { type: "interaction_opened", interactionId, interaction: choiceInteraction };
}

function resolved(
  interactionId: string,
  resolution: "choice" | "input" = "choice",
): RuntimeOutput {
  return { type: "interaction_resolved", interactionId, resolution };
}

function previewOpened(previewId = "pv_1"): RuntimeOutput {
  return { type: "input_preview_opened", previewId, text: "你好" };
}

describe("UiProjectionStore", () => {
  it("keeps the open interaction in currentInteraction on interaction_opened", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened());
    const snapshot = store.snapshot();
    expect(snapshot.currentInteraction).toBeDefined();
    // The top-level interactionId is stamped as the authoritative id so a
    // reconnecting browser can address the interaction.
    expect(snapshot.currentInteraction).toMatchObject({ interaction_id: "int_1" });
  });

  it("clears currentInteraction on interaction_resolved for the matching id", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(resolved("int_1"));
    expect(store.snapshot().currentInteraction).toBeUndefined();
  });

  it("keeps currentInteraction when interaction_resolved targets another id", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(resolved("int_other"));
    expect(store.snapshot().currentInteraction).toBeDefined();
  });

  it("keeps the preview on input_preview_opened without clearing the interaction", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(previewOpened("pv_1"));
    const snapshot = store.snapshot();
    expect(snapshot.currentPreview).toEqual({ previewId: "pv_1", text: "你好" });
    expect(snapshot.currentInteraction).toBeDefined();
  });

  it("clears the preview but keeps the interaction on input_preview_canceled", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(previewOpened("pv_1"));
    store.applyOutput({ type: "input_preview_canceled", previewId: "pv_1" });
    const snapshot = store.snapshot();
    expect(snapshot.currentPreview).toBeUndefined();
    expect(snapshot.currentInteraction).toBeDefined();
  });

  it("clears the preview on input_committed", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(previewOpened("pv_1"));
    store.applyOutput({ type: "input_committed", previewId: "pv_1" });
    expect(store.snapshot().currentPreview).toBeUndefined();
  });

  it("defensively clears interaction and preview on playback_ready", () => {
    const store = new UiProjectionStoreImpl();
    store.applyOutput(opened("int_1"));
    store.applyOutput(previewOpened("pv_1"));
    store.applyOutput({ type: "playback_ready", event: line });
    const snapshot = store.snapshot();
    expect(snapshot.currentInteraction).toBeUndefined();
    expect(snapshot.currentPreview).toBeUndefined();
    expect(snapshot.currentLine).toEqual(line);
  });
});
