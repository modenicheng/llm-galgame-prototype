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
import type {
  ContextLlmRecorderRequest,
  ContextLlmResult,
} from "../../core/ports/context-llm-recorder-port.js";

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
function runFullAttempt(recorder: LlmStreamRecorder, attemptId: string, taskType = "continuation"): void {
  recorder.onAttemptStart(attemptInfo(attemptId, taskType));
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

function contextRequest(
  taskType: ContextLlmRecorderRequest["taskType"] = "recap_summarization",
): ContextLlmRecorderRequest {
  return {
    taskType,
    body: {
      model: "test-model",
      messages: [
        { role: "system", content: `SYS[${taskType}]` },
        { role: "user", content: `USER[${taskType}]` },
      ],
      temperature: 0.3,
    },
    meta: { events: 3 },
  };
}

/** Drive one successful background request through the recorder. */
function contextCall(raw = "背景代理原始输出"): () => Promise<ContextLlmResult> {
  return async () => ({ raw, usage: { input: 300, output: 90, cachedInput: 120 } });
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

  it("records a background request with the three-piece layout, sharing the seq counter and index", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      let t = 0;
      const recorder = new LlmStreamRecorder({ now: () => (t += 50) });
      await recorder.beginSession(dir, "sess-1");
      runFullAttempt(recorder, "opening-ab01#0", "opening");
      const result = await recorder.recordContextRequest(contextRequest(), contextCall());
      await recorder.flush();

      expect(result).toEqual({
        raw: "背景代理原始输出",
        usage: { input: 300, output: 90, cachedInput: 120 },
      });

      const llmDir = path.join(dir, "sess-1", "llm");
      expect((await readdir(llmDir)).sort()).toEqual([
        "0001-opening-ab01-0",
        "0002-recap_summarization-2",
        "index.jsonl",
      ]);

      const attemptDir = path.join(llmDir, "0002-recap_summarization-2");
      // prompts.jsonl: the verbatim provider request body.
      const prompts = await readJsonl(path.join(attemptDir, "prompts.jsonl"));
      expect(prompts).toHaveLength(1);
      expect(typeof prompts[0]!.ts).toBe("string");
      expect(prompts[0]!.body).toEqual(contextRequest().body);

      expect(await readFile(path.join(attemptDir, "output.raw.txt"), "utf8")).toBe(
        "背景代理原始输出",
      );

      const events = await readJsonl(path.join(attemptDir, "events.jsonl"));
      expect(events.map((event) => event.t)).toEqual(["start", "usage", "end"]);
      expect(events[0]).toMatchObject({
        task_type: "recap_summarization",
        task_index: 0,
      });
      expect(events[1]).toMatchObject({
        input: 300,
        output: 90,
        cached_input: 120,
        source: "api",
      });
      expect(events[1]!.reasoning_tokens).toBeUndefined();
      expect(events[2]).toMatchObject({ state: "done" });

      const index = await readJsonl(path.join(llmDir, "index.jsonl"));
      expect(index.map((row) => row.seq)).toEqual([1, 2]);
      expect(index[1]).toMatchObject({
        dir: "0002-recap_summarization-2",
        attempt_id: "recap_summarization#2",
        task_type: "recap_summarization",
        outcome: "done",
        meta: { events: 3 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a failed background request and rethrows the original error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "sess-fail");
      const boom = new Error("API 超时击穿");
      await expect(
        recorder.recordContextRequest(contextRequest("memory_agent"), async () => {
          throw boom;
        }),
      ).rejects.toThrow("API 超时击穿");
      await recorder.flush();

      const llmDir = path.join(dir, "sess-fail", "llm");
      expect((await readdir(llmDir)).sort()).toEqual(["0001-memory_agent-1", "index.jsonl"]);

      const attemptDir = path.join(llmDir, "0001-memory_agent-1");
      // 请求体已落盘（审计要能看到发了什么），但失败请求没有输出可录。
      expect(await readJsonl(path.join(attemptDir, "prompts.jsonl"))).toHaveLength(1);
      await expect(readFile(path.join(attemptDir, "output.raw.txt"), "utf8")).rejects.toThrow();

      const events = await readJsonl(path.join(attemptDir, "events.jsonl"));
      expect(events.map((event) => event.t)).toEqual(["start", "end"]);
      expect(events[1]).toMatchObject({ state: "failed", error: "API 超时击穿" });

      const index = await readJsonl(path.join(llmDir, "index.jsonl"));
      expect(index).toHaveLength(1);
      expect(index[0]).toMatchObject({
        attempt_id: "memory_agent#1",
        task_type: "memory_agent",
        outcome: "failed",
        error: "API 超时击穿",
        meta: { events: 3 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the provider call through untouched when recording before beginSession", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = new LlmStreamRecorder({ now: () => 1000 });
    const result = await recorder.recordContextRequest(contextRequest(), async () => ({
      raw: "ok",
      usage: null,
    }));
    expect(result).toEqual({ raw: "ok", usage: null });
    await recorder.flush();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("before beginSession"),
    );
  });

  it("orders the shared index by settlement across interleaved writer/context attempts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "llm-recorder-"));
    try {
      const recorder = new LlmStreamRecorder({ now: () => 1000 });
      await recorder.beginSession(dir, "sess-mix");
      // Writer attempt starts first (seq 1) but settles after the context
      // request (seq 2) — index rows follow settlement order.
      recorder.onAttemptStart(attemptInfo("continuation-cc03#0"));
      await recorder.recordContextRequest(contextRequest(), contextCall());
      recorder.onAttemptEnd("continuation-cc03#0", { state: "done", segmentEnd: "buffer" });
      await recorder.flush();

      const index = await readJsonl(path.join(dir, "sess-mix", "llm", "index.jsonl"));
      expect(index.map((row) => row.seq)).toEqual([2, 1]);
      expect(index[0]).toMatchObject({ task_type: "recap_summarization", outcome: "done" });
      expect(index[1]).toMatchObject({ task_type: "continuation", outcome: "done" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
