# 叙事记忆强化与复核体系设计（facts / beliefs / lessons / audit）

日期：2026-09-06
状态：设计定稿，待实施（分期见 §12）。
**2026-09-09 起本 spec 归入 v2 剧情图架构**（`2026-09-09-game-graph-architecture-design.md`）
作为其记忆子层：Phase A/B 不变；Phase C 的「存档恢复记忆重建」由 v2 节点快照
承接、「NG+ 记忆分层」由 v2 的 canon 晋升承接，实施时随 v2 分期走。
范围：长期记忆系统（TODO.md 第 1 条）的下一阶段——在 NarrativeDirector
第 1–3 步（记忆过去 + 规划未来）之上，补齐「设定不丢失、决策可一致、问题
可前馈」三块基础设施。
来源：`docs/novel-skill/` 长篇小说 skill 的可复用条目分析（2026-09-06 会话），
经实时性约束裁剪后立项。本文是该分析的落地形态；采纳/不采纳清单见 §13。

---

## 1. 背景与两条底线

讨论共识（见 TODO.md）：长期记忆系统是 **LLM 编剧的上下文管理系统**，两条
底线是**不能吞设定**与**决策结果要一致**。

当前 NarrativeDirector 已有 threads / setups / anchors / episodes，但对照底线
仍有四个缺口：

| 缺口 | 后果 | 本设计的对应物 |
|---|---|---|
| 剧情中确立的事实（世界规则被验证、事件结果、已揭示信息）只散落在 episodes 摘要里 | Writer 隔若干段后违背自己刚确立的设定 | **既定事实库 facts**（§5） |
| 角色不知道自己不该知道的事（信息边界）无任何记录 | 「她不在场的事她不能知道」类穿帮——小说创作中最高频穿帮源 | **角色认知表 beliefs**（§6） |
| 已被证实的写作坑（审计发现、被拒 ops）不进入后续上下文 | 同一类错误反复出现 | **教训库 lessons**（§7） |
| 伏笔只有「age≥2 → reinforce」一条规则 | 伏笔可以无限期悬置；无终局结算 | **伏笔台账增强 + 终局报告**（§8） |

**决策一致性**如何被服务：facts 给 Writer 确定性的事实地面（而非摘要的模糊
转述）；beliefs 给「谁知道什么」的确定边界；lessons 把已经付过学费的决策排除
在候选之外；planner 与 Writer 读同一份带 revision 的记忆快照（已有机制）。
四者叠加，使同一记忆状态下的编剧决策可复现。

## 2. 核心原则（五条，全部来自 novel-skill 的实时化改造）

1. **前馈不回改**：committed events 是既定事实，任何审计发现都**不触发对已
   提交内容的改写**。问题只向前流动：进教训库、进下一批的规避上下文、或由
   planner 在计划中安排「剧情内圆场」节拍。这与现有 recovery 哲学（已发布
   前缀不回滚）同构。
2. **增量审计**：审计只对照「本批 committed 事件 + 内存状态摘要」，绝不重读
   历史全量。成本与剧情总长度无关。
3. **检测与修复分离**：审计只产出事实与判级（findings），不在审计路径上生成
   剧情文本；修复是 Writer 在后续生成里做的事，由提示词与计划驱动。
4. **异步不阻塞**：所有新组件挂在现有异步钩子（consolidation 批次、checkpoint、
   结局路径）上，fire-and-forget；`getBrief` 保持同步只读内存缓存、零 await。
   实时性红线逐条核对见 §11。
5. **append-only 与单一真源**：facts / lessons 只增不删（修订 = 新行引用旧行
   id，历史可追溯）；beliefs 是活状态（可被 correct），归入 narrative-state.json
   与 threads/setups 同性质管理。

## 3. 三条硬约束的延续（不变量）

现有 NarrativeDirector 三条硬约束在新组件下继续成立：

1. **只从 committed events 形成记忆**：facts / beliefs / findings 的证据都来自
   consolidator 已读的 committed 批次；候选分支、预取/预览仍然永不进入。
2. **未来计划永不写入事实记忆**：findings 与 lessons 是**诊断数据**，不是事实
   记忆——它们不进 episodes、不进 narrative-state 的 threads/setups 段，各自
   独立存储；consolidator 的输入契约不变（仍不含计划）。
