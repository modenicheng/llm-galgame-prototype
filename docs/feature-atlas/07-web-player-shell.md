# 玩家前端域（应用壳·舞台·UI·运行时对接）

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：23 个生产 .ts 文件 / 4,077 行（不含测试），另有宿主/配置文件 4 个（web/index.html 27 行、web/music-demo.html 71 行、web/vite-env.d.ts 11 行、vite.config.ts 34 行）与数据资产 web/public/fonts（195 个 woff2 子集，约 56 MB）、web/src/ui/styles.css（1,522 行，清单外补充说明）。
> 快照来源：D:/coding/lgp-main-atlas（只读）。行号均为该快照实际 Read/Grep 所得。

## 1. 域职责与边界

本域是浏览器端的整个玩家应用：**装配（main.ts）→ 会话组合根（app.ts GameApp）→ 纯投影（runtime/game-view-model.ts）→ 连接层（runtime/runtime-client.ts）→ 舞台渲染（stage/）→ 界面组件（ui/）**。不含 audio/（PCM 播放协调、下载、解码、生成式配乐渲染）与 storage/（IndexedDB 缓存、玩家偏好持久化），这两个域由本域在 GameApp/main.ts 的接缝处调用（见 §5）。

**应用启动顺序**（从页面加载到可玩）：

1. `web/index.html` 引入 `/fonts/fonts.css`（render-blocking，防 CJK 回退栈先绘）与 `/src/main.ts`；`main.ts:372-374` 检测 `#app` 存在即自启 `boot()`。
2. `boot()`（main.ts:59）：`buildAppDom` 注入静态 DOM 骨架 → `fetchAssetManifest()` GET `/api/assets/manifest` → 构造 `BrowserAssetResolver`/`StageRenderer`/`BgmController`/`SoundEffectController`/`GeneratedBgm` → `loadPlayerSettings()`（storage 域接缝）→ 构造 `GameApp` → 挂全部 UI 组件（StartScreen/DialogueBox/InteractionPanel/PreviewPanel/ControlsBar/SettingsMenu/EndScreen/ErrorBanner/GraphPanel）→ 注册键盘路由 → `mountWorldCreateForm()`（M3.3 直通开玩表单）→ `app.subscribe(render)` 并 `render(app.state())` 首帧。
3. 玩家点击「开始游戏」（StartScreen，§10.5 唯一用户手势）：`createAudioContext()` + `context.resume()` → `bgmController.unlock()` → `GameApp.start(context)`。
4. `GameApp.start()`（app.ts:171-260）：`loadConfig()`（GET /api/config，失败回退默认）→ 构造 `AudioCoordinator`（audio 域）→ `coordinator.init()`（AudioWorklet 可选：能力缺失降级文字模式，addModule 抛错则直接失败上抛）→ `db.open()` → 构造 writer/reader/cleaner/downloader（storage+audio 域）→ 构造 `RuntimeClient` 并 `connect()`（发 `client.ready`）→ 启动 cleaner 循环。任一步抛错则拆除半成品并重置 `started` 门（P2 防楔死）。

**WebSocket 消息到 UI 的链路**：`RuntimeClient.handleMessage`（JSON.parse → `ServerMessageSchema.safeParse` 校验 → `runtime.output` 按 `sequence` 单调去重 / `projection.snapshot` 重置水位）→ `GameApp.onServerMessage` 分流（audio.* 四类走音频生命周期；`music.score` 转 GeneratedBgm；其余交 `GameViewModel.applyServerMessage`）→ view-model `applyOutput`/`applyProjection` 更新状态并 `notify()` → `GameApp.handleViewNotify`（换行触发音频管线）→ `emitState()` → main.ts 的 `render(state)` 路由各面板显隐与内容 → `StageRenderer.apply`/`BgmController.apply`/`SoundEffectController.consume(app.consumeCues())` 更新舞台。

**与 audio/storage 域的接缝**（本域只调用、不拥有）：
- audio：`AudioCoordinator`（init/feedPcm/enqueueLine/start/stop/dropLine/notifyLineEof/bufferedAheadMs/isPlaying/setMode/setVolume/setMuted/available）、`AudioDownloader`（POST /api/audio/synthesize）、`PcmDecoder`、`GeneratedBgm.handleScore`、`SoundfontMusicRenderer`（music-demo 与 GeneratedBgm 装配）、`MusicScoreMessage` 类型。
- storage：`AudioDb`/`AudioCacheWriter`/`AudioCacheReader`/`AudioCacheCleaner`（TTS 缓存）、`loadPlayerSettings`/`savePlayerSettings`/`PlayerSettings`/`DEFAULT_PLAYER_SETTINGS`（localStorage 偏好）。

**DOM 直操范围**：main.ts（graphBtn/graphOverlay append、world-create 表单 innerHTML、document.body classList、window keydown）；layout.ts（整个静态骨架）；各 ui 组件（各自 root 内）；stage/（stage 容器内 bg/chars 层）；view-model 与 runtime-client 明确零 DOM。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| web/src/app.ts | 890 | GameApp 会话组合根：消息路由、TTS 获取生命周期、低水位补齐、状态外发 | 4（GameApp、GameAppOptions、GameAppState、interactionIdOf） | app.test.ts (913) |
| web/src/main.ts | 434 | 浏览器引导：DOM 装配、组件接线、render 路由、键盘路由、世界创建表单 | 1（boot） | main.test.ts (504) |
| web/src/runtime/game-view-model.ts | 316 | ServerMessage → UI 状态的纯投影（GameViewModel） | 6（FrontendMode、RuntimePlayableEventWire、ViewModelState、interactionModeToFrontendMode、MAX_RECENT_LINES、GameViewModel） | game-view-model.test.ts (697) |
| web/src/runtime/runtime-client.ts | 257 | Runtime WebSocket 连接层：校验/去重/重连退避/client.ready | 6（RuntimeCommandWire、ConnectionState、WebSocketLike、WebSocketCtor、RuntimeClientOptions、RuntimeClient） | runtime-client.test.ts (259) |
| web/src/stage/bgm-controller.ts | 316 | BGM 单 `<audio>` 封装：裁切循环、淡入淡出、生成曲直达 | 2（BgmClock、BgmController） | bgm-controller.test.ts (310) |
| web/src/stage/stage-renderer.ts | 162 | keyed 舞台渲染（背景/立绘/占位回退） | 2（deterministicHue、StageRenderer） | stage-renderer.test.ts (119) |
| web/src/stage/stage-types.ts | 56 | core 舞台/资产/cue 形状的 wire 镜像（纯类型） | 6（全为类型：StagePosition、StageCharacterState、StageVisualState、BgmPlayback、PublicAssetManifest、StageCueWire） | —（被各 stage 测试间接覆盖） |
| web/src/stage/asset-manifest-client.ts | 12 | GET /api/assets/manifest（失败回 null） | 1（fetchAssetManifest） | asset-manifest-client.test.ts (18) |
| web/src/stage/browser-asset-resolver.ts | 26 | 逻辑 id → 受控 URL 纯映射 | 1（BrowserAssetResolver） | browser-asset-resolver.test.ts (31) |
| web/src/stage/sound-effect-controller.ts | 21 | 消费 sound_effect cue：一次性 Audio 播放 | 1（SoundEffectController） | sound-effect-controller.test.ts (38) |
| web/src/ui/graph-panel.ts | 199 | 剧情图浮层（D8 分组、决策子图、回溯确认） | 2（GraphPanelView、GraphPanel） | graph-panel.test.ts (109) |
| web/src/ui/settings-menu.ts | 213 | 设置浮层（语音/BGM 音量、静音、字速、恢复默认） | 4（SettingsMenuHooks、SettingsMenuInitial、SettingsMenuOptions、SettingsMenu） | settings-menu.test.ts (130) |
| web/src/ui/interaction-panel.ts | 185 | 统一 choice/hybrid/input 表单 + 一次性提交锁 + 草稿恢复 | 2（InteractionPanelHooks、InteractionPanel） | interaction-panel.test.ts (269) + main.test.ts |
| web/src/ui/layout.ts | 179 | 静态 DOM 骨架构建（AppDomRefs） | 2（AppDomRefs、buildAppDom） | main.test.ts 间接 |
| web/src/ui/dialogue-box.ts | 142 | 对白框：打字机、名牌、line-id chip、字体门控 | 2（DialogueBoxHooks、DialogueBox） | main.test.ts 间接 |
| web/src/ui/controls.ts | 131 | 右上控制条：模式切换、设置入口、连接/播放状态 | 2（ControlsHooks、ControlsBar） | main.test.ts 间接 |
| web/src/ui/typewriter.ts | 97 | 逐字显示时序（无 DOM，标点加拍） | 2（TypewriterHooks、Typewriter） | typewriter.test.ts (89) |
| web/src/ui/input-panel.ts | 77 | PreviewPanel（INPUT_PREVIEW 确认页）+ asInputInteraction | 4（InputInteractionLike、asInputInteraction、PreviewPanelHooks、PreviewPanel） | main.test.ts + interaction-panel.test.ts |
| web/src/ui/end-screen.ts | 71 | EndScreen 结尾页 + ErrorBanner 错误条 + asEnding | 5（EndScreenHooks、EndingLike、asEnding、EndScreen、ErrorBanner） | main.test.ts 间接 |
| web/src/ui/choices.ts | 66 | 选项列表渲染 + asChoiceInteraction | 4（ChoiceOptionLike、ChoiceInteractionLike、asChoiceInteraction、renderChoiceOptions） | interaction-panel.test.ts 间接 |
| web/src/ui/start-screen.ts | 57 | 开始页（autoplay 解锁手势门） | 2（StartScreenHooks、StartScreen） | main.test.ts |
| web/src/ui/dom.ts | 38 | DOM 小工具（el/show/setText/clearChildren/asRecord） | 5 | 各 ui 测试间接 |
| web/src/music-demo.ts | 132 | /music-demo.html 入口：配乐试听工具（无导出，模块即脚本） | 0 | —（渲染器本体在 audio/music-renderer.test.ts） |
| web/index.html | 27 | 主页面宿主（fonts.css + #app + main.ts） | — | — |
| web/music-demo.html | 71 | 试听页宿主（内联样式） | — | — |
| vite.config.ts（仓库根） | 34 | Vite 构建：root=web、双入口、@shared 别名、middlewareMode | — | — |
| web/vite-env.d.ts | 11 | vite/client 环境类型引用 | — | — |
| web/public/fonts（目录） | — | 数据资产：Noto Serif SC + Ma Shan Zheng unicode-range 子集（195 woff2）、OFL 许可、fonts.css | — | — |
| web/src/ui/styles.css（清单外补充） | 1,522 | 设计系统样式（任务清单未列，属 ui/ 生产资产） | — | — |

