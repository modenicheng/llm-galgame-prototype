/**
 * Tests for BranchPrefetchGroup in src/prefetch.ts.
 *
 * BranchPrefetchGroup manages concurrent branch prefetching with
 * AbortController cancellation, priority queuing, and deferred resolution.
 */

import { describe, it, expect, vi } from "vitest";
import { BranchPrefetchGroup } from "./prefetch.js";
import type { ChoiceEvent, ChoiceOption, RuntimePlayableEvent } from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOption(id: string, text?: string): ChoiceOption {
  return { id, text: text ?? `选项${id}` };
}

function makeOptions(count: number): ChoiceOption[] {
  return Array.from({ length: count }, (_, i) => makeOption(`opt_${i}`, `选项 ${i}`));
}

function makeChoiceEvent(options: ChoiceOption[]): ChoiceEvent {
  return { type: "choice", prompt: "请选择：", options };
}

function makeEvents(count: number): RuntimePlayableEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "narration" as const,
    text: `事件 ${i}`,
    line_id: `line_${i}`,
  }));
}

function makeDialogueEvents(count: number): RuntimePlayableEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "dialogue" as const,
    speaker: `角色${i}`,
    text: `台词 ${i}`,
    line_id: `line_${i}`,
  }));
}

/**
 * Flush all pending micro- and macrotasks so that chained promise handlers
 * (.then / .catch / .finally) have fully settled before assertions.
 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Mock RuntimeStatus — tracks all calls to setJob and setBranch. */
function createMockStatus() {
  return {
    setJob: vi.fn(),
    setBranch: vi.fn(),
    setPhase: vi.fn(),
    setBuffer: vi.fn(),
    removeJob: vi.fn(),
    clearBranches: vi.fn(),
    setMedia: vi.fn(),
    subscribe: vi.fn(),
    snapshot: vi.fn(),
  };
}

/**
 * Creates a controllable generate function.
 *
 * Each call to generate() returns a promise that can be resolved/rejected
 * externally via the returned `controllers` array. The mock properly
 * respects AbortSignal: if the signal is already aborted, it rejects
 * immediately; if aborted later, it rejects via the "abort" event.
 */
