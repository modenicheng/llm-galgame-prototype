/**
 * Tests for LlmStreamRecorder — the full-fidelity on-disk record of the
 * writer LLM's DSL streams (observability counterpart of /monitor's
 * bounded in-memory view).
 *
 * Contract highlights under test: every attempt lands under
 * `<sessions_dir>/<sessionId>/llm/<seq>-<attemptId>/` with the verbatim
 * prompt reports, the raw delta stream and the structured event log; a
 * session resume continues the numbering; write failures are contained.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LlmStreamRecorder } from "./llm-stream-recorder.js";
import type {
  WriterAttemptInfo,
  WriterPromptReport,
} from "../../core/ports/dsl-stream-observer.js";

function attemptInfo(attemptId: string, taskType = "continuation"): WriterAttemptInfo {
  const withoutAttempt = attemptId.split("#")[0]!;
  return {
    attemptId,
    taskId: withoutAttempt,
    taskType,
    index: Number.parseInt(attemptId.split("#")[1] ?? "0", 10),
  };
}

function promptReport(attemptId: string, requestIndex: number, marker: string): WriterPromptReport {
  return {
    attemptId,
    requestIndex,
    messages: [
      {
        role: "system",
        segments: [{ source: "prompts/dsl-protocol.txt", label: "协议", text: `SYS[${marker}]` }],
      },
      {
        role: "user",
        segments: [
          { source: "runtime/history-window", label: "历史", text: `H[${marker}` },
          { source: "runtime/task", label: "任务", text: `|T(${marker})]` },
        ],
      },
    ],
  };
}

/** Drive one complete, successful attempt through the observer hooks. */
function runFullAttempt(recorder: LlmStreamRecorder, attemptId: string): void {
  recorder.onAttemptStart(attemptInfo(attemptId));
  recorder.onPrompt(promptReport(attemptId, 0, "p0"));
  recorder.onDelta(attemptId, "第一句。\n");
  recorder.onDelta(attemptId, "@second 句\n");
  recorder.onDelta(attemptId, "@end buffer");
  recorder.onLine(attemptId, 0, { kind: "dialogue" });
  recorder.onLine(attemptId, 1, { kind: null });
  recorder.onGroup(attemptId, 0, "dialogue", "许晚晴：第一句。……");
  recorder.onRepair(attemptId, { kind: "end_keyword", lineIndex: 2, message: "补 @end" });
  recorder.onUsage(attemptId, {
    input: 1200,
    output: 200,
    cachedInput: 640,
    source: "api",
    latencyMs: 5400,
  });
  recorder.onAttemptEnd(attemptId, { state: "done", segmentEnd: "buffer" });
}

