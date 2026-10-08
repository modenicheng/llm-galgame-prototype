# NarrativeDirector 记忆子层 — 设计现状（「记忆过去」）

日期：2026-08-09 设计；2026-09-17 随 v2 落地重写为现状规范（原第 3 步
PlotPlanner/DirectorPlan 已于 M4.4 整体删除，战术规划并入
`application/director/director-service.ts` 的导演编排；剪报通道见
`application/director/actor-briefing.ts`）。
状态：**已落地**。facts/beliefs/lessons/audit 的扩展契约见
`2026-09-06-narrative-memory-audit-design.md`（下称「记忆 spec」，本文不重复）。

## 1. 目标与核心约束

在 Runtime 与 StoryGenerator 之间的长线剧情层：从正式 committed events 形成
叙事记忆，供每回合组装演员剪报时读取一张足够小的记忆投影。

三条不可违反的约束：

1. **只从正式 committed events 形成记忆** —— 候选分支、预览候选永不进入
   NarrativeMemory。
2. **未来计划永不写入事实记忆** —— 记忆子层无任何规划职责（导演的
   SceneDirective 是会话内工作态，不经记忆通道）。
3. **记忆组装必须快** —— `getMemoryProjection` 只读内存缓存，同步返回，
   绝不现场请求 LLM。

## 2. 范围

### 做
- `NarrativeMemoryState + EpisodeMemory + JSON 存储`（narrative-state.json /
  episodes.jsonl / narrative-ops.jsonl；facts/lessons 通道与 ending-report
  见记忆 spec）
- 规则版线程/伏笔维护（classifySetup 最小版；MA-A 的 depth 超期分档见记忆
  spec §8）
- MemoryProjection（记忆投影，M4.4 起取代 NarrativeBrief；由
  `core/narrative/memory-projection.ts` 承载，消费方 = actor-briefing 剪报
  组装与剧本渲染）
- candidate 隔离（只订阅 committed events）
- MemoryConsolidator：LLM 低频异步，episode summary + thread/setup ops
  （MA-B 起搭载 FactOp/BeliefOp/AuditFinding）+ validator

### 不做（预留）
- character belief 之外的 embedding / SQLite 检索（第 4 步位置预留）
- 跨会话记忆规划（跨周目真相由 v2 图架构的 canon 晋升承载）

## 3. 作者静态设定：story-plan.yaml

根目录 `story-plan.yaml`，**顶层键** `threads / setups / anchors`（三段全部
可选，缺省时从空状态开始）：

```yaml
threads:  # PlotThread 种子（source: author）
setups:   # SetupPayoff 种子（source: author，status: planned；MA-A 起
          # runtime 硬拒缺 intendedPayoff 的 seed，author 种子缺省记 warning）
anchors:  # [{id, purpose, prerequisites, required}]（status 恒 pending）
```

- 加载器 `src/adapters/static/story-plan-loader.ts`：纯函数（路径 → StoryPlan）。
  - yaml 语法/结构错误 → 启动时报清晰错误
  - 单个条目校验失败 → 跳过该条目 + warning（走 diagnostic sink），不整体崩溃
  - **种子只负责第一次创建缺失条目**：`initialize()` 合并时持久化状态优先
    （loaded wins），同 id 的运行时生命周期（status / 时间戳 /
    reinforcementCount）重启后不被 plan 覆盖

## 4. Core 类型与 Port

### `src/core/narrative/memory-types.ts`
- `PlotThread`：id / kind（main|character|mystery|relationship|promise）/ summary / status（open|developing|ready_to_resolve|resolved|abandoned）/ importance（major|minor）/ introducedAtCheckpoint / lastTouchedAtCheckpoint / nextPressure? / source（author|runtime）
- `SetupPayoff`：id / kind（foreshadow|mystery_clue|object|character|relationship|world_rule|promise|motif）/ setup / intendedPayoff? / status（planned|seeded|reinforced|ready|paid_off|dropped）/ threadId? / reinforcementCount / seededAtCheckpoint? / lastTouchedAtCheckpoint? / payoffAtCheckpoint? / prerequisites / payoffBeforeAnchor? / source
  - **时间字段全部为 checkpoint 单位**：写入值是应用操作时的
    checkpointCount（叙事节拍），不是 event seq；classifySetup 的 age
    计算（checkpoint − lastTouched ≥ 2）因此单位一致
- `StoryAnchorState`：id / purpose / prerequisites / required / status（pending|reached|passed）
- `EpisodeMemory`：id / fromEventSeq / toEventSeq / summary / characters / locations / threads / setups / importance（major|normal）
- `NarrativeMemoryState`：revision / consolidatedThroughEventSeq / checkpointCount（递增，供 classifySetup 的 age 计算）/ threads / setups / anchors / recentEpisodeIds
- 全部 zod schema；MA-B 增补的 FactRecord/BeliefState/Lesson 亦在此文件
  （形状见记忆 spec §5/§6）

