# 实施进度对照（status）

> 快照日期：**2026-09-04**，对照 `main` 分支代码。本文是唯一的进度权威文档；
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
- `sessions/<sessionId>/` 会话目录：`events.jsonl` + narrative 记忆三件套
  （narrative-state.json / episodes.jsonl / narrative-ops.jsonl）+
  `director-plan.json`；director 关闭时 flush 落盘。

## 简化 / 未完成

- **PlaybackBuffer 未迁 EventGroup**：采用 §63 展平方案（事件携带 `stage` 字段），
  缓冲仍是展平 `RuntimeBufferEvent[]`；prelude+main 同组提交已由组编译保证。
  （原"会话恢复闭环"缺口已由 `3743ba8` 会话持久化恢复关闭：load/resume、
  事件日志恢复、快照元数据、视觉状态与交互游标恢复均已落地。）
- **beat 播放时机**：提交时立即应用（stage_beat_ready），不做缓冲时序。
- **舞台动画**：背景 crossfade / 角色 fade 为 CSS transition 基础版；无更复杂的
  转场/动画系统。
- **BGM 转场**：直接切换，无淡入淡出；音量/静音有 API，无自动 ducking。
- **CLI 音频**：`media.audio.enabled=false` 默认纯文本（CLI 不接 TTS 播放）。

## 近期提交锚点

- `85f6346` forced ending 贯穿 repair、泵排空、flush 加固
- `9085caf` event 模式 max_interactions + restart_session
- `fcdb58c` 会话目录统一 + director flush on shutdown
- `3f3bb69` 文档修正 + DESIGN.md 归档
- `14e3d8a..3618dd6` NarrativeDirector 第 3 步（Task 1–9）

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
- **资源策略**：背景复用 clubroom/hallway；树莓娘为项目自制占位立绘
  （单 variant）；BITNP 素材未授权不接入（来源审计见
  `docs/superpowers/notes/campus-ops-source-audit.md`）。
- **文本优先**：`synthesis.provider: disabled`，音频缺省不阻塞启动。
- **现场文档**：`docs/campus-ops-event-runbook.md`（一人操作/重开/指定种子）。

待办：树莓娘正式立绘与音色授权；展位实测后的种子扩充；
回 `main` 审查（`core:` 提交可回流，campus 内容保留本分支）。
