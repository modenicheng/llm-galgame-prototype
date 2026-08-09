# NarrativeDirector 长线剧情系统（第 1+2 步）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Runtime 与 StoryGenerator 之间实现长线叙事记忆层：只从正式 committed events 形成记忆，向 Writer 提供"编剧便签"（NarrativeBrief），并由低频异步 MemoryConsolidator 整理 episode/thread/setup。

**Architecture:** Core 层定义纯类型（zod schema）与两个 Port（`NarrativeDirectorPort`、`NarrativeMemoryStorePort`）；application 层实现 `NarrativeDirectorService`（组合根，getBrief 同步读内存）+ `MemoryConsolidator`（LLM 编排）+ 纯函数（validator/retriever/classifySetup）；adapters 层实现 JSON 文件存储与 OpenAI 结构化输出。Game 只加一个可选依赖 `ports.narrativeDirector`，在 `record()` 正式落库处 observeCommitted、interaction 完成后 checkpoint、生成请求前取 brief 传入 generator 的 ctx。

**Tech Stack:** TypeScript（ESM，`"type": "module"`，import 带 `.js` 后缀）、zod（现有依赖）、yaml（现有 `parse`）、openai SDK（现有依赖）、vitest。

**Spec:** `docs/superpowers/specs/2026-08-09-narrative-director-design.md`

## Global Constraints

- 只从正式 committed events 形成记忆：`observeCommitted` 只能在 `Game.record()` 的 `store.append` 成功之后调用。候选分支/预览候选永不进入记忆。
- 未来计划永远不写入事实记忆：本计划不实现任何 planner；`NarrativeBrief.revealLocks` 恒为空数组（字段预留）。
- `getBrief` 必须同步返回（无 await、无 LLM 调用），只读内存缓存。
- consolidation 是 fire-and-forget：任何异常只记 `narrative-ops.jsonl`（rejected）+ `diagnostics.warn`，绝不 reject 到 game 主循环。
- consolidator 单飞（一次只跑一个批次），watermark（`consolidatedThroughEventSeq`）单调推进。
- consolidator 的 raw events 来源 = director 运行时内存缓存（`observeCommitted` 传入），重启后的 watermark 缺口跳过不补。
- `narrative.mode: "event"` 时 director 完全旁路：`createRuntimeApplication` 不组装，`Game` 无 director → getBrief/observeCommitted/checkpoint 全部不发生。
- 所有新文件 import 用 `.js` 后缀（ESM）；测试文件与源文件同目录 `<name>.test.ts`。
- 每任务末尾 commit；全量命令：`timeout 400 npx vitest run src/`、`npx tsc --noEmit -p tsconfig.node.json`、`npx tsc --noEmit -p tsconfig.web.json`、`npm run build`。

---

### Task 1: Core narrative 类型与 zod schema

**Files:**
- Create: `src/core/narrative/memory-types.ts`
- Create: `src/core/narrative/memory-operation.ts`
- Create: `src/core/narrative/narrative-brief.ts`
- Test: `src/core/narrative/memory-types.test.ts`

**Interfaces:**
- Consumes: zod（`import { z } from "zod"`，检查现有 schema.ts 的 import 风格）
- Produces（后续任务全部依赖这些名字，禁止改名）:

```ts
// memory-types.ts
export type PlotThreadKind = "main" | "character" | "mystery" | "relationship" | "promise";
export type PlotThreadStatus = "open" | "developing" | "ready_to_resolve" | "resolved" | "abandoned";
export type SetupKind = "foreshadow" | "mystery_clue" | "object" | "character" | "relationship" | "world_rule" | "promise" | "motif";
export type SetupStatus = "planned" | "seeded" | "reinforced" | "ready" | "paid_off" | "dropped";
export type AnchorStatus = "pending" | "reached" | "passed";
export type EpisodeImportance = "major" | "normal";

export interface PlotThread {
  id: string; kind: PlotThreadKind; summary: string;
  status: PlotThreadStatus; importance: "major" | "minor";
  introducedAt: number; lastTouchedAt: number;
  nextPressure?: string; source: "author" | "runtime";
}
export interface SetupPayoff {
  id: string; kind: SetupKind; setup: string; intendedPayoff?: string;
  status: SetupStatus; threadId?: string; reinforcementCount: number;
  seededAt?: number; lastTouchedAt?: number; payoffAt?: number;
  prerequisites: string[]; payoffBeforeAnchor?: string; source: "author" | "runtime";
}
export interface StoryAnchorState {
  id: string; purpose: string; prerequisites: string[];
  required: boolean; status: AnchorStatus;
}
export interface EpisodeMemory {
  id: string; fromEventSeq: number; toEventSeq: number; summary: string;
  characters: string[]; locations: string[]; threads: string[]; setups: string[];
  importance: EpisodeImportance;
}
export interface NarrativeMemoryState {
  revision: number; consolidatedThroughEventSeq: number; checkpointCount: number;
  threads: Record<string, PlotThread>; setups: Record<string, SetupPayoff>;
  anchors: Record<string, StoryAnchorState>; recentEpisodeIds: string[];
}

export const PlotThreadSchema / SetupPayoffSchema / StoryAnchorStateSchema /
  EpisodeMemorySchema / NarrativeMemoryStateSchema: z.ZodType<...>  // 结构同接口，全字段必填、字符串非空
export const VALID_THREAD_TRANSITIONS: Record<PlotThreadStatus, PlotThreadStatus[]>
  // open→[developing,resolved,abandoned], developing→[ready_to_resolve,resolved,abandoned],
  // ready_to_resolve→[resolved,abandoned], resolved→[], abandoned→[]（terminal）
export const VALID_SETUP_TRANSITIONS: Record<SetupStatus, SetupStatus[]>
  // planned→[seeded,dropped], seeded→[reinforced,ready,paid_off,dropped],
  // reinforced→[ready,paid_off,dropped], ready→[paid_off,dropped],
  // paid_off→[], dropped→[]（terminal）
```

