import io

p = 'src/adapters/storage/json-narrative-memory-store.ts'
with io.open(p, 'r', encoding='utf-8', newline='') as f:
    t = f.read().replace('\r\n', '\n')

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
    const lines = episodes.map((ep) => JSON.stringify(ep)).join("\n");
    await appendFile(this.episodesPath, `${lines}\n`, "utf8");
  }

  async appendOps(ops: RejectedOp[]): Promise<void> {
    if (ops.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    const lines = ops.map((op) => JSON.stringify(op)).join("\n");
    await appendFile(this.opsPath, `${lines}\n`, "utf8");
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

old = '''  async savePlan(plan: DirectorPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${this.planPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, JSON.stringify(plan), "utf8");
    await rename(tmpPath, this.planPath);
  }'''
new = '''  async savePlan(plan: DirectorPlan): Promise<void> {
    await this.writeAtomic(this.planPath, JSON.stringify(plan));
  }'''
assert old in t, 'savePlan'
t = t.replace(old, new, 1)

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
      for (const line of raw.split("\n")) {
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
assert old in t, 'episodes load'
t = t.replace(old, new, 1)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(t.replace('\n', '\r\n'))
print('json-store unified')
