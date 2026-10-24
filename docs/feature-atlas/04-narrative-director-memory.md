# 叙事导演与记忆系统域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：18 文件 / 5376 行（生产代码，不含测试）｜导出符号合计 130

本文所有行号取自只读快照 `D:/coding/lgp-main-atlas` 的实际 Read/Grep 结果；路径均为相对 `src/` 的快照路径。

## 1. 域职责与边界

本域包含**两个同名为「导演」但职责不同的服务**，加上记忆系统与大纲（outline）契约：

- **记忆导演 `NarrativeDirectorService`**（application/narrative/）：叙事记忆层的组合根。持有内存态 `NarrativeMemoryState`（threads/setups/anchors/facts/beliefs/lessons），对每轮交互提供**同步**记忆投影 `MemoryProjection`（活跃剧情线、伏笔指令、相关 episode、规避清单等）；把已提交事件（`StoredEvent`）积攒成批，交给 `MemoryConsolidator` 走「LLM 抽取提案 → 纯函数规则校验 + §6.2 身份/引用校验 → 影子应用 → 持久化 → 交换」的整理（consolidation）管线；被拒提案喂教训库（`LessonService`），EndEvent 触发终局报告。写入路径全部串行在 memory-write 链上（copy-on-write 影子 + saveState 先行）。
- **场景导演 `DirectorService`**（application/director/）：场景边界触发的工具循环服务。用 LLM runner（readSceneHistory / queryCharacterState / narrowFormModes 三个确定性工具）产出 `SceneDirective`（场景目标、防守节拍、收束压力、表单收窄、voice/music 指导），会话内缓存、不入图契约；另评估自由输入产出防守节拍。它是「演出层导演」（每场景一次），与记忆导演（每批次记忆整理）完全独立、互不引用（详见 §7.1）。
- **记忆校验器 `memory-validator.ts`**：全部纯函数。三类职责：规则校验（预算/状态机/形状，`[CODE]` 稳定规则码）、状态应用（`apply*ToState` 原地修改）、§6.2 身份视图（`MemoryIdentityView` 构造 + 角色/证据/引用校验）。
- **大纲 outline**：`core/outline/types.ts` 是幕级大纲图冻结契约（planned→active→realized/pruned）；`application/outline/outline-writer.ts` 定义编剧 LLM 端口（初版世界草稿 + 后台维护），实现在 adapters/llm/outline-writer-adapter。大纲对导演域的作用：`DirectorService.computeOutlineEndingPressure` 读大纲 ending 候选产生确定性收束压力；但大纲全量对演员不可见（防火墙，见 actor-briefing）。

边界：本域不做 IO（存储走 `NarrativeMemoryStorePort` / `GraphStorePort` / `OutlineStorePort` 等 port，实现在 adapters/）；LLM 调用全部经 port（`MemoryConsolidatorPort`、`AgentRunnerPort`、`OutlineWriterPort`）；事件投影复用 story 域的 `projectMemoryEvidence`。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| application/narrative/narrative-director-service.ts | 1019 | 记忆导演组合根：投影/事件积攒/批次整理/降级/终局报告 | 4（1 class + 3 re-export type） | narrative-director-lifecycle.test.ts(323)、narrative-director-brief.test.ts(275)、narrative-director-consolidation.test.ts(1143)、narrative-director-replan.test.ts(373) |
| application/narrative/memory-validator.ts | 1188 | 纯校验规则 + 状态应用 + §6.2 身份视图 | 30 | memory-validator.test.ts(1622) |
| application/narrative/memory-consolidator.ts | 709 | 整理管线编排：截断→port 调用→校验过滤→episode id | 9 | memory-consolidator.test.ts(1681) |
| application/narrative/narrative-director-test-kit.ts | 203 | 记忆导演测试共享 fakes/fixtures（生产目录内） | 9 | 上述 4 个 narrative-director-*.test.ts 共用 |
| application/narrative/lesson-service.ts | 144 | 教训库：拒绝计数晋升/幂等累加/滚动窗口 | 1 | lesson-service.test.ts(140) |
| application/narrative/episode-retriever.ts | 97 | 相关 episode 检索（角色/地点/线程交集 + major 兜底） | 1 | episode-retriever.test.ts(263) |
| application/narrative/fact-retriever.ts | 46 | 相关 fact 检索（在场角色∩scope ∪ 地点 ∪ major） | 2 | fact-retriever.test.ts(55) |
| application/narrative/ending-report.ts | 68 | 终局报告确定性聚合（无 LLM） | 1 | ending-report.test.ts(92) |
| application/narrative/narrative-context-builder.ts | 103 | MemoryProjection → 导演便签纯文本渲染 | 1 | narrative-context-builder.test.ts(229) |
| application/narrative/setup-scheduler.ts | 75 | 锚点计算 + 伏笔指令调度（纯函数） | 2 | setup-scheduler.test.ts(126) |
| application/director/director-service.ts | 703 | 场景导演：工具循环 + SceneDirective 缓存 + 防守评估 | 5 | director-service.test.ts(649) |
| application/director/actor-briefing.ts | 53 | 演员剪报组装（形状即防火墙） | 2 | actor-briefing.test.ts(375) |
| core/narrative/memory-types.ts | 421 | 记忆领域类型 + zod schema + 线程状态转移表 | 28 | memory-types.test.ts(498) |
| core/narrative/memory-operation.ts | 209 | 记忆操作提案类型 + schema + 拒绝/身份问题类型 | 15 | memory-types.test.ts(498，同文件覆盖) |
| core/narrative/memory-projection.ts | 94 | 每回合记忆投影类型 + schema | 3 | memory-types.test.ts(498，L459 起) |
| core/narrative/setup-directive.ts | 29 | 伏笔指令类型 + schema | 2 | 无直接测试（经 MemoryProjectionSchema/setup-scheduler.test 间接） |
| application/outline/outline-writer.ts | 120 | 编剧/大纲维护 port + 角色卡/音频画像类型 | 8 | 无直接单测；消费者测试 world-generator.test、run-graph-coordinator-outline.test、character-contract.test、adapters/llm/outline-writer-adapter.test |
| core/outline/types.ts | 95 | 大纲图冻结契约 + 状态机纯迁移谓词 | 7 | core/outline/types.test.ts(112) |

## 3. 函数级明细

### 3.1 core/narrative/memory-types.ts

纯类型 + zod schema；唯一运行时逻辑是 `VALID_THREAD_TRANSITIONS` 常量。**记忆条目结构关键字段**见下。

#### `PlotThreadKind` / `PlotThreadStatus` / `SetupKind` / `SetupStatus` / `AnchorStatus` / `EpisodeImportance` — `core/narrative/memory-types.ts:15-49`
六个类型别名。线程状态 `open|developing|ready_to_resolve|resolved|abandoned`（后两个终态）；伏笔状态 `planned|seeded|reinforced|ready|paid_off|dropped`；锚点状态 `pending|reached|passed`。

#### `PlotThread` — `core/narrative/memory-types.ts:55-65`
剧情线条目。关键字段：`id`、`kind`、`summary`、`status`、`importance: "major"|"minor"`（预算口径）、`introducedAtCheckpoint`/`lastTouchedAtCheckpoint`（checkpoint 单位）、`nextPressure?`、`source: "author"|"runtime"`。

#### `SetupPayoff` — `core/narrative/memory-types.ts:67-83`
伏笔条目。关键字段：`setup`（前提）、`intendedPayoff?`（未声明则 seed 被硬拒、brief 标 payoffMissing）、`depth?: shallow|mid|heavy`（heavy 需 reinforcementCount≥2 才准回收）、`reinforcementCount`、`prerequisites: string[]`（锚点/线程/伏笔 id）、`payoffBeforeAnchor?`、时间字段均为 checkpoint。