## 3. 函数级明细

### web/src/app.ts

#### `GameAppOptions(接口: wsUrl, token, config?, bgmController?, initialSettings?, music?, fetchImpl?, webSocketImpl?, db?)` — `web/src/app.ts:47-63`
用途：GameApp 构造参数；`fetchImpl/webSocketImpl/db` 为测试缝。
调用方：main.ts:82-88（生产，传 wsUrl/token/bgmController/music/initialSettings）；app.test.ts。
依赖：PublicWebConfig、BgmController、PlayerSettings、MusicScoreMessage、AudioDb、WebSocketCtor 类型。
备注：`config` 预载选项生产未用（main.ts 不传，start 内 fetch）。

#### `GameAppState(接口: view, connection, playbackMode, voiceVolume, bgmVolume, muted, textSpeed, audioPlaying, bufferedAheadMs, underrunCount, configSource, showLineIds, startError)` — `web/src/app.ts:65-82`
用途：UI 单一状态快照（render 路由的唯一输入）。`startError` 承载 P2 启动失败楔死修复。
调用方：`GameApp.state()`/`emitState()` 产出；main.ts `app.subscribe` 消费。

#### `GameApp(类)` — `web/src/app.ts:107-876`
用途：浏览器会话组合根——持有投影、连接、播放策略、缓存与下载管线，绝不触碰 Game 内部、绝不直调 LLM/TTS（浏览器仅可提交 {taskId, lineId, cacheKey} + token，§22 不变式 2/3/9）。

**`constructor(options)` — `web/src/app.ts:146-160`**：初始化 db/bgmController/音量字速（clamp）、构造前先给 bgmController 推恢复的音量/静音、订阅 viewModel 通知。

**`start(context: AudioContext): Promise<void>` — `web/src/app.ts:171-260`**（启动编排，步骤）：
1. `started` 门防重入；`loadConfig()` 拉取配置，失败回退 `DEFAULT_PUBLIC_WEB_CONFIG`（configSource 保持 "defaults"）。
2. 构造 `AudioCoordinator`（context + playbackConfig + format + coordinatorEvents）。
3. `coordinator.init()`：addModule 抛错 → stop/置 null/startError/emitState/上抛（不静默降级）；能力缺失（available=false）→ 置 null 降级文字模式。
4. 向 coordinator 推恢复的音量/静音（init 只建节点，不知偏好）。
5. `db.open()` → 按 config 构造 `AudioCacheWriter`（批量写参数）`AudioCacheReader` `AudioCacheCleaner`（CLEANER_DEFAULTS）。
6. 构造 `AudioDownloader`（token/writer/decoder 工厂/onPcm→`this.onPcm`/onEof→`coordinator.notifyLineEof`，可选 fetchImpl）。
7. 构造 `RuntimeClient`（onServerMessage→`this.onServerMessage`，onConnectionChange：记状态、open 时 `startBufferReports()`、emitState）并 `void client.connect()`。
8. `void runCleaner()` 启动清理循环；清 startError、emitState。
9. catch 分支：任何 init 步骤抛错 → 重置 `started=false`、关 client、停 coordinator、记 startError、emitState、上抛（重试全部重建）。

**`stop(): void` — `web/src/app.ts:263-275`**：关 WS、停 buffer 报告/reading/pause/cleaner 定时器、停 coordinator；缓存保留在磁盘。
**`subscribe(listener): () => void` — `web/src/app.ts:277-282`**：状态订阅。
**`state(): GameAppState` — `web/src/app.ts:284-300`**：组装快照（bufferedAheadMs 取整自 coordinator）。
**`consumeCues(): StageCueWire[]` — `web/src/app.ts:306-308`**：转发 viewModel 的瞬态 cue 取走（UI 渲染层消费 visualState 时调用一次）。
**`advance(): void` — `web/src/app.ts:315-320`**：取消 reading/pause 定时器、coordinator.stop()、发 advance 命令。
**`selectChoice(optionId): void` — `web/src/app.ts:322-327`**：从 currentInteraction 取 interaction_id（`interactionIdOf`），发 select_choice。
**`submitInput(text): void` — `web/src/app.ts:329-336`**：trim 非空才发 preview_input。
**`confirmPreview(): void` — `web/src/app.ts:338-342`**：有 preview 才发 confirm_input。
**`cancelPreview(): void` — `web/src/app.ts:344-348`**：有 preview 才发 cancel_input。
**`setMode(mode): void` — `web/src/app.ts:350-358`**：manual 时取消两定时器；透传 coordinator.setMode。
**`setVoiceVolume(v)/setBgmVolume(v): void` — `web/src/app.ts:360-370`**：clampUnit 后分别推 coordinator / bgmController。
**`setMuted(muted): void` — `web/src/app.ts:372-377`**：同时推 coordinator 与 bgmController。
**`setTextSpeed(charsPerSec): void` — `web/src/app.ts:379-382`**：clampSpeed（5..120 取整）。
**`hasConnection(): boolean` — `web/src/app.ts:794-796`**：client 是否存在（结尾页选 restart_session 或 reload 兜底）。
**`retrace(decisionId): void` — `web/src/app.ts:799-801`**：M5.3 回溯——发 retrace 命令（服务器弃局记账开新周目）。
**`restartSession(): void` — `web/src/app.ts:809-811`**：发 restart_session（不刷新路径：服务端 rebuild 后经投影回开场）。

私有方法（关键复杂函数给步骤）：

**`onServerMessage(msg: ServerMessage): void` — `web/src/app.ts:388-412`**：分流 audio.descriptor→`onDescriptor`、audio.priority_changed→`onPriorityChanged`、audio.invalidated→`onInvalidated`、audio.task_status→`onTaskStatus`（best-effort catch）、music.score→`options.music.handleScore`（fire-and-forget）、默认→`viewModel.applyServerMessage`（projection.snapshot + runtime.output）。
**`handleViewNotify(): void` — `web/src/app.ts:414-429`**：PLAYING 且行 id 变化→`onCurrentLine`；非 PLAYING（决策/等待/结尾）→取消 reading 定时器并在播放中时 stop；最后 emitState。
**`onCurrentLine(lineId, line)` — `web/src/app.ts:435-444`**：记 currentLineId → 取消 reading 定时器 → coordinator.stop()（行中 advance 立即停声）→ `ensureEnqueued` → `coordinator.start` → `ensureAudio` → `scheduleReadingFallback` → `reconcileAudio`。
**`onDescriptor(descriptor)` — `web/src/app.ts:446-469`**：登记/更新 DescriptorEntry（保留最新 priority）→ `ensureEnqueued` → 若是当前行则 coordinator.start 并取消 reading 回退 → `ensureAudio` → `reconcileAudio`。
**`onPriorityChanged(lineId, priority)` — `web/src/app.ts:471-480`**：改 entry.priority；当前行则 ensureEnqueued+start；`reconcileAudio`。
**`onInvalidated(lineId)` — `web/src/app.ts:482-495`**：下载中则 abort（downloader catch 会把缓存标 partial）→ coordinator.dropLine（§12.5 死音频不得滞留时间线）→ 删 descriptors/enqueued/cacheDecoders → reconcileAudio。
**`onTaskStatus(taskId, lineId, status, error?)` — `web/src/app.ts:497-546`**：finished→writer.finishComplete（仅记账；PCM 已由 downloader 实时喂入，不重读缓存防二次播放 §12.4/§12.2）并置 entry cached/fed；failed→markFailed+abort+置 failed；canceled→markPartial+abort+置 failed；started→无操作；末尾 scheduleReadingFallback+reconcileAudio+emitState。
**`onPcm(lineId, samples)` — `web/src/app.ts:548-551`**：coordinator.feedPcm + reconcileAudio（downloader 的 onPcm 回调）。
**`ensureEnqueued(lineId)` — `web/src/app.ts:553-561`**：非 active scope 且非当前行的候选不入队；入队后记 enqueued 集合。
**`ensureAudio(lineId): void` — `web/src/app.ts:564-622`**（§2 循环/§12.2）：1) entry 非 idle 或管线未就绪则返回；2) coordinator 为 null（文字降级）返回；3) 候选分支仅 candidate_first_line 首行可预合成，深层候选等提升；4) 非当前行且 bufferedAheadMs≥target_buffer_ms 时抑制预取（§10.3 前瞻余量，P3）；5) state=checking → reader.lookup → 命中：cached+sendCacheReport(hit)+feedFromCache；未命中：report(partial/miss)+startDownload；6) 期间失效的陈旧 lookup 直接丢弃（P3 竞态）；catch 非致命回 idle。
**`startDownload(entry): Promise<void>` — `web/src/app.ts:624-647`**：置 downloading、`crypto.randomUUID()` 生成 taskId（P3：POST 体与记账共用一个 id）、AbortController → downloader.download；catch 时若 task_status 未落定则按 aborted 标 partial / 否则 markFailed，置 failed。
**`feedFromCache(entry): Promise<void>` — `web/src/app.ts:650-669`**：跨页缓存命中喂数——已 fed/未入队（候选持有）跳过；按 cacheKey 复用 PcmDecoder 逐 chunk feedPcm，flush 尾块，notifyLineEof，置 fed。
**`reconcileAudio(): void` — `web/src/app.ts:671-689`**：当前行恒 ensureAudio；bufferedAheadMs≤low_watermark_ms 时按 `fetchPriorityOrder` 顺序对 idle/checking 的未来行 ensureAudio。
**`fetchPriorityOrder(): string[]` — `web/src/app.ts:692-699`**：按 PRIORITY_RANK（current<next<active_future<candidate_first_line<background）排序返回 lineId。
**`scheduleReadingFallback(): void` — `web/src/app.ts:702-728`**（§9.3）：auto 模式且音频不在途（checking/downloading/cached未fed）时，按 `text.length/READING_CHARS_PER_SEC(5)` 估读时（钳 1500..15000ms）设 readingTimer；到点仍同line/auto/未在播则 advance。
**`cancelReadingTimer()/cancelPauseTimer()` — `web/src/app.ts:730-735 / 778-783`**：清定时器。
**`coordinatorEvents` — `web/src/app.ts:737-776`**：onLinePlaybackStarted→audioPlaying=true+取消 reading；onLinePlaybackFinished→auto 且是当前行时按 `performance.pause_after_ms`（PauseInfo）设 pauseTimer 再 advance（手动点击在暂停窗内可取消，防跳行 P2），否则直接 advance；onUnderrun→underrunCount+1。
**`sendCommand(command)` — `web/src/app.ts:789-791`**：`client.sendCommand(crypto.randomUUID(), command)`。
**`sendCacheReport(lineId, cacheKey, result)` — `web/src/app.ts:813-815`**：发 audio.cache_report。
**`startBufferReports()/stopBufferReports()` — `web/src/app.ts:817-833`**：连接 open 后每 2000ms 发 audio.buffer_report（bufferedAheadMs+underrunCount）。
**`runCleaner(): Promise<void>` — `web/src/app.ts:835-841`**：cleaner.run(activeCacheKeys())，每 10 分钟循环（started 期间）。
**`activeCacheKeys(): Set<string>` — `web/src/app.ts:843-849`**：当前 descriptors 的 cacheKey 集合（cleaner 白名单）。
**`loadConfig(): Promise<PublicWebConfig>` — `web/src/app.ts:855-868`**：fetchImpl GET /api/config；非 2xx 或缺 audio.playback.low_watermark_ms 抛错；成功置 configSource="server"。
**`emitState()` — `web/src/app.ts:870-875`**：向 listeners 广播 state() 快照。

