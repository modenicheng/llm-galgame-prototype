// @vitest-environment happy-dom
/**
 * PromptPanel tests — the writer prompt audit view. Feeds the real
 * MonitorModel with wire-shaped fixtures (writer.start / writer.prompt /
 * snapshot) and asserts the accordion renders origin labels, expansion
 * behavior, the pinned system block, and strip-continue follow-ups.
 */
import { describe, it, expect } from "vitest";
import { MonitorModel } from "./monitor-model.js";
import { PromptPanel } from "./prompt-panel.js";
import type { MonitorServerMessage } from "@shared/wire/monitor-message.js";

function startEvent(attemptId: string, taskId: string, index: number, startedAt: number): any {
  return {
    type: "writer.start",
    task: {
      taskId,
      taskType: "continuation",
      startedAt,
      lastActivityAt: startedAt,
      attempts: [
        {
          attemptId,
          index,
          state: "streaming",
          startedAt,
          endedAt: null,
          chars: 0,
          lines: 0,
          groups: 0,
          error: null,
          segmentEnd: null,
        },
      ],
    },
  };
}

function promptEvent(attemptId: string, requestIndex: number, messages: any[]): any {
  return { type: "writer.prompt", attemptId, requestIndex, messages };
}

const SYSTEM_MESSAGE = {
  role: "system" as const,
  segments: [
    { source: "prompts/dsl-protocol.txt", label: "DSL 协议", text: "协议正文。" },
    { source: "prompts/characters.txt", label: "角色设定", text: "\n\n===== 角色设定 =====\n\n角色A。" },
  ],
};

const USER_MESSAGES = [
  {
    role: "user" as const,
    segments: [
      { source: "runtime/history-window", label: "剧情历史（滑窗 3 条）", text: "===== 剧情历史 =====\n\n历史正文。" },
      { source: "prompts/instructions.yaml#continuation", label: "任务指令模板", text: "\n\n请继续。" },
    ],
  },
];

function mount(): { model: MonitorModel; list: HTMLElement; panel: PromptPanel } {
  const model = new MonitorModel();
  const list = document.createElement("div");
  const panel = new PromptPanel(model, { list });
  return { model, list, panel };
}

function apply(model: MonitorModel, events: any[]): void {
  const message: MonitorServerMessage = { type: "monitor.event", events };
  model.applyServerMessage(message);
}

