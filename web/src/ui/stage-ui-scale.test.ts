// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStageUiScale } from "./stage-ui-scale.js";

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.last = this;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  /** Test helper: fire the observed resize. */
  emit(width: number): void {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

describe("installStageUiScale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.last = null;
  });

  it("按框宽/1280 写入 --ui-scale，并随 resize 更新", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const frame = document.createElement("div");
    installStageUiScale(frame);
    expect(FakeResizeObserver.last).not.toBeNull();

    FakeResizeObserver.last!.emit(1920);
    expect(frame.style.getPropertyValue("--ui-scale")).toBe("1.5");

    FakeResizeObserver.last!.emit(960);
    expect(frame.style.getPropertyValue("--ui-scale")).toBe("0.75");

    // 小数保留 4 位，不产生超长浮点串。
    FakeResizeObserver.last!.emit(1365);
    expect(frame.style.getPropertyValue("--ui-scale")).toBe("1.0664");
  });

  it("缺 ResizeObserver（老浏览器/测试环境）时保持 1:1：不写变量也不抛错", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const frame = document.createElement("div");
    expect(() => installStageUiScale(frame)).not.toThrow();
    expect(frame.style.getPropertyValue("--ui-scale")).toBe("");
  });
});