调用方（跨文件）：main.ts（构造 + start/advance/selectChoice/submitInput/confirmPreview/cancelPreview/setMode/setVoiceVolume/setBgmVolume/setMuted/setTextSpeed/hasConnection/restartSession/retrace/consumeCues/subscribe/state）；app.test.ts。
依赖：GameViewModel、RuntimeClient、AudioCoordinator/AudioDownloader/PcmDecoder/GeneratedBgm(经 options.music)（audio 域）、AudioDb/AudioCacheWriter/AudioCacheReader/AudioCacheCleaner/PlayerSettings（storage 域）、@shared/wire（audio-descriptor/public-web-config/server-message）、stage/bgm-controller、stage/stage-types。
备注：状态归属——voice/bgm 音量、muted、textSpeed、playbackMode、connection、startError 属 GameApp；view.* 属 GameViewModel；浏览器不复制 Game 状态机。

#### `interactionIdOf(value: unknown): string | null` — `web/src/app.ts:878-882`
用途：从 unknown 交互对象收窄 interaction_id（>0 长度字符串）。
调用方：app.ts selectChoice/submitInput；main.ts render 路由（草稿键）；app.test.ts、main.test.ts。
依赖：无（纯函数）。

内部辅助（非导出）：`CLEANER_DEFAULTS`（§17.5 清理默认值，L35-40）、`BUFFER_REPORT_INTERVAL_MS=2000`（L42）、`CLEANER_INTERVAL_MS=10min`（L43）、`READING_CHARS_PER_SEC=5`（L45）、`DescriptorEntry`（行音频获取状态机：idle/checking/downloading/cached/failed+fed/taskId/abort，L84-92）、`PauseInfo`（LinePerformance 的浏览器可见切片 pause_after_ms，L95-97）、`PRIORITY_RANK`（优先级排序表，L99-105）、`clampUnit`（0..1 钳制，L884-886）、`clampSpeed`（5..120 取整，L888-890）。

### web/src/main.ts

#### `boot(root?: HTMLElement | null): Promise<void>` — `web/src/main.ts:59-370`
用途：浏览器引导/装配根（导出供测试）。
关键步骤：
1. body 加 `.gal-player`（CSS 禁选择/拖拽）+ 根节点 dragstart preventDefault（Firefox 兜底）。
2. `buildAppDom(appRoot)` 建骨架；`fetchAssetManifest()` → `BrowserAssetResolver` → `StageRenderer`/`BgmController`/`SoundEffectController`/`GeneratedBgm(bgmController, SoundfontMusicRenderer)`。
3. `tokenFromUrl()` 取 token；`loadPlayerSettings()` 恢复偏好；构造 `GameApp`（wsUrl/token/bgmController/music/initialSettings）。
4. StartScreen.onStart 回调（唯一手势内）：createAudioContext→resume→bgmController.unlock→app.start(context)；失败则 ErrorBanner 显示并可重试；成功置 started=true 并 hide。
5. token 为空时 StartScreen.setWarning。
6. `mountWorldCreateForm(appRoot)`（M3.3 无世界时挂创建表单）。
7. 构造 DialogueBox/InteractionPanel/PreviewPanel/ControlsBar/SettingsMenu（四个偏好 hook：改 playerSettings→app.setXxx→persistSettings）+EndScreen（onRestart：有连接走 restartSession 否则 reload）/ErrorBanner。
8. GraphPanel 装配：graphBtn 点击→可见则 hide，否则 `graphPanel.refresh(fetch /api/graph)`；graphOverlay append 到 appRoot、graphBtn append 到 controlsRoot。
9. window keydown 路由：IME 组合跳过；设置菜单打开时 Esc 关菜单且独占；Esc 在 INPUT_PREVIEW 时 cancelPreview（先于按钮目标守卫）；button 目标自处理；Enter/Space 在 PLAYING 时 pressAdvance，INPUT_PREVIEW+Enter 时 confirmPreview。
10. render 闭包状态（started/lastMode/lastProjectionSeq/lastPreviewText/draftByInteractionId/lastInteractionId/lastVisualState/lastBgmId）；`app.subscribe`→render；首帧 `render(app.state())`。
调用方：main.ts:372-374 自启；main.test.ts 显式调用。
依赖：域内几乎全部模块；storage/player-settings、audio/generated-bgm、audio/music-renderer（跨域接缝）。

render 闭包要点（`render(state: GameAppState)` — `web/src/main.ts:262-361`）：controls.setConnection/setAudio；按 mode 显隐 start/end/banner/controls/dialogue/preview/waiting；selecting 模式（CHOICE/HYBRID/INPUT_EDITING）或 INPUT_PREVIEW 时压暗 interactionVeil；mode 变化或 projectionSeq 变化（重连投影）时开/关 InteractionPanel（新 interaction 清旧草稿；重连投影强制重开以重置一次性提交锁 §10.3；preview 取消恢复草稿 §11.7）；PLAYING→dialogueBox.setLine；INPUT_PREVIEW→存草稿+previewPanel.show；ENDING→endScreen.show（失败报「结局数据缺失」）；ERROR→errorBanner.show；visualState 引用变化→stageRenderer.apply + bgm 值变化时才 bgmController.apply（携带旧值不重放，生成曲得以存活）+ seController.consume(app.consumeCues())。

内部辅助：`tokenFromUrl()`（URLSearchParams 取 token，L39-41）、`wsUrlFromLocation()`（https→wss 拼 /ws/runtime，L43-46）、`createAudioContext()`（webkit 回退，不支持则抛「当前浏览器不支持 Web Audio」，L49-57）、`mountWorldCreateForm(appRoot)`（GET /api/config 判 has_world===false 时 innerHTML 注入创建表单；异常按已有世界处理，L381-405）、`submitWorldCreation(text, button, error)`（POST /api/worlds {text}→成功 reload，L407-434）、自启守卫（L372-374）。
备注：main.ts:116 起缩进异常（4 空格，与上文 2 空格不一致）；mountWorldCreateForm 使用 innerHTML 拼 HTML（本文件唯一处）。

### web/src/runtime/game-view-model.ts

#### `FrontendMode(类型: 9 值联合)` — `web/src/runtime/game-view-model.ts:17-26`
BOOTSTRAP/PLAYING/CHOICE_SELECTING/HYBRID_SELECTING/INPUT_EDITING/INPUT_PREVIEW/CONTENT_WAITING/ENDING/ERROR。调用方：main.ts（render 路由与键盘路由）、ViewModelState、测试。

#### `RuntimePlayableEventWire(接口)` — `web/src/runtime/game-view-model.ts:33-47`
可播行 wire 形状（type/line_id/speaker?/text/portrait?/interaction_id?），与 core RuntimePlayableEvent 结构兼容。调用方：GameViewModel、main.ts、dialogue-box.ts（setLine 参数）、app.ts（PauseInfo 断言处）。

#### `ViewModelState(接口)` — `web/src/runtime/game-view-model.ts:49-70`
投影快照：mode/sessionId?/currentLine?/currentInteraction?(unknown)/currentPreview?/recentLines/status?/ending?/visualState?/lastError?/projectionSeq（重连投影单调计数，UI 用它强制重开面板并重置提交锁 §10.3）。

#### `interactionModeToFrontendMode(interaction: unknown): FrontendMode` — `web/src/runtime/game-view-model.ts:92-107`
用途：从交互 wire 对象推导前端模式（§11.2）；interaction.type==="interaction" 按 mode 三分；legacy `type:"choice"`（prompt+options）→CHOICE_SELECTING；否则 ERROR。
调用方：GameViewModel（deriveModeFromInteraction / deriveModeFromProjection）；game-view-model.test.ts（671-696 直接测）。

#### `MAX_RECENT_LINES(常量 = 8)` — `web/src/runtime/game-view-model.ts:109`
recentLines 上限。

