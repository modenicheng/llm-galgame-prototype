# 剧情图与故事投影域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：16 文件 / 4204 行（生产代码，不含测试）
> 快照：D:/coding/lgp-main-atlas（只读）。行号均为该快照实际 Read/Grep 所得。

## 1. 域职责与边界

本域由三块咬合而成：

- **core/graph（L1，图数据结构与纯算法）**：v2 剧情图契约的唯一 schema 来源（`SNAPSHOT_VERSION = 4`）——节点（SceneNode/DecisionNode/EndingNode）、边（PlotEdge + 负载统计 + 汇流凭据）、周目（RunRecord/ActiveCursor）；快照 v3→v4 显式升级适配器（snapshot-upcast）；ID 前缀规则与世界存储布局常量（ids）；边集上的共享纯函数（walk：最近入边/路径祖先/世界最大 seq）；交互表单快照 ↔ 运行时事件映射（form）；MemoryDigest ↔ NarrativeMemoryState 纯映射（memory-digest）；测试夹具（testing，仅供测试导入）。全部无 IO。
- **application/graph（L2，协调器/汇流/视图）**：`RunGraphCoordinator` 实现 `RunGraphPort`（core/ports/run-graph-port.ts），把演员管线生命周期（beginEdge→appendEdgeEvents→openDecision→reachEnding）翻译成 GraphStorePort 的图记录，另担 GC、恢复水合、回溯、同选项快进、大纲确定性迁移与后台维护、结算统计；`ConfluenceChecker` 在边收束后做后台 LLM 汇流判定与改绑；graph-view 装配 `GET /api/graph` 的脱敏总览图与结算/图鉴视图。
- **story（事件投影与上下文构建）**：types.ts 是 LLM 生成契约（GenerationEnvelope）、玩家交互契约（InteractionEvent）与图快照内嵌 StoryState 的单一类型源；event-projection 把已提交事件做「身份稳定投影」（writer 历史/记忆证据/前情梗概三入口）；reconcile 从已提交事件确定性投影 StoryState live 字段；state 提供初始态与 LLM 摘要序列化；interaction-policy 在运行时复检交互表单不变量；context-builder 把以上全部装配成 system prompt 与 DSL user prompt——**消费方是 LLM 适配层（adapters/llm/openai-compatible-generator.ts 等），不是玩家前端**。

数据形态要点：节点 = 决策点（入口快照 StateSnapshot + 表单快照 InteractionFormSnapshot）；边 = 玩家一次选择 + 该段全部已提交事件（payload jsonl + stats）+ 末态快照；分支 = 边的自然分叉；汇流 = 边末态与既有决策节点入口态被 LLM 判定等价后改绑（confluence 凭据内联，孤儿节点零删除）。事件投影：StoredEvent →（reconcile）→ StoryState live 字段、→（memoryDigest 映射）→ 记忆摘要入快照、→（event-projection）→ writer/记忆/梗概三个视角。

三者边界：core/graph 不知道应用层（只被依赖）；application/graph 依赖 ports（GraphStorePort/ConfluenceJudgePort/OutlineStorePort 等）与 core/graph；story/types 被 core 依赖（层级倒置，见 §7），story 其余模块被 adapters/llm、application/narrative、game.ts 消费。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| src/application/graph/run-graph-coordinator.ts | 929 | RunGraphPort 应用层实现：周目/开放边状态机、恢复水合、回溯/快进、GC、大纲迁移与后台维护、结算统计 | 2 | run-graph-coordinator.test.ts(443)、run-graph-coordinator-outline.test.ts(169)、run-graph-retrace.test.ts(158)、run-graph-gc.test.ts(147)、game-graph-store.test.ts、game-graph-restore.test.ts |
| src/application/graph/confluence-checker.ts | 350 | 后台汇流子系统：末态索引、确定性预筛、LLM 判定、互斥链内改绑 | 2 | run-graph-confluence.test.ts(597) |
| src/application/graph/graph-view.ts | 419 | 总览图/结算/图鉴三个脱敏视图装配 | 13 | graph-view.test.ts(143)、settlement-view.test.ts(119) |
| src/core/graph/types.ts | 281 | v2 图契约唯一 schema 来源（快照 v4/节点/边/周目） | 29 | types.test.ts(292)、game-graph-store.test.ts |
| src/core/graph/snapshot-upcast.ts | 308 | 快照 v3→v4 内存升级适配器 + 版本闸门 + 身份键解析 | 8 | snapshot-upcast.test.ts(253) |
| src/core/graph/ids.ts | 87 | ID 前缀规则、id schema、GAME_STORAGE_LAYOUT、路径函数 | 25 | ids.test.ts(56) |
| src/core/graph/form.ts | 69 | InteractionEvent ↔ InteractionFormSnapshot 纯映射 | 2 | types.test.ts(292, formSnapshotFromInteraction 段) |
| src/core/graph/memory-digest.ts | 65 | MemoryDigest ↔ NarrativeMemoryState 纯映射 | 3 | memory-digest.test.ts(129) |
| src/core/graph/walk.ts | 54 | 边集共享纯函数：快照投影/seq 统计/最近入边/路径祖先 | 4 | 无专属（经 coordinator/confluence 测试间接覆盖） |
| src/core/graph/testing.ts | 85 | 图契约测试夹具（仅供测试导入） | 5 | 被 8 个测试文件导入（game-graph-store/graph-view/run-graph-*/settlement-view/game-graph-restore/review-flow/confluence-judge-adapter） |
| src/story/types.ts | 448 | 生成契约/交互契约/StoryState 单一类型源 + zod schemas | 28 | types.test.ts(455)、performance-schema.test.ts(170) |
| src/story/context-builder.ts | 409 | system prompt / DSL user prompt / 视觉·素材·cast 序列化 | 9 | context-builder.test.ts(708)、llm.test.ts、actor-briefing.test.ts |
| src/story/event-projection.ts | 346 | 身份稳定事件投影（三入口）+ JSONL 渲染 + 名牌深拷贝 | 6 | event-projection.test.ts(449) |
| src/story/interaction-policy.ts | 143 | 交互表单运行时策略复检（§8.3 七步 + 相位门） | 3 | interaction-policy.test.ts(221) |
| src/story/reconcile.ts | 115 | 已提交事件 → StoryState 确定性投影 | 1 | reconcile.test.ts(79) |
| src/story/state.ts | 96 | StoryState 工厂/摘要/recap 数据块 | 3 | state.test.ts(186) |

合计导出符号 143 个；本任务指定的 5 个测试文件共 2652 行。

## 3. 函数级明细

### 3.1 src/application/graph/run-graph-coordinator.ts

#### `SEED_OUTLINE_NODE_ID = "ol_seed"` — src/application/graph/run-graph-coordinator.ts:73
M1 种子大纲节点 id：无编剧期场景节点 outlineRef 与前沿回退值。调用方：仅本文件（L731 pickFrontierRef 回退、L916 ensureSceneNode 新建场景）。依赖：无。备注：注释声明 M3.2 编剧接入后由真实大纲取代，不迁移旧 game。

#### `RunGraphCoordinator implements RunGraphPort` — src/application/graph/run-graph-coordinator.ts:91-924
图协调器主类。字段：`currentRun`/`lastDecisionId`/`openEdge`（状态机三件套）、`sceneNodes`（模型场景 id→SceneId 缓存）、`sceneOutlineRefs`、`mutationChain`（图变更互斥链 L105）、`checker`（ConfluenceChecker L108）、`outline`/`outlineRevision`/`frontierOutlineRef`（M3.4）、`canon`/`stats`/`reviewStore`/`identity`（可选装配）。构造器 L138-184：装配诊断汇、ConfluenceChecker（注入 enqueue/currentRunId/relinkOpenEdge/relinkLastDecision/outline 五个回调）、各可选 store。
调用方：src/bootstrap/create-runtime-application.ts:19,270（buildGraphCoordinator 装配，接 GameGraphStore + SystemClock + UUID 生成器 + judge/outline/canon/identity/stats/reviewStore）；测试 run-graph-coordinator*.test.ts、run-graph-confluence.test.ts、game-graph-store.test.ts、game-graph-restore.test.ts、review-flow.test.ts。依赖：GraphStorePort、ClockPort、ConfluenceJudgePort、DiagnosticSink、CanonStorePort、StatsStorePort、ReviewStorePort、GraphIdentityContext、OutlineStorePort/OutlineMaintainerPort、upcastLegacyEvents（adapters/storage/identity-upcaster）、core/graph/{types,ids,walk}、ConfluenceChecker。

