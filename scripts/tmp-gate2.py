import io
import re


def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')


def write(path, t):
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(t.replace('\n', '\r\n'))


def patch(path, old, new, count=1):
    t = read(path)
    assert old in t, (path, old[:60])
    t = t.replace(old, new, count)
    write(path, t)
    print('patched', path)


# ---- 1. delete VALID_SETUP_TRANSITIONS (dead + drifted) ----
p = 'src/core/narrative/memory-types.ts'
t = read(p)
start = t.index('/**\n * Legal SetupStatus transitions')
end = t.index('};', t.index('dropped: [],', start)) + 3
t = t[:start] + t[end:]
write(p, t)
print('removed VALID_SETUP_TRANSITIONS block')

p = 'src/core/narrative/memory-types.test.ts'
t = read(p)
start = t.index('describe("VALID_SETUP_TRANSITIONS"')
# find the matching close: the describe ends with '});' at same nesting — find next '\n});' after start
end = t.index('\n});', start) + len('\n});')
t = t[:start] + t[end:].lstrip('\n')
t = t.replace('  VALID_SETUP_TRANSITIONS,\n', '')
write(p, t)
print('removed VALID_SETUP_TRANSITIONS tests')

# ---- 2. state.ts: remove serialize/deserialize/saveStateSnapshot ----
p = 'src/story/state.ts'
t = read(p)
start = t.index('// ---------------------------------------------------------------------------\n// Serialization')
t = t[:start].rstrip('\n') + '\n'
t = t.replace('''import { writeFile } from "node:fs/promises";
import type { StoryState } from "./types.js";
import { StoryStateSchema } from "./types.js";''',
              'import type { StoryState } from "./types.js";')
t = t.replace(''' * `createInitialState` produces a blank/default state at the start of a
 * new session. `summarizeState` compresses the state into a text block
 * suitable for inclusion in the LLM's context window.
 *
 * `serializeState` / `deserializeState` handle JSON round-tripping with
 * Zod validation. `saveStateSnapshot` is an async filesystem wrapper.''',
              ''' * `createInitialState` produces a blank/default state at the start of a
 * new session. `summarizeState` compresses the state into a text block
 * suitable for inclusion in the LLM's context window.
 * （MA-A2：serialize/deserialize 已随图存储接管序列化而删除。）''')
write(p, t)
print('state.ts serialization removed')

# state.test.ts: drop serialize/deserialize describes + imports
p = 'src/story/state.test.ts'
t = read(p)
t = t.replace('''import {
  createInitialState,
  summarizeState,
  serializeState,
  deserializeState,
} from "./state.js";''', '''import { createInitialState, summarizeState } from "./state.js";''')
start = t.index('// ---------------------------------------------------------------------------\n// serializeState')
t = t[:start].rstrip('\n') + '\n'
write(p, t)
print('state.test.ts trimmed')

# ---- 3. test-kit orphan trailing comment ----
p = 'src/application/narrative/narrative-director-test-kit.ts'
t = read(p)
old = '''
// ---------------------------------------------------------------------------
// NarrativeDirectorService tests
// ---------------------------------------------------------------------------
'''
if old in t:
    t = t.replace(old, '')
    write(p, t)
    print('test-kit orphan comment removed')
else:
    print('test-kit orphan comment not found (skip)')

# ---- 4. types.ts orphan docblocks ----
p = 'src/story/types.ts'
t = read(p)
old = '''/**
 * A state patch that the model returns as part of a `GenerationEnvelope`.
 * merged state updates collected from in-band state_patch lines.
 */
'''
if old not in t:
    # locate by distinctive fragment
    frag = 'merged state updates collected from in-band state_patch lines.'
    i = t.index('/**', 0, t.index(frag))
    j = t.index('*/', i) + 3
    t = t[:i] + t[j:]
else:
    t = t.replace(old, '', 1)
t = t.replace(' Includes `ChoiceEvent` for backward compatibility with the legacy `mode: "choice"` instead.', '')
write(p, t)
print('types.ts docblocks cleaned')

# ---- 5. testing.ts: use SNAPSHOT_VERSION ----
p = 'src/core/graph/testing.ts'
t = read(p)
t = t.replace('''} from "./types.js";''', '''} from "./types.js";''', 1)
assert 'import type {' in t
if 'SNAPSHOT_VERSION' not in t:
    t = t.replace('import type {', 'import { SNAPSHOT_VERSION } from "./types.js";\nimport type {', 1)
t = t.replace('snapshotVersion: 2,', 'snapshotVersion: SNAPSHOT_VERSION,')
t = t.replace('snapshotVersion: 3,', 'snapshotVersion: SNAPSHOT_VERSION,')
write(p, t)
print('testing.ts uses SNAPSHOT_VERSION')

