# 实施进度对照（status）

> 快照日期：**2026-09-18**，对照 `feat/campus-ops-raspberry` 分支代码。本文是唯一的进度权威文档；
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
| `docs/novel-skill/` | 长篇小说创作 skill（外部参考素材，非本项目规范） |
| `docs/agents/TTS-音色配置指南.md` | 音色创建与绑定操作指南 |
| `docs/local-tts.md` | 本地 TTS 引擎部署指南（qwentts.cpp / Python tts-server，provider: local） |
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
- **交互生命周期**：choice / input / hybrid 三模式（DSL 推导 mode）、preview →
  confirm/cancel 两阶段、bridge 独立预取任务、BranchManager 候选预生成与提升、
  hybrid cancel 后 option 仍有效（§106 硬回归）。
- **端口化**：Game 消费 `StoryGeneratorPort`（InputBridge / tailVisualState /
  repairReason），bootstrap 经 `GeneratorPortFacade` 适配。
- **event 模式**：分级收束（2026-09-14）——`wrapup_interactions`（L1 软提示，
  默认 6）→ `closing_push_interactions`（L2 强提示 + 停止分支预取，默认 8）→
  `max_interactions`（L3 运行时保险丝：endingRequired + 模型连续不结束时合成
  结局兜底，默认 10）；交互进度注入 prompt、进入 L1 时种子线程 new → ready。
  修复链上限 `generation.max_consecutive_repairs`（默认 2）：耗尽转 L2，仍失败
  才升 L3。长回合护栏 `max_events_between_interactions`（默认 24）：自上次交互
  的文本事件超限后附"尽快交互"提示。+ `restart_session` 命令（应用级重建）。
  恢复时从 events.jsonl 重建交互计数与收束级别。
- **会话记忆代理**（2026-09-18，落地 09-17 记忆审计定稿）：event 模式专属的
  事件流投影器（`src/story/memory-agent.ts` 合并层 + `MemoryAgentAdapter`）。
  从增量提交事件提取人物 emotion/goal/relationship、canon 事实（≤12 键，
  scenario_* 钉住）、线程推进（前向迁移校验，不得覆盖 L1 的 ready 翻转；
  ≤8 条），merge-only 写入 StoryState——summarizeState 的既有槽位零管道
  改造注入。单飞 + `memoryWatermark` 水位随快照成对持久化；失败只跳过
  本批，绝不杀 run loop。种子 purpose 生命周期：首个交互提交后转中性
  锚点（不再以现在时常驻）。

### 长线剧情（NarrativeDirector，spec 见 superpowers）
- 第 1+2 步「记忆过去」：committed events → episodes / threads / setups / anchors，
  导演便签（NarrativeBrief）注入 Writer 上下文；consolidator 流水线（FIFO 批次、
  shadow-state 事务校验、copy-on-write 持久化、单飞 + 节流）。
- 第 3 步「规划未来」：PlotPlanner / DirectorPlan，horizon 计划、低水位后台重规划、
  硬过期非阻塞 barrier、锚点推进与 consolidation 走内存写互斥。
