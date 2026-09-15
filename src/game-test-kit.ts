/**
 * Shared fixtures and helpers for the Game test suite (game*.test.ts).
 * Extracted from game.test.ts so the suite can split along subsystem
 * seams; import from here instead of redefining per file.
 */
import { vi } from "vitest";
import {
  makeTestConfig,
  makeTestPorts,
} from "./test-helpers.js";

import type { StoryGeneratorPort } from "./core/ports/story-generator-port.js";
import { createGenerationHandle } from "./core/ports/story-generator-port.js";
import type {
  GenerationHandle,
  InputResponseRequest,
} from "./core/ports/story-generator-port.js";
import type { MediaPlannerPort } from "./core/ports/media-planner-port.js";
import type { RuntimeStatus } from "./runtime/status.js";
import type { AppConfig } from "./config.js";
import type {
  NarrationDraftEvent,
  EndEvent,
  StoredEvent,
  InteractionEvent,
} from "./schema.js";
import type { RuntimeCommand } from "./core/runtime/runtime-command.js";
import type { GenerationEnvelope } from "./story/types.js";
import type { EventGroupDraft } from "./core/protocol/gal-dsl/types.js";

import type { NarrativeDirectorPort } from "./core/ports/narrative-director-port.js";
import { EMPTY_MEMORY_DIGEST } from "./core/graph/memory-digest.js";
import type { MemoryDigest } from "./core/graph/types.js";
import type {
  NarrativeBrief,
  NarrativeBriefRequest,
} from "./core/narrative/narrative-brief.js";
import type { GamePorts } from "./game.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Game core tests exercise repair / policy / command-scoping contracts; the
 * §73–§76 low-water scheduler is out of scope here, so it is disabled via
 * config: start_threshold 1 → no first-line hold; refill_threshold -1 →
 * the invariant `ahead > threshold` always holds, so no refill ever starts.
 * game-dsl.test.ts covers the scheduler with real thresholds.
 */
export function makeGameConfig(overrides?: Parameters<typeof makeTestConfig>[0]): AppConfig {
  return makeTestConfig({
    text_buffer: { start_threshold_lines: 1, target_lines: 6, refill_threshold_lines: -1 },
    ...overrides,
  });
}

export function makeMockGenerator(): StoryGeneratorPort {
  return {
    generateOpening: vi.fn(),
    // Default: an empty branch (candidates resolve with no events). Hybrid
    // free-text tests never set this; the prefetch group still starts.
    generateBranchPrefetch: vi.fn(() =>
      createGenerationHandle("branch", async () => ({ events: [], state_patch: {}, groups: [] })),
    ),
    generateInputResponse: vi.fn(),
    generateContinuation: vi.fn(),
    // Default bridge: one narration line (docs §34). Tests that expect a
    // different bridge text override this per-test.
    generateInputBridge: vi.fn(() =>
      handleFromDrafts("bridge", [narrationEvent("她等着你开口。")]),
    ),
  } as unknown as StoryGeneratorPort;
}

export function makeMockMedia(): MediaPlannerPort {
  return {
    registerActive: vi.fn(),
    registerCandidate: vi.fn(),
    activateCandidate: vi.fn(),
    discardCandidate: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    markPresented: vi.fn(),
  } as unknown as MediaPlannerPort;
}

export function makeMockStatus(): RuntimeStatus {
  return {
    setPhase: vi.fn(),
    setJob: vi.fn(),
    removeJob: vi.fn(),
    setBuffer: vi.fn(),
    setBranch: vi.fn(),
    clearBranches: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    snapshot: vi.fn().mockReturnValue({ branches: {} }),
  } as unknown as RuntimeStatus;
}

export type EnvelopeDraft =
  | { type: "narration"; text: string }
  | { type: "dialogue"; speaker: string; text: string }
  | { type: "choice"; prompt: string; options: Array<{ id: string; text: string }> }
  | InteractionEvent
  | EndEvent;

/** Convert one draft event into a DSL EventGroupDraft (end → sentinel). */
export function groupFromEvent(draft: EnvelopeDraft): EventGroupDraft {
  if (draft.type === "narration") {
    return { prelude: [], main: { type: "narration", text: draft.text } };
  }
  if (draft.type === "dialogue") {
    return {
      prelude: [],
      main: {
        type: "dialogue",
        speaker: draft.speaker,
        text: draft.text,
        visual: { hasVisual: false, resetVisual: false },
        name: { hasName: false, resetName: false },
      },
    };
  }
  if (draft.type === "choice") {
    return {
      prelude: [],
      main: {
        type: "interaction",
        interaction: {
          prompt: draft.prompt,
          mode: "choice",
          optionTexts: draft.options.map((o) => o.text),
        },
      },
    };
  }
  if (draft.type !== "interaction") {
    throw new Error("end 事件不是组：请用段结束哨兵表达结局。");
  }
  const interaction: InteractionEvent = draft;
  const draftInteraction: {
    prompt: string;
    mode: InteractionEvent["mode"];
    optionTexts: string[];
    inputPlaceholder?: string;
  } = {
    prompt: interaction.prompt,
    mode: interaction.mode,
    optionTexts:
      interaction.mode === "input"
        ? []
        : interaction.options.map((o) => o.text),
  };
  if (interaction.mode !== "choice") {
    draftInteraction.inputPlaceholder = interaction.input.placeholder;
  }
  return {
    prelude: [],
    main: { type: "interaction", interaction: draftInteraction },
  };
}

