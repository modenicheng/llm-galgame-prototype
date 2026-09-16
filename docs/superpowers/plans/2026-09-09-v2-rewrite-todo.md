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
- [x] M1.6 ✅ 删除：sessions JSONL store（node-jsonl-session-store + 测试 + SessionStorePort 整文件）；`sessions_dir` 配置保留（narrative memory 会话文件仍用，非事件日志）。event mode / forced ending **暂留**（M3.5 由大纲结局驱动替代时删）
- [x] **GH-1 + GH-2**（M1 收尾门，2026-09-14 过）：1408 测试 + 双 typecheck + build 绿；
  死代码零残留（v1 恢复游标/会话存储 grep 清零）；单一真源成立（快照=运行时状态、
  边负载=回放、runs.jsonl=周目流水）；architecture.test 递归覆盖 core/graph、
  core/outline（无 node/adapter 依赖）；config 无死键（sessions_dir 由 narrative
  memory 接续使用）；偏差已回写 spec §3（form prompt 字段）；status.md 同步至
  2026-09-14；源码 §N 引用全量可解析。

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



## M2 汇流

- [x] M2.1 ✅（2026-09-16）ConfluenceJudge port（`core/ports/confluence-judge-port.ts`：
  `judge({endState, candidateEntry}) → {equivalent, confidence, rationale, judgedBy}`；
  候选枚举（如同场景过滤）是调用方的确定性职责，不入签名——自本条起即 §3.3
  冻结签名）+ 首个 adapter（`adapters/llm/confluence-judge-adapter.ts`，复用
  openai-compatible client，json_object + zod 校验；确定性比较器不实现，可插拔
  路径记于端口头注）。前置已落（2026-09-15）：存储层汇流边 endState 内联化修订
  （见偏差记录）。A2 seq 决议：选「从世界最大 seq 播种」并升格为统一规则
  （fresh 与 retrace 同式，理由与载体见偏差记录 2026-09-16 条）。
- [x] M2.2 ✅（2026-09-16）场景内汇流：边收束（openDecision）后**后台**发起判定——
  候选 = 同场景、有入边（排除孤儿与周目首节点）、不在当前路径上（防成环）的
  既有决策节点，逐个交 ConfluenceJudge，取置信最高命中；改绑有界：入边改指
  候选（凭据 + 真实末态内联）+ 出边改源 + 游标仍停新节点时前移，新节点孤儿化。
  并发安全：协调器图变更加 promise 链互斥（判定在链外等待，只有落盘改绑入队，
  实时性红线保持）。守卫：换周目/已完结即放弃改绑（判定窗口关闭）；apply 时
  重验祖先（判定落地期间玩家推进造成的路径变化）。落地细则见偏差记录
  2026-09-16 M2.2 条。
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
- [ ] M4.5 演员运行时拆分（2026-09-15 挂项，game.ts 收窄）：M3.5/M4.4 两笔删除落地后执行——交互驱动（choice/input/hybrid + 两阶段提交，~520 行）抽至 `src/runtime/` 独立模块，game.ts 保留 run 循环 + 段生命周期 + 恢复 + 图提交（目标 ~1500 行）；game*.test.ts 沿同缝拆分。**前置已落（2026-09-15）**：game.test.ts 已按 describe 拆为 game-graph-restore / game-input / game-interactions + 共享 game-test-kit；公共契约词汇（RuntimeShutdownError 等三类）已迁 `core/runtime/errors.ts`，宿主不再为错误类型 import game.ts。过 GH 门
- [ ] **GH-1 + GH-2**

## M5 图 UI 与结算