- 三条硬约束（只记 committed / 计划不入事实记忆 / planner 不写台词）全部落实。
- `story-plan.yaml` 作者种子（threads / setups / anchors），加载容错。

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
- **合成 provider 四选一**（`media.audio.synthesis.provider`）：`local`（本机
  推理，**当前默认**）/ `dashscope`（云端）/ `mock`（确定性正弦波 PCM，
  不写盘）/ `disabled`（纯文本）。
  - `local`（2026-09-18，`src/adapters/tts/local-qwen3-tts-provider.ts`）：
    对接 `tts-server/` 本机推理（RTX 5060）。默认方言 `openai` → **qwentts.cpp
    C++ 后端**（OpenAI 兼容 `POST /v1/audio/speech`，127.0.0.1:9766；首包
    ~530ms、四路吞吐 RTF ~0.09、显存 ~2.4G、无预热）；`.env` 设
    `LOCAL_TTS_DIALECT=tts-server` 切 Python 引擎（9765，保留作 fallback），
    `LOCAL_TTS_BASE_URL` 覆盖地址。音色在 `voices.yaml` `providers.local.voice`
    （键 = `tts-server/voices/registry.json`），五音色单模型（树莓娘 paimeng
    克隆 + 四配角内置音色克隆）、固定 24 kHz 流式 PCM、句子级浪批处理与取消；
    克隆路径不支持 rate/pitch/volume/seed/instructions（对齐 qwen3-tts-vc
    语义）。客户端 abort → 主动 `reader.cancel` → 服务端浪级剔除。
    服务部署/构建/音色重建见 `tts-server/README.md`。
  - dashscope 双模型族（`voices.yaml` V3 逻辑音色逐档案配 `model`，`.env` 放
    voice-id），PCM 流式（`pcm_s16le`）；TTS 按 `characterId` 查音色（§67），旁白不配音。
    - `cosyvoice*`：SpeechSynthesizer 端点（参数在 input，支持 rate/pitch/volume/seed）。
    - `qwen3-tts*`（flash/instruct/vc/vd）：multimodal-generation 端点（text/voice，参数
      不支持自动丢弃），固定 24000 Hz PCM；flash/vc 带 WAV 容器头（provider 剥离），
      instruct 为裸 PCM（直通）；仅 instruct 模型支持 `instructions`。
    - 启动校验：qwen3 档案要求 `synthesis.sample_rate: 24000`；local 档案同样
      校验 24000；跨族音色（按 id 前缀）直接报错（两族复刻/设计音色不互用）。
- **调度**：`audio-intent-planner` / `performance-compiler` / `tts-task-service` /
  `cache-key`，播放水位参数（startup_buffer / low_watermark / target_buffer）。
  缓存键含 model/采样率，换模型族自然失效。
- **播放**：`web/src/audio/`——AudioCoordinator（共享 AudioContext + AudioWorklet）、
  AudioTimeline（顺序排队 / skip / 低水位驱动）、pcm-decoder（worklet 按
  descriptor 采样率重采样）。
- **缓存**：IndexedDB（`audio-db` + cache reader/writer/cleaner，容量上限与清理）。
- **玩家音频设置**（2026-09-19）：语音/BGM 音量双通道分离，与静音、字速一起
  收进控制条「设置」浮层（`web/src/ui/settings-menu.ts`）；偏好经 localStorage
  持久化（`web/src/storage/player-settings.ts`），刷新自动恢复。

### 持久化
- `sessions/<sessionId>/` 会话目录：`events.jsonl` + narrative 记忆三件套
  （narrative-state.json / episodes.jsonl / narrative-ops.jsonl）+
  `director-plan.json`；director 关闭时 flush 落盘。
- **存档统计与管理**（`src/adapters/storage/session-archive.ts`）：跨会话视角的
  存档列表/统计（事件与交互计数、回合进度、phase/ending、叙事记忆在位、
  磁盘占用、遗留扁平日志盘点）与按目录删除（sessionId 严格校验防路径逃逸）。
  入口：CLI `--saves` / `--delete-save <id>`；Web 侧只读 `GET /api/saves`
  （删除不开放 HTTP）。存档槽位/任意进度存读仍为路线图项。

## 简化 / 未完成

- **PlaybackBuffer 未迁 EventGroup**：采用 §63 展平方案（事件携带 `stage` 字段），
  缓冲仍是展平 `RuntimeBufferEvent[]`；prelude+main 同组提交已由组编译保证。
  （原"会话恢复闭环"缺口已由 `3743ba8` 会话持久化恢复关闭：load/resume、
  事件日志恢复、快照元数据、视觉状态与交互游标恢复均已落地。）
- ~~beat 播放时机~~：已于 2026-09-17 修复——RuntimeBeatEvent 进播放队列，
  beat 组舞台 cue 在播放位生效（c8cb600），不再是提交即应用。
- **舞台动画**：背景 crossfade / 角色 fade 为 CSS transition 基础版；无更复杂的
  转场/动画系统。
