/**
 * Tests for the GenerationHandle compatibility wrapper and the
 * StoryGeneratorPort contract.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createGenerationHandle,
  type StoryGeneratorPort,
} from "./story-generator-port.js";
import type { EventGroupDraft } from "../protocol/gal-dsl/types.js";
import {
  GeneratorPortFacade,
  type StoryGenerator,
} from "../../adapters/llm/openai-compatible-generator.js";
import type { NarrativeBrief } from "../narrative/narrative-brief.js";
import type { StoryState } from "../../story/types.js";
import type { InteractionEvent } from "../../schema.js";

function narrationGroup(text: string): EventGroupDraft {
  return { prelude: [], main: { type: "narration", text } };
}

describe("createGenerationHandle", () => {
  it("publishes events as they arrive and resolves done with the envelope", async () => {
    const handle = createGenerationHandle("g1", async (_signal, onGroup) => {
      onGroup(narrationGroup("one"));
      onGroup(narrationGroup("two"));
      return { events: [], state_patch: {}, groups: [narrationGroup("one"), narrationGroup("two")] };
    });

    const seen: EventGroupDraft[] = [];
    for await (const event of handle.events) seen.push(event);

    expect(seen.map((e) => (e as { main: { text: string } }).main.text)).toEqual(["one", "two"]);
    const result = await handle.done;
    expect(result.groups).toHaveLength(2);
    expect(handle.id).toBe("g1");
  });

  it("yields events that arrive asynchronously after handle creation", async () => {
    const handle = createGenerationHandle("g3", async (_signal, onGroup) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      onGroup(narrationGroup("late"));
      return { events: [], state_patch: {} };
    });

    const seen: EventGroupDraft[] = [];
    for await (const event of handle.events) seen.push(event);

    expect(seen.map((e) => (e as { main: { text: string } }).main.text)).toEqual(["late"]);
  });

  it("closes the stream when the runner completes without events", async () => {
    const handle = createGenerationHandle("g4", async () => ({
      events: [],
      state_patch: {},
    }));

    const seen: EventGroupDraft[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(seen).toEqual([]);
    await expect(handle.done).resolves.toBeDefined();
  });

  it("cancel aborts the underlying runner", async () => {
    let aborted = false;
    const handle = createGenerationHandle("g2", (signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    handle.cancel("player changed their mind");
    await expect(handle.done).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("done rejects when the runner fails without cancellation", async () => {
    const handle = createGenerationHandle("g5", async () => {
      throw new Error("stream broken");
    });

    await expect(handle.done).rejects.toThrow("stream broken");
  });
});

describe("StoryGeneratorPort contract", () => {
  it("should expose the five handle-based generation methods", () => {
    // Compile-only check: the port shape must stay stable.
    const port: StoryGeneratorPort = {
      generateOpening: () => makeHandle("opening"),
      generateContinuation: () => makeHandle("continuation"),
      generateBranchPrefetch: () => makeHandle("branch"),
      generateInputResponse: () => makeHandle("input"),
      generateInputBridge: () => makeHandle("bridge"),
    };
    expect(port.generateOpening).toBeInstanceOf(Function);
    expect(port.generateContinuation).toBeInstanceOf(Function);
    expect(port.generateBranchPrefetch).toBeInstanceOf(Function);
    expect(port.generateInputResponse).toBeInstanceOf(Function);
    expect(port.generateInputBridge).toBeInstanceOf(Function);
  });
});

function makeHandle(id: string) {
  return createGenerationHandle(id, async () => ({ events: [], state_patch: {} }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrief(): NarrativeBrief {
  return {
    revision: 3,
    consolidatedThroughEventSeq: 120,
    currentEventSeq: 135,
    checkpointCount: 2,
    location: "旧图书馆",
    characters: ["苏遥"],
    activeThreads: [],
    setupDirectives: [],
    relevantEpisodes: [],
    anchors: [],
    revealLocks: [],
  };
}

function makeState(): StoryState {
  return {
    scene: { id: "scene-1", location: "教室", purpose: "日常" },
    canon: {},
    characters: {},
    open_threads: [],
    recent_summary: "",
    player_profile: { recent_tendencies: [] },
  };
}

function makeInteraction(): InteractionEvent {
  return {
    type: "interaction",
    interaction_id: "int_1",
    prompt: "What do you say?",
    mode: "input",
    input: { kind: "free_text", placeholder: "Type your response...", max_length: 200 },
  };
}

// ---------------------------------------------------------------------------
// GeneratorPortFacade
// ---------------------------------------------------------------------------

describe("GeneratorPortFacade", () => {
  it("forwards tailVisualState/repairReason/brief and exposes input bridge", async () => {
    const inner = {
      generateOpening: vi.fn(async () => ({ events: [], state_patch: {} })),
      generateContinuation: vi.fn(async () => ({ events: [], state_patch: {} })),
      generateBranchPrefetch: vi.fn(async () => ({ events: [], state_patch: {} })),
      generateInputResponse: vi.fn(async () => ({ events: [], state_patch: {} })),
      generateInputBridge: vi.fn(async () => ({ events: [], state_patch: {} })),
    };
    const facade = new GeneratorPortFacade(inner as unknown as StoryGenerator);
    const brief = makeBrief();
    facade.generateContinuation({
      turn: 2,
      state: makeState(),
      history: [],
      prefetchedEvents: [],
      repairReason: "修复原因",
      tailVisualState: { background: "clubroom", characters: {} },
      brief,
    });
    expect(inner.generateContinuation).toHaveBeenCalledWith(
      2, expect.anything(), [], [], expect.anything(), expect.objectContaining({
        repairReason: "修复原因",
        tailVisualState: { background: "clubroom", characters: {} },
        brief,
      }),
    );
    const bridge = facade.generateInputBridge({
      turn: 3,
      state: makeState(),
      interaction: makeInteraction(),
    });
    expect(bridge.id).toBe("bridge:int_1");
    expect(inner.generateInputBridge).toHaveBeenCalled();
  });
});
