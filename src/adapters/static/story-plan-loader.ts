/**
 * Author-authored static story-plan loader (narrative director, Task 3).
 *
 * Reads `story-plan.yaml` (see the repo-root sample) and normalizes its
 * entries into runtime `PlotThread` / `SetupPayoff` / `StoryAnchorState`
 * values. The plan file is optional: a missing file yields an empty plan,
 * while a present-but-broken file fails loudly at startup. Individual
 * entries that fail zod validation are skipped with a diagnostic warning
 * instead of taking down the whole plan.
 */

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import {
  PlotThreadSchema,
  SetupPayoffSchema,
  StoryAnchorStateSchema,
} from "../../core/narrative/memory-types.js";
import type {
  PlotThread,
  SetupPayoff,
  StoryAnchorState,
} from "../../core/narrative/memory-types.js";
import {
  silentDiagnosticSink,
  type DiagnosticSink,
} from "../../core/ports/diagnostic-sink.js";

/** A parsed, author-authored static story plan. */
export interface StoryPlan {
  /** Author-authored threads: `source` forced to "author", authored status kept. */
  threads: PlotThread[];
  /** Author-authored setups: `source` "author", `status` forced to "planned". */
  setups: SetupPayoff[];
  /** Author-authored anchors: `status` forced to "pending". */
  anchors: StoryAnchorState[];
}

const WARN_SCOPE = "StoryPlan";

/** Loosely-shaped top level of a story-plan.yaml document. */
const PlanShapeSchema = z.object({
  threads: z.array(z.unknown()).optional(),
  setups: z.array(z.unknown()).optional(),
  anchors: z.array(z.unknown()).optional(),
});

/** Map a snake_case yaml key to the camelCase TS field name. */
function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase()
  );
}

/** Convert a yaml entry to a camelCase-keyed record for the zod schemas. */
function normalizeKeys(entry: unknown): Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    out[toCamelCase(key)] = value;
  }
  return out;
}

/** Human-readable zod failure summary, e.g. `kind: Invalid enum value`. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseThread(
  raw: unknown,
  index: number,
  diagnostics: DiagnosticSink
): PlotThread | null {
  const fields = normalizeKeys(raw);
  const id = typeof fields.id === "string" ? fields.id : `<entry ${index}>`;
  try {
    // Threads keep their authored status; source is always "author" and
    // missing timestamps default to 0 (the author does not track runtime).
    return PlotThreadSchema.parse({
      ...fields,
      source: "author",
      introducedAtCheckpoint: fields.introducedAtCheckpoint ?? 0,
      lastTouchedAtCheckpoint: fields.lastTouchedAtCheckpoint ?? 0,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      diagnostics.warn(WARN_SCOPE, `thread 条目跳过: ${id} ${formatZodError(error)}`);
      return null;
    }
    throw error;
  }
}

function parseSetup(
  raw: unknown,
  index: number,
  diagnostics: DiagnosticSink
): SetupPayoff | null {
  const fields = normalizeKeys(raw);
  const id = typeof fields.id === "string" ? fields.id : `<entry ${index}>`;
  try {
    // Setups are always authored as "planned"; the runtime seeds them later.
    return SetupPayoffSchema.parse({
      ...fields,
      source: "author",
      status: "planned",
      reinforcementCount: fields.reinforcementCount ?? 0,
      prerequisites: fields.prerequisites ?? [],
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      diagnostics.warn(WARN_SCOPE, `setup 条目跳过: ${id} ${formatZodError(error)}`);
      return null;
    }
    throw error;
  }
}

function parseAnchor(
  raw: unknown,
  index: number,
  diagnostics: DiagnosticSink
): StoryAnchorState | null {
  const fields = normalizeKeys(raw);
  const id = typeof fields.id === "string" ? fields.id : `<entry ${index}>`;
  try {
    // Anchors start "pending"; only the runtime may reach or pass them.
    return StoryAnchorStateSchema.parse({
      ...fields,
      status: "pending",
      prerequisites: fields.prerequisites ?? [],
      required: fields.required ?? false,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      diagnostics.warn(WARN_SCOPE, `anchor 条目跳过: ${id} ${formatZodError(error)}`);
      return null;
    }
    throw error;
  }
}

/**
 * Load and validate a story-plan.yaml file.
 *
 * - Missing file (ENOENT): `{ threads: [], setups: [], anchors: [] }`, no error.
 * - Malformed yaml or structurally invalid document: throws a clear error
 *   so startup fails loudly.
 * - Individual entries failing zod validation: skipped, with a
 *   `diagnostics.warn("StoryPlan", ...)` per dropped entry.
 */
export async function loadStoryPlan(
  path: string,
  diagnostics: DiagnosticSink = silentDiagnosticSink
): Promise<StoryPlan> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // ENOENT on both Unix and Windows
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { threads: [], setups: [], anchors: [] };
    }
    throw error;
  }

  const doc: unknown = parse(raw);
  // Empty/whitespace-only yaml is a valid (empty) plan.
  if (doc === null || doc === undefined) {
    return { threads: [], setups: [], anchors: [] };
  }

  let plan: z.infer<typeof PlanShapeSchema>;
  try {
    plan = PlanShapeSchema.parse(doc);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`story-plan.yaml 结构错误: ${formatZodError(error)}`);
    }
    throw error;
  }

  const threads: PlotThread[] = [];
  for (const [index, entry] of (plan.threads ?? []).entries()) {
    const thread = parseThread(entry, index, diagnostics);
    if (thread !== null) threads.push(thread);
  }

  const setups: SetupPayoff[] = [];
  for (const [index, entry] of (plan.setups ?? []).entries()) {
    const setup = parseSetup(entry, index, diagnostics);
    if (setup !== null) setups.push(setup);
  }

  const anchors: StoryAnchorState[] = [];
  for (const [index, entry] of (plan.anchors ?? []).entries()) {
    const anchor = parseAnchor(entry, index, diagnostics);
    if (anchor !== null) anchors.push(anchor);
  }

  return { threads, setups, anchors };
}