公共方法逐个：

- `location: string`（字段，L92）——透传 store.location；game.ts:407 消费。
- `startRootRun(): Promise<RunId>`（L193-195）→ `startRootRunUnsafe`（L197-209）：initialize → 造 root 周目 CurrentRun → 重置 lastDecisionId/openEdge → putRun。
- `restoreOrCreateRun(options?): Promise<RunResume>`（L216-218）→ `restoreOrCreateRunUnsafe`（L220-249）。「继续游戏」统一入口。步骤：① initialize + collectGarbage；② loadCursor 为 null → 最新周目已完结且非 restart → 返回 ended（endingTextOf 回收文本）；③ 无游标 → 以 worldMaxSeq(listEdges)+1 播种开新 root（M2.1 跨周目 seq 单调）；④ restart → restartFromCursor；⑤ 否则 hydrateFromCursor。调用方：game.ts:419。
- `retraceFrom(decisionId): Promise<RestorePoint>`（L256-258）→ `retraceFromUnsafe`（L260-287）：目标决策存在性校验 → 活跃周目记 abandonedAt（图零删除，D7）→ 新 retrace 周目 → 游标改绑 → hydrateFromCursor。调用方：game.ts:253。
- `collectGarbage(): Promise<void>`（L441-517）M5.6 图维护 GC。步骤：① 列 decisions/edges/runs/cursor；② 构建保护集：每个周目终点（ending 边/abandonedAt/retrace 起点/游标）沿 pickLatestInEdge 逆向行走保护节点与入边（同结局 id 的全部指向边都保护，L465）；③ 不动点迭代删除无存活入边的决策节点及其牵连边（protectedEdges 除外）；④ removeDecision/removeEdge + discardOrphanPayloads；⑤ 有回收则 diagnostics.info。幂等。
- `beginEdge(choice): Promise<BeginEdgeResult>`（L538-540）→ `beginEdgeUnsafe`（L542-581）：① 状态机校验（无周目/首决策未开/边未收束 → 抛错）；② M5.3 同选项快进：与 lastDecisionId 既有出边 kind+text 严格相等且指向决策节点 → saveCursor 前移 + hydrateFromCursor 返回 fast_forward（结局端点不参与）；③ 否则开放新 OpenEdge（新 eg_ id）返回 opened。调用方：game.ts:1697（option）、1704（free_input）。
- `appendEdgeEvents(events): Promise<void>`（L583-585）→ `appendEdgeEventsUnsafe`（L587-595）：openEdge 为 null 时静默忽略（开局段事件不入图）；否则逐事件 appendPayload 并维护 eventCount/firstSeq/lastSeq。调用方：game.ts:1723。
- `openDecision(input): Promise<DecisionId>`（L597-610）：enqueue(openDecisionUnsafe) 后 `checker.schedule`（链内尾随）+ `void maintainOutlineQuietly`（链外 fire-and-forget）。调用方：game.ts:1087。
- `reachEnding(input): Promise<EndingId>`（L654-656）→ `reachEndingUnsafe`（L827-895）：① endingId = "end_"+sanitizeIdSuffix；② putEnding + 收束开放边（endState 内联，to: ending）；③ putRun(endedAt+ending) + currentRun=null + clearCursor；④ M5.4 结算统计：倒序找最近指向该结局的边，沿 pickLatestInEdge 回溯 traversed 边表 → stats.recordSettlement（失败只告警）。调用方：game.ts:1794。
- `currentOutlineRevision(): number`（L658-660）：返回缓存的 outlineRevision。调用方：game.ts:1749（currentMoment）。

私有方法（复杂者给步骤）：

- `enqueue(op)`（L187-191）：mutationChain 串行队列，吞错续链。
- `restartFromCursor(cursor)`（L295-314）：hydrateFromCursor → 旧周目记 abandonedAt → 新 retrace 周目绑游标。
- `hydrateFromCursor(cursor)`（L317-363）恢复水合。步骤：① run/decision 存在性校验（损坏大声抛错）；② discardOrphanPayloads；③ 根→游标路径回放：逐节点 pickLatestInEdge 取「最近走过」入边，readPayload 收集后 reverse().flat() 成 pathEvents；④ upcastPathEventsForReplay 身份升级（内存副本）；⑤ nextSeq = max(worldMaxSeq, pathLastSeq, digest 水位)+1；⑥ 重建 currentRun/lastDecisionId/openEdge=null，返回 RestorePoint（含 turnFloor 与可选 migration 报告）。
- `upcastPathEventsForReplay(events)`（L370-420）：无 identity/roster 透传；否则 upcastLegacyEvents 升级，仅在有 alias_resolved/unresolved_* 发现时携带 SessionMigrationReport 并 warn。
- `discardOrphanPayloads(edges)`（L423-430）：有 payload 文件但无边记录 = 崩溃残留，deletePayload。
- `endingTextOf(endingId)`（L524-536）：倒序扫描边（同结局 id 跨周目易重号 → 取最近写入），readPayload 找最后一条 end 事件的 text；开局直落结局为 null。
- `ensureOutlineLoaded()`（L667-673）：惰性加载 OutlineStore 一次（缺文件 = 空大纲 revision 0）。
- `migrateOutlineForScene(sceneId)`（L682-724）确定性迁移（无 LLM，D5）。步骤：① 同场景已迁移则跳过；② 进入新场景：上一前沿 act（active 且未实例化）→ realize（instantiatedBy=上一场景节点）；③ 前沿推进 pickFrontierRef（首个未 realized 的 act，无大纲回退 ol_seed），outlineRef 回写场景节点（append-only latest-wins）；④ planned → activate；⑤ 失败只告警不阻塞演出。
- `pickFrontierRef()`（L727-732）：首个非 realized 的 act，回退 SEED_OUTLINE_NODE_ID。
- `applyOutlineQuietly`/`applyOutlineQuietlyInner(ops, reason, viaChain)`（L734-736/743-763）：大纲修订统一入口；确定性迁移已在链内（直呼），后台维护链外入链串行（防两个 await 点交错产生重复 revision）。
- `maintainOutlineQuietly(input)`（L766-805）后台 LLM 维护（单飞）。步骤：① maintainer 缺席/已在跑/空大纲 → 返回；② loadCanonQuietly + reviewStore.list 收集输入；③ maintainer.maintainOutline 产 op；④ 预筛：只允许 add(planned)/prune(planned 或未实例化 active)，不得 activate/realize（确定性迁移独占）；⑤ 非空则经链 applyRevision。
- `loadCanonQuietly()`（L808-825）：canon 惰性加载一次，失败 undefined 不带进维护。
- `openDecisionUnsafe(input)`（L612-652）决策落盘。步骤：① 新 dc_ id + ensureSceneNode；② entryState = toStateSnapshot(moment)；③ putDecision；④ migrateOutlineForScene；⑤ checker.indexDecision；⑥ 收束前一条开放边：putEdge(endState = 本次入口快照，§3.3 不变量的结构保证)；⑦ lastDecisionId 推进 + saveCursor；⑧ 返回 {decisionId, sceneId, closedEdgeId}。
- `ensureSceneNode(modelSceneId)`（L903-922）：缓存 → 扫既有决策入口快照同 scene → 惰性创建（世界级稳定，M2.2 修订；收口单点防跨周目场景重复）。

**内部辅助**：`OpenEdge`（L75-82 开放边内存形态）、`CurrentRun`（L84-89）、模块函数 `sanitizeIdSuffix(raw)`（L926-929，结局 id 后缀清洗为 [A-Za-z0-9._-]）。

### 3.2 src/application/graph/confluence-checker.ts

#### `ConfluenceCheckerDeps` — src/application/graph/confluence-checker.ts:55-72
协调器侧依赖接口：`enqueue`（改绑落地入队）、`currentRunId`（改绑窗口判定）、`relinkOpenEdge`/`relinkLastDecision`（开放边与最近决策重挂）、`outline`（D8 物理地点键解析源：ensureLoaded/nodes/sceneRefs）。用途：把对协调器可变状态的访问收敛为具名操作。调用方：run-graph-coordinator.ts:157-178（构造 ConfluenceChecker 时注入）。依赖：ids/OutlineNode 类型。