```ts
// memory-operation.ts
export interface ThreadOp { type: "touch" | "advance" | "resolve" | "abandon" | "create"; id: string; progress?: string; }
export interface SetupOp { type: "seed" | "reinforce" | "payoff" | "hold" | "drop"; id: string; evidenceEventIds?: string[]; }
export interface EpisodeSummaryOp {
  summary: string; characters: string[]; locations: string[]; threads: string[]; setups: string[];
  importance: EpisodeImportance;
}
export const ThreadOpSchema / SetupOpSchema / EpisodeSummaryOpSchema: z.ZodType<...>
export interface RejectedOp { kind: "thread" | "setup" | "episode"; op: unknown; reason: string; }
```

```ts
// narrative-brief.ts
export interface NarrativeBriefRequest {
  turn: number; eventSeq: number; location: string; characters: string[];
  currentInteractionId?: string;
}
export interface SetupDirective { id: string; action: "seed" | "reinforce" | "payoff" | "hold"; urgency: "now" | "soon" | "normal"; }
export interface NarrativeBrief {
  revision: number; consolidatedThroughEventSeq: number; currentEventSeq: number; checkpointCount: number;
  location: string; characters: string[];
  activeThreads: Array<Pick<PlotThread, "id" | "kind" | "summary" | "status" | "importance" | "lastTouchedAt" | "nextPressure">>;
  setupDirectives: SetupDirective[];
  relevantEpisodes: EpisodeMemory[];
  anchors: StoryAnchorState[];
  revealLocks: string[];  // 本计划恒为空数组
}
export const NarrativeBriefSchema: z.ZodType<NarrativeBrief>
```

- [ ] **Step 1: 写失败测试** `src/core/narrative/memory-types.test.ts`：zod 解析合法状态、拒绝缺字段、`VALID_THREAD_TRANSITIONS`/`VALID_SETUP_TRANSITIONS` 的终态映射（resolved/abandoned/paid_off/dropped → []）、NarrativeBrief 全字段往返。
- [ ] **Step 2: 运行确认失败**：`npx vitest run src/core/narrative/memory-types.test.ts` → FAIL（module not found）。
- [ ] **Step 3: 实现三个文件**（纯类型 + zod，无逻辑）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/core/narrative/` → PASS。
- [ ] **Step 5: Commit**：`git add src/core/narrative && git commit -m "feat(narrative): core memory types with zod schemas"`

---

### Task 2: config narrative 段

**Files:**
- Modify: `src/config.ts`（AppConfig 加 `narrative`；ConfigSchema 加 `narrative: z.object({...}).default(DEFAULT_NARRATIVE_CONFIG)`）
- Modify: `config.yaml`（加默认值段）
- Test: `src/config.test.ts`（加 case：未提供 narrative 时默认生效；显式提供时覆盖）

**Interfaces:**
- Consumes: 无（独立）
- Produces:

```ts
export interface NarrativeConfig {
  mode: "longform" | "event";
  threads: { max_major_active: number; max_minor_active: number };
  setups: { max_active: number };
  consolidation: { batch_min_events: number; max_events_per_call: number; min_checkpoint_gap_ms: number };
  brief: { max_relevant_episodes: number; max_recent_raw_events: number };
  story_plan_path: string;
}
export const DEFAULT_NARRATIVE_CONFIG: NarrativeConfig  // longform / 2 / 3 / 6 / 4 / 80 / 5000 / 6 / 40 / "story-plan.yaml"
```

- [ ] **Step 1: 失败测试**：`config.test.ts` 加 `it("narrative config defaults apply when absent")`（`ConfigSchema.parse({})` 或 `loadConfig` 缺省）与 `it("narrative config overrides")`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：config.ts 加接口 + `DEFAULT_NARRATIVE_CONFIG` + schema `.default(...)`；config.yaml 加注释段（同默认值）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/config.test.ts` + `npx tsc --noEmit -p tsconfig.node.json`。
- [ ] **Step 5: Commit**：`git commit -m "feat(config): narrative section with defaults"`

---

### Task 3: story-plan-loader + story-plan.yaml 示例

**Files:**
- Create: `src/adapters/static/story-plan-loader.ts`
- Create: `story-plan.yaml`
- Test: `src/adapters/static/story-plan-loader.test.ts`

