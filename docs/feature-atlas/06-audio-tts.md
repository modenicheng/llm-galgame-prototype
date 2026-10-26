# 音频与 TTS 域（服务端）

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：20 文件 / 7855 行（生产代码，不含测试；另含数据资产 voices.yaml，106 行，不计入）

## 1. 域职责与边界

本域覆盖服务端音频管线的全部 Node 侧环节（§7.3–§7.5 契约）：

- **台词 TTS 合成调度**：`TtsTaskService` 按 `lineId+cacheKey` 校验、按 cacheKey 去重合流、FIFO 并发上限 + 优先级排序 + provider 启动间隔节流 + HTTP 429 指数退避重试，把 provider 的 PCM 块以 `AsyncIterable` 暴露给 HTTP 路由流式回传。
- **语音描述符（descriptor）工厂**：`AudioDescriptorFactory` 把运行时台词事件编译为「浏览器可见的 `AudioDescriptor`（lineId/cacheKey/scope/priority/名牌快照/格式）+ Node 私有的 `InternalAudioRecipe`（model/voiceId/演绎参数/seed）」二元组；recipe 永不序列化到浏览器。身份解析严格按稳定 `CharacterId`（C2/C7），声音不可用走可观测降级（文字照播）。
- **演出编译**：`PerformanceCompiler` 把 LLM 逐行演出意图（`LinePerformance`）⊕ 导演场景指导（`VoiceDirectionTarget`）⊕ 编剧画像基线（`VoicePerformanceBaseline`）按「导演 > 逐行 > 画像」优先级合并成 provider 数值参数（rate/pitch/volume/pauses）与 DashScope instruction（free/fixed_emotion/none 三档，100 加权字符预算），确定性输出保证 cacheKey 安全。
- **场景音乐作曲**：`SceneMusicService`（主题制 V2）——导演 `SceneDirective.music` → 绑定命中零 LLM 直发 / 否则调作曲家 agent（reuse|compose）→ 谱面/主题/绑定/会话持久化 → WS 推送；`shared/music/score.ts`+`theme.ts` 是 Node/Web 双侧共用的谱面与主题契约单一真源（L0）。
- **缓存键体系**：`cache-key.ts`（TTS：SHA-256 全参数指纹，前缀 `sha256:`）与 `music-cache-key.ts`（谱面规范 JSON + 渲染器版本，32 位 hex）两套独立键；浏览器只把键当不透明串。
- **意图规划**：`AudioIntentPlanner` 实现 `MediaPlannerPort`，维护正式时间线与候选分支，按 current/next/active_future/candidate_first_line/background 五档优先级增量 upsert descriptor。
- **多 provider 适配**：DashScope CosyVoice（SSE）、本地 qwen3-tts（openai / tts-server 两种方言）、确定性 mock；统一实现 `TtsProviderPort`（core/ports），共享 `TtsProviderError` / `deferred`。

边界外：PCM 播放与缓存（web/src/audio，L5）、谱面渲染（web 侧 OfflineAudioContext）、`shared/wire/audio-descriptor.ts` 线协议类型（L0 wire，本域只消费）。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| src/application/audio/tts-task-service.ts | 445 | 合成任务编排（去重/并发/优先级/429 重试/度量） | 6 | tts-task-service.test.ts (700) |
| src/application/audio/audio-descriptor-factory.ts | 387 | 台词事件 → descriptor+recipe（身份解析/降级/mock 绑定） | 6 | audio-descriptor-factory.test.ts (885) |
| src/application/audio/performance-compiler.ts | 357 | 演出意图 → provider 参数/instruction（词表真源） | 15 | performance-compiler.test.ts (366) |
| src/application/audio/scene-music-service.ts | 291 | 主题制配乐编排（绑定/作曲家/持久化/发布） | 6 | scene-music-service.test.ts (385) |
| src/application/audio/audio-intent-planner.ts | 192 | MediaPlannerPort 实现（时间线/分支/优先级） | 2 | audio-intent-planner.test.ts (263) |
| src/application/audio/audio-catalog-service.ts | 127 | descriptor/recipe 权威注册表 + 生命周期事件 | 4 | audio-catalog-service.test.ts (162) |
| src/application/audio/voice-design-views.ts | 189 | 动态角色音频注入（roster ⊕ 设计画像合并视图） | 7 | voice-design-views.test.ts (426) |
| src/application/audio/qwen3-text-compat.ts | 80 | qwen3-tts 标点兼容改写（破折号→省略号/到） | 2 | qwen3-text-compat.test.ts (88) |
| src/application/audio/cache-key.ts | 66 | TTS cacheKey（SHA-256 全参数指纹） | 2 | cache-key.test.ts (79) |
| src/application/audio/music-cache-key.ts | 33 | 音乐 cacheKey（谱面指纹+渲染器版本） | 2 | scene-music-service.test.ts（经 publish 键）；无独立测试文件 |
| src/application/audio/internal-audio-recipe.ts | 22 | Node 私有合成 recipe 类型 | 1 | （随 factory/catalog 测试间接覆盖） |
| src/application/audio/voice-direction-hub.ts | 25 | 导演声音指导桥（会话级重绑源） | 1 | voice-direction-hub.test.ts (20) |
| src/adapters/tts/dashscope-cosyvoice-provider.ts | 442 | DashScope SSE 流式合成适配器 | 5 | dashscope-cosyvoice-provider.test.ts (207) |
| src/adapters/tts/local-qwen3-tts-provider.ts | 213 | 本地 qwen3-tts 推理服务适配器（双方言） | 5 | local-qwen3-tts-provider.test.ts (148) |
| src/adapters/tts/mock-streaming-tts-provider.ts | 185 | 确定性正弦波 PCM mock | 2 | mock-streaming-tts-provider.test.ts (199) |
| src/adapters/tts/deferred.ts | 18 | Promise.withResolvers 替身（ES2022 目标） | 1 | （经三个 provider 测试间接覆盖） |
| src/adapters/tts/tts-provider-error.ts | 18 | provider 共享类型化错误 | 1 | （经两个 provider 测试间接覆盖） |
| src/shared/music/score.ts | 145 | 符号谱 schema/乐器与情绪词表/工具函数 | 17 | score.test.ts (111) |
| src/shared/music/theme.ts | 157 | 主题元数据/作曲家决策 schema/统计与动机提取 | 14 | theme.test.ts (186) |
| src/config/voices.ts | 238 | voices.yaml V3 严格加载与绑定/环境校验 | 12 | voices.test.ts (288) |

数据资产：`voices.yaml`（仓库根，106 行）——`version: 3` + `profiles:` 映射；每个 profile 含 `semantic`（base_description/allowed_delivery/forbidden_delivery）与 `providers`（`dashscope`：model+voice_id_env+voice_revision+instruction_mode；`local`：model 固定 `local-qwen3-tts`+voice 注册表键）。当前 2 个生产 profile：`suyao_main`、`linche_main`，dashscope model 均为 `qwen3-tts-vc-2026-01-22`（cosyvoice-v3.5-flash 注释备选）。

## 3. 函数级明细

### src/application/audio/tts-task-service.ts

#### `TtsTaskService`（interface，`synthesize(request: AudioFetchRequest, signal: AbortSignal): Promise<TtsStreamSession>`） — `src/application/audio/tts-task-service.ts:45-55`
- 用途：合成任务编排契约；实现见 `TtsTaskServiceImpl`。调用方：`hosts/local-web/audio-stream-route.ts:20`（HTTP 路由）、`application/runtime-application.ts:28`（组合根类型）、`hosts/local-web/test-fakes.ts:105`（FakeTtsTasks）。
- 依赖：`AudioFetchRequest`（shared/wire）、`TtsStreamSession`（core/ports/tts-provider-port）。

#### `TtsTaskErrorCode`（type，`"invalid_line" | "audio_disabled" | "canceled"`） — `:57`
- 用途：任务错误码枚举；HTTP 路由据此映射状态码。