/**
 * Build a minimal GenerationEnvelope for the mock generator. DSL protocol:
 * the envelope carries committed groups plus the segment-end status; draft
 * events are converted into DSL groups, a trailing `end` event maps to the
 * `@end ... ending` sentinel.
 */
export function envelope(
  drafts: EnvelopeDraft[],
  state_patch: GenerationEnvelope["state_patch"] = {},
): GenerationEnvelope {
  let reason: "buffer" | "interaction" | "ending" = "buffer";
  const groups: EventGroupDraft[] = [];
  for (const draft of drafts) {
    if (draft.type === "end") {
      reason = "ending";
      continue;
    }
    if (draft.type === "interaction") reason = "interaction";
    groups.push(groupFromEvent(draft));
  }
  return {
    events: [],
    state_patch,
    groups,
    segmentEnd: { kind: "complete", nonce: "0000", reason },
  };
}

/**
 * Port-shaped mock handle: the drafts stream through `onGroup` (so they
 * arrive on `handle.events` exactly like the real generator's DSL stream)
 * and the envelope carries the segment-end status. `end` drafts map to the
 * `@end ... ending` sentinel in the envelope, never to a group.
 */
export function handleFromDrafts(
  id: string,
  drafts: EnvelopeDraft[],
  state_patch: GenerationEnvelope["state_patch"] = {},
): GenerationHandle {
  return createGenerationHandle(id, async (_signal, onGroup) => {
    for (const draft of drafts) {
      if (draft.type === "end") continue;
      onGroup(groupFromEvent(draft));
    }
    return envelope(drafts, state_patch);
  });
}

export function narrationEvent(text = "Some narration."): NarrationDraftEvent {
  return { type: "narration", text };
}

export function endEvent(endingId = "end_1", text = "The end."): EndEvent {
  return { type: "end", ending_id: endingId, text };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function makeManualInputResponse(
  generator: StoryGeneratorPort,
  run: (
    signal: AbortSignal,
    onGroup: (draft: EventGroupDraft) => void,
  ) => Promise<GenerationEnvelope>,
): void {
  (generator.generateInputResponse as ReturnType<typeof vi.fn>).mockImplementation(
    (request: InputResponseRequest) =>
      createGenerationHandle("input", (signal, onGroup) => run(signal, onGroup)),
  );
}

export function inputInteractionFixture() {
  return {
    type: "interaction" as const,
    interaction_id: "interaction_1",
    prompt: "说什么？",
    mode: "input" as const,
    input: { kind: "free_text" as const, placeholder: "...", max_length: 200 },
  };
}

export function choiceFixture(
  options = [
    { id: "a", text: "选项A" },
    { id: "b", text: "选项B" },
  ],
) {
  return { type: "choice" as const, prompt: "怎么选？", options };
}

export function hybridFixture(interactionId = "interaction_1", bridgeText = "她等着你的决定。") {
  return {
    type: "interaction" as const,
    interaction_id: interactionId,
    prompt: "怎么做？",
    mode: "hybrid" as const,
    options: [
      { id: "a", text: "选项A" },
      { id: "b", text: "选项B" },
    ],
    input: { kind: "free_text" as const, placeholder: "...", max_length: 200 },
    input_bridge: { events: [{ type: "narration" as const, text: bridgeText }] },
  };
}

/**
 * Test-only window into Game internals used by the scoping assertions.
 * Private fields are erased at runtime, so the shape is structural — the
 * unchecked cast documents exactly which internals the tests rely on.
 */
export interface GameScopingInternals {
  events: StoredEvent[];
  deferredCommands: RuntimeCommand[];
  activeInteractionId: string | null;
  activePreviewId: string | null;
}

export type DirectorCall =
  | { type: "observeCommitted"; events: readonly StoredEvent[] }
  | { type: "checkpoint"; reason: string }
  | { type: "getBrief"; request: NarrativeBriefRequest }
  | { type: "flush" };

export function makeDirectorFake(
  briefOverrides?: Partial<NarrativeBrief>,
): NarrativeDirectorPort & { calls: DirectorCall[]; restoredWith: MemoryDigest[] } {
  const calls: DirectorCall[] = [];
  const restoredWith: MemoryDigest[] = [];
  const baseBrief: NarrativeBrief = {
    revision: 0,
    consolidatedThroughEventSeq: 0,
    currentEventSeq: 0,
    checkpointCount: 0,
    location: "",
    characters: [],
    activeThreads: [],
    setupDirectives: [],
    relevantEpisodes: [],
    anchors: [],
    revealLocks: [],
    ...briefOverrides,
  };
  return {
    calls,
    restoredWith,
    getBrief(request: NarrativeBriefRequest): NarrativeBrief {
      calls.push({ type: "getBrief", request });
      return {
        ...baseBrief,
        currentEventSeq: request.eventSeq,
        location: request.location,
        characters: request.characters,
      };
    },
    observeCommitted(events: readonly StoredEvent[]): void {
      calls.push({ type: "observeCommitted", events: [...events] });
    },
    getMemoryDigest() {
      return EMPTY_MEMORY_DIGEST;
    },
    restoreFromDigest(digest: MemoryDigest): void {
      // 恢复路径（M1.4）：记录重建所用的记忆摘要。
      restoredWith.push(digest);
    },
    checkpoint(reason: string): void {
      calls.push({ type: "checkpoint", reason });
    },
    async flush(): Promise<void> {
      calls.push({ type: "flush" });
    },
  };
}

export function makePortsWithDirector(
  director: NarrativeDirectorPort,
): GamePorts {
  const base = makeTestPorts();
  return { ...base, narrativeDirector: director };
}
