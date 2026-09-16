# 实施进度对照（status）

> 快照日期：**2026-09-16**，对照 `main` 分支代码。本文是唯一的进度权威文档；
> 设计规范见 `docs/llm-outputs-refactor.md`，变更记录见 `docs/changelog.md`。
> 后续开发完成/变更条目时请同步更新本文。

## 文档地图

| 文档 | 职能 |
|---|---|
| `README.md` | 运行方式、TTS 配置入口 |
| `docs/llm-outputs-refactor.md` | DSL 协议与运行时架构的规范设计（§ 编号被源码注释引用） |
| `docs/status.md`（本文） | 进度对照：已完成 / 简化 / 未完成 |
| `docs/changelog.md` | 实施日志摘编（按日期） |
| `docs/superpowers/specs/*` | NarrativeDirector、浏览器资源管线的专项设计 |
| `docs/superpowers/specs/2026-09-06-narrative-memory-audit-design.md` | 长期记忆强化与复核体系（facts/beliefs/lessons/audit）下一阶段设计，待实施 |
| `docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md` | **v2 剧情图架构（实施中）**：回溯/存档/多周目三合一、编剧-导演-演员三角色、破坏性重构授权 |
| `docs/superpowers/plans/2026-09-09-v2-rewrite-todo.md` | **v2 执行清单（交付版，2026-09-16 重整）**：面向一次性自主实现——任务卡 P1–P6 + 卫生门、设计决议 D1–D6、反重复地图、历史与偏差附录 |
| `.hygiene.config.json` / `.hygiene-baseline.json` | 仓库卫生自检校准值（阈值 / 豁免 / 标记基线），供用户级 `repo-hygiene` skill（`~/.agents/skills/repo-hygiene/`，不随仓库走）的机械检查脚本读取 |
| `docs/novel-skill/` | 长篇小说创作 skill（外部参考素材，非本项目规范） |
| `docs/agents/TTS-音色配置指南.md` | 音色创建与绑定操作指南 |
| `DESIGN.md` | 已归档（model-jsonl 时代旧架构，仅历史参考） |

## 已完成

### 协议与运行时
- **Gal DSL 单协议**：`src/core/protocol/gal-dsl/`（stream-decoder / line-parser /
  interaction-builder / group-builder / segment-validator / compiler / text-pipeline），
  含完整测试。JSONL 模型协议已于 2026-08-09 全量移除（changelog §115）。
- **演出状态**：`src/core/presentation/`——KEEP/SET/RESET、first-touch 初始化、
  hide/show/exit、`bgm stop`、站位互斥、未知角色 no-op（§11–§19、§52–§56）。
- **@end 哨兵与截断恢复**：nonce 校验、INCOMPLETE_SEGMENT、已发布前缀保留、
  recovery 续写（§45–§51）。
- **低水位续写**：`reconcileTextBuffer` + `start_threshold_lines`（2026-08-11），
  `@end buffer` 作为正常段边界（§73–§76）。
- **StoryStateReconciler**：`src/story/reconcile.ts` 确定性投影，主 DSL 的
  state_patch 应用路径已删除（§80–§81）。
- **生成上下文布局（D9，2026-09-17）**：user prompt 按「稳定 → 易变」排序（历史/
  素材前置、任务头置尾），删除 `game.history_events` 窗口截断——历史区单调追加、
  回溯 = 恢复重放天然截尾，保障 provider 前缀缓存命中（§70）。
- **交互生命周期**：choice / input / hybrid 三模式（DSL 推导 mode）、preview →
  confirm/cancel 两阶段、bridge 独立预取任务、BranchManager 候选预生成与提升、
  hybrid cancel 后 option 仍有效（§106 硬回归）。
- **端口化**：Game 消费 `StoryGeneratorPort`（InputBridge / tailVisualState /
  repairReason），bootstrap 经 `GeneratorPortFacade` 适配。
- **event 模式**：`narrative.event.max_interactions`（到达上限强制收束结局，模型
  连续不结束时运行时合成结局兜底）+ `restart_session` 命令（应用级重建）。

### 长线剧情（NarrativeDirector，spec 见 superpowers）
- 第 1+2 步「记忆过去」：committed events → episodes / threads / setups / anchors，
  导演便签（NarrativeBrief）注入 Writer 上下文；consolidator 流水线（FIFO 批次、
  shadow-state 事务校验、copy-on-write 持久化、单飞 + 节流）。