#### `ConfluenceChecker` — src/application/graph/confluence-checker.ts:74-311
汇流子系统。构造器 L78-83 持 store/judge/diagnostics/deps；`endStateIndex`（L76，SceneId→EndStateKey[]，惰性一次）。
方法：

- `indexDecision(decisionId, sceneId, entryState)`（L86-97）：索引就绪后新决策入索引（D8 键经内存映射解析）；null 时 no-op（首次重建自然包含）。调用方：run-graph-coordinator.ts:625。
- `deindexDecision(decisionId)`（L100-106）：汇流孤儿化节点出索引。调用方：本类 applyMatch L279。
- `schedule(input, opened)`（L109-129）：fire-and-forget 入口——judge 缺席/无收束边/无活动周目直接返回；构造 context 后 `void runCheck().catch(warn)`（实时性红线：判定失败只告警）。调用方：run-graph-coordinator.ts:604。
- `private runCheck(context)`（L131-198）判定主流程（链外）。步骤：① hydrateEndStateIndex；② extractEndStateKey 提新边末态键；③ 候选过滤：非自身、不在 pathAncestors（防成环）、有入边（孤儿/周目首节点排除）、身份契约一致（dslProtocolVersion + rosterRevision 任一不同即不送判，M3）；④ prescreenScore 确定性预筛限流（0 分不送判），按命中键数降序；⑤ Promise.allSettled 逐个 judge.judge，取 confidence 最高命中；⑥ enqueue(applyMatch)。
- `private applyMatch(context, candidate, judgment)`（L205-284）互斥链内改绑落地。步骤：① 窗口守卫（currentRunId 不变）；② 边守卫（仍指向 newNode 且无 confluence）；③ 身份契约闸门互斥链内复核；④ 防成环（候选不在游标 pathAncestors 上）；⑤ 入边改指候选 + confluence 凭据内联（endState 保留真实末态 ≠ 候选入口，凭据承担差异审计）；⑥ 出边改源：开放边走 relinkOpenEdge（内存），否则全部历史出边逐一 putEdge 改 from（防 find 只重挂第一条残留）；⑦ 游标仍停在新节点则前移；⑧ deindexDecision + diagnostics.info。
- `private hydrateEndStateIndex()`（L287-310）：listDecisions + listScenes + outline 加载，sceneId→outlineRef→OutlineNode.location 解析 D8 键，单点重建。

**内部辅助**：`EndStateKey`（L42-52 摘要键：location/characters/outlineLocation/身份契约键/entryState 缓存）、模块函数 `extractEndStateKey(decisionId, sceneId, snapshot)`（L314-329）、`prescreenScore(newKey, candidate)`（L332-350，命中键数计分：location 等价/角色集合等价/outline 物理地点等价各 +1）。

### 3.3 src/application/graph/graph-view.ts

#### `GraphDecisionView` — src/application/graph/graph-view.ts:23-33
单决策视图（id + form{mode,prompt,options?,placeholder?} + isCursor）。
#### `GraphEdgeView` — :36-44
单边视图（choiceText/choiceKind/to 端点 + 可选 confluence{matchedNode,judgedBy,confidence} 凭据标注）。
#### `GraphSceneView` — :47-56
场景块视图（sceneId/groupKey(D8 物理地点分组键，无大纲回退模型场景 id)/status/outlineRef?/decisions/outEdges）。
#### `GraphRunStats` — :59-64
周目统计折叠（total/ended/abandoned/active）。
#### `GraphView` — :66-90
总览图顶层形状：scenes + cursor? + runs + identity?（游标节点身份契约指纹：rosterScopeId/rosterRevision/dslProtocolVersion，脱敏不暴露 roster 内容）+ outlineReview?（M5.5 ③ 通关解锁：acts + endings）。
#### `GraphViewStores` — :92-98
装配输入（gameId/graph 必填，outline/stats 可选）。
#### `buildGraphView(stores): Promise<GraphView>` — :104-133
总览装配。步骤：① Promise.all 并行拉 decisions/edges/scenes/runs/cursor；② actWhitelistByScene 脱敏白名单；③ cursorIdentityOf 游标身份指纹；④ sceneViewsOf 场景块；⑤ 周目统计折叠；⑥ outlineReviewOf 通关解锁段。调用方：src/entrypoints/web.ts:112（graph.build 通道）；GraphView 类型被 src/hosts/local-web/local-web-host.ts:78 引用。依赖：GraphStorePort/OutlineStorePort/StatsStorePort。
#### `SettlementView` — :273-285
结算视图（runId/endingId/endingText/payoffRate?/outlineProgress?/endingsAchieved/edgesTraversed）。
#### `GalleryEntry` — :288-294
图鉴条目（未达成固定 "???"，不剧透）。
#### `GalleryView` — :296-300
图鉴视图（entries + achievedCount）。
#### `SettlementStores` — :302-310
结算/图鉴装配输入（graph/outline/stats + sessionsDir?/sessionId? 定位 ending-report.json）。
#### `buildSettlementView(stores): Promise<SettlementView>` — :331-383
结算装配：最新完结周目 → 倒序找指向结局的边回收 endingText（开局直落结局 null）→ readFile 读 `<sessionsDir>/<sessionId>/ending-report.json` 的 setups.payoffRate（best-effort）→ stats.load + outlineProgressOf。无完结周目抛错。调用方：src/entrypoints/web.ts:119。
#### `buildGalleryView(stores): Promise<GalleryView>` — :386-419
图鉴装配：已达成结局按 count 降序给语义名（去 end_ 前缀）；outline 未 pruned 的 ending 候选中未达成者补 "???"（只暴露数量）。调用方：src/entrypoints/web.ts:128。

**内部辅助**：`cursorIdentityOf`（L136-149）、`actWhitelistByScene`（L152-178，只有 active/realized 的 act 允许以 outlineRef/groupKey 出现）、`sceneViewsOf`（L181-231，空场景不出图、决策按落盘序=剧情时序）、`outlineReviewOf`（L234-261，settledRuns ≥ 1 才解锁）、`endingLabel`（L264-266）、`outlineProgressOf`（L313-328，realized act/总 act）。

### 3.4 src/core/graph/types.ts

#### `SNAPSHOT_VERSION = 4` — src/core/graph/types.ts:51
快照契约版本。v2：MemoryDigest 增 facts/beliefs；v3：StoryState 瘦身；v4：增身份块 SnapshotIdentityState、consolidationFailedIntervals 转必填。v1/v2 读取即拒，v3 经升级适配器。调用方：adapters/storage/game-graph-store.ts（L46 import）、snapshot-upcast.ts、walk.ts、testing.ts。备注：字段集属冻结契约，新增可选字段不翻版本但须登记。

