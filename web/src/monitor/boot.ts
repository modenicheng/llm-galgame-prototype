/**
 * boot — monitor dashboard bootstrap. Mounted by main.ts when the page
 * route is /monitor (same SPA shell, same Local Session Token).
 */
import "./monitor.css";
import { MonitorClient } from "./monitor-client.js";
import { MonitorModel } from "./monitor-model.js";
import { WriterPanel } from "./writer-panel.js";
import { ContextPanel } from "./context-panel.js";
import { PromptPanel } from "./prompt-panel.js";
import { StatusBar } from "./status-bar.js";
import { deriveStoryGraph, renderStoryGraph } from "./tabs/story-graph.js";
import { renderStoryState } from "./tabs/story-state-tab.js";
import { renderMetrics } from "./tabs/metrics-tab.js";
import { renderDiagnostics, renderEvents } from "./tabs/logs-tab.js";
import { el } from "../ui/dom.js";

type TabId = "graph" | "state" | "metrics" | "events" | "logs";
type RightTabId = "prompt" | "context";

const TABS: { id: TabId; label: string }[] = [
  { id: "graph", label: "剧情图" },
  { id: "state", label: "剧情状态" },
  { id: "metrics", label: "指标" },
  { id: "events", label: "事件" },
  { id: "logs", label: "日志" },
];

function panel(title: string, accent: string): { panel: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const panelEl = el("div", "mon-panel");
  const head = el("div", "mon-panel-head");
  head.appendChild(el("span", "mon-accent", accent));
  if (title !== "") head.appendChild(el("span", undefined, title));
  panelEl.appendChild(head);
  const body = el("div");
  body.style.flex = "1";
  body.style.minHeight = "0";
  body.style.display = "flex";
  body.style.flexDirection = "column";
  panelEl.appendChild(body);
  return { panel: panelEl, head, body };
}