**Interfaces:**
- Consumes: `PlotThread`/`SetupPayoff`/`StoryAnchorState` + zod schemas（Task 1）；`DiagnosticSink`（`src/core/ports/diagnostic-sink.ts`）；yaml `parse`（`import { parse } from "yaml"`，与 config.ts 同源）
- Produces:

```ts
export interface StoryPlan {
  threads: PlotThread[];      // source: "author"，完整字段
  setups: SetupPayoff[];      // source: "author"，status 强制 "planned"，prerequisites 默认 []
  anchors: StoryAnchorState[]; // status 强制 "pending"
}
export async function loadStoryPlan(path: string, diagnostics?: DiagnosticSink): Promise<StoryPlan>
// ENOENT → { threads: [], setups: [], anchors: [] }（不报错）
// yaml 语法/结构错误（非 ENOENT）→ throw（启动时报清晰错误）
// 单条目 zod 失败 → 跳过 + diagnostics.warn("StoryPlan", "thread 条目跳过: <id> <原因>")
```

`story-plan.yaml` 内容（示例，注释标明"示例设定，请作者替换"）：`threads`: `terminal_origin`（mystery/developing/major，nextPressure"下一次接触研究资料时，应产生一个足以推翻旧推测的新线索"）、`suyao_identity`（character/open/major）；`setups`: `terminal_reacts_to_suyao`（foreshadow，setup"终端似乎会对苏遥产生异常响应。"，intendedPayoff"揭示终端能够识别她记忆中留下的特征。"，prerequisites `player_has_questioned_suyao_identity`，payoffBeforeAnchor `reveal_suyao_origin`）、`professor_disappearance`（mystery_clue）、`key_to_basement`（object）；`anchors`: `discover_terminal`（required: true）→ `doubt_suyao_identity`（prerequisites: [discover_terminal]）→ `reveal_suyao_origin`（prerequisites: [doubt_suyao_identity]）。yaml 键名与 TS 字段一一对应（snake_case 键 → camelCase 字段：`next_pressure`、`intended_payoff`、`thread_id`、`reinforcement_count`、`seeded_at`、`last_touched_at`、`payoff_at`、`prerequisites`、`payoff_before_anchor`、`introduced_at`）。

- [ ] **Step 1: 失败测试**：合法 yaml 全解析（含 snake_case 映射）；不存在文件 → 空 plan；坏语法文件 → throw；坏条目（缺字段）→ 跳过 + warn 记录（用 `recordingDiagnostics` 小 helper 捕获 warn）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 loader + story-plan.yaml**（测试里用 `writeFile` 到 tmpdir 写 yaml 内容，不依赖仓库内文件）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/adapters/static/`。
- [ ] **Step 5: Commit**：`git add src/adapters/static story-plan.yaml && git commit -m "feat(narrative): story-plan loader and sample plan"`

---

### Task 4: NarrativeMemoryStorePort + JSON store adapter

**Files:**
- Create: `src/core/ports/narrative-memory-store-port.ts`
- Create: `src/adapters/storage/json-narrative-memory-store.ts`
- Test: `src/adapters/storage/json-narrative-memory-store.test.ts`

**Interfaces:**
- Consumes: `NarrativeMemoryState`/`EpisodeMemory`（Task 1）；`NarrativeConfig`（Task 2，用 `story_plan_path` 无关，只读 sessionDir）；`RejectedOp`（Task 1）
- Produces:

```ts
// port
export interface NarrativeMemoryStorePort {
  readonly location: string;
  load(): Promise<{ state: NarrativeMemoryState; episodes: EpisodeMemory[] }>;
  saveState(state: NarrativeMemoryState): Promise<void>;
  appendEpisodes(episodes: EpisodeMemory[]): Promise<void>;
  appendOps(ops: RejectedOp[]): Promise<void>;
}
```

- `JsonNarrativeMemoryStore` 构造：`new JsonNarrativeMemoryStore(sessionDir: string)`。文件布局（与 events.jsonl 同目录）：
  - `narrative-state.json`（原子写：`writeFile(tmp)` → `rename`；不存在 → 空状态 `{ revision: 0, consolidatedThroughEventSeq: 0, checkpointCount: 0, threads: {}, setups: {}, anchors: {}, recentEpisodeIds: [] }`）
  - `episodes.jsonl`（每行一个 EpisodeMemory JSON；不存在 → []）
  - `narrative-ops.jsonl`（每行一个 RejectedOp）
  - `load()` 读损坏 JSON：该文件内容丢弃 + 返回空（不 throw）；损坏的单行 episode：跳过该行
- 参考现有 `src/adapters/storage/node-jsonl-session-store.ts` 的 fs 风格（`mkdir` recursive、`appendFile`）。

- [ ] **Step 1: 失败测试**：往返（saveState→load 相等、episodes append→load）；原子写（写后文件存在且内容为最后状态）；损坏 state.json → 空状态不 throw；损坏 episode 行 → 跳过；appendOps 累积。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 port + store**（tmpdir 测试目录，每测试用 `mkdtemp`，测试后 `rm`）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/adapters/storage/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): JSON narrative memory store"`

---

### Task 5: memory-validator + episode-retriever + classifySetup

