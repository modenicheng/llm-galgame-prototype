# 实施日志（changelog）

> 摘编自原 `docs/llm-outputs-refactor.md` §114–§118（该文件 2026-09-04 拆分，
> 全文见 git 历史）。当前进度权威见 `docs/status.md`。

## 2026-09-19 ~ 2026-09-20 语音动态处理、序章卡与真机档位（campus 分支）

**语音动态处理（DSP）链**
- 动态处理核心与参数模型：语音/BGM 共用 dynamics worklet，
  `src/shared/wire/audio-dsp.ts` zod 单一来源（657ee65）；播放链接入 +
  `audio-dsp.yaml` 程序写回持久化与热生效（1e15736）；/monitor 新增「音频」
  操作台——DSP 参数编辑/保存与实时仪表（435563e）。
- 真机全静音 P0 修复：worklet 采样率误读实例字段产 NaN 毒化总线，附审计
  七项修复（62aaf41）；`range_db` 语义勘误 + TTS 排障表补双实例挂死形态
  （c6b96bd）；实测档位随 ef07db3 固化。

**玩家端**
- 序章卡：本局引子在开场生成期的过场展示——种子进投影
  （`session_started.intro`），开场全文与后续行进回看（9bd690b）。
- 结尾页「返回主界面」+ 主界面过往记录（6a77141）；玩家端禁文本选择与
  图片拖拽，/monitor 不受影响（4976676）；结局画面排印微调（5ee8c4e）。

**运行时与生成质量**
- 快照不再等待在飞记忆提取——交互后推进被记忆 LLM 链阻塞 15~20s 的根治
  （260dab1）；Canon 展示形态对齐提示词 JSON 形状——键=值，防记忆代理照抄
  成非法 JSON 丢整批状态更新（2809393）。
- opening 模板补 `@bgm` 强制——开局漏 BGM 致整局静音的根治（fd42e2c）；
  台词尾缀旁白检测 `tail_narration`——仅监控计数不改写 + 协议正反例
  （7cf90ad）。
- 记忆代理独立模型参数 + 解析加固；recap 压缩细节化防重复（c945000）；
  种子第二人称视角约束 + 同场人数与笑点多样性护栏（18f41ff）；后台代理
  LLM 请求审计落盘——ContextLlmRecorder 端口（4a553fa）；记忆提取接入
  监控异步上下文面板（82895f0）。

**campus 内容与提示词**
- 剧情种子作者侧字段（context/concerns/boundaries/angles）折进 canon——
  模型可见玩家不可见；目录按新字段重构（a3c024d）。
- 表单默认 hybrid 带 `@=` 输入行——玩家随时可用自己的话行动；收束期
  表单同规（2b29784）。

**TTS 与资产**
- qwen3-tts 标点兼容适配 + 参考音更换（48013ff）；夏一鸣换真人参考音源，
  voice_revision 2 失效旧缓存（4dee57d）；qwentts 服务改绑 0.0.0.0 开放
  内网——供局域网内另一台虚拟主播取流（0959fcf）。
- 七首 Pixabay BGM 授权入册 + 资源注册（e8697c2）；背景描述补物理位置
  锚点（fbd24e4）；真实 yaml 冒烟去配置内容快照、树莓娘默认站位
  center→left（2429fef）。

**配置与文档**
- 真机运行档位固化——thinking enabled/high、语音 DSP 实测参数、播放缓冲
  与 TTS 并发 3（ef07db3）；本地 TTS 服务 OpenAI 协议接入指南（bf5986b）。

## 2026-09-19 玩家端音频设置菜单与回看（campus 分支）

**音频设置统一菜单**
- 控制条只保留 推进模式 / 设置 / 重开 / 状态：音量与静音不再平铺在栏上，
  收进「设置」浮层（语音音量 / BGM 音量 / 全部静音 / 字速 + 恢复默认），
  锚在栏正下方，打开期间控制条常显（`.controls--pinned`），Esc 关闭且
  打开期间独占键盘（面板滑杆与剧情按键互不干扰）。
- GameApp 单一 `volume` 拆为 `voiceVolume`/`bgmVolume` 双通道（语音→
  AudioCoordinator，BGM→BgmController，互不串扰）；玩家偏好（双音量/
  静音/字速）经 localStorage 持久化（`web/src/storage/player-settings.ts`，
  全路径 fail-open：损坏 JSON/隐私模式退默认），刷新/重开后自动恢复；
  BGM 控制器在构造期即应用持久化电平，首曲不会先响满音量。

