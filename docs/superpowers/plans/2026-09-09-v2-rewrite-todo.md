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

- [ ] M1.1 ⚠ 设计细化：记忆子层 v2 持久化——MemoryDigest 嵌入决策节点快照为**唯一真源**；NarrativeMemoryStore 的会话文件降级为工作缓存（可重建）；digest 与 canon 引用的关系（引用制，不抄写）
- [ ] M1.2 GraphStore port + JSON/JSONL adapter（§9 布局：scenes/decisions/edges/endings/runs/payloads/snapshots/cursor/stats）
- [ ] M1.3 演员接图：Game 提交路径改造——段事件 → 边负载；交互开启 → 决策节点 + 入口快照；交互解决 → 出边 + 末态快照
- [ ] M1.4 ⚠ 游标与恢复：cursor.json；「继续游戏」= 载入节点入口快照重建运行时（Game 必须可从 StateSnapshot 完整重建——本阶段最高风险，先写恢复路径的集成测试再实现）
- [ ] M1.5 新周目入口：root 开局 / retrace（载入快照 → 重放表单 → 新选择产生新边）
- [ ] M1.6 删除：sessions JSONL store、SessionStorePort 及全部引用；`sessions/` 运行时写路径。event mode / forced ending **暂留**（M3.5 由大纲结局驱动替代时删）
- [ ] **GH-1 + GH-2**

## M2 汇流

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
- [ ] M5.3 回溯入口（选节点 → 入口快照 → 新周目重放表单）
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
