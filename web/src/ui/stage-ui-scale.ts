/**
 * 主 UI 随 16:9 舞台框等比缩放。
 *
 * `.scene`（对白/选项/输入/等待）挂在 16:9 舞台框内，但其中的字号与间距
 * 是按 1280px 宽的参考设计写的固定 px——舞台框随视口 letterbox 缩放时，
 * 不缩放的 UI 会在大窗口下相对背景偏小、小窗口下偏挤。这里以
 * ResizeObserver 跟踪舞台框宽度，写入 `--ui-scale = 框宽 / 1280`，由
 * styles.css 里 `.scene { transform: scale(var(--ui-scale)) }` 统一应用
 * （transform-origin 舞台底部中点，构图锚点不变）。立绘本身按框高的
 * 百分比定位，天然随框缩放，不在此列。
 */
/** 场景 px 设计所对应的舞台框参考宽度。 */
const UI_REFERENCE_WIDTH = 1280;

export function installStageUiScale(frame: HTMLElement): void {
  // 无 ResizeObserver（测试环境/老浏览器）时保持 1:1，不写变量。
  if (typeof ResizeObserver === "undefined") return;
  const apply = (width: number): void => {
    if (!(width > 0)) return;
    const scale = Math.round((width / UI_REFERENCE_WIDTH) * 10000) / 10000;
    frame.style.setProperty("--ui-scale", String(scale));
  };
  apply(frame.getBoundingClientRect().width);
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) apply(entry.contentRect.width);
  });
  observer.observe(frame);
}
