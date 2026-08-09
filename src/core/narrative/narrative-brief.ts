/**
 * Narrative brief types and zod schema (narrative director, Task 1).
 * Pure types + schema only — no runtime logic.
 *
 * A NarrativeBrief is the per-turn digest the runtime sends to the model so
 * it can keep longform promises, setups and threads coherent (see the
 * narrative-director plan). `revealLocks` is always [] in this plan.
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

export interface NarrativeBriefRequest {
  turn: number;
  eventSeq: number;
  location: string;
  characters: string[];
  currentInteractionId?: string;
}

export interface SetupDirective {
  id: string;
  action: "seed" | "reinforce" | "payoff" | "hold";
  urgency: "now" | "soon" | "normal";
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
  /** Always [] in this plan. */
  revealLocks: string[];
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

const SetupDirectiveSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["seed", "reinforce", "payoff", "hold"]),
  urgency: z.enum(["now", "soon", "normal"]),
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
});
