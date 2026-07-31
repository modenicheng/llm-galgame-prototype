import { describe, it, expect } from "vitest";
import { GenerationScheduler } from "./generation-scheduler.js";

describe("GenerationScheduler", () => {
  it("should start idle", () => {
    const scheduler = new GenerationScheduler();
    expect(scheduler.hasActivePathTask()).toBe(false);
    expect(scheduler.getActivePathStatus()).toBe("idle");
    expect(scheduler.getSignal()).toBeNull();
  });

  it("should transition to streaming on startActivePath", () => {
    const scheduler = new GenerationScheduler();
    const controller = scheduler.startActivePath();

    expect(scheduler.hasActivePathTask()).toBe(true);
    expect(scheduler.getActivePathStatus()).toBe("streaming");
    expect(scheduler.getSignal()).toBe(controller.signal);
  });

  it("should throw if starting while already streaming", () => {
    const scheduler = new GenerationScheduler();
    scheduler.startActivePath();

    expect(() => scheduler.startActivePath()).toThrow(
      'Cannot start active-path generation: current status is "streaming"',
    );
  });

  it("should return to idle on completeActivePath", () => {
    const scheduler = new GenerationScheduler();
    scheduler.startActivePath();
    scheduler.completeActivePath();

    expect(scheduler.hasActivePathTask()).toBe(false);
    expect(scheduler.getActivePathStatus()).toBe("idle");
    expect(scheduler.getSignal()).toBeNull();
  });

  it("should transition to canceling on cancelActivePath", () => {
    const scheduler = new GenerationScheduler();
    const controller = scheduler.startActivePath();
    const abortSpy = { aborted: false };
    controller.signal.addEventListener("abort", () => {
      abortSpy.aborted = true;
    });

    scheduler.cancelActivePath();

    expect(scheduler.getActivePathStatus()).toBe("canceling");
    expect(scheduler.hasActivePathTask()).toBe(true);
    expect(abortSpy.aborted).toBe(true);
  });

  it("should be a no-op to cancel when idle", () => {
    const scheduler = new GenerationScheduler();
    scheduler.cancelActivePath(); // should not throw
    expect(scheduler.getActivePathStatus()).toBe("idle");
  });

  it("should notify subscribers on state changes", () => {
    const scheduler = new GenerationScheduler();
    const states: string[] = [];
    scheduler.subscribe(() => states.push(scheduler.getActivePathStatus()));

    scheduler.startActivePath();
    scheduler.cancelActivePath();
    scheduler.completeActivePath();

    expect(states).toEqual(["streaming", "canceling", "idle"]);
  });

  it("should allow unsubscribing", () => {
    const scheduler = new GenerationScheduler();
    const states: string[] = [];
    const unsubscribe = scheduler.subscribe(() =>
      states.push(scheduler.getActivePathStatus()),
    );

    scheduler.startActivePath();
    unsubscribe();
    scheduler.completeActivePath();

    expect(states).toEqual(["streaming"]);
  });

  it("should allow starting a new task after completing the previous one", () => {
    const scheduler = new GenerationScheduler();
    scheduler.startActivePath();
    scheduler.completeActivePath();

    const controller = scheduler.startActivePath();
    expect(scheduler.getActivePathStatus()).toBe("streaming");
    expect(scheduler.getSignal()).toBe(controller.signal);
  });

  it("should adopt a candidate branch without creating a second controller", () => {
    const scheduler = new GenerationScheduler();
    const branchController = new AbortController();

    scheduler.adoptCandidateBranch("branch-task-1", "opt-a", branchController);

    expect(scheduler.hasActivePathTask()).toBe(true);
    expect(scheduler.getTaskId()).toBe("branch-task-1");
    expect(scheduler.getOwner()).toEqual({ type: "candidate_branch", branchId: "opt-a" });
    expect(scheduler.getSignal()).toBe(branchController.signal);

    scheduler.completeActivePath("different-task");
    expect(scheduler.hasActivePathTask()).toBe(true);

    scheduler.completeActivePath("branch-task-1");
    expect(scheduler.hasActivePathTask()).toBe(false);
  });
});