#### `StoryAnchorState` — `core/narrative/memory-types.ts:85-91`
锚点：`purpose`、`prerequisites`、`required`、`status`。

#### `EpisodeMemory` — `core/narrative/memory-types.ts:93-103`
长线记忆条目：`id`（`ep_{revision+1}_{fromSeq}` 确定性派生）、`fromEventSeq/toEventSeq`、`summary`（≤200 字）、标签数组 `characters/locations/threads/setups`（稳定 ID）、`importance: major|normal`。

#### `NarrativeMemoryState` — `core/narrative/memory-types.ts:105-128`
记忆台账真源。关键字段：`revision`（幂等 id 派生源）、`consolidatedThroughEventSeq`（连续成功水位，不越过缺口）、`checkpointCount`、`threads/setups/anchors` 三个 Record、`recentEpisodeIds`（≤20 的 recency 指针，不入 digest）、`beliefs: BeliefState[]`、`facts: FactRecord[]`（含 superseded 历史）、`consolidationFailedIntervals`（§6.2 M2 降级区间，重启不重试）。

#### `ConsolidationFailedInterval` — `core/narrative/memory-types.ts:140-145`
降级区间：`fromSeq/toSeq/attempts/status`，status 区分 `"degraded"`（身份修复后仍非法）与 `"repair_extraction_failed"`（瞬时故障重试耗尽，Ruling 14）。

#### `LessonTag` — `core/narrative/memory-types.ts:151-158`
七值标签：fact-conflict / belief-violation / character-consistency / setup-flow / style / interaction / other。

#### `Lesson` — `core/narrative/memory-types.ts:164-176`
教训条目：`tag+content` 幂等键、`source: audit|rejection|manual`、`sourceRef?`（规则码/finding id）、`occurrences`、`active`（窗口淘汰置 false，不删除）、`createdAtCheckpoint`。

#### `FactRecord` — `core/narrative/memory-types.ts:182-194`
既定事实：`id`（`fact_{revision}_{seq}`）、`content`、`evidenceEventSeqs`（1..3 条批内 seq）、`checkpoint`（检索倒序键）、`superseded`（amend 后置 true 保留历史）、`amends?` 回链、`scope?: {characters?, location?}`、`importance?`。

#### `BeliefState` — `core/narrative/memory-types.ts:197-207`
角色认知：`characterId`、`content`（命题 ≤80 字）、`status: active|resolved`（correct 后 resolved 保留审计）、`origin: learn|believe|correct`。

#### `EndingReport` — `core/narrative/memory-types.ts:210-228`
终局报告：setups{paidOff,dropped,active,payoffRate}、threads{resolved,abandoned,active}、lessons 摘要。

#### `PlotThreadSchema` … `EndingReportSchema`（10 个 schema） — `core/narrative/memory-types.ts:236-401`
逐接口镜像的 zod schema（`z.exactOptional` 对齐 exactOptionalPropertyTypes）：PlotThreadSchema L236、SetupPayoffSchema L254、StoryAnchorStateSchema L287、EpisodeMemorySchema L295、BeliefStateSchema L307、FactRecordSchema L317、ConsolidationFailedIntervalSchema L333、NarrativeMemoryStateSchema L341（beliefs/facts/consolidationFailedIntervals 带 `.default([])` 兼容旧持久化）、LessonSchema L369、EndingReportSchema L380。调用方：JsonNarrativeMemoryStore（adapters/storage）持久化校验。备注：模块内另有私有 `LessonTagSchema`（L359，未导出）。

#### `VALID_THREAD_TRANSITIONS` — `core/narrative/memory-types.ts:411-420`
合法线程状态转移表；resolved/abandoned 映射 `[]`（终态）。消费方：memory-validator 的 validateThreadOp/applyThreadOpToState。

内部辅助：无（纯类型文件）。

### 3.2 core/narrative/memory-operation.ts

LLM 整理提案的操作类型 + schema + 拒绝/身份问题结构。纯类型无逻辑。

#### `ThreadOp` — `core/narrative/memory-operation.ts:10-18`
`type: touch|advance|resolve|abandon|create`；create 须带 `kind`/`importance`（schema superRefine 强制）。

#### `SetupOp` — `core/narrative/memory-operation.ts:20-24`
`type: seed|reinforce|payoff|hold|drop` + `evidenceEventIds?`。

#### `EpisodeSummaryOp` — `core/narrative/memory-operation.ts:26-33`
本批 episode 摘要提案（无 id——id 由 consolidator 派生）。

#### `FactOp` — `core/narrative/memory-operation.ts:40-50`
`type: establish|amend`；amend 必带 `id`（被修订 fact）；`evidenceEventSeqs` 1..3。

#### `BeliefOp` — `core/narrative/memory-operation.ts:53-61`
`type: learn|believe|correct`；correct 必带 `replacesBeliefId`。

#### `AuditFinding` — `core/narrative/memory-operation.ts:64-71`
审计发现：`dimension: belief-violation|fact-conflict|character-consistency`、`severity: critical|major|normal|minor`（critical/major 自动成 lesson）、`evidenceEventSeqs`。

#### `ThreadOpSchema` — `core/narrative/memory-operation.ts:73-100`
superRefine：create 缺 kind/importance 报 issue。

#### `SetupOpSchema` / `EpisodeSummaryOpSchema` — `core/narrative/memory-operation.ts:102-115`
形状校验。

#### `FactOpSchema` / `BeliefOpSchema` / `AuditFindingSchema` — `core/narrative/memory-operation.ts:122-150`
共用私有 `EvidenceSeqsSchema`（L117-120：正整数数组 1..3 条）。

#### `RejectedOp` — `core/narrative/memory-operation.ts:153-170`
被拒操作留痕：`kind: thread|setup|episode|plan|anchor|finding|fact|belief`、`op: unknown`、`reason`（`[CODE]` 前缀）、`rule?`（解析出的稳定规则码）、`issues?`（§6.2 结构化）。

#### `IdentityValidationIssue` — `core/narrative/memory-operation.ts:184-194`
`code: UNKNOWN_CHARACTER_ID|EVIDENCE_OUT_OF_RANGE|KNOWLEDGE_NOT_SUPPORTED|INVALID_REFERENCE` + `path` + `value`。

#### `ValidatedProposal<T>` — `core/narrative/memory-operation.ts:207-209`
`accepted{value, issues:[]}` | `rejected{issues}`；rejected 的 issues 不保证非空（形状拒绝走空 issues，理由在 reason）——消费方须判 status 不得用 issues.length。

内部辅助：`EvidenceSeqsSchema`（L117-120，私有，三 schema 共用证据条数约束）。

### 3.3 core/narrative/memory-projection.ts

#### `MemoryProjectionRequest` — `core/narrative/memory-projection.ts:26-32`
请求：`turn/eventSeq/location/characters/currentInteractionId?`。

#### `MemoryProjection` — `core/narrative/memory-projection.ts:34-62`
每回合投影：水位三字段（revision/consolidatedThroughEventSeq/currentEventSeq）、`activeThreads`（PlotThread 投影列）、`setupDirectives`、`relevantEpisodes`、`anchors`、`avoidanceLessons`、`relatedFacts`、`characterBeliefs`。备注：注释声明这是「导演记忆子层的每回合投影」，字段集**不含** outline 全量/结局候选（形状即防火墙）。