**回看面板（历史浏览 + 语音回放）**
- 控制条新增「回看」（快捷键 `L`，Esc 关闭）：舞台内毛玻璃面板滚动展示
  本局全部已播行（旁白/角色/玩家台词），新行实时追加，`backlog-store.ts`
  按 line_id 去重、重连投影用 recentLines 播种、上限 400 条。
- 语音回放选型：**复用 IndexedDB 既有缓存**而非重新合成——播过的行其
  complete 资产本就逐块落在浏览器缓存（本会话资产受 activeCacheKeys
  保护不被逐出），回放零服务端开销、零合成延迟、与直播同一次采样；
  重合成需要新服务端 API 且本地引擎 RTF ~0.27 会挤占直播管线，仅在
  资产缺失（文本降级/跨局逐出）时该行降级纯文本，绝不触发重合成。
  `clip-player.ts`：整段 PCM → AudioBuffer → gain（随语音通道音量/静音），
  单飞行切换、stop 抑制 onended。
- 打开期间故事推进挂起：AudioCoordinator 新增 `setSuspended`——样本照常
  入队累积、armPlaybackStart 与空行 EOF 完结被门控（完结会引发自动推进）；
  关闭时从当前行剩余样本续播。重开新会话清空历史与回放。

## 2026-09-17 ~ 2026-09-18 本地 TTS、记忆代理与展位打磨

**本地语音合成（tts-server，provider `local`）**
- `local-qwen3-tts` provider：对接 `tts-server/` 本机推理（RTX 5060）；音色绑
  `voices.yaml` `providers.local.voice`（树莓娘 paimeng 克隆 + 四配角内置音色
  克隆，单模型五音色），固定 24 kHz 流式 PCM，句子级浪批处理、句间取消、
  abort 主动 `reader.cancel`（6d7c716、a58ec65）。
- 默认后端切 **qwentts.cpp**（C++/GGML）：OpenAI 兼容 `/v1/audio/speech` 流式
  方言；首包 ~530ms、四路吞吐 RTF ~0.09、显存 ~2.4G、无预热；Python 引擎经
  `LOCAL_TTS_DIALECT=tts-server` 保留作 fallback（72aed79）。
- `config.yaml` 默认 `synthesis.provider: local`；服务未启动时合成任务失败
  降级纯文本，不阻塞运行。

**会话记忆代理（event 模式）**（f0069fc）
- `memory-agent`：从增量提交事件投影人物 emotion/goal/relationship、canon
  事实（≤12 键）、线程推进，merge-only 写入 StoryState；单飞 + 水位随快照
  持久化，失败只跳过本批不杀 run loop；种子 purpose 首个交互后转中性锚点。

**DSL 协议硬化**
- 全 `@` 前缀命令语法 + 分层修复 + 结构化错误（ee1e1ea、e92836f、97798db、
  82f0ac6、262b383）；确定性补哨兵：finish_reason=stop 单理由任务本地合成
  `@end`（24a1442）、固定尾任务改字面固定尾（22fe8ce）；`@ending` 结局元数据
  指令（4e8e84a）；旁白自标注标签确定性剥离（c54501b）；全角冒号规范化按
  注册说话人门控（b8be38e）；09-17 六路审计修复（1279333、2da9f37、b6a9439）。

**运行时与生成质量**
- 修复续写动态预算 + 失败段丢弃重试 + sliceId 监控原位替换（b2010be）；
  fail-fast 修复续写（6365683）；RuntimeBeatEvent 进播放队列——beat cue 在
  播放位生效（c8cb600）；写手思考链 thinking 接入 + 请求/结果遥测（28d7a85）；
  recap 滚动前情梗概管线 + 长回合护栏收紧（0fca9f7）；舞台状态注入保真化 +
  REDUNDANT_STAGE_CUE 兜底（3414a39）；隐形说话自动显形兜底 + stageWarnings
  注入（9253fe6）。
- 提示词：campus 提示词与种子去 AI 味改写（96a2f61）；四配角定名许晚晴/
  林小满/夏一鸣/韩澈（c32d2d2）。

**监控与可观测**
- 连续编剧流监控面板 + `/monitor` 只读通道（0b907ac、605a853）；编剧输入
  提示词审计 tab（2b082ce）；写手 DSL 流输入输出全量落盘 + `/monitor/records`
  只读路由（c424076、c9699d3）；面板布局重构——列/行分割器 + 日志页几何
  跟随渲染（ee94050）。