function createControllableGenerate() {
  interface Controller {
    resolve: (events: RuntimePlayableEvent[]) => void;
    reject: (error: Error) => void;
    option: ChoiceOption;
    signal: AbortSignal;
  }

  const controllers: Controller[] = [];

  const generate = vi.fn((option: ChoiceOption, signal: AbortSignal) => {
    return new Promise<RuntimePlayableEvent[]>((resolve, reject) => {
      if (signal.aborted) {
        reject(newDOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => reject(newDOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      controllers.push({
        resolve: (events) => {
          signal.removeEventListener("abort", onAbort);
          resolve(events);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
        option,
        signal,
      });
    });
  });

  return { generate, controllers };
}

/** Helper to create an AbortError-like DOMException for the mock. */
function newDOMException(message: string, name: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// ---------------------------------------------------------------------------
// 1. Basic startup
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup startup", () => {
  it("should construct without starting (generate not called before start)", () => {
    const { generate } = createControllableGenerate();
    const status = createMockStatus();

    new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: status as any,
      generate,
    });

    // Sync status for initial "queued" state is called during construction.
    expect(status.setBranch).toHaveBeenCalledTimes(3);
    // But generate must NOT be called before start().
    expect(generate).not.toHaveBeenCalled();
  });

  it("should call generate for entries up to concurrency limit after start()", () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: status as any,
      generate,
    });

    group.start();

    // Concurrency=2, so exactly 2 entries should start generating.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
    expect(controllers[0]!.option.id).toBe("opt_0");
    expect(controllers[1]!.option.id).toBe("opt_1");
  });

  it("should mark started entries as running in status", () => {
    const { generate } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: status as any,
      generate,
    });

    group.start();

    // setJob called for each started entry with "running"
    expect(status.setJob).toHaveBeenCalledWith(
      "branch:opt_0",
      "分支：选项 0",
      "running",
    );
    expect(status.setJob).toHaveBeenCalledWith(
      "branch:opt_1",
      "分支：选项 1",
      "running",
    );
  });

  it("should be idempotent — calling start() twice does not double-start", () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(generate).toHaveBeenCalledTimes(2);

    group.start(); // second call is no-op
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrency control
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup concurrency control", () => {
  it("with concurrency=1, only one branch runs at a time", () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(controllers).toHaveLength(1);
    expect(controllers[0]!.option.id).toBe("opt_0");
  });

  it("with concurrency=3, up to 3 branches run at a time", () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(5)),
      concurrency: 3,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    expect(generate).toHaveBeenCalledTimes(3);
    expect(controllers).toHaveLength(3);
    const ids = controllers.map((c) => c.option.id);
    expect(ids).toEqual(["opt_0", "opt_1", "opt_2"]);
  });

  it("should start the next queued branch when a running one completes", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Only opt_0 is running.
    expect(generate).toHaveBeenCalledTimes(1);

    // Resolve opt_0.
    controllers[0]!.resolve(makeEvents(2));
    await tick(); // flush microtasks so pump runs

    // Now opt_1 should have started.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
    expect(controllers[1]!.option.id).toBe("opt_1");
  });

  it("should start ALL queued branches as slots free up", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 3,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(controllers).toHaveLength(3); // all started at once

    // Resolve all three.
    for (const c of controllers) c.resolve(makeEvents(1));
    await tick();

    // Queue should be empty; no more generate calls.
    expect(generate).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 3. Queuing
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup queuing", () => {
  it("should leave excess options in queued state", () => {
    const { generate } = createControllableGenerate();
    const status = createMockStatus();

    new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(4)),
      concurrency: 1,
      status: status as any,
      generate,
    }).start();

    // Only opt_0 is generating.
    expect(generate).toHaveBeenCalledTimes(1);

    // setBranch for opt_0 should be "running".
    // The others should have been synced as "queued" during construction
    // and then "running" only for the first.
    const branchCalls = status.setBranch.mock.calls;
    // Construction syncs all as queued (4 calls).
    // start() -> pump() -> startEntry for opt_0 syncs it as running (5th call).
    expect(branchCalls.length).toBe(5);
    // Last setBranch call should be for opt_0 with "running".
    const lastCall = branchCalls[4];
    expect(lastCall[0]).toBe("opt_0");
    expect(lastCall[2]).toBe("running");
  });

  it("should pick up the next queued entry when a slot opens", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(generate).toHaveBeenCalledTimes(2);

    // Resolve opt_0 — should free a slot for opt_2.
    controllers[0]!.resolve(makeEvents(1));
    await tick();

    expect(generate).toHaveBeenCalledTimes(3);
    // The third call should be for opt_2 (opt_0 completed, opt_1 still running).
    expect(controllers[2]!.option.id).toBe("opt_2");
  });
});