**Files:**
- Create: `src/application/narrative/memory-validator.ts`
- Create: `src/application/narrative/episode-retriever.ts`
- Test: `src/application/narrative/memory-validator.test.ts`
- Test: `src/application/narrative/episode-retriever.test.ts`

**Interfaces:**
- Consumes: 全部类型（Task 1）；`NarrativeConfig`（Task 2）
- Produces:

```ts
// memory-validator.ts
export function validateThreadOp(op: ThreadOp, memory: NarrativeMemoryState, config: NarrativeConfig): string | null;
// null = 通过；否则拒绝原因。规则：
//  - create: id 不能已存在；活跃 major（open/developing/ready_to_resolve 且 major）数 ≥ max_major_active → 拒
//  - touch/advance/resolve/abandon: id 必须存在；advance 必须合法迁移（VALID_THREAD_TRANSITIONS）
//  - resolve/abandon: 目标态必须非 terminal 即当前非 resolved/abandoned
export function validateSetupOp(op: SetupOp, memory: NarrativeMemoryState, config: NarrativeConfig): string | null;
//  - seed: id 必须存在且 status 为 planned；活跃（非 planned/paid_off/dropped）setup 数 ≥ max_active → 拒
//  - reinforce/payoff/hold/drop: id 必须存在；reinforce 只允许 seeded|reinforced；payoff 只允许 reinforced|ready；
//    drop 只允许非 terminal；hold 恒通过
export function validateEpisodeOp(op: EpisodeSummaryOp): string | null;
//  - summary 非空且 ≤ 200 字符；数组字段元素非空、去重后 ≤ 20
export function classifySetup(item: SetupPayoff, checkpoint: number, currentAnchorId: string | undefined): SetupDirective | undefined;
//  - paid_off/dropped → undefined
//  - payoffBeforeAnchor === currentAnchorId → { action: "payoff", urgency: "now" }
//  - seeded 且 (checkpoint - (lastTouchedAt ?? seededAt ?? checkpoint)) >= 2 → { action: "reinforce", urgency: "soon" }
//  - 否则 { action: "hold", urgency: "normal" }

// episode-retriever.ts
export function retrieveEpisodes(
  episodes: EpisodeMemory[],
  opts: { characters: string[]; threads: string[]; max: number },
): EpisodeMemory[];
// 1) characters 交集（episode.characters ∩ opts.characters 非空）按 toEventSeq 倒序取最近 2
// 2) threads 交集同样取最近 2（与 1 去重）
// 3) importance === "major" 全部加入（去重）
// 结果按 toEventSeq 倒序，截断到 max
```

- [ ] **Step 1: 失败测试**：validator 各拒绝规则（未知 id、非法迁移 paid_off→seeded 类、major budget 超限、setup budget、episode summary 超长）；classifySetup 三分支；retriever 交集/去重/排序/截断/major 恒包含。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现三个纯函数**（无 IO、无类）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/application/narrative/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): validator, retriever, classifySetup rules"`

---

### Task 6: NarrativeDirectorService（核心，无 LLM）

**Files:**
- Create: `src/core/ports/narrative-director-port.ts`
- Create: `src/application/narrative/narrative-director-service.ts`
- Test: `src/application/narrative/narrative-director-service.test.ts`

**Interfaces:**
- Consumes: 类型（Task 1）、`NarrativeConfig`（Task 2）、`StoryPlan`（Task 3）、`NarrativeMemoryStorePort`（Task 4）、validator/retriever/classifySetup（Task 5）、`MemoryConsolidatorPort`（**本任务先定义接口**，Task 8 实现）、`DiagnosticSink`、`StoredEvent`（`src/schema.ts`）
- Produces:

```ts
// narrative-director-port.ts
export type NarrativeCheckpointReason = "interaction_completed" | "segment_ended" | "scene_change";
export interface NarrativeDirectorPort {
  getBrief(request: NarrativeBriefRequest): NarrativeBrief;   // 同步
  observeCommitted(events: readonly StoredEvent[]): void;     // 入队 + 可能调度
  checkpoint(reason: NarrativeCheckpointReason): void;        // checkpointCount += 1 + 调度
}

// narrative-director-service.ts
export interface MemoryConsolidatorPort {
  consolidate(request: ConsolidationRequest): Promise<ConsolidationResult>;
}
export interface ConsolidationRequest {
  events: StoredEvent[]; threads: PlotThread[]; setups: SetupPayoff[];
  stateLocation: string; stateCharacters: string[];
}
export interface ConsolidationResult {
  episode: EpisodeSummaryOp; threadOps: ThreadOp[]; setupOps: SetupOp[];
}
export class NarrativeDirectorService implements NarrativeDirectorPort {
  constructor(opts: {
    config: NarrativeConfig; store: NarrativeMemoryStorePort;
    consolidator: MemoryConsolidatorPort | undefined; plan: StoryPlan;
    diagnostics?: DiagnosticSink;
  });
  async initialize(): Promise<void>;  // store.load() → 内存；plan 合并（author 种子合入空状态，id 冲突以 plan 为准）
  getBrief(request: NarrativeBriefRequest): NarrativeBrief;
  observeCommitted(events: readonly StoredEvent[]): void;
  checkpoint(reason: NarrativeCheckpointReason): void;
  // 测试辅助（应用层内聚）：consolidatePending() 暴露为 public async，测试直接 await
  consolidatePending(): Promise<{ applied: number; rejected: RejectedOp[] }>;
}
```