#### `MemoryProjectionSchema` — `core/narrative/memory-projection.ts:80-94`
zod 镜像；私有 `ActiveThreadSchema`（L64-78）。

### 3.4 core/narrative/setup-directive.ts

#### `SetupDirective` — `core/narrative/setup-directive.ts:9-20`
`id`、`action: seed|reinforce|payoff|hold|resolve_or_drop`、`urgency: now|soon|normal|overdue`、`premise?`、`payoff?`（仅 payoff 时携带，防剧透）、`payoffMissing?`。

#### `SetupDirectiveSchema` — `core/narrative/setup-directive.ts:22-29`
zod 镜像。

### 3.5 application/narrative/narrative-director-service.ts

记忆导演组合根，实现 `NarrativeDirectorPort`（core/ports/narrative-director-port.ts）。

#### `NarrativeDirectorService`（class） — `application/narrative/narrative-director-service.ts:149-1019`
**constructor（L198-224）**：normalizeNarrativeConfig、new LessonService、new MemoryConsolidator（包装可选 port——port 缺席产出空 outcome）、记录 seedAnchorOrder（作者声明顺序）。
- **initialize（L237-287）**：store.load → plan 种子与已加载态合并（loaded 同 id 胜出——防回滚运行时生命周期）→ lessonService.load（失败降级空）。
- **getMemoryProjection（L293-389）** 同步投影，步骤：
  1. 过滤 ACTIVE_THREAD_STATUSES 得 activeThreads；
  2. computeCurrentAnchorId + setupPrerequisitesSatisfied 求 satisfiedSetupIds；
  3. scheduleSetups 产伏笔指令；
  4. retrieveEpisodes（活跃线程 + 当前地点）；
  5. anchors 按 pending→reached→passed 排序；
  6. 组装：avoidanceLessons=lessonService.briefLessons()、retrieveFacts、beliefs 在场过滤；记录 lastBriefRequest。
- **getMemoryDigest（L395-397）**：memoryDigestFromState——决策节点快照唯一记忆真源。
- **restoreFromDigest（L399-406）**：memoryStateFromDigest 原样重建；episodes/pendingEvents 清空。
- **observeCommitted（L412-434）**：按 attemptThroughEventSeq 过滤已消耗事件；EndEvent → fire-and-forget writeEndingReport；余量入 pendingEvents；maybeSchedule。
- **checkpoint（L473-476）**：checkpointCount+1 + maybeSchedule。
- **consolidatePending（L482-511）**：单飞守卫——在飞时返回在飞 promise（供 flush 等待）；finally 中补跑 maybeSchedule 排空后续批。
- **runConsolidatePending（L514-728，私有主体）** 步骤：
  1. 原子排空 pendingEvents；
  2. FIFO 截批 max_events_per_call（取最旧 N，溢出延后）；
  3. consolidator.consolidate(batch, memory, location, characters)；
  4. port 失败（result null）→ 全批回队 + 节流；
  5. identityIssues 非空 → 整批不提交：携 priorIssues 定向修复一次；修复提取失败 → handleRepairExtractionFailure（瞬时故障计数，上限 2 后 repair_extraction_failed 降级）；修复成功 → 采纳（首试拒绝留审计）；修复后仍非法 → recordDegradedInterval("identity")；
  6. 成功路径：溢出回队、blockingGap 水位计算（不越过降级缺口）、mutateMemory 内 structuredClone 影子 → applyOutcomeToShadow → saveState → appendEpisodes → appendFacts → 交换（persist 失败全批回队）；
  7. recordRejectedOps / recordFindings / 清瞬时失败计数。
- **applyOutcomeToShadow（L780-829，私有）**：episode 入 recentEpisodeIds（截 20）→ thread/setup ops（checkpoint 单位）→ fact ops（factId(revision, seq) 确定性 id）→ belief ops（beliefId）。
- **flush（L839-850）**：排空 pending + 等待在飞 consolidation + 等 memoryWriteChain。
- **mutateMemory（L858-867，私有）**：promise 链串行化全部「读→影子→saveState→交换」写；链本身永不 reject。
- **recordDegradedInterval（L881-920，私有）**：失败区间入 state 并持久化（持久化失败仅告警），Ruling 14 两类降级分开诊断。
- **recordRejectedOps（L928-951，私有）**：appendOps 留痕 + lessonService.observeRejections → appendLessons。
- **recordFindings（L962-1000，私有）**：findings 全量 appendOps；critical/major 蒸馏成 lesson。
- **maybeSchedule（L1002-1017，私有）**：batch_min_events + min_checkpoint_gap_ms 双门槛。

调用方（Grep 核实）：bootstrap/create-runtime-application.ts:599（buildGameFor 内实例化，注入 game）；game.ts 经 NarrativeDirectorPort 调 observeCommitted（L1724、L575）、getMemoryDigest（L1744）、getMemoryProjection（L1872）、restoreFromDigest（L574）、flush（L1962）；runtime/interaction-choice.ts:82、interaction-input.ts:308/323、interaction-driver.ts:326 调 checkpoint。
依赖：NarrativeMemoryStorePort、MemoryConsolidator（域内）、LessonService、setup-scheduler、episode/fact-retriever、ending-report、core/graph/memory-digest、StoryPlan、config。
备注：consolidator port 缺席时（hasConsolidator=false）整个整理为 no-op（测试/CI 零网络路径）。

#### re-export `MemoryConsolidatorPort` / `ConsolidationRequest` / `ConsolidationResult` — `application/narrative/narrative-director-service.ts:81-85`
从 memory-consolidator.ts 透传（注释：保持 Task 6 旧 import 不破）。

内部辅助：`formatIdentityIssuesBrief`（L102-108，issues→诊断字符串）、`intervalKeyOf`（L111-113，批区间键）、`REPAIR_EXTRACTION_MAX_TRANSIENT_ATTEMPTS=2`（L116）、`normalizeNarrativeConfig`（L130-143，深合并缺省——防 caller 浅合并整段 narrative）、`MAX_RECENT_EPISODE_IDS=20`（L92）、`ANCHOR_STATUS_ORDER`（L95-99）。

### 3.6 application/narrative/memory-validator.ts

纯函数集（无 IO 无类）。拒绝 reason 以 `[CODE]` 前缀编码规则身份。

#### `rejectionRule(reason)` — `application/narrative/memory-validator.ts:61-64`
解析 `[A-Z_]+` 前缀；无码返回 "unknown"。调用方：LessonService.observeRejections、MemoryConsolidator。

#### `validateThreadOp(op, memory, config)` — `application/narrative/memory-validator.ts:83-155`
规则码：THREAD_ALREADY_EXISTS / THREAD_CREATE_MISSING_FIELDS / THREAD_BUDGET_EXCEEDED（按自身 importance 口径，audit P1-8）/ THREAD_MISSING / THREAD_TERMINAL。

#### `validateSetupOp(op, memory, config, maxEvidenceSeq?)` — `application/narrative/memory-validator.ts:161-241`
seed 仅 planned、须声明 intendedPayoff（SETUP_SEED_WITHOUT_INTENDED_PAYOFF）、SETUP_BUDGET_EXCEEDED；reinforce/payoff/drop 状态机校验；evidenceEventIds 范围（SETUP_EVIDENCE_OUT_OF_RANGE）。

#### `applyThreadOpToState(state, op, checkpoint)` — `application/narrative/memory-validator.ts:254-312`
原地应用：touch 更新 lastTouched/summary、advance 取转移表第一项、create 建runtime 线程。双用途：consolidator 影子校验（checkpoint 传 0）+ 导演真实应用。

