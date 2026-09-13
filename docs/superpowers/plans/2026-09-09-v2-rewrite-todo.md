# vibe-gal-v2 破坏性重构执行清单

日期：2026-09-09。设计依据：`docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md`（已批准）。
本清单是**活文档**：完成即勾选；偏离设计处记入文末「偏差记录」；每阶段结束必须通过卫生门才能进入下一阶段。

## 执行规则

1. **动手前先查「反重复地图」**——任何需求先确认没有既有组件可复用。
2. **卫生门强制**：GH-1（代码卫生）与 GH-2（文档卫生）未过，不开下一阶段。
3. ⚠ 标记 = 高风险项：先做设计细化或 spike，再动代码。
4. 破坏性重构：不留兼容层；被替换系统在所属阶段内**立即删除**（不留「暂时共存」）。
5. 里程碑完成即 commit（main），不攒大包。

## M0 基线与契约冻结 ✅（2026-09-09）

- [x] M0.1 基线验证：`backup/pre-v2-prototype` 存在；main 全量测试 + 双 typecheck 绿（基线 1330 测试 / 86 文件）
- [x] M0.2 图契约代码化：`src/core/graph/types.ts`——SceneNode / DecisionNode / PlotEdge / EndingNode / RunRecord / ActiveCursor / StateSnapshot（zod schema + 类型），单测覆盖解析与拒绝
- [x] M0.3 大纲契约代码化：`src/core/outline/types.ts`——OutlineNode / 状态机（planned→active→realized；pruned），单测
- [x] M0.4 ID 规则与存储布局常量：`src/core/graph/ids.ts`（前缀 schema + GAME_STORAGE_LAYOUT + 边负载/快照路径函数）
- [x] **GH-0 卫生门**：1380 测试全绿（+50）、双 typecheck ✓、build ✓；无被替换系统残留（本阶段纯新增）；architecture.test 随全量通过


## M1 图存储内核 + 演员接图（存档读档闭环）

- [x] M1.1 ⚠ 设计细化：记忆子层 v2 持久化（细化决议见下方「M1.1 设计细化」节）
- [ ] M1.2 GraphStore port + JSON/JSONL adapter（§9 布局：scenes/decisions/edges/endings/runs/payloads/snapshots/cursor/stats）
- [ ] M1.3 演员接图：Game 提交路径改造——段事件 → 边负载；交互开启 → 决策节点 + 入口快照；交互解决 → 出边 + 末态快照
- [x] M1.4 ✅ 游标与恢复：cursor.json；「继续游戏」= 载入节点入口快照重建运行时（Game 必须可从 StateSnapshot 完整重建——本阶段最高风险，先写恢复路径的集成测试再实现）。落地形态见下方「游标恢复的三态入口」；恢复集成测试：协调器 6 例 + Game 真存储跨重启 2 例 + 守卫回归 1 例。
- [x] M1.5 ✅ 新周目入口：root 开局 / retrace（载入快照 → 重放表单 → 新选择产生新边）。落地：`restoreOrCreateRun({restart:true})`——弃局活跃周目（abandonedAt=游标位）→ 游标节点开 retrace 新周目（CurrentRun 携带 origin，结局回写不再覆盖来源）→ 表单重放；bootstrap `restart()`（restart_session 指令路径）以 runMode="restart" 重建。同选项快进**推迟到 M5.3**（见下方 M5.3 注记）。
- [ ] M1.6 删除：sessions JSONL store、SessionStorePort 及全部引用；`sessions/` 运行时写路径。event mode / forced ending **暂留**（M3.5 由大纲结局驱动替代时删）
- [ ] **GH-1 + GH-2**

### M1.1 设计细化（2026-09-13 决议）

**真源层级**（恢复路径按此读取，不越级）：

