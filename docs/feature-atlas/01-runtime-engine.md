# 运行时引擎域（run loop 与交互运行时）

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：20 文件 / 5417 行（生产代码，不含测试）｜导出符号 72 个（含 status.ts 的 5 个再导出类型）
>
> 快照：D:/coding/lgp-main-atlas（只读）。行号均为快照中 Read 实测行号。

## 1. 域职责与边界

**解决什么问题**：把 LLM 流式产出的 DSL 事件组（AnyStreamedGroup）驱动的剧情「段（ActiveSegment）」按序播放给玩家；在 choice / input / hybrid 交互点暂停等待玩家命令；在玩家不可见的后台并行做分支预取、输入桥接预取与低水位续写；并把每一次玩家决策落入剧情图（RunGraphPort）以便存档/恢复/回溯。对宿主只暴露两个面：`dispatch(RuntimeCommand)`（进）与 `subscribe(RuntimeOutput)`（出）。

**游戏主循环在哪、如何驱动**：`Game.run()`（`src/game.ts:403-555`）。完全事件驱动（无定时器轮询）：
1. 入口恢复判定——`prepareRetrace` 备好的恢复点 / `graph.restoreOrCreateRun`（有档续档、完结补结局、无档新局）；
2. 首段播放 `consumeActiveSegment`：从段队列 `AsyncEventQueue.next()` 逐事件消费（beat→舞台、playable→等 advance、interaction→交互驱动、end→收束）；
3. 交互结果（ChoiceOutcome / BufferOutcome / FastForwardOutcome / EndOutcome）回到 `run()` 的 while 循环：选中分支的 preview 入正式缓冲并边播边由 `prepareContinuationAfterSelection` 接管/新开下一段；
4. `@end ... buffer` 干净收束 → 低水位续写分支（`pendingRefillSegment` 接管或现场启动）；
5. 同选项快进（fast_forward）→ 零生成，直接 `startRestoredSegment` 恢复后继节点表单。

**与相邻域的分界**：
- 文本生成执行在 adapters/llm（`openai-compatible-generator` 实现 StoryGeneratorPort）；本域只持有 port 并发请求（generateOpening / generateContinuation / generateBranchPrefetch / generateInputBridge / generateInputResponse）。
- 剧情图持久化在 core/ports/run-graph-port（RunGraphPort），实现在 adapters/storage；本域在决策点 `openDecision`、玩家事件 `beginEdge`/`appendEdgeEvents`、结局 `reachEnding`。
- 导演/记忆服务（application/director、narrativeDirector port）经构造注入；注意 `game.ts:119-120` 直接 import 了 `application/director/director-service`（类型）与 `actor-briefing`（函数）——层次穿透（见 §7）。
- story/（InteractionPolicy、reconcileStoryState、createInitialState）是被本域调用的纯领域逻辑。
- 宿主装配在 bootstrap/`create-runtime-application.ts`（new Game）、apps/cli 与 hosts/local-web（把 Game 包装成 CLI 循环 / WebSocket）。

**src/game.ts 的整体结构**（全仓最大生产文件，1983 行，单类 `Game` 占 178-1983 约 1806 行）。它至少同时承担 10 类职责：
1. 会话生命周期与图恢复/回溯（`run` / `prepareRetrace` / `startRestoredSegment` / `resumeRestoredInteraction` / `concludeRun`）；
2. 段生成泵与失败修复（`startActiveSegment` / `consumeActiveSegment` / `maybeStartEarlyRepair`，含 fail-fast 修复与递归 repairBudget）；
3. 低水位缓冲策略（`reconcileTextBuffer` / `waitForStartThreshold`，§73-§76）；
4. DSL 组编译路由与双轨状态（`compileGroup` / `applyCompiledGroupV2` / `compileRoutedGroup` / `materializeDslGroups` / `mergeBeatCues`；视觉 tail/rendered 双态 + 名牌 characterState/branch* 副本）；
5. 命令队列与交互作用域（`dispatch` / `waitForCommand` / `waitForInteractionCommand` / `isStaleInteractionCommand`，§10.2 陈旧命令门）；
6. 事件记账与 StoryState 投影调度（`record` / `recordModelEvent` / `scheduleReconcile` microtask 批量 reconcile + 导演 directive 触发）；
7. 生成身份/快照身份/导演剪报（`generationIdentity` / `momentIdentity` / `currentMoment` / `makeBriefing` / `rosterDefaultCast` / `effectiveDslProtocolVersion`）；
8. 逐行播放消费（`consumePlayableEvent` / `waitForAdvance` / `advanceBufferedEvent` / `applyPlayableStage` / `openInteractionStage`）；
9. 可观测中转（`getMetrics` / `updateBufferStatus` / `runTrackedJob` / `emit`）；
10. 实现 `InteractionHost`（runtime/interaction-driver.ts:73-164）——为 M4.5 拆分留的「驱动接缝」，20+ 个 `@internal` 成员被 runtime 子模块直接读写。

**域内子层次**（实际代码形态）：`core/runtime` + `core/interaction` 是可被 core/shared 复用的最小契约（命令/输出/错误/队列/输入会话）；`interaction/input-engine` 是无依赖的两阶段输入状态机；`runtime/*` 是引擎机制层（调度/预取/缓冲/指标/状态）；`game.ts` 是把它们与 ports 装配起来的编排器。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| src/game.ts | 1983 | Game 编排器：run loop、段生命周期、DSL 路由、图恢复、身份/剪报 | 2 | game.test.ts、game-interactions.test.ts、game-input.test.ts、game-dsl.test.ts、game-dsl-v2.test.ts、game-branch-selection.test.ts、game-graph-restore.test.ts、game-defense-beat.test.ts、game-generation-identity.test.ts、game-metrics.test.ts |
| src/runtime/branch-manager.ts | 181 | BranchPrefetchGroup 之上的候选语义层（BranchCandidate 生命周期） | 1 | branch-manager.test.ts |
| src/runtime/dsl-group-compiler.ts | 89 | v1 EventGroupDraft → 可播放事件/交互/beat 的编译（冻结路径） | 2 | game-dsl.test.ts（间接） |
| src/runtime/generation-scheduler.ts | 114 | 活动路径生成任务单槽调度（idle/streaming/canceling） | 3 | generation-scheduler.test.ts |
| src/runtime/interaction-choice.ts | 350 | choice 交互自由函数：表单打开/选支收养/预取接线/玩家选择记账 | 5 | game-interactions.test.ts、game-branch-selection.test.ts |
| src/runtime/interaction-driver.ts | 583 | InteractionHost 契约 + InteractionDriver 门面（hybrid 编排 + live 消费簇） | 2 | game-interactions.test.ts、game-input.test.ts |
| src/runtime/interaction-input.ts | 514 | input 交互自由函数：两阶段提交/桥接预取/NPC 回应流/记账 | 5 | game-input.test.ts、game-dsl.test.ts |
| src/runtime/metrics.ts | 404 | 延迟/成本/预取命中率/输入体验指标收集与快照 | 11 | metrics.test.ts |
| src/runtime/playback-buffer.ts | 127 | 游标式播放缓冲 + changed() 变更信号 | 1 | playback-buffer.test.ts |
| src/runtime/prefetch.ts | 290 | BranchPrefetchGroup：并发受控的分支预取管线（raw 层） | 3 | prefetch.test.ts |
| src/runtime/segment-types.ts | 110 | 段生命周期纯类型（ActiveSegment/SegmentOutcome 等） | 10 | （经 game-* 测试间接） |
| src/runtime/status.ts | 120 | RuntimeStatus 可变状态枢纽（phase/jobs/branches/media） | 6（含再导出 5） | status.test.ts |
| src/interaction/input-engine.ts | 158 | 自由输入两阶段提交状态机（editing→preview→committed/cancelled） | 3 | input-engine.test.ts |
| src/core/runtime/async-event-queue.ts | 47 | 可移植 async FIFO 队列（AsyncIterable） | 1 | （经各测试间接） |
| src/core/runtime/errors.ts | 42 | 运行时公共错误契约（shutdown/restart/retrace/policy） | 4 | （经 game-* 与 hosts 测试间接） |
| src/core/runtime/runtime-command.ts | 38 | RuntimeCommand 判别联合（宿主→运行时） | 1 | （间接） |
| src/core/runtime/runtime-output.ts | 65 | RuntimeOutput 判别联合（运行时→宿主）+ StagePresentationDelta | 3 | （间接） |
| src/core/runtime/status-types.ts | 45 | 状态快照纯数据形状（core 侧，防反向依赖） | 5 | （经 status.test.ts 间接） |
| src/core/interaction/input-bridge.ts | 34 | 输入桥接旁白缓存（store/peek/take/discard） | 1 | input-bridge.test.ts |
| src/core/interaction/input-session.ts | 123 | 输入回应流会话（staging 状态机 + 订阅 + done） | 3 | （经 game-input.test.ts 间接） |

