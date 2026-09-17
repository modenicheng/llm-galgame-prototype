# 实施进度对照（status）

> 快照日期：**2026-09-17**，对照 `main` 分支代码。本文是唯一的进度权威文档；
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
| `docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md` | **v2 剧情图架构（已全量落地）**：回溯/存档/多周目三合一、编剧-导演-演员三角色、破坏性重构授权 |
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
  state_patch 应用路径已删除（§80–§81）；**MA-A2（2026-09-17）**契约对齐：
  StoryState 收缩为投影产物（scene/characters/recent_summary，
  CharacterState 只留 location），canon/open_threads/player_profile/角色
  富字段与 StoryStatePatch/patch.ts 死代码整体删除，`SNAPSHOT_VERSION` 3
  （决议 D10；物品/场景细节语义由 MA-B facts 承载）。
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
  consolidator 流水线（FIFO 批次、shadow-state 事务校验、copy-on-write 持久化、
  单飞 + 节流）；**MA-A（2026-09-17）**记忆强化五项落地（depth/RESOLVE_OR_DROP、
  intendedPayoff 硬拒、ending-report 确定性聚合、lessons 拒绝码计数自动晋升 +
  brief 规避清单、facts/lessons jsonl 通道）；**MA-B/MA-A2（2026-09-17）**：
  MemoryDigest 嵌入 facts/beliefs 全文（SNAPSHOT_VERSION 1→2→3，StoryState 收缩
  为 reconcile 投影产物：scene/characters/recent_summary），恢复不依赖 canon。
- **导演子系统（M4.1–M4.5，2026-09-17）**：`DirectorService`（AgentRunnerPort
  工具循环 ≤6 步强制收束）产 `SceneDirective`（场景目标/防守节拍/收束压力/
  表单收窄）；场景边界 `triggerDirective` fire-and-forget；**剪报防火墙**
  （`buildActorBriefing` = MemoryProjection + directive，参数形状不含 outline
  全量/结局候选/他周目数据）；游戏侧 `assertInteractionPolicy` 消费 formModes、
  free_input 后台 `evaluateFreeInput` 防守节拍（滞后一拍）；交互驱动簇迁
  `interaction-driver.ts`；PlotPlanner/DirectorPlan/NarrativeBrief 已整体删除
  （M4.4，战术规划并入导演编排）。
- **收束与跨周目真相（M3.5/M3.6，2026-09-17）**：`narrative.mode` 键整体删除
  （longform 唯一路径），收束压力 = 模型判定 ∨ 大纲确定性信号（前沿 act 全
  realized 或维护已 activate 终章候选——导演读大纲 ending 候选、演员不可见）；
  `CanonStore`（world/canon.json + canon.log.jsonl）+ `CanonPromoter` 跨周目
  major facts 后台晋升（≥2 周目内容佐证 → 编剧裁决 promote/例外登记；读取方 =
  导演输入 + 编剧维护，演员不可见；晋升不回改既有快照）。
- `story-plan.yaml` 作者种子（threads / setups / anchors），加载容错；
  `prompts/story_line.txt` 全局注入已删除（M3.7），storyLine 只来自 per-game
  `world/prompts/`（缺失大声报错；无世界启动时该段缺省）。
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
- **记忆审计 Phase B（MA-B，2026-09-17）**：consolidator 输出契约扩展——
  FactOp/BeliefOp/AuditFinding 搭载既有调用（零新增 LLM 调用）；facts/beliefs
  内存投影 + 持久化（facts 随 state 快照 + facts.jsonl 留痕；beliefs 入
  narrative-state.json）；fact-retriever + brief [相关既定事实]/[角色认知]
  渲染；findings 全量留痕 narrative-ops.jsonl、critical/major 自动晋升 lesson
  （audit 来源）；批内预算（establish ≤3、每角色 belief ≤2、findings ≤5）；
  **SNAPSHOT_VERSION 1→2**：MemoryDigest 增 facts/beliefs 全文（D6），恢复
  不依赖 canon；旧 v1 快照读取即拒。dsl-protocol.txt 增事实/认知边界规则行。

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
- **场景间/滞后汇流 + 末态索引（M2.4，2026-09-17）**：候选不再限同场景——
  末态索引（摘要键 = location/在场角色集/outline 物理地点）确定性预筛限流
  judge 调用，命中键数降序优先；滞后汇流天然获得（新边收束对索引全量预筛）。
- **回溯入口 + 同选项快进（M5.3，2026-09-17）**：`retraceFrom(decisionId)`
  任意祖先节点开新周目（活跃周目 abandonedAt 仅记账，图零删除，D7）；
  `beginEdge` 返回判别联合——选择与既有出边 kind+text 严格相等且指向决策
  节点时命中快进（零内容生成，直接恢复后继表单；结局端点不参与）；
  retrace 命令贯穿 wire schema → Game（RetraceRequestedError → prepareRetrace
  → 同一 Game 重入 run）→ 图面板回溯确认 UI（「在此分叉开启新周目」措辞）。
