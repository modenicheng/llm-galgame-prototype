/**
 * MemoryProjection——导演记忆子层的每回合投影（M4.4：自 narrative-brief.ts
 * 收缩而来；plan 段 phase/currentGoal/beats/revealLocks 已随 PlotPlanner
 * 删除）。剪报组装（actor-briefing）与剧本渲染消费本投影。纯类型 + schema。
 */

import { z } from "zod";

import {
  BeliefStateSchema,
  EpisodeMemorySchema,
  FactRecordSchema,
  LessonSchema,
  StoryAnchorStateSchema,
} from "./memory-types.js";
import type {
  BeliefState,
  EpisodeMemory,
  FactRecord,
  Lesson,
  PlotThread,
  StoryAnchorState,
} from "./memory-types.js";
import { SetupDirectiveSchema, type SetupDirective } from "./setup-directive.js";

export interface MemoryProjectionRequest {
  turn: number;
  eventSeq: number;
  location: string;
  characters: string[];
  currentInteractionId?: string;
}

export interface MemoryProjection {
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
  /** 规避清单（记忆 spec §7.3，MA-A）：active lessons，occurrences 降序。 */
  avoidanceLessons: Lesson[];
  /** 相关既定事实（§5.3，MA-B）：fact-retriever 选取，checkpoint 倒序。 */
  relatedFacts: FactRecord[];
  /** 在场角色的 active 认知（§6.2，MA-B）。 */
  characterBeliefs: BeliefState[];
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

export const MemoryProjectionSchema: z.ZodType<MemoryProjection> = z.object({
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
  avoidanceLessons: z.array(LessonSchema),
  relatedFacts: z.array(FactRecordSchema),
  characterBeliefs: z.array(BeliefStateSchema),
});