合计：20 文件 / 5417 行 / 72 个导出符号。

## 3. 函数级明细

### src/game.ts（1983 行）

模块级内部常量/函数：
- `MAX_INTERACTION_MODE_HISTORY = 8`（L158）：§8.4 交互模式历史上限。
- `withoutRuntimeLabel(state, characterId)`（L165-176）：名牌复位纯函数（v2 labelOps reset 分支），不导出。

#### `GamePorts`（interface） — `src/game.ts:131-155`
宿主注入的 ports 集合：`graph: RunGraphPort`、`clock`、`ids`、可选 `sessionId` / `diagnostics` / `narrativeDirector` / `director`（M4.1 场景导演）、`runMode: "resume" | "restart"`（M1.5）、`characterRegistry`（C2 角色注册表，缺席 = legacy 会话）。被 bootstrap/create-runtime-application.ts（构造 Game）、game-test-kit.ts、hosts/local-web/test-fakes.ts 引用。

#### `Game implements InteractionHost`（class） — `src/game.ts:178-1983`
编排器本体。构造（L321-365）：装配 InteractionDriver、Metrics、图/时钟/ids/diagnostics、InteractionPolicy、展示 registry/defaults/reduce、dslCompiler 依赖束，并订阅 status → emit `status_changed`。关键方法（公开/内部混合，按职责分组）：

**会话与恢复**
- `currentSessionId` getter（L192-194）：结算页定位 ending-report 用。
- `currentSceneId` getter（L243-245）：读 `storyState.scene.id`。
- `prepareRetrace(decisionId)`（L252-254）：宿主回溯入口；`graph.retraceFrom` 备好 `pendingRestore`，下次 `run()` 走恢复路径。调用方：hosts/local-web/local-web-host.ts（retrace 命令处理）。
- `run()`（L403-555）：主循环。步骤：① emit `session_started`；② 恢复判定（pendingRestore / restoreOrCreateRun；ended → 补发结局即返回）；③ active → startRestoredSegment + resumeRestoredInteraction，fresh → seq 播种 + opening 段；④ while 循环消费 outcome：fast_forward → 恢复表单；buffer → 低水位续写（接管 pendingRefillSegment 或现场启动）；choice → preview 入缓冲 + prepareContinuationAfterSelection 后台并行 + 按结果走 consumeLiveSelection / consumeLiveInputResponse / consumePlayableEvents，再 await continuationPromise 并 consumeActiveSegment 进入下一轮。
- `startRestoredSegment(restore)`（L565-634）：入口快照重建运行时——storyState/tailVisualState/renderedVisualState 直接还原、narrativeDirector restoreFromDigest + observeCommitted 全路径重放、seq/turn 播种、名牌状态从快照身份块还原并清分支副本、协议版本漂移诊断（L592-602）、迁移报告透出（L604-614）、构造恢复段（terminal=恢复表单，branchManager 就绪）。
- `resumeRestoredInteraction(segment)`（L637-683）：恢复表单决策等待——choice/hybrid/input 三路都走与正常打开完全相同的 interactionDriver 处理函数；同选项快进透传 fast_forward。
- `concludeRun(ending)`（L1792-1795）：`graph.reachEnding` + 末态快照内联。

**段生命周期与修复**
- `startActiveSegment(kind, turn, history, prefetchedEvents, repairReason?)`（L790-919）：段工厂。步骤：① 建段（queue/taskId/初始字段）；② `generationScheduler.startActivePath` 取 AbortController；③ `runTrackedJob` 内按 kind 调 generateOpening/generateContinuation；④ 泵（for await genHandle.events → handleDslGroup）+ envelope.segmentEnd（onSegmentEnd）；⑤ 失败路径同步置 `segment.failed` 并排空泵再抛（I1）；⑥ finally 关队列、释放调度器；⑦ 出生即挂 done.catch（工厂不变量，防 unhandledRejection）；⑧ buffer 收束时立即 reconcileTextBuffer 预热续写（§75）。
- `consumeActiveSegment(segment, turn, priorContext, repairBudget?)`（L921-1133）：段消费循环。步骤：① `maybeStartEarlyRepair` 并行启动修复段；② 逐事件消费：beat → applyPlayableStage + emit `stage_beat_ready`；playable → 首条先 waitForStartThreshold 再 consumePlayableEvent；end → 记账 + concludeRun + emit `session_ended`；interaction → advanceBufferedEvent + recordModelEvent + `graph.openDecision`（决策节点 + 入口快照 + 游标推进）+ recordInteractionMode + 按 mode 分发 handleChoice / handleHybridInteraction / handleInteractionInput，快进命中即返回 fast_forward；③ 队列读空：buffer 收束 → 返回 buffer；否则进入修复路径——无 playable 且非策略拒绝 → fatal 抛出；repairBudget 耗尽仅告警；discardAll 孤儿预取、无 earlyRepair 时清 playbackBuffer、剥离 terminal 事件构造 fullContext，收养 earlyRepair 或现场启动修复段并递归 consumeActiveSegment（budget-1）。
- `maybeStartEarlyRepair(segment, priorContext)`（L1146-1181）：fail-fast 修复。守卫：已有 earlyRepair / 干净收束 / terminal 已入队（F1）/ fatal 无前缀 / startActiveSegment 抛错（调度槽被占）→ 回退消费循环现场启动。

**低水位缓冲**
- `reconcileTextBuffer(nextTurn)`（L1544-1561）：§75 不变量——pendingRefill 为空、无活动路径任务、无未消费交互、剩余文本 ≤ refill_threshold_lines 才启动后台续写段。触发点：段 buffer 收束、每次 advance、run loop buffer 分支。
- `waitForStartThreshold(segment)`（L1567-1590）：§74 首句放行门——`Promise.race([settledOrDone, playbackBuffer.changed()])` 事件驱动等待达到 start_threshold_lines；段 settled 即放行。

**DSL 编译路由与双轨状态**
- `compileGroup(draft, baseState, turn)`（L1252-1263）：薄委托 `compileDslGroup`（InteractionHost 契约保留）。
- `applyCompiledGroupV2(group, baseState, labels, turn)`（L1273-1320，private）：v2 已编译组原子提交——prelude 用 reduce 折叠预测舞台尾部、labelOps 折叠预测名牌、主事件物化（dialogue 的 speaker = 编译时刻 displayLabel）。
- `compileRoutedGroup(draft, baseState, labels, turn)`（L1331-1348）：版本路由——组上有 `labelOps` 字段走 v2，否则 v1 冻结路径（nextLabels 原样奉还）。被 interaction-choice/interaction-input 的预取泵与回应泵调用。
- `handleDslGroup(segment, history, turn, draft)`（L1356-1418，private）：流式组入口。步骤：① compileRoutedGroup 编译并推进 tailVisualState/characterState；② terminal 已存在则整组丢弃（§50 契约边界）；③ playable → events+buffered+media+playbackBuffer+queue 四路登记；④ interaction → 先 assertInteractionPolicy 再入缓冲置 terminal、pendingInteractionStage 存 cue、input/hybrid 启动桥接预取、createBranchManagerForTerminal、cancelActivePath；⑤ beat → 仅入 queue（cue 在播放位生效）。
- `handleSegmentEnd(segment, status, turn)`（L1427-1446，private）：ending → 合成 EndEvent 入队列；buffer → 标记干净收束；interaction → 无事。
- `materializeDslGroups(groups, baseState, turn, labels)`（L1625-1672）：分支预取/输入回应路径的组级物化——链式折叠视觉与名牌状态，beat cue 经 pendingBeatCues 前置折叠进下一可播行，段尾 beat 仅告警。
- `mergeBeatCues(beatCues, playable)`（L1681-1689）：把 beat cue 前置进下一个可播行的 stage（campus c8cb600 语义）。
- `openInteractionStage(interactionId)`（L1452-1458）：表单打开时应用交互组 cue 到 rendered 态（幂等）。
- `applyPlayableStage(cues)`（L1461-1465，private）：可播行/beat 的 cue 应用到 rendered 态并返回 delta。
- `promoteBranchCharacterState(optionId)`（L1948-1954）：选中分支名牌副本转正，其余清空。

