/**
 * Instrumented context-LLM ports — thin decorators that report the
 * background context-management LLMs' lifecycle to the MonitorHub.
 *
 * These calls do not stream (single completion per call), so the monitor
 * sees start → final output / fallback / error. Wrappers preserve the
 * inner port's contract exactly: same resolution values, same rejections.
 */
import type { RecapSummarizerPort } from "../../core/ports/recap-summarizer-port.js";
import type {
  SessionMemoryAgentPort,
} from "../../core/ports/session-memory-agent-port.js";
import type { StoredEvent } from "../../schema.js";
import type { MemoryConsolidatorPort } from "../narrative/memory-consolidator.js";
import type { PlotPlannerPort } from "../narrative/plot-planner.js";
import type { MonitorHub } from "./monitor-hub.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventRangeDetail(events: readonly StoredEvent[]): string {
  if (events.length === 0) return "空批次";
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return `事件 ${first.seq}–${last.seq}（${events.length} 条）`;
}

/**
 * Recap adapter contract: returns null when the LLM call failed internally
 * (the Game then applies the deterministic digest) — surfaced as "fallback".
 */
export function instrumentRecapSummarizer(
  inner: RecapSummarizerPort,
  monitor: MonitorHub,
): RecapSummarizerPort {
  return {
    summarize: (events, context) => {
      const id = monitor.contextStart("recap", eventRangeDetail(events));
      return inner.summarize(events, context).then(
        (output) => {
          monitor.contextEnd(
            id,
            output !== null && output.length > 0
              ? { state: "done", output }
              : { state: "fallback" },
          );
          return output;
        },
        (error: unknown) => {
          monitor.contextEnd(id, { state: "failed", error: errorMessage(error) });
          throw error;
        },
      );
    },
  };
}

export function instrumentMemoryConsolidator(
  inner: MemoryConsolidatorPort,
  monitor: MonitorHub,
): MemoryConsolidatorPort {
  return {
    consolidate: (request) => {
      const id = monitor.contextStart("consolidation", eventRangeDetail(request.events));
      return inner.consolidate(request).then(
        (result) => {
          monitor.contextEnd(id, {
            state: "done",
            output: JSON.stringify(
              {
                episode: {
                  summary: result.episode.summary,
                  characters: result.episode.characters,
                  threads: result.episode.threads,
                },
                threadOps: result.threadOps.length,
                setupOps: result.setupOps.length,
              },
              null,
              2,
            ),
          });
          return result;
        },
        (error: unknown) => {
          monitor.contextEnd(id, { state: "failed", error: errorMessage(error) });
          throw error;
        },
      );
    },
  };
}

export function instrumentPlotPlanner(
  inner: PlotPlannerPort,
  monitor: MonitorHub,
): PlotPlannerPort {
  return {
    plan: (request) => {
      const id = monitor.contextStart(
        "plot_plan",
        `checkpoint ${request.memory.checkpointCount} 重新规划`,
      );
      return inner.plan(request).then(
        (proposal) => {
          monitor.contextEnd(id, {
            state: "done",
            output: JSON.stringify(
              {
                phase: proposal.phase,
                goal: proposal.currentGoal,
                beats: proposal.beats.length,
                focusThreads: proposal.focusThreads,
              },
              null,
              2,
            ),
          });
          return proposal;
        },
        (error: unknown) => {
          monitor.contextEnd(id, { state: "failed", error: errorMessage(error) });
          throw error;
        },
      );
    },
  };
}

/**
 * Event 模式记忆代理（每轮末尾的状态提取）——异步面板上最高频的后台
 * LLM。端口契约：null = 本批无可提取内容或提取失败（解析跳过的原文
 * 摘录走 diagnostics → 「日志」tab），装饰器只如实标注不做二次推断。
 */
export function instrumentMemoryAgent(
  inner: SessionMemoryAgentPort,
  monitor: MonitorHub,
): SessionMemoryAgentPort {
  return {
    derive: (events, state) => {
      // 与适配器的首道短路一致：空批次不会发请求，不留面板噪声。
      if (events.length === 0) return inner.derive(events, state);
      const id = monitor.contextStart("memory_agent", eventRangeDetail(events));
      return inner.derive(events, state).then(
        (proposal) => {
          monitor.contextEnd(
            id,
            proposal !== null
              ? { state: "done", output: JSON.stringify(proposal, null, 2) }
              : { state: "done", output: "（本批无产出：无增量或提取失败，详见日志）" },
          );
          return proposal;
        },
        (error: unknown) => {
          monitor.contextEnd(id, { state: "failed", error: errorMessage(error) });
          throw error;
        },
      );
    },
  };
}
