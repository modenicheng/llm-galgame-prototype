/**
 * Narrative brief types and zod schema (narrative director, Task 1).
 * Pure types + schema only — no runtime logic.
 *
 * A NarrativeBrief is the per-turn digest the runtime sends to the model so
 * it can keep longform promises, setups and threads coherent (see the
 * narrative-director plan). `revealLocks` come from the active director
 * plan (empty when no plan is in effect).
 */

import { z } from "zod";

import {
  EpisodeMemorySchema,
  StoryAnchorStateSchema,
} from "./memory-types.js";
import type {
  EpisodeMemory,
  PlotThread,
  StoryAnchorState,
} from "./memory-types.js";
import {
  DirectorPhaseSchema,
  PlannedBeatSchema,
  SetupDirectiveSchema,
  type DirectorPhase,
  type PlannedBeat,
  type SetupDirective,
} from "./director-plan.js";

export interface NarrativeBriefRequest {
  turn: number;
  eventSeq: number;
  location: string;
  characters: string[];
  currentInteractionId?: string;
}

export interface NarrativeBrief {
  revision: number;
  consolidatedThroughEventSeq: number;
  currentEventSeq: number;
  checkpointCount: number;
  location: string;
  characters: string[];
  activeThreads: Array<
    Pick<
      PlotThread,
      | "id"
      | "kind"
      | "summary"
      | "status"
      | "importance"
      | "lastTouchedAtCheckpoint"
      | "nextPressure"
    >
  >;
  setupDirectives: SetupDirective[];
  relevantEpisodes: EpisodeMemory[];
  anchors: StoryAnchorState[];
  /** From the active director plan; empty when no plan is in effect. */
  revealLocks: string[];
  // 第 3 步新增（可选；无有效计划时为 undefined → 渲染省略 [导演目标]）
  phase?: DirectorPhase;
  currentGoal?: string;
  beats?: PlannedBeat[];
}

const ActiveThreadSchema = z.object({
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
  lastTouchedAtCheckpoint: z.number().int().nonnegative(),
  nextPressure: z.exactOptional(z.string().min(1)),
});

export const NarrativeBriefSchema: z.ZodType<NarrativeBrief> = z.object({
  revision: z.number().int().nonnegative(),
  consolidatedThroughEventSeq: z.number().int().nonnegative(),
  currentEventSeq: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
  location: z.string().min(1),
  characters: z.array(z.string().min(1)),
  activeThreads: z.array(ActiveThreadSchema),
  setupDirectives: z.array(SetupDirectiveSchema),
  relevantEpisodes: z.array(EpisodeMemorySchema),
  anchors: z.array(StoryAnchorStateSchema),
  revealLocks: z.array(z.string().min(1)),
  phase: z.exactOptional(DirectorPhaseSchema),
  currentGoal: z.exactOptional(z.string().min(1).max(200)),
  beats: z.exactOptional(z.array(PlannedBeatSchema).min(1).max(6)),
});
