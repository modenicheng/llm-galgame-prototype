/**
 * AudioIntentPlanner — pure media-intent planner implementing the core
 * MediaPlannerPort (§7.3).
 *
 * It expresses only what the runtime knows: which lines exist, on which
 * path, and their lifecycle (registered, promoted, discarded, presented).
 * It never touches providers, HTTP, or browser state; descriptors are
 * upserted into the AudioCatalogService, which owns the authoritative
 * registry and lifecycle events.
 */
import type { RuntimePlayableEvent } from "../../schema.js";
import type { AudioPriority } from "../../shared/wire/audio-descriptor.js";
import type { MediaPlannerPort } from "../../core/ports/media-planner-port.js";
import type { LinePerformance } from "./performance-compiler.js";
import type { AudioCatalogService } from "./audio-catalog-service.js";
import type { AudioDescriptorFactory } from "./audio-descriptor-factory.js";

export interface AudioIntentPlannerOptions {
  catalog: AudioCatalogService;
  factory: AudioDescriptorFactory;
  /** config.media.audio.planner.candidate_prefetch_lines */
  candidatePrefetchLines: number;
  /** config.media.audio.planner.max_active_future_lines */
  maxActiveFutureLines: number;
}

interface TimelineEntry {
  event: RuntimePlayableEvent;
  /** Line was registered as a formal (active) path line. */
  active: boolean;
}

export class AudioIntentPlanner implements MediaPlannerPort {
  /** Formal path timeline in presentation order. */
  private readonly timeline: TimelineEntry[] = [];
  /** Index of the line currently at the "current" position; -1 = none. */
  private currentIndex = -1;
  /** Candidate branch → its lines (promotable on selection). */
  private readonly branches = new Map<string, RuntimePlayableEvent[]>();

  constructor(private readonly options: AudioIntentPlannerOptions) {}

  registerActive(lines: RuntimePlayableEvent[]): void {
    for (const event of lines) {
      if (this.timeline.some((entry) => entry.event.line_id === event.line_id)) continue;
      this.timeline.push({ event, active: true });
    }
    if (this.currentIndex === -1 && this.timeline.length > 0) {
      this.currentIndex = 0;
    }
    for (let i = 0; i < this.timeline.length; i += 1) {
      const entry = this.timeline[i];
      if (entry === undefined) continue;
      const priority = this.priorityFor(i);
      const result = this.options.factory.build(
        entry.event,
        { type: "active" },
        priority,
        this.performanceOf(entry.event),
      );
      if (result) this.options.catalog.upsertDescriptor(result.descriptor, result.recipe);
    }
  }

  registerCandidate(branchId: string, lines: RuntimePlayableEvent[]): void {
    this.branches.set(branchId, lines);
    for (let i = 0; i < lines.length; i += 1) {
      const event = lines[i];
      if (event === undefined) continue;
      if (this.timeline.some((entry) => entry.event.line_id === event.line_id)) continue;
      const priority: AudioPriority =
        i < this.options.candidatePrefetchLines ? "candidate_first_line" : "background";
      const result = this.options.factory.build(
        event,
        { type: "candidate", branchId },
        priority,
        this.performanceOf(event),
      );
      if (result) this.options.catalog.upsertDescriptor(result.descriptor, result.recipe);
    }
  }

  activateCandidate(branchId: string): void {
    const promoted = this.branches.get(branchId) ?? [];

    for (const [otherBranchId, lines] of this.branches) {
      if (otherBranchId === branchId) continue;
      for (const event of lines) {
        this.options.catalog.invalidate(event.line_id, "branch_discarded");
      }
    }
    this.branches.clear();

    for (const event of promoted) {
      if (this.timeline.some((entry) => entry.event.line_id === event.line_id)) continue;
      this.timeline.push({ event, active: true });
    }
    if (this.currentIndex === -1 && this.timeline.length > 0) {
      this.currentIndex = 0;
    }
    for (let i = 0; i < this.timeline.length; i += 1) {
      const entry = this.timeline[i];
      if (entry === undefined || !entry.active) continue;
      const priority = this.priorityFor(i);
      const result = this.options.factory.build(
        entry.event,
        { type: "active" },
        priority,
        this.performanceOf(entry.event),
      );
      if (result) this.options.catalog.upsertDescriptor(result.descriptor, result.recipe);
    }
  }

  discardCandidate(branchId: string): void {
    const lines = this.branches.get(branchId);
    if (!lines) return;
    this.branches.delete(branchId);
    for (const event of lines) {
      this.options.catalog.invalidate(event.line_id, "branch_discarded");
    }
  }

  markPresented(lineId: string): void {
    const index = this.timeline.findIndex((entry) => entry.event.line_id === lineId);
    if (index < 0) return;
    if (this.currentIndex === -1 || index >= this.currentIndex) {
      this.currentIndex = index + 1;
    }
    for (let i = this.currentIndex; i < this.timeline.length; i += 1) {
      const entry = this.timeline[i];
      if (entry === undefined || !entry.active) continue;
      this.options.catalog.setPriority(entry.event.line_id, this.priorityFor(i));
    }
  }

  isReady(_lineId: string): boolean {
    // CLI compat: the planner doesn't track synthesis completion, and the
    // CLI never waits when legacy media.audio.enabled=false.
    return true;
  }


  waitUntilReady(_lineId: string, _timeoutMs?: number): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Priority of a timeline position relative to the current cursor. */
  private priorityFor(index: number): AudioPriority {
    if (index === this.currentIndex) return "current";
    if (index === this.currentIndex + 1) return "next";
    return "active_future";
  }

  /**
   * Forward the line's §14.3 performance intent to the factory. Player
   * lines have no performance field, so the union is narrowed by property
   * presence. All three build sites must forward it in lockstep.
   */
  private performanceOf(event: RuntimePlayableEvent): LinePerformance | undefined {
    return "performance" in event ? event.performance : undefined;
  }
}