### `src/core/narrative/memory-operation.ts`
- `ThreadOp`：{ type: "touch"|"advance"|"resolve"|"abandon"|"create", id, progress? }
- `SetupOp`：{ type: "seed"|"reinforce"|"payoff"|"hold"|"drop", id, evidenceEventIds? }
- MA-B 增 `FactOp` / `BeliefOp` / `AuditFinding`（见记忆 spec §5）
- 应用结果结构：成功 ops / 被拒 ops（含原因）

### `src/core/narrative/memory-projection.ts`
- `MemoryProjection`：每回合记忆投影（原 NarrativeBrief 的 plan 段已随
  PlotPlanner 删除）——activeThreads（含 nextPressure）/ setupDirectives /
  relevantEpisodes / anchorsStatus + MA-B 的 relatedFacts / characterBeliefs /
  avoidanceLessons 三段
- `MemoryProjectionRequest`：turn / eventSeq / location / characters /
  currentInteraction?

### `src/core/ports/narrative-director-port.ts`
```ts
interface NarrativeDirectorPort {
  getMemoryProjection(request: MemoryProjectionRequest): MemoryProjection; // 同步，零 await
  getMemoryDigest(): MemoryDigest;      // 决策节点快照的记忆真源；纯读取
  restoreFromDigest(digest: MemoryDigest): void; // 恢复路径（替代 store.load）
  observeCommitted(events: readonly StoredEvent[]): void; // 只入队，不阻塞
  checkpoint(reason: NarrativeCheckpointReason): void;    // 调度 consolidation
  flush(): Promise<void>;               // 关停：整理尾批并确保落盘（幂等）
}
```

### `src/core/ports/narrative-memory-store-port.ts`
- load(): 恢复 NarrativeMemoryState + episodes（幂等）
- saveState(state): 原子写 narrative-state.json（tmp + rename）
- appendEpisodes(episodes)
- appendOps(ops)（debug 用 narrative-ops.jsonl）
- MA-B 增 facts.jsonl / lessons.jsonl 通道与 ending-report 原子写（记忆 spec §5.3/§8.4）

## 5. Application 层（src/application/narrative/）

### narrative-director-service.ts（组合根，M4.4 起收窄为记忆子层）
- 持有：memory 状态（内存副本 + 持久化）、consolidation 队列、episode 索引、store port、consolidator、validator
- `observeCommitted(events)`：追加 recent events（内存）+ 排队 consolidation（可合并批次）；检测 EndEvent 触发终局报告（fire-and-forget，记忆 spec §8.4）
- `getMemoryProjection(request)`：episode-retriever + classifySetup 规则 → 组装投影，纯内存
- `checkpoint(reason)`：若队列积压 ≥ batch_min_events 则触发一次 consolidation 批次
- 积压阈值自动触发：`observeCommitted` 后积压 ≥ batch_min_events 且距上次 ≥ min_checkpoint_gap_ms → 调度

### narrative-context-builder.ts
- memory + projection → 提示词文本段（「编剧工作台」格式）：
  - `[DIRECTOR NOTE]`：memory revision 标注（「记忆截至事件 X，最近 Y 条见 RECENT EVENTS」）
  - ACTIVE THREADS（含 nextPressure）
  - SETUP / PAYOFF TASKS（REINFORCE / HOLD / PAYOFF）
  - RELEVANT LONG MEMORY（episode 列表）
  - MA-B 三段：[相关既定事实] / [角色认知] / [规避清单]（渲染函数随
    actor-briefing 复用，见记忆 spec §5.3/§7.3）

### memory-consolidator.ts
- 触发：checkpoint / 积压阈值（单飞：一次只跑一个批次）
- 流程：读 `consolidatedThroughEventSeq+1 .. 当前` 的 committed events → adapter 生成结构化 ops → validator 校验 → 应用（更新 threads/setups/episode 索引 + 新 EpisodeMemory；MA-B 起 facts/beliefs 影子应用保事务性）→ 推进 revision + watermark → 持久化
- **raw events 来源 = director 运行时内存缓存**（`observeCommitted` 传入的正式事件，最近 ≤ max_events_per_call 条）。重启后的 watermark 缺口跳过不补（痕迹仍在 ContextBuilder 的 recent raw events 里，不丢信息，只不进长线记忆）；恢复路径由 digest 全文重建（记忆 spec §9，不依赖重放）
- 失败：ops 记入 narrative-ops.jsonl（rejected 原因）+ 不推进 watermark（下次重试）
- fire-and-forget：异常绝不 reject 到 game 主循环；失败仅记 ops 日志 + 诊断指标

### memory-validator.ts（纯函数）
拒绝规则：
- 未知 thread/setup id
- 非法状态迁移（如 paid_off → seeded、dropped → reinforce）
- 超过 budget（§8 配置：major threads ≤ 2、minor ≤ 3、active setups ≤ 6）
- summary 超长（上限 200 字）
- op 声称的证据 event id 不在已提交范围内（≤ 当前批最后事件 seq）
- **事务式 shadow 校验**：ops 按输出顺序在克隆状态上
  validate → apply → 下一个，同批次内 budget/状态迁移互相可见
  （两个 create、重复 seed、seed 后 reinforce 不再穿透）
- 拒绝 reason 统一带 `[CODE] ` 稳定规则码前缀（MA-A；规则码清单见记忆 spec §7.2）