// ---------------------------------------------------------------------------
// 4. Successful generation
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup successful generation", () => {
  it("should resolve the deferred with events when generate completes", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(3);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    const takePromise = group.take("opt_0");
    controllers[0]!.resolve(events);

    const result = await takePromise;
    expect(result).toEqual(events);
  });

  it("should call onReady with the correct option and events", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(2);
    const onReady = vi.fn();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
      onReady,
    });

    group.start();
    controllers[0]!.resolve(events);
    await tick();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ id: "opt_0", text: "选项 0" }, events);
  });

  it("should update branch status to 'ready' on completion", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(makeEvents(3));
    await tick();

    // Check setBranch called with "ready" state, correct event counts.
    const branchCalls = status.setBranch.mock.calls;
    const readyCall = branchCalls.find((c: any[]) => c[2] === "ready");
    expect(readyCall).toBeDefined();
    expect(readyCall[0]).toBe("opt_0");
    expect(readyCall[3]).toBe(3); // eventCount
    expect(readyCall[4]).toBe(0); // dialogueCount (narration events)
  });

  it("should count dialogue events correctly in status", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();
    const events = makeDialogueEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(events);
    await tick();

    const branchCalls = status.setBranch.mock.calls;
    const readyCall = branchCalls.find((c: any[]) => c[2] === "ready");
    expect(readyCall[4]).toBe(2); // dialogueCount
  });

  it("should set job status to 'ready' on completion", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(makeEvents(1));
    await tick();

    expect(status.setJob).toHaveBeenCalledWith(
      "branch:opt_0",
      "分支：选项 0",
      "ready",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. take() method
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup take()", () => {
  it("should return events when the branch has already completed", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Complete opt_0 before calling take().
    controllers[0]!.resolve(events);
    await tick();

    const result = await group.take("opt_0");
    expect(result).toEqual(events);
  });

  it("should wait for the branch to complete if still generating", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // take() before the branch completes.
    const takePromise = group.take("opt_0");

    // Resolve after a tick.
    await tick();
    controllers[0]!.resolve(events);

    const result = await takePromise;
    expect(result).toEqual(events);
  });

  it("should expose arrived events without waiting for live selection", async () => {
    const { generate, controllers } = createControllableGenerate();
    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    const selection = group.selectLive("opt_0");

    // Selection returns the same mutable buffer immediately. The active
    // generation task remains responsible for appending later events.
    expect(selection.events).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);

    const events = makeEvents(2);
    controllers[0]!.resolve(events);
    await expect(selection.done).resolves.toEqual(events);
    expect(selection.events).toEqual(events);
  });

  it("should hand off a live branch after enough dialogue events", async () => {
    let resolveGeneration!: (events: RuntimePlayableEvent[]) => void;
    let rejectGeneration!: (error: Error) => void;
    let signal!: AbortSignal;
    let emit!: (event: RuntimePlayableEvent) => void;
    const generate = vi.fn((_option: ChoiceOption, requestSignal: AbortSignal, onEvent: (event: RuntimePlayableEvent) => void) => {
      signal = requestSignal;
      emit = onEvent;
      return new Promise<RuntimePlayableEvent[]>((resolve, reject) => {
        resolveGeneration = resolve;
        rejectGeneration = reject;
        requestSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    const selection = group.selectLive("opt_0");
    const events = makeDialogueEvents(2);
    emit!(events[0]!);
    emit!(events[1]!);
    selection.handoff();

    await expect(selection.done).resolves.toEqual(events);
    expect(signal!.aborted).toBe(true);
    // The underlying promise can reject after handoff without changing the
    // already committed live selection.
    resolveGeneration!(events);
    rejectGeneration!(new Error("late failure"));
  });

  it("should cancel other branches when taking one", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Take opt_1 — should cancel opt_0 and opt_2.
    // opt_0 is running (abort triggers mock rejection).
    // opt_2 is queued (direct cancel).
    // opt_1 is queued, so it gets priority-started.
    const takePromise = group.take("opt_1");
    await tick();

    // Now resolve opt_1.
    const opt1Controller = controllers.find((c) => c.option.id === "opt_1");
    expect(opt1Controller).toBeDefined();
    opt1Controller!.resolve(makeEvents(1));

    const result = await takePromise;
    expect(result).toHaveLength(1);
  });

  it("should throw for unknown option IDs", async () => {
    const { generate } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    await expect(group.take("nonexistent")).rejects.toThrow("未知分支选项：nonexistent");
  });

  it("should reject when taking a branch that has already failed", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    controllers[0]!.reject(new Error("LLM failure"));
    await tick();

    await expect(group.take("opt_0")).rejects.toThrow("LLM failure");
  });

  it("should reject when taking a branch that was cancelled", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Take opt_0 — this cancels opt_1 (queued).
    controllers[0]!.resolve(makeEvents(1));
    await tick();
    await group.take("opt_0");

    // Now try to take the cancelled opt_1.
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");
  });
});

