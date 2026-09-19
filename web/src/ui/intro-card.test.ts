// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntroCard } from "./intro-card.js";
import { el } from "./dom.js";

/** Build the intro DOM skeleton exactly as layout.ts declares it. */
function buildRoot(): HTMLElement {
  const root = el("section", "intro") as HTMLElement;
  const card = el("div", "intro__card") as HTMLDivElement;
  card.append(
    el("p", "intro__eyebrow", "序"),
    el("h2", "intro__title", ""),
    el("p", "intro__text", ""),
  );
  root.append(card);
  root.hidden = true;
  document.body.append(root);
  return root;
}

describe("IntroCard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("starts hidden; show reveals the card with title and text", () => {
    const root = buildRoot();
    const card = new IntroCard(root);
    expect(root.hidden).toBe(true);

    card.show({ title: "规则我都懂，就是没赢过", text: "下午的阶梯教室里……" }, true);
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".intro__title")!.textContent).toBe("规则我都懂，就是没赢过");
    expect(root.querySelector(".intro__text")!.textContent).toBe("下午的阶梯教室里……");
  });

  it("compact mode hides eyebrow/text blocks but keeps the title", () => {
    const root = buildRoot();
    const card = new IntroCard(root);
    card.show({ title: "例会记录怎么全是兔子", text: "正文" }, false);
    expect(root.classList.contains("intro--compact")).toBe(true);
    expect(root.querySelector(".intro__title")!.textContent).toBe("例会记录怎么全是兔子");
    // compact 由 CSS display:none 收起，DOM 仍在（无标题时 hidden 属性兜底）。
    expect(root.querySelector(".intro__text")).not.toBeNull();
  });

  it("repeated show with the same content is a no-op (no animation restart)", () => {
    const root = buildRoot();
    const card = new IntroCard(root);
    const intro = { title: "T", text: "X" };
    card.show(intro, true);
    // Content mutation is observable: an unchanged re-show must not touch it.
    root.querySelector(".intro__title")!.textContent = "touched";
    card.show(intro, true);
    expect(root.querySelector(".intro__title")!.textContent).toBe("touched");

    card.show({ title: "T2", text: "X" }, true);
    expect(root.querySelector(".intro__title")!.textContent).toBe("T2");
  });

  it("hide fades out then conceals via animationend", () => {
    const root = buildRoot();
    const card = new IntroCard(root);
    card.show({ title: "T", text: "X" }, true);
    card.hide();
    expect(root.classList.contains("intro--out")).toBe(true);
    expect(root.hidden).toBe(false); // still visible while fading

    root.dispatchEvent(new Event("animationend"));
    expect(root.hidden).toBe(true);
    expect(root.classList.contains("intro--out")).toBe(false);
  });

  it("hide falls back to a timer when animationend is lost", () => {
    vi.useFakeTimers();
    const root = buildRoot();
    const card = new IntroCard(root);
    card.show({ title: "T", text: "X" }, true);
    card.hide();
    vi.advanceTimersByTime(600);
    expect(root.hidden).toBe(true);
  });

  it("show during the exit animation cancels it and keeps the card visible", () => {
    const root = buildRoot();
    const card = new IntroCard(root);
    card.show({ title: "T", text: "X" }, true);
    card.hide();
    card.show({ title: "T2", text: "X2" }, true);
    expect(root.classList.contains("intro--out")).toBe(false);
    expect(root.hidden).toBe(false);
    expect(root.querySelector(".intro__title")!.textContent).toBe("T2");
    // The stale exit failsafe must not conceal the re-shown card.
    root.dispatchEvent(new Event("animationend"));
    expect(root.hidden).toBe(false);
  });
});