3. **planner 不写未来台词**：planner 只是新增读取 findings 摘要与 overdue
   setups（§10），产物仍只有 DirectorPlan。

`narrative.mode: event` 时本设计全部组件随 director 一并旁路（零行为变化）。

## 4. 数据流总览

```text
committed events（批次，已有）
      │
      ▼
MemoryConsolidator（一次 LLM 调用，输出 schema 扩展）
      ├── EpisodeMemory + ThreadOp/SetupOp      （现有）
      ├── FactOp[]        → facts.jsonl          （新增，§5）
      ├── BeliefOp[]      → narrative-state.json （新增，§6）
      └── AuditFinding[]  → lessons.jsonl / 前馈 （新增，§9）
      │
      ▼
getBrief（同步内存快照，零 await）
      └── 现有段落 + [相关既定事实] + [角色认知] + [规避清单]

SetupScheduler（确定性）→ 伏笔指令增加第三档「强制了断」（§8）
PlotPlanner → 输入新增 findings 摘要与 overdue setups（§10）
EndEvent 提交 → 终局报告（确定性聚合，§8.4）
```

新增 LLM 调用次数：**零**（findings/facts/beliefs 搭载 consolidator 既有调用，
通过输出 schema 扩展实现）。这是成本与复杂度的关键决策：不引入独立的
审计器适配器；若日后发现单次输出质量稀释，再拆分为独立调用（接口已按
可拆分设计）。

## 5. 既定事实库（facts）

### 5.1 定位与分工

设定分三层，各层职责与载体：

| 层 | 内容 | 载体 | 演化 |
|---|---|---|---|
| 作者 canon | 世界观/人物静态设定（"应当如此"） | `prompts/characters.txt` 等，每请求常驻 | 作者手工维护，运行时只读 |
| **runtime facts** | 剧情中确立的事实（"正文里已经如此"） | `sessions/<id>/facts.jsonl` | 只增不删，amend 引用旧行 |
| 长线记忆 | 事件轨迹摘要（"发生过什么"） | `episodes.jsonl`（现有） | 追加 + 检索 |

「不能吞设定」的补齐点正是第二层：作者 canon 由 prompt 常驻保障，而**剧情
自己长出来的设定**（终端会对苏遥的指纹反应、地下室第 4 号门已焊死、玩家
已把真名告诉了苏遥）目前只活在 episodes 的压缩摘要里，粒度丢失即设定丢失。

与 `StoryStateReconciler`（`src/story/reconcile.ts`）的关系：reconcile 是
确定性投影（location / characters / recent_summary），供程序消费；facts 是
语义级事实，供 Writer 消费。两者互补不重叠。

### 5.2 FactOp（consolidator 输出契约扩展）

```ts
interface FactOp {
  type: "establish" | "amend";
  id?: FactId;               // amend 必填，指向被修订的 fact
  content: string;           // 条件句式，≤120 字：「<主语/范围> + <事实>」
  evidenceEventSeqs: number[];   // 1..3 条证据事件 seq（必须落在本批范围内）
  scope?: { characters?: CharacterId[]; location?: string };  // 检索锚点
  importance?: "major" | "minor";   // major 事实常驻 brief，minor 按需检索
}
```

Validator 规则（沿用 shadow-state 事务校验模式）：

- evidence seq 必须落在已提交事件范围内（复用现有检查）。
- `amend` 必须引用存在且未被 amended 过的 fact id；amend 后旧 fact 标记
  superseded（不删除），新 fact 记 `amends: FactId`——对应 novel-skill
  「保留旧版本与修改原因，不覆盖」。
- `establish` 幂等：内容去重靠 prompt 纪律（"只登记剧情确立的、未来会被引用
  的事实"）+ 每批 establish 上限（常量 3）；不做 embedding 相似度（YAGNI）。
- 批内预算：amend 不限量（纠错优先），establish ≤ 3。

### 5.3 存储与检索

- `sessions/<id>/facts.jsonl`：每行一个 FactRecord（op 应用结果 + 应用时
  checkpoint），append-only；load 时按 id 重建 + 去重（与 episodes 同模式），
  损坏行跳过不抛错。
- 内存状态：`facts` 数组副本（含 superseded 标记），随 `mutateMemory` 串行链
  写入（与 consolidation/replan 同一互斥路径，复用 revision 竞态保护）。
