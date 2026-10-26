# 端口与存储适配域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：34 文件 / 3591 行（生产代码，不含测试）
> 范围：`src/core/ports/`（18 个生产文件，第 19 个 `story-generator-port.test.ts` 为测试）、`src/adapters/storage/`（11）、`src/adapters/static/`（2）、`src/adapters/platform/`（3）、`sessions/`（运行数据目录，概述）。行号均以 Read 实测为准，代码快照 `D:/coding/lgp-main-atlas`。

## 1. 域职责与边界

**端口-适配器模式的落地形态。** `src/core/ports/` 是 core 层对外部的全部契约面：LLM 生成（`StoryGeneratorPort`、`AgentRunnerPort`、`ConfluenceJudgePort`）、文件存储（`GraphStorePort`、`OutlineStorePort`、`CanonStorePort`、`StatsStorePort`、`ReviewStorePort`、`NarrativeMemoryStorePort`）、运行时协调（`RunGraphPort`、`NarrativeDirectorPort`、`MediaPlannerPort`）、平台能力（`ClockPort`、`IdGeneratorPort`、`DiagnosticSink`）、TTS（`TtsProviderPort` + `tts-model-family` 纯判定模块）。适配器实现分布在 `src/adapters/`（llm/storage/static/platform/tts）与 `src/application/`（`RunGraphCoordinator`、`NarrativeDirectorService`、`AudioIntentPlanner` 三个 application 类实现 core 端口）。装配在 `src/bootstrap/create-runtime-application.ts`（组合根）与 `src/entrypoints/web.ts`。

**文件型存储的一致性策略**（三条纪律，各 store 落实程度见 §7）：
1. **append-only JSONL + latest-wins 折叠**：图记录（scenes/decisions/edges/endings/runs）只追加不改写，同 id 取最后一次出现；删除走 tombstone 行（`{"id":…,"deleted":true}`），读取端折叠过滤（`game-graph-store.ts:146-201`）。
2. **tmp+rename 原子单文件写**：快照、游标、canon.json、outline.json、stats.json、themes.json、roster blob、ending-report 等全量文件一律先写 `<target>.tmp-<pid>-<时间戳>-<随机>` 再 `rename`，共 12 处内联重复（§7 关注点 2）。
3. **损坏语义分级**：「读宽容」= 缺文件（ENOENT）降级为空；「大声抛错」= 结构级损坏（索引行在而快照缺失、canon/outline/stats JSON 损坏）——静默重建等于吞档。各 store 对「非 ENOENT 读错误」的处理不一致（§7 关注点 3）。

写互斥（对抗「读-改-整体覆写」丢更新）：`CanonStore`/`OutlineStore`/`StatsStore`/`MusicThemeStore` 各自持有 `writeChain` Promise 链串行化变更；`GameGraphStore` 自身无锁，串行化由消费方 `RunGraphCoordinator.mutationChain`（`run-graph-coordinator.ts:105,186-189`）承担；`JsonNarrativeMemoryStore`/`ReviewStore`/`VoiceDesignStore`/`ComposerSessionStore` 无任何互斥。

**端口文件的两种非典型形态**：`identity-snapshot-port.ts` 实为共享类型模块（无 `*Port` 接口，导出常量/类型/1 个函数，服务 v3→v4 身份升级规范）；`diagnostic-sink.ts` 与 `story-generator-port.ts` 在端口文件内携带可运行实现（`silentDiagnosticSink` null 对象、`createGenerationHandle` 兼容包装器、`legacyGenerationIdentity`）。

## 2. 模块清单

### 2.1 端口定义（src/core/ports/，18 生产文件 1121 行）

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| agent-runner-port.ts | 40 | 导演 agent 最小工具循环契约 + 步数上限常量 | 4 | （由 adapters/llm/agent-runner-adapter.test.ts 覆盖） |
| canon-store-port.ts | 83 | 跨周目世界既定（canon）读写契约 + canon 数据形状 | 6 | adapters/storage/canon-store.test.ts |
| clock-port.ts | 14 | 时间源抽象（禁 core 直呼 Date） | 1 | （FakeClock 在 src/test-helpers.ts） |
| confluence-judge-port.ts | 38 | 汇流等价判定契约（冻结签名） | 2 | （adapters/llm 侧测试） |
| diagnostic-sink.ts | 20 | 结构化诊断输出契约 + silentDiagnosticSink | 2 | — |
| graph-store-port.ts | 114 | 剧情图存储契约（v2 §9 布局，真源拆分头注） | 1 | adapters/storage/game-graph-store.test.ts |
| id-generator-port.ts | 18 | 标识符生成抽象 | 1 | adapters/platform/session-id-generator.test.ts |
| identity-snapshot-port.ts | 143 | 快照身份信封/迁移诊断类型 + roster 快照函数 | 11 | identity-upcaster.test.ts |
| media-planner-port.ts | 38 | 纯媒体意图接口（生命周期，不含播放状态） | 1 | （application/audio 侧测试） |
| narrative-director-port.ts | 43 | 叙事导演组合根契约（剪报/digest/恢复/关停） | 2 | （application/narrative 侧测试） |
| narrative-memory-store-port.ts | 58 | 记忆三工件 + MA-A 通道持久化契约 | 1 | json-narrative-memory-store.test.ts |
| outline-store-port.ts | 36 | 大纲持久化 + 修订留痕契约 | 3 | outline-store.test.ts |
| review-store-port.ts | 22 | 通关评分存档契约 | 2 | —（review-store.ts 无测试） |
| run-graph-port.ts | 163 | 剧情图运行时端口（actor 生命周期→图操作） | 6 | （run-graph-coordinator 侧测试） |
| stats-store-port.ts | 23 | 世界级结算统计契约 | 2 | stats-store.test.ts |
| story-generator-port.ts | 180 | 故事生成契约 + 请求形状 + GenerationHandle 包装器 | 11 | story-generator-port.test.ts（同目录，200 行） |
| tts-model-family.ts | 30 | TTS 模型族判定（纯函数，非接口） | 3 | （config/voices 与 audio 侧测试） |
| tts-provider-port.ts | 58 | 流式 PCM 合成边界契约 | 5 | （adapters/tts 侧测试） |

### 2.2 存储适配器（src/adapters/storage/，11 文件 2101 行）

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| game-graph-store.ts | 598 | Node 剧情图存储（JSONL+快照+游标+roster blob+v3→v4 升级读取） | 1 | game-graph-store.test.ts（684 行） |
| identity-upcaster.ts | 303 | 旧事件身份升级（纯函数，校园 F3 移植） | 9 | identity-upcaster.test.ts（285 行） |
| canon-store.ts | 261 | canon.json + canon.log.jsonl（写互斥链） | 1 | canon-store.test.ts（194 行） |
| json-narrative-memory-store.ts | 218 | 会话目录记忆六工件 | 1 | json-narrative-memory-store.test.ts（298 行） |
| music-theme-store.ts | 175 | 主题制配乐目录 + 谱面（首写即定稿） | 1 | music-theme-store.test.ts（167 行） |
| outline-store.ts | 178 | outline.json + outline.log.jsonl（整批事务校验） | 1 | outline-store.test.ts（155 行） |
| stats-store.ts | 118 | stats.json（幂等结算计数） | 2 | stats-store.test.ts（62 行） |
| voice-design-store.ts | 81 | world/voice-design.json（世界创建期写一次） | 2 | voice-design-store.test.ts（63 行） |
| composer-session-store.ts | 67 | music/session.jsonl 作曲家会话 | 1 | composer-session-store.test.ts（68 行） |
| review-store.ts | 68 | reviews/<runId>.json 通关评分 | 1 | **无** |
| stored-event.ts | 34 | StoredEvent 磁盘行守卫（纯谓词） | 1 | （间接：game-graph-store.test.ts payload 用例） |

### 2.3 静态与平台适配器（5 文件 369 行）

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| adapters/static/story-plan-loader.ts | 222 | story-plan.yaml → 运行时 PlotThread/SetupPayoff/Anchor | 2 | story-plan-loader.test.ts（260 行） |
| adapters/static/character-pack-loader.ts | 81 | characters.yaml → CharacterRoster（revision 防篡改） | 1 | character-pack-loader.test.ts（204 行） |
| adapters/platform/console-diagnostic-sink.ts | 21 | 终端格式化诊断 sink | 1 | — |
| adapters/platform/session-id-generator.ts | 33 | 时间戳会话 ID + 单调计数器 | 1 | session-id-generator.test.ts（50 行） |
| adapters/platform/system-clock.ts | 12 | 真实墙钟 | 1 | — |

### 2.4 sessions/ 运行数据目录（概述）

