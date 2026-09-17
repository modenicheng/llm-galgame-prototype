/**
 * Tests for the /monitor/records read-only route (writer LLM stream
 * records, observability): allowlisted path shapes only, containment
 * guarded, and the hub state frame carries the record dir to the page.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveMonitorRecordFile,
  sanitizeAttemptIdSegment,
} from "./monitor-records.js";
import { MonitorHub } from "../../application/monitor/monitor-hub.js";
import { RuntimeStatus } from "../../status.js";
import { Metrics } from "../../runtime/metrics.js";

/** Build `<dir>/llm/<attemptDir>/` with the three record files + index. */
async function seedRecords(dir: string): Promise<string> {
  const recordDir = path.join(dir, "llm");
  const attemptDir = path.join(recordDir, "0001-continuation-a1b2-0");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(path.join(attemptDir, "output.raw.txt"), "第一句。\n@end buffer", "utf8");
  await writeFile(path.join(attemptDir, "prompts.jsonl"), '{"attemptId":"continuation-a1b2#0"}\n', "utf8");
  await writeFile(path.join(attemptDir, "events.jsonl"), '{"t":"start"}\n{"t":"end"}\n', "utf8");
  await writeFile(path.join(recordDir, "index.jsonl"), '{"seq":1}\n', "utf8");
  return recordDir;
}

describe("resolveMonitorRecordFile", () => {
  it("serves the session index and direct attempt files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mon-records-"));
    try {
      const recordDir = await seedRecords(dir);

      const index = await resolveMonitorRecordFile(recordDir, "/monitor/records/index.jsonl");
      expect(index).toBe(path.join(recordDir, "index.jsonl"));

      const raw = await resolveMonitorRecordFile(
        recordDir,
        "/monitor/records/0001-continuation-a1b2-0/output.raw.txt",
      );
      expect(raw).toBe(path.join(recordDir, "0001-continuation-a1b2-0", "output.raw.txt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves by-attempt links after the recorder's own sanitization", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mon-records-"));
    try {
      const recordDir = await seedRecords(dir);
      expect(sanitizeAttemptIdSegment("continuation-a1b2#0")).toBe("continuation-a1b2-0");

      const resolved = await resolveMonitorRecordFile(
        recordDir,
        `/monitor/records/by-attempt/${encodeURIComponent("continuation-a1b2#0")}/output.raw.txt`,
      );
      expect(resolved).toBe(path.join(recordDir, "0001-continuation-a1b2-0", "output.raw.txt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown shapes, traversal and non-record file names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mon-records-"));
    try {
      const recordDir = await seedRecords(dir);
      for (const pathname of [
        "/monitor/records/../state.json",
        "/monitor/records/index.jsonl/extra",
        "/monitor/records/0001-continuation-a1b2-0/state.json",
        "/monitor/records/0001-continuation-a1b2-0/../../events.jsonl",
        "/monitor/records/by-attempt/x/%2e%2e/events.jsonl",
        "/monitor/records/",
        "/monitor/records",
      ]) {
        expect(await resolveMonitorRecordFile(recordDir, pathname)).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves nothing when recording is off or the file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mon-records-"));
    try {
      expect(await resolveMonitorRecordFile(null, "/monitor/records/index.jsonl")).toBeNull();
      expect(
        await resolveMonitorRecordFile(dir, "/monitor/records/index.jsonl"),
      ).toBeNull();
      const recordDir = await seedRecords(dir);
      expect(
        await resolveMonitorRecordFile(recordDir, "/monitor/records/by-attempt/ghost-9999/output.raw.txt"),
      ).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MonitorHub recordDir wiring", () => {
  it("exposes the record dir on the state frame and snapshot once set", () => {
    const hub = new MonitorHub({
      status: new RuntimeStatus(),
      metrics: new Metrics(),
      info: {
        model: "test",
        narrativeMode: "event",
        apiBaseUrl: "",
        knownSpeakers: [],
        textBuffer: { startThresholdLines: 2, targetLines: 6, refillThresholdLines: 3 },
        eventMode: { wrapupInteractions: 0, closingPushInteractions: 0, maxInteractions: 0 },
      },
      game: () => null,
    });

    // 未设置时缺省（前端据此隐藏入口）。
    expect(hub.snapshot().state.recordDir).toBeUndefined();

    hub.setRecordDir(path.join("sessions", "sess-1", "llm"));
    expect(hub.snapshot().state.recordDir).toBe(path.join("sessions", "sess-1", "llm"));
    expect(hub.recordLocation).toBe(path.join("sessions", "sess-1", "llm"));

    // restart 换会话：可切回 null（落盘关闭），帧随之不再携带。
    hub.setRecordDir(null);
    expect(hub.snapshot().state.recordDir).toBeUndefined();
  });
});
