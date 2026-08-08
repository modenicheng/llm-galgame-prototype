// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { StageRenderer } from "./stage-renderer.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest, StageVisualState } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: { basement: { url: "/game-assets/backgrounds/basement.jpg" } },
  bgm: {},
  soundEffects: {},
  spriteSets: { suyao: { variants: { normal: { url: "/game-assets/characters/suyao/normal.png" }, anxious: { url: "/game-assets/characters/suyao/anxious.png" } } } },
};

function makeState(overrides: Partial<StageVisualState> = {}): StageVisualState {
  return {
    background: "basement",
    characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "left", displayName: "苏遥", visible: true } },
    ...overrides,
  };
}

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const resolver = new BrowserAssetResolver(manifest);
  const renderer = new StageRenderer(container, resolver);
  return { container, resolver, renderer };
}

describe("StageRenderer", () => {
  it("背景渲染为 <img> 且带 data-asset", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const img = container.querySelector<HTMLImageElement>(".stage__bg img");
    expect(img).not.toBeNull();
    expect(img?.dataset.asset).toBe("basement");
    expect(img?.src).toContain("/game-assets/backgrounds/basement.jpg");
  });

  it("角色首次出现创建 figure，换 variant 不重建节点", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char");
    const img = figure?.querySelector("img");
    expect(img?.getAttribute("src")).toContain("normal.png");
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "anxious", position: "left", displayName: "苏遥", visible: true } } }));
    const figure2 = container.querySelector<HTMLElement>("figure.stage__char");
    expect(figure2).toBe(figure);                    // 同一节点
    expect(figure2?.querySelector("img")?.getAttribute("src")).toContain("anxious.png");
  });

  it("position 变化只换 class", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char")!;
    expect(figure.classList.contains("stage__char--left")).toBe(true);
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "right", displayName: "苏遥", visible: true } } }));
    expect(figure.classList.contains("stage__char--right")).toBe(true);
    expect(figure.classList.contains("stage__char--left")).toBe(false);
  });

  it("visible=false 加 hidden，恢复后移除", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char")!;
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "left", displayName: "苏遥", visible: false } } }));
    expect(figure.hidden).toBe(true);
    renderer.apply(makeState());
    expect(figure.hidden).toBe(false);
  });

  it("无 manifest（resolver 全 undefined）回退占位：背景色块 + 角色占位 class", () => {
    const container = document.createElement("div");
    const renderer = new StageRenderer(container, new BrowserAssetResolver(null));
    renderer.apply(makeState());
    expect(container.querySelector(".stage__bg-item")).not.toBeNull();
    const figure = container.querySelector<HTMLElement>("figure.stage__char");
    expect(figure?.classList.contains("stage__char--placeholder")).toBe(true);
  });

  it("背景 img 加载失败（error 事件）移除坏图并回退占位色块", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const img = container.querySelector<HTMLImageElement>(".stage__bg img")!;
    img.dispatchEvent(new Event("error"));
    expect(container.querySelector(".stage__bg img")).toBeNull();
    const item = container.querySelector<HTMLElement>(".stage__bg-item");
    expect(item).not.toBeNull();
    expect(item?.dataset.asset).toBe("basement");
  });

  it("角色 img 加载失败加 placeholder class，后续有效 url 恢复", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char")!;
    const img = figure.querySelector<HTMLImageElement>("img")!;
    img.dispatchEvent(new Event("error"));
    expect(figure.classList.contains("stage__char--placeholder")).toBe(true);
    expect(img.hasAttribute("src")).toBe(false);
    // 后续 apply 换到有效 url：placeholder 移除、src 重设（重新加载）。
    renderer.apply(makeState());
    expect(figure.classList.contains("stage__char--placeholder")).toBe(false);
    expect(img.getAttribute("src")).toContain("normal.png");
  });

  it("角色离开舞台时移除节点", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    renderer.apply(makeState({ characters: {} }));
    expect(container.querySelectorAll("figure.stage__char").length).toBe(0);
  });

  it("重复 apply 幂等：不重复创建层", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    renderer.apply(makeState());
    expect(container.querySelectorAll(".stage__bg").length).toBe(1);
  });
});