快照中 `sessions/` 仅含 `.gitkeep`（运行时数据不入库）。运行期由 config `game.sessions_dir`（默认 `"sessions"`，`src/config.ts:544`）指定：`JsonNarrativeMemoryStore(sessionDir, sessionId)` 在 `sessions/<sessionId>/` 写 `narrative-state.json`、`episodes.jsonl`、`narrative-ops.jsonl`、`facts.jsonl`、`lessons.jsonl`、`ending-report.json`（`json-narrative-memory-store.ts:35-40`）；一个 runtime 绑定一个 sessionId（`create-runtime-application.ts:636-640` 注释，记忆与会话文件同 id）。`src/entrypoints/web.ts:156` 直接读 `sessions/<sessionId>/ending-report.json`。世界级数据在 `games/<gameId>/`（`DEFAULT_GAMES_ROOT = "games"`，`create-runtime-application.ts:107`；布局常量 `GAME_STORAGE_LAYOUT` 见 `src/core/graph/ids.ts:45-79`）。

## 3. 函数级明细

### 3.1 src/core/ports/agent-runner-port.ts（40 行）

#### `AgentTool` — `src/core/ports/agent-runner-port.ts:10-15`
用途：工具描述形状（name/description/JSON Schema parameters）。消费方：`AgentRunnerAdapter`（实现侧注入 LLM tools）、`director-service.ts:20` 引用。

#### `AgentTurnResult` — `src/core/ports/agent-runner-port.ts:18-23`
用途：单次模型应答——最终文本或一次工具调用请求（一步只一个 toolCall）。

#### `AgentRunnerPort` — `src/core/ports/agent-runner-port.ts:25-36`
用途：导演 agent 最小工具循环端口；`runLoop({system,user,tools,executeTool})` 循环「模型→工具执行→回喂」直到最终文本。
实现方：`AgentRunnerAdapter`（`src/adapters/llm/agent-runner-adapter.ts:20`，单实现）。
消费方：`src/application/director/director-service.ts:20,103,126`。

#### `MAX_AGENT_TOOL_STEPS = 6` — `src/core/ports/agent-runner-port.ts:39`
用途：步数上限常量，超限强制无工具收束。消费方：`agent-runner-adapter.ts:10,47`（循环上界）及其测试。

### 3.2 src/core/ports/canon-store-port.ts（83 行）

#### `CanonCharacter` — `canon-store-port.ts:15-25`
用途：canon 角色卡（control/initialLabel 为 M1 权威元信息）。消费方：canon-store.ts、world-generator.ts:25、canon-adjudicator-adapter、world-roster.ts:33。

#### `PromotedFact` — `canon-store-port.ts:28-37`
用途：跨 ≥2 周目佐证、经裁决入 canon 的 major fact（含 evidenceRuns/judgedBy/promotedAt）。

#### `CanonException` — `canon-store-port.ts:40-46`
用途：与 canon 矛盾但允许存在的事实，必须附 compensatingLimit。

#### `CanonSnapshot` — `canon-store-port.ts:49-55`
用途：canon.json 全量形状（revision 由 store 维护）。

#### `CanonOp` — `canon-store-port.ts:58-63`
用途：晋升修订判别联合（promote/exception），裁决产物落盘形态。

#### `CanonStorePort` — `canon-store-port.ts:65-83`
用途：canon 唯一入口——`getCanon`（同步内存读）/`load`（缺文件=空，损坏抛错）/`saveScaffold`（仅 canon.json 不存在时合法）/`applyPromotion`（校验→原子写→追加日志）。
实现方：`CanonStore`（`adapters/storage/canon-store.ts:82`，**未声明 `implements`**，结构性兼容）。
消费方（类型引用）：`canon-promoter.ts:15`、`director-service.ts:21`、`run-graph-coordinator.ts:20`、`create-runtime-application.ts:29`；`world-generator.ts:20` 直接 import 具体类 `CanonStore`。

### 3.3 src/core/ports/clock-port.ts（14 行）

#### `ClockPort` — `clock-port.ts:9-14`
用途：时间源抽象（`nowMs`/`nowIso`）；头注明令 core 运行时不得直呼 `Date.now()`。
实现方：`SystemClock`（`platform/system-clock.ts:4`）、`FakeClock`（`src/test-helpers.ts:160`）。
消费方：`game.ts:19`、`runtime/interaction-driver.ts`、`run-graph-coordinator.ts:15`、`confluence-checker.ts`、`create-runtime-application.ts`、`test-helpers.ts`。

### 3.4 src/core/ports/confluence-judge-port.ts（38 行）

#### `ConfluenceJudgment` — `confluence-judge-port.ts:20-29`
用途：等价判定结论（equivalent/confidence/rationale/judgedBy），调用方组装 `ConfluenceEvidence`。

#### `ConfluenceJudgePort` — `confluence-judge-port.ts:31-38`
用途：汇流等价判定（接口签名冻结契约）；`judge({endState, candidateEntry})`。
实现方：`ConfluenceJudgeAdapter`（`adapters/llm/confluence-judge-adapter.ts:46`，单实现）。
消费方：`confluence-checker.ts`、`run-graph-coordinator.ts`、`director-service.ts:106`（可选注入）。

### 3.5 src/core/ports/diagnostic-sink.ts（20 行）

#### `DiagnosticSink` — `diagnostic-sink.ts:9-14`
用途：结构化 `(scope, message)` 诊断契约（info/warn），宿主决定格式。
实现方：`ConsoleDiagnosticSink`（platform）、`RecordingDiagnostics`（`application/narrative/narrative-director-test-kit.ts:145`）。
消费方：约 20 个文件（game.ts、interaction-driver、adapters/llm 全部 adapter、application 各 service、bootstrap）——全仓消费面最广的端口。

#### `silentDiagnosticSink` — `diagnostic-sink.ts:17-20`
用途：丢弃一切的 null-object 安全默认。消费方：15+ 文件（各 adapter 默认参数、game.ts、test-helpers 等）。
备注：端口文件携带实现（null object），非纯契约。

### 3.6 src/core/ports/graph-store-port.ts（114 行）

#### `GraphStorePort` — `graph-store-port.ts:30-114`
用途：v2 剧情图存储端口，21 个成员（location/initialize/putRosterBlob/getRosterBlob/putScene/listScenes/removeDecision/removeEdge/putDecision/getDecision/listDecisions/putEdge/listEdges/putEnding/appendPayload/readPayload/listPayloadIds/deletePayload/putRun/getRun/listRuns/saveCursor/clearCursor/loadCursor）。读写模型头注（:1-17）：记录 append-only + latest-wins；决策入口快照单独落盘为唯一物理真源，decisions.jsonl 只存索引；普通决策端点的边 endState 不落盘（由后继入口派生），结局端点与汇流边内联。
实现方：`GameGraphStore`（`adapters/storage/game-graph-store.ts:212`，单实现）。
消费方：`run-graph-coordinator.ts`、`director-service.ts:25`、`confluence-checker.ts`、`canon-promoter.ts`、`graph-view.ts`、`create-runtime-application.ts`、`web.ts:89`、`test-helpers.ts`。

### 3.7 src/core/ports/id-generator-port.ts（18 行）

#### `IdGeneratorPort` — `id-generator-port.ts:9-18`
用途：ID 生成抽象（nextSessionId/nextLineId/nextGenerationId/nextPreviewId）。
实现方：`SessionIdGenerator`（platform/session-id-generator.ts:10）、`FakeIdGenerator`（test-helpers.ts:174）。
消费方：`game.ts`、`interaction-driver.ts`、`create-runtime-application.ts`。

### 3.8 src/core/ports/identity-snapshot-port.ts（143 行）

备注：本文件不是端口接口，是「快照身份信封与迁移诊断」共享规范（纯类型 + 常量 + 2 函数，无 IO），由 main 与校园线共用。

#### `SNAPSHOT_IDENTITY_SCHEMA_VERSION = 2` — `identity-snapshot-port.ts:21`
用途：快照身份契约版本。消费方：identity-upcaster.ts:44,277。

#### `SNAPSHOT_DSL_PROTOCOL_VERSION = 2` — `identity-snapshot-port.ts:31`
用途：DSL 协议格式常量当前值（信封实际记录会话生效版本，不恒写本常量）。消费方：identity-upcaster.test.ts:22。

#### `SnapshotDslProtocolVersion = 1 | 2` — `identity-snapshot-port.ts:38`
用途：`dsl.protocol_version` 取值域类型。消费方：identity-upcaster.ts:39、core/graph/snapshot-upcast.ts:22。

#### `SnapshotRosterSnapshot` — `identity-snapshot-port.ts:45-50`
用途：可恢复 roster 定义快照（scopeId/revision/playerId/characters）。