- **世界级附加存储（M3.6/M5.4/M5.5，2026-09-17）**：`world/canon.json` +
  `world/canon.log.jsonl`（跨周目事实晋升）；`stats.json`（结局达成 + 边通过
  计数，按周目幂等结算）；`reviews/<runId>.json`（通关评分：玩家星级 + 编剧
  评注，评价喂回编剧维护输入）。均为 append-only/原子写、损坏大声抛错。
- **图维护 GC（M5.6，2026-09-17）**：协调器内部回收**不可达**内容（崩溃孤儿、
  汇流孤儿、入边归零级联；幂等）——被任何周目路径（含已弃）到达的节点与边
  不可回收（负面测试锁定）；存储层 tombstone 行（`{id, deleted:true}`，
  append-only 不回改，§3 契约 schema 未动）；无任何玩家删除入口（D7）。
- `sessions/<sessionId>/` 仅存 narrative 记忆工作缓存（narrative-state.json /
  episodes.jsonl / narrative-ops.jsonl + facts/lessons jsonl + ending-report）；
  **可丢弃**——恢复永不读它，v1 的事件日志 `events.jsonl` 与内存态快照已随
  M1.6 删除。

## 简化 / 未完成

- **v2 剧情图架构：交付版执行清单 P1–P6 全部完成（2026-09-17）**——M5.0 宿主
  接线 → 记忆审计 Phase A/B（MA-A/MA-B/MA-A2）→ 编剧+大纲+世界生成 → 导演+
  剪报（M4.1–M4.5）→ 收束+canon+汇流补完+story_line 清理（M3.5/M3.6/M3.7/M2.4）
  → 图 UI+结算+评分+GC（M5.1–M5.6）；六道完整档卫生门（GH-P1～GH-P6）全部
  过门（三绿 + 机械检查 + subagent 只读评审，P1/P2 当场修复、P3 记附录 B）。
  M2.3 汇流端到端真实 LLM 验证归人工清单。剩余技术债见执行清单附录 B
  （interaction-driver 二分 input/choice、run-graph-coordinator 拆 confluence、
  game.ts 豁免清偿、若干 P3 记档项）。
- **PlaybackBuffer 未迁 EventGroup**：采用 §63 展平方案（事件携带 `stage` 字段），
  缓冲仍是展平 `RuntimeBufferEvent[]`；prelude+main 同组提交已由组编译保证。
- **beat 播放时机**：提交时立即应用（stage_beat_ready），不做缓冲时序。
- **舞台动画**：背景 crossfade / 角色 fade 为 CSS transition 基础版；无更复杂的
  转场/动画系统。
- **BGM 转场**：直接切换，无淡入淡出；音量/静音有 API，无自动 ducking。
- **CLI 音频**：`media.audio.synthesis.provider=disabled` 默认纯文本（CLI 不接 TTS 播放；planner 就绪查询为过渡桩，恒立即就绪）。
- **seq 播种已按世界最大值统一（M2.1 决议，2026-09-16）**：`nextSeq =
  max(世界最大 seq, 路径末 seq, digest 水位) + 1`，同世界新 root 周目不再从
  1 回绕；跨周目单调是 M2.2 汇流后 `pickLatestInEdge` 与记忆水位过滤的前提。

## 近期提交锚点

- `fe933c6` GH-P6 门禁：P1 快进透传修复 + 评价喂回/大纲回顾生产接线 + parseJsonl 写序契约
- `64c0fc7` M5.6 图维护 GC：tombstone + 不可达回收 + 级联幂等
- `5152769` M5.5 通关评分 reviews + 评价喂回 + 大纲回顾通关解锁
- `8600e33` M5.4 结算统计 stats.json + 结算/图鉴视图与 API
- `85fd883` M5.3 retraceFrom 回溯入口 + 同选项快进（零生成）+ 图面板回溯 UI
- `371a006` M5.1/M5.2 总览图 API + 决策子图 + graph-panel 可视化
- `7ed0d1a` M3.7 story_line 静态注入删除（只留 per-game 世界文件）
- `8427147` M3.6 canon 存储 + 跨周目事实晋升管线
- `6a13532` M3.5 大纲收束压力接线导演 + event mode 整体删除
- `94615e0` M2.4 末态索引 + 确定性预筛 + 场景间/滞后汇流
- `ee4fc6d` M4.3 防守节拍 + 相位门接线（P4：M4.1 runner / M4.2 剪报防火墙 /
  M4.4 PlotPlanner/DirectorPlan/NarrativeBrief 删除 / M4.5 game.ts 拆分同期落地）
- `fabed3a` M2.2 场景内汇流：后台判定 + 有界改绑 + 互斥链 + 场景节点世界稳定
- `a6ad549` M2.1 ConfluenceJudge port + LLM adapter + 世界最大 seq 播种
- `b9f3f8d` M1.5 新周目入口：restart 弃局 + retrace、origin 保留
- `875b75f` M1.4 游标恢复：三态入口、全路径重放、isStoredEvent 守卫修复
- `6131bea` M1.3 演员接图 + M0 契约审查修复
- `75fa102` M1.1+M1.2 记忆摘要映射 + 图存储
- `6fbf389` M0 契约冻结
- `85f6346` forced ending 贯穿 repair、泵排空、flush 加固（v1 尾期）
