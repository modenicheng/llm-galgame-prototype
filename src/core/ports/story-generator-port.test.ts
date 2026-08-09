/**
 * Tests for the GenerationHandle compatibility wrapper and the
 * StoryGeneratorPort contract.
 */
import { describe, it, expect } from "vitest";
import {
  createGenerationHandle,
  type StoryGeneratorPort,
} from "./story-generator-port.js";
import type { EventGroupDraft } from "../protocol/gal-dsl/types.js";

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
  it("should expose the four handle-based generation methods", () => {
    // Compile-only check: the port shape must stay stable.
    const port: StoryGeneratorPort = {
      generateOpening: () => makeHandle("opening"),
      generateContinuation: () => makeHandle("continuation"),
      generateBranchPrefetch: () => makeHandle("branch"),
      generateInputResponse: () => makeHandle("input"),
    };
    expect(port.generateOpening).toBeInstanceOf(Function);
    expect(port.generateContinuation).toBeInstanceOf(Function);
    expect(port.generateBranchPrefetch).toBeInstanceOf(Function);
    expect(port.generateInputResponse).toBeInstanceOf(Function);
  });
});

function makeHandle(id: string) {
  return createGenerationHandle(id, async () => ({ events: [], state_patch: {} }));
}