- ~~BGM 转场~~：直接切换的缺口已由 `f876e2d` 关闭——bgm_playback 可配置
  淡入淡出 + 裁切窗口循环。自动 ducking 仍无。
- **CLI 音频**：`media.audio.enabled=false` 默认纯文本（CLI 不接 TTS 播放）。
- **存档槽位/任意进度存读**：仍为路线图项（现为整会话目录级管理）。
- **记忆代理监控接线**：memory agent 的 LLM 调用已计入
  `metrics.requests.memory_agent`，但监控 context 面板尚未给它独立
  task kind（wire `MonitorContextTaskKind` 待扩 "memory"）。

## 近期提交锚点

- `72aed79` 默认后端切 qwentts.cpp——local provider 双方言（openai/tts-server）
- `f0069fc` 会话记忆代理——事件流投影人物/设定/线程入 StoryState
- `9253fe6` 隐形说话自动显形兜底 + stageWarnings 舞台警告注入
- `24a1442`/`22fe8ce` 确定性补哨兵 + 固定尾任务字面固定尾
- `c424076`/`c9699d3` 写手 DSL 流全量落盘 + /monitor/records 只读路由
- `b2010be` 修复续写动态预算 + 丢弃重试 + sliceId 监控原位替换
- `c8cb600` RuntimeBeatEvent 进播放队列——beat 组舞台 cue 在播放位生效
- `ee94050` monitor 面板布局重构——列/行分割器 + 日志页几何跟随渲染

## 校园技术社团值班分支（campus-ops-raspberry，2026-09-08）

本分支在通用框架上叠加独立展位体验，不改动 `main` 的长线剧情/记忆能力：

- **开放叙事**：每局从 `prompts/campus-ops.yaml` 的一条叙事种子开始；
  种子为严格 schema（禁止 `required_rounds`/`success_path` 等流程字段），
  只提供起点情境。选择策略为 sessionId 确定性轮换，
  `CAMPUS_SCENARIO_SEED_ID` 可显式指定（`src/campus/scenario-seeds.ts`）。
- **通用最小接口**：`GamePorts.initialStoryState`（组合根可预置初始故事
  状态；恢复路径不受影响，longform 缺省行为不变）。
- **角色适配**：`prompts/characters.txt` 分层（BITNP 已核对事实 / 本分支
  演绎）；世界规则、事实边界写入 `story_line.txt`/`guideline.txt`/
  `author.yaml`；结局只依据本局 committed facts。
- **资源策略**：背景使用 clubroom/wencui_corridor/campus_road/club_plaza；
  树莓娘为基于负责人提供的官方分层原稿加工的差分立绘（base + 18 表情差分 +
  剪影，2026-09-15 接入，仅限内部流通）；另有 4 个自制 AI 通用配角立绘
  （female_A/female_B/male_A/male_B，各 base + smile/surprised/embarrassed，
  2026-09-15 接入，AI 原创随仓库分发）；BITNP 其余素材未授权不接入（来源审计见
  `docs/superpowers/notes/campus-ops-source-audit.md`）。
- **本地语音**：`synthesis.provider: local`（tts-server 本机推理，无需 TTS
  key；服务未启动时合成失败降级纯文本，不阻塞运行）。
- **现场文档**：`docs/campus-ops-event-runbook.md`（一人操作/重开/指定种子）。
- **展位 UI 重开闭环（Task 6，2026-09-14）**：结束页与控制条"重开"均发送
  `restart_session`，宿主原地重建新会话（新 ID → 种子轮换），ws rebase 对
  现有连接改挂新 game 并推送新会话投影快照；重开期间按钮 pending；会话切换
  清空舞台与表单草稿；会话 ID 在控制条角标（点击复制）/结束页/报错横幅展示；
  等待界面显示运行阶段文案；`UiProjectionStore` 按会话 id 变化重置，旧会话
  状态不泄漏。生成等待中重开最迟当前段超时（约 60s）生效。

待办：树莓娘音色授权（差分立绘已于 2026-09-15 接入）；展位实测后的种子扩充；
回 `main` 审查（`core:` 提交可回流，campus 内容保留本分支）。