#### `rosterSnapshotOf(roster)` — `identity-snapshot-port.ts:53-60`
用途：由 CharacterRoster 浅拷贝派生 roster 快照。
备注：**全仓无消费方**（grep 仅定义处）——死导出候选。

#### `SnapshotIdentityEnvelope` — `identity-snapshot-port.ts:68-80`
用途：身份信封形状（两版本字段 + roster 快照 + 名牌状态）。消费方：identity-upcaster.ts:40,265-282（构造）。

#### `LegacyEventUpcastCategory` — `identity-snapshot-port.ts:90-101`
用途：旧事件升级六类结果判别联合。消费方：identity-upcaster。

#### `EventMigrationDiagnostics` — `identity-snapshot-port.ts:103-112`
用途：事件迁移计数/引用/原因（可数可观测）。

#### `SnapshotMigrationDiagnostics` — `identity-snapshot-port.ts:114-122`
用途：快照迁移诊断（sourceFormat v3/v4、恢复名牌数、损坏字段、notes）。

#### `SessionMigrationReport` — `identity-snapshot-port.ts:124-127`
用途：events + snapshot 两诊断的拼装体；`RestorePoint.migration`（run-graph-port.ts:69）仅在异常发现时携带。

#### `GraphIdentityContext` — `identity-snapshot-port.ts:139-143`
用途：M3 图存储侧身份上下文（roster 提供者 + dslProtocolVersion + 可选 legacyMapping），宿主装配一次、store 与协调器共用。
消费方：game-graph-store.ts:23、run-graph-coordinator.ts、create-runtime-application.ts、web.ts。

### 3.9 src/core/ports/media-planner-port.ts（38 行）

#### `MediaPlannerPort` — `media-planner-port.ts:15-38`
用途：纯媒体意图接口——注册正式/候选路径台词、晋升/丢弃候选、markPresented；`isReady`/`waitUntilReady` 为 CLI mock 音频节流的过渡性查询（浏览器宿主不调用）。
实现方：`AudioIntentPlanner`（`application/audio/audio-intent-planner.ts:33`，单实现，实现方在 application 层）。
消费方：`game.ts:325`、`runtime/interaction-driver.ts`、`game-test-kit.ts`。

### 3.10 src/core/ports/narrative-director-port.ts（43 行）

#### `NarrativeCheckpointReason` — `narrative-director-port.ts:14-17`
用途：检查点原因联合（interaction_completed/segment_ended/scene_change）。

#### `NarrativeDirectorPort` — `narrative-director-port.ts:19-43`
用途：叙事记忆层组合根——getMemoryProjection（同步剪报）、getMemoryDigest（决策快照唯一记忆真源，纯读取）、restoreFromDigest（恢复）、observeCommitted、checkpoint、flush（幂等关停）。
实现方：`NarrativeDirectorService`（`application/narrative/narrative-director-service.ts:149`，单实现）。
消费方：`game.ts:227`、`interaction-driver.ts`、`game-test-kit.ts`、`create-runtime-application.ts`。

### 3.11 src/core/ports/narrative-memory-store-port.ts（58 行）

#### `NarrativeMemoryStorePort` — `narrative-memory-store-port.ts:19-58`
用途：记忆层持久化契约——load（损坏降级空值不抛）、saveState（原子）、appendEpisodes/appendOps（JSONL 追加）、MA-A 通道（appendLessons/loadLessons/appendFacts/loadFacts 损坏行跳过、writeEndingReport 原子覆写）。
实现方：`JsonNarrativeMemoryStore`（storage，单生产实现）、`FakeStore`（`narrative-director-test-kit.ts:43`）。
消费方：`narrative-director-service.ts`、`narrative-director-test-kit.ts`。

### 3.12 src/core/ports/outline-store-port.ts（36 行）

#### `OutlineOp` — `outline-store-port.ts:13-17`
用途：大纲修订判别联合（add/activate/realize/prune；add 只收 planned，决议 D5）。

#### `OutlineSnapshot` — `outline-store-port.ts:19-22`
用途：大纲全量 + revision。

#### `OutlineStorePort` — `outline-store-port.ts:24-36`
用途：getOutline（同步内存读）/load（缺文件=空 revision 0，损坏抛错）/applyRevision（整批校验→原子写→追加日志，非法 op 拒绝整批）。
实现方：`OutlineStore`（storage/outline-store.ts:34）。消费方：`run-graph-coordinator.ts:59,115`、`director-service.ts:26`、`graph-view.ts`、`create-runtime-application.ts`、`web.ts`；`world-generator.ts:182` 直接实例化具体类。

### 3.13 src/core/ports/review-store-port.ts（22 行）

#### `RunReview` — `review-store-port.ts:7-16`
用途：单次通关评分（rating 1-5/comment/outlineFit/reviewedAt）。

#### `ReviewStorePort` — `review-store-port.ts:18-22`
用途：save/load/list 三方法。实现方：`ReviewStore`（storage/review-store.ts:19，单实现）。
消费方：`run-graph-coordinator.ts:22,130`、`create-runtime-application.ts:284`、`web.ts:177`。

### 3.14 src/core/ports/run-graph-port.ts（163 行）

#### `RuntimeMoment` — `run-graph-port.ts:23-35`
用途：快照时刻运行时状态（storyState/visualState/memoryDigest/outlineRevision/identity 五件套），决策入口与结局末态共用。

#### `EdgeChoice` — `run-graph-port.ts:38-41`
用途：边的 choice 语义（option/free_input + text）。

#### `RestorePoint` — `run-graph-port.ts:44-70`
用途：恢复点——游标决策节点 + pathEvents（提交历史）+ nextSeq 播种（跨周目单调）+ turnFloor + 可选 migration 报告。

#### `RunResume` — `run-graph-port.ts:73-90`
用途：「继续游戏」三态结果（fresh/ended/active）。

#### `BeginEdgeResult` — `run-graph-port.ts:93-101`
用途：beginEdge 判别联合（opened/fast_forward，M5.3 同选项快进）。

#### `RunGraphPort` — `run-graph-port.ts:103-163`
用途：剧情图运行时端口——restoreOrCreateRun（含 restart 语义）、retraceFrom、startRootRun、beginEdge、appendEdgeEvents、openDecision、reachEnding、currentOutlineRevision。
实现方：`RunGraphCoordinator`（`application/graph/run-graph-coordinator.ts:91`，单实现；`MemoryRunGraph` 为测试替身 `test-helpers.ts:98`）。
消费方：`game.ts:25,133`、`test-helpers.ts`。备注：实现方在 application 层（协调器状态机域，另见 05 号地图）。

### 3.15 src/core/ports/stats-store-port.ts（23 行）

#### `StatsSnapshot` — `stats-store-port.ts:6-13`
用途：结算统计形状（settledRuns/endings/edges 三计数）。

#### `StatsStorePort` — `stats-store-port.ts:15-23`
用途：load + recordSettlement（同周目重复结算 no-op 幂等）。
实现方：`StatsStore`（storage/stats-store.ts:28，单实现）。消费方：`run-graph-coordinator.ts:21,128`、`graph-view.ts`、`create-runtime-application.ts:282`、`web.ts:116-132`。

### 3.16 src/core/ports/story-generator-port.ts（180 行）

#### `GenerationIdentity` — `story-generator-port.ts:30-39`
用途：每个生成请求显式携带的身份上下文四件套（protocolVersion/rosterRevision/cast/characterState，C5 §5.1）。

#### `legacyGenerationIdentity(cast)` — `story-generator-port.ts:42-51`
用途：roster 缺席的 legacy 会话兼容视图。消费方：`game.ts`。

#### `OpeningRequest` — `story-generator-port.ts:53-63`
用途：开局生成请求（identity/turn/state/signal/briefing/tailVisualState）。以下 `ContinuationRequest`(:65-79)、`BranchPrefetchRequest`(:81-94)、`InputResponseRequest`(:96-109)、`InputBridgeRequest`(:111-122) 同族，按生成场景区分 history/choice/interaction/playerInput 载荷。

#### `GenerationHandle` — `story-generator-port.ts:124-136`
用途：生成任务句柄——id、events（AsyncIterable 流式事件组）、done（完成信封 Promise）、cancel。

#### `StoryGeneratorPort` — `story-generator-port.ts:138-144`
用途：五种生成入口（generateOpening/Continuation/BranchPrefetch/InputResponse/InputBridge），均返回 GenerationHandle。
实现方：`GeneratorPortFacade`（`adapters/llm/openai-compatible-generator.ts:1826`，单实现）。消费方：`game.ts:323`、`interaction-driver.ts`、`game-test-kit.ts`。

#### `GenerationRunner` — `story-generator-port.ts:147-150`
用途：被包装的 promise+onGroup provider 形状类型。