- [ ] M5.0 宿主接线：entrypoints（web/cli）传 gameId/gamesRoot——世界身份跨进程固定，「继续游戏」对真实用户可达。现状（2026-09-15 审查 C）：闭环只在运行时层成立（restoreOrCreateRun + options.gameId），两个入口均不传 gameId，进程重启后永远开新世界
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
- 2026-09-15（M2 前置修订，全量审查 A1）：存储适配器 endState 内联条件由
  「仅结局端点」放宽为「结局端点 ∨ 汇流边」。原 exact-相等写入门禁与 §3.3
  「末态 ≈ 入口态」的汇流定义正面矛盾——汇流边真实末态按定义不等于后继
  入口（强行相等即伪造状态），且 EdgeRecord 的旧 refine 会在读取时把带
  内联末态的汇流边当损坏行丢弃。修订后：汇流边内联真实末态、免相等门禁，
  凭据（judgedBy/confidence/rationale）承担差异审计；普通决策端点的门禁
  不变（「同一次快照写两处」不变量继续成立）。§3 冻结 schema 未动
  （PlotEdge 本就同时携带 confluence 与 endState），仅 GraphStorePort
  putEdge 语义与磁盘记录形状修订；无落盘数据，零迁移成本。
- 2026-09-15（审查记档，不修）：孤儿 decision（putDecision 已落、putEdge 未落
  的崩溃窗口产物，无入边不可达）暂不清理——快照真源无损、仅磁盘垃圾；M5.6
  DeleteBranch 提供 GC 原语后随节点删除一并处理。孤儿 payload 已在恢复时清理
  （M1.4），两者窗口同源、处置不同是有意的（payload 会被误当成真实边读回，
  不可达节点不会）。
- 2026-09-16（M2.1，A2 决议）：seq 播种统一为
  `nextSeq = max(世界最大 seq, 路径末事件 seq, digest 水位) + 1`，fresh 与
  retrace 同式。世界最大 seq 取各边 payload 统计 lastSeq 的最大值（开局段
  事件不入图、孤儿 payload 恢复时删除 ⟹ recorded edges 即存活事件全集），
  无需新增 store 查询。较清单原稿增强：原稿 A 仅提 fresh 播种，但 retrace 的
  `max(路径, 水位)` 规则在 M5.3 任意祖先回溯下仍有撞号隐患（被弃分支的 seq
  可大于回溯点的路径末 seq），统一按世界最大值对两者一并免疫。选 A 非 B 的
  理由（正确性而非偏好）：M2.2 汇流使同节点多入边成真后，① seq 回绕会让
  `pickLatestInEdge`（lastSeq 最大 = 最近走过）选错边；② M1.4 记忆追赶按
  `seq > 水位` 过滤重放事件，混合路径上周目二的回绕 seq 全部 ≤ 周目一水位，
  会被整段静默过滤——恢复后记忆丢失整个新分支，是正确性 bug。载体：
  `RunResume` fresh 变体增加 `nextSeq` 字段（运行时端口类型，非 §3 冻结
  schema），Game fresh 分支播种 `this.seq`；MemoryRunGraph 默认值同步。
- 2026-09-16（M2.2）：**场景节点世界级稳定修订**——原实现只有恢复路径重建
  「模型场景 id → 场景节点」缓存，fresh 新 root 周目会给同一模型场景再建一
  个场景节点。M1 里只是场景图外观问题，M2.2 的同场景候选过滤按 sceneId 匹配，
  跨周目汇流（本里程碑主用例）会整体失效。修复：`ensureSceneNode` 收口为
  缓存 → 扫既有决策入口快照 → 惰性创建（hydrate 里的重建循环删除，单点负责）。
- 2026-09-16（M2.2 落地细则记档）：① 改绑窗口守卫——判定落地时若创建该边
  的周目已完结或已换周目（restart/retrace/结局后新 root），放弃改绑（被弃
  周目的迟命中不追溯，M2.4 末态索引是滞后匹配的正牌机制）；② 候选排除
  「无入边」节点——孤儿（崩溃窗口/汇流改绑产物）不该成为汇流目标，副作用是
  周目首决策（开局面，结构性无入边）也不可命中，dev 接受；③ apply 时重验
  祖先而非 schedule 时快照——判定悬置期间玩家可能已推进，路径集合以落地
  时为准；④ 新增 `narrative.confluence.enabled` 配置（默认关，config.yaml 显
  式开）：判定是真实 LLM 调用，测试配置（绕过 zod 的手拼 config）与 CI 保持
  零网络；⑤ 图变更加 promise 链互斥（演员管线调用与后台改绑串行化），判定
  LLM 调用在链外，互斥体只含快速落盘。