#### `applySetupOpToState(state, op, checkpoint)` — `application/narrative/memory-validator.ts:318-354`
seed/reinforce（计数+1）/payoff/hold/drop 原地应用。

#### `MAX_ESTABLISH_PER_BATCH` / `MAX_BELIEF_OPS_PER_CHARACTER_PER_BATCH` / `MAX_FINDINGS_PER_BATCH` — `application/narrative/memory-validator.ts:369-373`
常量 3 / 2 / 5（§5.2/§6.1/§9.2 预算）。

#### `validateFactOp(op, facts, maxEvidenceSeq?)` — `application/narrative/memory-validator.ts:395-425`
证据 1..3 条 + 范围；amend 必带 id、目标存在且未 superseded（FACT_AMEND_*）。

#### `validateBeliefOp(op, beliefs, knownCharacters, maxEvidenceSeq?)` — `application/narrative/memory-validator.ts:428-474`
BELIEF_UNKNOWN_CHARACTER；correct 必带目标、目标 active、**同角色**（BELIEF_CORRECT_FOREIGN_TARGET，R16）。

#### `validateFinding(finding, maxEvidenceSeq?)` — `application/narrative/memory-validator.ts:477-487`
仅证据范围校验。

#### `applyFactOpToState(state, op, id, checkpoint)` — `application/narrative/memory-validator.ts:498-521`
establish/amend 追加 FactRecord（amends 回链 + 旧记录 superseded）。

#### `applyBeliefOpToState(state, op, id, checkpoint)` — `application/narrative/memory-validator.ts:527-548`
learn/believe/correct 追加 active belief；correct 将目标置 resolved。

#### `validateEpisodeOp(op)` — `application/narrative/memory-validator.ts:555-572`
summary 非空 ≤200；四数组字段无空串、去重 ≤20。

#### `setupPrerequisitesSatisfied(prerequisites, memory)` — `application/narrative/memory-validator.ts:578-597`
确定性判定：锚点 reached/passed、线程非终态、伏笔非 planned/dropped；未知 id → false。

#### `classifySetup(item, checkpoint, currentAnchorId, prerequisitesSatisfied, maxUntouchedCheckpoints=6)` — `application/narrative/memory-validator.ts:617-713`
单伏笔指令决策（优先级）：终态→undefined；超期→resolve_or_drop/overdue（先于前置门）；前置未满足→hold；payoffBeforeAnchor 命中且状态可回收→payoff/now（heavy 且 reinforcementCount<2 改发 reinforce，ready 无法 reinforce 则 hold）；seeded 且 age≥2→reinforce/soon；否则 hold/normal。payoffMissing 贯穿标注。

#### `MemoryIdentityView`（interface） — `application/narrative/memory-validator.ts:732-777`
§6.2 身份权威视图：knownCharacterIds、charactersByDisplayName（仅诊断，绝不反向解析）、allowedCharacterIds（严格空）、evidenceCharacterIds、evidenceSeqRange、canonicalLocations、citableFactIds/citableBeliefIds（M2 引用权威）、evidenceBatchSeqRange（批内区间）。

#### `acceptedProposal<T>(value)` / `rejectedProposal<T>(issues)` — `application/narrative/memory-validator.ts:780-789`
ValidatedProposal 构造子。

#### `validateCharacterTags(tags, view, basePath)` — `application/narrative/memory-validator.ts:800-827`
逐标签：非稳定 ID→UNKNOWN_CHARACTER_ID；已注册但无知情→KNOWLEDGE_NOT_SUPPORTED；每违规独立成条。

#### `validateEvidenceRefs(refs, view, basePath)` — `application/narrative/memory-validator.ts:834-855`
setup 证据引用须落 [min,max]；legacy（无区间）不校验。

#### `validateReferenceTags(tags, knownIds, basePath)` — `application/narrative/memory-validator.ts:862-881`
引用标签须在权威集合；undefined=legacy；空集合严格为空。

#### `describeCharacterTag(tag, view)` — `application/narrative/memory-validator.ts:887-899`
显示名误填的人类可读诊断（同名候选全列，绝不合并）。

#### `formatIdentityIssues(issues, view?)` — `application/narrative/memory-validator.ts:905-917`
issues → 单条 reason 字符串。

#### `buildMemoryIdentityView(input)` — `application/narrative/memory-validator.ts:936-1005`
main 请求侧构造：允许集合 = 证据登场 ∪（场景名单∩注册表）；显示名表；证据区间 [1,maxSeq]；批内区间；M2 引用权威由 citableFactIds/citableBeliefIds 注入。依赖 story/event-projection 的 projectMemoryEvidence。

#### `MAX_CITABLE_BELIEFS_PER_REQUEST` — `application/narrative/memory-validator.ts:1022`
=12；注释声明须与 config beliefs.request_max 缺省保持一致。

#### `CitableReferences`（interface） — `application/narrative/memory-validator.ts:1026-1031`
relevantFacts/relevantBeliefs（渲染进请求）+ citable*Ids（校验权威）——一次选择两处消费。

#### `selectCitableReferences(input)` — `application/narrative/memory-validator.ts:1044-1087`
facts 走 retrieveFacts 同政策；beliefs 按 ownerScope（identity 模式=证据∪场景，legacy=场景名单）过滤 active、createdAtCheckpoint 倒序、截 beliefMax。

#### `validateFactIdentity(op, view, basePath)` — `application/narrative/memory-validator.ts:1097-1128`
amend.id 须在 citableFactIds（INVALID_REFERENCE）；证据须在批内区间。

#### `validateBeliefIdentity(op, view, basePath)` — `application/narrative/memory-validator.ts:1141-1188`
知情链（证据参与 ∪ 场景在场，roster 存在不算，R27）；correct 引用权威；批内证据区间。

内部辅助：`fail(rule, reason)`（L56-58，`[CODE]` 前缀）、`ACTIVE_THREAD_STATUSES`（L45-49，私有）、`ACTIVE_SETUP_STATUSES`（L67-71）、`TERMINAL_THREAD_STATUSES`（L74-77）、`EPISODE_ARRAY_FIELDS`（L357-362）、`checkEvidenceRange`（L375-388）。

### 3.7 application/narrative/memory-consolidator.ts

#### `ConsolidationRequest`（interface） — `application/narrative/memory-consolidator.ts:71-111`
port 入参：events/threads/setups/stateLocation/stateCharacters + identity?/evidenceEvents?/relevantFacts?/relevantBeliefs?/priorIssues?。

#### `ConsolidationResult`（interface） — `application/narrative/memory-consolidator.ts:113-121`
port 出参：episode + threadOps/setupOps/factOps/beliefOps/findings。

#### `MemoryConsolidatorPort`（interface） — `application/narrative/memory-consolidator.ts:123-125`
生产实现：adapters/llm/narrative-consolidator-adapter.ts 的 NarrativeConsolidatorAdapter（L97 implements）。

#### `ConsolidationOutcome`（interface） — `application/narrative/memory-consolidator.ts:128-161`
一次整理的结果：result（null=port 失败）、episode/episodeProposal（ValidatedProposal）、各类 ops、rejected、identityIssues、validationMode: "identity"|"legacy"（legacy 仅指无身份权威，与 dsl 协议版本无关——L154-159 命名澄清）。

#### `ACTIVE_THREAD_STATUSES` — `application/narrative/memory-consolidator.ts:168-172`
open/developing/ready_to_resolve。消费方：narrative-director-service（getMemoryProjection）、memory-consolidator 内部。

