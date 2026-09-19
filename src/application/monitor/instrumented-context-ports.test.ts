/**
 * instrumentMemoryAgent 测试——记忆代理到监控「异步上下文」面板的
 * 生命周期装饰：提案→done+JSON、null→done（端口契约允许"无增量或
 * 提取失败"）、异常→failed 且原样穿透、空批次不留任务。
 * hub 自身的任务环形/事件广播由 monitor-hub.test.ts 覆盖，这里只验证
 * 装饰器的接线行为，故用录音桩。
 */
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../schema.js";
import type {
  MemoryAgentProposal,
  SessionMemoryAgentPort,
} from "../../core/ports/session-memory-agent-port.js";
import type { StoryState } from "../../story/types.js";
import type {
  MonitorContextTaskKind,
  MonitorContextTaskState,
} from "../../shared/wire/monitor-message.js";
import type { MonitorHub } from "./monitor-hub.js";
import { instrumentMemoryAgent } from "./instrumented-context-ports.js";

/** 只实现装饰器用到的两个方法，记录任务生命周期。 */
class RecordingHub {
  private seq = 0;
  readonly tasks = new Map<
    string,
    { kind: MonitorContextTaskKind; detail: string; state?: MonitorContextTaskState; output?: string | null; error?: string | null }
  >();

  contextStart(kind: MonitorContextTaskKind, detail: string): string {
    const id = `${kind}-${++this.seq}`;
    this.tasks.set(id, { kind, detail });
    return id;
  }

  contextEnd(
    id: string,
    patch: { state: MonitorContextTaskState; output?: string; error?: string },
  ): void {
    const task = this.tasks.get(id);
    if (task === undefined) return;
    task.state = patch.state;
    if (patch.output !== undefined) task.output = patch.output;
    if (patch.error !== undefined) task.error = patch.error;
  }
}

function makeEvents(seqFirst: number, seqLast: number): StoredEvent[] {
  return [seqFirst, seqLast].map((seq) => ({ seq }) as unknown as StoredEvent);
}

function makeInner(
  impl: (events: readonly StoredEvent[]) => Promise<MemoryAgentProposal | null>,
): SessionMemoryAgentPort & { calls: readonly StoredEvent[][] } {
  const calls: StoredEvent[][] = [];
  return {
    calls,
    derive: (events) => {
      calls.push([...events]);
      return impl(events);
    },
  } as SessionMemoryAgentPort & { calls: readonly StoredEvent[][] };
}

const state = { scene: { id: "s1" } } as unknown as StoryState;

describe("instrumentMemoryAgent", () => {
  it("reports a proposal as done with its JSON output", async () => {
    const hub = new RecordingHub();
    const proposal: MemoryAgentProposal = {
      canon: { "牌子去向": "收摊时不要送走" },
      characters: { raspberry: { emotion: "安心" } },
    };
    const inner = makeInner(() => Promise.resolve(proposal));
    const result = await instrumentMemoryAgent(inner, hub as unknown as MonitorHub).derive(
      makeEvents(21, 40),
      state,
    );

    expect(result).toBe(proposal);
    expect(hub.tasks.size).toBe(1);
    const task = [...hub.tasks.values()][0]!;
    expect(task.kind).toBe("memory_agent");
    expect(task.detail).toBe("事件 21–40（2 条）");
    expect(task.state).toBe("done");
    expect(JSON.parse(task.output ?? "")).toEqual(proposal);
  });

  it("labels a null proposal as done without inventing success detail", async () => {
    const hub = new RecordingHub();
    const inner = makeInner(() => Promise.resolve(null));
    await instrumentMemoryAgent(inner, hub as unknown as MonitorHub).derive(
      makeEvents(41, 55),
      state,
    );

    const task = [...hub.tasks.values()][0]!;
    expect(task.state).toBe("done");
    expect(task.output).toContain("无产出");
  });

  it("marks a rejection as failed and propagates it", async () => {
    const hub = new RecordingHub();
    const inner = makeInner(() => Promise.reject(new Error("boom")));
    const decorated = instrumentMemoryAgent(inner, hub as unknown as MonitorHub);
    await expect(decorated.derive(makeEvents(1, 9), state)).rejects.toThrow("boom");

    const task = [...hub.tasks.values()][0]!;
    expect(task.state).toBe("failed");
    expect(task.error).toBe("boom");
  });

  it("does not create a panel task for an empty batch", async () => {
    const hub = new RecordingHub();
    const inner = makeInner(() => Promise.resolve(null));
    await instrumentMemoryAgent(inner, hub as unknown as MonitorHub).derive([], state);

    expect(hub.tasks.size).toBe(0);
    expect(inner.calls.length).toBe(1);
  });
});
