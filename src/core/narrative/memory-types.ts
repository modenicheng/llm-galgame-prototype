/**
 * Core narrative-memory types and zod schemas (narrative director, Task 1).
 *
 * Pure types + schemas only: no runtime logic beyond the two transition-map
 * constants. Later tasks in the narrative-director plan depend on these
 * exact export names — do not rename.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

export type PlotThreadKind =
  | "main"
  | "character"
  | "mystery"
  | "relationship"
  | "promise";

export type PlotThreadStatus =
  | "open"
  | "developing"
  | "ready_to_resolve"
  | "resolved"
  | "abandoned";

export type SetupKind =
  | "foreshadow"
  | "mystery_clue"
  | "object"
  | "character"
  | "relationship"
  | "world_rule"
  | "promise"
  | "motif";

export type SetupStatus =
  | "planned"
  | "seeded"
  | "reinforced"
  | "ready"
  | "paid_off"
  | "dropped";

export type AnchorStatus = "pending" | "reached" | "passed";

export type EpisodeImportance = "major" | "normal";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PlotThread {
  id: string;
  kind: PlotThreadKind;
  summary: string;
  status: PlotThreadStatus;
  importance: "major" | "minor";
  introducedAt: number;
  lastTouchedAt: number;
  nextPressure?: string;
  source: "author" | "runtime";
}

export interface SetupPayoff {
  id: string;
  kind: SetupKind;
  setup: string;
  intendedPayoff?: string;
  status: SetupStatus;
  threadId?: string;
  reinforcementCount: number;
  seededAt?: number;
  lastTouchedAt?: number;
  payoffAt?: number;
  prerequisites: string[];
  payoffBeforeAnchor?: string;
  source: "author" | "runtime";
}

export interface StoryAnchorState {
  id: string;
  purpose: string;
  prerequisites: string[];
  required: boolean;
  status: AnchorStatus;
}

export interface EpisodeMemory {
  id: string;
  fromEventSeq: number;
  toEventSeq: number;
  summary: string;
  characters: string[];
  locations: string[];
  threads: string[];
  setups: string[];
  importance: EpisodeImportance;
}

export interface NarrativeMemoryState {
  revision: number;
  consolidatedThroughEventSeq: number;
  checkpointCount: number;
  threads: Record<string, PlotThread>;
  setups: Record<string, SetupPayoff>;
  anchors: Record<string, StoryAnchorState>;
  recentEpisodeIds: string[];
}

// ---------------------------------------------------------------------------
// Zod schemas (mirror the interfaces: required fields required, optional
// fields optional, strings non-empty; `z.exactOptional` keeps the inferred
// output assignable to the interfaces under exactOptionalPropertyTypes).
// ---------------------------------------------------------------------------

export const PlotThreadSchema: z.ZodType<PlotThread> = z.object({
  id: z.string().min(1),
  kind: z.enum(["main", "character", "mystery", "relationship", "promise"]),
  summary: z.string().min(1),
  status: z.enum([
    "open",
    "developing",
    "ready_to_resolve",
    "resolved",
    "abandoned",
  ]),
  importance: z.enum(["major", "minor"]),
  introducedAt: z.number().int().nonnegative(),
  lastTouchedAt: z.number().int().nonnegative(),
  nextPressure: z.exactOptional(z.string().min(1)),
  source: z.enum(["author", "runtime"]),
});

export const SetupPayoffSchema: z.ZodType<SetupPayoff> = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "foreshadow",
    "mystery_clue",
    "object",
    "character",
    "relationship",
    "world_rule",
    "promise",
    "motif",
  ]),
  setup: z.string().min(1),
  intendedPayoff: z.exactOptional(z.string().min(1)),
  status: z.enum([
    "planned",
    "seeded",
    "reinforced",
    "ready",
    "paid_off",
    "dropped",
  ]),
  threadId: z.exactOptional(z.string().min(1)),
  reinforcementCount: z.number().int().nonnegative(),
  seededAt: z.exactOptional(z.number().int().nonnegative()),
  lastTouchedAt: z.exactOptional(z.number().int().nonnegative()),
  payoffAt: z.exactOptional(z.number().int().nonnegative()),
  prerequisites: z.array(z.string().min(1)),
  payoffBeforeAnchor: z.exactOptional(z.string().min(1)),
  source: z.enum(["author", "runtime"]),
});

export const StoryAnchorStateSchema: z.ZodType<StoryAnchorState> = z.object({
  id: z.string().min(1),
  purpose: z.string().min(1),
  prerequisites: z.array(z.string().min(1)),
  required: z.boolean(),
  status: z.enum(["pending", "reached", "passed"]),
});

export const EpisodeMemorySchema: z.ZodType<EpisodeMemory> = z.object({
  id: z.string().min(1),
  fromEventSeq: z.number().int().nonnegative(),
  toEventSeq: z.number().int().nonnegative(),
  summary: z.string().min(1),
  characters: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  threads: z.array(z.string().min(1)),
  setups: z.array(z.string().min(1)),
  importance: z.enum(["major", "normal"]),
});

export const NarrativeMemoryStateSchema: z.ZodType<NarrativeMemoryState> =
  z.object({
    revision: z.number().int().nonnegative(),
    consolidatedThroughEventSeq: z.number().int().nonnegative(),
    checkpointCount: z.number().int().nonnegative(),
    threads: z.record(z.string().min(1), PlotThreadSchema),
    setups: z.record(z.string().min(1), SetupPayoffSchema),
    anchors: z.record(z.string().min(1), StoryAnchorStateSchema),
    recentEpisodeIds: z.array(z.string().min(1)),
  });

// ---------------------------------------------------------------------------
// Valid status transitions
// ---------------------------------------------------------------------------

/**
 * Legal PlotThreadStatus transitions, keyed by current status.
 * `resolved` and `abandoned` are terminal (map to []).
 */
export const VALID_THREAD_TRANSITIONS: Record<
  PlotThreadStatus,
  PlotThreadStatus[]
> = {
  open: ["developing", "resolved", "abandoned"],
  developing: ["ready_to_resolve", "resolved", "abandoned"],
  ready_to_resolve: ["resolved", "abandoned"],
  resolved: [],
  abandoned: [],
};

/**
 * Legal SetupStatus transitions, keyed by current status.
 * `paid_off` and `dropped` are terminal (map to []).
 */
export const VALID_SETUP_TRANSITIONS: Record<SetupStatus, SetupStatus[]> = {
  planned: ["seeded", "dropped"],
  seeded: ["reinforced", "ready", "paid_off", "dropped"],
  reinforced: ["ready", "paid_off", "dropped"],
  ready: ["paid_off", "dropped"],
  paid_off: [],
  dropped: [],
};