#### `NON_TERMINAL_SETUP_STATUSES` — `application/narrative/memory-consolidator.ts:175-180`
planned/seeded/reinforced/ready。消费方：setup-scheduler.ts:14、consolidator 内部。

#### `MemoryConsolidator`（class） — `application/narrative/memory-consolidator.ts:186-680`
**constructor（L196-207）**：port 可选、registry 可选（在场=identity 模式）、diagnostics。
- **consolidate(events, memory, stateLocation, stateCharacters, opts?)（L219-522）**，步骤：
  1. port 缺席/空事件 → emptyOutcome；
  2. 截批 max_events_per_call（保最旧 N——与导演截批双保险）；
  3. 求活跃线程/非终态伏笔；registry 在场时 projectMemoryEvidence + 两次 buildMemoryIdentityView（先无引用权威的 provisionalView 供 belief 归属，再带 selectCitableReferences 的 citable 权威）；
  4. port.consolidate（失败→null result，不抛）；
  5. **事务性影子校验**（structuredClone(memory)，audit finding 4）：threadOps（规则+同批 create 入 knownThreadIds）→ setupOps（规则+证据引用）→ episode 提案（形状 + validateCharacterTags/validateReferenceTags，全部 issue 聚合不截断）→ filterFactOps → filterBeliefOps → collectFindings；拒绝记录顺序 episode→thread→setup→fact→belief→finding；
  6. 返回 ConsolidationOutcome（identityIssues 聚合四处）。
- **filterFactOps（L528-579，私有）**：validateFactIdentity + validateFactOp 双层；establish 预算 ≤3；amend 影子应用供后续 op 看到。
- **filterBeliefOps（L581-653，私有）**：validateBeliefIdentity + validateBeliefOp；每角色每批 ≤2；非 correct 每角色 active ≤ config.beliefs.max_active_per_character。
- **collectFindings（L656-679，私有）**：批量上限 5 + 逐条 validateFinding。

#### `factId(revision, seq)` / `beliefId(revision, seq)` — `application/narrative/memory-consolidator.ts:684-691`
确定性 id（`fact_{rev}_{seq}` / `belief_{rev}_{seq}`）——重放幂等；导演应用时同公式重生成。

内部辅助：`emptyOutcome()`（L693-709，null result 空结果，validationMode "legacy"）。

### 3.8 application/narrative/setup-scheduler.ts

#### `computeCurrentAnchorId(anchors, orderById?)` — `application/narrative/setup-scheduler.ts:24-47`
当前路标 = 前置全满足的最先 pending 锚点（作者声明顺序优先，audit P1-5；无序退字典序）。

#### `scheduleSetups(setups, checkpoint, currentAnchorId, satisfied, maxUntouchedCheckpoints=6)` — `application/narrative/setup-scheduler.ts:56-75`
非终态伏笔逐个 classifySetup，过滤 undefined，保序。调用方：narrative-director-service.getMemoryProjection。

### 3.9 application/narrative/episode-retriever.ts

#### `retrieveEpisodes(episodes, opts)` — `application/narrative/episode-retriever.ts:34-97`
四步选取：角色交集最近 2 → 地点交集最近 2 → 线程交集最近 2（均去重不回填）→ major 全收；合并按 toEventSeq 倒序截 max。纯 ID 精确匹配（显示名不参与）。

内部辅助：`byToEventSeqDesc`（L22-24）、`RECENT_PER_FILTER=2`（L27）。

### 3.10 application/narrative/fact-retriever.ts

#### `FactQuery`（interface） — `application/narrative/fact-retriever.ts:11-18`
characters/location/max。

#### `retrieveFacts(facts, query)` — `application/narrative/fact-retriever.ts:20-46`
未 superseded 且（major ∨ scope.characters∩在场 ∨ location 匹配），checkpoint 倒序截 max。调用方：narrative-director-service.getMemoryProjection（relatedFacts）、memory-validator.selectCitableReferences。

### 3.11 application/narrative/lesson-service.ts

#### `LessonService`（class） — `application/narrative/lesson-service.ts:23-144`
- **load(existing)（L32-40）**：注入启动载入的 lessons，续 id 序号。
- **all()（L42-44）**。
- **briefLessons()（L50-58）**：active 按 occurrences 降序 + recency，截 brief_max；纯内存供 getBrief 同步取。
- **observeRejections(ops, checkpoint)（L65-91）**：按稳定规则码计数，达 auto_from_rejections 晋升/累加；unknown 码跳过（跨规则合并会误晋升）。
- **promote(tag, content, source, sourceRef, checkpoint)（L97-125）**：tag+content 幂等累加；新条目 id=`lesson_{seq}`。
- **applyWindow()（L128-143，私有）**：active 超 brief_max*3 时最旧置 inactive。

调用方：仅 narrative-director-service（constructor/initialize/recordRejectedOps/recordFindings/writeEndingReport）。依赖：memory-validator.rejectionRule。

内部辅助：`tagForKind`（L19-21，setup→setup-flow 其余 other）。

### 3.12 application/narrative/ending-report.ts

#### `buildEndingReport(memory, lessons, generatedAt)` — `application/narrative/ending-report.ts:21-68`
确定性聚合：伏笔回收率 paid_off/(paid_off+dropped+active)；线程终态分布；active lessons 摘要。调用方：narrative-director-service.writeEndingReport；产物经 store.writeEndingReport 落 ending-report.json（跨域消费方 application/graph/graph-view.ts:359 结算视图）。

### 3.13 application/narrative/narrative-context-builder.ts

#### `renderMemoryProjection(projection, maxRecentRawEvents)` — `application/narrative/narrative-context-builder.ts:22-103`
投影 → 「导演便签」纯文本：revision 注释行 + [活跃剧情线]/[伏笔任务]/[相关长线记忆]/[锚点进度]/[相关既定事实]/[角色认知]/[规避清单] 各段按需渲染。调用方：actor-briefing.buildActorBriefing（application/director/actor-briefing.ts:34）。

### 3.14 application/narrative/narrative-director-test-kit.ts

生产目录下的共享测试基建（MA-A hygiene prerequisite，被 4 个 narrative-director-*.test.ts 消费）。

#### `makeEvent(seq, turn?)` — L24-34；`makeConfig(overrides?)` — L36-40（浅合并 DEFAULT_NARRATIVE_CONFIG）
#### `FakeStore`（class，L43-126）：记录型 NarrativeMemoryStorePort；失败注入（failNextSaveState/failNextAppendEpisodes）与 saveStateGate（并发写重叠测试）。
#### `emptyState()` — L129-142；`RecordingDiagnostics`（class，L145-155）。
#### `makeThread` / `makeSetup` / `makeAnchor` / `makePlan` — L161-203：条目/计划工厂。

### 3.15 application/director/director-service.ts

场景导演（执行清单 M4.1）：工具循环骨架 + 确定性工具，产出会话内 SceneDirective（不入图契约）。

#### `FormMode`（type） — `application/director/director-service.ts:48`
`"choice" | "input" | "hybrid"`（与 InteractionPolicy 同口径）。

#### `SpeakerVoicePalette`（interface） — L51-54
allowedDelivery/forbiddenDelivery。

#### `SceneDirective`（interface） — L57-78
sceneGoal?/defenseBeats/endingPressure/formModes?/voice?/music?（SceneMusicDirection）。

#### `SceneDirectorPort`（type） — L120-123
`Pick<DirectorService, "getDirective"|"evaluateFreeInput"|"narrowFormModes"|"triggerDirective">`——Game 依赖的最小面。