**资产与前端**
- 立绘 presentation 推导 + 16:9 letterbox 舞台（933cf41、a3da111）；群像
  立绘重绘对齐树莓娘头身比 + ground 地面线（86aa5d9、51fdf1b）；realcugan
  2x 立绘/背景 + 北食堂/操场昼夜重渲染注册（b265e66、20a5d21）；自托管
  webfonts（e8765f5）；表单期舞台遮罩 + 玩家端样式打磨（3b844c8）；标题入场
  去 filter 动画修永糊（72d7927）；输入预览 Esc 取消修复（c079ec9）；
  ErrorBanner 移除——生成痕迹不上玩家端（03a203e）；BGM 裁切窗口循环 +
  淡入淡出（f876e2d）。
- 构建：npm → pnpm 迁移（a41906e）。

## 2026-09-16 存档统计与管理（session archive）

补齐跨会话持久化视角（此前只有单会话读写与 load/resume，无任何列表/统计/
删除能力；`sessions/` 根下还堆着 pre-P1-7 布局的数百个遗留扁平日志）：

1. **session-archive 模块**（`src/adapters/storage/session-archive.ts`）：
   扫描 `sessions/<id>/` 产出每存档摘要（事件按 source/type 分桶、交互与
   回合计数、首末时间戳、state.json 的 phase/ending、叙事记忆在位、字节数）
   与全库汇总（进行中/已结束/无快照、结局分布、遗留扁平文件盘点）。
   容错读取：坏行计数不致命；删除是唯一写操作，sessionId 严格白名单校验
   （防路径逃逸）+ 目录判定。
2. **CLI**：`--saves` 列表+汇总、`--delete-save <id>` 定向删除（均只需
   config，不引导运行时）；Web 宿主新增只读 `GET /api/saves`（删除不开放
   HTTP 面）。

测试：`session-archive.test.ts` 11 例（布局扫描、容错、遗留盘点、聚合、
id 校验、删除安全）+ 宿主 `/api/saves` 用例；全套 1468 通过。

## 2026-09-14 event 模式分级收束与记忆/上下文管理优化

依据 2026-09-08 展位现场 session（150 事件 / 5.5 分钟 / 6 次交互，全程无
`@end ending`，人工杀进程收场）诊断"模型停不下来"，四层修复：

1. **修复 `{nonce}` 替换 bug**：`endingRequired` 指令在 `fill()` 之后以字面量
   `{nonce}` 下发、`FORCED_ENDING_REPAIR_REASON` 同病——模型回显 `@end {nonce}`
   哨兵校验必然失败。现在生成器侧用请求真实 nonce 注入；修复原因改为指向
   "任务提示中给定的 nonce"。
2. **分级收束（尽量避免运行时硬上限）**：`narrative.event` 三级阈值
   `wrapup_interactions`（L1 软提示，默认 6）/ `closing_push_interactions`
   （L2 强提示 + 停止分支预取，默认 8）/ `max_interactions`（L3 运行时保险丝，
   默认 10，启用 0/正值语义不变）；L1 同时把 open_threads 的种子线程投影为
   ready。交互进度 `本局交互进度：N / 收束目标 M` 注入任务头。
3. **失控护栏**：`generation.max_consecutive_repairs`（默认 2）——修复链耗尽
   后续写转 L2 强收束提示，L2 下仍耗尽才启用 L3（保持"不杀 run loop"原则）；
   `narrative.event.max_events_between_interactions`（默认 24）——自上次交互的
   模型文本事件超限后续写附"尽快交互"提示（防单回合连写数分钟）。
4. **记忆/上下文（缓存友好）**：`serializeStoryContext` 输出 `[交互] <题干>`
   （截断 80 字），滑窗滑过后模型仍看得到自己问过什么；user prompt 段落重排为
   "静态素材 → 追加式历史 → 易变任务块"以提升 provider 前缀缓存命中；Game
   历史窗口有界且按 20 条对齐滑动（超 80 事件后前缀仍稳定）；restore 从
   events.jsonl 重建交互计数与收束级别；快照 nextTurn 改从事件流推导。

测试：`src/game-ending-pressure.test.ts` 7 例（L1/L2 提示与线程投影、L2 停
预取、L3 强制重试/合成结局、修复原因回归、护栏提示、修复链升级、restore
重建）；choice 无分支预取组时降级为空 preview 直接续写（原为内部错误）。

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

## 2026-09-08 校园值班开放叙事分支（feat/campus-ops-raspberry）

- `core:` `GamePorts.initialStoryState`：组合根可为全新会话预置初始故事
  状态（场景/事实/线程）；恢复会话以持久化快照为准，无快照恢复路径改为
  在预置状态上重放事件补丁。