#### `TtsTaskError`（class，`constructor(code, message?)`） — `:60-68`
- 用途：类型化任务错误。调用方：`audio-stream-route.ts:30`（`ttsErrorStatus` 按 code 映射 404/409/503/499）。

#### `TaskStatusEvent`（interface，`{taskId, lineId, status: started|finished|failed|canceled, error?, totalBytes?}`） — `:70-76`
- 用途：任务状态事件；经 `TtsTaskServiceImplOptions.onStatus` 扇出，bootstrap 用 Set 扇出给宿主订阅（`bootstrap/create-runtime-application.ts:213-219`）。

#### `TtsTaskServiceImplOptions`（interface） — `:78-86`
- 用途：装配选项（catalog/provider 可为 null=禁用/maxConcurrency/onStatus/minProviderStartIntervalMs 默认 350ms）。

#### `TtsTaskServiceImpl`（class，implements `TtsTaskService`） — `:125-445`
- 用途：具体编排器。关键流程 `synthesize`（`:140-190`）：
  1. `catalog.validateFetchRequest` 校验 lineId+cacheKey，失败抛 `TtsTaskError("invalid_line")`；
  2. signal 已 abort → `canceled`；provider 为 null → `audio_disabled`；`catalog.getRecipe` 缺失 → `invalid_line`；
  3. `tasks` 表按 `recipe.cacheKey` 命中则 refcount+1 挂 abort 后直接返回同一 `sessionPromise`（合流，§22 不变量 11）；
  4. 否则 `createEntry` 建条目入 FIFO 队列，`pumpQueue`，返回 sessionPromise。
- `pumpQueue`（`:251-283`）：并发空位 + `retryAt` 到期 + provider 启动间隔（`nextProviderStartAt`）三重门；到期候选按 `priorityOf`（`:285-288`，PRIORITY_RANK current→background 0→4）+ enqueuedAt 稳定排序出队。
- `runTask`（`:290-345`）：`provider.start(buildSynthesisRequest(entry))`；启动失败且是 429（`isRateLimitError`，`:35-42` 按 `error.code === "http_429"` 鸭子判定）且未取消 → 按 `RATE_LIMIT_RETRY_DELAYS_MS`（1s/2s/4s）重排队；否则 finish+failSession。成功则 `settleSession`（把 metadata + `wrapChunks` 包装的 chunks + completion 交给消费者）并 `monitor`。
- `monitor`（`:348-371`）：等 `completion`；`cancelRequested` 时即使 provider 正常 resolve 也记 `canceled`（§7.5 契约）。
- `onConsumerAbort`（`:233-249`）：refcount--；归零时排队中→出队+fail(canceled)，运行中→`providerSignal.abort()`。
- `finish`（`:385-412`）：幂等终结（finalized 标记）、删 tasks 表、activeCount--、发状态事件、再 pump。
- `wrapChunks`（`:415-426`）：透传 PCM 块并记首字节延迟与总字节。
- `buildSynthesisRequest`（`:428-444`）：recipe → `TtsSynthesisRequest`（instruction 仅在存在时携带）。
- 调用方：`bootstrap/create-runtime-application.ts:216`（构造）、`hosts/local-web/audio-stream-route.ts`（handle 内 `ttsTasks.synthesize`）。
- 依赖：`AudioCatalogService`、`TtsProviderPort`、`ttsLog`（shared/tts-log）。
- 备注：`maxActiveFutureLines` 配置在 planner 侧读取（audio-intent-planner），task service 并未消费未来行数上限——并发治理分两处。

内部辅助：`shortId`（:21-23 日志短 id）、`isRateLimitError`（:35-42 429 判定）、常量 `DEFAULT_MIN_PROVIDER_START_INTERVAL_MS`/`RATE_LIMIT_RETRY_DELAYS_MS`/`PRIORITY_RANK`（:25-33）、私有方法 `createEntry`/`attachAbort`/`onConsumerAbort`/`pumpQueue`/`priorityOf`/`runTask`/`monitor`/`settleSession`/`failSession`/`finish`/`wrapChunks`/`buildSynthesisRequest`。

### src/application/audio/audio-descriptor-factory.ts

#### `AudioDescriptorFactoryOptions`（interface） — `:54-93`
- 用途：装配选项——registry（身份真源）、legacyResolver（旧事件兼容）、voices、provider 判别、modelProfile、sampleRate/format、env（voice-id 查找，不下发浏览器）、compiler、seedFor、voiceDirectionFor、voiceDesigns。

#### `AvailableAudioBuild`（interface） — `:96-100`
- 用途：成功构建结果 `{voiceAvailability: "available", descriptor, recipe}`。

#### `VoiceUnavailabilityReason`（type，5 个降级原因） — `:103-113`
- 用途：`unresolved_speaker | unknown_character | voiceless_character | missing_profile | missing_provider_binding`。

#### `UnavailableAudioBuild`（interface） — `:116-123`
- 用途：可观测降级结果（reason + 中文 diagnostic，文字照播）。

#### `BuildAudioResult`（type，联合） — `:125`
- 用途：`AvailableAudioBuild | UnavailableAudioBuild`。

#### `AudioDescriptorFactory`（class） — `:130-387`
- `build(event, scope, priority, performance?)`（`:141-281`）：
  1. narration → null（设计上无语音，不诊断）；
  2. `resolveIdentity`（`:289-327`）：player_dialogue → roster.playerId；有 characterId 直用；缺 id 的旧事件经 legacyResolver（唯一命中才归因，否则 `unresolved_speaker` 不猜名）；label 恒为事件名牌快照（displayLabel ?? speaker）；
  3. registry.get 缺失 → `unknown_character`；无 voiceProfileId → `voiceless_character`；profile 缺失 → `missing_profile`；`resolveBinding` 为 null → `missing_provider_binding`；
  4. `resolveVoiceId(binding, env)` 取实际音色 id；查 `voiceDirectionFor(characterId)` 与 `voiceDesigns[characterId]`；
  5. `compiler.compile`（design 的 delivery/avoid 并进调色板、baseline 作先验）；
  6. qwen3-tts 族（`ttsModelFamilyOf(binding.model)`）→ `adaptQwen3TtsText(event.text)` 改写文本（改写结果同时进 recipe 与 cacheKey，旧行缓存自然失效）；
  7. `cacheKeyFromRecipe(cacheKeyRecipe(...))`；产出 descriptor（scope/priority/speakerId=characterId/displaySpeaker=format 24k/pcm_s16le 由装配定）与 recipe。
- `resolveBinding`（`:344-354`）：非 mock 走 `resolveVoiceBinding`（config/voices），无绑定 → null（可观测降级）；mock 合成稳定 mock 绑定（`MOCK_VOICE_<characterId>` env 键、revision 0、instruction_mode none）。
- `cacheKeyRecipe`（`:356-386`）：组装 `CacheKeyRecipe`；compiledInstruction/pause 仅在存在/大于 0 时进指纹。
- 调用方：`application/audio/audio-intent-planner.ts:69,91,130`（三个注册点）；`bootstrap/create-runtime-application.ts:192`（构造）。
- 依赖：`CharacterRegistry`/`LegacyIdentityResolver`（core/characters）、`config/voices.ts`、`PerformanceCompiler`、`cache-key.ts`、`qwen3-text-compat.ts`、`ttsModelFamilyOf`（core/ports/tts-model-family）、`CharacterVoiceDesign`（application/outline/outline-writer）、`ttsLog`。
- 备注：注释明确 R18（导演侧键严格校验）属 M2，工厂侧只保证 ID 语义。

内部辅助：`resolveIdentity`（:289-327）、`unavailable`（:329-336 降级结果+ttsLog build-skip）、`resolveBinding`、`cacheKeyRecipe`、常量 `MOCK_VOICE_ENV_PREFIX`（:128）。