#### `createGenerationHandle(id, run)` — `story-generator-port.ts:157-180`
用途（关键步骤）：① new AbortController + AsyncEventQueue；② `run(signal, onGroup)` 启动，onGroup 推队列；③ done 的 finally 关闭队列；④ cancel 用 `controller.abort()`（有 reason 时包 DOMException AbortError）。
消费方：`openai-compatible-generator.ts`、`game-test-kit.ts`。

### 3.17 src/core/ports/tts-model-family.ts（30 行）

#### `QWEN3_TTS_SAMPLE_RATE = 24000` — `tts-model-family.ts:16`
用途：qwen3-tts 系固定采样率。

#### `TtsModelFamily = "qwen3-tts" | "cosyvoice"` — `tts-model-family.ts:19`
用途：合成模型族联合类型。消费方：`application/audio/audio-descriptor-factory.ts`、`config/voices.ts`。

#### `ttsModelFamilyOf(model)` — `tts-model-family.ts:26-30`
用途：按前缀判定模型族（qwen3-tts*/local-qwen3-tts → qwen3-tts，其余按 cosyvoice）。消费方：audio-descriptor-factory、config/voices。

### 3.18 src/core/ports/tts-provider-port.ts（58 行）

#### `TtsSynthesisRequest` — `tts-provider-port.ts:12-23`
用途：合成参数（pcm_s16le 固定格式），由 Node app 层编译。

#### `TtsStreamMetadata` — `tts-provider-port.ts:26-32` / `TtsCompletion` — `:34-39`
用途：会话起始元数据 / 完成结果（totalBytes/durationMs/providerRequestId）。

#### `TtsStreamSession` — `tts-provider-port.ts:47-51`
用途：活跃合成会话（metadata + chunks AsyncIterable + completion Promise）。

#### `TtsProviderPort` — `tts-provider-port.ts:53-58`
用途：`start(request, signal)` 返回流式会话。
实现方：`DashScopeCosyVoiceProvider`（adapters/tts/dashscope-cosyvoice-provider.ts:226）、`LocalQwen3TtsProvider`（local-qwen3-tts-provider.ts:55）、`MockStreamingTtsProvider`（mock-streaming-tts-provider.ts:78）——三实现（唯一多实现的外部服务端口）。
消费方：`application/audio/tts-task-service.ts`、`create-runtime-application.ts`。

### 3.19 src/adapters/storage/game-graph-store.ts（598 行，重点）

模块级 schema：`DecisionRecordSchema`（:73-77，索引行：id/sceneId/form，不含 entryState）、`EdgeRecordSchema`（:79-105，endState 以 unknown 透传 + refine「内联 ⟺ 结局端点或汇流边」）。

#### `GameGraphStore implements GraphStorePort` — `game-graph-store.ts:212-598`
用途：Node 剧情图存储；构造校验 GameIdSchema 并 resolve location（:224-234）；可选装配 `GraphIdentityContext`（:220,227）。

**写入/原子替换关键方法**（步骤为任务要求必给）：

- `putRosterBlob(roster)` — `:252-267`：① CharacterRosterSchema.parse；② 内存 Set 去重（rosterBlobRevisions）；③ fileExists 幂等跳过（不可变 blob 不覆写）；④ tmp 写 + rename 原子落盘；⑤ 登记 revision。
- `putDecision(node)` — `:349-359`：① DecisionNodeSchema.parse；② **先写快照再写索引行**（反向孤儿快照无害，索引在而快照缺 = 结构损坏）；③ appendRecord 索引行（id/sceneId/form）。
- `writeSnapshot(decisionId, snapshot)` — `:361-367`：① tmp 路径 = `<snapshotPath>.tmp-<pid>-<时间戳>-<随机>`；② writeFile tmp；③ rename 原子替换；④ ensureRosterBlobOf（快照引用的 roster revision 首次出现时落 blob）。
- `putEdge(edge)` — `:463-493`：① PlotEdgeSchema.parse；② 端点判定——结局端点或带 confluence 凭据 → endState **内联**进记录；③ 普通决策端点 → readSnapshot(后继 id) 读入口快照，`stableStringify` 键序无关比较，不一致大声抛错（§3.3 写入门禁）；④ appendRecord 追加 edges.jsonl。
- `putScene/putEnding/putRun` — `:300-303/:324-327/:329-332`：schema.parse 后 appendRecord（latest-wins 语义由读取端折叠）。
- `removeDecision(id)` / `removeEdge(id)` — `:314-316/:319-322`：M5.6 tombstone——追加 `{"id":…,"deleted":true}` 行；removeEdge 随后 deletePayload 清孤儿负载。
- `appendPayload(edgeId, event)` — `:526-532`：appendFile 追加一行 JSON 到 `graph/payloads/<edgeId>.jsonl`（回放数据）。
- `saveCursor(cursor)` — `:565-570`：tmp+rename 原子写 cursor.json；`clearCursor` — `:572-574`：rm force。

**读取与组合**：

- `getRosterBlob(revision)` — `:269-286`：读 blob；JSON 损坏抛错；CharacterRosterSchema.parse。备注：catch 分支（:274-275）吞掉**全部**读错误返回 null（含权限/占用，与 readJsonlLines 的「只吞 ENOENT」不一致）。
- `listScenes` — `:305-311`：parseJsonl + latestById 折叠。
- `getRun/listRuns` — `:334-345`：listRuns 用 parseJsonlWriteOrder 按**最近写入序**（末位=最近活动周目）。
- `getDecision(id)` — `:443-448`：全量解析 decisions.jsonl 折叠后查 id；命中则 composeDecision。
- `composeDecision(record)` — `:432-441`：索引行 + readSnapshot 组合成完整 DecisionNode。
- `readSnapshot(decisionId)` — `:413-430`：缺文件=结构损坏抛错；JSON 解析失败抛错；再走 normalizeSnapshotPayload。
- `normalizeSnapshotPayload(payload, where)` — `:375-411`：版本闸门——v4 直接过 StateSnapshotSchema；v3 需身份上下文（无 roster/无 context 均显式拒绝猜读），调 `upcastSnapshotV3ToV4`（core/graph/snapshot-upcast.ts）内存升级，原文件字节不动；v1/v2/未来版本经 assertSupportedSnapshotVersion 拒绝。
- `listDecisions/listEdges` — `:450-459/:513-522`：折叠后逐条 await compose（每条一次快照文件读）。
- `composeEdge(record)` — `:495-511`：内联 endState（结局/汇流）走同一 normalize 升级；普通端点从后继入口快照派生。
- `readPayload(edgeId)` — `:534-545`：逐行 JSON.parse + isStoredEvent 守卫，损坏行跳过。
- `listPayloadIds` — `:547-557`：readdir payloadsDir 过滤 .jsonl（**catch 全部错误返回 []**）。
- `deletePayload(edgeId)` — `:559-561`：rm force（孤儿负载清理）。
- `loadCursor` — `:576-597`：ENOENT=null；损坏 JSON/schema → console.warn 后按无活动周目处理返回 null（读取宽容例外：游标可重建）。
- `initialize` — `:244-248`：幂等建 payloads/snapshots/rosters 三目录。

**内部辅助**（模块级函数）：`stableStringify`（:112-121，键序无关 JSON 比较）、`readJsonlLines`（:123-134，读文件分行；只把 ENOENT 当空日志）、`fileExists`（:136-144）、`parseJsonl`（:150-152，委托 WriteOrder 后取 records=首次出现序）、`parseJsonlWriteOrder`（:155-201，逐行解析：tombstone 行登记删除、schema 失败行跳过、latest-wins Map、按最后写入位排序）、`latestById`（:204-206）。类私有：`filePath`（:236-238）、`appendRecord`（:240-242）、`ensureRosterBlobOf`（:289-296，identity 未装配或 revision 不匹配即跳过）。

### 3.20 src/adapters/storage/identity-upcaster.ts（303 行）

#### `IdentityUpcastScopeMismatchError` — `identity-upcaster.ts:53-64`
用途：legacy 映射 scope 与 roster scope 不一致时显式拒绝（不跨世界兜底）。

#### `CorruptV2SnapshotError` — `:67-72`
用途：新格式快照身份损坏（身份不可恢复）。

#### `LegacyUpcastContext` — `:78-83`
用途：升级上下文（roster 快照 + legacyMapping）。

#### `LegacyEventsUpcastResult` — `:98-102`
用途：升级后事件序列 + 诊断。

#### `noLegacyEventMigration(totalEvents)` — `:121-129`
用途：当前格式读回的零迁移报告（六类计数恒 0）。消费方：run-graph-coordinator（干净恢复拼装用）。