- brief 检索（新 `fact-retriever.ts`，纯函数，直接扫数组——规模与
  episode-retriever 同级）：按
  （在场角色 ∩ scope.characters）∪（location 匹配）∪（importance=major）
  选取，上限 `facts.brief_max`（默认 8），按 checkpoint 倒序。

## 6. 角色认知表（beliefs —— spec 第 4 步的最小子集）

NarrativeDirector spec 第 4 步预留了 belief / player knowledge；本节只落其
**最小子集**：「角色当前知道什么 / 误信什么」。embedding、belief 推理、
SQLite 仍不做。

### 6.1 BeliefOp

```ts
interface BeliefOp {
  type: "learn" | "believe" | "correct";
  characterId: CharacterId;      // 含玩家角色（主角视角同样受信息边界约束）
  content: string;               // ≤80 字，命题式：「苏遥知道终端会响应玩家指纹」
  evidenceEventSeqs: number[];
  replacesBeliefId?: BeliefId;   // correct 必填
}
```

- `learn`：角色在场/被告知而获得的信息。
- `believe`：角色形成的、可能错误的信念——**误会是合法来源，也是回收时的
  爆点储备**（信息差机制）。
- `correct`：信念被纠正（真相揭示时刻，通常与 setup payoff 同点）。

Validator：correct 必须引用现存 active belief；believe/learn 的 characterId
必须在 consolidated 事件中出现过；每批每角色 op ≤ 2；每角色 active beliefs
上限 `beliefs.max_active_per_character`（默认 8，超限拒新保旧）。

### 6.2 存储、渲染与使用

- 存储：`NarrativeMemoryState` 新增 `beliefs: BeliefState[]` 段（活状态，
  与 threads/setups 同文件同原子写路径）。correct 后旧 belief 移入
  resolved（保留计数，供审计与终局报告）。
- brief 渲染：在场角色的 active beliefs，逐条一行；无任何 belief 记录的角色
  不渲染（零成本）。
- 使用：Writer 获得确定性的「谁知道什么」；§9 的信息边界审计以它为对照基准。
  它同时直接服务多周目（NG+ 继承的正是「角色们相信什么」）——接口按可导出
  设计，跨周目持久化在存档系统落地时接入。

## 7. 教训库（lessons）

novel-skill 的 handoff.md「已发现问题类型」区块：用户/审计指出的问题记成
规避清单，**同一问题在同一项目里第二次出现是流程违规而非笔误**。这是单点
性价比最高的借鉴——现有 `narrative-ops.jsonl` 只记 consolidator 被拒 ops，
不记写作层面的坑。

### 7.1 Lesson 记录

```ts
interface Lesson {
  id: LessonId;
  tag: "fact-conflict" | "belief-violation" | "character-consistency"
     | "setup-flow" | "style" | "interaction" | "other";
  content: string;             // 规避指令式：「旁白不得挂主角名下」（≤100 字）
  source: "audit" | "rejection" | "manual";
  sourceRef?: string;          // finding id / 被拒 op 规则名
  occurrences: number;         // 同 content 再现时 +1（去重键 = tag + content）
  active: boolean;
}
```

### 7.2 三个来源与自动晋升

1. **audit**：判级 ≥ 严重的 finding 自动蒸馏成 lesson（§9.3）。
2. **rejection**：同一 validator 拒绝规则（如 `SETUP_SEED_WITHOUT_PAYOFF`）
   累计出现 ≥ `lessons.auto_from_rejections`（默认 2）次 → 自动生成 lesson
   ——即「第二次出现算流程违规」的机制化。
3. **manual**：预留作者/运营入口（配置或 CLI 命令），v1 只留类型不实现 UI。

### 7.3 渲染与生命周期

- brief 渲染「规避清单」段：active lessons 按 occurrences 降序 + recency，
  上限 `lessons.brief_max`（默认 8）。
- 生命周期：append-only 文件 `lessons.jsonl`；active 集合用滚动窗口管理
  （超过 `lessons.brief_max * 3` 时最旧的自动置 inactive），不做自动复审。

## 8. 伏笔台账增强

对照 novel-skill《04-情节与悬念》§6 与《09》§3.3，现有 `SetupPayoff` 做四点
增强。全部为确定性规则，无新 LLM 调用。

### 8.1 depth（三层次）