#### `DirectorService`（class） — `application/director/director-service.ts:125-636`
- **constructor（L148-160）**：runner/store/judge?/outline?/canon?/speakerPalette?/diagnostics；canon 后台预热 fire-and-forget。
- **exposeConfluenceJudge()（L163-165）**：交出持有的判定员（bootstrap 传给 coordinator options.judge）。
- **getDirective(sceneId)（L167-169）**：读缓存。
- **refreshDirective(input)（L175-255）**，步骤：1) 构建工具 + narrowFormModes 闭包绑定 sceneId；2) 拼 user（场景/摘要/在场角色段/音频调色板段/canon 段）；3) runner.runLoop；4) parseDirective（voice 键按场景名单严格校验，R18）；5) endingPressure = 模型判定 ∨ computeOutlineEndingPressure；6) 保留旧 formModes 与已累积 defenseBeats；7) 落缓存 + directiveListener。
- **setDirectiveListener(listener)（L258-260）**：音乐服务接线（bootstrap L547-549）。
- **triggerDirective(input)（L263-287）**：异步入口；单飞时**记住最新补跑**（不丢弃）。
- **narrowFormModes(sceneId, modes)（L395-404）**：相位门收窄 allowed_modes。
- **evaluateFreeInput(input)（L411-455）**：free_input 后异步评估，产防守节拍追加进 directive.defenseBeats（截最近 3，滞后一拍有意）。
- **readSceneHistory(modelSceneId)（L523-549）**：图存储回放投影（含已弃周目，D7）；决策 id 匹配边（历史 bug 修复注释 L529-531）。
- **queryCharacterState(characterId)（L552-561）**：最近决策入口快照查角色状态。
- 私有：executeNarrowFormModes（L290-303）、renderCastSection（L309-315）、renderVoicePaletteSection（L321-338）、renderCanonSection（L344-367，上限 20 条）、computeOutlineEndingPressure（L375-392：ending 候选 activate/realize 或前沿 act 全 realized）、buildTools（L461-494，三工具定义）、executeTool（L496-520）、parseDirective（L563-605）、parseMusicDirection（L612-635，词表外 mood 整段丢弃）。

调用方（Grep 核实）：bootstrap/create-runtime-application.ts L523（buildDirectorService L294-330 装配，进程级单实例）+ L547 setDirectiveListener + L553 exposeConfluenceJudge + L624-626 voiceDirectionHub.setSource 读 getDirective；game.ts 经 SceneDirectorPort 调 getDirective（L767/1890）、evaluateFreeInput（L1712）、triggerDirective（L1824，场景边界）。
依赖：AgentRunnerPort、GraphStorePort、ConfluenceJudgePort?、OutlineStorePort?、CanonStorePort?、application/audio/performance-compiler（词表）、shared/music/score、story/context-builder.serializeStoryContextLegacy、core/narrative/memory-operation（IdentityValidationIssue 类型）。

内部辅助（模块级私有）：`DIRECTIVE_SYSTEM_PROMPT`（L81-100）、`DirectorServiceOptions`（L102-117）、`ParsedDirective`（L639-645）、`pickEnum`（L648-652）、`parseVoiceDirections`（L662-703，voice 键词表+名单校验）。

### 3.16 application/director/actor-briefing.ts

#### `ActorBriefingInput`（interface） — `application/director/actor-briefing.ts:18-27`
仅 memoryBrief?/rawEventCount?/directive?——**输入形状即防火墙**（无 outline 全量/结局候选/他周目字段）。

#### `buildActorBriefing(input)` — `application/director/actor-briefing.ts:30-53`
renderMemoryProjection + [场景指令] 段（目标/防守/收束/表单收窄）；无内容返回空串。调用方：game.ts:1892（makeBriefing）。

### 3.17 application/outline/outline-writer.ts

编剧 port 与产物类型（非冻结契约；大纲节点复用 core/outline/types 冻结契约）。

