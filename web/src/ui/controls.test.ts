// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ControlsBar, type ControlsHooks } from "./controls.js";

function build(initial: { mode: "manual" | "auto" } = { mode: "manual" }): {
  root: HTMLElement;
  bar: ControlsBar;
  hooks: ControlsHooks & Record<string, ReturnType<typeof vi.fn>>;
} {
  const root = document.createElement("div");
  document.body.append(root);
  const hooks = {
    onModeToggle: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenBacklog: vi.fn(),
    onRestart: vi.fn(),
  };
  return { root, bar: new ControlsBar(root, hooks, initial), hooks };
}

describe("ControlsBar", () => {
  it("renders mode toggle, settings/backlog entries, restart and status; no flat audio sliders", () => {
    const { root } = build();
    const bar = root.querySelector(".controls__bar") as HTMLElement;
    expect((bar.querySelector(".ctl--mode") as HTMLElement).textContent).toBe("手动推进");
    expect((bar.querySelector(".ctl--settings") as HTMLElement).textContent).toBe("设置");
    expect((bar.querySelector(".ctl--backlog") as HTMLElement).textContent).toBe("回看");
    expect((bar.querySelector(".ctl--restart") as HTMLElement).textContent).toBe("重开");
    expect(bar.querySelector(".ctl--status")).not.toBeNull();
    // Audio settings live in the settings menu — no sliders/mute/speed on the bar.
    expect(bar.querySelector("input[type=range]")).toBeNull();
    expect(bar.querySelector(".ctl--volume")).toBeNull();
    expect(bar.querySelector(".ctl--mute")).toBeNull();
    expect(bar.querySelector(".ctl--speed")).toBeNull();
  });

  it("mode button toggles manual/auto and reports the next mode", () => {
    const { root, hooks } = build();
    const modeBtn = root.querySelector(".ctl--mode") as HTMLButtonElement;
    modeBtn.click();
    expect(hooks.onModeToggle).toHaveBeenCalledWith("auto");
    expect(modeBtn.textContent).toBe("自动推进");
    modeBtn.click();
    expect(hooks.onModeToggle).toHaveBeenCalledWith("manual");
  });

  it("settings and backlog buttons report clicks and reflect open state", () => {
    const { root, bar, hooks } = build();
    const settingsBtn = root.querySelector(".ctl--settings") as HTMLButtonElement;
    const backlogBtn = root.querySelector(".ctl--backlog") as HTMLButtonElement;
    expect(bar.settingsTrigger).toBe(settingsBtn);
    settingsBtn.click();
    backlogBtn.click();
    expect(hooks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(hooks.onOpenBacklog).toHaveBeenCalledTimes(1);
    expect(settingsBtn.classList.contains("ctl--active")).toBe(false);
    expect(backlogBtn.classList.contains("ctl--active")).toBe(false);
    bar.setSettingsOpen(true);
    bar.setBacklogOpen(true);
    expect(settingsBtn.classList.contains("ctl--active")).toBe(true);
    expect(backlogBtn.classList.contains("ctl--active")).toBe(true);
    bar.setSettingsOpen(false);
    bar.setBacklogOpen(false);
    expect(settingsBtn.classList.contains("ctl--active")).toBe(false);
    expect(backlogBtn.classList.contains("ctl--active")).toBe(false);
  });

  it("status line follows connection and audio state", () => {
    const { root, bar } = build();
    bar.setConnection("open");
    bar.setAudio(true, 2400);
    expect((root.querySelector(".ctl__status-text") as HTMLElement).textContent).toBe(
      "已连接 · 播放中 · 缓冲 2.4s",
    );
    bar.setAudio(false, 0);
    expect((root.querySelector(".ctl__status-text") as HTMLElement).textContent).toBe(
      "已连接 · 待命",
    );
  });

  it("restart button parks while pending and reports clicks", () => {
    const { root, bar, hooks } = build();
    const restartBtn = root.querySelector(".ctl--restart") as HTMLButtonElement;
    restartBtn.click();
    expect(hooks.onRestart).toHaveBeenCalledTimes(1);
    bar.setRestartPending(true);
    expect(restartBtn.disabled).toBe(true);
    expect(restartBtn.textContent).toBe("重开中…");
    restartBtn.click();
    expect(hooks.onRestart).toHaveBeenCalledTimes(1); // parked — no double fire
    bar.setRestartPending(false);
    expect(restartBtn.textContent).toBe("重开");
  });

  it("session chip hides when absent and shows the short id when present", () => {
    const { root, bar } = build();
    const chip = root.querySelector(".ctl--session") as HTMLElement;
    expect(chip.hidden).toBe(true);
    bar.setSessionId("sess-abcdefgh-1234");
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe("会话 sess-abc");
    expect(chip.title).toContain("sess-abcdefgh-1234");
    bar.setSessionId(undefined);
    expect(chip.hidden).toBe(true);
  });
});