- `campus:` 叙事种子目录 `prompts/campus-ops.yaml`（12 条种子，strict
  schema 禁止流程化字段）+ `src/campus/scenario-seeds.ts`（加载、sessionId
  确定性选种、种子→初始状态）；event 模式下由组合根接线注入。
- `campus:` 树莓娘人设分层（已核对事实/本项目演绎）、校园世界规则与
  事实边界提示词；`config.yaml` 切换 `narrative.mode: event`、
  `synthesis.provider: disabled`；资源目录裁剪为校园场景 + 自制占位立绘。
- 测试：种子目录/选择/状态构造、bootstrap 种子接线、校园会话集成
  （短局/多轮/自由输入/同种子不同路径）、真实提示词与资源目录断言。

## 2026-09-08 修复：低水位 refill 与修复路径竞争导致 run loop 失序死亡

现场实测（选择分支→预览播放期间后继续写段截断失败）暴露 §75 低水位
refill 与 §8.5 修复路径的竞争，命中"播放缓冲顺序与生成事件流不一致"
直接杀死 run loop（现场表现即无法推进/卡死）：

- 失序机制：后继续写段提前失败使调度槽空闲 → 预览播放中的 advance
  触发低水位 refill 入缓冲 → run loop 进入失败路径 `playbackBuffer.clear()`
  抹掉 refill 未播事件后，buffer 分支仍无条件采纳 `pendingRefillSegment`
  → 消费死队列与重置后的缓冲失序 → `advanceBufferedEvent` 抛错。
- `game.ts` 新增 `reclaimPendingRefill()`：回收未被接管的 refill（取消
  生成→等槽释放→`PlaybackBuffer.removeLineIds` 摘除其未播事件→清空
  `pendingRefillSegment`），修复路径与选择后/回应后续写路径启动新段前
  必须调用；期间 `reclaimingRefill` 抑制 done 钩子再孵化 refill。
- 直播流（已选分支/输入回应）消费期间 `suppressRefill` 抑制低水位
  refill（回应 lane 不占用调度槽，原本无守卫）。
- `advanceBufferedEvent` 降级为最后防线：失序/缺行告警并重同步继续
  播放，不再抛错杀 run（现场演示优先连续性）。
- `audio-descriptor-factory`：`characters: {}` 的文本优先部署下，
  no-character 不再逐行刷 build-skip 告警（角色表非空时仍告警）。
- 测试：`game-dsl.test.ts` 新增 mid-preview refill 回收回归（无修复时
  过期 refill 孤儿行泄漏进播放，修复后播放序列精确）。

## 2026-09-14 展位 UI：重开闭环与会话可观测（Task 6）

现场验收（代码审计）发现 runbook 承诺与 UI 行为不符：结束页"重新开始"实际是
页面刷新，重连后仍显示同一个已结束会话（宿主 gameStarted 守卫阻止二次运行）；
运行时 `restart_session` 链路完整但 web UI 从未发送。以最小改动闭合缺口：

- `runtime-websocket`：`restart_session` 命令改由宿主统一处理（活循环在下一
  命令边界优雅退出、已结束/已崩溃则 dispatch 为无害 no-op 后直接重建）；
  `rebase()` 对现有 controller 连接改挂新 game 并推送新会话投影快照
  （此前只影响新连接，现有浏览器永远看不到新会话）。
- `LocalWebHost.handleRestart`：保留运行循环 promise，重启前先 dispatch 命令并
  await 旧循环退出（生成等待中最迟当前段超时生效）；`restarting` 防重入。
- `RuntimeApplication.restart`：显式 `projection.reset(newSessionId)`——
  `session_started` 在 `run()` 内才发射，晚于 ws rebase 推快照；
  `UiProjectionStore` 增 `reset()`，`session_started` 检测会话 id 变化时
  防御性重置（旧会话台词/结局/舞台不再泄漏进新会话快照）。
- web UI：结束页重开与控制条"重开"（带确认）发送 `restart_session`；按钮在
  重建期间 pending（新会话快照到达或 8s 失效保护复位）；会话切换时舞台清空、
  表单草稿丢弃；会话 ID 在控制条角标（点击复制）/结束页/报错横幅三处可见；
  等待界面显示运行阶段文案（区分"生成中"与"卡死"）。
- 测试：投影 reset 与会话 id 变化防御、ws 重启路由 + rebase 重挂推送、宿主
  重启全链路 + 防重入、bootstrap 重启后投影干净、view-model 快照清理 stale
  错误、结束页/控件重开交互、舞台 clear。