# ---- 6. json-store: writeAtomic + unify jsonl channels + EndingReportSchema.parse ----
p = 'src/adapters/storage/json-narrative-memory-store.ts'
t = read(p)

t = t.replace('''import {
  EpisodeMemorySchema,
  FactRecordSchema,
  LessonSchema,
  NarrativeMemoryStateSchema,
} from "../../core/narrative/memory-types.js";''', '''import {
  EpisodeMemorySchema,
  EndingReportSchema,
  FactRecordSchema,
  LessonSchema,
  NarrativeMemoryStateSchema,
} from "../../core/narrative/memory-types.js";''')

old = '''  async saveState(state: NarrativeMemoryState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, this.statePath);
  }

  async appendEpisodes(episodes: EpisodeMemory[]): Promise<void> {
    if (episodes.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = episodes.map((ep) => JSON.stringify(ep)).join("\\n");
    await appendFile(this.episodesPath, `${lines}\\n`, "utf8");
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    if (ops.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = ops.map((op) => JSON.stringify(op)).join("\\n");
    await appendFile(this.opsPath, `${lines}\\n`, "utf8");
  }'''
new = '''  /** tmp+rename 原子写（saveState/savePlan/writeEndingReport 共用）。 */
  private async writeAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  }

  async saveState(state: NarrativeMemoryState): Promise<void> {
    await this.writeAtomic(this.statePath, JSON.stringify(state));
  }

  async appendEpisodes(episodes: EpisodeMemory[]): Promise<void> {
    await this.appendJsonl(this.episodesPath, episodes);
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    await this.appendJsonl(this.opsPath, ops);
  }'''
assert old in t, 'saveState block'
t = t.replace(old, new, 1)

t = t.replace('''  async loadPlan(): Promise<DirectorPlan | null> {
    try {
      const raw = await readFile(this.planPath, "utf8");
      if (raw.trim().length > 0) {
        const parsed: unknown = JSON.parse(raw);
        // Structural corruption (valid JSON, wrong shape) degrades the same
        // way as syntax corruption: only a zod-valid plan is returned.
        const checked = DirectorPlanSchema.safeParse(parsed);
        if (checked.success) {
          return checked.data;
        }
      }
    } catch {
      // Missing or corrupt plan file → no plan, never throw.
    }
    return null;
  }

  async savePlan(plan: DirectorPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.planPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(plan), "utf8");
    await rename(tmpPath, this.planPath);
  }''', '''  async loadPlan(): Promise<DirectorPlan | null> {
    try {
      const raw = await readFile(this.planPath, "utf8");
      if (raw.trim().length > 0) {
        const parsed: unknown = JSON.parse(raw);
        // Structural corruption (valid JSON, wrong shape) degrades the same
        // way as syntax corruption: only a zod-valid plan is returned.
        const checked = DirectorPlanSchema.safeParse(parsed);
        if (checked.success) {
          return checked.data;
        }
      }
    } catch {
      // Missing or corrupt plan file → no plan, never throw.
    }
    return null;
  }

  async savePlan(plan: DirectorPlan): Promise<void> {
    await this.writeAtomic(this.planPath, JSON.stringify(plan));
  }''')

old = '''  async writeEndingReport(report: EndingReport): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.endingReportPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(report, null, 2), "utf8");
    await rename(tmpPath, this.endingReportPath);
  }'''
new = '''  async writeEndingReport(report: EndingReport): Promise<void> {
    const checked = EndingReportSchema.parse(report);
    await this.writeAtomic(this.endingReportPath, JSON.stringify(checked, null, 2));
  }'''
assert old in t, 'writeEndingReport'
t = t.replace(old, new, 1)

old = '''    const episodes: EpisodeMemory[] = [];
    const seenIds = new Set<string>();
    try {
      const raw = await readFile(this.episodesPath, "utf8");
      for (const line of raw.split("\\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          const checked = EpisodeMemorySchema.safeParse(parsed);
          if (checked.success) {
            // Dedupe by id: a failed persist retry may append the same
            // episode id twice (id is revision-derived and idempotent).
            if (!seenIds.has(checked.data.id)) {
              seenIds.add(checked.data.id);
              episodes.push(checked.data);
            }
          }
        } catch {
          // Corrupt single episode line → skip it, keep the rest.
        }
      }
    } catch {
      // Missing episodes file → empty list.
    }

    return { state, episodes };'''
new = '''    // 与 facts/lessons 同一泛化 jsonl 通道（损坏行跳过、按 id 去重）。
    const episodes = await this.loadJsonl(this.episodesPath, EpisodeMemorySchema);

    return { state, episodes };'''
assert old in t, 'episodes load block'
t = t.replace(old, new, 1)

write(p, t)
print('json-store unified')
