# 实施进度对照（status）

> 快照日期：**2026-10-09**，对照 `main` 分支代码。本文是唯一的进度权威文档，
> 设计规范见 `docs/llm-outputs-refactor.md`。
> 后续开发完成/变更条目时请同步更新本文。

## 文档地图

| 文档 | 职能 |
|---|---|
| `README.md` | 运行方式、TTS 配置入口 |
| `docs/llm-outputs-refactor.md` | DSL 协议与运行时架构的规范设计（§ 编号被源码注释引用） |
| `docs/status.md`（本文） | 进度对照：已完成 / 简化 / 未完成 |
| `docs/superpowers/specs/*` | 已落地/待实施子系统的专项设计（状态见各文头） |
| `docs/superpowers/specs/2026-09-06-narrative-memory-audit-design.md` | 长期记忆强化与复核体系（facts/beliefs/lessons/audit）下一阶段设计，待实施 |
| `docs/superpowers/specs/2026-09-16-character-voice-design.md` | 角色音频特征设计（编剧画像/导演指导三层模型），待实施 |
| `docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md` | **v2 剧情图架构（已全量落地）**：回溯/存档/多周目三合一、编剧-导演-演员三角色、破坏性重构授权 |
| `.hygiene.config.json` / `.hygiene-baseline.json` | 仓库卫生自检校准值（阈值 / 豁免 / 标记基线），供用户级 `repo-hygiene` skill（`~/.agents/skills/repo-hygiene/`，不随仓库走）的机械检查脚本读取 |
| `docs/novel-skill/` | 长篇小说创作 skill（外部参考素材，非本项目规范） |
| `docs/agents/TTS-音色配置指南.md` | 音色创建与绑定操作指南 |

## 已完成

### 协议与运行时
- **Gal DSL 单协议**：`src/core/protocol/gal-dsl/`（stream-decoder / line-parser /
  interaction-builder / group-builder / segment-validator / compiler / text-pipeline），
  含完整测试。JSONL 模型协议已于 2026-08-09 全量移除（changelog §115）。
- **@ 前缀指令语法 + 分层修复（2026-09-18，自 campus 线移植）**：所有指令行
  `@` 化（`@bg/@bgm/@se/@ch/@beat/@?/@+/@=/@/?/@end`），未知 @ 行
  `UNKNOWN_COMMAND` 拒绝、裸写法 `RETIRED_ALIAS` 响亮报错、全角前缀归一化；
  closing-repair 三层修复（哨兵规范化/台词头槽位 swap/空 `@?` 合并）接入生成流；
  `DslProtocolError` 携带 FastAPI 式 detail 注入下一轮修复指令；strip-and-continue
  剔除续写（白名单坏行剔除后 assistant 前缀同 parser 续写，每 attempt 预算 1 次，
  S1/S2/N1 边界加固）；段失败即后台启动修复段（fail-fast，消除读空队列后的
  冷启动空窗）；幻影角色去污染（knownCharacterIds 门控 + summarizeState 过滤）；
  舞台状态注入全维度显式化 + compiler `REDUNDANT_STAGE_CUE` 冗余兜底。
  `@ending` DSL 能力保留惰性解析、协议不宣传（待拍板）。
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
- **本地合成（2026-09-16 移植 campus 线）**：`synthesis.provider: local` →
  `LocalQwen3TtsProvider`（本机 Qwen3-TTS 推理服务，OpenAI 兼容
  `/v1/audio/speech` 或 `tts-server` Python 方言，`LOCAL_TTS_BASE_URL`/
  `LOCAL_TTS_DIALECT` 覆盖）；voices.yaml `providers.local` 注册表键音色
  （与 dashscope 绑定并存），固定 24000 Hz（启动校验拦截）；
  `TtsProviderError`/`deferred` 抽为 `adapters/tts/` 共享模块。
- **角色音频特征（2026-09-16 V1/V2 落地，spec：character-voice-design）**：
  编剧画像 `DraftCharacter.voice`（timbre/调色板/baseline）→ 世界创建期落盘
  `world/voice-design.json` 并渲染进 characters.txt；导演逐场景声音指导
  `SceneDirective.voice`（会话外查询经 VoiceDirectionHub）；编译器合并链
  导演 > 演员逐行 > 画像基线 > 恒等值（进 cacheKey）；动态角色经
  mergeVoiceDesignViews 注入（dashscope 需 `DASHSCOPE_VOICE_FALLBACK`，
  local 待 V3 身份合成）；表演词汇表运行时常量单一真源。
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
  过门（三绿 + 机械检查 + subagent 只读评审）。执行清单已完成退役删除；
  未清偿项移交下方「技术债账本」与「人工验证清单」。