**命令与播放**
- `dispatch(command)`（L367-375）：命令入口（listener 里可安全调用）；陈旧交互命令门口丢弃，权威判定在 waitForCommand。
- `isStaleInteractionCommand(command)`（L383-391，private）：§10.2——select_choice/preview_input 比对 activeInteractionId、confirm/cancel 比对 activePreviewId。
- `subscribe(listener)`（L393-396）/ `emit(output)`（L1183-1185）：输出分发。
- `waitForCommand(predicate)`（L1193-1221）：扫 deferredCommands 取首个匹配（顺路丢陈旧）；否则 await commands.next()；shutdown/restart_session/retrace 抛对应错误；不匹配且非陈旧 → 挂 deferred。
- `waitForInteractionCommand(interactionId, acceptedTypes)`（L1229-1245）：交互作用域命令等待的窄化包装。
- `advanceBufferedEvent(event)`（L1467-1472）：playbackBuffer.advance() 并校验与事件流顺序一致，不一致抛错。
- `consumePlayableEvent(event, turn, segment?)`（L1474-1525）：单行播放。步骤：① advanceBufferedEvent；② choiceTimestamp → recordChoiceToNextLine；③ player_dialogue → recordPlayerDialogue，模型行 → recordModelEvent；bridge 行只播不记账；④ media.waitUntilReady；⑤ buffered/media/bridge 计数清理 + bridge cover 时长指标；⑥ 行级 stage → applyPlayableStage + emit `playback_ready`；⑦ waitForAdvance。
- `waitForAdvance(segment?)`（L1527-1537）：等 advance 命令；段已失败则跳过低水续写。
- `nextLineId()`（L1592-1594）/ `registerBuffered(events)`（L1596-1599）/ `updateBufferStatus()`（L1601-1605，private）：line_id 分配与缓冲状态上报。

**记账与投影**
- `record(event)`（L1691-1727）：事件正式提交。步骤：① push events；② player_choice/player_input → `graph.beginEdge`（命中既有出边 → seq 归还 + pendingFastForward + 返回 "fast_forwarded"）；③ player_input → `director.evaluateFreeInput` fire-and-forget 防守评估；④ `graph.appendEdgeEvents`；⑤ narrativeDirector.observeCommitted；⑥ scheduleReconcile。
- `recordModelEvent(event, turn)`（L1607-1617，private）：模型事件补 seq/turn/timestamp 后 record。
- `takePendingFastForward()`（L1730-1734）：驱动器提交路径上取走快进恢复点（一次）。
- `scheduleReconcile(event)`（L1807-1835，private）：§81 microtask 单飞批量 reconcileStoryState（knownCharacterIds 过滤幻影发言者）；场景边界变化 → director.triggerDirective（后台刷新 SceneDirective）。
- `knownCharacterIds()`（L1798-1804，private）：registry 缺席返回 undefined（不过滤）。

**身份与剪报**
- `currentMoment()`（L1742-1752，private）：决策入口/结局末态快照——storyState + renderedVisualState + memoryDigest + outlineRevision + momentIdentity。
- `momentIdentity()`（L1761-1789，private）：快照身份块（schemaVersion、dslProtocolVersion、roster scope/revision、characterLabels、cast）；legacy 会话显式记 "legacy"。
- `generationIdentity(branchOptionId?)`（L1910-1933）：生成请求身份四件套；分支请求取预测名牌副本；legacy 走 legacyGenerationIdentity。
- `effectiveDslProtocolVersion()`（L1942-1944）：`config.dsl?.protocol_version ?? 1`（loadConfig 缺省 2；窄测试兜底 1）。
- `rosterDefaultCast(registry)`（L1846-1855，private）：允许说话人 = roster NPC；场景参与者 = roster 全体（三处共用派生）。
- `directorSceneCast()`（L1863-1868，private）：导演场景名单，legacy 回退 v1 资产注册表 ID。
- `makeBrief(turn)`（L1870-1881，private）：MemoryProjection（eventSeq = this.seq - 1，不谎报前沿）。
- `makeBriefing(turn)`（L1888-1898）：MemoryProjection + SceneDirective → buildActorBriefing 剪报文本。

**交互策略与杂项**
- `assertInteractionPolicy(event)`（L765-776）：terminal 入缓冲前执行 InteractionPolicy.validate（含 M4.3 directive.formModes 相位门）；拒绝抛 InteractionPolicyViolationError → 进修复环。
- `recordInteractionMode(mode)`（L783-788）：§8.4 记录正式打开的交互模式（上限 8）。
- `getMetrics()`（L399-401）：metrics.snapshot()。
- `flush()`（L1960-1964）：关停时 narrativeDirector.flush 落盘。
- `runTrackedJob(id, label, task)`（L1967-1982，private）：status.setJob 的 running/ready/failed 包装。

内部辅助（非导出）：`withoutRuntimeLabel`（名牌复位）、私有字段簇（pendingReconcile/reconcileScheduled、recentInteractionModes、pendingRefillSegment、pendingFastForward、pendingRestore、activeSegmentTurn、deferredCommands、pendingInteractionStage、renderedVisualState、lastDirectiveSceneId 等）。

### src/runtime/segment-types.ts（110 行）

#### `ActiveSegment`（interface） — `src/runtime/segment-types.ts:13-45`
一个生成段的全生命周期状态：`turn`、`taskId`、`events`（模型事件）、`queue`（播放时间线 = 模型事件 + beat）、`done`、`branchManager`、`terminal`（契约边界）、`schedulerReleased`、`endStatus`（@end buffer/ending）、`failed`、`earlyRepair`（fail-fast 修复段槽）。被 game.ts 与 interaction-driver.ts 共用。
#### `ActiveSegmentKind`（type） — `:47`
`"opening" | "continuation"`。
#### `ChoiceOutcome`（interface） — `:49-61`
choice/input 提交后段结果：preview + 可选 liveSelection / liveResponse / fastForward（M5.3）。
#### `ChoiceSelection`（type） — `:63-66`
ChoiceOutcome 的 Pick（preview/liveSelection + fastForward）——handleChoice 的返回形状。
#### `InputCommitOutcome`（type） — `:73-81`
input 提交结果：`committed`（preview + 可选 liveResponse/fastForward）或 hybrid 专属 `canceled` 哨兵。
#### `LiveStreamLike`（interface） — `:84-88`
可直播消费流的结构契约（events/done/subscribe）。
#### `EndOutcome`（interface） — `:90-92`
`{ type: "end" }`。
#### `BufferOutcome`（interface） — `:98-101`
`@end buffer` 干净收束 → 低水位续写。
#### `FastForwardOutcome`（interface） — `:104-108`
M5.3 同选项快进：restore + nextTurn。
#### `SegmentOutcome`（type） — `:110`
ChoiceOutcome | EndOutcome | BufferOutcome | FastForwardOutcome——run 循环的驱动信号。

### src/runtime/interaction-driver.ts（583 行）

