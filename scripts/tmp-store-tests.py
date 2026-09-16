import io

path = 'src/adapters/storage/json-narrative-memory-store.test.ts'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    t = f.read().rstrip('\r\n \t')

addition = '''

// ---------------------------------------------------------------------------
// MA-A 存储通道：facts.jsonl / lessons.jsonl / ending-report.json
// ---------------------------------------------------------------------------

describe("JsonNarrativeMemoryStore MA-A channels", () => {
  let dir: string;
  let store: JsonNarrativeMemoryStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nar-mem-maa-"));
    store = new JsonNarrativeMemoryStore(dir, "test-session");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips lessons and dedupes by id", async () => {
    const lesson: Lesson = {
      id: "lesson_1",
      tag: "setup-flow",
      content: "没有回收计划的伏笔不许下场",
      source: "rejection",
      sourceRef: "SETUP_SEED_WITHOUT_INTENDED_PAYOFF",
      occurrences: 2,
      active: true,
      createdAtCheckpoint: 3,
    };
    await store.appendLessons([lesson]);
    await store.appendLessons([{ ...lesson, occurrences: 3 }]); // 重试重写同 id
    const loaded = await store.loadLessons();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.occurrences).toBe(3);
  });

  it("round-trips facts and skips corrupt or invalid lines", async () => {
    const fact: FactRecord = {
      id: "fact_1",
      content: "地下室第 4 号门已焊死",
      evidenceEventSeqs: [3, 4],
      checkpoint: 2,
      superseded: false,
    };
    await store.appendFacts([fact]);
    const sessionDir = path.join(dir, "test-session");
    await appendFile(
      path.join(sessionDir, "facts.jsonl"),
      `{corrupt\\n"not-a-fact":true}\\n`,
      "utf8",
    );
    const loaded = await store.loadFacts();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.content).toBe("地下室第 4 号门已焊死");
  });

  it("loadLessons/loadFacts return empty arrays when files are missing", async () => {
    expect(await store.loadLessons()).toEqual([]);
    expect(await store.loadFacts()).toEqual([]);
  });

  it("writes the ending report atomically and overwrites on re-trigger", async () => {
    const report: EndingReport = {
      generatedAt: "2026-09-17T00:00:00Z",
      setups: { paidOff: 1, dropped: 0, active: 1, payoffRate: 0.5 },
      threads: { resolved: 1, abandoned: 0, active: 1 },
      lessons: [],
    };
    await store.writeEndingReport(report);
    const second = { ...report, setups: { ...report.setups, paidOff: 2 } };
    await store.writeEndingReport(second);
    const raw = await readFile(path.join(dir, "test-session", "ending-report.json"), "utf8");
    const parsed = JSON.parse(raw) as EndingReport;
    expect(parsed.setups.paidOff).toBe(2);
    expect(parsed.setups.payoffRate).toBe(0.5);
  });
});'''

addition = addition.replace('\\n', '\n')
addition_crlf = addition.replace('\n', '\r\n')
t = t + '\r\n' + addition_crlf + '\r\n'

# extend type imports for the new describe block
old_imp = 'import type { EpisodeMemory } from "../../core/narrative/memory-types.js";'
new_imp = ('import type {\n  EpisodeMemory,\n  FactRecord,\n  Lesson,\n  EndingReport,\n}'
           ' from "../../core/narrative/memory-types.js";')
if old_imp not in t:
    old_imp = old_imp.replace('\n', '\r\n')
    new_imp = new_imp.replace('\n', '\r\n')
assert old_imp in t, 'import line not found'
t = t.replace(old_imp, new_imp, 1)

# ensure readFile/appendFile imports exist
with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(t)
print('store tests appended')