`SetupPayoff` 新增 `depth?: "shallow" | "mid" | "heavy"`（create 时由
consolidator 判定或 author seed 声明；缺省 mid）。语义是**计划出现次数**：
shallow=1、mid=2–3、heavy=3+。现有 `reinforcementCount` 字段天然成为执行
计数器：

- `depth: heavy` 且 reinforcementCount < 2 时收到 payoff 指令 → scheduler
  改发 reinforce（积累不足不回收）。
- 违例回收（heavy 但实际只出现 1 次）→ 审计记一般级 finding（§9），不硬拒——
  validator 拒绝会阻塞记忆推进，得不偿失。

### 8.2 intendedPayoff 必填

「没有回收计划的伏笔不许下场」：

- validator 新增拒绝规则：runtime `SetupOp.seed` 缺 `intendedPayoff` → 拒绝
  （记 rejected op → 若反复触发自动成 lesson，见 §7.2）。
- author seed（story-plan.yaml）缺省 → loader 记 warning，brief 中该 setup
  标注「未定回收计划」，planner 输入中高亮。

### 8.3 强制了断（第三档指令）

现有 `classifySetup`：age ≥ 2 → reinforce/soon。新增第三档：

```text
age ≥ narrative.setups.max_untouched_checkpoints（默认 6）
→ 指令 = RESOLVE_OR_DROP（urgency: overdue）
```

- brief 语气升级：「该伏笔已超期，本段必须推进回收或显式放弃，不得继续悬置」。
- planner 输入携带 overdue setups 清单，要求在 horizon 内安排回收或 drop
  节拍（`SetupOp.drop` 是合法终态，与 novel-skill「断裂须记原因」一致）。
- 仍超期的 → 审计严重级 finding（逾期悬置）。

### 8.4 终局报告（回收率 + 成就钩子）

novel-skill 出版级达标线的「伏笔回收率 ≥ 95%」改造为游戏结算口径：

- 触发：EndEvent 正式提交后（`@end ... ending` 哨兵合成的 EndEvent 经
  observeCommitted 到达 director 时），异步聚合。
- 口径：`回收率 = paid_off / (paid_off + dropped + 结算时仍 active)`；
  threads 终态分布、beliefs unresolved 数、lessons 摘要附后。
- 产物：`sessions/<id>/ending-report.json`（确定性聚合，无 LLM）；Web 结局
  画面可选择渲染（后续波次），它是成就/收集系统（TODO 第 5 条）的现成数据源。

## 9. 异步审计（findings）

### 9.1 审计维度 v1（三选自十维）

卷级十维中按「有对照基准 + 高频穿帮」标准选三维：

| 维度 | 对照基准 | 典型判据 |
|---|---|---|
| 信息边界泄漏 | beliefs 表 | 角色引用了表外信息且本批无获知途径 |
| 事实一致性 | facts 表 | 本批事件与既有 fact 矛盾且无显式 amend |
| 人设一致性 | 作者 canon（characters 摘要） | 行为/语气与人设矛盾（v1 依赖 prompt 摘要粒度） |

其余维度（时间线、物品账、称呼等）明确不做：vibe-gal 尚无故事时钟与物品
账本，对照基准不存在，审了也是幻觉（§13）。

### 9.2 AuditFinding

```ts
interface AuditFinding {
  dimension: "belief-violation" | "fact-conflict" | "character-consistency";
  severity: "critical" | "major" | "normal" | "minor";
  content: string;             // ≤120 字，事实描述（不含改写建议）
  evidenceEventSeqs: number[];
  subject?: string;            // characterId / factId / setupId
}
```

- 搭载 consolidator 输出（§4）；判级采用 novel-skill 四级语义：
  critical = 主线矛盾/身份矛盾，major = 信息边界泄漏/已确立事实违背，
  normal = 情绪突兀/积累不足的回收，minor = 称呼细节。
- validator 校验：evidence seq 范围、dimension/severity 枚举、每批 findings
  ≤ 5（prompt 同步声明，防止刷屏）。
- findings 不修改任何记忆状态——它们只落 `lessons.jsonl`（major+）与
  `narrative-ops.jsonl`（全量留痕，复用现有 rejected-op 通道的文件）。

### 9.3 前馈路径（修复三通道，绝不回改）

