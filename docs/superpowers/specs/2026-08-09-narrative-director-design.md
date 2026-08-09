# NarrativeDirector 长线剧情系统 — 设计（第 1+2 步）

日期：2026-08-09
状态：已批准（作者确认）
范围：NarrativeDirector 第 1+2 步（记忆存储 + MemoryConsolidator）。第 3 步（PlotPlanner/DirectorPlan）与第 4 步（belief/embedding/SQLite）明确不做，只预留位置。

## 1. 目标与核心约束

在 Runtime 与 StoryGenerator 之间增加一个长线剧情层：把"记忆过去"与"规划未来"拆开。
第 1+2 步只做"记忆过去"：从正式 committed events 形成叙事记忆，供 Writer 生成下一段前读取一张足够小的"编剧便签"。

三条不可违反的约束：

1. **只从正式 committed events 形成记忆** —— 候选分支、预览候选永不进入 NarrativeMemory。
2. **未来计划永远不写入事实记忆** —— 第 1+2 步没有 planner，结构上保证。
3. **Planner 只规划 checkpoint，不写未来台词** —— 第 3 步事项，本设计不实现。

## 2. 范围

### 做
- `NarrativeMemoryState + EpisodeMemory + JSON 存储`（narrative-state.json / episodes.jsonl / narrative-ops.jsonl）
- 规则版线程/伏笔维护（classifySetup 的最小版）
- NarrativeBrief 渲染（"编剧便签"，注入 Writer 上下文）
- candidate 隔离（只订阅 committed events）
- MemoryConsolidator：LLM 低频异步，episode summary + thread/setup ops + validator

### 不做（预留）
- PlotPlanner / DirectorPlan（第 3 步）：不建 `director-plan.ts` 文件
- character belief / player knowledge / embedding / SQLite（第 4 步）
- `checkpoint(reason)` 只作为 consolidation 触发点，不规划未来

## 3. 作者静态设定：story-plan.yaml

新文件 `story-plan.yaml`，根键 `story_plan`，三段全部可选（缺省时从空状态开始）：

```yaml
story_plan:
  threads:  # PlotThread 种子（source: author）
  setups:   # SetupPayoff 种子（source: author，status: planned）
  anchors:  # [{id, purpose, prerequisites, required}]
```

- 示例内容（按作者题材：苏遥/终端）：
  - threads：`terminal_origin`（mystery）、`suyao_identity`（character）
  - setups：`terminal_reacts_to_suyao`（foreshadow）、`professor_disappearance`（mystery_clue）、`key_to_basement`（object）
  - anchors：`discover_terminal` → `doubt_suyao_identity` → `reveal_suyao_origin`（带 prerequisites，首个 required: true）
- 加载器 `src/adapters/static/story-plan-loader.ts`：纯函数（路径 → StoryPlan）。
  - yaml 语法/结构错误 → 启动时报清晰错误
  - 单个条目校验失败 → 跳过该条目 + warning（走 diagnostic sink），不整体崩溃

## 4. Core 类型与 Port

### `src/core/narrative/memory-types.ts`
- `PlotThread`：id / kind（main|character|mystery|relationship|promise）/ summary / status（open|developing|ready_to_resolve|resolved|abandoned）/ importance（major|minor）/ introducedAt / lastTouchedAt / nextPressure? / source（author|runtime）
- `SetupPayoff`：id / kind（foreshadow|mystery_clue|object|character|relationship|world_rule|promise|motif）/ setup / intendedPayoff? / status（planned|seeded|reinforced|ready|paid_off|dropped）/ threadId? / reinforcementCount / seededAt? / lastTouchedAt? / payoffAt? / prerequisites / payoffBeforeAnchor? / source
- `StoryAnchorState`：id / purpose / prerequisites / required / status（pending|reached|passed）
- `EpisodeMemory`：id / fromEventSeq / toEventSeq / summary / characters / locations / threads / setups / importance（major|normal）
- `NarrativeMemoryState`：revision / consolidatedThroughEventSeq / checkpointCount（递增，供 classifySetup 的 age 计算）/ threads / setups / anchors / recentEpisodeIds
- 全部加 zod schema（复用 src/schema.ts 风格）
- episode 索引：按 character / location / thread 的倒排（内存 Map，随 episodes 变化维护）

### `src/core/narrative/memory-operation.ts`
- `ThreadOp`：{ type: "touch"|"advance"|"resolve"|"abandon"|"create", id, progress? }
- `SetupOp`：{ type: "seed"|"reinforce"|"payoff"|"hold"|"drop", id, evidenceEventIds? }
- 应用结果结构：成功 ops / 被拒 ops（含原因）