1. `graph/snapshots/<decisionId>.json` = 运行时状态**唯一真源**（story + visual + memoryDigest）。「继续游戏」只读这里。
2. `graph/payloads/<edgeId>.jsonl` = 回放数据（UI/结算/审计），不是记忆真源。记录形状 = `StoredEvent` 直接逐行落盘（自带 seq/turn/source，零转换）。
3. `world/canon.json`（M3.6 落地）= 跨周目世界真理。
4. NarrativeMemoryStore 会话文件 = **工作缓存**（可丢弃可重建）：
   - `narrative-state.json`：恢复路径**不读**；consolidator 照常低频写穿，恢复后被 digest 重建态自然覆盖；
   - `episodes.jsonl`：恢复后从空重新积累（episodes 本就是 consolidator 的派生产物）；
   - `director-plan.json`：维持现状，直到 M4.4 随 DirectorPlan 一起处理。

**digest ↔ NarrativeMemoryState 纯映射**（新模块 `src/core/graph/memory-digest.ts`，core→core 依赖）：

- `memoryDigestFromState(state)`：丢 `recentEpisodeIds`（recent 指针属于 episodes 缓存，不入契约）；
- `memoryStateFromDigest(digest)`：`recentEpisodeIds` 重建为 `[]`。
- 引用制一句话：**周目内记忆随快照走，跨周目事实走引用**——Phase B facts/beliefs 进 digest 时只存 canon 事实 id 引用 + 摘要，内容唯一存放于 canon.json。

**NarrativeDirectorPort 扩展**（M1.3/M1.4 消费）：

- `getMemoryDigest(): MemoryDigest`——交互打开瞬间取记忆态嵌入入口快照；
- `restoreFromDigest(digest)`——恢复路径用它替代 `initialize()` 的 store.load() 分支。

**恢复点语义**：恢复 = 回到游标所在决策节点入口（交互打开那一刻）。有 payload 文件但无 edges 记录的孤儿文件在恢复时删除，重新生成走新边 id。首个决策点之前的开局段崩溃 → 无恢复点，重开新周目（dev 接受）。

**快照复用不变量**：下一个决策点的入口快照 = 前一条边的 endState（同一次快照写两处）；ending 收束时 endState 单独捕获。汇流比较因此天然对齐同一种货币（§3.3 不变量成立的结构保证）。

**恢复时的记忆追赶（2026-09-13 补充；2026-09-14 修正）**：快照 digest 的 `consolidatedThroughEventSeq` 之前的已整理、之后的未整理。恢复路径在 digest 重建后，把**根→游标全路径的边负载**重新喂给 `director.observeCommitted()`——其内部按 `seq > watermark` 过滤，恰好只把未整理窗口重新入队，零契约变更。~~只喂入边 payload~~（2026-09-14 修正：checkpoint 只在 interaction_completed 触发后台整理，水位可能滞后到开局面——只喂入边会丢祖先边的未整理窗口；全路径喂入在水位之下无害）。**已知洞（dev 接受）**：开局段事件不入图（M1.1 决议），其未整理残余在恢复时不可回收——与「首个决策点之前崩溃重开」同性质，M4 导演剪报接管上下文后影响趋零。

**场景节点判定（M1 无编剧过渡）**：`StoryState.scene.id` 首次出现 → 建 SceneNode（status=active）；M1 bootstrap 单个 seed 大纲节点（`ol_` 前缀、active）作为全部场景的 outlineRef（修订 2026-09-13：种子大纲**文件** outline.json 随 M3.1 OutlineStore 落地，M1 只有引用目标 id）。realized 迁移不做（M5 结算细化）；M3.2 真实大纲落地后 dev 期不迁移旧 game。

**seq / turn 连续性（恢复后计数器播种；2026-09-14 精确化）**：契约不加字段。恢复时 `nextSeq = max(路径末事件 seq, digest.consolidatedThroughEventSeq) + 1`（**下一个分配槽位**——语义必须是新事件不与重放事件撞号；watermark ≤ 路径末 seq 恒成立）；turn 取路径末事件（即游标交互事件自身）的 turn，首决策（无入边）为 1。周目内 seq 严格单调递增，consolidator 的 `consolidatedThroughEventSeq` 语义保持成立。

