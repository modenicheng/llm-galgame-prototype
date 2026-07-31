import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioConfig } from "./config.js";
import type { RuntimePlayableEvent } from "./schema.js";
import type { RuntimeStatus } from "./status.js";

export type AssetState = "idle" | "queued" | "generating" | "ready" | "failed" | "cancelled";

export interface AudioAsset {
  lineId: string;
  path: string;
}

export interface AudioSynthesizer {
  synthesize(lines: RuntimePlayableEvent[], signal: AbortSignal): Promise<AudioAsset[]>;
}

export interface MediaMetrics {
  totalSynthesisRequests: number;
  totalLinesSynthesized: number;
  totalSynthesisFailures: number;
  totalLinesCancelled: number;
  totalBranchesPrefetched: number;
  totalActiveLinesSynthesized: number;
  totalSynthesisLatencyMs: number;
  synthesisCount: number;
}

interface QueueJob {
  lines: RuntimePlayableEvent[];
  branchId: string | null;
  controller: AbortController;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error("Audio synthesis aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const error = new Error("Audio synthesis aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true }
    );
  });
}

export class MockAudioSynthesizer implements AudioSynthesizer {
  constructor(
    private readonly outputDir: string,
    private readonly latencyMs: number
  ) {}

  async synthesize(lines: RuntimePlayableEvent[], signal: AbortSignal): Promise<AudioAsset[]> {
    await wait(this.latencyMs, signal);
    const root = path.resolve(this.outputDir);
    await mkdir(root, { recursive: true });

    const assets: AudioAsset[] = [];
    for (const line of lines) {
      if (signal.aborted) {
        const error = new Error("Audio synthesis aborted");
        error.name = "AbortError";
        throw error;
      }
      const filePath = path.join(root, `${line.line_id}.mock-audio.json`);
      await writeFile(
        filePath,
        JSON.stringify(
          {
            line_id: line.line_id,
            kind: line.type,
            speaker: line.type === "dialogue" ? line.speaker : "narrator",
            text: line.text,
            generated_at: new Date().toISOString(),
            note: "调度演示文件，不含真实音频。"
          },
          null,
          2
        ),
        "utf8"
      );
      assets.push({ lineId: line.line_id, path: filePath });
    }
    return assets;
  }
}

export class MediaPrefetchScheduler {
  private readonly states = new Map<string, AssetState>();
  private readonly assets = new Map<string, AudioAsset>();
  private readonly lineById = new Map<string, RuntimePlayableEvent>();
  private readonly activeTimeline: RuntimePlayableEvent[] = [];
  private readonly branchLines = new Map<string, RuntimePlayableEvent[]>();
  private readonly branchControllers = new Map<string, Set<AbortController>>();
  private readonly queue: QueueJob[] = [];
  private activeJobs = 0;
  private currentIndex = -1;
  private readonly synthesizer: AudioSynthesizer | null;
  private readonly activeBranchIds = new Set<string>();
  private readonly drainResolvers: Array<() => void> = [];

  private readonly metrics: MediaMetrics = {
    totalSynthesisRequests: 0,
    totalLinesSynthesized: 0,
    totalSynthesisFailures: 0,
    totalLinesCancelled: 0,
    totalBranchesPrefetched: 0,
    totalActiveLinesSynthesized: 0,
    totalSynthesisLatencyMs: 0,
    synthesisCount: 0,
  };

  constructor(
    private readonly config: AudioConfig,
    private readonly status: RuntimeStatus
  ) {
    this.synthesizer =
      config.enabled && config.provider === "mock"
        ? new MockAudioSynthesizer(config.output_dir, config.mock_latency_ms)
        : null;

    this.status.setMedia({
      enabled: config.enabled,
      provider: config.provider,
      targetAhead: config.active_target_lines,
      refillThreshold: config.refill_threshold_lines,
      note: config.enabled
        ? config.provider === "mock"
          ? "模拟音频预取已启用"
          : "音频预取已启用"
        : "音频预取关闭；文本调度仍按相同 line_id 工作"
    });
  }

