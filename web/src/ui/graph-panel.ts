/**
 * GraphPanel（执行清单 M5.1/M5.2）——总览场景图 + 决策子图的最小可视化。
 *
 * - 场景块按 `groupKey`（outline 物理地点，决议 D8）并排分组；同物理场景
 *   不同状态并列展示，组内保持剧情时序；
 * - 场景块内含决策节点（表单提示）与出边（选择文本）——M5.2 决策子图；
 * - 当前游标决策高亮；
 * - 纯 DOM（无图库依赖）。数据来自 GET /api/graph（脱敏视图，graph-view.ts）。
 */
import { el } from "./dom.js";

/** 与 src/application/graph/graph-view.ts 的视图形状对齐（JSON 松散解析）。 */
export interface GraphPanelView {
  gameId?: string;
  scenes?: Array<{
    sceneId?: string;
    groupKey?: string;
    status?: string;
    decisions?: Array<{
      id?: string;
      form?: { mode?: string; prompt?: string; options?: string[]; placeholder?: string };
      isCursor?: boolean;
    }>;
    outEdges?: Array<{
      id?: string;
      choiceText?: string;
      choiceKind?: string;
      to?: { kind?: string; id?: string };
      confluence?: { matchedNode?: string; judgedBy?: string; confidence?: number };
    }>;
  }>;
  cursor?: { runId?: string; decisionId?: string };
  runs?: { total?: number; ended?: number; abandoned?: number; active?: number };
}

export class GraphPanel {
  private readonly root: HTMLElement;
  private readonly content: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("graph-overlay");
    this.root.hidden = true;
    const closeBtn = el("button", "btn btn--ghost graph-panel__close", "关闭") as HTMLButtonElement;
    closeBtn.type = "button";
    closeBtn.addEventListener("click", () => this.hide());
    const header = el("div", "graph-panel__header") as HTMLDivElement;
    header.append(el("h2", "graph-panel__title", "剧情图"), closeBtn);
    this.content = el("div", "graph-panel__content") as HTMLDivElement;
    this.root.append(header, this.content);
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** 拉取并渲染（fetch 由调用方注入，便于测试）。失败不抛出、只显示提示。 */
  async refresh(fetchView: () => Promise<unknown>): Promise<void> {
    this.show();
    this.content.textContent = "";
    try {
      const view = await fetchView();
      this.render(view);
    } catch (err: unknown) {
      this.content.append(
        el("p", "graph-panel__error", `剧情图加载失败：${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  /** 渲染一个视图对象（refresh 的同步内核，测试直接驱动）。 */
  render(value: unknown): void {
    const view = asView(value);
    this.content.textContent = "";
    if (view === null) {
      this.content.append(el("p", "graph-panel__error", "剧情图数据格式不正确"));
      return;
    }
    const summary = el("p", "graph-panel__summary") as HTMLParagraphElement;
    const runs = view.runs ?? {};
    summary.textContent =
      `周目 ${runs.total ?? 0} · 完结 ${runs.ended ?? 0} · 弃局 ${runs.abandoned ?? 0} · 进行中 ${runs.active ?? 0}`;
    this.content.append(summary);

    // D8 分组：同 groupKey 的场景并列成组，组内保持时序。
    const groups = new Map<string, GraphPanelView["scenes"]>();
    for (const scene of view.scenes ?? []) {
      const key = scene.groupKey ?? "（未分组）";
      const bucket = groups.get(key);
      if (bucket !== undefined) bucket.push(scene);
      else groups.set(key, [scene]);
    }
    if (groups.size === 0) {
      this.content.append(el("p", "graph-panel__empty", "尚无已演出的剧情。"));
      return;
    }
    for (const [groupKey, scenes] of groups) {
      const group = el("section", "graph-group") as HTMLElement;
      group.append(el("h3", "graph-group__title", groupKey));
      for (const scene of scenes ?? []) group.append(this.renderScene(scene));
      this.content.append(group);
    }
  }

  private renderScene(scene: NonNullable<GraphPanelView["scenes"]>[number]): HTMLElement {
    const card = el("section", "graph-scene") as HTMLElement;
    if (scene.status === "realized") card.classList.add("graph-scene--realized");
    card.append(
      el("p", "graph-scene__id", `${scene.sceneId ?? ""}${scene.status === "realized" ? " · 已完结" : ""}`),
    );
    for (const decision of scene.decisions ?? []) {
      const isCursor = decision.isCursor === true;
      const node = el("div", `graph-decision${isCursor ? " graph-decision--cursor" : ""}`) as HTMLDivElement;
      const formPrompt = decision.form?.prompt ?? "";
      const mode = decision.form?.mode ?? "";
      node.append(
        el("span", "graph-decision__mode", mode),
        el("span", "graph-decision__prompt", formPrompt),
        isCursor ? el("span", "graph-decision__cursor-mark", "◀ 当前") : el("span", "", ""),
      );
      card.append(node);
    }
    // 出边按决策分组的轻量替代：边列表直接挂在场景卡尾部。
    const edges = scene.outEdges ?? [];
    if (edges.length > 0) {
      const edgeList = el("ul", "graph-edges") as HTMLUListElement;
      for (const edge of edges) {
        const item = el("li", "graph-edge") as HTMLLIElement;
        const confluenceMark =
          edge.confluence !== undefined ? " · 汇流" : "";
        const toKind = edge.to?.kind === "ending" ? " ⇒ 结局" : "";
        item.textContent = `「${edge.choiceText ?? ""}」${toKind}${confluenceMark}`;
        edgeList.append(item);
      }
      card.append(edgeList);
    }
    return card;
  }
}

function asView(value: unknown): GraphPanelView | null {
  if (typeof value !== "object" || value === null) return null;
  return value as GraphPanelView;
}