**游标恢复的三态入口（2026-09-14，M1.4 落地形态）**：`RunGraphPort.restoreOrCreateRun(): RunResume`——`fresh`（无存档，内部已 startRootRun）/ `active`（游标恢复点：decision 节点 + pathEvents + nextSeq/turnFloor；协调器同时水合 currentRun/lastDecisionId/sceneNodes 缓存并清理孤儿 payload）/ `ended`（最新周目已完结：补发 session_ended，结局文本从末边负载回收，开局直落结局则用占位文本）。多入边节点取 `payload.lastSeq` 最大者（最近走过；M1.4 单入边下唯一）。Game 侧删除 v1 遗留 `resumeInteraction` 字段（v2 恢复真源是图游标+表单快照，不再有内存态恢复游标）；恢复时 `interactionCount` 清零（event mode 的 max_interactions 计数跨恢复不累计——event mode 本身 M3.5 删除）。



- [ ] M2.1 ConfluenceJudge port（接口签名按契约冻结）+ 首个 adapter（LLM 主观判定，复用现有 LLM client；确定性比较器为可插拔可选件，默认不实现）
- [ ] M2.2 场景内汇流：新边 endState vs 同场景既有决策节点入口态 → 命中即指向既有节点（判定凭据落盘到边）；异步后台，不阻塞播放
- [ ] M2.3 端到端验证：离谱输入 → 防守节拍引回 → 与既有路径汇流（图上如实呈现）
- [ ] M2.4 末态索引 + 场景间/滞后汇流（独立可勾，可后置到 M4 之后）
- [ ] **GH-1 + GH-2**

## M3 编剧（pi）+ 大纲图 + 世界生成

- [ ] M3.0 ⚠ pi agent 框架 spike：能力与接入方式调研（`.pi-subagents/` 现状、与现有 LLM client 的关系），产出决策记录；不确定处向作者确认
- [ ] M3.1 OutlineStore port + adapter（outline.json + append-only 修订日志：预测/剪枝/修订留痕）
- [ ] M3.2 编剧 agent：初版大纲生成（一至两个结局）；输入 = 用户文本描述（过渡期附 story_line.txt 作种子）
- [ ] M3.3 世界生成管线：world/canon 脚手架 + per-game assets catalog + 大纲落盘 → 直通开玩（无确认闸门）
- [ ] M3.4 大纲动态维护：checkpoint 时预测未来节点 / 剪除错误预测；realized 冻结
- [ ] M3.5 结局驱动收束：结局候选 → 收束压力；**删除** event mode / forced ending / max_interactions 配置（restart_session 一并回归图语义：回溯/新世界）
- [ ] M3.6 canon 存储 + 晋升流程（跨路径一致自动候选 → 编剧拍板；例外登记附补偿限制）
- [ ] M3.7 删除 story_line.txt 静态注入与 longform/event 配置开关
- [ ] 〔并行轨道〕memory-audit spec Phase A/B（facts/beliefs/lessons）——晋升依赖 facts，建议在 M3.6 前落地；独立 spec 不阻塞主线
- [ ] **GH-1 + GH-2**

## M4 导演（pi + tools）

- [ ] M4.1 导演 agent 骨架与工具集：读场景历史 / 查角色状态 / 收窄表单模式（相位门）/ 承接 M2.1 汇流判定
- [ ] M4.2 剪报防火墙：演员上下文组装迁移至导演——**复用 context-builder 的 serialize\***；禁入：未实现大纲节点、结局候选、其他周目剧情
- [ ] M4.3 防守节拍策划（偏题引回方案进演出指令）
- [ ] M4.4 删除 DirectorPlan / PlotPlanner 独立 LLM 与 NarrativeBrief（战术规划并入导演编排，剪报取代便签）；confirmatory：NarrativeDirector 记忆子层保留（consolidator 等不动）
- [ ] **GH-1 + GH-2**

## M5 图 UI 与结算

