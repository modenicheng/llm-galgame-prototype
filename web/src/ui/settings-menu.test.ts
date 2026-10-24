// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsMenu, type SettingsMenuHooks } from "./settings-menu.js";

function build(initial = { voiceVolume: 0.8, bgmVolume: 0.5, muted: false, textSpeed: 32 }): {
  root: HTMLElement;
  menu: SettingsMenu;
  hooks: SettingsMenuHooks & Record<string, ReturnType<typeof vi.fn>>;
} {
  const root = document.createElement("div");
  document.body.append(root);
  const hooks = {
    onVoiceVolume: vi.fn(),
    onBgmVolume: vi.fn(),
    onMute: vi.fn(),
    onTextSpeed: vi.fn(),
  };
  const menu = new SettingsMenu(root, hooks, initial);
  return { root, menu, hooks };
}

function panel(): HTMLElement {
  return document.querySelector(".settings-menu") as HTMLElement;
}

function slider(selector: string): HTMLInputElement {
  return panel().querySelector(selector) as HTMLInputElement;
}

describe("SettingsMenu", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts closed and toggles open/closed", () => {
    const { menu } = build();
    expect(menu.isOpen()).toBe(false);
    expect(panel().hidden).toBe(true);
    menu.toggle();
    expect(menu.isOpen()).toBe(true);
    expect(panel().hidden).toBe(false);
    menu.toggle();
    expect(menu.isOpen()).toBe(false);
    expect(panel().hidden).toBe(true);
  });

  it("renders initial values into the four rows", () => {
    build({ voiceVolume: 0.75, bgmVolume: 0.3, muted: true, textSpeed: 48 });
    expect(slider(".settings-menu__slider").value).toBe("75");
    const sliders = panel().querySelectorAll<HTMLInputElement>("input[type=range]");
    expect(sliders).toHaveLength(3);
    expect(sliders[1]!.value).toBe("30");
    const check = panel().querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(check.checked).toBe(true);
    expect(sliders[2]!.value).toBe("48");
    expect(panel().textContent).toContain("48 字/秒");
  });

  it("fires onVoiceVolume with a 0..1 value when the voice slider moves", () => {
    const { hooks } = build();
    const voice = slider(".settings-menu__slider");
    voice.value = "42";
    voice.dispatchEvent(new Event("input"));
    expect(hooks.onVoiceVolume).toHaveBeenCalledWith(0.42);
    expect(panel().textContent).toContain("42%");
  });

  it("fires onBgmVolume for the second slider and onTextSpeed for the third", () => {
    const { hooks } = build();
    const sliders = panel().querySelectorAll<HTMLInputElement>("input[type=range]");
    sliders[1]!.value = "10";
    sliders[1]!.dispatchEvent(new Event("input"));
    expect(hooks.onBgmVolume).toHaveBeenCalledWith(0.1);
    sliders[2]!.value = "44";
    sliders[2]!.dispatchEvent(new Event("input"));
    expect(hooks.onTextSpeed).toHaveBeenCalledWith(44);
  });

  it("fires onMute when the checkbox toggles", () => {
    const { hooks } = build();
    const check = panel().querySelector<HTMLInputElement>("input[type=checkbox]")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    expect(hooks.onMute).toHaveBeenCalledWith(true);
  });

  it("restores defaults and reports every change on 恢复默认", () => {
    const { hooks, menu } = build({ voiceVolume: 0.1, bgmVolume: 0.2, muted: true, textSpeed: 64 });
    menu.toggle();
    (panel().querySelector(".settings-menu__reset") as HTMLButtonElement).click();
    expect(hooks.onVoiceVolume).toHaveBeenCalledWith(1);
    expect(hooks.onBgmVolume).toHaveBeenCalledWith(1);
    expect(hooks.onMute).toHaveBeenCalledWith(false);
    expect(hooks.onTextSpeed).toHaveBeenCalledWith(32);
    expect(slider(".settings-menu__slider").value).toBe("100");
    expect(panel().querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(false);
  });

  it("closes on an outside click but not on clicks inside the panel or the anchor", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const anchored = new SettingsMenu(
      root,
      { onVoiceVolume: () => {}, onBgmVolume: () => {}, onMute: () => {}, onTextSpeed: () => {} },
      { voiceVolume: 1, bgmVolume: 1, muted: false, textSpeed: 32 },
      { anchor },
    );
    const ownPanel = root.querySelector(".settings-menu") as HTMLElement;
    anchored.open();
    expect(anchored.isOpen()).toBe(true);

    // Inside the panel: stays open.
    ownPanel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(anchored.isOpen()).toBe(true);
    // On the anchor (the 设置 trigger): the toggle owns that click.
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(anchored.isOpen()).toBe(true);
    // Anywhere else: closes.
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(anchored.isOpen()).toBe(false);
    // The document listener is detached after closing — a late outside click
    // must not re-enter the handler (and toggle() still works afterwards).
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(anchored.isOpen()).toBe(false);
    anchored.toggle();
    expect(anchored.isOpen()).toBe(true);
  });
});