  getMetrics(): Readonly<MediaMetrics> {
    return { ...this.metrics };
  }

  async waitForDrain(): Promise<void> {
    if (this.activeJobs === 0 && this.queue.length === 0) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  appendActive(events: RuntimePlayableEvent[]): void {
    for (const event of events) {
      if (!this.lineById.has(event.line_id)) {
        this.lineById.set(event.line_id, event);
        this.states.set(event.line_id, "idle");
      }
      if (!this.activeTimeline.some((line) => line.line_id === event.line_id)) {
        this.activeTimeline.push(event);
      }
    }
    this.pumpActive();
    this.updateStatus();
  }

  prefetchBranch(branchId: string, events: RuntimePlayableEvent[]): void {
    this.branchLines.set(branchId, events);
    this.metrics.totalBranchesPrefetched += 1;
    for (const event of events) {
      this.lineById.set(event.line_id, event);
      if (!this.states.has(event.line_id)) this.states.set(event.line_id, "idle");
    }

    if (!this.config.enabled || !this.synthesizer || this.config.branch_prefetch_lines === 0) {
      this.updateStatus();
      return;
    }

    const candidates = events
      .filter((event) => this.states.get(event.line_id) === "idle")
      .slice(0, this.config.branch_prefetch_lines);
    this.enqueueInBatches(candidates, branchId);
    this.updateStatus();
  }

  activateBranch(branchId: string): RuntimePlayableEvent[] {
    const selected = this.branchLines.get(branchId) ?? [];

    for (const [otherBranchId, controllers] of this.branchControllers) {
      if (otherBranchId === branchId) continue;
      for (const controller of controllers) controller.abort();
    }

    for (const [otherBranchId, lines] of this.branchLines) {
      if (otherBranchId === branchId) continue;
      for (const line of lines) {
        const state = this.states.get(line.line_id);
        if (state === "idle" || state === "queued" || state === "generating") {
          this.states.set(line.line_id, "cancelled");
        }
      }
    }

    this.branchLines.clear();
    for (const otherBranchId of [...this.branchControllers.keys()]) {
      if (otherBranchId !== branchId) this.branchControllers.delete(otherBranchId);
    }
    this.activeBranchIds.add(branchId);
    this.appendActive(selected);
    return selected;
  }

  isReady(lineId: string): boolean {
    if (!this.config.enabled || !this.synthesizer) return true;
    return this.states.get(lineId) === "ready";
  }

  async waitUntilReady(lineId: string, timeoutMs = 60_000): Promise<boolean> {
    if (!this.config.enabled || !this.synthesizer) return true;
    this.pumpActive();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.states.get(lineId);
      if (state === "ready") return true;
      if (state === "failed" || state === "cancelled" || state === undefined) {
        this.status.setMedia({ note: `资源 ${lineId} 未就绪，降级为纯文本播放` });
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    this.status.setMedia({ note: `资源 ${lineId} 等待超时(${timeoutMs}ms)，降级为纯文本播放` });
    return false;
  }

  markPresented(lineId: string): void {
    const index = this.activeTimeline.findIndex((line) => line.line_id === lineId);
    if (index >= 0) this.currentIndex = Math.max(this.currentIndex, index);
    this.status.setMedia({ currentLineId: lineId });
    this.pumpActive();
    this.updateStatus();
  }

  private pumpActive(): void {
    if (!this.config.enabled || !this.synthesizer) return;

    const future = this.activeTimeline.slice(this.currentIndex + 1);
    let readyAhead = 0;
    for (const line of future) {
      if (this.states.get(line.line_id) === "ready") {
        readyAhead += 1;
      } else {
        break;
      }
    }
    const pendingAhead = future.filter((line) => {
      const state = this.states.get(line.line_id);
      return state === "queued" || state === "generating";
    }).length;

    if (readyAhead > this.config.refill_threshold_lines && readyAhead + pendingAhead >= this.config.active_target_lines) {
      return;
    }

    const needed = Math.max(0, this.config.active_target_lines - readyAhead - pendingAhead);
    const candidates = future
      .filter((line) => this.states.get(line.line_id) === "idle")
      .slice(0, needed);
    this.enqueueInBatches(candidates, null);
  }

  private enqueueInBatches(lines: RuntimePlayableEvent[], branchId: string | null): void {
    for (let index = 0; index < lines.length; index += this.config.batch_size) {
      const batch = lines.slice(index, index + this.config.batch_size);
      if (batch.length === 0) continue;
      for (const line of batch) this.states.set(line.line_id, "queued");
      const controller = new AbortController();
      if (branchId) {
        const controllers = this.branchControllers.get(branchId) ?? new Set<AbortController>();
        controllers.add(controller);
        this.branchControllers.set(branchId, controllers);
      }
      this.queue.push({ lines: batch, branchId, controller });
    }
    this.pumpQueue();
  }

  private pumpQueue(): void {
    if (!this.synthesizer) return;

    while (this.activeJobs < this.config.max_concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      const activeLines = job.lines.filter(
        (line) => this.states.get(line.line_id) !== "cancelled"
      );
      if (activeLines.length === 0 || job.controller.signal.aborted) continue;

      this.activeJobs += 1;
      for (const line of activeLines) this.states.set(line.line_id, "generating");
      this.updateStatus();

      this.metrics.totalSynthesisRequests += 1;
      const startedAt = Date.now();
      void this.synthesizer
        .synthesize(activeLines, job.controller.signal)
        .then((assets) => {
          const latency = Date.now() - startedAt;
          this.metrics.totalSynthesisLatencyMs += latency;
          this.metrics.synthesisCount += 1;
          for (const asset of assets) {
            this.assets.set(asset.lineId, asset);
            this.states.set(asset.lineId, "ready");
            this.metrics.totalLinesSynthesized += 1;
            if (job.branchId === null || this.activeBranchIds.has(job.branchId)) {
              this.metrics.totalActiveLinesSynthesized += 1;
            }
          }
        })
        .catch((error: unknown) => {
          const cancelled = job.controller.signal.aborted;
          for (const line of activeLines) {
            if (cancelled) {
              this.states.set(line.line_id, "cancelled");
              this.metrics.totalLinesCancelled += 1;
            } else {
              this.states.set(line.line_id, "failed");
              this.metrics.totalSynthesisFailures += 1;
            }
          }
          if (!cancelled) {
            const message = error instanceof Error ? error.message : String(error);
            this.status.setMedia({ note: `音频预取失败：${message}` });
          }
        })
        .finally(() => {
          this.activeJobs = Math.max(0, this.activeJobs - 1);
          if (job.branchId) {
            const controllers = this.branchControllers.get(job.branchId);
            controllers?.delete(job.controller);
          }
          this.pumpActive();
          this.pumpQueue();
          this.updateStatus();
          this.notifyDrain();
        });
    }
  }

  private notifyDrain(): void {
    if (this.activeJobs === 0 && this.queue.length === 0) {
      const resolvers = this.drainResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  private updateStatus(): void {
    const future = this.activeTimeline.slice(this.currentIndex + 1);
    const readyAhead = future.filter((line) => this.states.get(line.line_id) === "ready").length;
    const queued = [...this.states.values()].filter((state) => state === "queued").length;
    const generating = [...this.states.values()].filter((state) => state === "generating").length;
    const activeIds = new Set(this.activeTimeline.map((line) => line.line_id));
    const branchReady = [...this.states.entries()].filter(
      ([lineId, state]) => state === "ready" && !activeIds.has(lineId)
    ).length;

    this.status.setMedia({
      readyAhead,
      queued,
      generating,
      branchReady
    });
  }
}