#### `SnapshotIdentityStateSchema` / `SnapshotIdentityState` — :85-107 / :108
快照身份块（v4）：`identitySchemaVersion`（literal）、`dslProtocolVersion`（只接受 1|2，域外值拒绝解析）、`rosterScopeId`/`rosterRevision`（roster 只引用 {scopeId, revision}，完整人设是 world/rosters/ 共享不可变 blob）、`characterLabels`（原型安全 record，L58-78 characterLabelsRecord 预处理危险键）、`cast`（allowedSpeakerIds + sceneParticipantIds）。被 StateSnapshotSchema 引用；汇流比较前置条件（confluence-checker）。
#### `InteractionFormSnapshotSchema` / `InteractionFormSnapshot` — :114-132 / :134
决策节点上的表单快照：mode(choice/input/hybrid) + prompt + options?/placeholder?；refine 强制字段与 mode 匹配。运行时 option id 不入契约，文本即语义。
#### `MemoryDigestSchema` / `MemoryDigest` — :140-155 / :156
记忆摘要：revision/consolidatedThroughEventSeq/checkpointCount/threads/setups/anchors/facts/beliefs（v2 全文嵌入，D6）/consolidationFailedIntervals（v4 必填）。
#### `StateSnapshotSchema` / `StateSnapshot` — :162-170 / :171
状态快照——回溯恢复、汇流比较、结算统计的共同货币：snapshotVersion(literal 4) + storyState + visualState + memoryDigest + outlineRevision + identity。
#### `SceneNodeSchema` / `SceneNode` — :177-181 / :182
场景节点：id + outlineRef + status(active|realized)。
#### `DecisionNodeSchema` / `DecisionNode` — :184-189 / :190
决策节点：id + sceneId + entryState(StateSnapshot) + form(InteractionFormSnapshot)。
#### `EdgePayloadStatsSchema` / `EdgePayloadStats` — :193-205 / :206
边负载统计：eventCount/firstSeq/lastSeq，refine 强制「全零或 firstSeq≥1 且 ≤ lastSeq」（seq 单调）。
#### `EdgeEndpointSchema` / `EdgeEndpoint` — :208-211 / :212
边端点判别联合：decision | ending。
#### `ConfluenceEvidenceSchema` / `ConfluenceEvidence` — :214-219 / :220
汇流凭据：matchedNode/judgedBy/confidence(0-1)/rationale。
#### `PlotEdgeSchema` / `PlotEdge` — :223-242 / :243
边：id + from(DecisionId) + choice{kind: option|free_input, text} + payload(stats) + endState(StateSnapshot) + to(端点) + confluence?；refine 强制 confluence.matchedNode == to.id（指向既有后继即为汇流）。
#### `EndingNodeSchema` / `EndingNode` — :245-248 / :249
结局节点：id + outlineRef?。
#### `RunRecordSchema` / `RunRecord` — :255-274 / :275
周目记录：id + origin(root | retrace{from}) + startedAt + endedAt?/ending?/abandonedAt?；双 refine：有 ending 必有 endedAt；abandoned 与 ended 互斥。非记忆容器（§6）。
#### `ActiveCursorSchema` / `ActiveCursor` — :277-280 / :281
活动游标：runId + position(DecisionId)。

依赖：zod、story/types（StoryStateSchema）、core/narrative/memory-types、core/presentation/types、core/characters/types、core/ports/identity-snapshot-port、./ids。
调用方（域外，Grep 核实）：adapters/storage/game-graph-store.ts:32,46（schemas + SNAPSHOT_VERSION）、adapters/llm/confluence-judge-adapter.ts:18（StateSnapshot）、application/narrative/narrative-director-service.ts:49（MemoryDigest）、application/outline/outline-writer.ts:11（MemoryDigest）、game.ts:32、game-test-kit.ts:33、review-flow.test.ts:17、canon-promoter.test.ts:16、run-graph-gc.test.ts:14、run-graph-confluence.test.ts:24。

**内部辅助**：`characterLabelsRecord`（L58-78，非导出，危险键 preprocess + 合法角色 ID refine）。

### 3.5 src/core/graph/snapshot-upcast.ts

#### `SnapshotVersionGateError` — src/core/graph/snapshot-upcast.ts:41-50
版本不被支持（v1/v2 或未来版本），携带 foundVersion/supportedVersion。调用方：game-graph-store.test.ts:471、snapshot-upcast.test.ts。
#### `SnapshotUpcastError` — :53-62
v3→v4 升级中无法唯一解析的身份引用，携带 refs[]/reasons[]（整档拒绝）。
#### `REJECTED_SNAPSHOT_VERSIONS = [1, 2]` — :70
读取即拒的版本表。
#### `SnapshotUpcastContext` — :91-101
升级上下文：roster（SnapshotRosterSnapshot，键解析权威）+ dslProtocolVersion（按当前配置落章）+ legacyMapping?。
#### `buildSnapshotIdentityState(input): SnapshotIdentityState` — :107-125
由 roster + 协议版本构造 v4 身份块（cast：NPC=允许说话人、全体=场景参与者）。调用方：本文件 upcastSnapshotV3ToV4:300、snapshot-upcast.test.ts:235。
#### `readSnapshotVersion(payload): number | undefined` — :128-132
读自报契约版本（非整数 → undefined）。调用方：game-graph-store.ts:376。
#### `assertSupportedSnapshotVersion(version): void` — :135-151
版本闸门：3/4 放行；1/2 与更高版本抛 SnapshotVersionGateError。调用方：game-graph-store.ts:381。
#### `upcastSnapshotV3ToV4(payload, context): StateSnapshot` — :233-308
v3 载荷 → v4（内存副本，原对象不动）。步骤：① V3StateSnapshotSchema.parse（v3 历史形状冻结，L79-85）；② buildKeyResolver（优先级链：roster 已验证 ID → 唯一 legacy alias → 拒绝；scopeId 不一致直接抛错 L162-173）；③ visualState 角色键逐个解析；④ digest.beliefs 的 characterId 解析；⑤ facts 的 scope.characters 逐个解析；⑥ 有 unresolved → 收集全部后一次抛 SnapshotUpcastError；⑦ 组装候选（版本 4、digest 补 consolidationFailedIntervals=[]、identity=buildSnapshotIdentityState 空名牌）；⑧ StateSnapshotSchema.parse 复验。调用方：game-graph-store.ts:399。

**内部辅助**：`V3_SNAPSHOT_VERSION`（L68）、`V3MemoryDigestSchema`（L72-77）、`V3StateSnapshotSchema`（L79-85）、`KeyResolver`（L157-160）、`buildKeyResolver`（L162-206）、`collectUnresolved`（L209-217）。

### 3.6 src/core/graph/ids.ts

#### `GAME_ID_PREFIX`/`SCENE_ID_PREFIX`/`DECISION_ID_PREFIX`/`EDGE_ID_PREFIX`/`ENDING_ID_PREFIX`/`RUN_ID_PREFIX`/`OUTLINE_NODE_ID_PREFIX` — src/core/graph/ids.ts:11-17
七类 ID 前缀常量（game_/sc_/dc_/eg_/end_/run_/ol_）。调用方：run-graph-coordinator.ts:50-56、game-graph-store.ts、各测试。
#### `GameId`/`SceneId`/`DecisionId`/`EdgeId`/`EndingId`/`RunId`/`OutlineNodeId`（type = string）— :24-30
品牌化 id 类型别名。
#### `GameIdSchema`…`OutlineNodeIdSchema` — :32-39
`^前缀[A-Za-z0-9._-]+$` 正则 schema（L19-22 prefixedIdSchema）。调用方：types.ts、game-graph-store.ts:57-59。
#### `GAME_STORAGE_LAYOUT` — :45-68
世界存储布局常量（相对 games/<gameId>/ 的 POSIX 路径）：world/canon(.log)、world/rosters、outline(.log).json、graph/{scenes,decisions,edges,endings,runs}.jsonl、graph/payloads、graph/snapshots、cursor.json、stats.json、music/{themes.json,scores,session.jsonl}、assets/resources.yaml。调用方（Grep 核实）：adapters/storage/game-graph-store.ts:55、canon-store.ts:19、outline-store.ts:20、stats-store.ts:14、music-theme-store.ts:18、composer-session-store.ts:19、canon-promoter.test.ts:18、outline-store.test.ts:12、canon-store.test.ts:11。
#### `edgePayloadPath(edgeId): string` — :71-73
`graph/payloads/<edgeId>.jsonl`。调用方：game-graph-store.ts。
#### `decisionSnapshotPath(decisionId): string` — :76-78
`graph/snapshots/<decisionId>.json`。调用方：game-graph-store.ts。
#### `rosterBlobPath(revision): string` — :84-87
`world/rosters/<清洗后 revision>.json`（M3 共享不可变 roster blob；文件名防御性清洗）。调用方：game-graph-store.ts。

**内部辅助**：`ID_SUFFIX`（L19）、`prefixedIdSchema`（L21-22）。

### 3.7 src/core/graph/form.ts

#### `formSnapshotFromInteraction(event: InteractionEvent): InteractionFormSnapshot` — src/core/graph/form.ts:11-24
运行时交互事件 → 契约表单快照（丢弃运行时 option id，保留 prompt/文本/placeholder）。调用方：game.ts:29,1089；types.test.ts:15。
#### `interactionFromFormSnapshot(form, interactionId): InteractionEvent` — :33-69
恢复重放（M1.4）逆向映射：id 按运行时惯例重铸（`<interactionId>_opt_<index>`）；input 的 kind/max_length 不入契约、按默认 free_text/500 重建。调用方：game.ts:30,567（startRestoredSegment 表单重放）。

### 3.8 src/core/graph/memory-digest.ts