#### `GameViewModel(类)` — `web/src/runtime/game-view-model.ts:117-316`
用途：ServerMessage→UI 状态的**纯投影**（不改 Game 内部、不调 TTS、不碰 DOM/IndexedDB；浏览器只镜像 Node 发布的内容）。
方法：
- `applyServerMessage(msg)` — `web/src/runtime/game-view-model.ts:134-146`：projection.snapshot→applyProjection；runtime.output→applyOutput；其余（audio.*）忽略。
- `applyProjection(projection: UiProjection)` — `web/src/runtime/game-view-model.ts:149-165`：重连全量恢复——sessionId/currentLine/currentInteraction/currentPreview/recentLines(截尾8)/status/ending/visualState；cues 清空（断线窗口的一次性 cue 不重放 §6.4）；deriveModeFromProjection；projectionSeq+1；notify。
- `state(): ViewModelState` — `web/src/runtime/game-view-model.ts:167-182`：防御式快照（recentLines 拷贝）。
- `consumeCues(): StageCueWire[]` — `web/src/runtime/game-view-model.ts:185-189`：一次性取走暂存 cues（重渲染不重放）。
- `subscribe(listener)` — `web/src/runtime/game-view-model.ts:191-196`。
- `applyOutput(output: RuntimeOutputWire)`（私有）— `web/src/runtime/game-view-model.ts:200-277`：按 output.type 分派——session_started 记 sessionId；playback_ready→PLAYING+currentLine+清交互/预览+pushRecentLine+presentation（visualState+cues）；interaction_opened→规范化（顶层 interactionId 盖到 interaction_id 上，合成 choice 也补）+deriveMode；stage_beat_ready→只更新 visualState/cues **不改 mode**（§65/§107）；interaction_resolved→关表单，非 INPUT_PREVIEW 时转 CONTENT_WAITING（resolved 先于 input_committed，预览需保留）；input_preview_opened→INPUT_PREVIEW+preview；input_preview_canceled→清 preview，按原交互恢复原模式（§11.6）；input_committed→CONTENT_WAITING；status_changed→status；session_ended→ENDING+ending+清行/交互/预览；runtime_error→ERROR+lastError。
- `pushCues(cues)`（私有）— `web/src/runtime/game-view-model.ts:284-286`：wire 镜像断言后入暂存队列。
- `pushRecentLine(line)`（私有）— `web/src/runtime/game-view-model.ts:288-293`：超 8 截头。
- `deriveModeFromInteraction`（L295-297，转发）/`deriveModeFromProjection`（L299-308：ended→ENDING、error→ERROR、preview→INPUT_PREVIEW、interaction→按模式、有行→PLAYING、running→CONTENT_WAITING、否则 BOOTSTRAP）。
- `notify()`（私有）— `web/src/runtime/game-view-model.ts:310-315`。
调用方：app.ts（构造、subscribe、applyServerMessage、state、consumeCues）；game-view-model.test.ts。
依赖：仅 @shared/wire（server-message/ui-projection）+ stage/stage-types（类型）。

内部辅助：`isInteraction`（L72-79，判 interaction 三模式）、`isLegacyChoice`（L81-89，判合成 choice）、`RuntimeOutputWire`（L112-115，从 ServerMessage Extract 出的 output 类型，免 import core）。

### web/src/runtime/runtime-client.ts

#### `RuntimeCommandWire(类型)` — `web/src/runtime/runtime-client.ts:26`
`z.infer<typeof RuntimeCommandSchema>`——RuntimeCommand 的 wire 形状（命令联合定义在 core，wire schema 编码其形状）。

#### `ConnectionState(类型: "connecting"|"open"|"closed")` — `web/src/runtime/runtime-client.ts:28`
调用方：app.ts（GameAppState.connection）、controls.ts（CONNECTION_LABEL）、main.ts。

#### `WebSocketLike(接口) / WebSocketCtor(类型)` — `web/src/runtime/runtime-client.ts:34-44`
最小结构 WebSocket 面（send/close/on*/readyState）；测试注入 fake。

#### `RuntimeClientOptions(接口)` — `web/src/runtime/runtime-client.ts:46-56`
wsUrl/token/onServerMessage/onConnectionChange/webSocketImpl?。

#### `RuntimeClient(类)` — `web/src/runtime/runtime-client.ts:61-257`
用途：连接层——建连/恢复、发命令、收消息（校验+去重）、重连退避、每次（重）连后重发 client.ready；不碰 DOM/TTS/IndexedDB。
方法：
- `constructor(options)` — `web/src/runtime/runtime-client.ts:74-79`：默认 webSocketImpl=globalThis.WebSocket。
- `connect(): Promise<void>` — `web/src/runtime/runtime-client.ts:82-94`：幂等（open 即 resolve）；首次建 connectPromise 并 openSocket。
- `sendCommand(commandId, command)` — `web/src/runtime/runtime-client.ts:97-99`：包 runtime.command（commandId 由 UI 层生成）。
- `send(msg: ClientMessage)` — `web/src/runtime/runtime-client.ts:102-108`：裸发（cache/buffer report）；非 open 时 console.warn 丢弃。
- `close(): void` — `web/src/runtime/runtime-client.ts:111-135`：manuallyClosed=true、清 retryTimer、摘除全部 handler 再 close（防 fake/浏览器 close 事件重排重连）、置 closed、settleConnect。
- `openSocket()`（私有）— `web/src/runtime/runtime-client.ts:137-155`：URL 追加 ?token=；挂 onopen/onmessage/onclose/onerror（onerror 空——close 事件驱动后续）。
- `handleOpen(ws)`（私有）— `web/src/runtime/runtime-client.ts:157-163`：陈旧 socket 守卫；置 open、退避重置 500ms、发 readyMessage、settleConnect。
- `handleMessage(ev, ws)`（私有）— `web/src/runtime/runtime-client.ts:165-194`：非 string 丢；JSON.parse 失败丢；`ServerMessageSchema.safeParse` 失败丢；runtime.output 按 `sequence <= lastSeenSequence` 去重；projection.snapshot 重置水位为 -1（快照是新基线，服务端可重启计数）；转发 onServerMessage。
- `handleClose(ws, ev)`（私有）— `web/src/runtime/runtime-client.ts:196-213`：code===STALE_WIRE_CLOSE_CODE(4002) 时不重连（C7：旧 wire 页面刷新升级）；否则非手动关闭则 scheduleReconnect。
- `scheduleReconnect()`（私有）— `web/src/runtime/runtime-client.ts:216-224`：指数退避 500ms→8s 封顶；open 时重置。
- `setConnectionState(next)`（私有）— `web/src/runtime/runtime-client.ts:226-230`：去重后回调 onConnectionChange。
- `settleConnect()`（私有）— `web/src/runtime/runtime-client.ts:232-239`：resolve connectPromise。
- `readyMessage(): ClientMessage`（私有）— `web/src/runtime/runtime-client.ts:241-256`：client.ready——capabilities.audioWorklet（createAudioWorkletNode 或 AudioWorkletNode 存在性探测）、indexedDb；wireVersion=WIRE_PROTOCOL_VERSION(4)（C7）。
调用方：app.ts（构造/connect/sendCommand/send/close）；runtime-client.test.ts。
依赖：@shared/wire/schemas（RuntimeCommandSchema/ServerMessageSchema/STALE_WIRE_CLOSE_CODE/WIRE_PROTOCOL_VERSION）、client-message、server-message、zod。

内部辅助：`INITIAL_BACKOFF_MS=500`（L58）、`MAX_BACKOFF_MS=8_000`（L59）。

### web/src/stage/bgm-controller.ts

#### `BgmClock(接口: now()/scheduleFrame(cb))` — `web/src/stage/bgm-controller.ts:22-26`
时钟抽象（生产 rAF+performance.now，见 defaultClock L28-33；测试手动驱动）。

#### `BgmController(类)` — `web/src/stage/bgm-controller.ts:50-316`
用途：薄 `<audio>` 封装（spec §6.3）——观察 visualState.bgm；undefined 即淡出后暂停清空；不接 TTS PCM/AudioWorklet 管线。播放微调（manifest bgm_playback）：start/end 裁切窗口内循环（帧回调+timeupdate 双保险，后者覆盖后台标签）、淡入/淡出（顺序式，单 audio）；无配置等价裸 `<audio loop>`。
方法：
- `constructor(resolver, createAudio=()=>new Audio(), clock=defaultClock)` — `web/src/stage/bgm-controller.ts:67-78`：loop=true、preload=auto，挂 loadedmetadata/timeupdate/ended。
- `unlock(): void` — `web/src/stage/bgm-controller.ts:81-95`：Start 手势内 0 音量播首曲再暂停，解锁 autoplay 策略（读 manifest 第一首 bgm）。
- `apply(id: string | undefined): void` — `web/src/stage/bgm-controller.ts:97-112`：同 id 幂等；undefined→淡出后 clearAudio；未知 id 保持当前曲；无前曲直接 startTrack，否则先淡出再接续。
- `applyGenerated(url: string): void` — `web/src/stage/bgm-controller.ts:120-130`：生成曲直达播放（blob URL 绕过资产目录；GENERATED_ID 哨兵使 apply 的静态 id 空间不可能命中）；「最新意图胜」——写手显式 @bgm 值变化随时压回；URL 生命周期归 GeneratedBgm。
- `setVolume(v)/setMuted(muted)` — `web/src/stage/bgm-controller.ts:132-140`：目标音量与 gain 乘算。
- 私有引擎：`playbackOf(id)`（L146-149，manifest playback；生成曲天然 undefined）、`startTrack(id)`（L151-183：装 url、按 playback 定 TrimWindow（end 缺省→Infinity；无窗口则原生 loop）、fadeIn 建 in-ramp、seek 逻辑由 onMetadata 处理）、`startGenerated(url)`（L186-196：整曲原生循环）、`beginFadeOutThen(then)`（L199-221：fadeOut≤0 立即；淡出已在途只换接续动作）、`runAfterFadeOut()`（L223-227）、`clearAudio()`（L229-239）、`applyVolume()`（L241-244，muted?0:volume × gain）、`onMetadata()`（L246-268：duration 钳制 end；窗口退化(<0.05s)回退整曲循环；seek 到 start，失败容忍）、`enforceTrim()`（L270-276：currentTime≥end 回卷）、`onEnded()`（L278-283：end 缺省回卷续播）、`tick(now)`（L285-303：ramp 线性推进 gain，out 完成后 pause+接续）、`ensureLoop()`（L305-315：ramp 或裁切监听活动期间自续订帧回调）。
调用方：main.ts（unlock/apply/setVolume/setMuted）、GeneratedBgm（audio 域，applyGenerated）、app.ts（经 options.bgmController 的 setVolume/setMuted）、bgm-controller.test.ts。
依赖：browser-asset-resolver、stage-types（BgmPlayback）。