#### `InteractionHost`（interface） — `src/runtime/interaction-driver.ts:73-164`
InteractionDriver 簇对 Game 宿主的最小视图：约 30 个状态成员（status/metrics/clock/ids/config/generator/media/seq/activeInteractionId/activePreviewId/choiceTimestamp/inputConfirmAtMs/storyState/tailVisualState/events/bridgeBuffer/inputEngine/bridgeControllers/branchTailStates/branchCharacterStates/characterState/bridgeLineIds/responseLineIds/buffered/playbackBuffer/reduce/narrativeDirector）+ 14 个方法（emit/makeBriefing/generationIdentity/promoteBranchCharacterState/openInteractionStage/waitForCommand/waitForInteractionCommand/record/takePendingFastForward/nextLineId/materializeDslGroups/mergeBeatCues/compileRoutedGroup/registerBuffered/advanceBufferedEvent/consumePlayableEvent/assertInteractionPolicy/recordInteractionMode）。被 interaction-choice.ts / interaction-input.ts 以首参 `host` 消费；game.ts 的 `Game` 实现之。
#### `InteractionDriver`（class） — `:166-583`
构造仅存 host。成员：
- `resolveInteraction(interactionId, resolution)`（L169-174）：emit `interaction_resolved`。
- `createBranchManagerForTerminal(terminal, turn, context)`（L176-182）：委托 interaction-choice.ts 同名函数。
- `startBridgePrefetch(interaction, turn)`（L184-189）/ `cancelBridgePrefetch(interactionId)`（L191-193）：委托 interaction-input.ts。
- `recordPlayerChoice(option, turn)`（L195-200）/ `recordPlayerInput`（L202-208）/ `recordPlayerDialogue`（L210-212）：记账三委托。
- `handleChoice(choice, turn, branchManager, prefetchContext, interactionId?)`（L214-222）：委托 interaction-choice.handleChoice。
- `handleInteractionInput(interaction, turn, branchManager, initialText?)`（L224-231）：委托 interaction-input.handleInteractionInput。
- `handleHybridInteraction(interaction, turn, branchManager, prefetchContext)`（L244-417）：hybrid 编排（本体保留在此）。while 循环：打开交互作用域（select_choice + preview_input 双通道）→ preview_input → 丢弃选项预取 + handleInteractionInput；canceled → 重建 branchManager 再武装两路（§11.7）；select_choice → resolveInteraction + 丢弃 bridge + recordPlayerChoice + checkpoint + 快进检查 → 有 branchManager 走 adoptSelectedBranch，无则按需生成（on-demand-branch）+ materializeDslGroups 并直接转正尾部状态。
- `buildRuntimeInteraction(draft, turn)`（L419-450）：DslInteractionDraft → InteractionEvent（id = `interaction_${turn}`，选项 id = `${id}_opt_${index}`，input/hybrid 附加 InputSpec）。
- `consumePlayableEvents(events, turn, segment?)`（L452-458）：顺序 consumePlayableEvent。
- `consumeLiveSelection(initialEvents, selection, turn)`（L460-499）：已选分支直播消费——可播行达 branch_dialogue_lines 即 handoff() 交接正式续写；失败仅保留前缀并提示。
- `consumeLiveInputResponse(initialEvents, live, turn)`（L501-520）：确认后的回应流直播消费；underrun 记指标；结束 removeJob("input-response")。
- `consumeLiveStream(initialEvents, live, turn, onEvent?, onSynced?, onFirstWait?)`（L522-582）：直播流通用泵——subscribe 前先快照 live.events 关闭交接缝隙；新事件即时入 playbackBuffer/buffered/media + 私有 AsyncEventQueue；先播 initialEvents 再逐个消费迟到行；underrun 首等记 onFirstWait；返回 failure。

### src/runtime/interaction-choice.ts（350 行）

#### `createBranchManagerForTerminal(host, terminal, turn, context)` — `src/runtime/interaction-choice.ts:24-39`
choice/hybrid terminal → 合成 ChoiceEvent → createBranchManager；input 返回 null（§13.2 纯输入不预取分支）。
#### `handleChoice(host, choice, turn, branchManager, prefetchContext, interactionId?)` — `:41-117`
choice 表单全流程：setPhase → activeInteractionId 置作用域 → openInteractionStage + emit `interaction_opened` → waitForInteractionCommand(select_choice) → 校验选项 → emit `interaction_resolved` + 释放作用域 → choiceTimestamp → recordPlayerChoice → checkpoint("interaction_completed") → 快进检查（命中：discardAll + 清分支任务，返回空 preview + fastForward）→ adoptSelectedBranch → 清 branch:* 任务与 branches 视图。
#### `adoptSelectedBranch(host, selected, choice, turn, branchManager, prefetchContext)` — `:119-230`
选支收养：候选 ready/failed/discarded → selectCandidate（失败走重试）；queued/generating → selectCandidateLive（直播接管）。失败重试路径：先删除该分支的预测副本（branchTailStates/branchCharacterStates，防幽灵改名渗入重试，84a68ee finding 6）→ generateBranchPrefetch 重试 → materializeDslGroups 回写分支表 → media.registerCandidate；finally removeJob（重试自身失败也解除任务）。成功后：分支尾态转正 tailVisualState、promoteBranchCharacterState 转正名牌、无尾态时从 preview cue 派生、清分支表、media 激活 + registerActive + registerBuffered。
#### `createBranchManager(host, choice, turn, prefetchContext, interactionId?, source?)` — `:232-332`
预取接线：为每个选项 createCandidate；startPrefetch 的 generate 回调内——分支身份（generationIdentity(option.id)）→ generateBranchPrefetch → 泵逐组 compileRoutedGroup（分支局部 branchState/branchLabels 逐组折叠并即时落表 host.branchTailStates/branchCharacterStates，live 选择可在泵收尾前读到同步状态）→ beat cue 前置合并 → onEvent 逐行上报；done 拒绝时先排空泵再抛（防 unhandledRejection）；onReady → media.registerCandidate。
#### `recordPlayerChoice(host, option, turn)` — `:334-350`
构造 StoredPlayerChoiceEvent（seq/timestamp）→ host.record。

### src/runtime/interaction-input.ts（514 行）

#### `startBridgePrefetch(host, interaction, turn)` — `src/runtime/interaction-input.ts:25-83`
输入桥接旁白预取（可配置开关）：generateInputBridge → 收集 narration 组 → 物化 1-2 条（越界记 schema 失败并丢弃，§34 契约）→ bridgeLineIds 标记 + bridgeBuffer.store；任何失败仅 warn。
#### `cancelBridgePrefetch(host, interactionId)` — `:85-91`
abort 控制器并移除。
#### `handleInteractionInput(host, interaction, turn, branchManager, initialText?)` — `:93-330`
自由输入两阶段提交主流程（237 行 while 循环）。步骤：① 入口先 discardAll 分支预取（input 不用分支）；② 编辑态：重开表单（activeInteractionId + interaction_opened）→ 等待 preview_input → 截断 max_length；空白输入 continue 重开（边契约 text ≥ 1）；③ 预览态：InputEngine.startEditing/updateDraft/requestPreview → 建 InputResponseSession → startInputResponseGeneration 后台生成 → activePreviewId + emit `input_preview_opened` → require_preview_confirmation ? 等 confirm/cancel : 单 Enter 直提；④ cancel：abort 回应请求 + session.cancel + inputEngine.cancel + emit `input_preview_canceled`；hybrid 返回 `{type:"canceled"}` 哨兵，纯 input continue 重编辑；⑤ confirm：inputEngine.commit + responseSession.commit → emit `interaction_resolved(input)` → 释放两个作用域 → emit `input_committed` → bridgeBuffer.take + cancelBridgePrefetch → inputConfirmAtMs 指标；⑥ setTimeout(0) 排空微任务后分类：settled 且失败且无事件 → 修复请求（新 InputResponseSession）；未 settled → 直播晋升（promoted_live 指标）；⑦ recordPlayerInput → 快进检查（命中：abort 回应流与修复流，零生成返回）；⑧ 无 liveSession → await done 返回固定前缀 [playerDialogue, bridge, response]；有 → 返回 preview + liveResponse。
#### `recordPlayerInput(host, interactionId, text, turn)` — `:475-492`
构造 StoredPlayerInputEvent → host.record。
#### `recordPlayerDialogue(host, event, turn)` — `:494-508`
构造 StoredPlayerDialogueEvent → host.record。
内部辅助：`startInputResponseGeneration(host, interaction, turn, text, responseSession)`（L332-442，回应生成泵：generateInputResponse → 逐组 compileRoutedGroup 到回应局部 responseState/responseLabels → stageResponseEvent 入会话；done ok 先排空泵（I2 final burst）再转正 host.tailVisualState/characterState + markReady；失败 markFailed + status failed）；`stageResponseEvent(host, session, event)`（L444-458，追加回应事件 + confirm→首行指标）；`makePlayerDialogue(host, interactionId, text)`（L461-473，玩家台词事件 speaker="你"）；`countBufferedDialogues(host)`（L510-514）。

