import { describe, it, expect, vi } from "vitest";
import { RuntimeStatus } from "./status.js";
import type {
  RuntimeStatusSnapshot,
  JobStatus,
  BranchStatus,
  MediaStatus,
} from "./status.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a fresh RuntimeStatus for each test case. */
function fresh(): RuntimeStatus {
  return new RuntimeStatus();
}

/** Snapshot of the default media block — used for assertions on a pristine instance. */
const defaultMedia: MediaStatus = {
  enabled: false,
  provider: "disabled",
  currentLineId: null,
  readyAhead: 0,
  queued: 0,
  generating: 0,
  targetAhead: 0,
  refillThreshold: 0,
  branchReady: 0,
  note: "仅文本模式",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuntimeStatus", () => {
  // 1. Initial snapshot --------------------------------------------------
  it("should return the expected default snapshot after construction", () => {
    const s = fresh().snapshot();
    expect(s).toEqual<RuntimeStatusSnapshot>({
      phase: "启动",
      message: "正在初始化",
      bufferedEvents: 0,
      bufferedDialogueLines: 0,
      jobs: {},
      branches: {},
      media: defaultMedia,
    });
  });

  // 2. setPhase ----------------------------------------------------------
  it("setPhase should update phase and message in the snapshot", () => {
    const rs = fresh();
    rs.setPhase("playing", "脚本已加载");
    const s = rs.snapshot();
    expect(s.phase).toBe("playing");
    expect(s.message).toBe("脚本已加载");
  });

  // 3. setBuffer ---------------------------------------------------------
  it("setBuffer should update bufferedEvents and bufferedDialogueLines", () => {
    const rs = fresh();
    rs.setBuffer(5, 12);
    const s = rs.snapshot();
    expect(s.bufferedEvents).toBe(5);
    expect(s.bufferedDialogueLines).toBe(12);
  });

  // 4. setJob lifecycle --------------------------------------------------
  it("should track a job through running => ready => failed", () => {
    const rs = fresh();

    // Add job as running
    rs.setJob("job-1", "branch-b", "running");
    let s = rs.snapshot();
    expect(s.jobs).toHaveProperty("job-1");
    expect(s.jobs["job-1"]).toEqual<JobStatus>({
      label: "branch-b",
      state: "running",
      error: null,
    });

    // Update to ready
    rs.setJob("job-1", "branch-b", "ready");
    s = rs.snapshot();
    expect(s.jobs["job-1"].state).toBe("ready");

    // Update to failed with error
    rs.setJob("job-1", "branch-b", "failed", "API timeout");
    s = rs.snapshot();
    expect(s.jobs["job-1"].state).toBe("failed");
    expect(s.jobs["job-1"].error).toBe("API timeout");
  });

  // 5. removeJob ---------------------------------------------------------
  it("removeJob should delete a job from the snapshot", () => {
    const rs = fresh();
    rs.setJob("job-x", "label", "queued");
    expect(rs.snapshot().jobs).toHaveProperty("job-x");

    rs.removeJob("job-x");
    expect(rs.snapshot().jobs).not.toHaveProperty("job-x");
  });

  it("removeJob should not throw when the job does not exist", () => {
    const rs = fresh();
    expect(() => rs.removeJob("nonexistent")).not.toThrow();
    // Snapshot stays the same
    expect(rs.snapshot().jobs).toEqual({});
  });

  // 6. setBranch lifecycle -----------------------------------------------
  it("should track a branch through queued => running => ready", () => {
    const rs = fresh();

    rs.setBranch("b1", "Branch Alpha", "queued", 0, 0);
    let s = rs.snapshot();
    expect(s.branches).toHaveProperty("b1");
    expect(s.branches["b1"]).toMatchObject<Partial<BranchStatus>>({
      label: "Branch Alpha",
      state: "queued",
      eventCount: 0,
      dialogueCount: 0,
      error: null,
    });

    rs.setBranch("b1", "Branch Alpha", "running", 3, 7);
    s = rs.snapshot();
    expect(s.branches["b1"].state).toBe("running");
    expect(s.branches["b1"].eventCount).toBe(3);
    expect(s.branches["b1"].dialogueCount).toBe(7);

    rs.setBranch("b1", "Branch Alpha", "ready", 10, 25);
    s = rs.snapshot();
    expect(s.branches["b1"].state).toBe("ready");
    expect(s.branches["b1"].eventCount).toBe(10);
    expect(s.branches["b1"].dialogueCount).toBe(25);
  });

  // 7. clearBranches -----------------------------------------------------
  it("clearBranches should remove all branches", () => {
    const rs = fresh();
    rs.setBranch("b1", "A", "queued");
    rs.setBranch("b2", "B", "running");
    expect(Object.keys(rs.snapshot().branches)).toHaveLength(2);

    rs.clearBranches();
    expect(rs.snapshot().branches).toEqual({});
  });

  it("clearBranches should be a no-op when already empty", () => {
    const rs = fresh();
    expect(rs.snapshot().branches).toEqual({});
    expect(() => rs.clearBranches()).not.toThrow();
    expect(rs.snapshot().branches).toEqual({});
  });

  // 8. setMedia ----------------------------------------------------------
  it("setMedia should merge partial updates into the media block", () => {
    const rs = fresh();

    rs.setMedia({ enabled: true, provider: "openai" });
    let s = rs.snapshot();
    expect(s.media.enabled).toBe(true);
    expect(s.media.provider).toBe("openai");
    // untouched fields keep defaults
    expect(s.media.note).toBe("仅文本模式");
    expect(s.media.readyAhead).toBe(0);

    rs.setMedia({ readyAhead: 3, generating: 1 });
    s = rs.snapshot();
    expect(s.media.readyAhead).toBe(3);
    expect(s.media.generating).toBe(1);
    // previous overrides persist
    expect(s.media.enabled).toBe(true);
    expect(s.media.provider).toBe("openai");
  });

  // 9. subscribe / unsubscribe -------------------------------------------
  it("subscribe should call the listener on each mutation", () => {
    const rs = fresh();
    const fn = vi.fn();

    rs.subscribe(fn);
    rs.setPhase("playing", "ok"); // call 1
    rs.setBuffer(1, 2); // call 2

    expect(fn).toHaveBeenCalledTimes(2);
    // Each call receives the current snapshot
    expect(fn.mock.calls[0]![0]).toMatchObject({ phase: "playing" });
    expect(fn.mock.calls[1]![0]).toMatchObject({ bufferedEvents: 1 });
  });

  it("unsubscribe (the returned function) should stop further calls", () => {
    const rs = fresh();
    const fn = vi.fn();

    const unsub = rs.subscribe(fn);
    rs.setPhase("a", "b"); // call 1
    unsub();
    rs.setPhase("c", "d"); // should NOT call

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // 10. Multiple listeners ------------------------------------------------
  it("should notify every listener with the same snapshot", () => {
    const rs = fresh();
    const fnA = vi.fn();
    const fnB = vi.fn();

    rs.subscribe(fnA);
    rs.subscribe(fnB);
    rs.setPhase("multi", "listener test");

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);

    const snapA = fnA.mock.calls[0]![0] as RuntimeStatusSnapshot;
    const snapB = fnB.mock.calls[0]![0] as RuntimeStatusSnapshot;
    expect(snapA).toEqual(snapB);
    // They should be reference-equal (emit calls snapshot() once)
    expect(snapA).toBe(snapB);
  });

  // 11. Snapshot immutability --------------------------------------------
  it("mutating a returned snapshot should not affect internal state", () => {
    const rs = fresh();
    rs.setPhase("original", "msg");

    const snap = rs.snapshot();
    snap.phase = "hacked";
    snap.bufferedEvents = 999;
    (snap.media as MediaStatus).enabled = true;

    const freshSnap = rs.snapshot();
    expect(freshSnap.phase).toBe("original");
    expect(freshSnap.bufferedEvents).toBe(0);
    expect(freshSnap.media.enabled).toBe(false);
  });

  it("mutating a job inside a returned snapshot should not affect internal state", () => {
    const rs = fresh();
    rs.setJob("j1", "lbl", "queued");

    const snap = rs.snapshot();
    snap.jobs["j1"]!.state = "hacked" as JobStatus["state"];

    expect(rs.snapshot().jobs["j1"]!.state).toBe("queued");
  });

  it("mutating a branch inside a returned snapshot should not affect internal state", () => {
    const rs = fresh();
    rs.setBranch("b1", "label", "queued");

    const snap = rs.snapshot();
    snap.branches["b1"]!.state = "hacked" as BranchStatus["state"];

    expect(rs.snapshot().branches["b1"]!.state).toBe("queued");
  });

  // 12. Job deduplication ------------------------------------------------
  it("setting the same job ID twice should update in place (no duplicates)", () => {
    const rs = fresh();
    rs.setJob("dup", "first", "queued");
    rs.setJob("dup", "second", "running");

    const s = rs.snapshot();
    const keys = Object.keys(s.jobs);
    expect(keys).toHaveLength(1);
    expect(keys).toEqual(["dup"]);
    expect(s.jobs["dup"]).toMatchObject({ label: "second", state: "running" });
  });

  // 13. Branch deduplication ---------------------------------------------
  it("setting the same branch ID twice should update in place (no duplicates)", () => {
    const rs = fresh();
    rs.setBranch("dup", "first", "queued", 1, 2);
    rs.setBranch("dup", "second", "running", 5, 10);

    const s = rs.snapshot();
    const keys = Object.keys(s.branches);
    expect(keys).toHaveLength(1);
    expect(keys).toEqual(["dup"]);
    expect(s.branches["dup"]).toMatchObject({
      label: "second",
      state: "running",
      eventCount: 5,
      dialogueCount: 10,
    });
  });

  // 14. Snapshot completeness --------------------------------------------
  it("snapshot should contain all required top-level fields", () => {
    const rs = fresh();
    const s = rs.snapshot();

    expect(s).toHaveProperty("phase");
    expect(s).toHaveProperty("message");
    expect(s).toHaveProperty("bufferedEvents");
    expect(s).toHaveProperty("bufferedDialogueLines");
    expect(s).toHaveProperty("jobs");
    expect(s).toHaveProperty("branches");
    expect(s).toHaveProperty("media");

    // media sub-fields
    const media = s.media;
    expect(media).toHaveProperty("enabled");
    expect(media).toHaveProperty("provider");
    expect(media).toHaveProperty("currentLineId");
    expect(media).toHaveProperty("readyAhead");
    expect(media).toHaveProperty("queued");
    expect(media).toHaveProperty("generating");
    expect(media).toHaveProperty("targetAhead");
    expect(media).toHaveProperty("refillThreshold");
    expect(media).toHaveProperty("branchReady");
    expect(media).toHaveProperty("note");
  });

  // Edge-case: cancel state for jobs -------------------------------------
  it("should support cancelled job state", () => {
    const rs = fresh();
    rs.setJob("cj", "cancel-test", "cancelled", "user aborted");
    const s = rs.snapshot();
    expect(s.jobs["cj"]!.state).toBe("cancelled");
    expect(s.jobs["cj"]!.error).toBe("user aborted");
  });

  // Edge-case: setJob with error = null explicitly -----------------------
  it("setJob should store error=null when not provided", () => {
    const rs = fresh();
    rs.setJob("j", "lbl", "running");
    expect(rs.snapshot().jobs["j"]!.error).toBeNull();
  });
});
