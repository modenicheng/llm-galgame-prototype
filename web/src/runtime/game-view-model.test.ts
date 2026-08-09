/**
 * GameViewModel tests — feed ServerMessages and assert mode/state
 * transitions (design doc §9.2), plus projection restore and history cap.
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@shared/wire/server-message.js";
import type { UiProjection } from "@shared/wire/ui-projection.js";
import {
  GameViewModel,
  MAX_RECENT_LINES,
  interactionModeToFrontendMode,
} from "./game-view-model.js";

function dialogueLine(lineId: string, text: string) {
  return {
    type: "dialogue" as const,
    speaker: "Aoi",
    text,
    line_id: lineId,
  };
}

function playbackReady(sequence: number, lineId: string, text: string): ServerMessage {
  return {
    type: "runtime.output",
    sequence,
    output: { type: "playback_ready", event: dialogueLine(lineId, text) },
  };
}

const choiceInteractionOpened: ServerMessage = {
  type: "runtime.output",
  sequence: 10,
  output: {
    type: "interaction_opened",
    interactionId: "int-1",
    interaction: {
      type: "interaction",
      interaction_id: "int-1",
      prompt: "What now?",
      mode: "choice",
      options: [
        { id: "o1", text: "Go left" },
        { id: "o2", text: "Go right" },
      ],
    },
  },
};

const inputInteractionOpened: ServerMessage = {
  type: "runtime.output",
  sequence: 11,
  output: {
    type: "interaction_opened",
    interactionId: "int-2",
    interaction: {
      type: "interaction",
      interaction_id: "int-2",
      prompt: "Say something",
      mode: "input",
      input: { kind: "free_text", placeholder: "…", max_length: 200 },
    },
  },
};

const hybridInteractionOpened: ServerMessage = {
  type: "runtime.output",
  sequence: 12,
  output: {
    type: "interaction_opened",
    interactionId: "int-3",
    interaction: {
      type: "interaction",
      interaction_id: "int-3",
      prompt: "How to respond?",
      mode: "hybrid",
      options: [
        { id: "o1", text: "Follow her" },
        { id: "o2", text: "Stay" },
      ],
      input: { kind: "free_text", placeholder: "…", max_length: 200 },
    },
  },
};

const fullStatus = {
  phase: "running",
  message: "ok",
  bufferedEvents: 2,
  bufferedDialogueLines: 1,
  jobs: {},
  branches: {},
  media: {
    enabled: true,
    provider: "mock",
    currentLineId: null,
    readyAhead: 0,
    queued: 0,
    generating: 0,
    targetAhead: 0,
    refillThreshold: 0,
    branchReady: 0,
    note: "",
  },
};

describe("GameViewModel", () => {
  it("starts in BOOTSTRAP with empty history", () => {
    const vm = new GameViewModel();
    const state = vm.state();
    expect(state.mode).toBe("BOOTSTRAP");
    expect(state.recentLines).toEqual([]);
  });

  it("enters PLAYING on playback_ready and tracks the current line", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(playbackReady(1, "line_1", "Hello."));
    const state = vm.state();
    expect(state.mode).toBe("PLAYING");
    expect(state.currentLine?.line_id).toBe("line_1");
    expect(state.currentLine?.text).toBe("Hello.");
    expect(state.recentLines).toHaveLength(1);
  });

  it("enters CHOICE_SELECTING for choice interactions and INPUT_EDITING for input interactions", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(playbackReady(1, "line_1", "What do you do?"));
    vm.applyServerMessage(choiceInteractionOpened);
    let state = vm.state();
    expect(state.mode).toBe("CHOICE_SELECTING");
    expect(state.currentInteraction).toBeDefined();
    expect(state.currentLine?.line_id).toBe("line_1");

    vm.applyServerMessage(inputInteractionOpened);
    state = vm.state();
    expect(state.mode).toBe("INPUT_EDITING");
  });

  it("enters HYBRID_SELECTING for hybrid interactions", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(hybridInteractionOpened);
    const state = vm.state();
    expect(state.mode).toBe("HYBRID_SELECTING");
    expect(state.currentInteraction).toBeDefined();
  });

  it("returns to HYBRID_SELECTING after a hybrid preview cancel", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(hybridInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 13,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "draft" },
    });
    expect(vm.state().mode).toBe("INPUT_PREVIEW");

    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 14,
      output: { type: "input_preview_canceled", previewId: "pv-1" },
    });
    const state = vm.state();
    expect(state.mode).toBe("HYBRID_SELECTING");
    expect(state.currentPreview).toBeUndefined();
    // The original interaction survives the preview round-trip.
    expect(state.currentInteraction).toBeDefined();
  });

  it("normalizes a synthetic choice interaction with the top-level interactionId", () => {
    const vm = new GameViewModel();
    const syntheticChoiceOpened: ServerMessage = {
      type: "runtime.output",
      sequence: 12,
      output: {
        type: "interaction_opened",
        interactionId: "choice_2",
        // The Game converts mode:choice interactions into a synthetic
        // `choice` event with NO interaction_id (src/game.ts handleChoice).
        interaction: {
          type: "choice",
          prompt: "What now?",
          options: [
            { id: "o1", text: "Go left" },
            { id: "o2", text: "Go right" },
          ],
        },
      },
    };

    vm.applyServerMessage(syntheticChoiceOpened);
    const interaction = vm.state().currentInteraction as {
      type: string;
      interaction_id?: string;
      options: Array<{ id: string }>;
    };
    expect(interaction.interaction_id).toBe("choice_2"); // stamped from top-level id
    expect(interaction.type).toBe("choice");
    expect(interaction.options).toHaveLength(2);

    // The interaction (and its id) clears once the line plays.
    vm.applyServerMessage(playbackReady(13, "line_5", "Next."));
    expect(vm.state().currentInteraction).toBeUndefined();
  });

  it("restores a normalized interaction from a projection after reconnect", () => {
    const vm = new GameViewModel();
    // The store normalizes on interaction_opened, so a reconnecting browser
    // receives a currentInteraction that already carries interaction_id.
    vm.applyProjection({
      phase: "running",
      recentLines: [],
      // The store stamps interaction_id onto synthetic choices; mirror that
      // shape here (the union cast mirrors the store's own cast).
      currentInteraction: {
        type: "choice",
        interaction_id: "choice_2",
        prompt: "What now?",
        options: [
          { id: "o1", text: "Go left" },
          { id: "o2", text: "Go right" },
        ],
      } as NonNullable<UiProjection["currentInteraction"]>,
    });
    const interaction = vm.state().currentInteraction as { interaction_id?: string };
    expect(interaction.interaction_id).toBe("choice_2");
  });

  it("enters INPUT_PREVIEW on input_preview_opened", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 5,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "typed draft" },
    });
    const state = vm.state();
    expect(state.mode).toBe("INPUT_PREVIEW");
    expect(state.currentPreview).toEqual({ previewId: "pv-1", text: "typed draft" });
  });

  it("returns to INPUT_EDITING on cancel and waits on commit", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(inputInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 12,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "draft" },
    });
    expect(vm.state().mode).toBe("INPUT_PREVIEW");

    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 13,
      output: { type: "input_preview_canceled", previewId: "pv-1" },
    });
    expect(vm.state().mode).toBe("INPUT_EDITING");
    expect(vm.state().currentPreview).toBeUndefined();

    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 14,
      output: { type: "input_committed", previewId: "pv-1" },
    });
    expect(vm.state().mode).toBe("CONTENT_WAITING");
  });

  it("enters CONTENT_WAITING on interaction_resolved and drops the form", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(choiceInteractionOpened);
    expect(vm.state().mode).toBe("CHOICE_SELECTING");
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 11,
      output: { type: "interaction_resolved", interactionId: "int-1", resolution: "choice" },
    });
    const state = vm.state();
    expect(state.mode).toBe("CONTENT_WAITING");
    expect(state.currentInteraction).toBeUndefined();
  });

  it("keeps INPUT_PREVIEW until input_committed after interaction_resolved", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(inputInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 12,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "draft" },
    });
    // The Game emits interaction_resolved before input_committed; the form
    // must not flip to CONTENT_WAITING behind an open preview mid-flight.
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 13,
      output: { type: "interaction_resolved", interactionId: "int-2", resolution: "input" },
    });
    expect(vm.state().mode).toBe("INPUT_PREVIEW");
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 14,
      output: { type: "input_committed", previewId: "pv-1" },
    });
    expect(vm.state().mode).toBe("CONTENT_WAITING");
    expect(vm.state().currentInteraction).toBeUndefined();
  });

  it("enters ENDING on session_ended and ERROR on runtime_error", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 20,
      output: { type: "session_ended", ending: { type: "end", ending_id: "e1", text: "Fin." } },
    });
    let state = vm.state();
    expect(state.mode).toBe("ENDING");
    expect(state.ending).toEqual({ type: "end", ending_id: "e1", text: "Fin." });
    expect(state.currentLine).toBeUndefined();

    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 21,
      output: { type: "runtime_error", code: "GENERATION_FAILED", message: "timeout" },
    });
    state = vm.state();
    expect(state.mode).toBe("ERROR");
    expect(state.lastError).toBe("GENERATION_FAILED: timeout");
  });

  it("tracks session id and status", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 1,
      output: { type: "session_started", sessionId: "sess-1", location: "/tmp/sess-1.jsonl" },
    });
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 2,
      output: { type: "status_changed", status: fullStatus },
    });
    const state = vm.state();
    expect(state.sessionId).toBe("sess-1");
    expect(state.status).toEqual(fullStatus);
  });

  it("restores full state from a projection after reconnect", () => {
    const vm = new GameViewModel();
    const projection: UiProjection = {
      sessionId: "sess-9",
      phase: "running",
      currentLine: dialogueLine("line_3", "Restored."),
      currentInteraction: {
        type: "interaction",
        interaction_id: "int-1",
        prompt: "What now?",
        mode: "choice",
        options: [
          { id: "o1", text: "Go left" },
          { id: "o2", text: "Go right" },
        ],
      },
      currentPreview: { previewId: "pv-1", text: "draft" },
      recentLines: [
        dialogueLine("line_1", "One"),
        dialogueLine("line_2", "Two"),
        dialogueLine("line_3", "Restored."),
      ],
      status: fullStatus,
      ending: { type: "end", ending_id: "e1", text: "Fin." },
    };
    vm.applyProjection(projection);

    const state = vm.state();
    expect(state.mode).toBe("INPUT_PREVIEW"); // preview wins over interaction/line
    expect(state.sessionId).toBe("sess-9");
    expect(state.currentLine?.line_id).toBe("line_3");
    expect(state.currentInteraction).toBeDefined();
    expect(state.currentPreview).toEqual({ previewId: "pv-1", text: "draft" });
    expect(state.recentLines).toHaveLength(3);
    expect(state.status).toEqual(fullStatus);
    expect(state.ending).toEqual({ type: "end", ending_id: "e1", text: "Fin." });
  });

  it("derives mode from projection when no preview is active", () => {
    const vm = new GameViewModel();
    vm.applyProjection({ phase: "idle", recentLines: [] });
    expect(vm.state().mode).toBe("BOOTSTRAP");

    vm.applyProjection({
      phase: "running",
      recentLines: [],
      currentInteraction: {
        type: "interaction",
        interaction_id: "int-2",
        prompt: "Say something",
        mode: "input",
        input: { kind: "free_text", placeholder: "…", max_length: 200 },
        },
    });
    expect(vm.state().mode).toBe("INPUT_EDITING");

    vm.applyProjection({
      phase: "running",
      recentLines: [],
      currentInteraction: {
        type: "interaction",
        interaction_id: "int-3",
        prompt: "How to respond?",
        mode: "hybrid",
        options: [
          { id: "o1", text: "Follow her" },
          { id: "o2", text: "Stay" },
        ],
        input: { kind: "free_text", placeholder: "…", max_length: 200 },
        },
    });
    expect(vm.state().mode).toBe("HYBRID_SELECTING");

    vm.applyProjection({ phase: "ended", recentLines: [] });
    expect(vm.state().mode).toBe("ENDING");

    vm.applyProjection({ phase: "error", recentLines: [] });
    expect(vm.state().mode).toBe("ERROR");
  });

  it("reconnect after a resolved hybrid restores CONTENT_WAITING, never the form (§9.6)", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(hybridInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 13,
      output: { type: "interaction_resolved", interactionId: "int-3", resolution: "choice" },
    });
    expect(vm.state().mode).toBe("CONTENT_WAITING");

    // The browser drops before the next playback_ready and reconnects: the
    // server projection no longer carries the resolved interaction, so the
    // page must restore CONTENT_WAITING with no form.
    vm.applyProjection({ phase: "running", recentLines: [] });
    const state = vm.state();
    expect(state.mode).toBe("CONTENT_WAITING");
    expect(state.currentInteraction).toBeUndefined();
    expect(state.currentPreview).toBeUndefined();
  });

  it("reconnect during an open input preview restores INPUT_PREVIEW (§9.6)", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(inputInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 12,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "typed draft" },
    });
    expect(vm.state().mode).toBe("INPUT_PREVIEW");

    // Reconnect: the store projection keeps both the open interaction and
    // the preview, so the editor reopens with the draft intact.
    vm.applyProjection({
      phase: "running",
      recentLines: [],
      currentInteraction: {
        type: "interaction",
        interaction_id: "int-2",
        prompt: "Say something",
        mode: "input",
        input: { kind: "free_text", placeholder: "…", max_length: 200 },
        },
      currentPreview: { previewId: "pv-1", text: "typed draft" },
    });
    const state = vm.state();
    expect(state.mode).toBe("INPUT_PREVIEW");
    expect(state.currentPreview).toEqual({ previewId: "pv-1", text: "typed draft" });
    expect(state.currentInteraction).toBeDefined();
  });

  it("reconnect after a confirmed input restores no form (§9.6)", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage(inputInteractionOpened);
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 12,
      output: { type: "input_preview_opened", previewId: "pv-1", text: "draft" },
    });
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 13,
      output: { type: "interaction_resolved", interactionId: "int-2", resolution: "input" },
    });
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 14,
      output: { type: "input_committed", previewId: "pv-1" },
    });
    expect(vm.state().mode).toBe("CONTENT_WAITING");

    // Reconnect: neither the interaction nor the old input box is restored.
    vm.applyProjection({ phase: "running", recentLines: [] });
    const state = vm.state();
    expect(state.mode).toBe("CONTENT_WAITING");
    expect(state.currentInteraction).toBeUndefined();
    expect(state.currentPreview).toBeUndefined();
  });

  it("caps recentLines at 8, keeping the newest", () => {
    const vm = new GameViewModel();
    for (let i = 1; i <= 10; i++) {
      vm.applyServerMessage(playbackReady(i, `line_${i}`, `Text ${i}`));
    }
    const state = vm.state();
    expect(state.recentLines).toHaveLength(MAX_RECENT_LINES);
    expect(state.recentLines[0]?.line_id).toBe("line_3");
    expect(state.recentLines[7]?.line_id).toBe("line_10");
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const vm = new GameViewModel();
    const seen: number[] = [];
    const off = vm.subscribe((s) => seen.push(s.recentLines.length));
    vm.applyServerMessage(playbackReady(1, "line_1", "One"));
    vm.applyServerMessage(playbackReady(2, "line_2", "Two"));
    expect(seen).toEqual([1, 2]);

    off();
    vm.applyServerMessage(playbackReady(3, "line_3", "Three"));
    expect(seen).toEqual([1, 2]);
  });
});

describe("GameViewModel stage visual state (§86)", () => {
  const visualState = {
    background: "rainy_street",
    bgm: "rain_loop",
    characters: {
      aoi: {
        spriteSet: "aoi",
        variant: "normal",
        position: "left",
        displayName: "青",
        visible: true,
      },
    },
  } as const;

  it("mirrors presentation.visualState from playback_ready", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 1,
      output: {
        type: "playback_ready",
        event: dialogueLine("line_1", "Hello."),
        presentation: { cues: [], visualState },
      },
    });
    const state = vm.state();
    expect(state.mode).toBe("PLAYING");
    expect(state.visualState).toEqual(visualState);
  });

  it("mirrors presentation.visualState from interaction_opened", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 2,
      output: {
        type: "interaction_opened",
        interactionId: "int-1",
        interaction: {
          type: "choice",
          prompt: "What now?",
          options: [{ id: "o1", text: "Go left" }],
        },
        presentation: { cues: [], visualState },
      },
    });
    expect(vm.state().visualState).toEqual(visualState);
    expect(vm.state().mode).toBe("CHOICE_SELECTING");
  });

  it("stage_beat_ready updates visualState without changing mode", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 1,
      output: { type: "playback_ready", event: dialogueLine("line_1", "Hello.") },
    });
    expect(vm.state().mode).toBe("PLAYING");

    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 2,
      output: {
        type: "stage_beat_ready",
        presentation: { cues: [], visualState: { ...visualState, bgm: "silence" } },
      },
    });
    const state = vm.state();
    expect(state.visualState?.bgm).toBe("silence");
    // A beat does not change the frontend mode.
    expect(state.mode).toBe("PLAYING");
  });

  it("restores visualState from a projection snapshot", () => {
    const vm = new GameViewModel();
    vm.applyProjection({
      phase: "running",
      recentLines: [],
      visualState,
    });
    expect(vm.state().visualState).toEqual(visualState);
    expect(vm.state().mode).toBe("CONTENT_WAITING");
  });

  it("presentation.cues 被暂存，consumeCues 一次性取走", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 1,
      output: {
        type: "playback_ready",
        event: dialogueLine("line_1", "…"),
        presentation: {
          visualState,
          cues: [
            { type: "sound_effect", assetId: "beep" },
            { type: "background", assetId: "basement" },
          ],
        },
      },
    });
    const cues = vm.consumeCues();
    expect(cues).toHaveLength(2);
    expect(vm.consumeCues()).toHaveLength(0); // 二次为空
  });

  it("重连投影恢复时 cues 被清空（不重放）", () => {
    const vm = new GameViewModel();
    vm.applyServerMessage({
      type: "runtime.output",
      sequence: 2,
      output: {
        type: "playback_ready",
        event: dialogueLine("line_1", "…"),
        presentation: {
          visualState,
          cues: [{ type: "sound_effect", assetId: "beep" }],
        },
      },
    });
    // Reconnect restores authoritative visualState; the one-shot cues must
    // not be replayed (spec §6.4).
    vm.applyProjection({ phase: "running", recentLines: [], visualState });
    expect(vm.consumeCues()).toHaveLength(0);
  });

  it("presentation 缺 cues 字段（undefined）不抛错，无 cue 暂存", () => {
    const vm = new GameViewModel();
    expect(() =>
      vm.applyServerMessage({
        type: "runtime.output",
        sequence: 3,
        output: {
          type: "playback_ready",
          event: dialogueLine("line_1", "…"),
          presentation: { cues: undefined as unknown as never[], visualState },
        },
      }),
    ).not.toThrow();
    expect(vm.consumeCues()).toHaveLength(0);
  });
});

describe("interactionModeToFrontendMode", () => {
  it("maps each interaction mode to its frontend mode", () => {
    expect(
      interactionModeToFrontendMode({ type: "interaction", mode: "choice" }),
    ).toBe("CHOICE_SELECTING");
    expect(
      interactionModeToFrontendMode({ type: "interaction", mode: "hybrid" }),
    ).toBe("HYBRID_SELECTING");
    expect(
      interactionModeToFrontendMode({ type: "interaction", mode: "input" }),
    ).toBe("INPUT_EDITING");
  });

  it("maps a legacy choice event to CHOICE_SELECTING", () => {
    expect(
      interactionModeToFrontendMode({ type: "choice", prompt: "?", options: [] }),
    ).toBe("CHOICE_SELECTING");
  });

  it("returns ERROR for unknown or malformed interactions", () => {
    expect(interactionModeToFrontendMode(undefined)).toBe("ERROR");
    expect(interactionModeToFrontendMode({ type: "interaction", mode: "bogus" })).toBe(
      "ERROR",
    );
    expect(interactionModeToFrontendMode({ type: "end" })).toBe("ERROR");
  });
});