### src/runtime/branch-manager.ts（181 行）

#### `BranchManager`（class） — `src/runtime/branch-manager.ts:28-181`
BranchPrefetchGroup 之上的语义层。成员：
- `createCandidate(id, interactionId, source)`（L45-55）：注册 queued 候选。
- `startPrefetch(options)`（L64-93）：包装 generate/onEvent/onReady（状态迁移 generating/ready + 事件去重收集）→ new BranchPrefetchGroup + start → recordBranchRequested。
- `updateCandidateStatus(id, status, events?)`（L99-108）。
- `selectCandidate(optionId)`（L118-131）：await group.take；成功记 prefetch hit，失败标 failed + miss 并上抛。
- `selectCandidateLive(optionId)`（L134-140）：不等待的直播选择。
- `discardCandidate(id)`（L146-148）/ `discardAll()`（L154-163）：未选非失败候选置 discarded，cancelAll 整组。
- 读访问：`getCandidate`（L169-171）/ `getCandidates`（L173-175）/ `isActive`（L178-180）。
调用方：interaction-choice.ts（createBranchManager 全流程）、game.ts（startRestoredSegment/discardAll）。

### src/runtime/prefetch.ts（290 行）

#### `BranchPrefetchOptions`（interface） — `src/runtime/prefetch.ts:34-45`
choice + concurrency + status + generate(option, signal, onEvent) + 可选 onEvent/onReady。被 branch-manager.ts 包装使用。
#### `LiveBranchSelection`（interface） — `:47-56`
直播选择产物：branchId/taskId/controller/events/done/subscribe/handoff()。被 game.ts（prepareContinuationAfterSelection 收养）、interaction-driver.ts（consumeLiveSelection）、segment-types.ts 引用。
#### `BranchPrefetchGroup`（class） — `:58-290`
raw 预取管线。构造为每个选项建 BranchEntry（queued + AbortController + deferred）；`start()`（L85-89）触发 pump；`take(optionId)`（L91-103）——取消未选、queued 快速通道、await deferred；`selectLive(optionId)`（L110-121）——同 take 但返回 LiveBranchSelection；`cancelAll()`（L139-141）。私有：createLiveSelection（L123-137）、handoffEntry（L143-157，abort + 立即 resolve 已提交前缀）、pump（L159-167，并发槽填充）、startEntry（L169-240，状态迁移 + appendEvent 去重广播 + ready/failed/cancelled 三态收尾）、cancelUnselected/cancelEntry（L242-271，queued 直接拒绝 / running abort）、removeFromQueue（L273-276）、syncStatus（L278-289，setBranch 事件/对白计数）。
内部辅助：`Deferred`/`createDeferred`（L4-20，未选分支预挂 catch 防未处理拒绝）、`EntryState`（L22）、`BranchEntry`（L24-32）。

### src/runtime/generation-scheduler.ts（114 行）

#### `ActivePathTaskStatus`（type） — `src/runtime/generation-scheduler.ts:9`
`"idle" | "streaming" | "canceling"`。
#### `ActivePathTaskOwner`（type） — `:10`
`"active_path" | { type: "candidate_branch"; branchId: string }`。
#### `GenerationScheduler`（class） — `:12-114`
活动路径单槽调度。`hasActivePathTask`（L20-22）/ `getActivePathStatus`（L25-27）/ `getTaskId`（L30-32）/ `getOwner`（L35-37）；`startActivePath(taskId?)`（L45-57，非 idle 抛错并返回新 AbortController）；`adoptCandidateBranch(taskId, branchId, controller)`（L64-75，直播分支晋升，复用原控制器）；`completeActivePath(taskId?)`（L78-85，仅属主可释放）；`cancelActivePath()`（L93-98，置 canceling + abort）；`getSignal()`（L101-103）；`subscribe`（L106-109）+ 私有 `emit`（L111-113）。唯一生产调用方：game.ts（L232 持有、L728/734/735/812/882/1401/1546 调用）。

### src/runtime/playback-buffer.ts（127 行）

#### `PlaybackBuffer`（class） — `src/runtime/playback-buffer.ts:12-127`
游标式播放缓冲。`changed()`（L26-33，共享单 promise 的变更信号，事件驱动替代轮询）；私有 `fireChange`（L35-41）；`enqueue/enqueueMany`（L44-47/L50-54）；`advance()`（L57-63）；`peek()`（L66-68）；`countTextLinesAhead()`（L74-81，低水位判据）；`hasUnconsumedInteraction()`（L87-95，interaction/end 哨兵检测）；`hasEvents/pendingCount/totalCount/getPendingEvents`（L98-115）；`clear()`（L122-126）。调用方：game.ts（唯一生产使用方，多路 enqueue/advance/clear）。

### src/runtime/metrics.ts（404 行）

#### `LLMRequestCounts` — `:17-22`；`LLMTokenStats` — `:25-28`；`LLMLatencyStats` — `:31-36`；`PrefetchStats` — `:39-45`；`WasteStats` — `:48-53`；`InputStats` — `:56-72`；`ErrorStats` — `:75-77`；`HygieneStats` — `:83-88`；`PlayerTimingStats` — `:91-94`；`MetricsSnapshot` — `:97-111`
指标快照的类型层。MetricsSnapshot 被 game.ts（getMetrics 返回值）、application/runtime-application、apps/cli、shared/wire 侧消费；LLMRequestCounts 被 adapters/llm/openai-compatible-generator.ts 引用（recordLLMRequest 的 type 参数）。
#### `Metrics`（class） — `:132-404`
记录方法 19 个：`recordLLMRequest`（L181-190，**生产调用方是 adapters/llm/openai-compatible-generator.ts 十余处**，非本域）、`recordBranchRequested`（L193-195，branch-manager）、`recordPrefetchHit/Miss`（L198-205，branch-manager）、`recordTextWaste`（L211-213）/`recordAudioWaste`（L219-221，**无生产调用方，仅 metrics.test.ts:323-330**）、`recordInputPreview`（L228-231）、`recordInputResponseUnderrun`（L234-236）、`recordInputConfirmToFirstResponseLine`（L239-241）、`recordInputBridgeCoverDuration`（L244-246）、`recordInputResponseCanceled`（L249-251）、`recordStaleInputEventDropped`（L254-256）、`recordInputResponsePromotedLive`（L259-261）、`recordSchemaValidationFailure`（L264-266，interaction-input + 生成器侧）、`recordNarrationLabelStripped`/`recordTailNarrationDetected`（L269-276，生成器侧）、`recordChoiceToNextLine`（L283-285，game.ts）、`recordAssetDiagnostic`（L288-290，dsl-group-compiler）；读侧 `assetDiagnosticCounts`（L296-298）、`snapshot()`（L310-363，p50/p95/max + 全量副本）、`reset()`（L366-394）。
内部辅助：`percentile(sorted, p)`（L117-126，线性插值分位数）、私有 `computeRate`（L400-403）。

### src/runtime/status.ts（120 行）

#### 类型再导出块 — `src/runtime/status.ts:6-12`
`export type { BranchStatus, JobState, JobStatus, MediaStatus, RuntimeStatusSnapshot } from "../core/runtime/status-types.js"`——5 个名字（形状本体在 core，防 core 反向依赖）。
#### `RuntimeStatus`（class） — `:24-120`
可变状态枢纽。`snapshot()`（L45-59，深拷贝 jobs/branches/media）；`subscribe`（L61-64）；`setPhase`（L66-70）；`setBuffer`（L72-76）；`setJob`/`removeJob`（L78-85）；`setBranch`（L87-103，含事件/对白计数与错误）；`clearBranches`（L105-109）；`setMedia`（L111-114，patch 合并）；私有 `emit`（L116-119，快照广播）。生产调用方：game.ts（构造注入 + 大量 setPhase/setJob）、prefetch.ts（setJob/setBranch）、bootstrap（实例化）、apps/cli/terminal-ui 与 shared/wire（快照类型）。