### src/application/audio/performance-compiler.ts

#### `LinePerformance`（interface） — `:12-34`
- 用途：LLM 逐行演出意图受限形状（emotion 13 值/intensity 0-3/pace/energy/volume/delivery[]/pause_*_ms）。镜像副本在 `story/types.ts:229-240`（注释要求两处同步）。

#### `DELIVERY_TAGS` / `DeliveryTag` — `:41-51`
- 用途：delivery 词表真源（8 标签）。跨域消费：`adapters/llm/outline-writer-adapter.ts:14-18`（连同 PACE/ENERGY/VOLUME 词表一起用于 writer 的 zod schema）。

#### `PACE_VALUES`/`Pace` — `:53-54`；`ENERGY_VALUES`/`Energy` — `:56-57`；`VOLUME_VALUES`/`VolumeLevel` — `:59-60`
- 用途：三轴词表真源，同上被 outline-writer-adapter 消费。

#### `VoicePerformanceBaseline`（interface） — `:66-70`
- 用途：画像层表演先验（三轴档位）。

#### `VoiceDirectionTarget`（interface） — `:77-84`
- 用途：导演逐场景声音指导（delivery/三轴/note ≤40 字）。消费方：`voice-direction-hub.ts`、`director-service`（经 hub）、factory options。

#### `CompiledPerformance`（interface） — `:87-94`
- 用途：编译产物（instruction?/rate/pitch/volume/pauseBeforeMs/pauseAfterMs）。

#### `PerformanceCompileInput`（interface） — `:97-113`
- 用途：编译输入（baseDescription/allowedDelivery/forbiddenDelivery/performance/direction/baseline/instructionMode）。

#### `PerformanceCompiler`（interface） — `:115-117`
- 用途：编译器契约。

#### `PerformanceCompilerImpl`（class） — `:309-357`
- `compile(input)`（`:310-356`）：合并优先级 导演 direction > 逐行 performance > 画像 baseline（三轴 `:335-339`、delivery 候选导演标签前置 `:321-324`）；instruction 按 `instructionMode`：`fixed_emotion` → `buildFixedEmotionInstruction`（`:296-300`，FIXED_EMOTION 表 `:283-293` 把 13 情绪映射到 DashScope 7 情绪词，无忠实映射丢弃）；`free` → `buildInstruction`（`:218-243`：base 锚 + `语气：…。` + intensity 2/3 加「情绪强烈。」 + 导演 note；超出 100 加权字符预算先丢尾部短句再截 base——note 先于音色锚让位）；`none` → 不产出。数值轴经 `lookup`（`:169-176`，PACE_RATE `:135-141`、ENERGY_PITCH `:143-149`、VOLUME_LEVEL `:151-156`，缺省回落 IDENTITY_PARAMS `:159-165`）；pause 经 `clampPause`（`:178-181`，0–30000ms）。try/catch 全包：任何异常回落身份参数 + base 作 instruction（编译器永不抛）。
- 调用方：`audio-descriptor-factory.ts:203`（build 内）；`bootstrap/create-runtime-application.ts:201`（构造注入）。
- 备注：`weightedLength`（`:255-262`）汉字（0x3400–0x9fff）计 2 其余计 1，≥ 供应商计数（永不低估）。

内部辅助：`DELIVERY_LABELS`（:124-133 标签→中文）、`PACE_RATE`/`ENERGY_PITCH`/`VOLUME_LEVEL`/`IDENTITY_PARAMS`（数值表）、`lookup`、`clampPause`、`filterDelivery`（:189-207 调色板过滤+去重）、`buildInstruction`、`INSTRUCTION_BUDGET`（:246）、`weightedLength`、`truncateWeighted`（:265-275）、`FIXED_EMOTION`、`buildFixedEmotionInstruction`。

### src/application/audio/scene-music-service.ts

#### `MusicThemeStorePort`（interface，5 方法） — `:39-46`
- 用途：主题目录持久化端口。实现：`adapters/storage/music-theme-store.ts:36`（`MusicThemeStore`，themes.json + scores/）。

#### `ComposerSessionStorePort`（interface，2 方法） — `:49-52`
- 用途：作曲家持久会话端口。实现：`adapters/storage/composer-session-store.ts:28`（`ComposerSessionStore`，music/session.jsonl）。

#### `SceneMusicComposerDecisionInput`（interface） — `:55-59`
- 用途：作曲家决策输入形状（brief+catalog+sessionTurns）。

#### `SceneMusicComposerPort`（interface，`decide(input): Promise<ComposerDecision | null>`） — `:62-64`
- 用途：作曲家端口。实现：`adapters/llm/scene-music-composer-adapter.ts:65`（`SceneMusicComposerAdapter`，LLM 适配）。

#### `SceneMusicScoreEvent`（interface） — `:67-72`
- 用途：谱面产物事件（sceneId/themeId/cacheKey/score），WS 推送与重连回放载荷。消费方：`hosts/local-web/runtime-websocket.ts:20,36-38`、`application/runtime-application.ts:14`。

#### `SceneMusicService`（class） — `:74-291`
- `handleDirective(directive)`（`:99-126`）：导演回调入口（同步、fire-and-forget）；无 music 指导 / 已服务 / in-flight 占位中则跳过；`deciding` Map 保证同场景并发只调一次 LLM；异常仅 `diagnostics.warn`。
- `serve(sceneId, brief)`（`:128-214`）：①绑定命中 → `loadThemeScore` 直发（零 LLM；谱面缺失告警后转作曲家决策重绑）；②`buildCatalog` + `readRecent(COMPOSER_SESSION_WINDOW_TURNS=30)` → `composer.decide`；null（两败）→ 告警沿用当前曲目；③reuse → 读谱、`bindScene` 落盘（失败仅本会话生效）、会话留痕、发布；④compose → `extractMotifHint` 补主题指纹、id 冲突用 `musicCacheKey(score).slice(0,4)` 短 hash 重命名（决策后取新鲜目录防并发撞 id）、putScore+addTheme 落盘（失败仅本会话）、留痕、发布。
- `loadThemeScore`（`:217-227`）：谱面读取，缺失/损坏 → undefined（调用方告警降级）。
- `buildCatalog`（`:230-239`）：全量主题目录 + `themeScoreStats` 统计，单条失败跳过。
- `appendSessionTurns`（`:242-268`）：user=brief / assistant=决策元数据 JSON（不存完整谱面）；留痕失败不阻塞发布。
- `publish`（`:270-279`）：构造事件（`musicCacheKey(score)`）记 `latest` 并逐 listener 派发。
- `subscribe(listener)`（`:282-285`）：WS 桥接订阅（`runtime-websocket.ts` 经 `app.musicScoreSubscribe`，`bootstrap/create-runtime-application.ts:669`）。
- `latestScore()`（`:288-290`）：重连回放（`bootstrap:670`）。
- 调用方：`bootstrap/create-runtime-application.ts:541`（构造）、`:548`（`director.setDirectiveListener((d) => sceneMusic.handleDirective(d))`）。
- 依赖：`shared/music/theme.ts`、`shared/music/score.ts`、`music-cache-key.ts`、`DiagnosticSink`（core/ports，默认 silentDiagnosticSink）、`SceneDirective`（application/director/director-service）。
- 备注：场景一经绑定不随导演后续修订变化（主题=场景音乐身份）；`servedScenes` 会话内防重复广播。

内部辅助：私有 `serve`/`loadThemeScore`/`buildCatalog`/`appendSessionTurns`/`publish`；字段 `servedScenes`/`deciding`/`latest`/`listeners`。

### src/application/audio/audio-intent-planner.ts

#### `AudioIntentPlannerOptions`（interface） — `:18-25`
- 用途：catalog/factory + `candidatePrefetchLines` + `maxActiveFutureLines`（均来自 config.media.audio.planner，bootstrap `:210-212` 填充）。