#### `upcastLegacyEvents(events, context)` — `:163-233`
用途：旧事件序列 → 新身份事件（纯函数，原数组/对象一律不动）。
关键步骤：① assertScopeMatch（scope 不一致抛错）；② 建 resolver + rosterIds 集；③ 逐事件——非对白透传计 `non_model_dialogue_untouched`；④ 对白走优先级链：已验证 ID（合法且在 roster）→ `identity_verified`；唯一 legacy alias → `alias_resolved`（upcastDialogueCopy 补 characterId/displayLabel）；⑤ 其余 unresolved：**原引用返回只读回放**，记录 `event:<seq>` 引用与诊断说明，绝不猜归因。
消费方：`run-graph-coordinator.ts:25,377`（恢复路径旧边负载升级）；`core/graph/snapshot-upcast.ts:164` 注释引用同纪律但不复用类。

#### `legacyEventContentSummary(events)` — `:239-251`
用途：内容摘要（seq|type|名牌|正文|line_id），断言迁移前后逐字节一致。消费方：game-graph-store.test.ts:24,574。

#### `buildSnapshotIdentityEnvelope(roster, characterLabels, dslProtocolVersion)` — `:265-282`
用途：由 roster 快照+名牌状态构造身份信封（协议版本显式注入，不恒写常量）。备注：main 图快照路径不走本函数（SnapshotIdentityState 由 Game 直写）；保留两分支可移植形状。

#### `parseSnapshotRoster(value)` — `:292-303`
用途：roster 快照结构校验，损坏抛 CorruptV2SnapshotError。

**内部辅助**：`assertScopeMatch`（:85-92）、`emptyCategoryCounts`（:104-113）、`upcastDialogueCopy`（:133-144，新副本补 characterId/displayLabel）、`unresolvedCategory`（:146-153）、`SnapshotRosterSnapshotSchema`（:285-290）。

### 3.21 src/adapters/storage/canon-store.ts（261 行）

#### `CanonStore` — `canon-store.ts:82-261`
用途：canon.json + canon.log.jsonl 适配器。备注：**未声明 `implements CanonStorePort`**（结构性兼容）；持有 `writeChain` 写互斥链（:91）。

- `constructor(gamesRoot, gameId)` — `:93-102`：内存空快照初始化。
- `getCanon()` — `:142-147`：同步读，未 load 先行抛错。
- `load()` — `:150-153`：显式加载；缺文件=空 canon（兼容 M3.3 前旧世界），JSON/结构损坏大声抛错（ensureLoaded :120-140）。
- `saveScaffold(world)` — `:156-161`：enqueue 包裹 saveScaffoldUnsafe；后者（:163-203）：① 存在性检查（canon.json 已存在大声拒绝覆写，只把 ENOENT 视为不存在）；② 构造 revision 0 快照；③ mkdir + tmp+rename 原子写；④ 追加 revision 0 日志行；⑤ 更新内存。
- `applyPromotion(ops, reason)` — `:205-207`：enqueue 包裹 applyPromotionUnsafe；后者（:209-260）：① 空批次拒绝；② ensureLoaded；③ **整批校验**——工作副本逐条应用（promote 查 id/content 重复、exception 查 id 重复，非法即整批拒绝不落盘）；④ revision+1；⑤ mkdir + tmp+rename 写全量；⑥ appendFile 追加日志行（revision/ops/reason/at）；⑦ 更新内存并返回新修订号。

**内部辅助**：`canonPath/logPath` getter（:104-110）、`enqueue`（:113-117，writeChain 串行化，前序失败不阻塞后续）、`ensureLoaded`（:120-140）。模块级 schema：`CanonCharacterSchema`（:21-30，control/initialLabel 宽容可选）、`CanonFileSchema`（:32-53）、`CanonOpSchema`（:55-73）、`CanonLogLine`（:75-80）。

### 3.22 src/adapters/storage/json-narrative-memory-store.ts（218 行）

#### `JsonNarrativeMemoryStore implements NarrativeMemoryStorePort` — `json-narrative-memory-store.ts:55-218`
用途：会话目录（`<sessionDir>/<sessionId>/`）记忆六工件。**无写互斥链**（依赖调用方串行）。

- `constructor(sessionDir, sessionId)` — `:64-66`：dir 拼接。
- `location` getter — `:68-70`。
- `load()` — `:84-114`：① 缺 state 文件（仅 ENOENT）→ EMPTY_STATE + loadJsonl episodes；② JSON 语法损坏 → 空态（不抛）；③ 结构损坏（safeParse 失败）同样降级空态；④ episodes 走 loadJsonl（损坏行跳过、按 id 去重）。
- `writeAtomic(filePath, content)` — `:117-124`：mkdir + tmp（含随机分量防同毫秒并发互踩）+ rename。saveState（:126-128）与 writeEndingReport（:214-217，EndingReportSchema.parse 后 pretty 写）共用。
- `appendEpisodes/appendOps/appendFacts/appendLessons` — `:130-136,198-208`：appendJsonl 泛化追加（空数组 no-op）。
- `loadFacts/loadLessons` — `:202-212`：loadJsonl + 对应 schema。
- `appendJsonl` — `:156-164`：join("\n") 一次 appendFile。
- `loadJsonl` — `:167-196`：逐行 parse + safeParse，损坏行跳过，**按 id first-wins 去重**（seenIds 首见保留）；外层 catch 缺文件→空。备注：与 game-graph-store 的 latest-wins 语义相反。

**内部辅助**：六个文件名常量（:35-40）、`EMPTY_STATE`（:42-53）、三个 path getter（:72-82,143-153）。

### 3.23 src/adapters/storage/music-theme-store.ts（175 行）

#### `MusicThemeStore implements MusicThemeStorePort` — `music-theme-store.ts:36-175`
用途：`music/themes.json`（目录+绑定）与 `music/scores/<themeId>.json`（谱面）；「首写即定稿」纪律（同 id 覆写=no-op）；writeChain 互斥（:45）。
备注：**端口 `MusicThemeStorePort` 定义在 `application/audio/scene-music-service.ts:39`**（core/ports 之外），且 adapter 反向依赖 application 文件（import :21）。

- `listThemes()` — `:96-98`：目录序（=落盘序）。
- `getBinding(sceneId)` — `:101-103`：未绑定 undefined（走作曲家决策）。
- `addTheme(meta, bind?)` — `:110-126`：enqueue 内——loadCatalog → 主题已存在 no-op（绑定仍补写）→ 无变化短路 → writeCatalog。
- `bindScene(sceneId, themeId)` — `:129-138`：enqueue 内只补绑定。
- `getScore(themeId)` — `:143-158`：ENOENT=undefined；损坏大声抛错。
- `putScore(themeId, score)` — `:165-174`：enqueue 内存在性复查（TOCTOU 防护）→ tmp+rename 首写。

**内部辅助**：`enqueue`（:54-58）、`loadCatalog`（:62-81，内存缓存，ENOENT=空目录，损坏抛错）、`writeCatalog`（:83-93，tmp+rename 原子重写）。模块级：`ThemeCatalogFileSchema`（:23-29，version:1 strict）、`ThemeCatalog`（:31-34）。

### 3.24 src/adapters/storage/outline-store.ts（178 行）

#### `OutlineStore implements OutlineStorePort` — `outline-store.ts:34-178`
用途：outline.json + outline.log.jsonl；writeChain 互斥（:44）；损坏大声抛错（大纲是结构真源）。

- `getOutline()` — `:92-97`：同步读，未 load 抛错。
- `load()` — `:100-103`：ensureLoaded（:68-90，ENOENT=空大纲 revision 0；JSON/结构损坏抛错）。
- `applyRevision(ops, reason)` — `:105-107`：enqueue 包裹；`applyRevisionUnsafe`（:109-177）关键步骤：① 空批次拒绝；② ensureLoaded；③ **整批校验**——byId Map 工作副本逐条迁移：add（查重 + 只收 planned，决议 D5）、activate/realize/prune 走 `transitionOutlineNode` 状态机（非法迁移整批拒绝不落盘）；④ tmp+rename 原子写全量 `{revision, nodes}`；⑤ appendFile 追加日志行；⑥ 更新内存返回新修订号。

**内部辅助**：`outlinePath/logPath` getter（:52-65）、`enqueue`（:57-61）、`ensureLoaded`（:68-90）。模块级：`OutlineFileSchema`（:22-25）、`OutlineLogLine`（:27-32）。

### 3.25 src/adapters/storage/stats-store.ts（118 行）

#### `StatsSnapshot`（re-export）— `stats-store.ts:26`
用途：类型再导出（port 侧类型的便捷转发）。