### src/runtime/dsl-group-compiler.ts（89 行）

#### `DslGroupCompilerDeps`（interface） — `src/runtime/dsl-group-compiler.ts:27-37`
编译依赖束：registry/reduce/defaultsFor/可选 catalog/metrics（recordAssetDiagnostic 子集）/diagnostics/nextLineId/buildRuntimeInteraction。由 game.ts 构造（L352-361）。
#### `compileDslGroup(deps, draft, baseState, turn)` — `:39-89`
v1 冻结编译路径：compileEventGroup（core/protocol/gal-dsl/compiler）→ 资产诊断计数与 warn → 按 main 类型物化 dialogue（characterId+speaker）/narration/interaction（deps.buildRuntimeInteraction）/beat（无主事件），返回 {playable, interaction, cues, tailState}。调用方：game.ts compileGroup（L1262）。

### src/interaction/input-engine.ts（158 行）

#### `InputPhase`（type） — `src/interaction/input-engine.ts:19`
`"editing" | "preview" | "committed" | "cancelled"`。
#### `InputSession`（interface） — `:21-38`
interaction_id/phase/draft/revision（单调计数）/preview_text/可选 response_events/时间戳。
#### `InputEngine`（class） — `:44-158`
两阶段提交状态机。`startEditing`（L51-62，同 id 旧会话被替换）、`updateDraft`（L68-73）、`requestPreview`（L79-86，冻结 draft）、`commit`（L92-98）、`cancel`（L104-110，回 editing 并清 response_events）、`getDisplayText`（L117-120）、`getPhase`（L125-127）、`setResponseEvents`（L132-138）、`getCommittedText`（L142-145）；私有 `assertPhase`（L148-157，非法迁移抛错）。生产调用方：game.ts（实例字段 inputEngine）+ interaction-input.ts（startEditing/updateDraft/requestPreview/commit/cancel）。备注：session 以 interaction_id 为键存储在引擎内，但提交路径实际状态以 InputResponseSession 为准，两者并存。

### src/core/runtime/async-event-queue.ts（47 行）

#### `AsyncEventQueue<T>`（class，implements AsyncIterable<T>） — `src/core/runtime/async-event-queue.ts:8-47`
可移植 async FIFO：`push`（L13-20，优先唤醒等待者）、`close`（L22-27，唤醒全部等待者返回 done）、`next`（L29-37，长度判断而非 shift 判 undefined——值类型允许 undefined）、`pendingCount`（L39-42）、`[Symbol.asyncIterator]`（L44-46）。调用方（生产）：game.ts（命令队列 + 段队列）、interaction-driver.ts（直播消费私有队列）。备注：L29 `next()` 起行缩进为 4 空格（文件其余 2 空格），疑似手工改动痕迹。

### src/core/runtime/errors.ts（42 行）

#### `RuntimeShutdownError` — `:10-15`
shutdown 命令 / 队列关闭时抛出。消费方：entrypoints/cli.ts、hosts/local-web/local-web-host.ts（区分关停路径）、game.ts / interaction-* 各等待点。
#### `RestartRequestedError` — `:18-23`
restart_session 命令——宿主重建运行时。
#### `RetraceRequestedError` — `:29-34`
retrace 命令（M5.3），携带 decisionId——宿主调 prepareRetrace 后重入 run。
#### `InteractionPolicyViolationError` — `:37-42`
生成交互违反 InteractionPolicy（§8.5）——可修复失败类。

### src/core/runtime/runtime-command.ts（38 行）

#### `RuntimeCommand`（type，判别联合） — `src/core/runtime/runtime-command.ts:6-38`
9 种命令：start / advance / select_choice / preview_input / confirm_input / cancel_input / shutdown / restart_session / retrace。引用方：game.ts（dispatch/waitForCommand）、apps/cli/cli-controller.ts、hosts/local-web/runtime-websocket.ts、shared/wire/client-message.ts、game-test-kit.ts。

### src/core/runtime/runtime-output.ts（65 行）

#### `RuntimeInteractionEvent`（type） — `:16`
ChoiceEvent | InteractionEvent——表单输出面。
#### `StagePresentationDelta`（interface） — `:23-26`
cues + 应用后的权威 visualState（重连安全，docs §65）。
#### `RuntimeOutput`（type，判别联合） — `:28-65`
11 种输出：session_started / playback_ready / interaction_opened / stage_beat_ready / interaction_resolved / input_preview_opened / input_preview_canceled / input_committed / status_changed / session_ended / runtime_error。引用方：game.ts、hosts/local-web/runtime-websocket.ts + test-fakes.ts、shared/wire/server-message.ts + ui-projection.ts。

### src/core/runtime/status-types.ts（45 行）

#### `JobState` — `:8`；`JobStatus` — `:10-14`；`BranchStatus` — `:16-22`；`MediaStatus` — `:24-35`；`RuntimeStatusSnapshot` — `:37-45`
状态快照纯形状。MediaStatus 字段（enabled/provider/currentLineId/readyAhead/queued/generating/targetAhead/refillThreshold/branchReady/note）由媒体规划适配器经 RuntimeStatus.setMedia patch。被 core/runtime/runtime-output.ts（status_changed 载荷）与 runtime/status.ts（再导出）引用。

### src/core/interaction/input-bridge.ts（34 行）

#### `InputBridgeBuffer`（class） — `src/core/interaction/input-bridge.ts:12-34`
按 interaction_id 缓存已物化桥接旁白：`store`（L15-17）、`peek`（L20-22，跨预览取消复用）、`take`（L25-29，确认时取出）、`discard`（L31-33，选预设选项时丢弃）。调用方：game.ts（bridgeBuffer 字段）、interaction-input.ts（peek/store/take）、interaction-driver.ts（hybrid 选支 discard）。

### src/core/interaction/input-session.ts（123 行）

#### `InputResponseStatus`（type） — `src/core/interaction/input-session.ts:17-22`
generating/ready/committed/canceled/failed。
#### `InputResponseSessionInit`（interface） — `:24-30`
previewId/interactionId/generationId/frozenText/bridgeEvents。
#### `InputResponseSession`（class） — `:32-123`
回应流会话：`appendResponseEvent`（L59-63，canceled 后丢弃）、`settled` getter（L66-68）、`markReady`（L71-80，committed/canceled 不降级）、`markFailed`（L83-94，保留 committed 前缀有效性但记录 failure）、`commit`（L97-100）、`cancel`（L103-107，清空事件并 resolve done）、`subscribe`（L110-113，直播晋升后的事件流）、`done` getter（L116-118）、`events` getter（L120-122）。调用方：interaction-input.ts（创建/驱动）、interaction-driver.ts（consumeLiveInputResponse 以 LiveStreamLike 消费）、game.ts（liveResponse 接力）、segment-types.ts（类型引用）。

## 4. 域内数据流（玩家在 choice 表单点选一个选项 → 剧情推进）