#### `CharacterVoiceDesign`（interface） — L30-39；`CharacterVoiceDesignSchema` — L46-61
角色音频画像：timbre（≤120 字）/delivery（DELIVERY_TAGS 1..8）/avoid?/baseline?。schema 为唯一 zod 真源（编剧输出校验 + voice-design.json 落盘校验共用）。跨域消费：application/audio/*、adapters/storage/voice-design-store.ts。

#### `DraftCharacter`（interface） — L64-82
角色卡：control（须恰好一名 player，M1）、initialLabel?、spriteBinding?、voice?。消费方：application/characters/world-roster.ts、application/world/world-generator.ts。

#### `WorldDraft`（interface） — L85-89
worldSetting + characters + outline（全 planned 的 act 链 + 1–2 ending）。

#### `OutlineWriterRequest` — L91-96；`OutlineMaintenanceRequest` — L99-107（outline 现状 + recentSummary + memoryDigest + canon? + reviews?）。
#### `OutlineWriterPort` — L109-111：`writeOutline(request): Promise<WorldDraft>`。实现：adapters/llm/outline-writer-adapter.ts:120。
#### `OutlineMaintainerPort` — L118-120：`maintainOutline(request): Promise<OutlineOp[]>`（只允许 add(planned)/prune）。消费方：application/graph/run-graph-coordinator.ts:781（后台维护）；bootstrap L501-503 装配 OutlineWriterAdapter 双角色。

### 3.18 core/outline/types.ts

#### `OutlineNodeStatus`（type） — L15；`OutlineNode`（interface） — L17-31（purpose ≤200 字禁台词、kind act|ending、instantiatedBy?、location?）。
#### `OUTLINE_PURPOSE_MAX_LENGTH` — L33（=200）；`OutlineNodeSchema` — L35-42。
#### `OUTLINE_TERMINAL_STATUSES` — L44-47（realized/pruned）。
#### `canTransitionOutlineStatus(from, to)` — L55-68：planned→active|pruned；active→realized|pruned；终态 false。
#### `transitionOutlineNode(node, to, instantiatedBy?)` — L74-85：不可变迁移；realized 必须提供 instantiatedBy；非法返回 undefined。

内部辅助：`canTransitionOutlineNode`（L87-95，私有谓词组合）。

## 4. 域内数据流（一次交互后的完整链路）

以下调用点均已 Grep 核实：

1. **交互完成**：runtime/interaction-choice.ts:82（或 interaction-input.ts:308/323、interaction-driver.ts:326）→ `narrativeDirector.checkpoint("interaction_completed")` → checkpointCount+1 → `maybeSchedule()`。
2. **事件提交**：game.ts:1724 `narrativeDirector?.observeCommitted([event])` → attemptThroughEventSeq 过滤已消耗事件（恢复重放安全）→ pendingEvents 入队 → `maybeSchedule()`（batch_min_events + min_checkpoint_gap_ms 双门槛）→ `consolidatePending()`。
3. **批次整理启动**：`runConsolidatePending` 原子排空 pendingEvents → FIFO 截 max_events_per_call → `MemoryConsolidator.consolidate(batch, memory, lastBriefRequest 位置/角色)`。
4. **抽取请求构造**：`projectMemoryEvidence(batch, registry)`（story 域）→ `buildMemoryIdentityView`（两次：provisional + 带 `selectCitableReferences` 的 citableFactIds/citableBeliefIds）→ `port.consolidate`（NarrativeConsolidatorAdapter → LLM）→ ConsolidationResult（episode + 五类 ops）。
5. **校验**（影子事务，`structuredClone(memory)`）：`validateThreadOp`/`applyThreadOpToState` → `validateSetupOp`+`validateEvidenceRefs` → `validateEpisodeOp`+`validateCharacterTags`+`validateReferenceTags` → `filterFactOps`（`validateFactIdentity`+`validateFactOp`，establish ≤3）→ `filterBeliefOps`（`validateBeliefIdentity`+`validateBeliefOp`，每角色 ≤2/批）→ `collectFindings`（≤5）。
6. **身份失败分支**：identityIssues 非空 → 整批不提交 → 携 priorIssues 定向修复一次 → 修复成功采纳 / `recordDegradedInterval("identity")` / `handleRepairExtractionFailure`（瞬时计数，耗尽 → `recordDegradedInterval("repair_extraction")`）。成功水位停在缺口前（blockingGap）。
7. **成功应用**：`mutateMemory`（写链串行）→ 影子克隆 → `applyOutcomeToShadow`（episode id=`ep_{revision+1}_{fromSeq}`、`applyThreadOpToState`/`applySetupOpToState`/`applyFactOpToState`+`factId`/`applyBeliefOpToState`+`beliefId`）→ `store.saveState`（提交点先行）→ `appendEpisodes` → `appendFacts`（facts.jsonl 留痕）→ 交换 this.memory → `recordRejectedOps`（appendOps + `LessonService.observeRejections` → appendLessons）→ `recordFindings`（appendOps + critical/major `promote` → appendLessons）。
8. **下轮上下文回注**：game.ts:1872 `getMemoryProjection`（同步，零 await 红线）→ activeThreads / `computeCurrentAnchorId` / `setupPrerequisitesSatisfied` / `scheduleSetups`(`classifySetup`) / `retrieveEpisodes` / `briefLessons` / `retrieveFacts` / beliefs 过滤 → MemoryProjection → game.ts:1892 `buildActorBriefing`（+ `DirectorService.getDirective` 的 SceneDirective）→ `renderMemoryProjection` 渲染进 writer prompt。
9. **场景边界（并行链）**：game.ts:1824 `director.triggerDirective` → `refreshDirective`（LLM 工具循环）→ SceneDirective 缓存 → setDirectiveListener → SceneMusicService（音乐链）；player_input → game.ts:1712 `evaluateFreeInput` → defenseBeats 追加。
10. **快照与恢复**：game.ts:1744 `getMemoryDigest`（`memoryDigestFromState`）入决策节点；恢复 game.ts:574-575 `restoreFromDigest` + `observeCommitted(全路径重放)`。**终局**：EndEvent → `writeEndingReport` → `buildEndingReport` → ending-report.json（graph-view.ts:359 消费）。

## 5. 跨域接口

**本域依赖（出向）**：
- `config.ts`：NarrativeConfig / DEFAULT_NARRATIVE_CONFIG（两个服务 + validator/consolidator/lesson）。
- core/ports：diagnostic-sink、narrative-memory-store-port、narrative-director-port、agent-runner-port、graph-store-port、outline-store-port、canon-store-port、confluence-judge-port、review-store-port（outline-writer）。
- story 域：`schema.ts`（StoredEvent）、`story/event-projection.ts`（projectMemoryEvidence/ProjectedEvent）、`story/context-builder.ts`（serializeStoryContextLegacy——director-service C5 冻结渲染）。
- core/characters/types.ts（CharacterRegistry/CharacterId）；core/graph/types.ts + core/graph/memory-digest.ts（MemoryDigest 双向映射）。
- application/audio/performance-compiler（DELIVERY_TAGS 等词表 + VoiceDirectionTarget）；shared/music/score（MUSIC_MOODS/SceneMusicDirection）——仅 director-service 与 outline-writer。
- adapters/static/story-plan-loader.ts（StoryPlan 类型——narrative-director-service 直接 import adapter 类型）。

**本域被依赖（入向）**：
- bootstrap/create-runtime-application.ts：装配双导演（DirectorService L523、NarrativeDirectorService L599）、OutlineWriterAdapter（L503）、setDirectiveListener（L547）、voiceDirectionHub 绑定（L624-626）。
- game.ts：NarrativeDirectorPort + SceneDirectorPort + buildActorBriefing（见 §4）。
- runtime/interaction-{choice,input,driver}.ts：checkpoint()。
- adapters/storage/json-narrative-memory-store.ts：实现 NarrativeMemoryStorePort（消费 memory-types/memory-operation）。
- adapters/llm/narrative-consolidator-adapter.ts：实现 MemoryConsolidatorPort。
- application/canon/canon-promoter.ts:19：消费 FactRecord（读 facts 提升世界 canon）。
- application/graph/run-graph-coordinator.ts：OutlineMaintainerPort 消费 + decision.entryState.memoryDigest；graph-view.ts:359 读 ending-report.json。
- application/world/world-generator.ts、application/characters/world-roster.ts：OutlineWriterPort/WorldDraft/DraftCharacter。
- application/audio/*、adapters/storage/voice-design-store.ts：CharacterVoiceDesign(Schema)。
- adapters/llm/outline-writer-adapter.ts：实现 OutlineWriterPort/OutlineMaintainerPort，OUTLINE_PURPOSE_MAX_LENGTH。

## 6. 测试覆盖

| 测试文件（行数/it 数） | 覆盖的符号/行为 |
|---|---|
| narrative/memory-consolidator.test.ts（1681/41） | MemoryConsolidator.consolidate 全路径：成功路径（port 入参、episode id 生成）；§6.2 身份（显示名/未知 ID/KNOWLEDGE_NOT_SUPPORTED/空集合严格空/同名双胞胎不合并/issue 聚合/证据越界/同批 create 线程标签）；拒绝路径（影子事务性 audit finding 4、同批预算、拒绝记录顺序）；port 失败 null；截批 FIFO；MA-B facts/beliefs/findings 预算与 amend 链；M2 引用权威/知情链（画外角色凭证据、空证据严格空、超预算同步收缩、beliefs.request_max、priorIssues 透传、legacy 无身份） |
| narrative/memory-validator.test.ts（1622/98） | validateThreadOp（含 create 预算口径）、validateSetupOp、validateEpisodeOp、classifySetup（超期第三档/depth 门控/前置门）、setupPrerequisitesSatisfied、MA-A 规则（intendedPayoff 必填）、§6.2 validateCharacterTags/validateEvidenceRefs/validateReferenceTags/accepted-rejectedProposal/describeCharacterTag、M2（BELIEF_CORRECT_FOREIGN_TARGET 同角色、selectCitableReferences、buildMemoryIdentityView M2 字段、validateFactIdentity、validateBeliefIdentity 知情链） |
| narrative/narrative-director-consolidation.test.ts（1143/24） | consolidatePending/runConsolidatePending：brief 位置透传、五类 op 应用、水位推进、原子性（saveState/appendEpisodes 失败回队 audit finding 6）、§6.2 M2 身份拒批（整批不提交/恰好 2 次/降级区间）、Ruling 14（瞬时修复失败回队与耗尽降级）、定向修复成功、缺口水位阻塞、重放过滤、重启恢复降级区间、合法空提案、flush（排空/在飞等待 C6/no-op） |
| director/director-service.test.ts（649/19） | refreshDirective 工具循环与缓存/无 JSON 回退、exposeConfluenceJudge、canon 段（M3.6）、outline 收束压力（M3.5 四情形）、voice 键严格化（R18 显示名拒绝/严格空/词表校验/调色板渲染）、music 解析（词表外丢弃/强度缺省/词表插值单一真源） |
| core/narrative/memory-types.test.ts（498/31） | 六 schema 合法/非法解析、NarrativeMemoryStateSchema 旧档缺段降级、VALID_THREAD_TRANSITIONS 全量性、ThreadOpSchema create 必填、MemoryProjectionSchema round-trip（同文件覆盖 memory-operation.ts 与 memory-projection.ts） |
| narrative/narrative-director-lifecycle.test.ts（323/12） | initialize 种子合并（loaded 胜出/引用安全）、observeCommitted（水位过滤/无 consolidator）、checkpoint、终局报告触发、getMemoryProjection 零 await 红线 |
| narrative/narrative-director-brief.test.ts（275/8） | getMemoryProjection（retriever/classify/锚点排序）、normalizeNarrativeConfig 部分配置/部分子对象合并/传给 consolidator 的是规范化配置 |
| narrative/narrative-director-replan.test.ts（373/5） | maybeSchedule 调度阈值（scheduling thresholds） |
| narrative/lesson-service.test.ts（140/7） | observeRejections 稳定码计数/unknown 跳过/晋升阈值、promote 幂等与 id 续号、briefLessons 排序截断、滚动窗口 |
| narrative/setup-scheduler.test.ts（126） | scheduleSetups、computeCurrentAnchorId（含声明顺序） |
| narrative/episode-retriever.test.ts（263）、fact-retriever.test.ts（55）、ending-report.test.ts（92）、narrative-context-builder.test.ts（229） | 各自唯一导出函数的选取/渲染规则（含规避清单、payoffMissing 标注） |
| director/actor-briefing.test.ts（375） | buildActorBriefing 段渲染、防火墙负向快照（canon/结局候选/他周目不进剪报、导演 prompt 可见 canon——边界对照） |
| core/outline/types.test.ts（112） | OutlineNodeSchema、状态机谓词、transitionOutlineNode |
| 无直接测试 | core/narrative/setup-directive.ts、application/outline/outline-writer.ts（后者经 5 个消费者测试文件间接覆盖） |

## 7. 重构关注点（事实清单）

1. **双「导演」同名异责，命名易误导**：`application/director/director-service.ts:125`（场景演出导演：LLM 工具循环产 SceneDirective，bootstrap L523 进程级单实例）与 `application/narrative/narrative-director-service.ts:149`（记忆导演：整理管线，bootstrap L599 每会话实例）。二者互不 import、无共享父接口（SceneDirectorPort 是 Pick<DirectorService>，NarrativeDirectorPort 独立），职责划分本身清晰，但「director」一词在 codebase 中至少三义（DirectorService / NarrativeDirectorService / DIRECTIVE_SYSTEM_PROMPT 的「导演」），且 directory 名 `application/director` 与 `application/narrative` 平级却无依赖关系。
2. **memory-validator.ts 1188 行三职责混杂**：L83-713 规则校验与状态应用（validate*/apply*ToState/classifySetup）+ L715-1188 §6.2 身份视图族（MemoryIdentityView/buildMemoryIdentityView/validate*Identity/selectCitableReferences）——后者是 C8/M2 后长出的独立子系统，可整体拆出。
3. **ACTIVE_THREAD_STATUSES 双定义**：memory-validator.ts:45-49（私有、未导出）与 memory-consolidator.ts:168-172（导出）内容相同；narrative-director-service.ts:66-70 与 setup-scheduler.ts:14 从 consolidator（orchestrator 模块）反向 import 状态集合常量——常量归属错位。
4. **runConsolidatePending 215 行**（narrative-director-service.ts:514-728）：截批、port 失败回队、身份修复（Ruling 14 瞬时/终态分支）、降级记录、缺口水位、影子应用与持久化全内联在一个私有方法。
5. **MemoryConsolidator.consolidate 约 300 行**（memory-consolidator.ts:219-522）：请求构造含两次 buildMemoryIdentityView（provisional L275-282 + 最终 L299-309），影子校验五段顺序耦合拒绝记录顺序（episode 先记录后校验的注释 L365-368）。
6. **缺省值双真源**：MAX_CITABLE_BELIEFS_PER_REQUEST（memory-validator.ts:1022）与 config beliefs.request_max 需人工同步——两处注释自认「两处缺省必须保持一致」（memory-validator.ts:1019-1021、memory-consolidator.ts:289-291）。
7. **outline port 放置在 application 层**：outline-writer.ts:109-120 定义 OutlineWriterPort/OutlineMaintainerPort，而其余 port 均在 core/ports/；adapter（adapters/llm/outline-writer-adapter.ts:120）实现 application 层接口，且 adapters/storage/voice-design-store.ts:10-11、application/audio/* 反向依赖 application/outline 的类型——与「adapter 只依赖 core」的分层方向不一致。
8. **场景导演跨域词汇耦合**：director-service.ts:29-42 直接 import application/audio/performance-compiler 词表与 shared/music/score 契约（voice/music 指导解析内嵌在导演服务）；DIRECTIVE_SYSTEM_PROMPT（L81-100）运行时拼接四张词表。
9. **checkpoint() 调用方与 port 定义位置分离**：NarrativeDirectorPort.checkpoint（core/ports/narrative-director-port.ts:36）的调用方全部在 runtime/interaction-*（interaction-choice.ts:82 等），game.ts 不调用——记忆驱动的「节拍」语义分散在 interaction 运行时。
10. **测试基建位于生产目录**：narrative-director-test-kit.ts 在 src/application/narrative/ 下（无 .test 后缀），被 4 个测试文件消费；makeConfig（L36-40）浅合并整段 narrative 正是 normalizeNarrativeConfig（narrative-director-service.ts:130-143）存在的原因——注释自述「Callers may shallow-merge configs」。
11. **retrieveFacts 同策略重复执行**：每轮 brief（narrative-director-service.ts:376-380）与每次 consolidate（selectCitableReferences，memory-validator.ts:1060-1064）各扫一次 facts；satisfiedSetupIds 对每个 setup 全量重算 prerequisites（narrative-director-service.ts:326-330）。
12. **narrative-director-service.ts:21 直接 import adapter 类型**：`StoryPlan` 来自 ../../adapters/static/story-plan-loader.js——应用服务依赖 adapters 层类型，方向倒置。
13. **恢复路径 episodes 缓存清空**（narrative-director-service.ts:399-406 注释，M1.1 决议）：restoreFromDigest 后 relevantEpisodes 检索在 episodes 重新积累前返回空——是有意设计但重构时需保留语义。

## 8. 建议层级定位（对建议框架的回应）

按 L0 共享内核 / L1 core 领域 / L2 application 服务 / L3 adapters / L4 装配的框架：

- core/narrative（memory-types/memory-operation/memory-projection/setup-directive）与 core/outline/types → **L1**，现状即符合。
- application/narrative 的纯函数（memory-validator、setup-scheduler、episode/fact-retriever、ending-report、narrative-context-builder）→ 名义 L2 实质无 IO 无状态，可下沉 L1（尤其 memory-validator 的规则段是领域规则）；memory-consolidator/narrative-director-service/lesson-service → **L2**。
- application/director（DirectorService/actor-briefing）→ **L2**（LLM 编排服务）；但其对 audio/music 词表的依赖属跨域契约，宜经 port/共享内核中转。
- application/outline/outline-writer.ts → **建议移至 L1**（core/ports 或 core/outline）：它是纯 port+类型定义，被 L3 adapter 实现、被多个 L2 消费，留在 application 造成 adapters→application 反向依赖（§7.7）。
- narrative-director-test-kit.ts → 建议移入 test-support/（L6 工具链）。