#### `StatsStore implements StatsStorePort` — `stats-store.ts:28-103`
用途：stats.json 幂等结算计数；writeChain 互斥（:36）；读宽容（ENOENT=空）+ 损坏大声抛错。

- `load()` — `:50-69`：内存缓存 snapshot；ENOENT=空统计；StatsFileSchema.parse（损坏抛错）。
- `recordSettlement(runId, endingId, traversedEdgeIds)` — `:75-81`：enqueue 包裹；`recordSettlementUnsafe`（:83-102）：① load；② settledRuns 含 runId 直接返回（幂等 no-op）；③ settledRuns 追加 + bump 结局 + bumpAll 边；④ mkdir + tmp+rename；⑤ 更新缓存返回。

**内部辅助**：`enqueue`（:43-47）、模块级 `bump`（:105-109，计数 +1 或新建条目）、`bumpAll`（:111-118）、`StatsFileSchema`（:17-24）。

### 3.26 src/adapters/storage/voice-design-store.ts（81 行）

#### `VoiceDesignFile` — `voice-design-store.ts:22-25`
用途：音频画像文件形状（version:1 + characters 记录）。消费方：`application/audio/voice-design-views.ts:12`（application 反向 import adapter 类型）。

#### `VoiceDesignStore` — `:44-81`
用途：`world/voice-design.json`——世界创建期写一次，拒绝覆写（沿 canon 脚手架纪律）；缺失=undefined、损坏大声抛错。
- `save(file)` — `:55-67`：access 存在性检查（已存在抛错）→ mkdir + tmp+rename。
- `load()` — `:70-80`：ENOENT=undefined；JSON/schema 损坏抛错。
备注：**全仓唯一没有任何端口接口的 store**（具体类直接被消费）；且 :10-11 从 `application/outline/outline-writer.js` import `CharacterVoiceDesignSchema`（adapter → application 反向依赖，schema 唯一真源在 application）。

**内部辅助**：`filePath`（:50-52）、模块级 `VOICE_DESIGN_FILE` 常量（:14）、`StoredVoiceDesign`（:17-20）、`VoiceDesignFileSchema`（:29-42，strict）。

### 3.27 src/adapters/storage/composer-session-store.ts（67 行）

#### `ComposerSessionStore implements ComposerSessionStorePort` — `composer-session-store.ts:28-67`
用途：`music/session.jsonl` 追加式作曲家会话（user=brief JSON / assistant=决策摘要，不存完整谱面）。
- `append(turn)` — `:40-43`：mkdir + appendFile（O_APPEND 单行原子性由内核保证）。
- `readRecent(maxTurns)` — `:46-66`：ENOENT=空会话；**任一行解析失败大声抛错**（会话损坏即不可信，与其他 JSONL 的跳行策略不同）；slice(-maxTurns) 取最近窗口。
备注：端口 `ComposerSessionStorePort` 定义在 `application/audio/scene-music-service.ts:49`（core/ports 之外）；adapter 反向依赖 application（import :21）。**无写互斥**（追加单行靠内核原子性）。

**内部辅助**：`SessionLineSchema`（:23-26）。

### 3.28 src/adapters/storage/review-store.ts（68 行）

#### `ReviewStore implements ReviewStorePort` — `review-store.ts:19-68`
用途：`reviews/<runId>.json` 每完结周目一份。
- `save(review)` — `:32-38`：ReviewFileSchema.parse → mkdir → tmp+rename。
- `load(runId)` — `:40-53`：ENOENT=null，其余（含损坏）抛错。
- `list()` — `:55-67`：readdir 过滤 .json 逐个 parse（损坏抛错），按 reviewedAt 排序；**readdir 的 catch 吞掉全部错误返回 []**（:58-61，含权限错误）。
备注：无写互斥；无测试文件。**内部辅助**：`reviewPath`（:26-30，runId 去前缀 + 字符清洗防目录穿越）、`ReviewFileSchema`（:11-17）。

### 3.29 src/adapters/storage/stored-event.ts（34 行）

#### `isStoredEvent(value)` — `stored-event.ts:7-34`
用途：StoredEvent 磁盘行守卫（v2 边负载唯一校验入口）：信封五字段（seq/turn/timestamp/source/type）+ 按 source×type 分派——model 侧 dialogue/narration 走 Draft schema + line_id、interaction **剥信封后**过 strictObject 的 InteractionEventSchema（:25，v1 潜伏 bug 的修复注释）、end 校验 ending_id/text；player 侧 choice/input/dialogue 逐类型校验。
消费方：`game-graph-store.ts:20,539`（readPayload 行过滤）。

### 3.30 src/adapters/static/story-plan-loader.ts（222 行）

#### `StoryPlan` — `story-plan-loader.ts:31-38`
用途：作者静态故事计划形状（threads/setups/anchors）。

#### `loadStoryPlan(path, diagnostics?)` — `:168-222`
用途：读取并归一 story-plan.yaml。
关键步骤：① ENOENT → 空计划（文件可选）；② yaml parse（空文档=空计划）；③ PlanShapeSchema 顶层结构校验（失败大声抛错，启动失败）；④ 三类条目分别 parseThread/parseSetup/parseAnchor——snake_case→camelCase 键归一（normalizeKeys），单条 zod 失败 **跳过 + diagnostics.warn** 不拖垮整计划；⑤ setup 缺 intended_payoff 只 warn（brief 标注，运行时 seed 硬拒）。
消费方：`create-runtime-application.ts:582`（config `narrative.story_plan_path`）。

**内部辅助**：`toCamelCase`（:50-54）、`normalizeKeys`（:57-66）、`formatZodError`（:69-73）、`parseThread`（:75-98，source 强制 "author"）、`parseSetup`（:100-133，status 强制 planned）、`parseAnchor`（:135-157，status 强制 pending）、`PlanShapeSchema`（:43-47）、`WARN_SCOPE`（:40）。

### 3.31 src/adapters/static/character-pack-loader.ts（81 行）

#### `loadCharacterPackRoster(filePath)` — `character-pack-loader.ts:38-81`
用途：characters.yaml → CharacterRoster（静态 fallback 世界身份真源）。
关键步骤：① readFile（失败包装错误抛出）；② yaml parse（失败包装抛出）；③ CharacterPackFileSchema（schemaVersion:2 strict）校验；④ buildCharacterRoster 计算 revision；⑤ 文件手写 revision 与计算值不符大声抛错（防篡改）。
消费方：`create-runtime-application.ts:403`（fallback roster）、`web.ts:72`、`cli.ts:64`。

**内部辅助**：`CharacterPackFileSchema`（:23-31）。

### 3.32 src/adapters/platform/console-diagnostic-sink.ts（21 行）

#### `ConsoleDiagnosticSink implements DiagnosticSink` — `console-diagnostic-sink.ts:9-21`
用途：终端诊断格式化——`info`：scope="player" 原样打印、其余 ANSI dim；`warn`：stderr。
消费方：`create-runtime-application.ts`（默认诊断通道，多处 `new ConsoleDiagnosticSink()`）、web/cli 宿主。

### 3.33 src/adapters/platform/session-id-generator.ts（33 行）

#### `SessionIdGenerator implements IdGeneratorPort` — `session-id-generator.ts:10-33`
用途：Node 宿主时间基 ID——nextSessionId = ISO 时间戳替换 `[:.]` 为 `-`（安全文件名）；nextLineId/nextGenerationId/nextPreviewId 各持单调计数器（单实例不重号）。
消费方：`create-runtime-application.ts`（Game 装配 `ids: new SessionIdGenerator()`）。

### 3.34 src/adapters/platform/system-clock.ts（12 行）

#### `SystemClock implements ClockPort` — `system-clock.ts:4-12`
用途：真实墙钟（Date.now / toISOString）。消费方：`create-runtime-application.ts`（两处 `new SystemClock()`：buildGraphCoordinator 与 Game 装配）。

## 4. 端口全景表