describe("PromptPanel", () => {
  it("renders attempts newest-first with segment origin labels", () => {
    const { model, list } = mount();
    apply(model, [
      startEvent("continuation-a1#0", "continuation-a1", 0, 1_000),
      promptEvent("continuation-a1#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);
    apply(model, [
      startEvent("continuation-a2#0", "continuation-a2", 0, 2_000),
      promptEvent("continuation-a2#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);

    const items = list.querySelectorAll(".mon-prompt-item");
    expect(items).toHaveLength(2);
    // Newest (a2) first and auto-expanded.
    expect(items[0]!.className).not.toContain("is-collapsed");
    expect(items[1]!.className).toContain("is-collapsed");
    expect(items[0]!.textContent).toContain("续写 · 请求 #1");

    // Origin labels visible in the expanded item.
    const sources = Array.from(items[0]!.querySelectorAll(".mon-prompt-seg-src")).map(
      (node) => node.textContent,
    );
    expect(sources).toContain("runtime/history-window");
    expect(sources).toContain("prompts/instructions.yaml#continuation");

    // The pinned system block renders once from the folded event.
    expect(list.querySelectorAll(".mon-prompt-sys")).toHaveLength(1);
    expect(list.querySelector(".mon-prompt-sys-head")!.textContent).toContain("系统提示词");
  });

  it("groups a repair continuation with its original generation under one slice header", () => {
    const { model, list } = mount();
    // 同片两个任务（原始生成 + 修复续写）+ 一个独立片。
    apply(model, [
      {
        ...startEvent("continuation-a1#0", "continuation-a1", 0, 1_000),
        task: { ...startEvent("continuation-a1#0", "continuation-a1", 0, 1_000).task, sliceId: "slice-3" },
      },
      promptEvent("continuation-a1#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);
    apply(model, [
      {
        ...startEvent("continuation-a2#0", "continuation-a2", 0, 2_000),
        task: { ...startEvent("continuation-a2#0", "continuation-a2", 0, 2_000).task, sliceId: "slice-3" },
      },
      promptEvent("continuation-a2#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);
    const independent = startEvent("input-r3#0", "input-r3", 0, 3_000);
    independent.task.taskType = "input_response";
    apply(model, [independent, promptEvent("input-r3#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES])]);

    // 组头只出现在多生成的片上。
    const groups = list.querySelectorAll(".mon-prompt-slice-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.textContent).toContain("修复续写 ×1");
    // 排序：独立片（最新）在前，随后是同片组——组头之下是生成 #2（当前
    // 生效）再生成 #1（被覆盖）。片内条目标注生成序号；独立片保持原样。
    const items = list.querySelectorAll(".mon-prompt-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("输入回应 · 请求 #1");
    expect(items[1]!.textContent).toContain("生成 #2");
    expect(items[2]!.textContent).toContain("生成 #1");
    expect(items[1]!.previousElementSibling).toBe(groups[0]);
  });

  it("expands a segment's verbatim text on click and keeps it across re-renders", () => {
    const { model, list } = mount();
    apply(model, [
      startEvent("continuation-a1#0", "continuation-a1", 0, 1_000),
      promptEvent("continuation-a1#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);

    expect(list.querySelectorAll(".mon-prompt-seg-body")).toHaveLength(0);
    const segHead = list.querySelector(".mon-prompt-seg-head") as HTMLElement;
    segHead.click();
    let bodies = list.querySelectorAll(".mon-prompt-seg-body");
    expect(bodies).toHaveLength(1);
    // Verbatim slice, separators included.
    expect(bodies[0]!.textContent).toBe("===== 剧情历史 =====\n\n历史正文。");

    // A follow-up prompt report re-renders without losing the expansion.
    apply(model, [
      { type: "writer.delta", attemptId: "continuation-a1#0", text: "新内容" },
      promptEvent("continuation-a1#0", 1, [
        { role: "user", segments: [{ source: "runtime/strip-continue", label: "剔除续写指令", text: "续写指令。" }] },
      ]),
    ]);
    bodies = list.querySelectorAll(".mon-prompt-seg-body");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.textContent).toBe("===== 剧情历史 =====\n\n历史正文。");
  });

  it("does not re-render on plain writer deltas (writerPrompt topic only)", () => {
    const { model, list } = mount();
    apply(model, [
      startEvent("continuation-a1#0", "continuation-a1", 0, 1_000),
      promptEvent("continuation-a1#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
    ]);
    // A full re-render wipes the list (`textContent = ""`), so a manually
    // appended canary survives only if no re-render happened.
    const canary = document.createElement("div");
    canary.className = "canary";
    list.appendChild(canary);

    apply(model, [{ type: "writer.delta", attemptId: "continuation-a1#0", text: "流式内容" }]);
    expect(list.querySelector(".canary")).not.toBeNull();

    apply(model, [
      { type: "writer.end", taskId: "continuation-a1", attemptId: "continuation-a1#0", state: "done", error: null, segmentEnd: "buffer" },
    ]);
    expect(list.querySelector(".canary")).not.toBeNull();
  });

  it("shows the strip-continue follow-up as a labeled sub-request", () => {
    const { model, list } = mount();
    apply(model, [
      startEvent("continuation-a1#0", "continuation-a1", 0, 1_000),
      promptEvent("continuation-a1#0", 0, [SYSTEM_MESSAGE, ...USER_MESSAGES]),
      promptEvent("continuation-a1#0", 1, [
        { role: "user", segments: [{ source: "runtime/strip-continue", label: "剔除续写指令", text: "续写指令。" }] },
        { role: "assistant", segments: [{ source: "writer-output/prefix", label: "续写前缀（本 attempt 已输出）", text: "前缀\n" }] },
      ]),
    ]);

    const item = list.querySelector(".mon-prompt-item")!;
    expect(item.textContent).toContain("含续写 ×1");
    expect(item.textContent).toContain("续写请求 2（strip-continue）");
    const sources = Array.from(item.querySelectorAll(".mon-prompt-seg-src")).map(
      (node) => node.textContent,
    );
    expect(sources).toContain("runtime/strip-continue");
    expect(sources).toContain("writer-output/prefix");
  });

  it("restores everything from a monitor.snapshot (reconnect path)", () => {
    const { model, list } = mount();
    model.applyServerMessage({
      type: "monitor.snapshot",
      snapshot: {
        at: 3_000,
        info: {
          model: "test",
          narrativeMode: "event",
          apiBaseUrl: "",
          knownSpeakers: [],
          textBuffer: { startThresholdLines: 2, targetLines: 6, refillThresholdLines: 4 },
          eventMode: { wrapupInteractions: 6, closingPushInteractions: 8, maxInteractions: 10 },
        },
        writer: {
          tasks: [
            {
              taskId: "continuation-s1",
              taskType: "continuation",
              startedAt: 1_000,
              lastActivityAt: 2_000,
              attempts: [
                {
                  attemptId: "continuation-s1#0",
                  index: 0,
                  state: "done",
                  startedAt: 1_000,
                  endedAt: 2_000,
                  chars: 10,
                  lines: 2,
                  groups: 1,
                  error: null,
                  segmentEnd: "buffer",
                  text: "@end aaaa buffer",
                  truncated: false,
                  prompt: {
                    requests: [USER_MESSAGES],
                  },
                },
              ],
            },
          ],
          systemPrompt: SYSTEM_MESSAGE,
        },
        context: { tasks: [] },
        diagnostics: [],
        state: {
          at: 3_000,
          session: {} as any,
          status: {} as any,
          metrics: {} as any,
        },
      },
    });

    expect(list.querySelectorAll(".mon-prompt-item")).toHaveLength(1);
    expect(list.querySelector(".mon-prompt-sys-head")!.textContent).toContain("系统提示词");
    const sources = Array.from(list.querySelectorAll(".mon-prompt-seg-src")).map(
      (node) => node.textContent,
    );
    expect(sources).toContain("runtime/history-window");
  });
});
