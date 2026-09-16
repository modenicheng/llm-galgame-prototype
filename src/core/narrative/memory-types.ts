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
  introducedAtCheckpoint: number;
  lastTouchedAtCheckpoint: number;
  nextPressure?: string;
  source: "author" | "runtime";
}

export interface SetupPayoff {
  id: string;
  kind: SetupKind;
  setup: string;
  intendedPayoff?: string;
  /** 计划出现次数档位（记忆 spec §8.1）：shallow=1、mid=2–3、heavy=3+；缺省 mid。 */
  depth?: "shallow" | "mid" | "heavy";
  status: SetupStatus;
  threadId?: string;
  reinforcementCount: number;
  seededAtCheckpoint?: number;
  lastTouchedAtCheckpoint?: number;
  payoffAtCheckpoint?: number;
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
// Lessons（教训库，记忆 spec §7）与 Facts 存储通道（§5.3）
// ---------------------------------------------------------------------------

export type LessonTag =
  | "fact-conflict"
  | "belief-violation"
  | "character-consistency"
  | "setup-flow"
  | "style"
  | "interaction"
  | "other";

/**
 * 教训记录（规避清单条目）。append-only：同一 tag+content 再现时 occurrences+1，
 * 不新增行；窗口管理（超出上限置 inactive）由 LessonService 承担。
 */
export interface Lesson {
  id: string;
  tag: LessonTag;
  /** 规避指令式描述（≤100 字），如「旁白不得挂主角名下」。 */
  content: string;
  source: "audit" | "rejection" | "manual";
  /** finding id / 被拒 op 的稳定规则码。 */
  sourceRef?: string;
  occurrences: number;
  active: boolean;
  /** 首次登记时的 checkpoint（recency 排序用）。 */
  createdAtCheckpoint: number;
}

/**
 * FactRecord（既定事实库，记忆 spec §5）。Phase A 仅建存储通道
 * （facts.jsonl 读写），写入者随 Phase B 的 consolidator 扩展落地。
 */
export interface FactRecord {
  id: string;
  content: string;
  evidenceEventSeqs: number[];
  /** 应用该事实时的 checkpoint（检索按 checkpoint 倒序）。 */
  checkpoint: number;
  /** 被 amend 取代后置 true（不删除，保留历史）。 */
  superseded: boolean;
  /** amend 关系：本记录取代的旧 fact id。 */
  amends?: string;
  scope?: { characters?: string[]; location?: string };
  importance?: "major" | "minor";
}

/** 终局报告（记忆 spec §8.4）：确定性聚合，无 LLM。 */
export interface EndingReport {
  generatedAt: string;
  setups: {
    paidOff: number;
    dropped: number;
    /** 结算时仍 active（含 planned）的伏笔数。 */
    active: number;
    /** paid_off / (paid_off + dropped + active)；分母为 0 时为 0。 */
    payoffRate: number;
  };
  threads: {
    resolved: number;
    abandoned: number;
    /** 仍开放（open/developing/ready_to_resolve）的线程数。 */
    active: number;
  };
  /** active lessons 摘要附后。 */
  lessons: Array<Pick<Lesson, "id" | "tag" | "content" | "occurrences">>;
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
  introducedAtCheckpoint: z.number().int().nonnegative(),
  lastTouchedAtCheckpoint: z.number().int().nonnegative(),
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
  depth: z.exactOptional(z.enum(["shallow", "mid", "heavy"])),
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
  seededAtCheckpoint: z.exactOptional(z.number().int().nonnegative()),
  lastTouchedAtCheckpoint: z.exactOptional(z.number().int().nonnegative()),
  payoffAtCheckpoint: z.exactOptional(z.number().int().nonnegative()),
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

const LessonTagSchema = z.enum([
  "fact-conflict",
  "belief-violation",
  "character-consistency",
  "setup-flow",
  "style",
  "interaction",
  "other",
]);

export const LessonSchema: z.ZodType<Lesson> = z.object({
  id: z.string().min(1),
  tag: LessonTagSchema,
  content: z.string().min(1).max(100),
  source: z.enum(["audit", "rejection", "manual"]),
  sourceRef: z.exactOptional(z.string().min(1)),
  occurrences: z.number().int().positive(),
  active: z.boolean(),
  createdAtCheckpoint: z.number().int().nonnegative(),
});

export const FactRecordSchema: z.ZodType<FactRecord> = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  evidenceEventSeqs: z.array(z.number().int().positive()),
  checkpoint: z.number().int().nonnegative(),
  superseded: z.boolean(),
  amends: z.exactOptional(z.string().min(1)),
  scope: z.exactOptional(
    z.object({
      characters: z.exactOptional(z.array(z.string().min(1))),
      location: z.exactOptional(z.string().min(1)),
    }),
  ),
  importance: z.exactOptional(z.enum(["major", "minor"])),
});

export const EndingReportSchema: z.ZodType<EndingReport> = z.object({
  generatedAt: z.string().min(1),
  setups: z.object({
    paidOff: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    payoffRate: z.number().min(0).max(1),
  }),
  threads: z.object({
    resolved: z.number().int().nonnegative(),
    abandoned: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
  }),
  lessons: z.array(
    z.object({
      id: z.string().min(1),
      tag: LessonTagSchema,
      content: z.string().min(1),
      occurrences: z.number().int().positive(),
    }),
  ),
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