| 端口 | 定义文件 | 实现类/文件 | 被谁消费（生产，非测试） | 备注 |
|---|---|---|---|---|
| AgentRunnerPort | core/ports/agent-runner-port.ts | AgentRunnerAdapter（adapters/llm/agent-runner-adapter.ts:20） | director-service | 单实现；端口文件含常量 MAX_AGENT_TOOL_STEPS |
| CanonStorePort | core/ports/canon-store-port.ts | CanonStore（adapters/storage/canon-store.ts:82） | canon-promoter、director-service、run-graph-coordinator（类型）；world-generator（**直接用具体类**） | 单实现；实现方未声明 implements |
| ClockPort | core/ports/clock-port.ts | SystemClock（platform/system-clock.ts:4）；FakeClock（test-helpers.ts:160，测试） | game.ts、interaction-driver、run-graph-coordinator、confluence-checker、create-runtime-application | 双实现（其一为测试替身） |
| ConfluenceJudgePort | core/ports/confluence-judge-port.ts | ConfluenceJudgeAdapter（adapters/llm/confluence-judge-adapter.ts:46） | confluence-checker、run-graph-coordinator、director-service（可选） | 单实现；签名冻结契约 |
| DiagnosticSink | core/ports/diagnostic-sink.ts | ConsoleDiagnosticSink（platform）；RecordingDiagnostics（narrative-director-test-kit.ts:145，测试）；silentDiagnosticSink（端口内 null 对象） | game.ts、interaction-driver、6 个 llm adapter、application 各 service、bootstrap、story-plan-loader | 全仓消费面最广；端口文件自带实现 |
| GraphStorePort | core/ports/graph-store-port.ts | GameGraphStore（adapters/storage/game-graph-store.ts:212） | run-graph-coordinator、director-service、confluence-checker、canon-promoter、graph-view、create-runtime-application、web.ts | 单实现；21 成员最大存储端口 |
| IdGeneratorPort | core/ports/id-generator-port.ts | SessionIdGenerator（platform/session-id-generator.ts:10）；FakeIdGenerator（test-helpers.ts:174，测试） | game.ts、interaction-driver、create-runtime-application | 双实现（其一为测试替身） |
| MediaPlannerPort | core/ports/media-planner-port.ts | AudioIntentPlanner（application/audio/audio-intent-planner.ts:33） | game.ts、interaction-driver、game-test-kit | 单实现；**实现在 application 层**；含过渡性 readiness 查询 |
| NarrativeDirectorPort | core/ports/narrative-director-port.ts | NarrativeDirectorService（application/narrative/narrative-director-service.ts:149） | game.ts、interaction-driver、game-test-kit、create-runtime-application | 单实现；实现在 application 层 |
| NarrativeMemoryStorePort | core/ports/narrative-memory-store-port.ts | JsonNarrativeMemoryStore（storage）；FakeStore（narrative-director-test-kit.ts:43，测试） | narrative-director-service、narrative-director-test-kit | 单生产实现 |
| OutlineStorePort | core/ports/outline-store-port.ts | OutlineStore（storage/outline-store.ts:34） | run-graph-coordinator、director-service、graph-view、create-runtime-application、web.ts；world-generator（直接实例化） | 单实现 |
| ReviewStorePort | core/ports/review-store-port.ts | ReviewStore（storage/review-store.ts:19） | run-graph-coordinator、create-runtime-application、web.ts | 单实现；实现无测试 |
| RunGraphPort | core/ports/run-graph-port.ts | RunGraphCoordinator（application/graph/run-graph-coordinator.ts:91）；MemoryRunGraph（test-helpers.ts:98，测试） | game.ts | 单生产实现；实现在 application 层（协调器域） |
| StatsStorePort | core/ports/stats-store-port.ts | StatsStore（storage/stats-store.ts:28） | run-graph-coordinator、graph-view、create-runtime-application、web.ts | 单实现 |
| StoryGeneratorPort | core/ports/story-generator-port.ts | GeneratorPortFacade（adapters/llm/openai-compatible-generator.ts:1826） | game.ts、interaction-driver、game-test-kit | 单实现；端口文件含 3 个可运行 helper |
| TtsProviderPort | core/ports/tts-provider-port.ts | DashScopeCosyVoiceProvider、LocalQwen3TtsProvider、MockStreamingTtsProvider（adapters/tts） | application/audio/tts-task-service、create-runtime-application | **三实现**（真×2 + mock）——唯一多实现外部服务端口 |
| TtsModelFamily（模块） | core/ports/tts-model-family.ts | （纯函数，无接口） | audio-descriptor-factory、config/voices | 非端口：模型族判定纯函数 |
| 身份信封规范（模块） | core/ports/identity-snapshot-port.ts | （类型 + rosterSnapshotOf/noLegacyEventMigration 等纯函数） | game-graph-store、run-graph-coordinator、snapshot-upcast、identity-upcaster、create-runtime-application、web.ts | 非端口：共享类型模块 |

**定义在 core/ports 之外的端口**（grep `export interface *Port` 全仓核实）：
- `MusicThemeStorePort`、`ComposerSessionStorePort`、`SceneMusicComposerPort` — `application/audio/scene-music-service.ts:39,49,62`
- `CanonAdjudicatorPort` — `application/canon/canon-promoter.ts:30`
- `MemoryConsolidatorPort` — `application/narrative/memory-consolidator.ts:123`
- `OutlineWriterPort`、`OutlineMaintainerPort` — `application/outline/outline-writer.ts:109,118`
- **无端口的 store**：`VoiceDesignStore`（具体类直接消费）。

## 5. 域内数据流：一次剧情图持久化

以「玩家解决交互 → 新边开放 → 事件入负载 → 交互打开落决策节点」为例（均在 `games/<gameId>/` 布局，路径常量来自 `core/graph/ids.ts:45-79` 的 GAME_STORAGE_LAYOUT）：

1. **开边**：Game/InteractionDriver 调 `RunGraphPort.beginEdge`（run-graph-port.ts:135）→ `RunGraphCoordinator`（mutationChain 串行，run-graph-coordinator.ts:186-189）查同选项快进（命中则 `saveCursor` 前移并返回 restore，run-graph-coordinator.ts:565）；未命中 → `GameGraphStore.putEdge`（game-graph-store.ts:463-493）：PlotEdgeSchema.parse → 普通决策端点 `readSnapshot(后继 id)`（:484）+ `stableStringify` 相等门禁 → `appendRecord` 追加 `graph/edges.jsonl`（:492）。
2. **边负载追加**：每条已提交事件走 `RunGraphPort.appendEdgeEvents` → coordinator（:590）→ `GameGraphStore.appendPayload`（:526-532）→ `appendFile` 追加 `graph/payloads/<edgeId>.jsonl`（O_APPEND，内核单行原子）。回读走 `readPayload`（:534-545）+ `isStoredEvent` 行守卫。
3. **落决策节点**：交互正式打开 → `RunGraphPort.openDecision` → coordinator（:623）→ `GameGraphStore.putDecision`（:349-359）：① `DecisionNodeSchema.parse`；② `writeSnapshot`（:361-367）——tmp 写 `graph/snapshots/<decisionId>.json` → `rename` 原子替换 → `ensureRosterBlobOf`（:289-296）→ `putRosterBlob`（:252-267，revision 幂等，tmp+rename 落 `world/rosters/<revision>.json`）；③ `appendRecord` 追加 `graph/decisions.jsonl` **索引行**（不含 entryState——入口快照唯一物理真源 = 快照文件）。
4. **游标推进**：coordinator `saveCursor`（game-graph-store.ts:565-570，tmp+rename `cursor.json`）。
5. **周目/场景记录**（伴随写入）：`putScene`（场景节点按需惰性创建，coordinator :712/:919）、`putRun`（latest-wins 追加 `graph/runs.jsonl`，:329-332）；周目完结时 `reachEnding` → `putEnding`（:836）+ `putEdge`（结局端点 endState **内联**，:841）+ `putRun`（abandonedAt/endedAt 更新行，:855）+ `clearCursor`（:864）。
6. **读取/恢复链**（反向）：`restoreOrCreateRun` → `loadCursor`（:576-597，损坏 warn 后按 null）→ `getDecision`（:443-448，全量解析 decisions.jsonl 折叠）→ `composeDecision`（:432-441）→ `readSnapshot`（:413-430）→ `normalizeSnapshotPayload`（:375-411，v3 经 `upcastSnapshotV3ToV4` 内存升级，字节不动）→ `readPayload` 读路径事件 → `upcastLegacyEvents`（identity-upcaster.ts:163-233）内存升级旧对白 → 组装 `RestorePoint`（含 nextSeq 播种与可选 migration 报告）。

快照与事件两条恢复路径的升级纪律一致：**原字节永不改写，升级只在内存副本**（game-graph-store.test.ts:409-436 的 dirFingerprint 断言守护）。

## 6. 跨域接口与测试覆盖

**跨域接口（本域向外的边界）**：core 层类型（graph/types、characters/types、narrative/memory-types、outline/types、schema.js、story/types、protocol/gal-dsl/types）被端口与适配器大量引用；`RunGraphPort` 的实现方 RunGraphCoordinator 在 application/graph 域（见 05 号地图）；LLM/TTS 适配器域见 03/06 号地图；`GraphIdentityContext` 的装配源（world-roster/legacy-identity）在 application/characters 域。

