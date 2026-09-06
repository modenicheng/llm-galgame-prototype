# 实施日志（changelog）

> 摘编自原 `docs/llm-outputs-refactor.md` §114–§118（该文件 2026-09-04 拆分，
> 全文见 git 历史）。当前进度权威见 `docs/status.md`。

## 2026-08-09 会话问题修复（原 §114）

08-27-59-001Z 会话实测暴露三个内容层问题，均在 `prompts/dsl-protocol.txt` 修复：

1. **旁白被写成角色台词**（第一人称叙述被挂到主角名下，导致 TTS 念旁白）→
   协议明确旁白判定标准：主角的第一人称动作/观察也是旁白；「能否想象角色开口
   发声」作为可操作判定。（已并入设计参考 §4）
2. **虚拟第三人**（凭空出现人数描述）→ 硬性规则：在场人物只有已登台角色和玩家
   自己；神秘声音/影子保持未知，不实体化。
3. **新角色引入约束** → 登台角色才能说话；被提及未登场的人物只存在于文字中；
   新角色必须有铺垫才可登场。compiler 对未注册角色本就放行，约束完全落在
   prompt 层。

## 2026-08-09 移除 JSONL 旧协议，全量 Gal DSL（原 §115）

- 删除：`model-jsonl.ts` 及其测试、generator 的 jsonl 路径、相关 schema
  （ModelEventSchema 等）、`input_bridge` 内联字段与 materialize、
  `generation.protocol` 与 `interaction.legacy_choice` 配置、instructions 的
  `output_protocol` 段、game.ts 的 onEvent/validateEvent 路径。
- 行为变化：ChoiceEvent / EndEvent 转为运行时内部类型（`@end ... ending`
  哨兵合成 EndEvent）；interaction_id / option_id 全部由运行时生成。
- 保留：Session JSONL 存储格式（与模型协议无关）。

## 2026-08-09 NarrativeDirector 第 1+2 步：记忆过去（原 §116）

在 Runtime 与 StoryGenerator 之间新增长线剧情层（设计见
`docs/superpowers/specs/2026-08-09-narrative-director-design.md`）：

- core/narrative 纯类型（PlotThread / SetupPayoff / EpisodeMemory / ops）+
  application 层（director-service / memory-consolidator / memory-validator /
  episode-retriever / narrative-context-builder）+ adapters（consolidator LLM、
  JSON 记忆存储、story-plan loader）。
- 三条硬约束：只从正式 committed events 形成记忆；未来计划永不写入事实记忆；
  planner 不写未来台词。
- consolidation 流水线：FIFO 批次、shadow-state 事务校验、copy-on-write 原子
  持久化、单飞 + min_checkpoint_gap 节流、失败重新入队幂等重试。
- 文件布局：`sessions/<sessionId>/` 下 narrative-state.json / episodes.jsonl /
  narrative-ops.jsonl；记忆绑定 session，损坏一律降级不抛错。
- 时间单位统一为 checkpoint（叙事节拍）；`mode: event` 完全旁路。

## 2026-08-11 NarrativeDirector 第 3 步：PlotPlanner / DirectorPlan（原 §117）

「规划未来」：每个 checkpoint 周期生成未来 horizon 内的导演计划（phase / goal /
beats / focusThreads / setupDirectives 快照 / revealLocks / anchorOps），经
getBrief 随导演便签注入 Writer 上下文。

- 首计划在 checkpoint 1 创建；低水位后台重规划（单飞防重入）；
  硬过期后 brief 省略计划段——**绝不阻塞回合等待 LLM**。
- 三条约束落实：计划只进 director-plan.json + 锚点状态；consolidator 输入不含
  计划；锚点推进与 consolidation 走 memoryWriteChain 内存写互斥（有竞态测试）。
- 提交序列 14e3d8a..3618dd6（Task 1–9）。

## 2026-08-11 基础设施审计修复（原 §118）

静态审计确认的 11 项偏差修复（plan：
`docs/superpowers/plans/2026-08-11-step4-audit-fixes.md`）：

- P0 低水位续写落地（§73–§76）；P0 StoryStateReconciler（§80–§81）。
- 叙事精度：setup prerequisites 门槛、SetupDirective 投影、anchor 按声明序
  （DAG）、规范 episode 标签、ThreadOp.create 携带 kind/importance 与预算。
- 端口依赖倒置：Game 改消费 `StoryGeneratorPort`。
- 会话目录统一（narrative 文件与 JSONL 同入 `sessions/<sessionId>/`）+
  director shutdown flush。
- event 模式最小集（max_interactions 强制收束 + restart_session 命令）。
- 文档清理：README mode/bridge 描述修正、dsl-protocol 独立 `ch` 须带 variant、
  DESIGN.md 归档。
- 配套：删除 `narrative.brief.max_recent_raw_events`（原始事件窗口唯一来源为
  `game.history_events`）。

## 2026-09-04 文档拆分（本次）

- 原 87KB 单文件按职能拆分：设计参考（`llm-outputs-refactor.md`，保留 § 编号）/
  进度对照（`status.md`）/ 实施日志（本文）。
- 删除已完成的迁移期内容：JSONL 时代基线（原 §1–§2）、文件级改造清单与旧目录树
  （原 §84–§86 的过时部分）、迁移顺序（原 §88–§97）、测试清单（原 §98–§105，
  已固化为测试套件）、第一阶段闭环（原 §108–§109）。
- 新增 `TODO.md`：下一阶段大方向路线图（长期记忆/多周目/存档/成就/语音合成优化/
  动态资源生成）。