内部辅助：`GENERATED_ID="__generated__"`（L16）、`MIN_WINDOW_SEC=0.05`（L19）、`defaultClock`（L28-33）、`VolumeRamp`（L36-42）、`TrimWindow`（L45-48）。

### web/src/stage/stage-renderer.ts

#### `deterministicHue(key: string): number` — `web/src/stage/stage-renderer.ts:23-27`
用途：id 字符码求和 %360——占位色块的确定性色相。调用方：本文件两处占位渲染；stage-renderer.test.ts。

#### `StageRenderer(类)` — `web/src/stage/stage-renderer.ts:35-162`
用途：keyed 舞台渲染（spec §6.2）——背景持久 `<img>`（load 后加 ready class 淡入，CSS transition crossfade）；角色每 characterId 一个持久 `<figure>`（variant 变只换 src、position 变只换 slot class、visible 变只切 hidden）；无 URL 回退色块占位。
方法：`constructor(container, resolver)`（L41-48，建 bg/chars 两层）、`apply(state: StageVisualState)`（L50-58：applyBackground+applyCharacters+container.dataset.bgm 写记）、`applyBackground(id)`（L60-88：同 id 幂等；清层；img error 时移除坏图回退占位）、`renderBackgroundPlaceholder(id)`（L90-96）、`applyCharacters(characters)`（L98-116：删除离场节点、按 key 排序更新在场者）、`ensureCharacter(key)`（L118-130）、`updateCharacter(node, key, character)`（L132-155：换 src 前挂 once error 回退；SLOT_CLASSES 换位；hidden 与 displayName）、`applyCharacterPlaceholder(node, key)`（L157-161）。
调用方：main.ts render 闭包（visualState 引用变化时 apply）；stage-renderer.test.ts。
依赖：ui/dom（el/clearChildren）、browser-asset-resolver、stage-types。

内部辅助：`SLOT_CLASSES`（L14-20，五个站位 class）、`CharacterNode`（L29-33）。

### web/src/stage/stage-types.ts（纯类型，无运行时代码）

#### `StagePosition(类型)` — `web/src/stage/stage-types.ts:13`
"far_left"|"left"|"center"|"right"|"far_right"。
#### `StageCharacterState(接口)` — `web/src/stage/stage-types.ts:16-22`
spriteSet/variant/position/displayName/visible。
#### `StageVisualState(接口)` — `web/src/stage/stage-types.ts:25-29`
background?/bgm?/characters——权威舞台画面（§52）。
#### `BgmPlayback(接口)` — `web/src/stage/stage-types.ts:32-41`
start?/end?/fadeIn?/fadeOut?（秒）。
#### `PublicAssetManifest(接口)` — `web/src/stage/stage-types.ts:44-49`
backgrounds/bgm/soundEffects/spriteSets 四类 URL 表（core PublicAssetManifest 的 wire 镜像，spec §5.2）。
#### `StageCueWire(类型)` — `web/src/stage/stage-types.ts:52-56`
background|bgm|sound_effect|character_patch 四种瞬态 cue；SE 瞬时不入 VisualState。
调用方：game-view-model、app.ts（consumeCues）、stage 三件套、sound-effect-controller、main.ts、audio/generated-bgm（仅 BgmController 类型）。设计要点：**浏览器刻意不 import core**，wire 镜像结构一致即可赋值。

### web/src/stage/asset-manifest-client.ts

#### `fetchAssetManifest(): Promise<PublicAssetManifest | null>` — `web/src/stage/asset-manifest-client.ts:4-12`
用途：启动时 GET /api/assets/manifest 一次；任何失败返回 null（渲染器回退占位，spec §6.1）。调用方：main.ts:70；asset-manifest-client.test.ts。依赖：fetch、stage-types。

### web/src/stage/browser-asset-resolver.ts

#### `BrowserAssetResolver(类)` — `web/src/stage/browser-asset-resolver.ts:4-26`
用途：逻辑 id → 受控 URL 纯映射（spec §6.1）。成员：`manifest` getter（L7-9）、`resolveBackground(id)`（L11-13）、`resolveBgm(id)`（L15-17）、`resolveSoundEffect(id)`（L19-21）、`resolveSprite(spriteSet, variant)`（L23-25）——manifest 为 null 时全 undefined。
调用方：main.ts（构造并注入三个控制器）、StageRenderer/BgmController/SoundEffectController、GeneratedBgm（间接）；browser-asset-resolver.test.ts。

### web/src/stage/sound-effect-controller.ts

#### `SoundEffectController(类)` — `web/src/stage/sound-effect-controller.ts:5-21`
用途：消费瞬态 sound_effect cue——每 cue 一个一次性 `Audio` 播放（createAudio 可注入），不入 VisualState（spec §6.4）。方法：`consume(cues)`（L11-20：非 sound_effect 跳过；未解析 id 静默跳过）。
调用方：main.ts render 闭包（visualState 变化时 `seController.consume(app.consumeCues())`）；sound-effect-controller.test.ts。

### web/src/ui/graph-panel.ts

#### `GraphPanelView(接口)` — `web/src/ui/graph-panel.ts:13-34`
GET /api/graph 视图形状（与 src/application/graph/graph-view.ts 对齐的松散 JSON）：scenes[]（sceneId/groupKey/status/decisions[]（form/isCursor）/outEdges[]（choiceText/choiceKind/to/confluence））、cursor、runs 统计。

#### `GraphPanel(类)` — `web/src/ui/graph-panel.ts:36-194`
用途：剧情图浮层（M5.1/M5.2 总览+决策子图，纯 DOM 无图库）+ M5.3 回溯确认。
方法：`constructor(root, hooks?)`（L42-75：overlay 骨架、关闭钮、确认条（「在此分叉开启新周目」措辞，决议 D7））、`get isVisible`（L77-79）、`show()`（L81-83）、`hide()`（L85-88，同时取消确认）、`cancelConfirm()`（L90-93）、`requestRetrace(decisionId, prompt)`（L96-103：非游标决策点「回溯」→弹确认条）、`refresh(fetchView)`（L106-117：show→拉取→render；失败在面板内提示不抛出）、`render(value)`（L120-151：runs 摘要行→D8 groupKey 分组→组内时序渲染场景卡；空态文案）、`renderScene(scene)`（L153-193：已完结标记、决策节点（游标高亮 ◀ 当前、非游标挂回溯按钮）、出边列表（结局 ⇒/汇流标记））。
调用方：main.ts（构造/refresh/hide/isVisible）；graph-panel.test.ts。
依赖：ui/dom。

内部辅助：`asView(value)`（L196-199，unknown→view 的宽松收窄）。

### web/src/ui/settings-menu.ts

#### `SettingsMenuHooks / SettingsMenuInitial / SettingsMenuOptions(接口)` — `web/src/ui/settings-menu.ts:11-33`
onVoiceVolume/onBgmVolume/onMute/onTextSpeed；初值四元组；anchor（设置触发钮，其点击不算 outside）与 document（测试缝）。

#### `SettingsMenu(类)` — `web/src/ui/settings-menu.ts:42-213`
用途：合并式设置浮层（语音/BGM 音量、静音、字速、恢复默认），锚在控制条下；outside click 或 Esc 关闭（Esc 归 main.ts 键盘路由）。
方法：`constructor(root, hooks, initial, options)`（L63-142：四行控件装配——语音 0..100%、BGM 0..100%、静音 checkbox、字速 8..64 步进 4 默认 32 字/秒；「恢复默认」按钮；提示「设置保存在本机」）、`isOpen()`（L144-146）、`toggle()`（L148-151）、`open()`（L153-158，挂 document click）、`close()`（L160-165）、`setValues(initial)`（L168-176，外部同步不触发 hooks）、`resetDefaults()`（L179-185，UI 复位+每行各发一次 hook）、`buildSliderRow(...)`（L187-212，通用滑杆行）。
调用方：main.ts（构造/toggle/isOpen/close/setValues 未用——仅 toggle/isOpen/close/syncControlsPinned 路径）；settings-menu.test.ts。
依赖：ui/dom。

内部辅助：`onDocClick`（L56-61，outside 判定）、`SLIDER_MIN/MAX`（L35-36）、`SPEED_MIN/MAX/STEP/DEFAULT`（L37-40）。

### web/src/ui/interaction-panel.ts

#### `InteractionPanelHooks(接口: onSelect(optionId), onSubmit(text))` — `web/src/ui/interaction-panel.ts:21-24`