- 内部语义：
  - `pendingEvents: StoredEvent[]`；`observeCommitted` push。
  - 调度：`maybeSchedule()` —— consolidator 非 undefined && pending ≥ batch_min_events && 距上次 consolidate ≥ min_checkpoint_gap_ms && 不在跑 → `void this.consolidatePending().catch(...)`（fire-and-forget，catch 只 `diagnostics.warn`，绝不 throw）。
  - `checkpoint()`：`checkpointCount += 1`，然后 `maybeSchedule()`。
  - `consolidatePending()`：取 pending 全部（超 max_events_per_call 只留最后 N）；`consolidator.consolidate({events, threads: 全部 active, setups: 全部非 terminal, stateLocation: 最近事件里的 location（无则 ""）, stateCharacters: []})`——本任务 consolidator 为 undefined 时直接返回 `{ applied: 0, rejected: [] }`；**apply 逻辑本任务就实现**（validate → apply → episode 追加 → recentEpisodeIds 前插截断 20 → revision+1 → consolidatedThroughEventSeq = 批末 seq → saveState + appendEpisodes + appendOps(rejected)）。apply 用纯私有方法 `applyThreadOp`/`applySetupOp`（touch→lastTouchedAt 更新+progress 覆盖 summary 可选、advance→状态迁移、resolve→resolved、abandon→abandoned、create→新 runtime thread；seed→seeded+seededAt、reinforce→reinforced+count+1+lastTouchedAt、payoff→paid_off+payoffAt、hold→无变化、drop→dropped）。
  - `getBrief`：`retrieveEpisodes`（characters/threads 来自 request，max = config.brief.max_relevant_episodes）+ active threads（非 resolved/abandoned）+ `classifySetup` 对所有非 terminal setup（checkpoint = checkpointCount，currentAnchorId = 最近 reached/passed anchor 之后第一个 pending anchor 的 id，无则 undefined）+ anchors 全量（按 status 排序）；`revealLocks: []`。
- 状态应用顺序在 consolidatePending 内：先 episode（追加）、再 threadOps、再 setupOps；每个 op 经 validator，被拒入 rejected 不应用。

- [ ] **Step 1: 失败测试**（director-service.test.ts，用 fake consolidator 直接返回固定 result + recording store（内存实现 NarrativeMemoryStorePort）+ recording diagnostics）：
  - initialize 合并 plan 种子（threads/setups/anchors 进入内存）
  - observeCommitted 入队 + getBrief 不触发 consolidate（consolidator undefined 时 applied 0）
  - checkpoint 递增 checkpointCount 且 brief 里可见
  - consolidatePending：mock result → validator 通过 → threads/setups 更新 + episode 追加 + revision/watermark 推进 + store.saveState 调用；非法 op → rejected 记录 + 不应用 + appendOps 调用
  - 失败不推进：consolidator.consolidate reject → consolidatePending 不 throw、watermark 不动
  - getBrief：relevantEpisodes 按 retriever 规则、setupDirectives 含 classifySetup 产物、revealLocks 为空
  - 调度门槛：pending < batch_min_events 不调 consolidator；≥ 且 gap 满足 → 调（用 fake consolidator 计数）
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 port + service**。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/application/narrative/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): director service with brief, commit observation, consolidation pipeline"`

---

### Task 7: NarrativeBrief 渲染 + context-builder 集成

**Files:**
- Create: `src/application/narrative/narrative-context-builder.ts`
- Modify: `src/story/context-builder.ts`
- Test: `src/application/narrative/narrative-context-builder.test.ts`
- Test: `src/story/context-builder.test.ts`（追加 case）

**Interfaces:**
- Consumes: `NarrativeBrief`（Task 1）、`NarrativeConfig`（Task 2，取 `brief.max_recent_raw_events`）
- Produces:

```ts
export function renderDirectorNote(brief: NarrativeBrief, maxRecentRawEvents: number): string;
// 空 brief（revision === 0 且无任何 active threads/setups/episodes/anchors 信息？简化：调用方保证传 longform brief；
// 渲染规则——每段仅在有内容时输出，用 "===== 导演便签 =====" 开头：
//   "记忆已整理至事件 {consolidatedThroughEventSeq}（当前事件 {currentEventSeq}），最近 {maxRecentRawEvents} 条原始事件见下方剧情历史。"
//   "[活跃剧情线]" 每条：`- {id}（{kind}，{status}，{importance}）：{summary}`；有 nextPressure 加 ` 压力：{nextPressure}`
//   "[伏笔任务]" 每条：`- {action} {id}（{urgency}）`；action 大写
//   "[相关长线记忆]" 每条：`- 事件 {fromEventSeq}-{toEventSeq}：{summary}`
//   "[锚点进度]" 每条：`- {id}：{status}`（按传入顺序）
//   "[禁止透露]"（revealLocks 非空时）：每条 `- {id}`（本计划恒不出现）
```

