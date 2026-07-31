import type { ChoiceEvent, ChoiceOption, RuntimePlayableEvent } from "./schema.js";
import type { RuntimeStatus } from "./status.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Unselected branches may be cancelled and never awaited.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

type EntryState = "queued" | "running" | "ready" | "failed" | "cancelled";

interface BranchEntry {
  option: ChoiceOption;
  state: EntryState;
  controller: AbortController;
  deferred: Deferred<RuntimePlayableEvent[]>;
  events: RuntimePlayableEvent[];
  error: Error | null;
}

export interface BranchPrefetchOptions {
  choice: ChoiceEvent;
  concurrency: number;
  status: RuntimeStatus;
  generate: (
    option: ChoiceOption,
    signal: AbortSignal,
    onEvent: (event: RuntimePlayableEvent) => void,
  ) => Promise<RuntimePlayableEvent[]>;
  onEvent?: (option: ChoiceOption, event: RuntimePlayableEvent) => void;
  onReady?: (option: ChoiceOption, events: RuntimePlayableEvent[]) => void;
}

export interface LiveBranchSelection {
  events: RuntimePlayableEvent[];
  done: Promise<RuntimePlayableEvent[]>;
}

export class BranchPrefetchGroup {
  private readonly entries = new Map<string, BranchEntry>();
  private readonly queue: string[] = [];
  private active = 0;
  private started = false;

  constructor(private readonly options: BranchPrefetchOptions) {
    for (const option of options.choice.options) {
      const entry: BranchEntry = {
        option,
        state: "queued",
        controller: new AbortController(),
        deferred: createDeferred<RuntimePlayableEvent[]>(),
        events: [],
        error: null
      };
      this.entries.set(option.id, entry);
      this.queue.push(option.id);
      this.syncStatus(entry);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pump();
  }

  async take(optionId: string): Promise<RuntimePlayableEvent[]> {
    const selected = this.entries.get(optionId);
    if (!selected) throw new Error(`未知分支选项：${optionId}`);

    this.cancelUnselected(optionId);

    if (selected.state === "queued") {
      this.removeFromQueue(optionId);
      this.startEntry(selected, true);
    }

    return selected.deferred.promise;
  }

  /**
   * Select a branch without waiting for its generation to finish. Events that
   * have already arrived are returned immediately; later events remain in the
   * same generation task and are observable through `done`.
   */
  selectLive(optionId: string): LiveBranchSelection {
    const selected = this.entries.get(optionId);
    if (!selected) throw new Error(`未知分支选项：${optionId}`);

    this.cancelUnselected(optionId);
    if (selected.state === "queued") {
      this.removeFromQueue(optionId);
      this.startEntry(selected, true);
    }

    return { events: selected.events, done: selected.deferred.promise };
  }

  cancelAll(): void {
    for (const entry of this.entries.values()) this.cancelEntry(entry);
  }

  private pump(): void {
    while (this.active < this.options.concurrency && this.queue.length > 0) {
      const optionId = this.queue.shift();
      if (!optionId) break;
      const entry = this.entries.get(optionId);
      if (!entry || entry.state !== "queued") continue;
      this.startEntry(entry, false);
    }
  }

  private startEntry(entry: BranchEntry, priority: boolean): void {
    if (entry.state !== "queued") return;
    entry.state = "running";
    this.active += 1;
    this.options.status.setJob(
      `branch:${entry.option.id}`,
      `${priority ? "已选分支" : "分支"}：${entry.option.text}`,
      "running"
    );
    this.syncStatus(entry);

    void this.options
      .generate(entry.option, entry.controller.signal, (event) => {
        if (entry.controller.signal.aborted) return;
        entry.events.push(event);
        this.options.onEvent?.(entry.option, event);
        this.syncStatus(entry);
      })
      .then((events) => {
        if (entry.controller.signal.aborted) return;
        // A provider may return a complete batch without invoking onEvent.
        if (entry.events.length === 0) entry.events.push(...events);
        entry.state = "ready";
        entry.deferred.resolve(entry.events);
        this.options.onReady?.(entry.option, entry.events);
        this.options.status.setJob(
          `branch:${entry.option.id}`,
          `分支：${entry.option.text}`,
          "ready"
        );
        this.syncStatus(entry);
      })
      .catch((error: unknown) => {
        if (entry.controller.signal.aborted) {
          entry.state = "cancelled";
          const abortError = new Error(`分支预取已取消：${entry.option.text}`);
          abortError.name = "AbortError";
          entry.error = abortError;
          entry.deferred.reject(abortError);
          this.options.status.setJob(
            `branch:${entry.option.id}`,
            `分支：${entry.option.text}`,
            "cancelled"
          );
          this.syncStatus(entry);
          return;
        }

        const normalized = error instanceof Error ? error : new Error(String(error));
        entry.error = normalized;
        entry.state = "failed";
        entry.deferred.reject(normalized);
        this.options.status.setJob(
          `branch:${entry.option.id}`,
          `分支：${entry.option.text}`,
          "failed",
          normalized.message
        );
        this.syncStatus(entry);
      })
      .finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.pump();
      });
  }

  private cancelUnselected(selectedId: string): void {
    for (const [optionId, entry] of this.entries) {
      if (optionId === selectedId) continue;
      this.cancelEntry(entry);
    }
  }

  private cancelEntry(entry: BranchEntry): void {
    if (entry.state === "ready" || entry.state === "failed" || entry.state === "cancelled") {
      return;
    }

    if (entry.state === "queued") {
      this.removeFromQueue(entry.option.id);
      entry.state = "cancelled";
      const abortError = new Error(`分支预取已取消：${entry.option.text}`);
      abortError.name = "AbortError";
      entry.error = abortError;
      entry.deferred.reject(abortError);
      this.options.status.setJob(
        `branch:${entry.option.id}`,
        `分支：${entry.option.text}`,
        "cancelled"
      );
      this.syncStatus(entry);
      return;
    }

    entry.controller.abort();
  }

  private removeFromQueue(optionId: string): void {
    const index = this.queue.indexOf(optionId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private syncStatus(entry: BranchEntry): void {
    const events = entry.events;
    const dialogueCount = events.filter((event) => event.type === "dialogue").length;
    this.options.status.setBranch(
      entry.option.id,
      entry.option.text,
      entry.state,
      events.length,
      dialogueCount,
      entry.error?.message ?? null
    );
  }
}