#### `InteractionPanel(类)` — `web/src/ui/interaction-panel.ts:46-185`
用途：统一 choice/hybrid/input 表单（§11.3/§11.4）——单组件拥有整个交互面（取代旧 renderChoices+InputPanel 分裂导致 hybrid 退化为纯选项、prompt 渲染两次的漂移）；实现一次性提交锁（§10.3）。
方法：`constructor(root, hooks)`（L59-79：从既有骨架 querySelector 取子节点；textarea Enter 提交（IME isComposing/keyCode 229 跳过；Shift+Enter 换行默认行为）；input 事件更新计数）、`open(interaction): boolean`（L86-123：模式判定+asChoiceInteraction/asInputInteraction 双收窄校验；重置提交锁；prompt 唯一；按模式显隐 choices/divider/input；maxLength 钳 1..2000（默认 200）；非 choice 聚焦 textarea）、`setSubmitting(submitting)`（L131-135：外部锁控——注释声明为 §11.4 预留，当前无生产调用方）、`restoreDraft(text)`（L141-149：preview 取消后按原始模式重开并写回草稿 §11.6/§11.7）、`close()`（L152-154）、`selectOption(optionId)`（L156-160：锁+hook）、`submitInput()`（L162-168：trim 非空才锁+hook）、`lock()`（L170-174）、`setOptionsDisabled(disabled)`（L176-180）、`updateCount()`（L182-184）。
调用方：main.ts（open/close/restoreDraft）；interaction-panel.test.ts + main.test.ts。
依赖：choices、dom、input-panel（asInputInteraction）。

内部辅助：`PanelMode`（L26）、`DEFAULT_MAX_LENGTH=200`（L28）、`DEFAULT_PLACEHOLDER`（L29）、`interactionModeOf(value)`（L32-44，判 interaction 三模式与 legacy choice）。

### web/src/ui/layout.ts

#### `AppDomRefs(接口)` — `web/src/ui/layout.ts:10-23`
stage/hud/scene/interactionVeil/dialogueRoot/interactionRoot/previewRoot/waitingEl/controlsRoot/startRoot/endRoot/bannerRoot 共 12 个句柄。

#### `buildAppDom(root: HTMLElement): AppDomRefs` — `web/src/ui/layout.ts:33-179`
用途：清空 root 后注入完整静态骨架：stage（mesh/grain/shafts/双 orb/vig + interactionVeil 遮罩）、hud 品牌、scene（对白框/交互表单骨架/预览面板/等待指示）、controlsRoot、start overlay（标题「灯影夜话」+开始钮+提示）、end overlay（终印/重开钮）、error banner。动态内容全部归组件，本文件只声明结构与 class 钩子。
调用方：main.ts:69；main.test.ts。
依赖：ui/dom。

内部辅助：`button(className, text?, ariaLabel?)`（L26-31，显式 type="button" 防 Enter/Space 触发表单提交）。

### web/src/ui/dialogue-box.ts

#### `DialogueBoxHooks(接口: onAdvance())` — `web/src/ui/dialogue-box.ts:10-12`

#### `DialogueBox(类)` — `web/src/ui/dialogue-box.ts:17-142`
用途：核心对白面板——名牌、打字机逐显、line-id chip（config.game.show_line_ids）、推进提示；一次点击补完全文，再一次推进（§9.3）。
方法：`constructor(root, hooks)`（L32-45：querySelector 取子节点；root click（hint 除外）与 hint click 都走 pressAdvance）、`setLine(line, showLineIds)`（L48-81：同 line_id 幂等；lineEpoch 代次+1；旁白名牌「旁白」+dialogue--narration；重建 Typewriter（onUpdate 写 text、onDone 亮 hint）；`waitForLineFonts` 门控后 start——迟到回调按 epoch 丢弃）、`setCharsPerSecond(cps)`（L83-86）、`get isTyping`（L88-90，无生产调用方）、`pressAdvance()`（L93-99：未打完→skip；已完→hooks.onAdvance）、`clear()`（L101-110，**无生产调用方**）、`waitForLineFonts(text, speaker)`（L118-141：document.fonts.load 预取本行文本与名牌字重的 unicode-range 子集，Promise.race 1500ms 超时；无 fonts API/样式异常/load 拒绝全部 fail-open 不阻塞剧情）。
调用方：main.ts（setLine/setCharsPerSecond/pressAdvance）；main.test.ts（经 boot 间接）。
依赖：game-view-model 类型、ui/dom、typewriter。

内部辅助：`FONT_READY_TIMEOUT_MS=1500`（L15）。

### web/src/ui/controls.ts

#### `ControlsHooks(接口: onModeToggle(next), onOpenSettings())` — `web/src/ui/controls.ts:11-15`

#### `ControlsBar(类)` — `web/src/ui/controls.ts:28-131`
用途：右上会话控制条——手动/自动切换钮、设置入口（全部音视频/文字设置在 SettingsMenu 浮层，不压扁进本条）、连接+播放状态指示。
方法：`constructor(root, hooks, initial)`（L39-81：直接 document.createElement 装配（本文件未用 ui/dom 的 el）；模式钮点击即本地翻转并回调）、`get settingsTrigger`（L84-86，SettingsMenu 的 anchor）、`show()/hide()`（L88-94，**无生产调用方**——显隐由 main.ts 的 show(refs.controlsRoot,...) 完成）、`setMode(mode)`（L96-100，**无生产调用方**）、`setSettingsOpen(open)`（L102-104，**无生产调用方**）、`setConnection(state)`（L106-109，dataset.connection+renderStatus）、`setAudio(playing, bufferedMs)`（L111-115，dataset.playing+缓冲秒显示）、`renderStatus()/renderMode()/renderSettings()`（L117-130）。
调用方：main.ts（setConnection/setAudio/settingsTrigger + hooks）；main.test.ts。
依赖：runtime-client 类型（ConnectionState）、audio-coordinator 类型（PlaybackMode）、ui/dom（setText/show）。

内部辅助：`MODE_LABEL`（L17-20 手动/自动）、`CONNECTION_LABEL`（L22-26 连接中…/已连接/已断开）。

### web/src/ui/typewriter.ts

#### `TypewriterHooks(接口: onUpdate(full), onDone())` — `web/src/ui/typewriter.ts:9-12`

#### `Typewriter(类)` — `web/src/ui/typewriter.ts:22-97`
用途：纯时序逐字显示（无 DOM）；CJK 句末标点加拍（×2.5）拟朗读节奏。
方法：`constructor(text, hooks, charsPerSec=32)`（L30-34）、`get isDone`（L36-38）、`get progress`（L40-42，**无生产调用方**）、`start()`（L45-48）、`setCharsPerSecond(cps)`（L51-56：变速从当前位置重排）、`skip()`（L59-66：立即全文+onDone）、`stop()`（L68-73）、`schedule()`（L75-90：逐字 setTimeout，标点延迟乘数）、`finish()`（L92-96）。
调用方：dialogue-box.ts；typewriter.test.ts。
依赖：无（纯逻辑）。

内部辅助：`PUNCTUATION`（L15，十个全半角标点集合）、`PUNCTUATION_DELAY_MULTIPLIER=2.5`（L16）、`clampCps`（L18-20，1..120）。

### web/src/ui/input-panel.ts

#### `InputInteractionLike(接口)` — `web/src/ui/input-panel.ts:14-21`
interaction_id/prompt/input?{placeholder?, max_length?}。

#### `asInputInteraction(value: unknown): InputInteractionLike | null` — `web/src/ui/input-panel.ts:24-47`
用途：unknown→输入面收窄（逐字段类型判定，缺省字段省略）。调用方：InteractionPanel.open、main.test.ts。

#### `PreviewPanelHooks(接口: onConfirm(), onCancel())` — `web/src/ui/input-panel.ts:49-52`

#### `PreviewPanel(类)` — `web/src/ui/input-panel.ts:54-77`
用途：自由文本流的确认页（§13）——冻结文本展示；Enter 确认/Esc 取消（键盘在 main.ts）；编辑态已移交 InteractionPanel。方法：`constructor(root, hooks)`（L59-71：querySelector 绑确认/取消钮）、`show(text)`（L73-76）。
调用方：main.ts；main.test.ts。备注：无 hide 方法（显隐由 main.ts show(refs.previewRoot,...) 控制）。

### web/src/ui/end-screen.ts

#### `EndScreenHooks(接口: onRestart())` — `web/src/ui/end-screen.ts:8-10`
#### `EndingLike(接口: ending_id, text)` — `web/src/ui/end-screen.ts:12-15`
#### `asEnding(value: unknown): EndingLike | null` — `web/src/ui/end-screen.ts:18-25`
用途：unknown 结尾事件收窄。调用方：EndScreen.show、main.test.ts。
#### `EndScreen(类)` — `web/src/ui/end-screen.ts:27-52`
方法：`constructor(root, hooks)`（L31-38 绑重开钮）、`show(ending): boolean`（L41-47：asEnding 失败返回 false，由调用方转 ErrorBanner「结局数据缺失」）、`hide()`（L49-51，**无生产调用方**）。
#### `ErrorBanner(类)` — `web/src/ui/end-screen.ts:54-71`
方法：`constructor(root)`（L58-61）、`show(message)`（L63-66）、`hide()`（L68-70，**无生产调用方**——ERROR 模式经 show(refs.bannerRoot,...) 控制）。
调用方：main.ts（EndScreen.show/构造、ErrorBanner.show ×3 处）。

### web/src/ui/choices.ts

#### `ChoiceOptionLike(接口: id, text)` — `web/src/ui/choices.ts:8-11`
#### `ChoiceInteractionLike(接口: interaction_id, prompt, options[])` — `web/src/ui/choices.ts:13-17`
#### `asChoiceInteraction(value: unknown): ChoiceInteractionLike | null` — `web/src/ui/choices.ts:20-39`
用途：unknown→选项面收窄（过滤坏 option；全坏返回 null）。调用方：InteractionPanel.open、renderChoiceOptions、main.test.ts。
#### `renderChoiceOptions(container, interaction, onSelect): void` — `web/src/ui/choices.ts:45-65`
用途：只渲染选项列表（无 prompt，prompt 归 InteractionPanel 唯一持有 §11.3）；每卡 `--i` 自定义属性驱动 CSS 级联入场。调用方：InteractionPanel.open；interaction-panel.test.ts 间接。
依赖：ui/dom。

### web/src/ui/start-screen.ts

#### `StartScreenHooks(接口: onStart(): void | Promise<void>)` — `web/src/ui/start-screen.ts:8-10`