#### `EMPTY_MEMORY_DIGEST: MemoryDigest` — src/core/graph/memory-digest.ts:14-24
空摘要常量（event mode / director 未接入时）。调用方：game.ts:27,1744、game-test-kit.ts:32,321、confluence-judge-adapter.test.ts:13、game-graph-restore.test.ts:40。
#### `memoryDigestFromState(state: NarrativeMemoryState): MemoryDigest` — :30-44
摘要化（丢弃 recentEpisodeIds 缓存指针；facts/beliefs 深拷贝全文嵌入）。调用方：application/narrative/narrative-director-service.ts:48,396。
#### `memoryStateFromDigest(digest: MemoryDigest): NarrativeMemoryState` — :47-65
重建运行时记忆态（episodes 从空积累；consolidationFailedIntervals 映射层容忍缺省补 []）。调用方：narrative-director-service.ts:48,403（restoreFromDigest）。

### 3.9 src/core/graph/walk.ts

#### `toStateSnapshot(moment: RuntimeMoment): StateSnapshot` — src/core/graph/walk.ts:12-21
运行时快照投影（moment → 持久化契约形状，铺 snapshotVersion）。调用方：run-graph-coordinator.ts:70,622,835、confluence-checker.ts:33,121。
#### `worldMaxSeq(edges): number` — :27-29
世界最大已落盘事件 seq（各边 lastSeq 取最大；开局段不入图故 recorded edges 即全集）。调用方：run-graph-coordinator.ts:69,241,359。
#### `pickLatestInEdge(edges, nodeId): PlotEdge | undefined` — :32-39
指向 nodeId 的入边中 lastSeq 最大者（「最近走过」）。调用方：run-graph-coordinator.ts:337,456,884、pathAncestors。
#### `pathAncestors(edges, start): Set<DecisionId>` — :45-54
根→start 当前路径节点集（沿最近入边回溯）；汇流候选排除集（防成环）。调用方：run-graph-coordinator.ts:66、confluence-checker.ts:33,149,241。

备注：文件头注释自述置入 core 的原因——避免 RunGraphCoordinator 与 ConfluenceChecker 两个应用层模块互相依赖。

### 3.10 src/core/graph/testing.ts

#### `makeIdentity(overrides?): SnapshotIdentityState` — src/core/graph/testing.ts:15-27
v4 身份块默认夹具（legacy 视图：scope/revision="legacy"、空名牌、空 cast）。
#### `makeSnapshot(overrides?): StateSnapshot` — :29-53
最小合法 v4 快照（含中文示例场景「地下室/旧终端」）。
#### `makeForm(overrides?): InteractionFormSnapshot` — :55-59
默认 choice 表单（「你要怎么做？」+ 两选项）。
#### `makeDecision(overrides?): DecisionNode` — :61-72
默认决策节点（dc_001/sc_001）。
#### `makeEdge(overrides?): PlotEdge` — :74-85
默认边（eg_001，option「追问终端的来历」，空负载）。
调用方（Grep 核实，全为测试）：game-graph-store.test.ts:30、graph-view.test.ts:14、run-graph-confluence.test.ts:16、run-graph-coordinator.test.ts:17、run-graph-coordinator-outline.test.ts:17、run-graph-gc.test.ts:13、run-graph-retrace.test.ts:15、settlement-view.test.ts:15、game-graph-restore.test.ts:16、review-flow.test.ts:16、canon-promoter.test.ts:17、confluence-judge-adapter.test.ts:14。

### 3.11 src/story/types.ts

#### 再导出 `DialogueDraftEvent`/`NarrationDraftEvent`/`Portrait`/`ChoiceOption`/`EndEvent`（type）— src/story/types.ts:16-22
自 ../schema.js 兼容再导出。
#### `InteractionMode = "choice" | "input" | "hybrid"` — :50
交互模式三态。
#### `InteractionOption` — :53-58
选项（id 稳定追踪用 + text 展示）。
#### `InputSpec` — :70-76
开放输入规格：kind（free_text/guided_text/question/action/short_answer）+ placeholder + max_length。
#### `ChoiceInteraction` — :84-93
choice 模式交互事件（type:"interaction" + interaction_id + prompt + options）。
#### `InputInteraction` — :95-104
input 模式（+ input: InputSpec）。
#### `HybridInteraction` — :106-117
hybrid 模式（options + input）。
#### `InteractionEvent` — :119-122
三分支联合；模型段落的终止事件（统一分支与文本输入）。
#### `GeneratedEvent` — :134-139
段内模型可产事件联合（Dialogue/Narration/Interaction/End/Choice-legacy）。
#### `GenerationEnvelope` — :146-157
生成请求顶层返回：events + groups?（v1 EventGroupDraft / v2 CompiledEventGroupV2，AnyStreamedGroup）+ segmentEnd?。state_patch 已删除（§80-81）。
#### `CharacterState` — :164-166
每角色可变态（仅 location?）。
#### `StoryState` — :174-185
确定性投影产物（§3.2）：scene{id,location,time?,purpose} + characters + recent_summary；rich 字段已随 MA-A2 清除。
#### `BranchSource` — :192；`BranchStatus` — :194-201；`BranchCandidate` — :208-219
预取分支事务模型：queued/generating/ready/selected/discarded/failed 六态生命周期。调用方：runtime/branch-manager.ts:21。
#### `LinePerformance` — :232-263
台词表演意图（emotion/intensity/pace/energy/volume/delivery/pause_*）；与 application/audio/performance-compiler.ts 镜像同步（注释要求 keep in sync）。
#### `LinePerformanceSchema` — :265-274
zod 校验；非法 performance 丢弃但台词正文存活（catch → undefined）。
#### `PortraitSchema` — :276-280
立绘指令（character/expression/position 默认 center）。
#### `DialogueDraftEventSchema` — :282-291
宽松 legacy 对白读取器（speaker 是显示名；C2 起 frozen，只在兼容边界读取）。
#### `NarrationDraftEventSchema` — :293-297
旁白。
#### `CharacterDialogueEventSchema` — :310-317
C2 严格新格式对白：strictObject，characterId（稳定 roster ID）+ displayLabel 必填，不接受 speaker 混写。调用方：shared/wire/schemas.ts:19、schema.ts 再导出。
#### `InteractionEventSchema` — :388-392
三模式判别联合 schema（choice 选项 2-5、input 必有 input、hybrid 双有；选项 id 唯一）。调用方：schema.ts:26 再导出。
#### `StoryStateSchema` — :400-411
StoryState 校验（exactOptional 惯例）；嵌入 v2 图契约入口快照（core/graph/types.ts:15 引用）。
#### `BranchCandidateSchema` — :413-448
BranchCandidate 校验。

**内部辅助**：`InputSpecSchema`（L319-329）、`InteractionOptionSchema`（L331-334）、`validateUniqueOptionIds`（L340-357）、`ChoiceInteractionSchema`（L359-367）、`InputInteractionSchema`（L369-375）、`HybridInteractionSchema`（L377-386）。
域外调用方（Grep 核实）：src/schema.ts:10-26（大量再导出，全项目的 schema 门面）、adapters/storage/stored-event.ts:5、adapters/llm/openai-compatible-generator.ts:74、runtime/branch-manager.ts:21、runtime/interaction-driver.ts:67、core/ports/run-graph-port.ts:11、core/ports/story-generator-port.ts:20、game.ts:106,124、shared/wire/schemas.ts:19 及 10+ 测试。

### 3.12 src/story/context-builder.ts

