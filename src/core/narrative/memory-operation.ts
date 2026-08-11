/**
 * Narrative-memory operation types and zod schemas (narrative director,
 * Task 1). Pure types + schemas only — no runtime logic.
 */

import { z } from "zod";

import type { EpisodeImportance, PlotThreadKind } from "./memory-types.js";

export interface ThreadOp {
  type: "touch" | "advance" | "resolve" | "abandon" | "create";
  id: string;
  progress?: string;
  /** create 专用：新线程类型（audit P1-8）。 */
  kind?: PlotThreadKind;
  /** create 专用：importance 决定预算口径（major 查 major 预算）。 */
  importance?: "major" | "minor";
}

export interface SetupOp {
  type: "seed" | "reinforce" | "payoff" | "hold" | "drop";
  id: string;
  evidenceEventIds?: string[];
}

export interface EpisodeSummaryOp {
  summary: string;
  characters: string[];
  locations: string[];
  threads: string[];
  setups: string[];
  importance: EpisodeImportance;
}

export const ThreadOpSchema: z.ZodType<ThreadOp> = z
  .object({
    type: z.enum(["touch", "advance", "resolve", "abandon", "create"]),
    id: z.string().min(1),
    progress: z.exactOptional(z.string().min(1)),
    kind: z.exactOptional(
      z.enum(["main", "character", "mystery", "relationship", "promise"]),
    ),
    importance: z.exactOptional(z.enum(["major", "minor"])),
  })
  .superRefine((op, ctx) => {
    if (op.type === "create") {
      if (op.kind === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "create 必须携带 kind",
        });
      }
      if (op.importance === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["importance"],
          message: "create 必须携带 importance",
        });
      }
    }
  });

export const SetupOpSchema: z.ZodType<SetupOp> = z.object({
  type: z.enum(["seed", "reinforce", "payoff", "hold", "drop"]),
  id: z.string().min(1),
  evidenceEventIds: z.exactOptional(z.array(z.string().min(1))),
});

export const EpisodeSummaryOpSchema: z.ZodType<EpisodeSummaryOp> = z.object({
  summary: z.string().min(1),
  characters: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  threads: z.array(z.string().min(1)),
  setups: z.array(z.string().min(1)),
  importance: z.enum(["major", "normal"]),
});

/** A rejected narrative operation, recorded for diagnostics/feedback. */
export interface RejectedOp {
  // plan = plan proposal rejected as a whole / field-level rejection,
  // anchor = anchor op rejected.
  kind: "thread" | "setup" | "episode" | "plan" | "anchor";
  op: unknown;
  reason: string;
}