// ---------------------------------------------------------------------------
// 6. take() prioritization
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup take() prioritization", () => {
  it("should fast-track a queued branch when taken", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(4)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // At this point: opt_0 is running, opt_1-3 are queued.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(controllers[0]!.option.id).toBe("opt_0");

    // Take opt_2 (queued). It should cancel opt_0 and fast-track opt_2.
    const takePromise = group.take("opt_2");

    // cancelling opt_0 will abort its signal, causing the mock to reject.
    // opt_2 should now be started (priority=true).
    await tick();

    // Verify opt_2 was started (it appeared in controllers).
    const opt2Ctrl = controllers.find((c) => c.option.id === "opt_2");
    expect(opt2Ctrl).toBeDefined();

    // Resolve opt_2.
    const events = makeEvents(3);
    opt2Ctrl!.resolve(events);

    const result = await takePromise;
    expect(result).toEqual(events);
  });

  it("should use the priority label in setJob when fast-tracking", async () => {
    const { generate } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();

    // Take opt_1 (queued) — should get "已选分支" label.
    group.take("opt_1");
    await tick();

    const jobCalls = status.setJob.mock.calls;
    const priorityCall = jobCalls.find(
      (c: any[]) => c[0] === "branch:opt_1" && c[1].includes("已选分支"),
    );
    expect(priorityCall).toBeDefined();
    expect(priorityCall[2]).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// 7. cancelAll()
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup cancelAll()", () => {
  it("should cancel all queued entries, rejecting their deferreds", async () => {
    const { generate } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    group.cancelAll();

    // opt_1 and opt_2 were queued — their deferreds should be rejected.
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");
    await expect(group.take("opt_2")).rejects.toThrow("分支预取已取消");
  });

  it("should abort running entries", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(controllers).toHaveLength(2); // both running

    group.cancelAll();

    // Both controllers should have been aborted (the mock rejects on abort).
    // The catch handler processes this as a microtask.
    await tick();

    // Both deferreds should be rejected with the Chinese cancel message.
    await expect(group.take("opt_0")).rejects.toThrow("分支预取已取消");
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");
  });

  it("should leave already-completed (ready) branches alone", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(1);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Complete opt_0.
    controllers[0]!.resolve(events);
    await tick();

    // Now cancelAll.
    group.cancelAll();

    // opt_0 is ready — its deferred should still be resolved.
    const result = await group.take("opt_0");
    expect(result).toEqual(events);

    // opt_1 was running and got aborted — needs tick for catch handler.
    await tick();
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");
  });

  it("should leave already-failed branches alone", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Fail opt_0.
    controllers[0]!.reject(new Error("timeout"));
    await tick();

    // cancelAll should not affect the already-failed opt_0.
    group.cancelAll();

    await expect(group.take("opt_0")).rejects.toThrow("timeout");
  });
});

// ---------------------------------------------------------------------------
// 8. Error handling
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup error handling", () => {
  it("should reject the deferred when generate() throws", async () => {
    const failingGenerate = vi.fn(async (_option: ChoiceOption, _signal: AbortSignal) => {
      throw new Error("LLM API failure");
    });

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate: failingGenerate,
    });

    group.start();

    await expect(group.take("opt_0")).rejects.toThrow("LLM API failure");
  });

  it("should set branch state to 'failed' when generate() throws", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.reject(new Error("network error"));
    await tick();

    const branchCalls = status.setBranch.mock.calls;
    const failedCall = branchCalls.find((c: any[]) => c[2] === "failed");
    expect(failedCall).toBeDefined();
    expect(failedCall[0]).toBe("opt_0");
    expect(failedCall[5]).toBe("network error"); // error message
  });

  it("should set job state to 'failed' with error message", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.reject(new Error("timeout"));
    await tick();

    expect(status.setJob).toHaveBeenCalledWith(
      "branch:opt_0",
      "分支：选项 0",
      "failed",
      "timeout",
    );
  });

  it("should normalize non-Error rejections", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    controllers[0]!.reject("plain string error" as any);
    await tick();

    await expect(group.take("opt_0")).rejects.toThrow("plain string error");
  });

  it("should continue pumping after a branch fails", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(generate).toHaveBeenCalledTimes(2);

    // Fail opt_0. This should free a slot for opt_2.
    controllers[0]!.reject(new Error("fail"));
    await tick();

    expect(generate).toHaveBeenCalledTimes(3);
    expect(controllers[2]!.option.id).toBe("opt_2");
  });

  it("should not crash the group when generate() throws", () => {
    const failingGenerate = vi.fn(async (_option: ChoiceOption, _signal: AbortSignal) => {
      throw new Error("boom");
    });

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate: failingGenerate,
    });

    // start() should not throw, even though generate returns a rejected promise.
    expect(() => group.start()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. AbortController
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup AbortController", () => {
  it("should pass the AbortSignal to generate()", () => {
    const { generate } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    expect(generate).toHaveBeenCalledTimes(1);
    const [_option, signal] = generate.mock.calls[0] as [ChoiceOption, AbortSignal];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("should abort the signal when cancelUnselected is called via take()", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Both running; take opt_0 — this aborts opt_1 and fast-tracks opt_0.
    controllers[0]!.resolve(makeEvents(1));
    await tick();

    await group.take("opt_0");

    // opt_1 was running and got aborted — catch handler needs a tick.
    await tick();
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");
  });

  it("should treat generate() errors as cancelled if the signal was aborted", async () => {
    const { generate, controllers } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: status as any,
      generate,
    });

    group.start();

    // Take opt_0 — this aborts opt_1's controller.
    controllers[0]!.resolve(makeEvents(1));
    await tick();
    await group.take("opt_0");
    await tick();

    // Check that opt_1's state became "cancelled" in setBranch.
    const branchCalls = status.setBranch.mock.calls;
    const cancelledCall = branchCalls.find(
      (c: any[]) => c[0] === "opt_1" && c[2] === "cancelled",
    );
    expect(cancelledCall).toBeDefined();

    // Check setJob for opt_1 was called with "cancelled".
    const jobCalls = status.setJob.mock.calls;
    const cancelledJob = jobCalls.find(
      (c: any[]) => c[0] === "branch:opt_1" && c[2] === "cancelled",
    );
    expect(cancelledJob).toBeDefined();
  });

  it("should create a unique AbortController per entry", () => {
    const { generate } = createControllableGenerate();

    new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    }).start();

    const [_opt0, signal0] = generate.mock.calls[0] as [ChoiceOption, AbortSignal];
    const [_opt1, signal1] = generate.mock.calls[1] as [ChoiceOption, AbortSignal];
    expect(signal0).not.toBe(signal1);
  });
});