#### `ContextInput` — src/story/context-builder.ts:27-43
上下文输入：prompts(PromptBundle) + state(StoryState) + recentEvents(StoryContextEvent[]) + registry?(CharacterRegistry，缺席=legacy 兼容) + authorConfig? + actorBriefing?（M4.2 剪报）。
#### `buildSystemContext(input): string` — :57-79
system prompt 装配（dslProtocol + 可选作者控制段 + 角色设定 + 可选故事大纲 + 写作限制；**不含**动态状态——动态进 user prompt 便于逐回合刷新）。调用方：adapters/llm/openai-compatible-generator.ts:6,330。
#### `serializeStoryContextLegacy(events): string` — :126-152
LEGACY 兼容渲染（C5 冻结）：`名牌: 台词`/`[玩家] 选择：` 纯文本行；只服务无 registry 边界（窄测试），interaction/choice/end 跳过。调用方：openai-compatible-generator.ts:8,411、narrative-consolidator-adapter.ts:22,199、director-service.ts:45,546。
#### `serializeStoryContext(events, registry): string` — :160-165
= renderProjectedEvents(projectWriterHistory(events, registry))——身份稳定事件 JSONL（§5.1）。调用方：openai-compatible-generator.ts:7,410、character-contract.test.ts:41。
#### `serializeVisualContext(state, roster?): string` — :175-224
舞台状态尾投影：背景/BGM/角色逐维度显式声明（「无」也要说，防模型重发 @bgm stop）；roster 在场补「不在场」名单。调用方：openai-compatible-generator.ts（buildDslUserPrompt 内 L382）、adapters/llm/confluence-judge-adapter.ts:19,131。
#### `serializeModelAssetCatalog(catalog, roster?): string` — :236-286
模型面素材目录序列化；C6 §5.4 去重——roster 在场时外观按角色列 look（不再给全量 spriteSets + characters 双份）；玩家标注「不由你代写台词」。调用方：openai-compatible-generator.ts（buildDslUserPrompt 内 L366）。
#### `DslContextInput`（extends ContextInput）— :293-309
DSL 模式增量：taskType/generationNonce(@end 哨兵回显)/targetLines/tailVisualState?/modelAssetCatalog?/identity?(GenerationIdentity)。
#### `renderCastSection(identity): string` — :315-335
本段 cast 段落：允许发声（空 = 仅旁白，不硬塞角色）与场景参与者分列；名牌覆盖显示「id（当前名牌：…）」。调用方：buildDslUserPrompt:391。
#### `buildDslUserPrompt(turn, input, extraInstructions?): string` — :346-409
DSL user prompt 装配。步骤（段落按「稳定 → 易变」排序，D9 前缀缓存友好）：① 剧情历史（registry 有无切换 serializeStoryContext/Legacy；不做窗口截断——截断会移动公共前缀起点）；② 可用素材（serializeModelAssetCatalog）；③ 当前故事状态（summarizeState）；④ 导演便签（actorBriefing 非空才入）；⑤ 当前舞台状态（serializeVisualContext；identity 缺席才从 registry roster 派生不在场）；⑥ 本段 cast（identity 在场）；⑦ 任务头（taskType/turn/targetLines/nonce + 协议版本与 roster revision）；⑧ extraInstructions。调用方：openai-compatible-generator.ts:5,484,526,570,612,643。

**内部辅助**：`buildAuthorConfigSection`（L85-109，作者控制模式/锁定/偏好/种子规则）。

### 3.13 src/story/event-projection.ts

#### `ProjectedEvent` — src/story/event-projection.ts:33-50
投影条目：eventRef（已提交 event:<seq> / 未提交 attempt:<id>:<index>）+ seq? + type + source(model|player) + characterId?/displayLabel?/text?/interactionId?/linkedEventRef?。
#### `cloneCharacterRuntimeState(state): CharacterRuntimeState` — :272-282
名牌状态无原型深拷贝（预取分支隔离副本用）。调用方：game.ts:113,582,1931。
#### `projectWriterHistory(events, registry): readonly ProjectedEvent[]` — :285-290
writer/prefetch/recovery 历史窗口（含未提交预取事件，attempt 引用）。调用方：context-builder.ts:19,164。
#### `projectMemoryEvidence(events: StoredEvent[], registry)` — :293-301
记忆证据：只有真实 seq 的已提交事件，排除 unresolved_legacy_dialogue。调用方：application/narrative/memory-consolidator.ts:17,271、memory-validator.ts:20,950、adapters/llm/narrative-consolidator-adapter.ts:24,132。
#### `projectRecapSource(events: StoredEvent[], registry)` — :304-310
前情梗概源：已提交事件，unresolved 带标记保留（压缩器如实记录）。调用方：narrative-consolidator-adapter（经投影管道）。
#### `renderProjectedEvents(events): string` — :321-323
JSONL 渲染（键序固定 eventRef 首位；一条事件永不破行；行内无 `名牌: 台词` 可误解析形态）。调用方：context-builder.ts:20,164、narrative-consolidator-adapter.ts:25,198。

**内部辅助**：`INTERACTION_PROMPT_MAX`（L57，80 字截断）、`truncateForProjection`（L59-64）、`committedSeq`（L66-70）、`resolveLegacySpeaker`（L77-86，唯一命中才归因，二义/未注册 → unresolved）、`projectOne`（L89-176，单事件投影核心：dialogue 的 characterId 直读或 legacy 解析、player_* 定性为 player 来源、choice/end/beat 跳过）、`MergeIndex`/`buildMergeIndex`（L182-202，interaction_id → player_input/player_dialogue 双视图索引）、`attemptKeyId`（L209-218，line_id 优先 → interaction_id → 内容兜底）、`projectEvents`（L224-265，三入口共用管道：projectOne → player 双视图合并（input 被 dialogue 合并、dialogue 链接 input 的 eventRef）→ eventRef 落章）、`renderOneProjectedEvent`（L325-346）。

### 3.14 src/story/interaction-policy.ts

#### `InteractionPolicyState` — src/story/interaction-policy.ts:14-16
`previousModes: InteractionMode[]`（连续 input 计数依据）。
#### `InteractionPolicyResult` — :18-21
`{ accepted, reason? }`。
#### `InteractionPolicy` — :49-143
运行时策略层（防御 types.ts schema 不变量被未来 schema 变更绕过）。`validate(interaction, state, modeAllowList?)`（L57-142）按 §8.3 顺序七步：① mode ∈ allowed_modes；1b. M4.3 相位门（导演 formModes 收窄：allowList ∩ allowed_modes）；② choice/hybrid 选项数在 [min,max]；③ 选项 id 唯一；④ input.max_length ≤ 配置上限；⑤ 连续纯 input 不超限（choice/hybrid 中断计数）；⑥ choice 不得携带 input 字段；⑦ input 不得携带 options 字段。旧式 choice 归一化为 mode "choice" 同组检查。调用方：game.ts:105（InteractionPolicy 实例化）；interaction-policy.test.ts。

**内部辅助**：`PolicyCandidate`（L24-29）、`toCandidate`（L35-47，归一化视图，保留字段在场性供 ⑥⑦ 检测 schema 外多/缺字段）。

### 3.15 src/story/reconcile.ts

#### `reconcileStoryState(previous, committed, options?): StoryState` — src/story/reconcile.ts:49-115
确定性投影（§80-81），纯函数、增量调用、无变化返回原引用。步骤：① 遍历已提交事件：dialogue/narration 的 stage cue——background cue 更新 scene.location、character_patch cue 增 characters 键（经 trackableCharacterId 幻影过滤）；② dialogue 的 characterId 入 characters；③ recentLines 收集，末 3 条拼接 ≤300 字为 recent_summary；④ 三者皆未变则返回 previous。knownCharacterIds 过滤幻影发言者（坏行如 `@6ch raspberry` 不回流 prompt，2026-09-17 会话审计移植）。调用方：game.ts:107；dynamic-character-e2e.test.ts:33。

**内部辅助**：`isBackgroundCue`（L20-25）、`isCharacterPatchCue`（L27-32）、`trackableCharacterId`（L41-47）。

### 3.16 src/story/state.ts

#### `createInitialState(overrides?): StoryState` — src/story/state.ts:19-39
空白初始态（prologue/unknown 场景 + "The story has just begun."）。调用方：game.ts:118、confluence-judge-adapter.ts:20、confluence-judge-adapter.test.ts:11、protocol-card-wiring.test.ts:22、actor-briefing.test.ts:20、run-graph-confluence.test.ts:17、run-graph-coordinator*.test.ts、game-graph-restore.test.ts:11、game.test.ts:14、llm.test.ts:27、reconcile.test.ts:2。
#### `recapDataBlock(recentSummary): string` — :48-50
梗概结构化数据块（单行 JSON，kind=recap）——防玩家文本二阶注入（C6 §5.3，port 自 campus 05f3772）。调用方：summarizeState:93。
#### `summarizeState(state): string` — :60-96
LLM 面状态摘要：[Scene] 段 + [已记录人物状态]（累计状态非在场名单；幻影 id `/[\s@]/` 过滤）+ [Recent] recapDataBlock。调用方：context-builder.ts:16,370、confluence-judge-adapter.ts:20。

## 4. 域内数据流（一段新剧情提交的完整链路）