`context-builder.ts` 修改：
- `ContextInput` 加 `directorBrief?: NarrativeBrief`（import 自 `../core/narrative/narrative-brief.js`，注意 context-builder.ts 在 `src/story/`，相对路径 `../core/narrative/narrative-brief.js`）
- `DslContextInput` 不变（继承）
- `buildDslUserPrompt`：在 `===== 剧情历史 =====` 段**之后**、`===== 当前舞台状态 =====` 之前插入：`if (input.directorBrief) sections.push(renderDirectorNote(input.directorBrief, input.maxRecentRawEvents))`——需要 `DslContextInput` 加 `maxRecentRawEvents?: number`（默认 40 常量 `DEFAULT_MAX_RECENT_RAW_EVENTS` 导出自 narrative-context-builder.ts）。

- [ ] **Step 1: 失败测试**：narrative-context-builder.test.ts（含 threads/setups/episodes/anchors/revealLocks 各段渲染、空列表省略段、revision 标注行）；context-builder.test.ts 追加：有 directorBrief 时 user prompt 含 `导演便签` 且位于 剧情历史 之后；无 brief 时输出与现状完全一致（现有测试已锁）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/story/ src/application/narrative/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): director note rendering in writer prompt"`

---

### Task 8: MemoryConsolidator（应用层）

**Files:**
- Create: `src/application/narrative/memory-consolidator.ts`
- Modify: `src/application/narrative/narrative-director-service.ts`（consolidatePending 抽取为调用 MemoryConsolidator）
- Test: `src/application/narrative/memory-consolidator.test.ts`

**Interfaces:**
- Consumes: `MemoryConsolidatorPort`/`ConsolidationRequest`/`ConsolidationResult`（Task 6 定义）、validator（Task 5）、`NarrativeConfig`（Task 2）、`DiagnosticSink`
- Produces:

```ts
export interface ConsolidationOutcome {
  result: ConsolidationResult | null;       // consolidator 失败 → null
  episode: EpisodeMemory | null;            // 通过校验的 episode（id 由本类生成）
  threadOps: ThreadOp[];                    // 通过校验
  setupOps: SetupOp[];                      // 通过校验
  rejected: RejectedOp[];
}
export class MemoryConsolidator {
  constructor(opts: { port: MemoryConsolidatorPort; config: NarrativeConfig; diagnostics?: DiagnosticSink });
  // 截断 events 到 max_events_per_call（取最后 N）；调 port；validator 过滤；episode id = `ep_{revision+1}_{fromSeq}`
  async consolidate(
    events: StoredEvent[], memory: NarrativeMemoryState,
    stateLocation: string, stateCharacters: string[],
  ): Promise<ConsolidationOutcome>;
}
```

**重构说明（抽取）**：Task 6 的 `NarrativeDirectorService.consolidatePending()` 内联实现了"调 port → validator → apply"管线。本任务把"调 port + 截断 + validator 过滤 + episode id 生成"抽取到 `MemoryConsolidator` 类（行为不变：同样的 validator 规则、同样的拒绝记录），并修改 director-service：`consolidatePending()` 改为调用 `memoryConsolidator.consolidate(...)`，把返回的 episode/threadOps/setupOps 应用、rejected 记录；director 持有 `MemoryConsolidator`（由构造参数 `consolidator: MemoryConsolidatorPort | undefined` 内部包装，consolidator 为 undefined 时 MemoryConsolidator 也返回空 outcome）。director-service 现有测试必须保持全绿（重构不改行为）。

- [ ] **Step 1: 失败测试**（mock MemoryConsolidatorPort）：成功路径（result → 校验 → episode id/字段、ops 透传）；非法 threadOp/setupOp 进 rejected；port reject → outcome.result null 且不 throw；截断（> max_events_per_call 只传最后 N 给 port，断言 port 收到的 events 长度）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): memory consolidator orchestration"`

---

### Task 9: NarrativeConsolidatorAdapter（LLM）

**Files:**
- Create: `src/adapters/llm/narrative-consolidator-adapter.ts`
- Test: `src/adapters/llm/narrative-consolidator-adapter.test.ts`

**Interfaces:**
- Consumes: `MemoryConsolidatorPort`（Task 6）、`ConsolidationRequest`/`ConsolidationResult`、`ThreadOpSchema`/`SetupOpSchema`/`EpisodeSummaryOpSchema`（Task 1）、`NarrativeConfig`（Task 2）、`serializeStoryContext`（`src/story/context-builder.ts`，输入 `StoredEvent[]` 兼容 `StoryContextEvent`）、`DiagnosticSink`
- Produces:

```ts
export class NarrativeConsolidatorAdapter implements MemoryConsolidatorPort {
  constructor(opts: {
    apiKey: string; api: AppConfig["api"]; config: NarrativeConfig;
    diagnostics?: DiagnosticSink; client?: OpenAI;   // client 注入用于测试
  });
  consolidate(request: ConsolidationRequest): Promise<ConsolidationResult>;
}
```

