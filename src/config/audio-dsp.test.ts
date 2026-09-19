/**
 * AudioDspStore/loadAudioDspConfig tests: missing file → defaults (info),
 * broken file → defaults + warn (fail-open), valid round-trip, atomic
 * save semantics (disk content canonical, memory unchanged on failure).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AudioDspStore,
  loadAudioDspConfig,
} from "./audio-dsp.js";
import { defaultAudioDspParams } from "../shared/wire/audio-dsp.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("loadAudioDspConfig", () => {
  it("missing file → defaults + info log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const log = makeLog();
      const params = await loadAudioDspConfig(path.join(dir, "absent.yaml"), log);
      expect(params).toEqual(defaultAudioDspParams());
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("valid file → parsed values (partial payloads fill defaults)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const file = path.join(dir, "audio-dsp.yaml");
      await writeFile(
        file,
        ["version: 1", "ducking:", "  depth_db: -20", "  enabled: true"].join("\n"),
        "utf8",
      );
      const log = makeLog();
      const params = await loadAudioDspConfig(file, log);
      expect(params.ducking.depth_db).toBe(-20);
      expect(params.ducking.hold_ms).toBe(350); // 缺字段回默认
      expect(params.voice.gate.threshold_db).toBe(-55);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("broken file → defaults + warn (fail-open, never bricks startup)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const file = path.join(dir, "audio-dsp.yaml");
      await writeFile(file, "- just\n- a\n- list\n", "utf8");
      const log = makeLog();
      const params = await loadAudioDspConfig(file, log);
      expect(params).toEqual(defaultAudioDspParams());
      expect(log.warn).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("AudioDspStore.save", () => {
  it("writes canonical yaml that loads back identically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const file = path.join(dir, "audio-dsp.yaml");
      const log = makeLog();
      const store = new AudioDspStore(file, defaultAudioDspParams(), log);
      const next = defaultAudioDspParams();
      next.ducking.depth_db = -18;
      next.voice.gate.enabled = false;
      await store.save(next);
      expect(store.get()).toEqual(next);
      const reloaded = await loadAudioDspConfig(file, makeLog());
      expect(reloaded).toEqual(next);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("failed write keeps the in-memory params unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const log = makeLog();
      const store = new AudioDspStore(path.join(dir, "no-such-dir", "x.yaml"), defaultAudioDspParams(), log);
      const next = defaultAudioDspParams();
      next.ducking.depth_db = -30;
      await expect(store.save(next)).rejects.toThrow();
      expect(store.get()).not.toEqual(next); // 内存态不动
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("saved file has no leftover tmp sibling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "audio-dsp-"));
    try {
      const file = path.join(dir, "audio-dsp.yaml");
      const store = new AudioDspStore(file, defaultAudioDspParams(), makeLog());
      await store.save(defaultAudioDspParams());
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir);
      expect(entries).toEqual(["audio-dsp.yaml"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