export function bootMonitor(root: HTMLElement): void {
  document.title = "监控后台 · 灯影夜话";
  const model = new MonitorModel();

  root.textContent = "";
  const shell = el("div", "mon-root");

  // --- Left: writer LLM panel (largest block) ---
  const writer = panel("编剧 LLM · 实时 DSL 流", "▍");
  writer.panel.classList.add("mon-writer");
  const toolbar = el("div", "mon-taskbar writer-document-toolbar");
  const stream = el("div", "mon-stream");
  const foot = el("div", "mon-writer-foot");
  writer.body.appendChild(toolbar);
  writer.body.appendChild(stream);
  writer.body.appendChild(foot);
  shell.appendChild(writer.panel);
  new WriterPanel(model, { toolbar, stream, foot });

  // --- Right top: writer prompt audit (default) / async context LLM, tabbed
  // inside the panel head so the switch costs no vertical space ---
  const right = el("div", "mon-right");
  const rightTop = panel("", "▍");
  const headTabs = el("div", "mon-head-tabs");
  const promptList = el("div", "mon-prompt-list");
  const contextList = el("div", "mon-context-list");
  const RIGHT_TABS: { id: RightTabId; label: string }[] = [
    { id: "prompt", label: "编剧输入" },
    { id: "context", label: "异步上下文" },
  ];
  let activeRightTab: RightTabId = "prompt";
  for (const tab of RIGHT_TABS) {
    const btn = el("button", "mon-tab mon-tab--head", tab.label);
    btn.dataset.tabId = tab.id;
    btn.addEventListener("click", () => {
      activeRightTab = tab.id;
      syncRightTabUI();
    });
    headTabs.appendChild(btn);
  }
  rightTop.head.appendChild(headTabs);
  rightTop.body.appendChild(promptList);
  rightTop.body.appendChild(contextList);
  right.appendChild(rightTop.panel);
  function syncRightTabUI(): void {
    for (const button of Array.from(headTabs.children) as HTMLElement[]) {
      const id = button.dataset.tabId as RightTabId | undefined;
      button.classList.toggle("is-active", id === activeRightTab);
    }
    promptList.style.display = activeRightTab === "prompt" ? "block" : "none";
    contextList.style.display = activeRightTab === "context" ? "block" : "none";
  }
  syncRightTabUI();
  new PromptPanel(model, { list: promptList });
  new ContextPanel(model, { list: contextList });

  // --- Right bottom: tabs (story graph + all other game state) ---
  const tabs = panel("剧情图 / 游戏状态", "▍");
  const tabbar = el("div", "mon-tabbar");
  const tabbody = el("div", "mon-tabbody");
  const tabBodies = new Map<TabId, HTMLElement>();
  let activeTab: TabId = "graph";
  for (const tab of TABS) {
    const btn = el("button", "mon-tab", tab.label);
    btn.dataset.tabId = tab.id;
    btn.addEventListener("click", () => {
      activeTab = tab.id;
      syncTabUI();
    });
    tabbar.appendChild(btn);
    const body = el("div");
    body.style.display = "none";
    tabBodies.set(tab.id, body);
    tabbody.appendChild(body);
  }
  tabs.body.appendChild(tabbar);
  tabs.body.appendChild(tabbody);
  right.appendChild(tabs.panel);
  shell.appendChild(right);

  function syncTabUI(): void {
    for (const button of Array.from(tabbar.children) as HTMLElement[]) {
      const id = button.dataset.tabId as TabId | undefined;
      button.classList.toggle("is-active", id === activeTab);
    }
    for (const [id, body] of tabBodies) {
      body.style.display = id === activeTab ? "block" : "none";
    }
    renderTabs(true);
  }

  // --- Bottom: status bar ---
  const statusBar = el("div", "mon-statusbar");
  shell.appendChild(statusBar);
  const bar = new StatusBar(model, { bar: statusBar });
  window.addEventListener("pagehide", () => bar.dispose(), { once: true });

  root.appendChild(shell);

  // ---- Tab rendering (guarded: only the active tab renders; the graph
  // only rebuilds when the timeline actually changed) ----
  let lastGraphKey = "";
  function renderTabs(force: boolean): void {
    const state = model.state;
    if (activeTab === "graph") {
      if (state === null) return;
      const session = state.session;
      const graph = deriveStoryGraph(session.timeline);
      const key = JSON.stringify([
        session.lastSeq,
        session.eventCount,
        graph.hasEnding,
        Object.keys(state.status.branches),
      ]);
      if (!force && key === lastGraphKey) return;
      lastGraphKey = key;
      renderStoryGraph(
        tabBodies.get("graph")!,
        graph,
        {
          interactionCount: session.endingPressure.interactionCount,
          wrapupAt: session.endingPressure.wrapupAt,
          closingPushAt: session.endingPressure.closingPushAt,
          maxAt: session.endingPressure.maxAt,
        },
        state.status.branches,
      );
    } else if (activeTab === "state") {
      renderStoryState(tabBodies.get("state")!, state?.session.storyState);
    } else if (activeTab === "metrics") {
      renderMetrics(tabBodies.get("metrics")!, state?.metrics);
    } else if (activeTab === "events") {
      if (state !== null) renderEvents(tabBodies.get("events")!, state.session.timeline);
    } else if (activeTab === "logs") {
      renderDiagnostics(tabBodies.get("logs")!, model.diagnostics);
    }
  }

  model.subscribe((topic) => {
    if (topic === "state") renderTabs(false);
    else if (topic === "diagnostics" && activeTab === "logs") renderTabs(false);
  });

  // Token comes from the page URL exactly like the game page (§8.3).
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const client = new MonitorClient({
    wsUrl: `${proto}://${window.location.host}/ws/monitor`,
    token,
    onMessage: (message) => model.applyServerMessage(message),
    onConnectionChange: (state) => model.setConnection(state),
  });
  client.connect();
}
