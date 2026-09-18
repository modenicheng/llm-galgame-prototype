// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BacklogOverlay, type BacklogOverlayHooks } from "./backlog-overlay.js";
import type { BacklogEntry } from "../runtime/backlog-store.js";

function entry(id: string, overrides: Partial<BacklogEntry> = {}): BacklogEntry {
  return {
    type: "dialogue",
    lineId: id,
    speaker: "苏遥",
    text: `台词 ${id}`,
    cacheKey: `cache-${id}`,
    sampleRate: 22050,
    ...overrides,
  };
}

function build(): {
  root: HTMLElement;
  overlay: BacklogOverlay;
  hooks: BacklogOverlayHooks & Record<string, ReturnType<typeof vi.fn>>;
} {
  const root = document.createElement("section");
  document.body.append(root);
  const hooks = {
    onClose: vi.fn(),
    onReplay: vi.fn(),
    onStopReplay: vi.fn(),
  };
  return { root, overlay: new BacklogOverlay(root, hooks), hooks };
}

describe("BacklogOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts hidden; open reveals the panel with rows newest-last", () => {
    const { root, overlay } = build();
    expect(root.hidden).toBe(true);
    overlay.open([entry("a"), entry("b")], null);
    expect(root.hidden).toBe(false);
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".backlog__item")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dataset.lineId).toBe("a");
    expect(rows[1]!.dataset.lineId).toBe("b");
    expect(root.querySelector(".backlog__count")!.textContent).toBe("2 条");
    expect((root.querySelector(".backlog__empty") as HTMLElement).hidden).toBe(true);
  });

  it("speaker rows show the name; narration rows show 旁白 with jade styling", () => {
    const { root, overlay } = build();
    overlay.open(
      [
        entry("n", { type: "narration" }),
        entry("d"),
      ],
      null,
    );
    const rows = [...root.querySelectorAll<HTMLElement>(".backlog__item")];
    expect(rows[0]!.classList.contains("backlog__item--narration")).toBe(true);
    expect(rows[0]!.querySelector(".backlog__speaker")!.textContent).toBe("旁白");
    expect(rows[1]!.querySelector(".backlog__speaker")!.textContent).toBe("苏遥");
  });

  it("rows with audio replay on click; playing row stops on click", () => {
    const { root, overlay, hooks } = build();
    overlay.open([entry("a"), entry("b")], null);
    let rows = [...root.querySelectorAll<HTMLButtonElement>(".backlog__item")];
    rows[0]!.click();
    expect(hooks.onReplay).toHaveBeenCalledWith("a");

    // Update marks row a as playing; clicking it now stops the replay.
    overlay.update([entry("a"), entry("b")], "a");
    rows = [...root.querySelectorAll<HTMLButtonElement>(".backlog__item")];
    expect(rows[0]!.classList.contains("backlog__item--playing")).toBe(true);
    expect(rows[0]!.querySelector(".backlog__cue")!.textContent).toBe("■");
    rows[0]!.click();
    expect(hooks.onStopReplay).toHaveBeenCalledTimes(1);
    void root;
  });

  it("rows without replayable audio are disabled and marked 无音频", () => {
    const { root, overlay, hooks } = build();
    overlay.open([entry("x", { cacheKey: null, sampleRate: 0 })], null);
    const row = root.querySelector<HTMLButtonElement>(".backlog__item")!;
    expect(row.disabled).toBe(true);
    expect(row.classList.contains("backlog__item--noaudio")).toBe(true);
    expect(row.textContent).toContain("无音频");
    row.click();
    expect(hooks.onReplay).not.toHaveBeenCalled();
  });

  it("update with unchanged shape is a no-op (row identity preserved)", () => {
    const { root, overlay } = build();
    overlay.open([entry("a")], null);
    const rowBefore = root.querySelector(".backlog__item");
    overlay.update([entry("a")], null); // same size + last id + replay target
    expect(root.querySelector(".backlog__item")).toBe(rowBefore);
    overlay.update([entry("a"), entry("b")], null); // changed → rebuild
    expect(root.querySelectorAll(".backlog__item")).toHaveLength(2);
  });

  it("close hides the panel and fires the hook via the close button", () => {
    const { root, overlay, hooks } = build();
    overlay.open([entry("a")], null);
    (root.querySelector(".backlog__close") as HTMLButtonElement).click();
    expect(hooks.onClose).toHaveBeenCalledTimes(1);
    overlay.close();
    expect(root.hidden).toBe(true);
    // update() while closed must not resurrect the panel.
    overlay.update([entry("a"), entry("b")], null);
    expect(root.hidden).toBe(true);
  });
});