1. **brief 规避清单**：major+ 自动成 lesson（§7.2），下批生成即生效。
2. **planner 联动**：planner 输入新增「未消化 findings 计数 + 严重级摘要」，
   要求在计划 beats 中安排剧情内消化（圆场、误 会解开、揭示重排）。
3. **剧情内显式反转**：Writer 确要推翻已确立事实时，唯一合法路径是
   `FactOp.amend` + 新事件证据——机制上保证「改设定必留痕」。

## 10. 提示词与组件变更清单

| 文件/组件 | 变更 |
|---|---|
| `core/narrative/memory-operation.ts` | + FactOp / BeliefOp（zod schema 与上限常量） |
| `core/narrative/memory-types.ts` | + NarrativeMemoryState.beliefs / facts 内存投影类型 |
| `core/narrative/narrative-brief.ts` | + relatedFacts / characterBeliefs / avoidanceLessons 字段 |
| `application/narrative/memory-validator.ts` | + §5.2 / §6.1 / §8.2 校验规则、findings 校验 |
| `application/narrative/setup-scheduler.ts` | + depth 门控、RESOLVE_OR_DROP 第三档 |
| `application/narrative/fact-retriever.ts`（新） | facts → brief 相关集选取（纯函数） |
| `application/narrative/narrative-context-builder.ts` | + [相关既定事实] [角色认知] [规避清单] 三段渲染 |
| `application/narrative/lesson-service.ts`（新） | lessons 聚合/晋升/窗口管理（纯逻辑） |
| `adapters/llm/narrative-consolidator-adapter.ts` | 输出 schema 扩展（facts/beliefs/findings），prompt 增补对应指令 |
| `adapters/storage/json-narrative-memory-store.ts` | + facts.jsonl / lessons.jsonl 读写（同原子写/降级模式） |
| `application/narrative/plot-planner.ts` | 输入 + findings 摘要与 overdue setups |
| `src/game.ts` | EndEvent 提交 → 触发终局报告（异步）；其余零改动 |
| `prompts/dsl-protocol.txt` | + 一行：「遵守导演便签中的既定事实与角色认知边界，推翻事实须剧情内显式铺垫」 |

## 11. 实时性红线（逐条核对）

本设计引入的每一项工作，挂载点与播放路径的关系：

| 工作 | 挂载点 | 与播放路径关系 |
|---|---|---|
| consolidator 输出扩展（facts/beliefs/findings） | 既有 consolidation 批次（积压阈值 + 节流 + 单飞） | 不变，仍 fire-and-forget |
| facts/lessons 写盘 | `mutateMemory` 串行链内 | 内存外 IO，不阻塞任何 RuntimeCommand |
| brief 三段渲染 | `getBrief`（同步内存快照） | 纯内存数组切片，成本受 brief_max 上限约束；**零新增 await** |
| 强制了断指令 | classifySetup（纯函数，现有调用点） | 零成本 |
| 终局报告 | EndEvent 提交后异步 | 结局已成立，无实时压力 |
| findings → planner | 既有 replan 周期（后台、单飞） | 不阻塞回合 |

**明确禁止**：不得在任何 RuntimeCommand / 生成请求的同步路径上新增 LLM 调用
或文件读写；不得为等待审计结果而延迟任何一段生成；brief 必须能在任何时刻
以纯内存快照回答（部分组件尚未完成首次批次时，对应段缺省渲染——与现有
「无 brief 时零变化」同一模式）。

## 12. 实施分期

**Phase A —— 确定性规则与存储骨架（无新 LLM 输出契约）**

1. depth 字段 + scheduler depth 门控 + RESOLVE_OR_DROP 第三档（§8.1/8.3）。
2. intendedPayoff 必填校验（runtime 拒绝 + author warning）（§8.2）。
3. 终局报告：ending-report.json 聚合 + EndEvent 触发（§8.4）。
4. lessons 存储 + rejection 来源自动晋升（§7.2 来源 2）+ brief 规避清单渲染。
5. 存储层 facts.jsonl / lessons.jsonl 读写与降级（先建通道，B 阶段才有写入者）。

验收：全量测试绿；跑一局验证超期伏笔在 brief 中出现 RESOLVE_OR_DROP；结局
后 ending-report.json 数值正确。

**Phase B —— consolidator 扩展（本设计的核心批次）**

