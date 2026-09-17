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

  it("keeps recent_summary untouched — recap pipeline owns it", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [
      storedNarration(1, "第一句。"),
      storedDialogue(2, "suyao", "苏遥", "第二句。"),
      storedNarration(3, "第三句。"),
      storedNarration(4, "第四句。"),
    ]);
    // recent_summary 由滚动前情梗概管线（recap.ts）独占维护：reconcile
    // 不再把"最近 3 行"覆写进去（那 3 行本就重复出现在历史窗口里）。
    expect(next.recent_summary).toBe(initial.recent_summary);
  });

  it("returns the same reference when nothing changed", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(initial, [storedNarration(1, "纯旁白。")]);
    // 无 stage、无台词角色 → 无投影变化 → 引用不变。
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

  // 上下文污染闭环（2026-09-17 审计）：坏语法造出的幻影发言者一旦入库，
  // 就经 summarizeState 的 [Characters] 段回流进 writer prompt，模型看到
  // 坏语法并模仿。已知角色集把幻影挡在 state 之外。
  it("does not register dialogue speakers outside knownCharacterIds", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(
      initial,
      [storedDialogue(1, "@6ch raspberry", "@6ch raspberry", "uneasy center")],
      { knownCharacterIds: new Set(["raspberry", "female_A"]) },
    );
    expect(next.characters["@6ch raspberry"]).toBeUndefined();
    expect(next).toBe(initial);
  });

  it("registers known speakers when the known set is supplied", () => {
    const initial = createInitialState();
    const next = reconcileStoryState(
      initial,
      [storedDialogue(1, "raspberry", "树莓娘", "剪完我自己都笑了。")],
      { knownCharacterIds: new Set(["raspberry"]) },
    );
    expect(next.characters["raspberry"]).toEqual({});
  });

  it("never tracks ids containing @ or whitespace even without a known set", () => {
    const initial = createInitialState();
    const next = reconcileStateUnsafe(initial);
    expect(next).toBe(initial);
  });
});

/** 通过任意（未注册）已知集路径验证兜底过滤。 */
function reconcileStateUnsafe(initial: ReturnType<typeof createInitialState>) {
  return reconcileStoryState(initial, [
    storedDialogue(1, "@ch raspberry", "@ch raspberry", "台词"),
    storedNarration(2, "动作。", [{ type: "character_patch", character: "weird id" }]),
  ]);
}
