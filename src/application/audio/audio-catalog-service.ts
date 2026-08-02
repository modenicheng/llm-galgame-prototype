/**
 * AudioCatalogService — the authoritative registry of audio descriptors.
 *
 * Receives media intent from the runtime planner, holds the authoritative
 * `AudioDescriptor` per line, validates browser synthesis requests
 * (`lineId + cacheKey` must match, scope must still be valid), and emits
 * lifecycle events the web host forwards to the browser over WebSocket.
 */
import type { AudioDescriptor, AudioPriority } from "../../shared/wire/audio-descriptor.js";
import type { InternalAudioRecipe } from "./internal-audio-recipe.js";
import type { AudioFetchRequest } from "../../shared/wire/client-message.js";

export type AudioInvalidationReason =
  | "branch_discarded"
  | "preview_canceled"
  | "session_closed";

/** Lifecycle events the web host streams to the browser. */
export type AudioCatalogEvent =
  | { type: "descriptor"; descriptor: AudioDescriptor }
  | {
      type: "invalidated";
      lineId: string;
      reason: AudioInvalidationReason;
    }
  | {
      type: "priority_changed";
      lineId: string;
      priority: AudioPriority;
    };

export interface AudioCatalogService {
  /** Register/refresh the descriptor for one line. */
  upsertDescriptor(descriptor: AudioDescriptor, recipe: InternalAudioRecipe): void;

  /** Fetch a descriptor; undefined when the line is unknown or invalidated. */
  get(lineId: string): AudioDescriptor | undefined;

  /** Resolve a recipe; undefined when the line is unknown. */
  getRecipe(lineId: string): InternalAudioRecipe | undefined;

  /** True while a line's scope is still valid (active/candidate/preview). */
  isValidScope(lineId: string): boolean;

  /** Invalidate a line (branch discarded / preview canceled / session closed). */
  invalidate(lineId: string, reason: AudioInvalidationReason): void;

  /** Change a live line's priority (e.g. promote after selection). */
  setPriority(lineId: string, priority: AudioPriority): void;

  /** Validate a browser request: descriptor exists and cacheKey matches. */
  validateFetchRequest(request: AudioFetchRequest): AudioDescriptor | undefined;

  /** All descriptors currently valid (for reconnect snapshots). */
  listDescriptors(): AudioDescriptor[];

  /** Subscribe to lifecycle events; returns an unsubscribe function. */
  subscribe(listener: (event: AudioCatalogEvent) => void): () => void;
}

/**
 * AudioCatalogServiceImpl — the authoritative descriptor/recipe registry.
 *
 * A line is "valid" while it holds a descriptor. Invalidation removes both
 * the descriptor and its recipe, so `get`/`getRecipe` return undefined and
 * `validateFetchRequest` refuses stale or forged requests (§22 invariant 10).
 */
export class AudioCatalogServiceImpl implements AudioCatalogService {
  private readonly descriptors = new Map<string, AudioDescriptor>();
  private readonly recipes = new Map<string, InternalAudioRecipe>();
  private readonly listeners = new Set<(event: AudioCatalogEvent) => void>();

  upsertDescriptor(descriptor: AudioDescriptor, recipe: InternalAudioRecipe): void {
    this.descriptors.set(descriptor.lineId, descriptor);
    this.recipes.set(descriptor.lineId, recipe);
    this.emit({ type: "descriptor", descriptor });
  }

  get(lineId: string): AudioDescriptor | undefined {
    return this.descriptors.get(lineId);
  }

  getRecipe(lineId: string): InternalAudioRecipe | undefined {
    return this.recipes.get(lineId);
  }

  isValidScope(lineId: string): boolean {
    return this.descriptors.has(lineId);
  }

  invalidate(lineId: string, reason: AudioInvalidationReason): void {
    if (!this.descriptors.has(lineId)) return;
    this.descriptors.delete(lineId);
    this.recipes.delete(lineId);
    this.emit({ type: "invalidated", lineId, reason });
  }

  setPriority(lineId: string, priority: AudioPriority): void {
    const descriptor = this.descriptors.get(lineId);
    if (!descriptor) return;
    if (descriptor.priority === priority) return;
    this.descriptors.set(lineId, { ...descriptor, priority });
    this.emit({ type: "priority_changed", lineId, priority });
  }

  validateFetchRequest(request: AudioFetchRequest): AudioDescriptor | undefined {
    const descriptor = this.descriptors.get(request.lineId);
    if (!descriptor || descriptor.cacheKey !== request.cacheKey) return undefined;
    if (!this.isValidScope(request.lineId)) return undefined;
    return descriptor;
  }

  listDescriptors(): AudioDescriptor[] {
    return [...this.descriptors.values()];
  }

  subscribe(listener: (event: AudioCatalogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AudioCatalogEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