### `src/core/narrative/narrative-brief.ts`
- `NarrativeBrief`：revision / consolidatedThroughEventSeq / currentEventSeq / location / characters / activeThreads（含 nextPressure）/ setupDirectives / relevantEpisodes / anchorsStatus / revealLocks（第 1+2 步恒为空数组，字段预留）
- `NarrativeBriefRequest`：turn / eventSeq / location / characters / currentInteraction?

### `src/core/ports/narrative-director-port.ts`
```ts
interface NarrativeDirectorPort {
  getBrief(request: NarrativeBriefRequest): NarrativeBrief;  // 同步，只读缓存，零 await
  observeCommitted(events: readonly StoredEvent[]): void;    // 只入队，不阻塞
  checkpoint(reason: NarrativeCheckpointReason): void;       // 调度 consolidation
}
```
- `getBrief` 必须快：只读内存缓存，绝不现场请求 LLM。

### `src/core/ports/narrative-memory-store-port.ts`
- load(): 恢复 NarrativeMemoryState + episodes（幂等）
- saveState(state): 原子写 narrative-state.json（tmp + rename）
- appendEpisodes(episodes)
- appendOps(ops)（debug 用 narrative-ops.jsonl）

## 5. Application 层（src/application/narrative/）

### narrative-director-service.ts（组合根）
- 持有：memory 状态（内存副本 + 持久化）、consolidation 队列、episode 索引、store port、consolidator、validator
- `observeCommitted(events)`：追加 recent events（内存）+ 排队 consolidation（可合并批次）
- `getBrief(request)`：episode-retriever + classifySetup 规则 → 组装 NarrativeBrief，纯内存
- `checkpoint(reason)`：若队列积压 ≥ batch_min_events 则触发一次 consolidation 批次
- 积压阈值自动触发：`observeCommitted` 后积压 ≥ batch_min_events 且距上次 ≥ min_checkpoint_gap_ms → 调度

### narrative-context-builder.ts
- memory + brief → 提示词文本段（"编剧工作台"格式）：
  - `[DIRECTOR NOTE]`：memory revision 标注（"记忆截至事件 X，最近 Y 条见 RECENT EVENTS"）
  - ACTIVE THREADS（含 nextPressure）
  - SETUP / PAYOFF TASKS（REINFORCE / HOLD / PAYOFF）
  - RELEVANT LONG MEMORY（episode 列表）
  - REVEAL LOCKS（空）
- 与现有 `src/story/context-builder.ts` 分离；无 brief 时输出空字符串（零变化）

### memory-consolidator.ts
- 触发：checkpoint / 积压阈值（单飞：一次只跑一个批次）
- 流程：读 `consolidatedThroughEventSeq+1 .. 当前` 的 committed events → adapter 生成结构化 ops → validator 校验 → 应用（更新 threads/setups/episode 索引 + 新 EpisodeMemory）→ 推进 revision + watermark → 持久化
- **raw events 来源 = director 运行时内存缓存**（`observeCommitted` 传入的正式事件，最近 ≤ max_events_per_call 条）。SessionStorePort 无读接口，不为此新增；重启后的 watermark 缺口跳过不补（痕迹仍在 ContextBuilder 的 recent raw events 里，不丢信息，只不进长线记忆）
- 失败：ops 记入 narrative-ops.jsonl（rejected 原因）+ 不推进 watermark（下次重试）
- fire-and-forget：异常绝不 reject 到 game 主循环；失败仅记 ops 日志 + 诊断指标

### memory-validator.ts（纯函数）
拒绝规则：
- 未知 thread/setup id
- 非法状态迁移（如 paid_off → seeded、dropped → reinforce）
- 超过 budget（§7 配置：major threads ≤ 2、minor ≤ 3、active setups ≤ 6）
- summary 超长（上限 200 字）
- op 声称的证据 event id 不在已提交范围内

### episode-retriever.ts
- §12 检索：`(characters∩) 最近 2 + (threads∩) 最近 2 + 全部 major`，去重、按 seq 倒序、截断 max_relevant_episodes（默认 6）

### classifySetup（最小版，私有于 director-service）
- payoffBeforeAnchor 命中当前 anchor → payoff/now
- seeded 且 age ≥ 2 checkpoint → reinforce/soon
- 其余 → hold/normal

## 6. Adapters

### src/adapters/storage/json-narrative-memory-store.ts
- 目录布局：`sessions/<session-id>/narrative-state.json`、`episodes.jsonl`、`narrative-ops.jsonl`（与 events.jsonl / state.json 并列）
- 原子写：tmp 文件 + rename
- 损坏文件：load 时返回空状态 + warning（不崩溃）