1. **玩家解决交互 → 开边**：game.ts:1697/1704 `graph.beginEdge({kind, text})` → `beginEdgeUnsafe`（run-graph-coordinator.ts:542）：状态机校验 → 同选项快进匹配（既有出边 kind+text 严格相等则 hydrateFromCursor 返回 fast_forward，跳过生成）→ 否则开放 `OpenEdge`。
2. **生成事件逐条提交**：game.ts:1723 `graph.appendEdgeEvents([event])` → `appendEdgeEventsUnsafe` 追加进边负载并累计 stats；同一批已提交事件并行走 `reconcileStoryState`（reconcile.ts:49）确定性更新 StoryState 的 location/characters/recent_summary。
3. **段落终止为 interaction → 决策落盘 + 汇流调度**：game.ts:1087 `graph.openDecision({modelSceneId, form: formSnapshotFromInteraction(event), moment: currentMoment()})` → `openDecisionUnsafe`：ensureSceneNode（场景节点世界级稳定）→ `toStateSnapshot(moment)`（walk.ts:12）入口快照 → putDecision → `migrateOutlineForScene`（大纲确定性迁移：realize 上一前沿 act、activate 新前沿、outlineRef 回写场景节点）→ `checker.indexDecision` → **收束前一条边**（putEdge，endState = 本次入口快照）→ saveCursor。随后 `checker.schedule`（后台汇流）+ `void maintainOutlineQuietly`（后台大纲维护）。
4. **后台汇流判定**：`ConfluenceChecker.schedule` → `runCheck`（互斥链外）：hydrateEndStateIndex → extractEndStateKey → 身份契约闸门（dslProtocolVersion + rosterRevision）+ prescreenScore 预筛 → `judge.judge`（LLM）→ 命中则 `enqueue(applyMatch)`：入边改指既有节点 + ConfluenceEvidence 内联、孤儿出边全部改源、游标前移、孤儿出索引。
5. **结局收束**：end 事件 → game.ts:1794 `graph.reachEnding` → `reachEndingUnsafe`：putEnding + 收束边（to: ending）+ putRun(endedAt/ending) + clearCursor + `stats.recordSettlement`（倒序找最近结局边 + pickLatestInEdge 回溯 traversed）。
6. **恢复/回放**：`restoreOrCreateRun` → `hydrateFromCursor`：discardOrphanPayloads → 逐节点 `pickLatestInEdge` 回放 readPayload 成 pathEvents → `upcastPathEventsForReplay`（旧对白身份内存升级）→ RestorePoint{decision, pathEvents, nextSeq, turnFloor}。Game 侧 `startRestoredSegment`（game.ts:563）用 `interactionFromFormSnapshot` 重铸表单、`memoryStateFromDigest` 重建记忆、storyState/visualState 从入口快照还原。
7. **上下文构建（下一轮生成）**：openai-compatible-generator.ts 构造请求时 `buildSystemContext`（静态）+ `buildDslUserPrompt`：剧情历史 = `serializeStoryContext` → `projectWriterHistory`/`projectEvents`（身份稳定投影：characterId + 发射时刻名牌 + event:<seq>/attempt 引用 + player 双视图合并）→ JSONL；故事状态 = `summarizeState`；舞台 = `serializeVisualContext`；cast = `renderCastSection`；记忆证据线（memory-consolidator/memory-validator）走 `projectMemoryEvidence`。
8. **玩家查看图**：GET /api/graph（entrypoints/web.ts:112-128）→ `buildGraphView`（三层脱敏过滤 + D8 分组）/ `buildSettlementView` / `buildGalleryView`。

## 5. 跨域接口