// ---------------------------------------------------------------------------
// 10. onReady callback
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup onReady callback", () => {
  it("should call onReady when a branch completes successfully", async () => {
    const { generate, controllers } = createControllableGenerate();
    const onReady = vi.fn();
    const events = makeEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
      onReady,
    });

    group.start();
    expect(onReady).not.toHaveBeenCalled();

    controllers[0]!.resolve(events);
    await tick();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(
      { id: "opt_0", text: "选项 0" },
      events,
    );
  });

  it("should NOT call onReady for failed branches", async () => {
    const { generate, controllers } = createControllableGenerate();
    const onReady = vi.fn();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
      onReady,
    });

    group.start();
    controllers[0]!.reject(new Error("fail"));
    await tick();

    expect(onReady).not.toHaveBeenCalled();
  });

  it("should NOT call onReady for cancelled branches", async () => {
    const { generate, controllers } = createControllableGenerate();
    const onReady = vi.fn();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
      onReady,
    });

    group.start();

    // Complete opt_0, then take it (cancelling opt_1).
    controllers[0]!.resolve(makeEvents(1));
    await tick();
    await group.take("opt_0");
    await tick();

    // onReady should only have been called once (for opt_0).
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("should work without an onReady callback (optional)", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
      // no onReady
    });

    group.start();
    controllers[0]!.resolve(makeEvents(1));
    await tick();

    // Should not throw.
    const result = await group.take("opt_0");
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Status sync
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup status sync", () => {
  it("should sync all branches as 'queued' during construction", () => {
    const status = createMockStatus();
    const { generate } = createControllableGenerate();

    new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    // Three setBranch calls during construction, all "queued".
    expect(status.setBranch).toHaveBeenCalledTimes(3);
    const calls = status.setBranch.mock.calls;
    for (const call of calls) {
      expect(call[2]).toBe("queued");
    }
  });

  it("should include eventCount and dialogueCount in setBranch for ready branches", async () => {
    const status = createMockStatus();
    const { generate, controllers } = createControllableGenerate();
    const events: RuntimePlayableEvent[] = [
      { type: "dialogue", speaker: "A", text: "hi", line_id: "l1" },
      { type: "narration", text: "something", line_id: "l2" },
      { type: "dialogue", speaker: "B", text: "hello", line_id: "l3" },
    ];

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(events);
    await tick();

    const branchCalls = status.setBranch.mock.calls;
    const readyCall = branchCalls.find((c: any[]) => c[2] === "ready");
    expect(readyCall).toBeDefined();
    // 3 events total, 2 dialogues
    expect(readyCall[3]).toBe(3);
    expect(readyCall[4]).toBe(2);
  });

  it("should set error=null in setBranch for successful branches", async () => {
    const status = createMockStatus();
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(makeEvents(1));
    await tick();

    const branchCalls = status.setBranch.mock.calls;
    const readyCall = branchCalls.find((c: any[]) => c[2] === "ready");
    expect(readyCall[5]).toBeNull(); // error is null
  });

  it("should set error message in setBranch and setJob for failed branches", async () => {
    const status = createMockStatus();
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 1,
      status: status as any,
      generate,
    });

    group.start();
    controllers[0]!.reject(new Error("specific error"));
    await tick();

    const branchCalls = status.setBranch.mock.calls;
    const failedCall = branchCalls.find((c: any[]) => c[2] === "failed");
    expect(failedCall[5]).toBe("specific error");

    const jobCalls = status.setJob.mock.calls;
    const failedJob = jobCalls.find((c: any[]) => c[2] === "failed");
    expect(failedJob[3]).toBe("specific error");
  });
});