6. FactOp / BeliefOp / AuditFinding 进 consolidator 输出契约与 prompt。
7. validator 扩展 + facts/beliefs 内存与持久化 + lesson 来源 1（audit 晋升）。
8. fact-retriever + brief 三段渲染 + dsl-protocol 一行规则。
9. 幂等/去重/预算全链路测试。

验收：端到端——确立事实的剧情段之后，间隔多段再提及该事实，Writer 表述与
fact 一致；角色引用未获知信息时 brief 规避清单在后续批次出现对应 lesson。

**Phase C —— 联动与跨会话（依赖外部系统）**

10. planner findings 联动（Phase B 后即可做，视效果决定）。
11. **存档恢复时的记忆重建**（依赖 TODO 第 3 条 load/resume）：resume =
    重放 events.jsonl → observeCommitted → 排空 consolidation → 校验
    narrative-state/plan/facts/lessons 全部就绪后才放行首次生成——「绝不允许
    只读最后两章就往下写」的机制化。
12. NG+ 记忆分层（依赖多周目）：周目层元记忆 + beliefs/facts 的选择性继承。

## 13. 明确不采纳清单（含理由）

| novel-skill 条目 | 结论 | 理由 |
|---|---|---|
| 每章六步主循环（读→定→写→润→审→同步的串行纪律） | 不采纳 | 同步串行流程与流式实时生成冲突；等价物是分布式异步钩子（§11） |
| 修订蓝图→逐处修改→回归检查 | 不采纳 | 面向历史可改写的离线流程；vibe-gal 已发布即既定事实，只前馈 |
| 出版级达标线（字数/错字率/信息密度） | 不采纳 | 指标不适用；仅伏笔回收率以结算口径吸收（§8.4） |
| 时间线/物品账审计维 | 暂缓 | 无故事时钟与物品账本，无对照基准；待 StoryState 扩展后重估 |
| 桥段登记（tropes） | 暂缓（P3） | 长时游玩的 LLM 循环风险真实，但需先给 episode 加场景形状标签；规模未到 |
| 宏观重读四问 | 暂缓 | 可并入 replan 周期做健康检查；等 Phase B 效果再评估 |
| 滚动摘要/超节点/三层检索视图 | 暂缓 | episodes 数十条规模，检索成本未成为瓶颈；差分记录纪律已由 consolidator prompt 吸收 |
| 文风/反AI味、对话工艺模块 | 不采纳 | 结构一致性优先级远高于文风；对话三职可在日后进 writer guideline |
| 独立审计器适配器（独立 LLM 调用） | 备选不启用 | 搭载 consolidator 零新增调用；若输出质量稀释再拆（接口已可拆） |

## 14. 测试矩阵（概要）

| 层 | 测试 |
|---|---|
| memory-operation | FactOp/BeliefOp schema 解析与拒绝（上限、缺证据、amend 引用不存在 id） |
| memory-validator | intendedPayoff 必填拒 seed；amend 链；beliefs 上限；findings 枚举/范围/批量上限 |
| setup-scheduler | depth 门控改发 reinforce；age 三档指令；overdue 进入 planner 输入 |
| fact-retriever | 角色交集/位置匹配/major 常驻/上限截断 |
| lesson-service | rejection ×2 自动晋升；audit major+ 晋升；滚动窗口降级；渲染排序 |
| json store | facts/lessons 写读往返、append-only、损坏行跳过、原子写 |
| consolidator-adapter | mock LLM 返回扩展输出 → ops/findings 正确分流；缺段容错 |
| director-service | facts/beliefs 经 mutateMemory 串行应用与 revision 推进；与 replan 互斥不回退 |
| context-builder | 三段渲染；无数据时零变化；brief_max 截断 |
| game 集成 | EndEvent → ending-report.json；candidate 事件不产生任何 fact/belief/finding |
| 端到端（手测脚本） | §12 Phase B 验收场景 |

## 15. 成功标准

- node/web 全量测试绿、双 typecheck + build 过（每 Phase 同）。
- 实时性：生成路径零新增同步开销（测试断言 getBrief 零 await、无新同步 IO）。
- 底线可验证：① Writer 违背 runtime fact 的事件发生后，下批 brief 出现对应
  规避/圆场信号；② 角色信息越界被审计捕获并进入 lessons；③ 任意时刻重启
  进程（Phase C 后）恢复会话不丢 facts/beliefs/lessons。
- 结算：长局跑至结局，ending-report.json 的回收率与 setups 终态一致。