- 第 3 步「规划未来」：PlotPlanner / DirectorPlan，horizon 计划、低水位后台重规划、
  硬过期非阻塞 barrier、锚点推进与 consolidation 走内存写互斥。
- 三条硬约束（只记 committed / 计划不入事实记忆 / planner 不写台词）全部落实。
- `story-plan.yaml` 作者种子（threads / setups / anchors），加载容错。
- **记忆审计 Phase A（MA-A，2026-09-17）**：伏笔台账增强——`depth` 三档 +
  heavy 积累门控 + RESOLVE_OR_DROP 强制了断第三档（超期先于前置门）；
  intendedPayoff 必填（author seed 缺省记 warning，运行时 seed 硬拒，稳定规则
  码 `SETUP_SEED_WITHOUT_INTENDED_PAYOFF`）；**终局报告** `ending-report.json`
  （EndEvent 经 observeCommitted 触发、fire-and-forget、确定性聚合回收率/
  threads 终态/lessons 摘要）；**教训库 lessons**（`lesson-service.ts`：被拒 op
  按稳定规则码计数 ≥ `lessons.auto_from_rejections` 自动晋升、滚动窗口、
  brief [规避清单] 渲染）；facts.jsonl / lessons.jsonl 存储通道（facts 写入者
  随 Phase B）。validator 拒绝 reason 统一带 `[CODE] ` 稳定规则码前缀。
  `narrative-director-service.test.ts` 沿子系统缝拆分为 4 文件 + test-kit。

### 资源与舞台（浏览器）
- **资源目录**：`assets/resources.yaml` → `AssetCatalog`（Runtime/Model 双投影）→
  `asset-manifest`（公开 URL 清单）→ `BrowserAssetResolver`。
- **StageRenderer**：真实素材渲染——背景持久 `<img>` 淡入 crossfade、角色按
  characterId 的持久节点（variant 换 src、position 换 slot class、visible 切换），
  manifest 缺失时回退确定性色块占位。
- **BgmController**：真实 `<audio>` 循环播放（含 autoplay 手势解锁）；
  **SoundEffectController**：一次性音效播放。
- **UiProjection.visualState**：重连恢复完整视觉状态（§107）。

### 音频（TTS V2/V3 管线）
- **合成**：DashScope CosyVoice（`voices.yaml` V3 逻辑音色 → `.env` voice-id），
  PCM 流式（`pcm_s16le`）；TTS 按 `characterId` 查音色（§67），旁白不配音。
- **调度**：`audio-intent-planner` / `performance-compiler` / `tts-task-service` /
  `cache-key`，播放水位参数（startup_buffer / low_watermark / target_buffer）。
- **播放**：`web/src/audio/`——AudioCoordinator（共享 AudioContext + AudioWorklet）、
  AudioTimeline（顺序排队 / skip / 低水位驱动）、pcm-decoder。
- **缓存**：IndexedDB（`audio-db` + cache reader/writer/cleaner，容量上限与清理）。

### 持久化
- **v2 剧情图存储（唯一存档真源，M0–M1.6 落地）**：`games/<gameId>/`——
  `graph/*.jsonl`（scenes/decisions/edges/endings/runs，latest-wins）+
  `graph/snapshots/<decisionId>.json`（决策入口快照 = 运行时状态唯一物理真源）+
  `graph/payloads/<edgeId>.jsonl`（边负载 = 回放数据）+ `cursor.json`（活动周目
  游标）。原子写（tmp+rename）；快照缺失而索引行存在 = 结构损坏大声抛错。
  边 endState 内联 ⟺ 结局端点 ∨ 汇流边（2026-09-15 修订，M2 前置）；普通
  决策端点由后继入口快照派生、写入校验精确一致。
- **场景内汇流（M2.2）**：边收束后后台 LLM 判定（`narrative.confluence.enabled`，
  默认关、config.yaml 开）新边末态 vs 同场景既有节点入口态，命中即改指既有
  节点（凭据 + 真实末态内联），出边改源、游标前移、新节点孤儿化；候选排除
  路径祖先（防成环）与无入边节点；换周目/已完结即放弃改绑。场景节点按模型
  场景 id 世界级稳定（fresh 周目不再重复建场景节点）。
