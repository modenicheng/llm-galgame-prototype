/**
 * Metrics tab — the runtime metrics snapshot as cards.
 */
import type { MonitorStateFrame } from "@shared/wire/monitor-message.js";
import { el } from "../../ui/dom.js";

/** MetricsSnapshot as it crosses the monitor wire (plain JSON). */
type MetricsSnapshotView = MonitorStateFrame["metrics"];

const REQUEST_LABELS: Record<string, string> = {
  opening: "开场",
  continuation: "续写",
  branch_prefetch: "分支预取",
  input_bridge: "过场桥接",
  input_response: "输入回应",
  speculative: "投机生成",
  plot_plan: "剧情规划",
  narrative_consolidation: "记忆整理",
  recap_summarization: "前情压缩",
};

function num(value: number | undefined): string {
  return value === undefined ? "0" : String(value);
}

function card(title: string, rows: [string, string][]): HTMLElement {
  const c = el("div", "kv-card");
  c.appendChild(el("h4", undefined, title));
  for (const [k, v] of rows) {
    const row = el("div", "row");
    row.appendChild(el("span", "k", k));
    row.appendChild(el("span", undefined, v));
    c.appendChild(row);
  }
  return c;
}

export function renderMetrics(container: HTMLElement, metrics: MetricsSnapshotView | undefined): void {
  container.textContent = "";
  if (metrics === undefined) {
    container.appendChild(el("div", "mon-empty", "等待指标…"));
    return;
  }

  const llm = metrics.llm;
  const grid = el("div", "kv-grid");

  const requestRows = Object.entries(llm.requests)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => [REQUEST_LABELS[key] ?? key, String(count)] as [string, string]);
  if (requestRows.length > 0) grid.appendChild(card("LLM 请求", requestRows));

  grid.appendChild(
    card("Token", [
      ["输入", num(llm.tokens.input)],
      ["输出", num(llm.tokens.output)],
      ["缓存命中输入", num(llm.tokens.cached_input)],
      ["缓存命中率", `${(llm.cache_hit_rate * 100).toFixed(1)}%`],
    ]),
  );
  grid.appendChild(
    card("延迟", [
      ["p50", `${llm.latency_ms.p50}ms`],
      ["p95", `${llm.latency_ms.p95}ms`],
      ["最大", `${llm.latency_ms.max}ms`],
      ["样本", num(llm.latency_ms.samples)],
    ]),
  );
  grid.appendChild(
    card("分支预取", [
      ["命中 / 请求", `${metrics.prefetch.branches_hit} / ${metrics.prefetch.branches_requested}`],
      ["命中率", `${(metrics.prefetch.hit_rate * 100).toFixed(1)}%`],
      ["未命中", num(metrics.prefetch.branches_missed)],
    ]),
  );
  grid.appendChild(
    card("输入", [
      ["预览次数", num(metrics.input.preview_count)],
      ["平均停留", `${Math.round(metrics.input.avg_dwell_ms)}ms`],
    ]),
  );
  grid.appendChild(
    card("错误与浪费", [
      ["schema 校验失败", num(metrics.errors.schema_validation_failures)],
      ["弃文本", `${(metrics.waste.text_bytes / 1024).toFixed(1)}KB`],
      ["弃音频", num(metrics.waste.audio_files)],
    ]),
  );
  grid.appendChild(
    card("玩家时序", [["选择→下一句样本", String(metrics.player.choice_to_next_line_ms.length)]]),
  );

  const assetDiags = metrics.asset_diagnostics;
  if (assetDiags !== undefined) {
    const rows = Object.entries(assetDiags).map(([code, count]) => [code, String(count)] as [string, string]);
    if (rows.length > 0) grid.appendChild(card("资产诊断", rows));
  }

  container.appendChild(grid);
}