**本域依赖（import 的域外模块，Grep 核实）**：
- src/schema.ts：StoredEvent/StoryContextEvent/InteractionEvent/ChoiceEvent/EndEvent（事件契约门面，其本身再导出本域 story/types）。
- core/ports/*：run-graph-port（RuntimeMoment/RestorePoint/RunResume/BeginEdgeResult/EdgeChoice/RunGraphPort）、graph-store-port、confluence-judge-port、diagnostic-sink、clock-port、canon-store-port、stats-store-port、review-store-port、identity-snapshot-port（GraphIdentityContext/SessionMigrationReport/SNAPSHOT_IDENTITY_SCHEMA_VERSION）、outline-store-port（OutlineStorePort/OutlineOp）、story-generator-port（GenerationIdentity）。
- core/narrative/memory-types（digest 元素 schema）、core/presentation/types（VisualState）、core/characters/types + legacy-identity（身份键/名牌/registry）、core/protocol/gal-dsl/types（AnyStreamedGroup/SegmentEndStatus）、core/outline/types（OutlineNode）、core/assets/types（ModelAssetCatalog）。
- application/outline/outline-writer（OutlineMaintainerPort）。
- **adapters/storage/identity-upcaster（upcastLegacyEvents）**——application/graph → adapters 的反向依赖（见 §7）。
- config.ts（AuthorConfig/InteractionPolicyConfig）、prompts.ts（PromptBundle）、node:fs/promises + node:path（graph-view 读 ending-report.json）。

**被依赖（域外消费方）**：
- bootstrap/create-runtime-application.ts:19,270 → RunGraphCoordinator（唯一生产装配点）。
- game.ts → RunGraphPort 九个方法调用（restoreOrCreateRun:419、retraceFrom:253、beginEdge:1697/1704、appendEdgeEvents:1723、openDecision:1087、reachEnding:1794、currentOutlineRevision:1749、location:407）；formSnapshotFromInteraction:1089、interactionFromFormSnapshot:567、InteractionPolicy、reconcileStoryState、cloneCharacterRuntimeState、createInitialState、EMPTY_MEMORY_DIGEST、MemoryDigest/SnapshotIdentityState 类型。
- entrypoints/web.ts:22,112,119,128 → buildGraphView/buildSettlementView/buildGalleryView；hosts/local-web/local-web-host.ts:78 → GraphView 类型。
- adapters/storage/game-graph-store.ts → snapshot-upcast（readSnapshotVersion:376/assertSupportedSnapshotVersion:381/upcastSnapshotV3ToV4:399）、ids（GAME_STORAGE_LAYOUT/decisionSnapshotPath/edgePayloadPath/rosterBlobPath）、types（全部 schemas + SNAPSHOT_VERSION）；canon/outline/stats/music-theme/composer-session 各 store → GAME_STORAGE_LAYOUT。
- adapters/llm/openai-compatible-generator.ts → buildSystemContext/serializeStoryContext(Legacy)/buildDslUserPrompt + GenerationEnvelope/StoryState；confluence-judge-adapter.ts → serializeVisualContext/summarizeState/StateSnapshot；narrative-consolidator-adapter.ts → serializeStoryContextLegacy/projectMemoryEvidence/renderProjectedEvents/ProjectedEvent；stored-event.ts → Dialogue/NarrationDraftEventSchema。
- application/narrative/{memory-consolidator,memory-validator}.ts → projectMemoryEvidence/ProjectedEvent；narrative-director-service.ts → memoryDigestFromState/memoryStateFromDigest/MemoryDigest；application/outline/outline-writer.ts → MemoryDigest；application/director/director-service.ts → serializeStoryContextLegacy。
- runtime/branch-manager.ts → BranchCandidate/BranchStatus/GeneratedEvent；runtime/interaction-driver.ts → InputSpec/StoryState；shared/wire/schemas.ts → CharacterDialogueEventSchema。
- 测试基建：test-helpers.ts（MemoryRunGraph 实现 RunGraphPort）、game-test-kit.ts、character-contract.test.ts、llm.test.ts、actor-briefing.test.ts 等。

## 6. 测试覆盖

| 测试文件 | 覆盖的符号/行为 |
|---|---|
| src/application/graph/run-graph-confluence.test.ts (597) | ConfluenceChecker/RunGraphCoordinator 汇流全链路：跨周目改绑+凭据+游标前移、无匹配不动图、滞后判定出边改源、开放边内存改挂、M2.4 预筛排除异键节点（judge 调用断言）、judge 失败仅告警、周目完结守卫、跨场景汇流、M3 身份契约双闸门（roster revision / 协议版本） |
| src/application/graph/run-graph-coordinator.test.ts (443) | 开局段不入图+beginEdge 前置抛错、完整生命周期（决策→边 stats→游标随行）、reachEnding 四件套、无决策直落结局、restore 三态（fresh/active 水合 seq/turn 地板/ended 文本回收）、多边路径按剧情序回放、孤儿 payload 删除、同结局 id 取最近周目文本、restart 弃局记账+世界 max seq 播种 |
| src/story/types.test.ts (455) | 类型构造性（InteractionMode/InputSpec/五 kind/StoryState/GenerationEnvelope/BranchCandidate 六态）、InteractionEventSchema 全量校验（合法 choice、input_bridge 拒绝、空 prompt、未知 mode、选项 1/6 个、id 重复/大小写/空白、choice 带 input 拒绝）、StoryStateSchema、BranchCandidateSchema |
| src/story/event-projection.test.ts (449) | projectWriterHistory（event:<seq>/稳定 characterId/R01 改名向量/attempt 引用/legacy 唯一命中与 unresolved/player 双视图去重/孤立 input 保留/narration 不伪造 id/机器记录跳过）、projectMemoryEvidence（只收已提交、排除 unresolved、玩家合并）、projectRecapSource（unresolved 带标记保留、80 字截断）、renderProjectedEvents（逐行 JSON、键序、不破行） |
| src/story/context-builder.test.ts (708) | buildSystemContext（五段构成/动态状态不入）、buildDslUserPrompt（D9 稳定→易变排序、无便签省略）、C1/R01 改名身份向量、cast 段（空允许 cast「仅旁白」、名牌覆盖、任务头协议/身份版本行、cast 段恰一次）、视觉段（visible 真值、identity 在场不列不在场）、serializeModelAssetCatalog roster 去重三例 |
| （同域其他）run-graph-coordinator-outline.test.ts (169) | M3.4 大纲确定性迁移（activate/realize/前沿推进） |
| （同域其他）run-graph-retrace.test.ts (158) | M5.3 retrace + 同选项快进 |
| （同域其他）run-graph-gc.test.ts (147) | M5.6 collectGarbage（保护集/级联回收/幂等） |
| （同域其他）graph-view.test.ts (143) / settlement-view.test.ts (119) | buildGraphView 脱敏与分组；结算/图鉴视图 |
| （同域其他）core/graph/types.test.ts (292) / snapshot-upcast.test.ts (253) / memory-digest.test.ts (129) / ids.test.ts (56) | 图契约 schema 不变量、v3→v4 升级与版本闸门、digest 往返/失败区间、id 规则与路径函数 |
| （同域其他）story/reconcile.test.ts (79) / state.test.ts (186) / interaction-policy.test.ts (221) / performance-schema.test.ts (170) | reconcile 投影规则、初始态/摘要、七步策略+相位门、performance 容错 |

覆盖缺口（事实）：walk.ts 无专属测试文件（经协调器/汇流测试间接覆盖）；testing.ts 为夹具无测试；ConfluenceCheckerDeps 单独无测试（经协调器集成测试覆盖）。

## 7. 重构关注点（事实清单）

1. `src/application/graph/run-graph-coordinator.ts:25` — `import { upcastLegacyEvents } from "../../adapters/storage/identity-upcaster.js"`：应用层（L2）直接依赖适配层（L3），方向反了；应上移为 port。
2. `src/core/graph/types.ts:15` 与 `src/core/ports/run-graph-port.ts:11`、`src/core/ports/story-generator-port.ts:20` — core 层 import `../../story/types.js`：story 目录不在 core/ 内，但其 types 事实上被 core 与 ports 依赖（L0/L1 地位），目录层级与依赖方向不一致。
3. `src/application/graph/run-graph-coordinator.ts`（929 行）— 单类承担 ≥9 类职责：周目状态机、恢复水合、GC、大纲确定性迁移、后台 LLM 维护、canon 加载、结算统计、路径事件身份升级、场景节点缓存；文件内含 M1.1–M5.6 多个里程碑叠加的历史层。
4. 「取最近指向某结局 id 的边」规则在 3 处重复实现：`run-graph-coordinator.ts:524-536`（endingTextOf 倒序扫描）、`run-graph-coordinator.ts:874-876`（结算统计 reverse().find）、`graph-view.ts:343-345`（buildSettlementView reverse().find）——运行时 ending_N 跨周目易重号是共同根因（各自注释自述）。
5. `src/application/graph/confluence-checker.ts:125,184,281` — 诊断日志 component 名硬编码字符串 `"RunGraphCoordinator"`（拆出后未改名）；对协调器内部状态的访问全靠 ConfluenceCheckerDeps 回调（L55-72），边界依赖隐式契约。
6. `src/application/graph/graph-view.ts:356-369` — buildSettlementView 直接 `readFile` 读 `<sessionsDir>/<sessionId>/ending-report.json`：应用层视图绕过 store port 做文件 IO。
7. `src/story/context-builder.ts` — legacy 双轨并存（serializeStoryContextLegacy 与 serializeStoryContext，C5 冻结）；同一文件混装 system prompt、user prompt 装配、visual/asset/catalog/cast 五类序列化（9 个导出/409 行）。
8. `src/story/interaction-policy.ts:57-142` — validate 七步手写复刻 `types.ts` InteractionEventSchema 的结构约束（选项数/唯一 id/字段互斥），同一不变量两处维护（注释自述「防 schema 变更静默绕过」）。
9. `src/story/types.ts`（448 行）— 一个文件同时是 LLM 生成契约、玩家交互契约、图快照内嵌 schema（StoryStateSchema 被 core/graph/types.ts 引用）三类契约源，且被 src/schema.ts 门面大量再导出；改动波及面全项目最大。
10. `src/application/graph/run-graph-coordinator.ts:608` — `void this.maintainOutlineQuietly(input)` fire-and-forget，仅靠 `maintenanceRunning` 布尔单飞（L123）防并发，无队列/退避。
11. `src/core/graph/walk.ts:3-5` — 注释自述下沉 core 的动机是「避免两个应用层模块互相依赖」：说明 application/graph 内聚度不足时的结构性妥协。
12. `src/application/graph/confluence-checker.ts:87,102` — endStateIndex 为 null 时 indexDecision/deindexDecision 静默 no-op；索引只增不减（除改绑孤儿出索引），无失效/重建机制，依赖「快照只读」假设。
13. `src/core/graph/testing.ts` — 名为生产文件（core/graph/testing.ts，非 .test.ts）但仅供测试导入；在模块清单/打包中易被误当运行时代码。

## 8. 建议层级定位（对应 L0–L6 框架）

- **L1 核心领域**：core/graph 全部 7 文件（纯 schema/纯函数，无 IO）+ story 的 types.ts、reconcile.ts、state.ts、event-projection.ts、interaction-policy.ts（同为纯类型/纯函数领域规则）。
- **L2 应用服务**：application/graph 三文件（run-graph-coordinator/confluence-checker/graph-view——协调器与汇流是典型应用服务；graph-view 是读侧视图装配，但其直接 readFile 应改走 port）。
- **异议/说明**：story/context-builder.ts 是 prompt 序列化，消费方在 adapters/llm（L3），但其自身无 IO、纯字符串装配，介于 L1/L2 之间；建议与 openai-compatible-generator 的分工一并重划（序列化归 core/story，装配归 adapter）。story 目录现状横跨「领域内核」与「LLM 序列化」两类职责，且 story/types 被 core 依赖（§7 第 2 条），重构时宜把 story/types 拆为 L0 契约层或并入 core。

## 附A · 设计评注（2026-10-25 复核轮——观察与可能方向，非约束）

1. **汇流行走 visited 环保护**（run-graph-coordinator.ts:335）：现状靠运行时守卫防环。设计评注：另一种形态是让汇流改绑在构造上保证无环，守卫降为断言。
2. **同结局"最新文本胜"**：结算边 `[...edges].reverse().find(...)`（run-graph-coordinator.ts）实现的是"最近写入的同终点边胜出"——多周目重抵同一结局时玩家看到最新一次的结局文本（与 `endingTextOf` 一致）。语义与 reverse 扫描这个实现可分开评价。
3. **汇流孤儿出边改绑**（confluence-checker）：新节点既有出边随迁 re-hook（`putEdge({...outEdge, from: candidate})`）——缺失时图视图出现幽灵分叉。
4. **fresh 周目 seq 从世界最大值播种**（game.ts:452-454，M2.1 决议）：同世界新 root 周目与既有边 seq 不重叠；其正确性依赖 10 域的 ENOENT-only 读判据（10 附A）。