1. 宿主 `dispatch({type:"select_choice"})`（game.ts:367）→ `isStaleInteractionCommand` 门口放行 → `commands` 队列。
2. 此前：run() → `consumeActiveSegment`（game.ts:921）从段队列读到 interaction 事件 → `advanceBufferedEvent` + `recordModelEvent`（正式记账，game.ts:1607）→ `graph.openDecision`（决策节点 + 入口快照，game.ts:1087）→ `recordInteractionMode`（:1095）→ `InteractionDriver.handleChoice`（game.ts:1103 → interaction-driver.ts:214 → interaction-choice.ts:41）。
3. `handleChoice` 已 `emit interaction_opened` 并 `waitForInteractionCommand` 挂起（game.ts:1229 → 1193）——此刻玩家命令入队即被唤醒。
4. 命中选项 → `emit interaction_resolved` → 释放作用域 → `recordPlayerChoice`（interaction-choice.ts:334）→ `Game.record`（game.ts:1691）：`graph.beginEdge`（既有出边一致 → pendingFastForward）→ `graph.appendEdgeEvents` → `narrativeDirector.observeCommitted` → `scheduleReconcile`（microtask 内 reconcileStoryState + 场景变化触发 director.triggerDirective）。
5. `takePendingFastForward` 命中 → 返回 fast_forward（run 循环走 `startRestoredSegment` 零生成恢复）；未命中 → `adoptSelectedBranch`（interaction-choice.ts:119）：`BranchManager.selectCandidate/selectCandidateLive`（branch-manager.ts:118/134）→ `BranchPrefetchGroup.take/selectLive`（prefetch.ts:91/110）→ 取回预取事件、转正分支尾态/名牌副本、丢弃未选分支。
6. ChoiceOutcome 回到 run()（game.ts:544-552）：`playbackBuffer.enqueueMany(preview)` + `registerBuffered`；`prepareContinuationAfterSelection`（game.ts:685）并行——live 分支经 `GenerationScheduler.adoptCandidateBranch` 收养（:728），await done 后 `startActiveSegment("continuation")`（:750）。
7. 播放线程：`consumeLiveSelection` 或 `consumePlayableEvents`（interaction-driver.ts:460/452）→ `Game.consumePlayableEvent`（game.ts:1474）：`advanceBufferedEvent` 顺序校验 → `recordModelEvent` → `media.waitUntilReady` → 行级 stage `applyPlayableStage` → `emit playback_ready` → `waitForAdvance`（:1527）等玩家 advance。
8. 每次 advance → `reconcileTextBuffer`（:1544）评估低水位：剩余文本 ≤ refill 阈值且无活动任务 → 后台 `startActiveSegment` 预热下一段（§75）。
9. 新段再次产出 interaction / `@end buffer` / end → SegmentOutcome 回到 run() 循环，周而复始。

## 5. 跨域接口

**本域 import 的其它域模块**（生产代码，非测试）：
- src 根：`config.js`（AppConfig）、`schema.js`（全部事件类型 + isPlayableEvent）。
- core/ports（L1）：clock-port、diagnostic-sink、id-generator-port、run-graph-port（RunGraphPort/RunResume/RestorePoint）、story-generator-port（StoryGeneratorPort/GenerationIdentity/legacyGenerationIdentity）、media-planner-port、narrative-director-port、identity-snapshot-port（SNAPSHOT_IDENTITY_SCHEMA_VERSION）。
- core/graph：memory-digest（EMPTY_MEMORY_DIGEST）、form（formSnapshotFromInteraction/interactionFromFormSnapshot）、types（MemoryDigest/SnapshotIdentityState）。
- core/protocol/gal-dsl：types（AnyStreamedGroup/CompiledEventGroupV2/EventGroupDraft/DslInteractionDraft/SegmentEndStatus/AssetDiagnostic）；compiler（compileEventGroup，经 dsl-group-compiler.ts:10）。
- core/assets：types（AssetCatalog）、catalog（EMPTY_CHARACTER_REGISTRY/toCharacterRegistry）。
- core/presentation：defaults（createDefaultsFromRegistry/createInitialVisualState）、reducer（createVisualStateReducer）、types（VisualState/StageCue/CharacterRegistry 等）。
- core/characters：types（CharacterRuntimeState/createCharacterRuntimeState/withCharacterLabel）。
- core/narrative：memory-projection（MemoryProjection）。
- story/：interaction-policy（InteractionPolicy）、types（InteractionMode/InputSpec/StoryState/GeneratedEvent）、reconcile（reconcileStoryState）、event-projection（cloneCharacterRuntimeState）、state（createInitialState）。
- **application/director**（层次穿透）：director-service（SceneDirectorPort 类型，game.ts:119）、actor-briefing（buildActorBriefing，game.ts:120）。

**被哪些域 import**（生产代码）：
- L4 装配/宿主：bootstrap/create-runtime-application.ts（Game:13、Metrics:41、RuntimeStatus:42）；application/runtime-application.ts（Game:9、Metrics:16）；hosts/local-web/runtime-websocket.ts（Game:13、RuntimeCommand:24）、local-web-host.ts（errors:22）、test-fakes.ts（Game:6、RuntimeOutput:13）；apps/cli/cli-controller.ts（RuntimeCommand:8、Game:14）、terminal-ui.ts（RuntimeStatusSnapshot:12）；entrypoints/cli.ts（errors:6、Metrics:7）。
- L0 shared：shared/wire/client-message.ts（RuntimeCommand:5）、server-message.ts（RuntimeOutput:6）、ui-projection.ts（RuntimeInteractionEvent:11、RuntimeStatusSnapshot:13——经 src/runtime/status.js）。
- L3 适配器：adapters/llm/openai-compatible-generator.ts（Metrics/LLMRequestCounts:67；回调 recordLLMRequest/recordSchemaValidationFailure/recordNarrationLabelStripped/recordTailNarrationDetected 等）。
- L2 应用：application/ui/ui-projection-store.ts（core/runtime 与 runtime/status 相关类型）。
- 测试基础设施：game-test-kit.ts（RuntimeStatus/RuntimeCommand/GamePorts）、test-helpers.ts。

## 6. 测试覆盖

| 测试文件 | 覆盖的符号/行为（describe/it 名） |
|---|---|
| src/game.test.ts | Game 构造与基础设施；Session ID 安全字符；内部状态访问（storyState 事件反映）；Line ID 生成（单调+嵌 sessionId）；recordPlayerChoice/recordPlayerInput 结构与时间戳；seq 编号；registerBuffered→setBuffer；StoryState reconciliation（microtask 后）；Metrics 透传；Narration-only 分支交接阈值；NarrativeDirector 集成（observeCommitted/checkpoint 恰一次/预取内容不进记忆/brief 透传/无导演零行为差异） |
| src/game-interactions.test.ts | Hybrid 交互命令（预设选项、取消后双路再武装+重预取）；InteractionPolicy 执行（非法模式入缓冲前拒绝+修复、首事件即非法也修复、中途失败泵排空、连续纯输入拒绝、hybrid 后 streak 重置、纯输入无 BranchManager、模式历史上限 8）；interaction_resolved 发布时机（choice/input/未知选项/Esc/自动确认）；命令作用域（双击/同 tick 竞争/陈旧 preview 丢弃、deferredCommands 不残留、空白输入边界重开） |
| src/game-input.test.ts | 预览取消（中止陈旧回应、无残留）；桥接语义（稳定 line_id、hybrid 预设丢弃桥、自由输入保留桥、桥+回应播放）；回应流式（预览期 staging 不碰正式态、确认后直播晋升、取消后迟到事件丢弃、状态补丁不提交、确认失败保留前缀、失败一次重试、重试也失败不伪造回应、指标记录、免确认直提、final burst 全量播种预测尾态、单 Enter 流失败重试不晋升） |
| src/game-dsl.test.ts | DSL 开场组流入缓冲（characterId+stage）；@end ending 合成 EndEvent；hybrid 编译（生成 id、分支+桥预取）；自由输入播放链；预览取消再武装；截断恢复（保留已提交组+续写修复）；视觉状态（有 cue 的行播放才变）；低水位续写（读尾部即续写、超阈值不续写、start_threshold 门、失败段不触发低水续写、fail-fast 修复提前启动）；beat cue 时序（播放位生效、分支预取折叠进下一行） |
| src/game-dsl-v2.test.ts | v2 knob=2 端到端（解码、标签快照进事件、@ch 生效）；分支标签预测隔离与选中转正；v2 协议错误一次尾部修复；双_fault 走段失败路径；缺省 knob=2（Ruling 15）；v1 会话字节级不变（fixture 钉）；重试臂不吞幽灵改名（84a68ee finding 6）；重试自身失败任务解除（finding 1） |
| src/game-branch-selection.test.ts | 真生成器分支选择（PLAYING 不卡 CONTENT_WAITING）；预取不足 3 句选择失败行为；hybrid 取消再武装后选择不损坏播放缓冲；中止回应流后选支保持缓冲顺序；terminal 后杂散组丢弃（docs §50） |
| src/game-graph-restore.test.ts | 图生命周期（纯开场无决策、交互开决策节点/边/结局、开场失败修复、预算耗尽继续修复、修复段选择走正常分支、预览播放中续写段失败不崩溃）；M1.4 游标恢复（表单重放/记忆追赶/seq 连续、完结局补结局、M1.5 restart 弃局重建、M5.3 retrace 同选项快进零生成）；M3 身份隔离（名牌按快照还原、分支副本不跨周目泄漏）；Ruling 15 协议版本 fixity（快照写会话实际版本、跨旋钮恢复漂移诊断） |
| src/runtime/prefetch.test.ts | BranchPrefetchGroup：启动/并发控制/排队/成功生成/take（已完成为等/live 暴露/handoff/取消他人/未知 id/失败/已取消）、take 优先快速通道、cancelAll、错误处理（拒绝/状态/继续泵/非 Error 归一）、AbortController、onReady、状态同步、边界（空选项/单选项/重复 take/并发超量/deferred 不泄漏未处理拒绝） |
| src/runtime/metrics.test.ts | Metrics：LLM 请求分类计数、token 累计、延迟分位数（p50/p95/max/单样本/乱序）、预取命中率、快照不可变性、schema 失败计数、choice-to-next-line、资产诊断计数与副本、reset |
| src/runtime/branch-manager.test.ts | BranchManager：createCandidate/updateCandidateStatus/discardCandidate/discardAll/isActive/selectCandidate（无组抛错/成功 selected/失败标 failed）、metrics 集成（requested/hit/miss/无 Metrics 可选）、onReady 生命周期、边界（空选项/重复 startPrefetch 不双计/interaction_id+source 保持） |
| （同目录补充）src/runtime/generation-scheduler.test.ts | GenerationScheduler 状态机（idle/streaming/canceling、重复启动抛错、adoptCandidateBranch 复用控制器、订阅/退订、完成后再启动） |
| （同目录补充）src/runtime/playback-buffer.test.ts | PlaybackBuffer 顺序/游标/计数/哨兵检测/clear + changed() 信号语义（下次变更才醒、共享单信号、迟到等待者等下一次、空 enqueueMany 不触发） |
| （同目录补充）src/runtime/status.test.ts | RuntimeStatus 默认快照/setPhase 等 setter 行为 |
| （同目录补充）src/interaction/input-engine.test.ts | InputEngine 全生命周期/迁移非法抛错/cancel 后再编辑/revision 单调/response_events 挂载与清除 |
| （同目录补充）src/core/interaction/input-bridge.test.ts | InputBridgeBuffer store/peek/take/discard/未知 id/交互独立 |