#### `StartScreen(类)` — `web/src/ui/start-screen.ts:12-57`
用途：autoplay 解锁门（§10.5）——开始点击是创建 AudioContext/注册 worklet/开 WS 的唯一手势。
方法：`constructor(root, hooks)`（L19-28：querySelector 取钮/提示/警告，点击→handleStart）、`show()`（L30-32，**无生产调用方**）、`hide()`（L34-36）、`setBusy(busy)`（L38-41：禁钮+文案「正在启程……」）、`setWarning(message)`（L43-46：token 缺失警告）、`handleStart()`（L48-56：防重入+busy 包裹 await onStart，finally 复位）。
调用方：main.ts（onStart/setWarning/hide）；main.test.ts。

### web/src/ui/dom.ts

#### `el<K>(tag, className?, text?): HTMLElementTagNameMap[K]` — `web/src/ui/dom.ts:7-16`
建元素+可选 class/text。调用方：layout/graph-panel/settings-menu/choices/stage-renderer/main.ts 等（生产 111 处）。
#### `show(node, visible): void` — `web/src/ui/dom.ts:19-22`
切 hidden 属性（只管可见性，布局归 CSS）。
#### `setText(node, text): void` — `web/src/ui/dom.ts:24-26`
null 安全 textContent。
#### `clearChildren(node): void` — `web/src/ui/dom.ts:28-32`
#### `asRecord(value): Record<string, unknown> | null` — `web/src/ui/dom.ts:35-38`
unknown→plain record 收窄（choices/input-panel/end-screen/interaction-panel 共用）。
依赖：无。备注：纯表现层管道，不触游戏/音频状态。

### web/src/music-demo.ts（页面入口脚本，无导出）

模块级执行：取 #player/#status/#fixtures/#fileMeta/#fileInput；为 `DEMO_SCORES`（audio/demo-scores）每曲建「播放」行（button+meta+download）；file input change → file.text() → `MusicScoreSchema.safeParse`（@shared/music/score）→ playTrack。
- `scoreMeta(score)`（L23-32）：bpm/调式/小节/循环秒（`loopSeconds`）/轨道音符统计文本。
- `setStatus(text)`（L50-52）。
- `replayUrl(url)`（L54-59）：revoke 旧 blob URL → 新 URL 播放。
- `playTrack(track, activeEl?)`（L61-92）：rendering 防重入；全按钮禁用→`renderer.render(score)`→`audioBufferToWavBlob`→blob URL→replayUrl；状态行含 WAV 体积；下载链接挂 URL；失败只 setStatus。
调用方：music-demo.html `<script type="module" src="/src/music-demo.ts">`。
依赖：@shared/music/score、audio/music-renderer（SoundfontMusicRenderer/audioBufferToWavBlob/loopSeconds）、audio/demo-scores。
备注：不经 WS、不启游戏（听感调参零 token 的独立工具页）。

### 宿主与配置（概述）

- `web/index.html`（27 行）：zh-CN、dark color-scheme、**render-blocking** 的 /fonts/fonts.css（注释说明：@font-face 必须先于首布局，防 CJK 回退栈先绘）、#app、noscript 提示、/src/main.ts。
- `web/music-demo.html`（71 行）：内联样式的试听页宿主，引 /src/music-demo.ts。
- `vite.config.ts`（34 行，仓库根）：root=web、publicDir=false、双入口（index+musicDemo）rollupOptions、outDir ../dist/web + sourcemap、`@shared` → src/shared 别名、dev 下 middlewareMode: true（本机 web host 挂载 Vite 中间件，Vite 不绑端口）、hmr: false。
- `web/vite-env.d.ts`（11 行）：vite/client 引用（`*?url`/`*.css` 模块声明）。
- `web/public/fonts`（数据资产）：fonts.css + files/ 195 个 woff2（Noto Serif SC unicode-range 子集为主 + Ma Shan Zheng），OFL 许可文本，README；由 scripts/vendor-webfonts.mjs 再生（index.html 注释）。约 56 MB。
- `web/src/ui/styles.css`（1,522 行，清单外补充）：设计系统样式（.gal-player 交互禁制、.stage__veil 遮罩、choices 级联入场等）——本域组件的 class 钩子全部落在此文件。

## 4. 域内数据流（一条服务器消息的完整旅程）

以「服务端推一条新对白」为例（playback_ready）：

1. **WS 接收**：`RuntimeClient.handleMessage`（runtime-client.ts:165）JSON.parse → `ServerMessageSchema.safeParse` → `sequence > lastSeenSequence` 通过去重 → `options.onServerMessage(msg)`。
2. **应用层分流**：`GameApp.onServerMessage`（app.ts:388）default 分支 → `viewModel.applyServerMessage(msg)`。
3. **投影更新**：`GameViewModel.applyOutput`（game-view-model.ts:200）case "playback_ready"：mode=PLAYING、currentLine=event、pushRecentLine、visualState=presentation.visualState、pushCues(presentation.cues) → `notify()`。
4. **音频联动**：viewModel.notify → `GameApp.handleViewNotify`（app.ts:414）：line_id 变化 → `onCurrentLine`（app.ts:435）：coordinator.stop → `ensureEnqueued` → `coordinator.start(lineId)` → `ensureAudio`（缓存查→命中 `feedFromCache` 喂数 / 未命中 `startDownload` → downloader 流式 onPcm → `coordinator.feedPcm`）→ `scheduleReadingFallback`（无音频的 auto 兜底）→ `reconcileAudio`（低水位补未来行）→ `emitState()`。
5. **UI 渲染**：listener（main.ts:363 订阅）→ `render(state)`（main.ts:262）：`show(refs.dialogueRoot, mode==="PLAYING")` → `dialogueBox.setLine(line, showLineIds)`（打字机+字体门控）；`visualState !== lastVisualState` → `stageRenderer.apply(visualState)`（背景/立绘 keyed 更新）→ `visualState.bgm !== lastBgmId` 时 `bgmController.apply(bgm)` → `seController.consume(app.consumeCues())`（app.ts:306 → viewModel.consumeCues 一次性取走 sound_effect cue 播放）。
6. **玩家输入回发**：点击对白框 → `DialogueBox.pressAdvance` → hooks.onAdvance → `app.advance()`（app.ts:315：停本地播放 + `sendCommand({type:"advance"})` → `RuntimeClient.sendCommand(crypto.randomUUID(), cmd)` → ws.send runtime.command）。服务器处理后再推下一条 playback_ready，回到第 1 步。
   - 决策分叉变体：InteractionPanel 选项点击 → `app.selectChoice(optionId)`（需 `interactionIdOf` 取 id）→ select_choice 命令。
   - 自由输入变体：textarea Enter → `app.submitInput` → preview_input → 服务器 input_preview_opened → render 切 INPUT_PREVIEW + 存草稿 → Enter/Esc → `confirmPreview`/`cancelPreview` → confirm_input/cancel_input；取消后服务器 input_preview_canceled → render 经 `interactionPanel.restoreDraft(draft)` 恢复编辑态。
   - 自动模式变体：播完 `coordinatorEvents.onLinePlaybackFinished` → pause_after_ms 暂停窗 → `advance()`。

## 5. 跨域接口

**依赖（本域 import 的域外模块）**：

| 来源 | 符号 | 本域调用点 |
|---|---|---|
| src/shared/wire/server-message.ts | `ServerMessage` | runtime-client.ts:22、game-view-model.ts:13、app.ts:20 |
| src/shared/wire/ui-projection.ts | `UiProjection` | game-view-model.ts:14 |
| src/shared/wire/schemas.ts | `RuntimeCommandSchema`、`ServerMessageSchema`、`STALE_WIRE_CLOSE_CODE(=4002)`、`WIRE_PROTOCOL_VERSION(=4)` | runtime-client.ts:15-20 |
| src/shared/wire/client-message.ts | `ClientMessage`（client.ready/audio.cache_report/audio.buffer_report/runtime.command） | runtime-client.ts:21 |
| src/shared/wire/audio-descriptor.ts | `AudioDescriptor`、`AudioPriority` | app.ts:16 |
| src/shared/wire/public-web-config.ts | `PublicWebConfig`、`DEFAULT_PUBLIC_WEB_CONFIG` | app.ts:18-19 |
| src/shared/music/score.ts | `MusicScoreSchema`、`MusicScore` | music-demo.ts:8 |
| web/src/audio（audio 域） | `AudioCoordinator`(+`AudioCoordinatorEvents`/`PlaybackMode`)、`AudioDownloader`、`PcmDecoder`、`GeneratedBgm`(+`MusicScoreMessage`)、`SoundfontMusicRenderer`、`audioBufferToWavBlob`、`loopSeconds`、`DEMO_SCORES` | app.ts:21-23/57、main.ts:31-32/76、music-demo.ts:9-14 |
| web/src/storage（storage 域） | `AudioDb`、`AudioCacheWriter`(+`CacheWriteOptions`)、`AudioCacheReader`、`AudioCacheCleaner`(+`CleanerOptions`)、`loadPlayerSettings`/`savePlayerSettings`/`PlayerSettings`/`DEFAULT_PLAYER_SETTINGS` | app.ts:27-32、main.ts:21-25/80-81 |

**与 shared/wire 协议的对应**：本域是 wire 协议的浏览器消费端——ServerMessage 七型中 audio.descriptor/priority_changed/invalidated/task_status 由 GameApp 四个 on* 处理，music.score 转 GeneratedBgm，projection.snapshot/runtime.output 由 GameViewModel 投影；ClientMessage 四型全由本域发出（client.ready=RuntimeClient、runtime.command=sendCommand、audio.cache_report/buffer_report=GameApp 报告）。STAGE 侧 stage-types.ts 与 core VisualState/PublicAssetManifest/StageCue 是「结构镜像不 import core」的对应关系（stage-types.ts:1-10 注释明示）。

**被谁依赖**：生产代码中无其他域 import web/src（server 侧只托管构建产物）。`src/entrypoints/web.ts` 启动 `LocalWebHost`（src/hosts/local-web/local-web-host.ts），其路由即本域的 HTTP 面：GET /api/config、POST /api/audio/synthesize、POST /api/worlds、GET /api/graph（src/application/graph/graph-view.ts）、GET /api/assets/manifest、WS /ws/runtime（runtime-websocket.ts）。vite.config.ts dev middlewareMode 由该 host 挂载。