#### `AudioIntentPlanner`（class，implements `MediaPlannerPort`） — `:33-192`
- `registerActive(lines)`（`:52-81`）：新行入 timeline（timelineIndex O(1) 查重）；仅对新增行 build+upsert（delta 策略，避免 O(n²) 重发）；unavailable 行不进 catalog（文字照播）。
- `registerCandidate(branchId, lines)`（`:83-103`）：前 `candidatePrefetchLines` 行标 `candidate_first_line`，其余 `background`；scope `{type: "candidate", branchId}`。
- `activateCandidate(branchId)`（`:105-142`）：其余分支全部 `invalidate("branch_discarded")` 后清空；promoted 行入 timeline 并按 active scope 重编 descriptor（candidate/active 同 cacheKey——音频复用语义由 factory 保证，见 audio-descriptor-factory.test「同一 ID 在 candidate 与 active scope → 同一缓存键」）。
- `discardCandidate(branchId)`（`:144-151`）：分支行失效。
- `markPresented(lineId)`（`:153-164`）：推进 currentIndex 游标并对后续行重算优先级（`setPriority` 增量下发）。
- `isReady`/`waitUntilReady`（`:166-175`）：过渡期 CLI 兼容——恒 true。
- `priorityFor(index)`（`:178-182`）：current/next/active_future 三档。
- `performanceOf(event)`（`:189-191`）：按属性存在性转发 `event.performance`（三个 build 点锁步转发）。
- 调用方：`core/game.ts:325`（经 `MediaPlannerPort` 注入，runtime/interaction-driver.ts:81 消费）、`bootstrap/create-runtime-application.ts:209`（构造）。
- 备注：timeline 只增不删；markPresented 对未知行 no-op。

内部辅助：`pushTimelineEntry`（:45-50）、字段 `timeline`/`timelineIndex`/`currentIndex`/`branches`。

### src/application/audio/audio-catalog-service.ts

#### `AudioInvalidationReason`（type） — `:13-16`
- 用途：`branch_discarded | preview_canceled | session_closed`。

#### `AudioCatalogEvent`（type，descriptor/invalidated/priority_changed 三态） — `:19-30`
- 用途：生命周期事件，web host 经 WS 转发浏览器。

#### `AudioCatalogService`（interface，9 方法） — `:32-59`
- 用途：权威注册表契约。

#### `AudioCatalogServiceImpl`（class） — `:68-127`
- `upsertDescriptor(descriptor, recipe)`（`:73-77`）：双表（descriptors/recipes）写入 + descriptor 事件。
- `get`/`getRecipe`/`isValidScope`（`:79-89`）：查询；行有效 ⟺ 有 descriptor。
- `invalidate(lineId, reason)`（`:91-96`）：删两表 + invalidated 事件（未知行 no-op）。
- `setPriority(lineId, priority)`（`:98-104`）：同值不发事件。
- `validateFetchRequest(request)`（`:106-111`）：descriptor 存在 + cacheKey 匹配 + scope 有效（§22 不变量 10，拒绝伪造/过期请求）。双调用方：`TtsTaskServiceImpl.synthesize:144` 与 `hosts/local-web/audio-stream-route.ts:115`（入队前快速失败）。
- `listDescriptors()`（`:113-115`）：重连快照（`runtime-websocket.ts:151`）。
- `subscribe(listener)`（`:117-122`）：事件订阅（`runtime-websocket.ts:174`）。
- 调用方：本域 planner/task-service；跨域 `hosts/local-web/runtime-websocket.ts`、`hosts/local-web/audio-stream-route.ts`、`application/runtime-application.ts:27`。

内部辅助：`emit`（:124-126）。

### src/application/audio/voice-design-views.ts

#### `DASHSCOPE_VOICE_FALLBACK_ENV`（const，`"DASHSCOPE_VOICE_FALLBACK"`） — `:18`
- 用途：动态角色共享回退音色 env 键。

#### `DESIGN_PROFILE_PREFIX`（const，`"design:"`） — `:21`
- 用途：动态角色合成 profile id 前缀（author 命名空间隔离）。

#### `VoiceDesignViews`（interface） — `:23-28`
- 用途：合并视图形状（characters 绑定表 / voices 配置 / designs 索引）。

#### `VoiceDesignConflictError`（class） — `:35-58`
- 用途：roster 绑定与设计画像同键冲突（R08/Ruling 12）——装配期大声失败，禁止 last-wins。

#### `mergeVoiceDesignViews(input)` — `:70-140`
- 用途：纯函数合并——roster.voiceProfileId 为绑定基座；设计画像注入：不在 roster 的 id 只进 designs 索引不注入绑定；roster 已绑定者同 profile no-op、异 profile 抛 `VoiceDesignConflictError`；local provider（V3 前身份缺口）或 dashscope 无 fallback 音色时跳过注入（角色走 voiceless 降级）；注入角色获得 `design:<id>` 合成 profile（semantic 来自画像 timbre/delivery/avoid；dashscope 绑定用 fallback env + instruction_mode "free"）。voices.yaml 不回写。
- 调用方：`bootstrap/create-runtime-application.ts:242`（`buildVoiceViews`）。

#### `audioRosterFromViews(roster, views)` — `:149-164`
- 用途：roster ⊕ 视图 → 工厂用 `CharacterRoster`（仅给无绑定动态角色补 voiceProfileId，身份/控制契约不变，revision 按 C2 重算）。调用方：`bootstrap/create-runtime-application.ts:463`。

#### `buildSpeakerPalette(views)` — `:172-189`
- 用途：导演音频调色板查询闭包（author semantic ⊕ design 画像，Set 去重保序；双空 → undefined）。调用方：`bootstrap/create-runtime-application.ts:531`（注入 director options.speakerPalette，类型 `SpeakerVoicePalette` 定义于 `application/director/director-service.ts:51`）。

内部辅助：`rosterHas`（:61-63 原型链安全成员检查）、`rosterBindingOf`（:66-68）。

### src/application/audio/qwen3-text-compat.ts

#### `Qwen3TextCompatResult`（interface，`{text, dashToPause, rangeToDao}`） — `:25-32`
- 用途：改写结果与计数（供日志 `punct-adapt`）。

#### `adaptQwen3TtsText(input)` — `:47-80`
- 用途：qwen3-tts 族标点兼容——①数字区间破折号（中文/阿拉伯数字两侧）→「到」（先于停顿改写）；②破折号族（`--`、—、–、―、‒、−、－、─）→「……」；③CJK 邻接空格剥离；④相邻省略号折叠；ASCII 单连字符与无害符号（～、·）不动。
- 调用方：`audio-descriptor-factory.ts:227`（仅 `ttsModelFamilyOf(binding.model) === "qwen3-tts"` 时启用）。
- 备注：改写文本同时进 recipe.text 与 cacheKey（factory 注释 ：222-226），旧行缓存自然换键重合成。

内部辅助：`NUMERALS`（:35）、`DASH_RUN`（:42）、`CJK`（:45）三个字符类常量。

### src/application/audio/cache-key.ts

#### `CacheKeyRecipe`（interface） — `:10-28`
- 用途：参与指纹的全部音频相关参数（provider/model/voiceId/voiceRevision/text/compiledInstruction?/pause*?/rate/pitch/volume/seed/format/sampleRate）。可选字段缺省时不进摘要（absent ≠ empty，有测试钉死）。

#### `cacheKeyFromRecipe(recipe)` — `:30-66`
- 用途：SHA-256 顺序摘要（`\u0000` 分隔），返回 `sha256:<hex>`。浏览器视为不透明串（无法从 provider 参数重算——它没有这些参数）。
- 调用方：`audio-descriptor-factory.ts:236`。

### src/application/audio/music-cache-key.ts

#### `MUSIC_RENDERER_VERSION`（const，`2`） — `:12`
- 用途：渲染器行为版本；影响输出的渲染改动必须升版本使旧谱缓存失效。web 侧 `web/src/audio/music-renderer.ts:12` 注释引用同一契约。

