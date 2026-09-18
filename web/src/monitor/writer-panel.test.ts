/**
 * WriterPanel slice-layout tests（生成片文档结构）.
 *
 * Layout contract (修复续写插入式布局): the original generation keeps its
 * full banner and is NEVER collapsed (its streamed lines were played);
 * repair rounds are inserted AFTER it under small in-block banners; only
 * superseded repair rounds collapse (replacement exists solely between
 * repair rounds); same-round retries collapse under their own round.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { MonitorServerEvent, MonitorWriterTaskState } from "@shared/wire/monitor-message.js";
import { MonitorModel } from "./monitor-model.js";
import { WriterPanel } from "./writer-panel.js";

function attempt(attemptId: string, index: number, state: MonitorWriterTaskState) {
  return {
    attemptId,
    index,
    state,
    startedAt: 1_000 + index,
    endedAt: 2_000,
    chars: 10,
    lines: 2,
    groups: 1,
    error: state === "failed" ? "DSL 流在第 2 行之后结束但没有 @end 哨兵" : null,
    segmentEnd: "buffer",
  };
}

function startTask(taskId: string, sliceId: string, attempts: ReturnType<typeof attempt>[]) {
  return {
    type: "writer.start",
    task: {
      taskId,
      taskType: "continuation",
      sliceId,
      startedAt: 1_000,
      lastActivityAt: 2_000,
      attempts,
    },
  } as MonitorServerEvent;
}

interface Mount {
  model: MonitorModel;
  stream: HTMLElement;
}

function mount(): Mount {
  const model = new MonitorModel();
  const stream = document.createElement("div");
  new WriterPanel(model, {
    toolbar: document.createElement("div"),
    stream,
    foot: document.createElement("div"),
  });
  return { model, stream };
}

function feed(model: MonitorModel, events: MonitorServerEvent[]): void {
  model.applyServerMessage({ type: "monitor.event", events });
}

describe("WriterPanel slice layout", () => {
  it("inserts repair rounds after the original with mini banners; original never collapses", () => {
    const { model, stream } = mount();
    feed(model, [
      startTask("t1", "s1", [attempt("a1", 0, "failed")]),
      startTask("t2", "s1", [attempt("a2", 0, "done")]),
      startTask("t3", "s1", [attempt("a3", 0, "done")]),
    ]);

    const sections = stream.querySelectorAll(".writer-request");
    expect(sections).toHaveLength(1);
    const section = sections[0]!;

    // 原片：完整 boundary，直接是 section 子节点（未折叠），带修复计数 chip。
    const boundary = section.querySelector(".writer-request-boundary");
    expect(boundary).not.toBeNull();
    expect(boundary!.textContent).toContain("续写 · 生成 #1");
    expect(boundary!.textContent).toContain("修复续写 ×2");
    expect(boundary!.parentElement).toBe(section);

    // 修复轮：小型 banner，按轮次跟在原片后；最新轮可见（折叠块里的不算）。
    const banners = [...section.querySelectorAll(":scope > .writer-repair-banner")];
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toContain("修复续写 · 生成 #3");

    // 被覆盖的修复轮（生成 #2，失败）折叠在原位，展开后同样以 mini banner 呈现。
    const details = section.querySelector("details.writer-history-item");
    expect(details?.textContent).toContain("被覆盖的修复 · 生成 #2");
    expect(details?.querySelector(".writer-repair-banner")).not.toBeNull();

    // 文档顺序：原片 boundary → 原片正文 → 折叠的旧修复轮 → 最新修复 banner。
    const children = [...section.children];
    expect(children[0]!.className).toContain("writer-request-boundary");
    expect(children[1]!.className).toContain("writer-request-stream");
    const detailsIndex = children.findIndex((n) => n.tagName === "DETAILS");
    const bannerIndex = children.findIndex((n) => n.classList.contains("writer-repair-banner"));
    expect(detailsIndex).toBeGreaterThan(1);
    expect(bannerIndex).toBe(detailsIndex + 1);

    // 旧版"被覆盖的生成"整体折叠语义不再存在。
    expect(stream.textContent).not.toContain("被覆盖的生成");
  });

  it("single repair slice: original + one mini banner, nothing collapsed", () => {
    const { model, stream } = mount();
    feed(model, [
      startTask("t1", "s2", [attempt("a1", 0, "failed")]),
      startTask("t2", "s2", [attempt("a2", 0, "done")]),
    ]);

    const section = stream.querySelector(".writer-request")!;
    expect(section.querySelectorAll(".writer-request-boundary")).toHaveLength(1);
    expect(section.querySelectorAll(".writer-repair-banner")).toHaveLength(1);
    expect(section.querySelectorAll("details")).toHaveLength(0);
    expect(section.querySelector(".writer-repair-banner")!.textContent).toContain(
      "修复续写 · 生成 #2",
    );
  });

  it("same-round retries collapse under their own round", () => {
    const { model, stream } = mount();
    feed(model, [
      startTask("t1", "s3", [attempt("a1a", 0, "failed"), attempt("a1b", 1, "done")]),
    ]);

    const section = stream.querySelector(".writer-request")!;
    // 轮内最新尝试进完整 boundary，其余折叠为"重试"。
    expect(section.querySelector(".writer-request-boundary")!.textContent).toContain("生成 #1");
    const details = section.querySelector("details.writer-history-item");
    expect(details?.textContent).toContain("重试 ×1");
    expect(section.querySelectorAll(".writer-repair-banner")).toHaveLength(0);
  });

  it("live delta appends still target the right block via attemptId", () => {
    const { model, stream } = mount();
    feed(model, [
      startTask("t1", "s4", [attempt("a1", 0, "failed")]),
      startTask("t2", "s4", [attempt("a2", 0, "streaming")]),
      { type: "writer.delta", attemptId: "a2", text: "@end 7db buffer\n" } as MonitorServerEvent,
    ]);

    const banners = stream.querySelectorAll(".writer-repair-banner");
    expect(banners).toHaveLength(1);
    // streaming 尝试的正文进 mini banner 之后的流块（紧邻 banner 的兄弟节点）。
    const body = banners[0]!.nextElementSibling!;
    expect(body.classList.contains("writer-request-stream")).toBe(true);
    expect(body.textContent).toContain("@end 7db buffer");
    expect(banners[0]!.classList.contains("state-streaming")).toBe(true);
  });
});