**与 audio 域的调用点汇总**：app.ts start()（构造/init/stop coordinator、构造 downloader+decoder 工厂）、onPcm/feedFromCache（feedPcm）、onCurrentLine/onDescriptor/onPriorityChanged（enqueueLine/start/stop）、onInvalidated（dropLine）、coordinatorEvents 三回调、setMode/setVoiceVolume/setMuted、state()（bufferedAheadMs/isPlaying）；main.ts（GeneratedBgm 装配进 GameAppOptions.music）。
**与 storage 域的调用点汇总**：app.ts start()（db.open/writer/reader/cleaner 构造）、ensureAudio（reader.lookup/readChunks）、startDownload/onTaskStatus（writer.markPartial/markFailed/finishComplete）、runCleaner（cleaner.run）、activeCacheKeys；main.ts（loadPlayerSettings/savePlayerSettings）。

## 6. 测试覆盖

| 测试文件 | 覆盖的符号/行为 |
|---|---|
| web/src/app.test.ts (913) | GameApp 全生命周期：start（worklet 注册+client.ready）/advance/selectChoice（含合成 choice 顶层 interactionId）/submitInput+confirm+Esc cancel/自动模式播完推进与无音频读时兜底/缓存命中跳下载直喂 PCM/下载 POST {taskId,lineId,cacheKey}+token/默认 fetch 绑定/同 cacheKey 并发下载去重/失效中止下载标 partial/合成失败标 failed 不断剧情/重连投影恢复 PLAYING/无 /api/config 回退默认/coordinator 支撑的状态面/task_status finished 不重喂（只播一次）/去重消费者的失效中止共享 fetch/查找途中失效不下载/addModule 抛错显式报错/AudioWorklet 缺失降级文字/暂停窗内手动 advance 只发一次/达到 target_buffer_ms 停止补齐/candidate_first_line 预合成/深层候选不合成 |
| web/src/main.test.ts (504) | boot 装配：start 点击解锁 AudioContext 并连 WS/token 从 URL 读取与缺失警告；交互表单三模式渲染、提交锁（选项/输入后锁死）、hybrid 草稿恢复、预览 Enter/Esc（含按钮聚焦时 Esc）、新交互不复用旧草稿、重连投影重置提交锁重开面板 |
| web/src/runtime/game-view-model.test.ts (697) | GameViewModel：BOOTSTRAP 起始/playback_ready 入 PLAYING/三种交互模式/hybrid 取消回 HYBRID/合成 choice 规范化/投影恢复规范化交互/INPUT_PREVIEW 进入与取消回 INPUT_EDITING/commit 转 WAITING/resolved 关表单且预览保留至 commit/ENDING 与 ERROR/sessionId 与 status/投影全量恢复/无预览投影的 mode 推导/三种重连场景（§9.6 resolved 不复活表单、preview 期间重连恢复预览、已确认输入不复活）/recentLines 截 8/订阅与退订；§86 舞台：playback_ready 与 interaction_opened 镜像 visualState/stage_beat_ready 不改 mode/投影恢复 visualState/cues 暂存一次性取走/重连 cues 清空/缺 cues 不抛；interactionModeToFrontendMode 三分+legacy+ERROR |
| web/src/runtime/runtime-client.test.ts (259) | RuntimeClient：open 发带 token 的 client.ready+capabilities/C7 wire 过旧 close(4002) 不重连/sequence 单调去重/退避重连并重发 ready/非法消息丢弃告警/sendCommand 与裸报告/未连接丢弃命令/close 停重连报 closed |
| web/src/stage/bgm-controller.test.ts (310) | BgmController：apply/apply(undefined)/未知 id/setVolume/setMuted/unlock/applyGenerated（含同 URL 幂等与静态压回）；裁切窗口（seek start、end 回卷双保险、只配 start 的 ended 回卷、窗口钳制与退化回退）；淡入淡出（爬升/停止淡出/切歌串接/淡入中调音量/淡出中再切歌只换接续） |
| web/src/stage/stage-renderer.test.ts (119) | StageRenderer：背景 img+data-asset/角色 figure 复用换 variant 不重建/position 只换 class/visible 切 hidden/无 manifest 占位回退/背景与角色 img error 回退/离场删节点/重复 apply 幂等 |
| web/src/stage/browser-asset-resolver.test.ts (31) | BrowserAssetResolver：四类解析/未知 id undefined/无 manifest 全 undefined |
| web/src/stage/sound-effect-controller.test.ts (38) | SoundEffectController：只播 sound_effect cue 且每 cue 一个一次性 Audio/未知 id 跳过 |
| web/src/stage/asset-manifest-client.test.ts (18) | fetchAssetManifest：成功解析/失败返回 null |
| web/src/ui/interaction-panel.test.ts (269) | InteractionPanel：三模式显隐/prompt 渲染一次/不可用交互 open 返回 false/close/提交锁两条路径/setSubmitting 外部锁/新交互重置锁与草稿/IME 不提交/Enter 提交/Shift+Enter 换行/草稿恢复/新交互清旧草稿 |
| web/src/ui/settings-menu.test.ts (130) | SettingsMenu：初始关闭与 toggle/四行初值/三个滑杆与静音 hook/恢复默认逐行上报/outside click 关闭但面板与 anchor 内不关 |
| web/src/ui/graph-panel.test.ts (109) | GraphPanel：D8 分组+场景卡+游标高亮+出边/空态/拉取失败面板内提示/show/hide |
| web/src/ui/typewriter.test.ts (89) | Typewriter：逐字时序/标点加拍/skip 立即完成/变速重排/空文本立即完成/stop 中止不完 |

覆盖缺口（事实）：layout.ts、dialogue-box.ts、controls.ts、choices.ts、input-panel.ts（PreviewPanel 部分）、end-screen.ts、start-screen.ts、dom.ts 无专属测试文件，仅经 main.test.ts/app.test.ts 间接覆盖；music-demo.ts 完全无测试。

## 7. 重构关注点（事实清单）

- `web/src/ui/controls.ts:88-104` — `ControlsBar.show()/hide()/setMode()/setSettingsOpen()` 四个公有方法在域内无任何生产调用方（显隐由 main.ts 直接 `show(refs.controlsRoot,...)` 控制、模式翻转由构造器内部点击路径完成）；死接口面。
- `web/src/ui/dialogue-box.ts:101-110` — `DialogueBox.clear()` 无生产调用方（连 HEADING/交互切换清场都未用）。
- `web/src/ui/dialogue-box.ts:88-90`、`web/src/ui/typewriter.ts:40-42` — `isTyping`、`progress` getter 无生产调用方。
- `web/src/ui/interaction-panel.ts:131-135` — `setSubmitting` 注释自述「RESERVED … no active caller」，仅测试调用。
- `web/src/ui/start-screen.ts:30-32`、`web/src/ui/end-screen.ts:49-51`、`web/src/ui/end-screen.ts:68-70` — `StartScreen.show`、`EndScreen.hide`、`ErrorBanner.hide` 无生产调用方。
- `web/src/main.ts:116` — 缩进异常（该行 4 空格缩进，上下文均 2 空格；疑为 mountWorldCreateForm 插入后未格式化）。
- `web/src/main.ts:190-208` — GraphPanel 的 overlay 根与按钮由 main.ts 直接 `el()` 创建并 append（graphBtn 进 controlsRoot、graphOverlay 进 appRoot），未纳入 layout.ts 骨架；控制条内出现跨模块 append。
- `web/src/main.ts:386-394` — `mountWorldCreateForm` 用 `innerHTML` 字符串拼接表单（本文件唯一 innerHTML 使用点），与全文件 `el()` 程序化建 DOM 风格不一致。
- `web/src/main.ts:262-361` — `render` 闭包持 8 个可变局部状态（started/lastMode/lastProjectionSeq/lastPreviewText/draftByInteractionId/lastInteractionId/lastVisualState/lastBgmId），boot() 全长 312 行单体；BGM「值变化才 apply」与「visualState 引用变化才重渲染」两条 memoization 规则内嵌于此，属隐式契约。
- `web/src/app.ts:107-876` — GameApp 770 行单类，同时承担消息路由、音频获取状态机（DescriptorEntry 五态）、缓存编排、报告循环、配置加载与状态广播；私有方法 25 个。
- `web/src/app.ts:94-97` — `PauseInfo` 以 `as` 断言从 `RuntimePlayableEventWire` 之外读取 `performance.pause_after_ms`（746-748 行处 cast），该字段未进 wire 类型。
- `web/src/runtime/runtime-client.ts:243-255` — `readyMessage` 在连接层探测 AudioWorklet 能力（createAudioWorkletNode/AudioWorkletNode 存在性），能力探测逻辑与 app.ts:203 的 available 判定分散两处。
- `web/src/ui/controls.ts:48-76` — ControlsBar 用原生 `document.createElement` 装配，未用 ui/dom.ts 的 `el()`（域内其余组件统一用 el）。
- `web/src/ui/graph-panel.ts:196-199` — `asView` 只做 `typeof object` 判定即 cast，字段校验全靠下游可选链；与 dom.ts `asRecord`、input-panel `asInputInteraction` 的严格逐字段收窄风格不一致。
- `web/src/app.ts:57-58` — `GameAppOptions.music` 以 `{ handleScore(message) }` 结构化类型注入而非直接收 `GeneratedBgm`，为测试留缝但使 music.score 链路多一层间接。
- `web/src/ui/layout.ts:33-179` 与 `web/src/ui/interaction-panel.ts:62-67` — 骨架在 layout.ts 声明、InteractionPanel 用 `querySelector` 字符串类名回取子节点；类名改动需跨两文件同步（dialogue-box/input-panel/end-screen/start-screen 同模式）。
- `web/src/main.ts:114` — `void mountWorldCreateForm(appRoot)` 与后续组件构造交错执行（fire-and-forget，无序完成），表单出现时机与游戏组件装配无同步保证。
