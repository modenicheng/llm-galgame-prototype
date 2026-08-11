import { describe, it, expect } from "vitest";
import { createInitialState } from "./state.js";
import { reconcileStoryState } from "./reconcile.js";
import type { StoredEvent } from "../schema.js";

function storedNarration(seq: number, text: string, stage: unknown[] = []): StoredEvent {
  return {
    type: "narration",
    text,
    stage,
    seq,
    turn: 1,
    timestamp: "2026-08-11T00:00:00.000Z",
    source: "model",
  } as unknown as StoredEvent;
}

function storedDialogue(seq: number, characterId: string, speaker: string, text: string): StoredEvent {
  return {
    type: "dialogue",
    characterId,
    speaker,
    text,
    seq,
    turn: 1,
    timestamp: "2026-08-11T00:00:00.000Z",
    source: "model",
  } as unknown as StoredEvent;
}

describe("reconcileStoryState", () => {
  it("projects the last background cue into scene.location", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [
      storedNarration(1, "走进地下室。", [{ type: "background", assetId: "basement" }]),
    ]);
    expect(next.scene.location).toBe("basement");
    expect(next).not.toBe(initial);
  });

  it("registers dialogue speakers and ch cues as characters", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [
      storedDialogue(1, "suyao", "苏遥", "你不该来这里。"),
      storedNarration(2, "林澈推门进来。", [{ type: "character_patch", character: "linche" }]),
    ]);
    expect(Object.keys(next.characters)).toEqual(["suyao", "linche"]);
    expect(next.characters["suyao"]).toEqual({});
  });

  it("builds a rolling recent_summary from the last lines", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [
      storedNarration(1, "第一句。"),
      storedDialogue(2, "suyao", "苏遥", "第二句。"),
      storedNarration(3, "第三句。"),
      storedNarration(4, "第四句。"),
    ]);
    expect(next.recent_summary).toBe("苏遥: 第二句。 / 第三句。 / 第四句。");
  });

  it("returns the same reference when nothing changed", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [storedNarration(1, "纯旁白。")]);
    // 无 stage、无台词角色 → 只有 recent_summary 变化 → 引用变化；
    // 再用无内容事件验证引用不变。
    const untouched = reconcileStoryState(next, [
      { ...storedNarration(2, "纯旁白。"), type: "interaction" } as unknown as StoredEvent,
    ]);
    expect(untouched).toBe(next);
  });

  it("is incremental: a later batch does not lose earlier characters", () => {
    const initial = createInitialState();
    const afterA = reconcileStoryState(initial, [storedDialogue(1, "suyao", "苏遥", "你好。")]);
    const afterB = reconcileStoryState(afterA, [storedDialogue(2, "linche", "林澈", "嗯。")]);
    expect(Object.keys(afterB.characters)).toEqual(["suyao", "linche"]);
  });
});