#### `musicCacheKey(score)` — `:26-33`
- 用途：`sha256("music-v" + 版本 + 谱面规范 JSON)` 取前 32 hex。浏览器缓存的是乐谱而非音频（同谱同版本=同音频，渲染器确定性）。
- 调用方：`scene-music-service.ts:191`（主题 id 冲突短 hash）、`:274`（publish 事件 cacheKey）。

内部辅助：`canonicalJson`（:15-24 递归按键名排序、滤 undefined 的规范序列化——模型 JSON 键序不稳定）。

### src/application/audio/internal-audio-recipe.ts

#### `InternalAudioRecipe`（interface） — `:6-22`
- 用途：Node 私有合成 recipe（lineId/cacheKey/text/model/voiceId/voiceRevision/instruction?/rate/pitch/pauseBeforeMs/pauseAfterMs/volume/seed）。浏览器只见派生 cacheKey。
- 消费方：factory 产出（:246-259）、catalog 存取、task-service `buildSynthesisRequest`。

### src/application/audio/voice-direction-hub.ts

#### `VoiceDirectionHub`（class） — `:11-25`
- `setSource(source?)`（`:16-20`）：绑/解绑查询源（会话建立或 restart 重建时重绑；`bootstrap/create-runtime-application.ts:630` 绑定）。
- `for(speakerId)`（`:22-24`）：查询当前指导；未绑定 → undefined（与无指导路径逐字节一致）。经 `voiceDirectionFor: voiceDirectionHub.for.bind(...)` 注入 factory（`bootstrap:491`）。
- 备注：解决 audio 栈按 runtime 生命周期构建 vs 导演按会话构建的错配。

### src/adapters/tts/dashscope-cosyvoice-provider.ts

#### `DASHSCOPE_DEFAULT_BASE_URL`（const） — `:43-44`
- 用途：官方 SpeechSynthesizer 端点默认值（`selectTtsProvider` 可用 `DASHSCOPE_TTS_BASE_URL` 覆盖）。

#### `DASHSCOPE_DEFAULT_TIMEOUT_MS`（const，`120_000`） — `:45`

#### `DashScopeCosyVoiceProviderOptions`（interface） — `:47-57`
- 用途：apiKey/baseUrl?/timeoutMs?/fetchImpl?/decode?（全部可注入，测试用）。

#### `TtsProviderError`（re-export） — `:60`
- 用途：转发共享错误类（与 local provider 同一类型，测试钉死）。

#### `DashScopeCosyVoiceProvider`（class，implements `TtsProviderPort`） — `:226-442`
- `start(request, signal)`（`:229-441`）：
  1. 组装官方 body：参数全部在 `input`（text/voice/format:"pcm"/sample_rate/rate/pitch/volume/seed/instruction?），非独立 parameters 对象；
  2. POST + `X-DashScope-Data-Inspector`/`X-DashScope-SSE` 头；非 2xx → `TtsProviderError("http_<status>")`；无 body → `sse_parse`；fetch 阶段结束 finally 摘除 caller-signal 桥（防监听器累积）；
  3. 会话态：`AsyncQueue<Uint8Array>(32)` 背压队列 + `deferred<TtsCompletion>` + 首 chunk 期限定时器（超时 → `first_chunk_timeout` 并 abort）；
  4. 后台驱动 `run()`：`parseSseEvents` 逐事件——记 request_id、`extractAudioPayload`（`output.audio.audio_data` 旧名 ?? `output.audio.data` 新名）base64 解码 → `waitForSpace` 后入队；API 错误事件（非 200 code）→ `sse_parse`；`finish_reason: "stop"` 收尾；无任何音频 → `sse_parse`；正常收尾 `settleResolve({totalBytes, durationMs, providerRequestId})`；
  5. abort 是正常结束：abort fetch、close 队列、以已收字节 resolve；异常时映射为 TtsProviderError 并 `queue.fail` + reject。
- 调用方：仅经 `TtsProviderPort` 由 `TtsTaskServiceImpl.runTask` 消费；构造于 `bootstrap/create-runtime-application.ts:126-133`。
- 备注：无重试（重试在 TtsTaskService）；abort/网络错误原样传播，仅 HTTP/SSE/超时做类型化映射。

内部辅助：`DashScopeSseEvent`（:62-75）、`extractAudioPayload`（:78-83）、`isApiErrorEvent`（:86-91）、`parseSseEvents`（:94-132 SSE 字节流→JSON 事件）、`estimatePcmDurationMs`（:135-138 s16le 单声道字节→毫秒）、`AsyncQueue`（:145-224 有界异步队列：push/finish/fail/close/waitForSpace/next，drain 派发）。

### src/adapters/tts/local-qwen3-tts-provider.ts

#### `TtsProviderError`（re-export） — `:34`

#### `LOCAL_TTS_DEFAULT_BASE_URL`（const，`http://127.0.0.1:9766`） — `:36`；`LOCAL_TTS_DEFAULT_TIMEOUT_MS`（const，`120_000`） — `:37`

#### `LocalQwen3TtsProviderOptions`（interface） — `:39-53`
- 用途：baseUrl?/dialect?（"openai" 默认 | "tts-server"）/timeoutMs?/fetchImpl?。env 覆盖（`LOCAL_TTS_BASE_URL`/`LOCAL_TTS_DIALECT`）在 bootstrap `:145-153` 做启动期校验（空 URL 回落默认、非 http(s) 或未知方言抛错）。

#### `LocalQwen3TtsProvider`（class，implements `TtsProviderPort`） — `:55-213`
- `buildDialectRequest(request)`（`:69-84`）：openai → `POST {base}/v1/audio/speech` `{model, input, voice, response_format: "pcm"}`；tts-server → `POST {base}/tts` `{text, voice}`。
- `start(request, signal)`（`:86-137`）：fetch（连接失败 → `connection`；启动前 abort → `canceled`）；非 2xx 消费掉错误体后 `http_<status>`；从 `x-audio-task-id`/`x-audio-sample-rate` 响应头补 metadata；交 `pumpSession`。
- `pumpSession(...)`（`:143-212`）：async generator 逐帧 yield `new Uint8Array(value)`；首 chunk 期限（后续句子可排队，不适用期限）；abort → `controller.abort()` + `reader.cancel()` + 以已收字节 resolve；流中断且非 abort → `connection`。
- 备注：clone 路径不转发 rate/pitch/volume/seed/instruction（引擎不支持，字段直接不发送）。

内部辅助：`buildDialectRequest`（构造器外唯一私有方法；pumpSession 为私有方法）。

### src/adapters/tts/mock-streaming-tts-provider.ts

#### `MockStreamingTtsProviderOptions`（interface） — `:28-41`
- 用途：sampleRate?/chunkBytes?/chunkIntervalMs?/firstByteDelayMs?/durationMs?/failAfterBytes?（模拟首包延迟与中途失败）。

#### `MockStreamingTtsProvider`（class，implements `TtsProviderPort`） — `:78-185`
- `start(request, signal)`（`:81-184`）：由 `request.seed` 经 mulberry32 派生相位与频率（180–260Hz），`buildChunk` 生成 0.25 幅度正弦 s16le 块；按 chunkIntervalMs 节拍产出 durationMs 总时长；abort → 立即以部分字节 resolve（正常结束）；`failAfterBytes` → 迭代中途抛错且 completion reject（provider 失败语义，与 abort 区分）。确定性：同 seed 同字节，不同 seed 不同字节（cacheKey 语义在 mock 下仍成立）。
- 调用方：`bootstrap/create-runtime-application.ts:162`（provider=mock 分支）；大量测试作 fake provider。
- 备注：不落盘（V1 MockAudioSynthesizer 的 mock-audio.json 行为已移除）。

内部辅助：常量 DEFAULT_*（:43-47）、`mulberry32`（:50-58）、`buildChunk`（:61-76）。