- **「继续游戏」三态入口（M1.4/M1.5）**：`restoreOrCreateRun`——游标恢复
  （入口快照重建 story/visual/memory，全路径边负载经 seq 水位过滤重放进导演，
  seq/turn 播种保证单调）/ 周目已完结补发结局 / 全新开局；`restart` 模式弃局
  活跃周目（abandonedAt）并在游标节点开 retrace 新周目（restart_session 接线）。
- **宿主世界接线（M5.0）**：web/cli 入口 `--game <id>` 与环境变量
  `VIBEGAL_GAME_ID`（参数优先）固定世界；local-web 未显式指定时读
  `games/.last-game` 续玩，启动后写回（best-effort：损坏/缺失即开新世界，
  读写失败不阻塞启动；id 只接受安全字符集，防路径逃逸）。CLI 不读写
  `.last-game`。`RuntimeApplication.gameId` 暴露给宿主。
- `sessions/<sessionId>/` 仅存 narrative 记忆工作缓存（narrative-state.json /
  episodes.jsonl / narrative-ops.jsonl + director-plan.json）；**可丢弃**——恢复
  永不读它，v1 的事件日志 `events.jsonl` 与内存态快照已随 M1.6 删除。

## 简化 / 未完成

- **v2 剧情图架构（实施中）**：M0 契约冻结、M1.1 记忆摘要映射、M1.2 图存储、
  M1.3 演员接图、M1.4 游标恢复、M1.5 新周目入口（root/retrace）、M1.6 sessions
  JSONL store 删除、M2.1 ConfluenceJudge port + LLM 判定 adapter、M2.2 场景内
  汇流（后台判定 + 有界改绑 + promise 链互斥）、M5.0 宿主接线均已完成；
  执行清单已于 2026-09-16 重整为**交付版**（任务卡 P1–P6：M5.0 宿主接线 →
  记忆审计 Phase A/B → 编剧+大纲+世界生成 → 导演+剪报 → 收束+canon+汇流补完 →
  图 UI+结算；M2.3 端到端验证归人工清单）。待做清单与卫生门见执行清单。
- **event mode / forced ending / max_interactions**：过渡期保留（恢复后
  interactionCount 清零、不跨周目累计）；M3.5 由大纲结局驱动替代时整体删除。
- **PlaybackBuffer 未迁 EventGroup**：采用 §63 展平方案（事件携带 `stage` 字段），
  缓冲仍是展平 `RuntimeBufferEvent[]`；prelude+main 同组提交已由组编译保证。
- **beat 播放时机**：提交时立即应用（stage_beat_ready），不做缓冲时序。
- **舞台动画**：背景 crossfade / 角色 fade 为 CSS transition 基础版；无更复杂的
  转场/动画系统。
- **BGM 转场**：直接切换，无淡入淡出；音量/静音有 API，无自动 ducking。
- **CLI 音频**：`media.audio.synthesis.provider=disabled` 默认纯文本（CLI 不接 TTS 播放；planner 就绪查询为过渡桩，恒立即就绪）。
- **回溯只到游标（最前沿节点）**：任意祖先节点回溯 + 同选项快进随 M5.3 回溯
  入口 UI 落地（见执行清单 M5.3 注记）。
- **seq 播种已按世界最大值统一（M2.1 决议，2026-09-16）**：`nextSeq =
  max(世界最大 seq, 路径末 seq, digest 水位) + 1`，同世界新 root 周目不再从
  1 回绕；跨周目单调是 M2.2 汇流后 `pickLatestInEdge` 与记忆水位过滤的前提。

## 近期提交锚点

- `fabed3a` M2.2 场景内汇流：后台判定 + 有界改绑 + 互斥链 + 场景节点世界稳定
- `a6ad549` M2.1 ConfluenceJudge port + LLM adapter + 世界最大 seq 播种
- `b9f3f8d` M1.5 新周目入口：restart 弃局 + retrace、origin 保留
- `875b75f` M1.4 游标恢复：三态入口、全路径重放、isStoredEvent 守卫修复
- `6131bea` M1.3 演员接图 + M0 契约审查修复
- `75fa102` M1.1+M1.2 记忆摘要映射 + 图存储
- `6fbf389` M0 契约冻结
- `85f6346` forced ending 贯穿 repair、泵排空、flush 加固（v1 尾期）
