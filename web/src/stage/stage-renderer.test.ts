/**
 * StageRenderer DOM tests (§86 web): layer creation, background/character
 * rendering from the wire visual state, hidden handling, and idempotent
 * re-apply (no layer duplication).
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { deterministicHue, StageRenderer } from "./stage-renderer.js";
import type { StageVisualState } from "./stage-types.js";

function baseState(): StageVisualState {
  return {
    background: "rainy_street",
    bgm: "rain_loop",
    characters: {
      aoi: {
        spriteSet: "aoi",
        variant: "normal",
        position: "left",
        displayName: "青",
        visible: true,
      },
      raito: {
        spriteSet: "raito",
        variant: "serious",
        position: "center",
        displayName: "来斗",
        visible: false,
      },
    },
  };
}

describe("StageRenderer", () => {
  it("renders background, characters, positions and hidden flags from visual state", () => {
    const container = document.createElement("div");
    const renderer = new StageRenderer(container);

    renderer.apply(baseState());

    // The two renderer-owned layers exist exactly once.
    expect(container.querySelectorAll(".stage__bg").length).toBe(1);
    expect(container.querySelectorAll(".stage__chars").length).toBe(1);

    const bgItem = container.querySelector(".stage__bg-item");
    expect(bgItem?.getAttribute("data-asset")).toBe("rainy_street");
    expect(bgItem?.textContent).toContain("rainy_street");

    const chars = container.querySelectorAll(".stage__char[data-char]");
    expect(chars.length).toBe(2);

    const aoi = container.querySelector('.stage__char[data-char="aoi"]');
    expect(aoi?.classList.contains("stage__char--left")).toBe(true);
    expect((aoi as HTMLElement | null)?.hidden).toBe(false);

    const raito = container.querySelector('.stage__char[data-char="raito"]');
    expect(raito?.classList.contains("stage__char--center")).toBe(true);
    expect((raito as HTMLElement | null)?.hidden).toBe(true);

    // Character label shows displayName · spriteSet/variant.
    expect(container.textContent).toContain("来斗 · raito/serious");

    // BGM visual indicator on the container.
    expect(container.dataset.bgm).toBe("rain_loop");
  });

  it("is idempotent: re-applying a state does not duplicate layers", () => {
    const container = document.createElement("div");
    const renderer = new StageRenderer(container);

    renderer.apply(baseState());
    renderer.apply(baseState());

    expect(container.querySelectorAll(".stage__bg").length).toBe(1);
    expect(container.querySelectorAll(".stage__chars").length).toBe(1);
    expect(container.querySelectorAll(".stage__bg-item").length).toBe(1);
    expect(container.querySelectorAll(".stage__char[data-char]").length).toBe(2);
  });

  it("clears the stage when a state has no background or characters", () => {
    const container = document.createElement("div");
    const renderer = new StageRenderer(container);

    renderer.apply(baseState());
    renderer.apply({ characters: {} });

    expect(container.querySelectorAll(".stage__bg-item").length).toBe(0);
    expect(container.querySelectorAll(".stage__char").length).toBe(0);
    expect(container.hasAttribute("data-bgm")).toBe(false);
  });

  it("produces a deterministic hue for a given key", () => {
    expect(deterministicHue("aoi")).toBe(deterministicHue("aoi"));
    expect(deterministicHue("rainy_street")).toBe(deterministicHue("rainy_street"));
    expect(deterministicHue("anything")).toBeGreaterThanOrEqual(0);
    expect(deterministicHue("anything")).toBeLessThan(360);
  });
});