### src/adapters/tts/deferred.ts

#### `deferred<T>()` — `:6-18`
- 用途：`Promise.withResolvers` 同形助手（项目 ES2022 目标无该 lib）；返回 `{promise, resolve, reject}`。三个 provider 通用。

### src/adapters/tts/tts-provider-error.ts

#### `TtsProviderError`（class，`constructor(code: string, message: string)`） — `:10-18`
- 用途：全部 provider 适配器共享的类型化失败；消费方按 `code` 鸭子判定（如 TtsTaskService 的 `http_429` 退避），不依赖 instanceof。码族：`http_<status>`/`first_chunk_timeout`/`connection`/`sse_parse`/`canceled`。

### src/shared/music/score.ts（L0）

#### `MUSIC_INSTRUMENTS`/`MusicInstrument` — `:21-35`
- 用途：12 乐器枚举真源（渲染层映射 soundfont）。跨域消费：`adapters/llm/music-composition-skill.ts:9`（作曲提示词）；web 侧 music-renderer。

#### `MUSIC_MOODS`/`MusicMood` — `:38-47`
- 用途：7 情绪词表（导演 prompt 插值 + 作曲 prompt 同源）。消费方：director-service（`:41-42` 导入 SceneMusicDirection 等自本文件）。

#### `MUSIC_INTENSITY_MIN/MAX/DEFAULT`（1/3/2） — `:50-52`；`MUSIC_MAX_TOTAL_NOTES`（600） — `:55`

#### `MusicNoteSchema`（beat/dur/midi/vel，strict） — `:57-68`；`MusicTrackSchema`（instrument/gain/notes≥1） — `:70-77`；`MusicScoreSchema`（version=1/bpm 50-170/key 0-11/mode 三值/bars 8-48/tracks≤12 + superRefine：每乐器一轨、起拍不越循环、总音符 ≤600） — `:79-123`
- 用途：符号谱校验单一真源；Node 作曲适配器校验 LLM 产出，浏览器渲染器同源消费。

#### `MusicNote`/`MusicTrack`/`MusicScore`（z.infer 类型） — `:125-127`

#### `SceneMusicDirection`（interface，mood/intensity/note?） — `:130-135`
- 用途：导演音乐指导形状（SceneDirective.music 字段，director-service.ts:77）。

#### `scoreLoopBeats(score)` — `:138-140`
- 用途：循环总拍数（4/4）。

#### `midiToFreq(midi)` — `:143-145`
- 用途：MIDI → Hz（A4=440），web 渲染器使用。

### src/shared/music/theme.ts（L0）

#### `ThemeIdSchema`（kebab-case slug ≤40） — `:26-28`
- 用途：主题 id（scores/<themeId>.json 文件名安全由 schema 保证）。

#### `MusicThemeMetaSchema`/`MusicThemeMeta` — `:31-52`
- 用途：主题元数据（id/title/concept/style?/motifHint?/parentTheme?）；motifHint 正则限定 4–8 个 MIDI 值。

#### `ComposerThemeInputSchema`/`ComposerThemeInput` — `:58-59`
- 用途：compose 决策的主题输入（omit motifHint——LLM 不写，防幻觉）。

#### `SceneMusicBrief`（interface） — `:62-68`
- 用途：场景配乐 brief（sceneId/sceneGoal?/mood/intensity/note?）。

#### `ComposerDecisionSchema`/`ComposerDecision` — `:71-89`
- 用途：判别联合 reuse{themeId, reason} | compose{theme, score, reason}；LLM 单次 JSON 输出的校验形状（scene-music-composer-adapter 使用）。

#### `ThemeScoreStats`（interface） — `:92-100`；`ThemeCatalogEntry`（interface） — `:103-106`；`ComposerSessionTurn`（interface） — `:109-112`
- 用途：谱面统计 / 目录条目 / 会话轮次（music/session.jsonl 行形状）。

#### `COMPOSER_SESSION_WINDOW_TURNS`（const，`30`） — `:119`
- 用途：会话窗口（窗口截断，V2 不做 LLM 压缩）。

#### `themeScoreStats(score)` — `:121-131`
- 用途：确定性谱面统计（bpm/key/mode/bars/instruments/noteCount/loopSeconds）。消费方：scene-music-service buildCatalog/appendSessionTurns。

#### `extractMotifHint(score)` — `:142-157`
- 用途：确定性动机提取——非铺底轨（排除 pad/choir）中平均音高最高且 ≥4 音的轨，按起拍排序取头 8 音 MIDI 逗号串；无候选 → undefined；同谱恒同值。消费方：scene-music-service serve。

内部辅助：`PAD_INSTRUMENTS`（:134 铺底轨集合）。

### src/config/voices.ts

#### `InstructionMode`（type，`"free" | "fixed_emotion" | "none"`） — `:49`
- 用途：DashScope 指令策略；被 performance-compiler（:9 导入）与 factory 消费。

#### `VoiceProviderBinding`（interface） — `:52-62`
- 用途：dashscope 形状绑定（model/voice_id_env/voice?/voice_revision/instruction_mode）。

#### `LocalVoiceProviderBinding`（interface） — `:69-74`
- 用途：local 绑定（model 固定 `local-qwen3-tts`/voice 注册表键/voice_revision）。

#### `VoiceSemantic`（interface） — `:77-81`；`VoiceProfile`（interface） — `:83-89`；`VoicesConfig`（interface） — `:91-94`
- 用途：profile 形状（semantic + providers{dashscope?, local?}，version 3）。

#### `VoicesConfigSchema`（zod） — `:136-141`
- 用途：严格解析入口（version 恰为 3；profiles 经 safeRecord）。

#### `loadVoices(voicesPath = "voices.yaml")` — `:143-148`
- 用途：读文件 + yaml parse + 严格 schema 校验。调用方：`bootstrap/create-runtime-application.ts:369`。

#### `resolveVoiceBinding(voices, profileId, provider)` — `:156-175`
- 用途：按 provider 取绑定；local 绑定归一化为 dashscope 形状（voice_id_env 空、instruction_mode "none"）使下游多态。调用方：factory `resolveBinding:346`。

#### `resolveVoiceId(binding, env)` — `:182-188`
- 用途：local 优先内联 voice 键；dashscope 查 env（voice-id 从百炼控制台复制进 .env）。调用方：factory `:195`。

#### `validateDashscopeEnv(voices, env)` — `:195-213`
- 用途：启动校验——列出缺失/空的 voice env 及非 URL 的 `DASHSCOPE_TTS_BASE_URL`。调用方：bootstrap `selectTtsProvider:122`。

#### `validateLocalModelConfig(voices, sampleRate)` — `:224-238`
- 用途：local 固定 24 kHz 输出，全局 sample_rate 必须一致（命名违规 profile）。调用方：bootstrap `:137`。

内部辅助：`DANGEROUS_RECORD_KEYS`（:22）、`safeRecord`（:29-46 原型链安全 record——zod v4 z.record 静默丢自有 `__proto__` 键，先在原始输入拒绝）、三个 zod schema（:96-129）、`LOCAL_QWEN3_TTS_SAMPLE_RATE`（:216，24000）。

## 4. 域内数据流（一句台词的旅程）

以一句 LLM 产出的角色台词（`RuntimePlayableEvent`，携带 characterId、可选 performance）为例：