### episode-retriever.ts
- `(characters∩) 最近 2 + (locations∩) 最近 2 + (threads∩) 最近 2 + 全部 major`，去重、按 seq 倒序、截断 max_relevant_episodes（默认 6）；threads 只传**活跃**线程 id（避免已终结线程钝化检索信号）

### classifySetup（私有于 director-service）
- payoffBeforeAnchor 命中当前 anchor → payoff/now（**仅 seeded|reinforced|ready**
  状态；planned 等状态发 payoff 会被 validator 拒绝）
- seeded 且 age ≥ 2 checkpoint → reinforce/soon
- 其余 → hold/normal
- **anchor 推进不在本层**：`computeCurrentAnchorId` 要求存在已
  reached/passed 的 anchor 才返回后续 pending；无推进机制 → 恒 undefined →
  payoffBeforeAnchor 指令惰性（不承诺无法兑现的期限）
- MA-A 的超期第三档（RESOLVE_OR_DROP）与 heavy 积累门控叠加在上述之上
  （先于前置门），见记忆 spec §8.1/§8.3

## 6. Adapters

### src/adapters/storage/json-narrative-memory-store.ts
- 目录布局：`sessions/<session-id>/` 下 narrative-state.json、episodes.jsonl、
  narrative-ops.jsonl（+ facts/lessons jsonl 与 ending-report，见记忆 spec）；
  **记忆绑定 session，可丢弃**——v2 恢复路径不读会话文件，从图快照 digest 重建
- 原子写：tmp 文件 + rename
- 损坏文件：load 时返回空状态 + warning（不崩溃）；**语法损坏与结构损坏
  都用 zod schema 判定**，episode 按 id 去重（持久化重试幂等）

### src/adapters/llm/narrative-consolidator-adapter.ts
- 独立 OpenAI client（api.model / base_url / api_key_env 同 generator 配置）
- 非流式单轮，`response_format: json_object`
- 输入 = 最近 events 文本 + 当前 threads/setups 摘要（**不含任何未来计划**）
- 输出 = ThreadOp[] + SetupOp[] + EpisodeSummary；MA-B 起同批搭载
  FactOp/BeliefOp/AuditFinding（缺段容错为空数组，契约见记忆 spec §5）
- 解析失败 → 记 ops rejected + 诊断指标

## 7. Runtime 接入（现状）

- `create-runtime-application.ts`：组装 director service + json store +
  consolidator adapter（依赖注入，测试可替换）；图恢复路径经
  `restoreFromDigest` 重建记忆态（v2 决策节点快照为记忆真源）
- 提交挂钩：正式事件落库处同步 `observeCommitted`（prefetch/预览候选
  天然不进记忆）；交互完成后 `checkpoint("interaction_completed")`
- 演员上下文：`Game.makeBriefing` 调 `getMemoryProjection` +
  `buildActorBriefing`（`application/director/actor-briefing.ts`，并入导演
  SceneDirective 段）产 `briefing: string`，随生成请求传递（M4.2 剪报通道；
  防火墙 = 剪报参数形状不含大纲全量/结局候选/他周目数据）

## 8. 配置（config.yaml `narrative:` 段，现状）

```yaml
narrative:
  threads:      # max_major_active: 2 / max_minor_active: 3
  setups:       # max_active: 6 / max_untouched_checkpoints: 6（MA-A）
  lessons:      # auto_from_rejections: 2 / brief_max: 8（MA-A）
  facts:        # brief_max: 8（MA-B）
  beliefs:      # max_active_per_character: 8（MA-B）
  consolidation:
    batch_min_events: 4      # 积压 ≥4 条才值得一次 LLM 调用
    max_events_per_call: 80  # 单次 consolidator 输入上限
    min_checkpoint_gap_ms: 5000
  brief:
    max_relevant_episodes: 6
  confluence:   # enabled: false（图汇流门控，属 v2 图架构）
  story_plan_path: story-plan.yaml
```

## 9. 隔离与错误处理

- candidate 隔离：`observeCommitted` 只在正式落库处触发；prefetch 分支/预览候选天然不进记忆
- 异步不阻塞：consolidation fire-and-forget；`getMemoryProjection` 同步读内存
- 滞后续写：投影同时携带 consolidatedThroughEventSeq 与 currentEventSeq，渲染注明「记忆截至 X，最近事件见 RECENT EVENTS」
- **consolidation 批次为 FIFO**：每次取最老 max_events_per_call 条，较新的 overflow 事件留队；watermark = 本批最后事件 seq（连续前沿，天然单调，无回退）
- 重入安全：consolidator 单飞；完成释放标志后重新检查调度（飞行期间新事件可继续 drain），失败重试受 min_checkpoint_gap_ms 节流
- **持久化失败原子**：copy-on-write——ops 应用到克隆状态，saveState（提交点）→ appendEpisodes 全部成功后替换内存；任一失败内存不动、整批重新入队（重试生成同 id episode，幂等收敛）；appendOps 失败仅记日志
- checkpoint 在交互正式落库（player choice/input 已 record）**之后**触发，保证触发 consolidation 时批次包含该交互事件