async function readJsonl(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("LlmStreamRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records prompt, raw stream and events for one attempt, plus an index row", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      let t = 0;
      const recorder = new LlmStreamRecorder({ now: () => (t += 50) });
      await recorder.beginSession(dir, "sess-1");
      runFullAttempt(recorder, "continuation-a1b2#0");
      await recorder.flush();

      const llmDir = path.join(dir, "sess-1", "llm");
      const attemptDir = path.join(llmDir, "0001-continuation-a1b2-0");

      // prompts.jsonl: verbatim segments — joining reproduces the sent bytes.
      const prompts = await readJsonl(path.join(attemptDir, "prompts.jsonl"));
      expect(prompts).toHaveLength(1);
      const report = prompts[0]! as unknown as ReturnType<typeof promptReport>;
      expect(report.attemptId).toBe("continuation-a1b2#0");
      expect(report.requestIndex).toBe(0);
      const user = report.messages[1]!;
      expect(user.segments.map((segment) => segment.text).join("")).toBe("H[p0|T(p0)]");

      // output.raw.txt: deltas concatenated in arrival order.
      expect(await readFile(path.join(attemptDir, "output.raw.txt"), "utf8")).toBe(
        "第一句。\n@second 句\n@end buffer",
      );

      // events.jsonl: structured events in hook order with timestamps.
      const events = await readJsonl(path.join(attemptDir, "events.jsonl"));
      expect(events.map((event) => event.t)).toEqual([
        "start",
        "line",
        "line",
        "group",
        "repair",
        "usage",
        "end",
      ]);
      expect(events[0]).toMatchObject({ task_id: "continuation-a1b2", task_type: "continuation", task_index: 0 });
      expect(events[1]).toMatchObject({ line_index: 0, kind: "dialogue" });
      expect(events[2]).toMatchObject({ line_index: 1, kind: null });
      expect(events[4]).toMatchObject({ kind: "end_keyword", line_index: 2 });
      expect(events[5]).toMatchObject({ input: 1200, cached_input: 640, source: "api" });
      expect(events[6]).toMatchObject({ state: "done", segment_end: "buffer" });
      for (const event of events) expect(typeof event.ts).toBe("string");

      // index.jsonl: one settled-attempt summary.
      const index = await readJsonl(path.join(llmDir, "index.jsonl"));
      expect(index).toHaveLength(1);
      expect(index[0]).toMatchObject({
        seq: 1,
        dir: "0001-continuation-a1b2-0",
        attempt_id: "continuation-a1b2#0",
        task_type: "continuation",
        outcome: "done",
        segment_end: "buffer",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps follow-up prompt reports (strip-continue) as separate lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "sess-1");
      recorder.onAttemptStart(attemptInfo("continuation-c3d4#0"));
      recorder.onPrompt(promptReport("continuation-c3d4#0", 0, "initial"));
      recorder.onPrompt(promptReport("continuation-c3d4#0", 1, "follow-up"));
      recorder.onAttemptEnd("continuation-c3d4#0", { state: "done", segmentEnd: "buffer" });
      await recorder.flush();

      const prompts = await readJsonl(
        path.join(dir, "sess-1", "llm", "0001-continuation-c3d4-0", "prompts.jsonl"),
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatchObject({ attemptId: "continuation-c3d4#0", requestIndex: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives each repair attempt its own directory and index row", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "sess-1");
      recorder.onAttemptStart(attemptInfo("opening-e5f6#0", "opening"));
      recorder.onAttemptEnd("opening-e5f6#0", { state: "retried", error: "max_tokens 截断" });
      recorder.onAttemptStart(attemptInfo("opening-e5f6#1", "opening"));
      recorder.onAttemptEnd("opening-e5f6#1", { state: "done", segmentEnd: "interaction" });
      await recorder.flush();

      const llmDir = path.join(dir, "sess-1", "llm");
      const entries = (await readdir(llmDir)).sort();
      expect(entries).toEqual(["0001-opening-e5f6-0", "0002-opening-e5f6-1", "index.jsonl"]);
      const index = await readJsonl(path.join(llmDir, "index.jsonl"));
      expect(index.map((row) => row.outcome)).toEqual(["retried", "done"]);
      expect(index[1]).toMatchObject({ seq: 2, attempt_id: "opening-e5f6#1" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues numbering when the same session directory is resumed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const first = new LlmStreamRecorder({ now: () => 1000 });
      await first.beginSession(dir, "sess-resume");
      runFullAttempt(first, "continuation-aa01#0");
      await first.flush();

      const second = new LlmStreamRecorder({ now: () => 1000 });
      await second.beginSession(dir, "sess-resume");
      runFullAttempt(second, "continuation-bb02#0");
      await second.flush();

      const llmDir = path.join(dir, "sess-resume", "llm");
      const entries = (await readdir(llmDir)).sort();
      expect(entries).toEqual([
        "0001-continuation-aa01-0",
        "0002-continuation-bb02-0",
        "index.jsonl",
      ]);
      const index = await readJsonl(path.join(llmDir, "index.jsonl"));
      expect(index).toHaveLength(2);
      expect(index[1]).toMatchObject({ seq: 2, attempt_id: "continuation-bb02#0" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("switches sessions on beginSession and restarts numbering per session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "s1");
      runFullAttempt(recorder, "continuation-x1#0");
      await recorder.flush();
      await recorder.beginSession(dir, "s2");
      runFullAttempt(recorder, "continuation-x2#0");
      await recorder.flush();

      expect((await readdir(path.join(dir, "s1", "llm"))).sort()).toEqual([
        "0001-continuation-x1-0",
        "index.jsonl",
      ]);
      expect((await readdir(path.join(dir, "s2", "llm"))).sort()).toEqual([
        "0001-continuation-x2-0",
        "index.jsonl",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops events for unknown attempts without throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = new LlmStreamRecorder({ now: () => 1000 });
    expect(() => recorder.onDelta("ghost#0", "x")).not.toThrow();
    expect(() => recorder.onPrompt(promptReport("ghost#0", 0, "x"))).not.toThrow();
    expect(() => recorder.onAttemptEnd("ghost#0", { state: "done" })).not.toThrow();
  });

  it("contains write failures: a broken raw stream does not kill the attempt log", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "sess-fail");
      recorder.onAttemptStart(attemptInfo("t-fail#0"));
      await recorder.flush();
      const attemptDir = path.join(dir, "sess-fail", "llm", "0001-t-fail-0");
      // A directory where output.raw.txt must be appended forces every
      // delta write to fail — the chain must survive.
      await mkdir(path.join(attemptDir, "output.raw.txt"), { recursive: true });

      recorder.onDelta("t-fail#0", "x");
      recorder.onDelta("t-fail#0", "y");
      recorder.onAttemptEnd("t-fail#0", { state: "done", segmentEnd: "buffer" });
      await recorder.flush();

      const events = await readJsonl(path.join(attemptDir, "events.jsonl"));
      expect(events[events.length - 1]).toMatchObject({ t: "end", state: "done" });
      const index = await readJsonl(path.join(dir, "sess-fail", "llm", "index.jsonl"));
      expect(index).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