## 7. 重构关注点（事实清单）

1. `src/game.ts:178-1983` — 单类 1806 行、约 50 个成员方法 + 20 余个 `@internal` 字段，同时承担 §1 所列 10 类职责；run() 152 行、consumeActiveSegment() 213 行、startActiveSegment() 130 行，是全仓最大复杂度聚集点。
2. `src/runtime/interaction-driver.ts:73-164` — `InteractionHost` 接口 92 行、约 44 个成员（30 状态 + 14 方法），把 Game 内部可变状态（seq、choiceTimestamp、branchTailStates、branchCharacterStates、bridgeLineIds…）整面暴露给 runtime 子模块；「最小视图」实为宽接口，Game 侧对应成员全部标 `@internal`（game.ts 内 20 处）。
3. `src/game.ts:119-120` — 层次穿透：位于 src 根的 Game 直接 import `application/director/director-service`（类型）与 `actor-briefing`（函数）；同理 `src/shared/wire/ui-projection.ts:13`（L0 shared）import `src/runtime/status.js`，`src/adapters/llm/openai-compatible-generator.ts:67`（L3 适配器）import 并回调 `src/runtime/metrics.js` 的 Metrics——依赖方向与「shared→core→…→adapters」的分层建议相悖。
4. `src/runtime/metrics.ts:211-221` — `recordTextWaste`/`recordAudioWaste` 无生产调用方（仅 metrics.test.ts:323-330），WasteStats 在生产恒为 0：死观测钩子。
5. `src/runtime/prefetch.ts:22` 与 `src/runtime/branch-manager.ts`（BranchCandidate.status）— 两层状态机语义重叠（queued/running/ready/failed/cancelled vs queued/generating/ready/selected/discarded/failed），同一分支状态被 BranchEntry 与 BranchCandidate 各记一份，同步靠包装回调（branch-manager.ts:64-93）。
6. `src/runtime/interaction-driver.ts:166-583` — InteractionDriver 大半方法是 1:1 委托（resolveInteraction/createBranchManagerForTerminal/startBridgePrefetch/cancelBridgePrefetch/recordPlayer*/handleChoice/handleInteractionInput 共 9 个），逻辑本体在 interaction-choice/interaction-input 自由函数；门面主要承担类型耦合（host 首参约定）。
7. `src/runtime/interaction-input.ts:93-330` — `handleInteractionInput` 237 行单函数：编辑→预览→确认/取消→快进→修复→直播晋升 7 条路径在一个 while(true) 内，含 setTimeout(0) 微任务排空等时序敏感逻辑（L245）。
8. `src/game.ts:921-1133` — 修复控制流分散三处协作（consumeActiveSegment 递归 repairBudget / maybeStartEarlyRepair 后台启动 / startActiveSegment 抛错回退），且失败路径清理规则有条件分支（L998-1000：仅无 earlyRepair 时 clear playbackBuffer）——正确性依赖注释链（L869-871、L908-911、L1535-1537 三处描述同一约束「杂散续写会让 startActivePath 抛错杀死 run()」）。
9. `src/game.ts:287/294` + `src/runtime/interaction-choice.ts:302-303/161-163/204-220` + `src/game.ts:743-748/585-586` — branchTailStates/branchCharacterStates 共享可变表有 4 个生命周期写入点（预取泵逐组落表、重试前删除、adopt 转正、恢复/收尾清空），一致性全靠注释约定「绝不回写主状态」。
10. `src/game.ts:852-877`、`src/runtime/interaction-choice.ts:285-323`、`src/runtime/interaction-input.ts:362-385` — 「for await 泵 + 失败时带 catch 排空防 unhandledRejection」样板在 3 处重复实现，各配长注释（I1/C5/I2 同一模式），无共享抽象。
11. `src/runtime/generation-scheduler.ts:45-49` — 单槽约束以抛错维持而非排队/等待；game.ts 必须保证所有启动点先检查 hasActivePathTask（reconcileTextBuffer L1546）或吞掉启动异常（maybeStartEarlyRepair L1178-1180）——并发正确性依赖隐式调用顺序。
12. `src/runtime/status.ts:6-12` — 状态类型双位置（core/status-types.ts 本体 + runtime/status.ts 再导出）；同一类型有两个 import 路径并存（terminal-ui.ts 走 runtime/status.js，runtime-output.ts 走 core），消费端路径不一致。
13. `src/core/runtime/async-event-queue.ts:29` — `next()` 方法缩进异常（4 空格 vs 文件其余 2 空格）；行为无影响，提示该文件有未过格式化的手工修改。
14. `src/interaction/input-engine.ts:45` 与 `src/core/interaction/input-session.ts` — 自由输入的两阶段状态被两个状态机分别记录（InputEngine.session.phase 与 InputResponseSession.status），提交路径以 ResponseSession 为准、InputEngine 仅在 handleInteractionInput 内短暂使用（startEditing→updateDraft→requestPreview→commit/cancel 同步调用），职责可合并。

## 附：本域建议层级（供整体重构参考）

按建议分层框架，本域现状横跨 L1/L2：
- `core/runtime/*`、`core/interaction/*`、`interaction/input-engine.ts` 属 **L1 核心领域**（无外部依赖的纯契约与状态机）——现状即如此，无需移动。
- `runtime/*` 机制层（调度/预取/缓冲/指标/状态）建议定位 **L1.5 或 L2 之下**：它们只依赖 core 与 story，但 `metrics.ts` 被 adapters 反向依赖（见 §7.3）需要先把「LLM 观测」收进 port 或挪到 adapters 侧。
- `game.ts` 是事实上的 **L2 应用服务**（编排 ports + 调 application/director + 驱动 L3 生成器），建议按 §1 的 10 类职责拆为 run-loop / segment-lifecycle / dsl-routing / identity-briefing / playback 等模块后再定位；InteractionHost 宽接口是拆分的第一个收口点。