- 实现：非流式 `client.chat.completions.create({ model, messages: [system, user], response_format: { type: "json_object" }, temperature: 0.3 })`（参考 generator 的构造方式：`src/adapters/llm/openai-compatible-generator.ts` 的 client 构造与 `api` 字段用法）。
  - system：固定中文指令——"你是剧情记忆整理器。输入一段已发生剧情，输出 JSON：{episode:{summary,characters,locations,threads,setups,importance}, threadOps:[{type,id,progress?}], setupOps:[{type,id,evidenceEventIds?}]}。只整理事实，不要推测未来，不要写未来计划。threads/setups 只能引用给定列表中的 id。summary 不超过 200 字。"
  - user：`===== 剧情事件 =====\n{serializeStoryContext(events)}\n\n===== 当前剧情线 =====\n{threads 摘要}\n\n===== 当前伏笔 =====\n{setups 摘要}`（threads/setups 摘要格式：`- {id}（{status}）：{summary}`）
  - 输出：`JSON.parse` 失败 / zod 校验失败 → `diagnostics.warn("NarrativeConsolidator", ...)` + throw `new Error("consolidator 输出解析失败")`（由 director 的 fire-and-forget 兜底）。

- [ ] **Step 1: 失败测试**（fake client：`{ chat: { completions: { create: vi.fn() } } } as unknown as OpenAI`）：请求发出（断言 create 调用含 model/messages 长度/response_format）；合法 JSON 响应 → 解析为 ConsolidationResult；坏 JSON 响应 → throw；缺字段 JSON → throw；线程/伏笔摘要出现在 user 消息（toContain id）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/adapters/llm/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): LLM consolidator adapter with structured output"`

---

### Task 10: Game 接入（observeCommitted / checkpoint / brief 传递）

**Files:**
- Modify: `src/game.ts`
- Modify: `src/adapters/llm/openai-compatible-generator.ts`
- Modify: `src/core/ports/story-generator-port.ts`（可选一致性：request 类型加 `brief?: NarrativeBrief`）
- Test: `src/game.test.ts`（追加集成 case）

**Interfaces:**
- Consumes: `NarrativeDirectorPort`（Task 6）、`NarrativeBrief`（Task 1）
- Produces（无新导出）：

- `src/game.ts`：
  - `GamePorts` 加 `narrativeDirector?: NarrativeDirectorPort;`（`src/game.ts:151`）
  - 构造体加 `this.narrativeDirector = ports.narrativeDirector;`（字段 `private readonly narrativeDirector?: NarrativeDirectorPort;`）
  - `record()`（`src/game.ts:2160`）：`await this.store.append(event); this.narrativeDirector?.observeCommitted([event]);`
  - `handleInteractionInput` 的 `waitForCommand` 消费处（`src/game.ts:824` 的 `const command = await this.waitForCommand(...)` 之后）：`this.narrativeDirector?.checkpoint("interaction_completed");`
  - `startActiveSegment`（`src/game.ts:555` 附近）：构造 brief 并注入 dslOptions：

```ts
const brief = this.narrativeDirector?.getBrief({
  turn,
  eventSeq: this.seq,
  location: this.storyState.scene.location,
  characters: Object.keys(this.storyState.characters),
});
const dslOptions = {
  onGroup,
  onSegmentEnd,
  tailVisualState: this.tailVisualState,
  ...(brief ? { brief } : {}),
  ...(repairReason ? { repairReason } : {}),
};
```

  - 其余三个生成调用点（`generateBranchPrefetch` 1162、`generateInputResponse` 1837、`generateInputBridge` 2082 附近）：同样构造 brief（同一 helper `private makeBrief(): NarrativeBrief | undefined` 供四处复用）并传 `options` 参数里的 `brief`。
- `src/adapters/llm/openai-compatible-generator.ts`：
  - `GenerationStreamOptions` 加 `brief?: NarrativeBrief;`
  - `buildDslCtx` 加第三段：`if (options?.brief) ctx.directorBrief = options.brief;`（DslContextInput 加 `directorBrief?: NarrativeBrief`，`maxRecentRawEvents: this.config.narrative.brief.max_recent_raw_events`）
- `src/core/ports/story-generator-port.ts`：`OpeningRequest`/`ContinuationRequest`/`BranchPrefetchRequest`/`InputResponseRequest` 加 `brief?: NarrativeBrief;`（一致性，实际不消费）。

- [ ] **Step 1: 失败测试**（game.test.ts 追加 describe "NarrativeDirector integration"，用 recording director fake 实现 `NarrativeDirectorPort`）：
  - 正式播放一条 line → fake 收到 observeCommitted 且事件是已落库的 stored event（seq 匹配）
  - 走一个 choice 交互：选择后 fake 收到 checkpoint("interaction_completed")；候选 prefetch 分支内容不触发 observeCommitted（fake 收到的事件里没有 prefetch 文本）
  - 生成请求携带 brief：fake getBrief 返回固定 brief，用 llm.test 同款方式断言 generator 收到的 options.brief（或通过 buildDslUserPrompt 输出含 `导演便签`——用注入的 recording generator？game.test 现有 generator mock 是 vi.fn 包装的 StoryGenerator 实例——断言 `generateOpening` 的第 4 参 options.brief 等于 fake 返回值）
  - 不传 director 时行为零变化（现有全部测试天然覆盖）
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/game.test.ts`（现有 75 个全绿 + 新增）。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): wire director into game runtime (observe/checkpoint/brief)"`