- [ ] M5.1 总览场景图（realized / active 渲染；大纲前沿对玩家不可见）
- [ ] M5.2 决策子图展开（场景内决策节点）
- [ ] M5.3 回溯入口（选节点 → 入口快照 → 新周目重放表单）。**含同选项快进**（2026-09-14 自 M1.5 推迟至此）：快进 = 玩家在回溯节点重选与某条既有出边完全一致的选项时沿旧边直接跳到后继表单。M1.5 不实现的原因：restart 只回溯到游标节点，而游标恒为最前沿（无出边），快进在该入口下不可达——只有 M5.3 的任意祖先节点回溯才会命中既有出边。beginEdge 届时返回 `{opened} | {fast_forward: RestorePoint}`，结局端点出边不参与快进（重选结局选项走新生成，如实留第二条边）。
- [ ] M5.4 结算与图鉴：stats 计数器、结局页、伏笔回收率 / 大纲完成度
- [ ] M5.5 通关打分 + 大纲回顾解锁（评价喂回编剧）
- [ ] M5.6 节点删除 UI（DeleteBranch + 级联 GC；若 M1 已实现存储层 GC 则此处仅接 UI）
- [ ] **GH 终检（全量）**

## 卫生门清单（每阶段末逐项过）

**GH-1 代码卫生**
- 全量测试 + node/web 双 typecheck + build 绿
- 死代码清扫：被替换系统零残留（对照「反重复地图」右列逐项 grep）
- 单一真源核对：facts/canon/快照、大纲/setups 台账、边负载/周目流水，无第二存放处
- `core/architecture.test.ts` 依赖方向覆盖新增目录（core/graph、core/outline 等）
- config 无死配置项（删除的系统能力对应配置一并删）

**GH-2 文档卫生**
- `docs/status.md` 与实际行为一致（本阶段改动已反映）
- 设计偏离已记入本清单「偏差记录」；重大偏离回写设计 spec 并注明
- 源码注释中的 `docs/llm-outputs-refactor.md §N` 引用仍可解析（章节未被删除）
- 本清单勾选状态与实际一致

## 反重复地图（动手前必查）

| 需求 | 不要新建 | 复用 |
|---|---|---|
| 剧情事件持久化 | 独立事件日志 | 边负载 `payloads/<edgeId>.jsonl` |
| 恢复 / 交接 | RUN_MEMORY 类记忆文件 | 决策节点入口快照（派生缓存须可丢弃） |
| 状态摘要 | 新的状态机 | `story/reconcile` + VisualState + MemoryDigest |
| 演员上下文 / 剪报 | 第二套序列化器 | context-builder 的 serialize\* |
| 伏笔 / 线程台账 | 大纲内重复维护 | setups/threads 台账，大纲只引用 id + 回收窗口 |
| 世界真理 | 各路径抄写事实 | canon + 引用制 |
| 图鉴 / 统计 | run 实体数据库 | stats 计数器 |
| 相位门 | 新 policy 系统 | InteractionPolicy.allowed_modes 收窄 |
| 汇流 | 图重写逻辑 | 边→既有节点匹配不变量（§3.3） |
| LLM 调用 | 多套 client | 演员 = 现有 openai-compatible client；编剧/导演 = pi |
| 会话恢复 | 扩展 v1 restore（3743ba8） | v1 restore 冻结不再扩展，由 M1.4 节点快照取代 |

## 偏差记录（实施中追加）

- 2026-09-09（M0）：tsconfig 开启 `exactOptionalPropertyTypes`，zod 可选字段必须用
  `z.exactOptional(...)` 而非 `.optional()`（memory-types 既有惯用法）。M1 起所有
  含可选字段的持久化 schema 一律遵循。另：`StateSnapshot.snapshotVersion` 为
  `z.literal(1)`，测试构造非法版本需绕开类型层（`as Record<string, unknown>`）。
- 2026-09-13（M1.3）：契约修订（M0 契约尚无任何落盘数据，SNAPSHOT_VERSION 仍为 1）——
  `InteractionFormSnapshot` 增加 `prompt` 必填字段：恢复重放表单需要原样还原提示语，
  仅 mode/options/placeholder 不足以重建表单。M1 收尾门时回写设计 spec §3。