### src/adapters/llm/narrative-consolidator-adapter.ts
- 独立 OpenAI client（api.model / base_url / api_key_env 同 generator 配置）
- 非流式单轮，`response_format: json_object`
- 输入 = 最近 events 文本 + 当前 threads/setups 摘要（**不含任何未来计划**）
- 输出 = ThreadOp[] + SetupOp[] + EpisodeSummary（§6 原始设计形态）
- 解析失败 → 记 ops rejected + 诊断指标

## 7. Runtime 接入（改动最小化）

- `createRuntimeApplication`：组装 director service + json store + consolidator adapter（依赖注入，测试可替换）
- `game.ts`：
  - 构造新增可选依赖 `narrativeDirector?: NarrativeDirectorPort`（向后兼容；event mode 不传）
  - **唯一提交挂钩**：`this.store.append(event)`（game.ts:2162）旁同步调 `director.observeCommitted([stored])`
  - **interaction 完成**后调 `director.checkpoint("interaction_completed")`
  - 生成请求前：构造 NarrativeBriefRequest → `getBrief` → 放入请求对象新字段 `brief?: NarrativeBrief`
- `story-generator-port.ts`：OpeningRequest / ContinuationRequest / BranchPrefetchRequest / InputResponseRequest 加 `brief?: NarrativeBrief`
- `context-builder.ts`：`ContextInput` 加 `directorBrief?: NarrativeBrief`；DSL 版 buildUserPrompt 在 `[RECENT EVENTS]` 前渲染 `[DIRECTOR NOTE]` 段

## 8. 配置（config.yaml + config.ts）

```yaml
narrative:
  mode: longform        # longform | event（event 时 director 完全旁路）
  threads:
    max_major_active: 2
    max_minor_active: 3
  setups:
    max_active: 6
  consolidation:
    batch_min_events: 4      # 积压 ≥4 条才值得一次 LLM 调用
    max_events_per_call: 80  # 单次 consolidator 输入上限
    min_checkpoint_gap_ms: 5000
  brief:
    max_relevant_episodes: 6
    max_recent_raw_events: 40
```

- `mode: event`：`getBrief` 返回空 brief、`observeCommitted`/`checkpoint` 空操作（旁路防呆）

## 9. 隔离与错误处理

- candidate 隔离：`observeCommitted` 只在 `store.append` 正式落库处触发；prefetch 分支/预览候选天然不进记忆；现有事务逻辑不动
- 异步不阻塞：consolidation fire-and-forget；`getBrief` 同步读内存
- 滞后续写：brief 同时携带 consolidatedThroughEventSeq 与 currentEventSeq，渲染注明"记忆截至 X，最近事件见 RECENT EVENTS"
- 重入安全：consolidator 单飞，watermark 单调推进

## 10. 测试矩阵

| 层 | 测试 |
|---|---|
| memory-types | zod schema 解析/拒绝 |
| story-plan-loader | 合法 yaml、坏 yaml、坏条目跳过 + warning |
| json store | 写读往返、原子写、episodes append、恢复损坏文件 |
| memory-validator | 拒绝未知 id / 非法迁移 / budget 超限 |
| episode-retriever | 交集检索、major 恒包含、排序截断 |
| director-service | observeCommitted 入队、批次合并、watermark 推进、失败不推进、checkpoint 触发 |
| memory-consolidator | mock consolidator-adapter 返回 ops → 应用；非法 ops → rejected 记录 |
| consolidator-adapter | mock LLM HTTP 返回 ops JSON → 解析；坏 JSON → rejected 指标 |
| context-builder | brief 段渲染（含 revision 标注）、无 brief 时零变化 |
| game 集成 | 提交→observeCommitted；candidate 不进记忆；getBrief 进 ctx；event mode 旁路 |

## 11. 目录结构

```
story-plan.yaml
src/core/narrative/memory-types.ts
src/core/narrative/memory-operation.ts
src/core/narrative/narrative-brief.ts
src/core/ports/narrative-director-port.ts
src/core/ports/narrative-memory-store-port.ts
src/application/narrative/narrative-director-service.ts
src/application/narrative/narrative-context-builder.ts
src/application/narrative/memory-consolidator.ts
src/application/narrative/memory-validator.ts
src/application/narrative/episode-retriever.ts
src/adapters/llm/narrative-consolidator-adapter.ts
src/adapters/storage/json-narrative-memory-store.ts
src/adapters/static/story-plan-loader.ts
```

## 12. 成功标准

- node/web 全量测试保持全绿（新增测试覆盖 §10 矩阵）
- 双 typecheck + build 通过
- 一个端到端场景可验证：跑一局 → 提交事件 → observeCommitted → checkpoint → consolidator 生成 episode/ops → 下一段生成的 ctx 含 [DIRECTOR NOTE]；候选分支内容不出现在记忆里
- 文档：docs/superpowers/specs/ 提交本设计；docs §116 记录变更