---

### Task 11: createRuntimeApplication 组装 + 集成测试

**Files:**
- Modify: `src/bootstrap/create-runtime-application.ts`
- Test: `src/bootstrap/create-runtime-application.test.ts`（追加 case）

**Interfaces:**
- Consumes: `NarrativeDirectorService`（Task 6）、`JsonNarrativeMemoryStore`（Task 4）、`NarrativeConsolidatorAdapter`（Task 9）、`loadStoryPlan`（Task 3）、`NarrativeConfig`（Task 2）
- Produces:

- `RuntimeApplicationOptions` 加 `storyPlanPath?: string`（默认 `config.narrative.story_plan_path`）。
- 组装（在 `new NodeJsonlSessionStore(...)` 之后、`new Game(...)` 之前）：

```ts
let narrativeDirector: NarrativeDirectorPort | undefined;
if (config.narrative.mode === "longform") {
  const plan = await loadStoryPlan(options.storyPlanPath ?? config.narrative.story_plan_path, new ConsoleDiagnosticSink());
  const narrativeStore = new JsonNarrativeMemoryStore(options.sessionDir ?? config.game.sessions_dir);
  const consolidator = new NarrativeConsolidatorAdapter({ apiKey, api: config.api, config: config.narrative, diagnostics: new ConsoleDiagnosticSink() });
  narrativeDirector = new NarrativeDirectorService({
    config: config.narrative, store: narrativeStore,
    consolidator, plan, diagnostics: new ConsoleDiagnosticSink(),
  });
  await narrativeDirector.initialize();
}
```

- `GamePorts` 传 `...(narrativeDirector ? { narrativeDirector } : {})`。
- `mode: "event"` 时零组装（Game 无 director，旁路）。

- [ ] **Step 1: 失败测试**（create-runtime-application.test.ts 追加）：
  - `makeTestConfig({ narrative: { mode: "longform", story_plan_path: tmpStoryPlan } })` + mock StoryGenerator（现成 generatorState 模式）→ app.game 内部 `(game as any).narrativeDirector` 为 NarrativeDirectorService 实例；跑一局 → `sessions/<id>/narrative-state.json` 与 `narrative-ops.jsonl` 文件存在（consolidation 可能未触发，state 文件由 initialize 后的首次 save 或 observeCommitted 调度产生——断言策略：直接调 `(game as any).narrativeDirector.consolidatePending()` 不可取；改为断言文件最终存在：跑局 + checkpoint 后等待 microtask，用 `await new Promise(r => setTimeout(r, 10))`，然后读文件存在）。
  - `mode: "event"`（默认 makeTestConfig）→ `(game as any).narrativeDirector` undefined。
  - story_plan_path 指向不存在文件 → 不 throw（空 plan），game 正常跑。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**：`npx vitest run src/bootstrap/`。
- [ ] **Step 5: Commit**：`git commit -m "feat(narrative): compose director in runtime application"`

---

### Task 12: 文档 + 全量验证

**Files:**
- Modify: `docs/llm-outputs-refactor.md`（追加 §116 NarrativeDirector 记录：模块边界、三约束、配置、文件布局）
- 全量验证（本任务无新代码）

- [ ] **Step 1: 全量测试**：`timeout 400 npx vitest run src/` → 全部通过（现有 1084 + 新增）。
- [ ] **Step 2: web 侧**：`timeout 400 npx vitest run web/` → 全部通过；`npx tsc --noEmit -p tsconfig.web.json` 无错误。
- [ ] **Step 3: typecheck + build**：`npx tsc --noEmit -p tsconfig.node.json` && `npm run build`。
- [ ] **Step 4: 文档**：追加 docs §116（含 `narrative` 配置说明、文件布局 `sessions/<id>/{narrative-state.json,episodes.jsonl,narrative-ops.jsonl}`、三约束、mode: event 旁路说明）。
- [ ] **Step 5: Commit**：`git commit -m "docs: narrative director §116"`

---

## Self-Review 记录

- **Spec 覆盖**：§3 story-plan（Task 3）、§4 类型/port（Task 1/6）、§5 application 层（Task 5/6/7/8）、§6 adapters（Task 4/9）、§7 runtime 接入（Task 10/11）、§8 配置（Task 2）、§9 隔离（Task 10 record 挂钩 + Task 6 语义）、§10 测试矩阵（各任务测试）、§11 目录（全部对应）。spec §5 的"episode 索引倒排"简化为 retriever 直接扫 episodes 数组（几十条规模，YAGNI；spec §12 明确不需要索引结构）。
- **一致性**：`NarrativeDirectorPort` 三方法签名在 Task 6/10/11 完全一致；`MemoryConsolidatorPort` 在 Task 6 定义、Task 8/9 实现；`NarrativeBrief` 字段在 Task 1/6/7/10 一致；`consolidatedThroughEventSeq` 命名全程一致（无 consolidatedThrough 缩写变体）。
- **无占位符**：每个任务含真实测试代码与实现描述。