1. **登记**：runtime/interaction-driver → core/game 经 `MediaPlannerPort` 调 `AudioIntentPlanner.registerActive`（audio-intent-planner.ts:52）——新行入 timeline，算优先级。
2. **身份+编译**：planner 调 `AudioDescriptorFactory.build`（audio-descriptor-factory.ts:141）：`resolveIdentity` 按稳定 characterId（旧事件走 legacyResolver）→ registry 查 voiceProfileId → `resolveVoiceBinding`/`resolveVoiceId`（config/voices.ts:156/182）→ `VoiceDirectionHub.for`（导演指导）+ voiceDesigns（编剧画像）→ `PerformanceCompilerImpl.compile`（performance-compiler.ts:310，导演>逐行>画像合并出数值参数与 instruction）。
3. **文本兼容**：若 `ttsModelFamilyOf(binding.model) === "qwen3-tts"` → `adaptQwen3TtsText`（qwen3-text-compat.ts:47）改写破折号。
4. **指纹**：`cacheKeyFromRecipe`（cache-key.ts:30）对全参数 SHA-256 → descriptor + `InternalAudioRecipe`。
5. **注册**：planner 把 available 结果 `AudioCatalogServiceImpl.upsertDescriptor`（audio-catalog-service.ts:73）→ `descriptor` 事件经 `runtime-websocket.ts:174` 订阅推给浏览器（重连走 `listDescriptors` 快照 :151）。
6. **取流**：浏览器按 descriptor 发 `POST /api/audio/synthesize`（audio-stream-route.ts，x-session-token + AudioFetchRequest）→ 路由先 `catalog.validateFetchRequest` 快筛（:115）→ `TtsTaskServiceImpl.synthesize`（tts-task-service.ts:140）再校验、按 cacheKey 合流/入队。
7. **合成**：`pumpQueue` 按并发/优先级/启动间隔调 `runTask` → `provider.start`（DashScope SSE `start`:229 / local `start`:86 / mock `start`:81）流式产出 PCM → `wrapChunks` 计量 → HTTP 响应体逐块回传；429 时按 1s/2s/4s 重试；浏览器断开 → refcount 归零 → `providerSignal.abort()` 取消上游。
8. **（并行支线）配乐**：导演 `SceneDirective.music` → `SceneMusicService.handleDirective`（scene-music-service.ts:99）→ 绑定直发或作曲家 decide → `publish` 的 `SceneMusicScoreEvent`（含 `musicCacheKey`）经 WS 推送，浏览器渲染器确定性渲染（同谱同版本同音频）。

## 5. 跨域接口

**实现的端口**（本域为 implementor）：
- `TtsProviderPort`（core/ports/tts-provider-port.ts）— 三个适配器实现：DashScopeCosyVoiceProvider、LocalQwen3TtsProvider、MockStreamingTtsProvider。
- `MediaPlannerPort`（core/ports/media-planner-port.ts）— `AudioIntentPlanner` 实现；core/game.ts:325 与 runtime/interaction-driver.ts:81 仅依赖端口（test-support/game-test-kit.ts:76 提供 mock）。
- `MusicThemeStorePort` / `ComposerSessionStorePort` / `SceneMusicComposerPort`（本域 scene-music-service.ts 内定义）— 分别由 adapters/storage/music-theme-store.ts:36、adapters/storage/composer-session-store.ts:28、adapters/llm/scene-music-composer-adapter.ts:65 实现（端口定义在应用层、实现在适配器层——倒挂于「ports 在 core」惯例，见 §7）。

**依赖（跨域引入）**：
- core/characters（CharacterRegistry、LegacyIdentityResolver、registry.buildCharacterRoster）、core/ports/tts-model-family、core/ports/diagnostic-sink。
- shared/wire（AudioDescriptor/AudioPriority/AudioScope/AudioFetchRequest）、shared/tts-log、shared/music（本域成员，L0）。
- application/outline/outline-writer（`CharacterVoiceDesign` 类型）、application/director/director-service（`SceneDirective`、`SpeakerVoicePalette`）。
- schema.js（RuntimePlayableEvent）。