- 2026-09-14（M1.4）：修复 `isStoredEvent` 的 **v1 潜伏 bug**——存储行外层的
  seq/turn/timestamp/source 信封使 `type:"interaction"` 事件永远无法通过
  strictObject 的 `InteractionEventSchema`，v1 恢复走快照内 `resumeInteraction`
  从不回读事件所以未暴露；v2 边负载回放使 interaction 事件成为承重数据
  （游标节点的表单重放/turn 播种依赖它）。修复：校验前剥离信封字段。
- 2026-09-14（M1.4）：`StoryStateSchema.scene.time` 与 `CharacterStateSchema`
  的可选字段从 `.optional()` 迁移到 `z.exactOptional(...)`（即 M0 已记录的
  zod 惯例的补齐）——否则快照解析产物无法赋回 `StoryState` 接口，恢复路径
  编译不过。无运行时语义变化（JSON 落盘本就无显式 undefined 键）。
- 2026-09-14（M1.4）：删除 v1 遗留的 `Game.resumeInteraction` 字段及其测试——
  v2 恢复真源是图游标 + 契约表单快照，不再有内存态恢复游标；恢复时
  `interactionCount` 清零（event mode 的 max_interactions 不跨恢复累计，
  event mode 本身将随 M3.5 删除）。bootstrap 增加 `options.gameId`（世界
  身份跨启动固定，宿主「继续游戏」传同一 id；缺省仍是每启动新世界）。
- 2026-09-14（M1.5）：`GamePorts.runMode`（resume/restart）+ `restoreOrCreateRun({restart})`；
  协调器 `restartFromCursor` 弃局 + retrace；`CurrentRun` 携带 origin（修复：
  reachEnding 回写 run 记录时硬编码 root 会覆盖 retrace 来源——真 bug，测试捕获）。
  `listRuns` 语义定为 latest-wins 折叠、按最后写入排序（弃局/结局更新行折叠，
  末位 = 最近活动周目）。已知留痕缺口（dev 接受）：首个决策点之前 restart，
  旧 root run 无 abandonedAt 可记（契约 abandonedAt 是 DecisionId），记录保持
  无终态标记。
- 2026-09-14（M1.5）：同选项快进自 M1.5 推迟到 M5.3——restart 只回溯游标节点，
  游标恒无出边，快进不可达；实现它即死代码（详见 M5.3 注记）。
- 2026-09-13（M1.3）：`SceneNode` 延迟到首个决策点才落盘（场景与决策 1:1 惰性创建）——
  模型场景 id → SceneNode 的映射通过扫描决策节点入口快照的
  `storyState.scene.id` 重建，契约无需增加字段；无任何决策的场景不留图记录（M1 接受）。
- 2026-09-13（M0 契约审查，落地前复审）：发现并修复 3 处——
  ① `PlotEdge` 补 refine：confluence 存在 ⟹ `to.kind==="decision"` 且
  `to.id === confluence.matchedNode`（§3.3 的构造性保证升格为写入校验）；
  ② `RunRecord` 补两个 refine：`ending ⟹ endedAt`、
  `abandonedAt ⟹ 无 endedAt/ending`（字段组合语义编码进契约）；
  ③ `OutlineNodeSchema.instantiatedBy` 由 `z.string()` 收紧为 `SceneIdSchema`
  （schema/接口/spec §4 三方对齐）。审查同时确认的**保留项**（有意不改）：
  `StoryState.open_threads` 与 `MemoryDigest.threads` 双台账（v1 双层遗产，
  M4 上下文合并时统一归属）；payload 统计不设连续性不变量（回放完整性由
  回放侧校验）；表单 options ≥1 宽于运行时 ≥2（契约宽松、运行时严格）；
  `matchedNode` 与 `to.id` 冗余（凭据自含 + refine 交叉校验，冗余即哨兵）。