### 技术债账本（v2 卫生门 P3 记档移交 + 2026-10-09 卫生批次，清偿后请划掉）

结构性（豁免在册，见 `.hygiene.config.json`，清偿后同步移除豁免）：

- `game.ts`（1576 行）：run()/startActiveSegment() 超长、run() buffer 分支
  5 层嵌套；record 返回值双通道死支；段生命周期/恢复簇拆分的前置 =
  game.test.ts 32 处 `as any` 私有访问去耦合（建公共断言 API）。
  （DSL 组编译簇已于 2026-10-09 外移 `runtime/dsl-group-compiler.ts`。）
- `openai-compatible-generator.ts`：拆出 dsl-stream-attempt
  （strip-and-continue 主循环 ~450 行）。
- `narrative-director-service.ts`：收窄为记忆子层（M4.4 尾项）。
- 已清偿（2026-10-09 卫生批次）：interaction-driver 二分
  choice/input/driver 三文件（豁免移除）；run-graph-coordinator 拆出
  `confluence-checker.ts` + 图行走算法下沉 `core/graph/walk.ts`
  （1150→849 行，豁免移除——后续可再拆大纲维护子系统 ~270 行进 warn 线）。

跨模块重复（抽共享基础设施）：

- tmp+rename 原子写仓内 ~9 份；`isEnoent` 惯用法 ≥5 处；OpenAI client
  构造样板 ×5；跨 adapter 同构 JSON 调用 5 处；web/cli `parseArgs` 近重复；
  host 三个 GET 路由同构；web 侧 latestEnding 定位两处；图存储 latestById
  派生六处；config 默认值在 zod `.default` 与代码 `??` 双重派生（含
  bootstrap 兜底 cosyvoice_v3_flash/22050/2；web 端 PublicWebConfig 兜底
  已于 2026-10-09 收敛单源 `shared/wire/public-web-config.ts`）。
  （图逆向行走 ×4 已随 `core/graph/walk.ts` 清偿。）

行为/契约小项：

- canon-store saveScaffold catch-all 应 ENOENT-only；canon-store-port
  getCanon 的 throw 契约迫使调用方吞错（宜 `| undefined`）；
  readSceneHistory 静默 continue 无告警；outline-writer-adapter
  maintainOutline 解析失败与 schema 失败混报；loadCanonQuietly 死防御
  catch；`interaction.default_mode` 校验但运行时不消费（死键）；
  `@ending` 惰性解析无运行时消费者（启用时机随通关评分结局档位）；
  测试 fixture 硬编码快照版本号应引 `SNAPSHOT_VERSION`；
  `makeCtx(null as unknown as StoryState)` 类型欺骗（入参应收窄）；
  `fast_forward` 字面量 ×4；segment-types ChoiceSelection 重抄字段；
  测试 fixture 的 `state_patch` 冗余键 ~30 处；
  `interaction-input.ts` 的 handleInteractionInput ~230 行 /
  handleHybridInteraction 内 syntheticChoice 构造 ×2（二分时按行为
  逐行迁移保留，函数级拆分待做）；confluence-checker 的 sceneOutlineRefs
  Map 值未读（可 Set）与 hydrate 双重 get（随拆分迁入）；
  源码注释引用的子节锚点 §8.5/§10.2/§11.6/§11.7/§13.x（game.ts 及
  game*.test.ts / runtime 注释）在任何文档中均不存在——基线遗留的
  悬空引用，语义应就近写明或改指真实出处。

待实施特性（spec 在册）：

- 角色音频特征 V3：身份合成（dashscope qwen3-tts-vd / local 参考音中继
  + per-game voice-bindings），config 门控默认关
  （spec：2026-09-16-character-voice-design）。

### 人工验证清单（需真实 LLM 会话 / 手感，2026-09-17 移交）

1. **M2.3 汇流端到端**：真实会话离谱输入 → 防守节拍引回 → 图上呈现汇流
   （`edges.jsonl` 出现 confluence 凭据）；`narrative.confluence.enabled`
   开启后的判定质量。
2. **MA Phase A/B 验收**：超期伏笔 RESOLVE_OR_DROP 出现；ending-report.json
   数值与体感一致；事实/认知边界端到端。
3. **M3.3 世界生成质量**：真实描述 → 大纲/角色/开场可玩性、防剧透直通体验。
4. **M5 图 UI 手测**：总览（含同物理场景并排分组）/子图/回溯/快进/结算/
   图鉴/评分全流程（web 控制区「剧情图」按钮入口）。
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