**被依赖（跨域消费本域符号）**：
- bootstrap/create-runtime-application.ts——装配全栈：`selectTtsProvider`:115（provider 三选一 + 启动校验）、`buildAudioStack`:172（catalog/factory/planner/ttsTasks + TaskStatusEvent 扇出）、`buildVoiceViews`:232、`audioRosterFromViews`:463、VoiceDirectionHub:486/630、SceneMusicService:541 + director 接线 :548、WS 桥 :669-670。
- hosts/local-web/audio-stream-route.ts（HTTP 合成路由）、runtime-websocket.ts（descriptor 生命周期事件 + 谱面推送）、test-fakes.ts（FakeTtsTasks）。
- application/runtime-application.ts:11-14（组合根类型 audioCatalog/ttsTasks/SceneMusicScoreEvent）。
- adapters/llm/outline-writer-adapter.ts:14-18（DELIVERY_TAGS/PACE/ENERGY/VOLUME_VALUES 词表）、music-composition-skill.ts:9（MUSIC_INSTRUMENTS）、scene-music-composer-adapter.ts（theme.ts 决策 schema）。
- story/types.ts:229-240（LinePerformance 镜像形状，注释要求与 performance-compiler 同步）。
- web（L5）：web/src/audio/* 经 `@shared/music/score.js` 消费谱面类型与 schema（music-renderer.ts、generated-bgm.ts、music-demo.ts）；音频流经 HTTP `POST /api/audio/synthesize`（PCM 不过 WS，§22 不变量 12），descriptor/invalidated/priority_changed 事件与谱面走 Runtime WebSocket。

## 6. 测试覆盖

| 测试文件 | 覆盖的符号/行为 |
|---|---|
| audio-descriptor-factory.test.ts (885 行, 8 describe / 30 it) | build 全路径：正常构建/narration null/名牌快照/env 音色/mock 绑定/确定性 seed/scope/编译透传/pause 进键；voiceDirectionFor（稳定 ID 查询、指导改变 cacheKey、narration 不查）；voiceDesigns 并集；五类 unavailable 降级（voiceless/玩家/missing_profile/missing_provider_binding/unknown_character）；legacy 身份集中解析（唯一命中/改名不猜/未装配降级）；身份隔离 R05/R24（同 ID 异牌同键、同牌异 ID 不串、跨 scope 同键）；R02 改名稳定性；qwen3 标点改写进 recipe+新键 |
| tts-task-service.test.ts (700 行, 19 it) | synthesize 全行为：invalid_line（未知行/伪造键）、audio_disabled、预取消；cacheKey 去重双消费者共享会话；最后消费者 abort 取消 provider；join 部分取消；排队中取消立即失败；FIFO 并发上限；abort 后 provider 部分字节记 canceled；正常 finished；provider 失败 failed；429 重试成功/重试等待期取消；启动间隔节流；同步 429 退避排在启动门后；current 绕过 background；优先级排序 |
| audio-intent-planner.test.ts (263 行, 13 it) | registerActive 三档优先级/幂等/仅新增行发 descriptor；registerCandidate 预取档位；activateCandidate 晋升+失效他支+追加时间线+仅晋升行发 descriptor；discardCandidate 失效；markPresented 游标推进/未知行 no-op；isReady/waitUntilReady 恒真；performance 转发 |
| audio-catalog-service.test.ts (162 行, 9 it) | upsert/get/invalidate（含 no-op）/事件发射；validateFetchRequest 拒伪造键（§22）；setPriority 同值静默；退订 |
| performance-compiler.test.ts (366 行, 4 describe / 29 it) | 恒等参数/空 base 无 instruction；调色板过滤三态；三轴映射；pause 透传；intensity 2-3 强调；确定性（cacheKey 稳定）；垃圾输入/空值不抛；三 instruction 档（fixed_emotion 词表映射/无映射省略、free、none）；100 加权字符预算截断/汉字计 2；导演指导合并（覆盖逐行/note 追加/note 先丢/fixed_emotion 忽略 note/未知字段降级）；画像基线合并（三链优先级） |
| voice-design-views.test.ts (426 行, 10 it) | mock 注入/dashscope 需 fallback env/local 跳过保留索引/无设计文件等价视图/roster 缺席不注入；Ruling 12 异 profile 报错/同 profile no-op；工厂与调色板同视图；audioRosterFromViews 只补动态绑定；注入跳过时保持无绑定 |
| scene-music-service.test.ts (385 行, 12 it) | 无指导不触发；绑定命中零 LLM；reuse/compose 全链（落盘+motifHint+发布）；id 冲突短 hash 重命名；reuse 指向缺失主题告警；双败沿用；同场景并发合流；孤儿绑定降级；落盘失败仍本会话发布；decide reject 吞掉重试；留痕失败仍发布 |
| cache-key.test.ts (79 行, 5 it) | 同 recipe 同键；任一参数变键变；absent ≠ 空 instruction；有 instruction/pause 进摘要、缺省排除 |
| qwen3-text-compat.test.ts (88 行, 12 it) | 行尾/句中破折号、长折叠、数字区间到（中/阿、容空格、单侧数字不映射）、CJK 空格剥离、省略号合并、ASCII 单连字符不动、`--` 算折、无害符号不动、无改写原样 |
| voice-direction-hub.test.ts (20 行, 1 it) | 未绑定/委托/重绑 |
| dashscope-cosyvoice-provider.test.ts (207 行, 8 it) | 官方 body 形状（参数在 input）；无 instruction 省略；新旧 audio 字段名；http_<status> 映射；无音频 sse_parse；中途 abort 部分字节 resolve；首块超时 reject+abort；默认端点 |
| local-qwen3-tts-provider.test.ts (148 行, 6 it) | openai 方言默认请求+流式；tts-server 方言+头元数据；http_<status>；abort 部分字节；connection 错误；与 dashscope 共享错误类 |
| mock-streaming-tts-provider.test.ts (199 行, 6 it) | s16le 元数据；首块先于 completion；字节数精确；同 seed 确定性；abort 部分字节；failAfterBytes 中途抛错+reject |
| score.test.ts (111 行, 8 it) | 合法谱面/循环外起拍/跨循环时值/重复乐器/总量上限/strict 拒未知字段/枚举；scoreLoopBeats、midiToFreq |
| theme.test.ts (186 行, 9 it) | 元数据合法/坏 slug/多余键/幻觉 motifHint 拒收；reuse/compose 分支；未知 action 拒；extractMotifHint（选轨规则/铺底排除/确定性）；themeScoreStats |
| config/voices.test.ts (288 行, 6 describe / 16 it) | zod 默认展开；`__proto__`/constructor 原型链键拒绝（JSON.parse 构造）；合法键通过；resolveVoiceBinding local 归一化/缺失 undefined；resolveVoiceId 内联键优先；validateDashscopeEnv 缺失清单/非 URL base；local 24k 校验（合格忽略 dashscope-only profile/不匹配点名 profile） |

## 7. 重构关注点（事实清单）

1. `src/application/audio/scene-music-service.ts:39-64` — `MusicThemeStorePort`/`ComposerSessionStorePort`/`SceneMusicComposerPort` 三个端口定义在 application 层而实现在 adapters 层（music-theme-store.ts:21、composer-session-store.ts:21、scene-music-composer-adapter.ts:34 反向 import application），与「端口在 core/ports」的既有惯例（tts-provider-port、media-planner-port）不一致；重构归位时注意这是「ports 随服务定义」的局部风格。
2. 多 provider 重复模式：`dashscope-cosyvoice-provider.ts:229-441` 与 `local-qwen3-tts-provider.ts:86-212` 各自实现「AbortController 桥接 + 首块期限定时器 + deferred completion + settled 幂等 + abort=部分字节 resolve」同一套会话状态机（dashscope 另有 AsyncQueue :145-224；local 用 async generator），mock 也有 settleResolve/settleReject/clearTimers 三连（mock-streaming-tts-provider.ts:108-119）；三者的取消/结算语义靠测试钉死而非共享抽象——抽公共 session 骨架是最大去重点，但需保住「abort=正常结束 vs provider 失败=reject」的分界。
3. 缓存键一致性：TTS 键 `cache-key.ts:30-66` 与音乐键 `music-cache-key.ts:26-33` 是两套独立实现（前缀 `sha256:` vs 裸 32 hex、全参数指纹 vs 规范 JSON+版本），语义上都正确但风格不统一；`CacheKeyRecipe` 的可选字段「缺省不进摘要」约定（cache-key.ts:42-53）与 factory `cacheKeyRecipe`（audio-descriptor-factory.ts:376-384）的「>0 才带」配对，任何一侧改动都必须同步另一侧，否则旧缓存静默失效/失效失败。
4. `src/application/audio/performance-compiler.ts:12-34` 的 `LinePerformance` 与 `src/story/types.ts:229-240` 存在手工镜像形状（后者注释自认「keep the two shapes in sync」）；词表真源（DELIVERY_TAGS 等）又被 `adapters/llm/outline-writer-adapter.ts:14-18` 引用——重构应把形状收敛到单一模块。
5. `src/application/audio/tts-task-service.ts:27-33` 的 `PRIORITY_RANK` 与 `src/shared/wire/audio-descriptor.ts` 的 `AudioPriority`（planner 五档 current…background）耦合但分处两文件；优先级语义散布在 planner（priorityFor :178-182 只产三档）与 task-service（排序消费五档）两处。
6. `src/application/audio/audio-intent-planner.ts:18-25` 的 `maxActiveFutureLines` 选项被装配注入（bootstrap :211-212）但类内无任何读取（仅 candidatePrefetchLines 在 :89-90 使用）——死配置。
7. `src/hosts/local-web/audio-stream-route.ts:33-48` 的 `ttsErrorStatus` 映射了 `invalid_cache_key`/`concurrency_limit`/`bad_request` 三个错误码，而 `TtsTaskErrorCode`（tts-task-service.ts:57）实际只有 `invalid_line | audio_disabled | canceled` 三个——映射表与错误码联合不同步（防御性 default 兜底，属无害但事实性漂移）。
8. `src/application/audio/tts-task-service.ts:26` 429 重试延迟表 `[1000, 2000, 4000]` 为硬编码常量，与 `minProviderStartIntervalMs`（可注入，:84-85）不对称；重试参数不可配置。
9. `src/application/audio/voice-design-views.ts:117` local provider 下动态角色不注入（注释「identity gap until V3」）——设计画像与 local 合成组合时静默无声（走 voiceless 降级），是已知能力缺口而非 bug。
10. `src/application/audio/scene-music-service.ts:81-84` `servedScenes`/`deciding` 均为进程内状态：跨进程重启后靠 bindings 兜底（注释自述），会话留痕读窗口 30 轮（theme.ts:119）超限即静默截断。

## 附A · 设计评注（观察与可能方向，非约束）

1. **429 重试语义**（tts-task-service.ts）：`started` 事件只发一次（`startedNotified` :109、:296-303）；重排队 `enqueuedAt = Date.now()`（:318）——重试条目移同优先级 FIFO 队尾；3 次后放弃转 failed（:314）。延迟表 `[1000,2000,4000]` 是策略数字，配置化是常见整理方向。
2. **pumpQueue 单定时器**（tts-task-service.ts:252-255）：现状全局单 `pumpTimer`（入口先 clear）防泵风暴——手工纪律，可随调度器抽象（optimization-plan 样板族）收编。
3. **compose id 冲突循环复查**（scene-music-service.ts:190-195）：短 hash 后缀仍撞时继续追加——"重命名收敛成功"是这条路径的效果。
4. **谱面缺失的再绑定**：命中绑定但谱面缺失/损坏时只 warn 并转作曲家决策，重绑由 compose 路径的 `addTheme(meta, {sceneId})` 覆盖完成（:130-142）——没有显式解绑操作。
5. **handleDirective 判定顺序与失败重入**（scene-music-service.ts:103-105）：先 `servedScenes` 后 in-flight；`deciding` finally 删除——失败可被后续 directive 重试。
6. **声音优先级链**："导演 > 演员逐行 > 画像基线 > 恒等值"（performance-compiler.ts:319-338），恒等值进 cacheKey。