| 测试文件（行数） | 覆盖点 |
|---|---|
| storage/game-graph-store.test.ts（684） | 布局（gameId 拒绝、目录创建）；决策快照真源（索引行不含 entryState :80-83、快照缺失抛错 :88-99）；边 endState 门禁（一致通过 :116-138 / 不一致拒 :140-160 / 汇流内联免门禁 :162-191 / 结局端点内联 :193-212 / latest-wins :214-243）；payload（顺序追加/损坏行跳过/interaction 信封回归 :276-300）；cursor roundtrip + 损坏读 null :302-317；**v3→v4 fixture 矩阵**（R24/R25：升级读取字节不变 :409-436、无身份上下文显式拒 :439-447、v1/v2 读取即拒 :449-478、roster blob 幂等 :480-512、干净 v4 无 migration :514-550、旧负载 alias 升级 :552-584、unresolved 只读回放 :586-623、ambiguous 显式失败 :625-652、旧 canon/voice-design 宽容读取 :654-683） |
| storage/identity-upcaster.test.ts（285） | upcastLegacyEvents 六类样本向量（R24/R25 共用）；noLegacyEventMigration / buildSnapshotIdentityEnvelope |
| storage/canon-store.test.ts（194） | CanonStore（scaffold 拒覆写/整批校验/日志） |
| storage/json-narrative-memory-store.test.ts（298） | JsonNarrativeMemoryStore；MA-A channels（facts/lessons/ending-report） |
| storage/music-theme-store.test.ts（167） | MusicThemeStore（首写定稿/绑定/互斥） |
| storage/outline-store.test.ts（155） | OutlineStore（整批事务/状态机校验） |
| storage/stats-store.test.ts（62） | StatsStore（幂等结算） |
| storage/voice-design-store.test.ts（63） | VoiceDesignStore（写一次拒覆写） |
| storage/composer-session-store.test.ts（68） | ComposerSessionStore（窗口截断/损坏抛错） |
| storage/review-store.ts | **无测试文件** |
| static/story-plan-loader.test.ts（260） | loadStoryPlan（缺文件空计划/单条跳过 warn/结构错误抛） |
| static/character-pack-loader.test.ts（204） | loadCharacterPackRoster（玩家契约 + 破损大声失败两组） |
| platform/session-id-generator.test.ts（50） | SessionIdGenerator（单调不重号） |
| platform/console-diagnostic-sink.ts、system-clock.ts | 无测试文件 |
| ports/story-generator-port.test.ts（200） | createGenerationHandle（流式发布/done/cancel）；StoryGeneratorPort contract；GeneratorPortFacade |

## 7. 重构关注点（事实清单）

1. **写互斥样板重复且覆盖不齐**：`enqueue`（writeChain 串行化）同一段 5 行代码在 4 个 store 重复——`canon-store.ts:113-117`、`outline-store.ts:57-61`、`stats-store.ts:43-47`、`music-theme-store.ts:54-58`；`GameGraphStore` 无 store 级互斥（串行化依赖消费方 `run-graph-coordinator.ts:105` 的 mutationChain），`JsonNarrativeMemoryStore`/`ReviewStore`/`VoiceDesignStore`/`ComposerSessionStore` 完全无互斥——同一仓内两层（store 自身设防 vs 调用方保证）混用。
2. **tmp+rename 原子写无共享工具**：tmp 名模式 `` `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` `` 内联重复 12 处——`game-graph-store.ts:262,363,567`、`canon-store.ts:191,247`、`outline-store.ts:159`、`stats-store.ts:97`、`music-theme-store.ts:85,170`、`json-narrative-memory-store.ts:121`（唯一写了随机分量注释）、`review-store.ts:35`、`voice-design-store.ts:63`。
3. **ENOENT/读错误处理不一致**：`game-graph-store.ts:130`（readJsonlLines 只吞 ENOENT，其余抛——注释明确说明吞错的危害）vs 同文件 `getRosterBlob` :274-275 与 `listPayloadIds` :551-553（catch 全部返回 null/[]）；`review-store.ts:58-61`（list 的 readdir catch 全部返回 []）；`json-narrative-memory-store.ts:192-194`（loadJsonl 外层 catch 全部）。同为「读宽容」，边界宽窄不一。
4. **两套 JSONL 读取器去重语义相反**：`game-graph-store.ts:155-201` parseJsonlWriteOrder = latest-wins（同 id 取最后）+ tombstone 折叠；`json-narrative-memory-store.ts:167-196` loadJsonl = **first-wins**（seenIds 首见保留）无 tombstone。同为 append-only JSONL 却是两种折叠模型。
5. **CanonStore 未声明 implements CanonStorePort**（`canon-store.ts:82`）——契约靠结构兼容维持，端口演进无编译期保护（对比 OutlineStore/StatsStore/ReviewStore/JsonNarrativeMemoryStore 均有声明）。
6. **适配器反向依赖 application 层**：`music-theme-store.ts:21`、`composer-session-store.ts:21` import `application/audio/scene-music-service.js` 的端口；`voice-design-store.ts:10-11` import `application/outline/outline-writer.js` 的 `CharacterVoiceDesignSchema`。端口定义与 schema 真源落在 application，storage adapter 反向依赖之。
7. **application 反向实例化具体 store**：`application/world/world-generator.ts:182`（new OutlineStore）、`:220`（new CanonStore）、`:233`（new VoiceDesignStore save）、`:135`（VoiceDesignStore load）；`application/graph/run-graph-coordinator.ts:25` 直接 import adapter 的 `upcastLegacyEvents`；`application/audio/voice-design-views.ts:12` import adapter 的 `VoiceDesignFile` 类型——依赖方向与端口-适配器意图相悖（world-generator 与 coordinator 应只见图/大纲端口）。
8. **VoiceDesignStore 无端口**：全仓唯一没有 Port 抽象的 store，消费方直接持具体类（world-generator、create-runtime-application.ts:241、voice-design-views）。
9. **读取放大**：`getDecision`（`game-graph-store.ts:443-448`）每次调用全量读+解析 decisions.jsonl；`listDecisions`/`listEdges`（:450-459/:513-522）对每条记录各 await 一次快照文件读（O(n) 文件 IO）；`putEdge`（:484）每次写边重读后继快照。协调器恢复路径叠加这些调用。
10. **store 内直呼系统时间**：`canon-store.ts:198,234,254` 与 `outline-store.ts:170` 落盘日志行用 `new Date().toISOString()`——adapter 未注入 ClockPort，与 clock-port.ts:3-7 的可注入纪律不一致（GameGraphStore 的协调器侧时间由注入 clock 提供，对比鲜明）。
11. **死导出**：`rosterSnapshotOf`（identity-snapshot-port.ts:53-60）全仓无消费方。
12. **测试空洞**：`review-store.ts` 无测试文件；`console-diagnostic-sink.ts`、`system-clock.ts` 无测试；`stored-event.ts` 仅经 game-graph-store.test.ts 间接覆盖（:276-300 interaction 信封回归）。
13. **端口文件职责混合**：`diagnostic-sink.ts:17-20`（null 对象实现）、`story-generator-port.ts:42-51,157-180`（legacyGenerationIdentity/createGenerationHandle 可运行 helper）、`identity-snapshot-port.ts`（整文件是共享规范而非端口）——「ports 目录 = 纯契约」的约定被三处打破。
14. **JSONL 损坏行策略分裂**：图记录/payload「损坏行跳过不掩盖后续」（game-graph-store.ts:189-191,540-542）vs 作曲家会话「任一行损坏大声抛错」（composer-session-store.ts:60-64）vs canon/outline 全量文件「损坏即抛」——三种策略并存各有理由（注释均有说明），但无统一文档化判据。

## 附A · 设计评注（观察与可能方向，非约束）

1. **ENOENT-only 读判据**：现状判据 = 语义上"文件不存在 = 合法空态"的列举读（sessions 目录未建、首轮周目无记录）才只吞 ENOENT，其余 fs 错误抛出。因果链（game-graph-store.ts:123-134）：吞掉非 ENOENT 读错误 → 恢复路径 `worldMaxSeq` 归零 → 新边 seq 与既有边撞号 → 静默数据损坏。`fileExists`（:136-144）同纪律。本文件 §7.3 所列三处 catch-all（getRosterBlob:274-275、listPayloadIds:551-553、review-store.ts:58-61）与判据相悖，属历史遗留——若希望"照抄邻居"在机制上不可能，共享 `isMissingFile(err)` 工具（OP-19 已含）是一种形态。
2. **缺文件 ≠ 坏文件的粒度区分**：json-narrative-memory-store 整文件级（fs 错误 ENOENT-only、解析失败保空不抛——"记忆丢了游戏还能跑"）；game-graph-store 单行级（坏行跳过不掩盖后续）。两种容错语义各有适用面，表驱动文档化（10 §7.14 三策略的收口）是常见整理方向。