// ---------------------------------------------------------------------------
// 12. Edge cases
// ---------------------------------------------------------------------------

describe("BranchPrefetchGroup edge cases", () => {
  it("should handle empty options gracefully", () => {
    const { generate } = createControllableGenerate();
    const status = createMockStatus();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent([]),
      concurrency: 2,
      status: status as any,
      generate,
    });

    expect(() => group.start()).not.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect(status.setBranch).not.toHaveBeenCalled();
  });

  it("should handle a single option correctly", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(1)),
      concurrency: 5,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    expect(generate).toHaveBeenCalledTimes(1);

    controllers[0]!.resolve(events);
    const result = await group.take("opt_0");
    expect(result).toEqual(events);
  });

  it("should handle duplicate take() calls gracefully", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events = makeEvents(1);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(events);
    await tick();

    // First take — succeeds.
    const r1 = await group.take("opt_0");
    expect(r1).toEqual(events);

    // Second take on the same option — should return the same events.
    const r2 = await group.take("opt_0");
    expect(r2).toEqual(events);
  });

  it("should handle take() after all branches are ready", async () => {
    const { generate, controllers } = createControllableGenerate();
    const events0 = makeEvents(1);
    const events1 = makeEvents(2);

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    controllers[0]!.resolve(events0);
    controllers[1]!.resolve(events1);
    await tick();

    // All ready; take opt_1.
    const result = await group.take("opt_1");
    expect(result).toEqual(events1);
  });

  it("should handle take() after all branches have failed", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();
    controllers[0]!.reject(new Error("fail0"));
    controllers[1]!.reject(new Error("fail1"));
    await tick();

    await expect(group.take("opt_0")).rejects.toThrow("fail0");
    await expect(group.take("opt_1")).rejects.toThrow("fail1");
  });

  it("should handle concurrency larger than option count", () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(2)),
      concurrency: 10, // much larger than 2
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // All options should be started.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);
  });

  it("should not leak deferred promises — unhandled rejections are suppressed", async () => {
    // The Deferred type uses void promise.catch(() => undefined) to suppress
    // unhandled rejections. Verify that a cancelled branch's rejection does
    // not surface as an unhandled rejection warning.
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 1,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // Take opt_0. This cancels opt_1 and opt_2 (queued).
    controllers[0]!.resolve(makeEvents(1));
    await tick();
    await group.take("opt_0");

    // We don't await opt_1 or opt_2 — if the deferred catch suppression
    // works, there should be no unhandled rejection.
    // (This test passes trivially if no exception is thrown.)
    expect(true).toBe(true);
  });

  it("should gracefully handle take() on a just-cancelled branch", async () => {
    const { generate, controllers } = createControllableGenerate();

    const group = new BranchPrefetchGroup({
      choice: makeChoiceEvent(makeOptions(3)),
      concurrency: 2,
      status: createMockStatus() as any,
      generate,
    });

    group.start();

    // opt_0 and opt_1 are running, opt_2 is queued.
    // Complete then take opt_0. This cancels opt_1 (running -> abort) and opt_2 (queued -> direct cancel).
    controllers[0]!.resolve(makeEvents(1));
    await tick();
    await group.take("opt_0");
    // Flush so opt_1's catch handler processes the abort.
    await tick();

    // Now trying to take opt_1 should reject (it was aborted).
    await expect(group.take("opt_1")).rejects.toThrow("分支预取已取消");

    // And opt_2 should also reject (it was cancelled while queued).
    await expect(group.take("opt_2")).rejects.toThrow("分支预取已取消");
  });
});
