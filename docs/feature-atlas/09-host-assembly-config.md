# 宿主·装配·配置·线缆协议域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：22 文件 / 7006 行（生产代码，不含测试；另含数据资产 config.yaml，139 行）

## 1. 域职责与边界

本域覆盖四块职责：

- **HTTP/WS 宿主**（`src/hosts/local-web/`）：单进程本地 web 宿主 `LocalWebHost`——静态服务（dev 走 Vite middleware、prod 走 `dist/web`）、`/ws/runtime` JSON WebSocket（`RuntimeWebSocket`）、`POST /api/audio/synthesize` PCM 流路由（`AudioStreamRoute`）、`GET /api/config`、世界创建/图视图/评分等 HTTP 通道。安全不变量：只绑 `127.0.0.1`；Local Session Token（URL query 携带、WS 与 TTS 请求回显）+ Origin 校验（`origin-guard.ts`）；controller_limit（缺省 1）；PCM 永不上 WS（§22 invariant 12）。
- **装配**（`src/bootstrap/create-runtime-application.ts` 698 行）：Node 侧组合根 `createRuntimeApplication`，构建整个运行时。**装配清单**（按创建顺序）：
  1. `config`（`loadConfig` 或 options.config）、`authorConfig`（`loadAuthorConfig("prompts/author.yaml")`）、`gamesRoot`（缺省 `DEFAULT_GAMES_ROOT="games"`）
  2. `gameId`（显式或时间戳生成）、`CanonStore` + canon 快照、`loadVoices`、`loadApiKey`
  3. `assetCatalog`（`loadAssetCatalog`）
  4. `characterRegistry`（三分支：canon roster / legacy 兼容 / characters.yaml 静态 fallback，见 §3）
  5. prompts（`loadPrompts` + 世界专属 prompts 目录）、`RuntimeStatus`、`Metrics`、`StoryGenerator`
  6. TTS provider（`selectTtsProvider`：dashscope/local/mock/null）+ `factoryProvider`/`modelProfile` 派生
  7. `buildVoiceViews`（VoiceDesignStore → mergeVoiceDesignViews）、音频侧 `audioRegistry`（roster 派生或 legacy 占位 roster）
  8. `VoiceDirectionHub` + `buildAudioStack`（`AudioCatalogServiceImpl`、`AudioDescriptorFactory`、`AudioIntentPlanner`、`TtsTaskServiceImpl`、taskStatusListeners）
  9. `UiProjectionStoreImpl`、显式世界时 `OutlineStore` + `OutlineWriterAdapter`
  10. `confluenceEnabled`、`graphIdentityContext`、`buildDirectorService`（DirectorService + AgentRunnerAdapter + GameGraphStore + ConfluenceJudgeAdapter）
  11. `SceneMusicService`（SceneMusicComposerAdapter + MusicThemeStore + ComposerSessionStore）+ 导演 directive 监听
  12. `buildGraphCoordinator`（GameGraphStore + RunGraphCoordinator + StatsStore + ReviewStore）、`buildCanonPromoter`（GameGraphStore + CanonAdjudicatorAdapter）
  13. 每会话 `buildGameFor`（loadStoryPlan + JsonNarrativeMemoryStore + NarrativeConsolidatorAdapter + NarrativeDirectorService + `Game`[GeneratorPortFacade/SystemClock/SessionIdGenerator]）+ `watchGame`（投影喂入 + session_ended 触发 canon 晋升）
  14. 返回 `RuntimeApplication` 字面量（含 `shutdown`/`restart`/`taskStatusSubscribe`/`musicScoreSubscribe`/`latestMusicScore`）
- **配置加载校验链**（`src/config.ts` + `src/config/public-web-config.ts`）：config.yaml → yaml `parse` → 手工 C7 检查（残留 `characters` 段显式报错，config.ts:627-636）→ `ConfigSchema.parse`（zod：分节 schema + `.default()` 填充 + `superRefine` 跨字段校验）→ `AppConfig`。作者配置 `prompts/author.yaml` → `loadAuthorConfig`（ENOENT → `DEFAULT_AUTHOR_CONFIG`）。浏览器安全切片 `toPublicWebConfig`（AppConfig → PublicWebConfig，Node-only builder，wire 类型永不反向 import Node config）。
- **线缆协议**（`src/shared/wire/` + `src/shared/tts-log.ts`）：Node 宿主与浏览器共享的纯数据类型 + zod schema。**wire 协议版本 = 4**（`WIRE_PROTOCOL_VERSION`，schemas.ts:33；演进：C7=2 稳定 speakerId、动态音乐=3、主题制配乐 V2=4 新增 themeId）。版本不匹配的客户端被 close 4002（`STALE_WIRE_CLOSE_CODE`）。

边界外：TTS provider 实现（adapters/tts，见 06 域）、Game/run 循环（01 域）、图视图构建逻辑本体（05 域）、浏览器端消费（07/08 域）。`ui-projection-store.ts` 位于 application 层但被本域宿主直接消费，归属讨论见 §8。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| src/hosts/local-web/local-web-host.ts | 650 | 单进程 web 宿主（HTTP+WS+静态+API 路由+生命周期） | 2 | local-web-host.test.ts (491) |
| src/hosts/local-web/runtime-websocket.ts | 341 | /ws/runtime 连接管理、鉴权、快照回放、命令去重 | 2 | runtime-websocket.test.ts (514) |
| src/hosts/local-web/audio-stream-route.ts | 267 | POST /api/audio/synthesize PCM 流式路由 | 2 | audio-stream-route.test.ts (264) |
| src/hosts/local-web/vite-middleware.ts | 64 | dev 模式 Vite middleware 包装 | 2 | —（经 local-web-host 间接覆盖） |
| src/hosts/local-web/last-game.ts | 64 | games/.last-game 读写 + 显式 gameId 解析 | 4 | last-game.test.ts (118) |
| src/hosts/local-web/origin-guard.ts | 45 | WS/TTS Origin 白名单校验 | 1 | origin-guard.test.ts (52) |
| src/hosts/local-web/open-browser.ts | 26 | 跨平台打开浏览器 | 1 | — |
| src/hosts/local-web/test-fakes.ts | 116 | 宿主测试共享 fakes（vitest 依赖） | 7 | （本身是测试支撑，被各 *.test.ts 引用） |
| src/hosts/local-web/with-resolvers.d.ts | 20 | Promise.withResolvers 环境声明补丁 | 0（ambient） | — |
| src/entrypoints/cli.ts | 176 | CLI 入口（进程脚本） | 0 | — |
| src/entrypoints/web.ts | 211 | Web 入口（装配宿主 + HTTP 通道回调实现） | 0 | — |
| src/bootstrap/create-runtime-application.ts | 698 | Node 侧组合根 | 2 | create-runtime-application.test.ts (1193) |
| src/application/runtime-application.ts | 83 | RuntimeApplication 契约（接口类型） | 2 | —（经 bootstrap 测试覆盖） |
| src/config.ts | 648 | AppConfig 类型 + zod schema + 加载器 | 18 | config.test.ts (922) |
| src/config/public-web-config.ts | 41 | AppConfig → PublicWebConfig 构建器 | 1 | —（经 local-web-host /api/config 测试覆盖） |
| src/schema.ts | 214 | 事件模型类型聚合/再导出 + isPlayableEvent | 35（含 12 个再导出） | schema.test.ts (529) |
| src/shared/wire/schemas.ts | 190 | 线缆消息 zod schema + 协议版本常量 | 9 | schemas.test.ts (113) |
| src/shared/wire/client-message.ts | 42 | 浏览器→Node 消息类型 | 2 | 经 runtime-websocket.test.ts 覆盖 |
| src/shared/wire/server-message.ts | 49 | Node→浏览器消息类型 | 1 | 经 runtime-websocket.test.ts 覆盖 |
| src/shared/wire/audio-descriptor.ts | 42 | 音频描述符类型（C7 身份语义） | 4 | 经 schemas.test.ts 覆盖 |
| src/shared/wire/ui-projection.ts | 42 | UI 投影快照类型 | 1 | 经 runtime-websocket.test.ts 覆盖 |
| src/shared/wire/public-web-config.ts | 65 | 浏览器安全配置类型 + 离线缺省值 | 2 | — |
| src/shared/tts-log.ts | 26 | TTS 管线结构化日志（Vitest 下静默） | 1 | — |
| src/application/ui/ui-projection-store.ts | 141 | RuntimeOutput → UiProjection 状态投影 | 2 | 经 create-runtime-application / runtime-websocket 测试覆盖 |
| config.yaml（数据资产） | 139 | 顶层 13 节：app/local_web/api/generation/text_buffer/assets/prefetch/input/interaction/media/game/narrative/debug（无 dsl 节 → 缺省 2） | — | — |

## 3. 函数级明细

### src/hosts/local-web/local-web-host.ts

#### `LocalWebHostOptions` — `src/hosts/local-web/local-web-host.ts:56-86`
- 用途：宿主构造参数。`config`/`app`/`dev` 必填；可选 `logger`、`assetCatalog`（缺省回退 `app.assetCatalog`）、三个 HTTP 通道注入：`worlds.create`（POST /api/worlds）、`graph.build/settlement/gallery`（M5.1/M5.4）、`reviews.submit`（M5.5 ①）。通道缺省时对应端点 404。
- 调用方：src/entrypoints/web.ts:92。
- 依赖：AppConfig、RuntimeApplication、AssetCatalog、GraphView 类型。

#### `LocalWebHost` — `src/hosts/local-web/local-web-host.ts:108-534`
- 用途：单进程本地 web 宿主类。
- 构造（L128-175）：生成 16 字节 hex `token`；`toPublicWebConfig`；distRoot（env `LLM_GALGAME_WEB_DIST_DIR` 覆盖）；assetRoot = config.assets.catalog 的 dirname；assetManifest = `buildPublicAssetManifest(..., "/game-assets/")`；组装 `RuntimeWebSocket`（token/controller_limit/originGuard/startGame 回调）与 `AudioStreamRoute`（ttsTasks/catalog/token）。
- 方法逐个：

#### `LocalWebHost.getToken()` — `src/hosts/local-web/local-web-host.ts:178-180`
- 用途：返回 Local Session Token（测试用）。

#### `LocalWebHost.start()` — `src/hosts/local-web/local-web-host.ts:182-235`
- 用途：启动 HTTP + WS，返回 `{url, port}`。
- 关键步骤：① 读 host/port（port>0 用配置值，否则 0=OS 分配）；② `http.createServer(handleRequest)`；③ `WebSocketServer({noServer:true})` + `upgrade` 事件只放行 `/ws/runtime`（其余 `socket.destroy()`）；④ dev 时 `createViteDevMiddleware()`；⑤ `server.listen` 带 once-error 处理；⑥ 从 `server.address()` 取实际端口拼 url；⑦ 拼 `?token=` URL，`open_browser` 为真则 `openBrowser`（失败降级为日志），否则仅日志。
- 调用方：web.ts:183；local-web-host.test.ts。

#### `LocalWebHost.startGame()`（private） — `src/hosts/local-web/local-web-host.ts:246-252`
- 用途：首个 controller WS 连接触发 `game.run()`（§10.5：绝不 boot 即跑，避免无人连接时烧 LLM）。`gameStarted` 标志防重入（刷新重连不会二次 run）。

#### `LocalWebHost.handleRunLoopExit(where, error)`（private） — `src/hosts/local-web/local-web-host.ts:260-276`
- 用途：run 循环退出统一收口。`RuntimeShutdownError` 静默；`RestartRequestedError`→`handleRestart`；`RetraceRequestedError`→`handleRetrace`；其余致命错误：日志 + 合成 `runtime_error` 投影 + `runtimeWs.notifyError` 广播（campus 8e029ff 移植——此前只写日志，浏览器永远停在 CONTENT_WAITING）。

#### `LocalWebHost.handleRetrace(decisionId)`（private） — `src/hosts/local-web/local-web-host.ts:282-293`
- 用途：M5.3 回溯——同一 Game 实例 `prepareRetrace(decisionId)` 后重入 run；ws 不换绑。

#### `LocalWebHost.handleRestart()`（private） — `src/hosts/local-web/local-web-host.ts:300-307`
- 用途：`app.restart()` 重建会话 → `runtimeWs.rebase` 换绑新 game → 重开 run 循环。

#### `LocalWebHost.handleReviewSubmission(req, res)`（private） — `src/hosts/local-web/local-web-host.ts:312-327`
- 用途：POST /api/reviews——校验 rating 为 1–5 整数，调 `reviews.submit(gameId, rating, currentSessionId)`；错误 → 500。

#### `LocalWebHost.handleWorldCreation(req, res)`（private） — `src/hosts/local-web/local-web-host.ts:333-356`
- 用途：M3.3 直通开玩——`worlds.create(text)` → 旧 `app.shutdown()` → 换 `this.app` → `runtimeWs.rebase` → 重开 run → 200 返回 gameId；失败 500 透传（不回退旧世界）。

#### `LocalWebHost.readJsonBody(req, maxBytes=65536)`（private） — `src/hosts/local-web/local-web-host.ts:358-376`
- 用途：读取 JSON 请求体（超限 65536 字节 destroy + reject；空体返回 `{}`）。

#### `LocalWebHost.hasWorld()`（private） — `src/hosts/local-web/local-web-host.ts:379-385`
- 用途：探测 `cwd()/games/<gameId>/outline.json` 是否存在（GET /api/config 的 `has_world` 字段）。

#### `LocalWebHost.shutdown()` — `src/hosts/local-web/local-web-host.ts:388-429`
- 用途：§15.3 顺序关停。步骤：① `runtimeWs.stopAcceptingCommands()`；② `app.shutdown()`；③ 逐个 close(1001) WS 客户端（1 秒超时后 terminate）；④ `server.closeAllConnections()` + close；⑤ `devMiddleware.close()`。`shutdownCalled` 幂等。

#### `LocalWebHost.handleRequest(req, res)`（private） — `src/hosts/local-web/local-web-host.ts:431-517`
- 用途：HTTP 路由表（if 链）。路由：POST /api/audio/synthesize→audioRoute；GET /api/config→publicConfig+has_world；POST /api/worlds、POST /api/reviews、GET /api/graph/settlement、GET /api/graph/gallery、GET /api/graph（通道缺省 404）；GET /api/assets/manifest；GET /game-assets/*→serveAssetFile；其余 /api/*→404 JSON；fallback→serveStatic。

#### `LocalWebHost.serveStatic(req, res)`（private） — `src/hosts/local-web/local-web-host.ts:519-527`
- 用途：dev 走 vite middleware（next 回调 404），prod 走 `serveFile(distRoot)`。

#### `LocalWebHost.sendJson(res, status, body)`（private） — `src/hosts/local-web/local-web-host.ts:529-533`
- 用途：安全 JSON 响应（headersSent/writableEnded/destroyed 三重守卫）。

**内部辅助**：`gamesRootForWorldHint()`（返回 process.cwd()，§「继续游戏」探测根）；`findProjectRoot()`（向上找 package.json，dev/prod 两布局通用）；`PROJECT_ROOT`/`DEFAULT_WEB_DIST_DIR`/`WEB_DIST_DIR_ENV`（测试接缝）；`MIME_TYPES`（16 项静态 MIME 表）；`ASSET_MIME_TYPES`（MIME_TYPES + ogg/mp3/wav）；`serveFile(rootDir, req, res)`（prod 静态服务：405/路径穿越 403/SPA fallback 到 index.html/no-store）；`serveAssetFile(assetRoot, req, res, pathname)`（资源服务：无 SPA fallback，穿越 403，解码失败 400）。

### src/hosts/local-web/runtime-websocket.ts

#### `RuntimeWebSocketDeps` — `src/hosts/local-web/runtime-websocket.ts:26-45`
- 用途：WS 依赖注入接口——game/projection/catalog/ttsStatus/musicEvents/latestMusicScore/startGame/token/controllerLimit/originGuard/publicConfig。

#### `RuntimeWebSocket` — `src/hosts/local-web/runtime-websocket.ts:54-322`
- 用途：/ws/runtime 全生命周期管理。状态：controllers Set、connectionState/sequenceByWs Map、recentCommandIds 去重集（上限 `COMMAND_ID_DEDUP_CAP=1000`）、acceptingCommands、sessionEnded、心跳定时器（`HEARTBEAT_INTERVAL_MS=30_000`）。

#### `RuntimeWebSocket.stopAcceptingCommands()` — `src/hosts/local-web/runtime-websocket.ts:88-90`
- 用途：关停第 1 步——拒绝后续 runtime.command。

#### `RuntimeWebSocket.rebase(game)` — `src/hosts/local-web/runtime-websocket.ts:100-106`
- 用途：restart/世界换绑后指向新 game；复位 sessionEnded；既有连接 close(1000, "session rebased") 逼浏览器重连拿新快照。

#### `RuntimeWebSocket.notifyError(code, message)` — `src/hosts/local-web/runtime-websocket.ts:114-119`
- 用途：run 循环死亡广播——合成 `runtime_error` 按 `runtime.output` 通道下发（延续每连接序号）。

#### `RuntimeWebSocket.handle(ws, req)` — `src/hosts/local-web/runtime-websocket.ts:121-215`
- 用途：新连接入口（由宿主 upgrade 回调调用）。
- 关键步骤：① URL query token 校验（不匹配 terminate）；② originGuard 校验；③ controller 数超限 close(4001, "controller-limit")；④ 首个 controller → `deps.startGame()`；⑤ 注册连接状态 + 启心跳；⑥ `setImmediate` 握手完成后下发 `projection.snapshot` + 全量 descriptor 目录回放 + 最近谱面回放（music.score）；⑦ 订阅四个事件源——game 输出（`runtime.output` + 每连接序号 + sessionEnded/session_started 标志维护）、catalog 事件（mapCatalogEvent）、TTS 任务状态（taskStatusMessage）、音乐事件；⑧ 挂 pong/message/close/error；close 时全部退订 + 清理，`sessionEnded && 仍有连接` → closeAllControllers（结局后断开全部，逼刷新开新局）。

#### `RuntimeWebSocket.onMessage(raw, ws)`（private） — `src/hosts/local-web/runtime-websocket.ts:223-267`
- 用途：入站消息处理。`ClientMessageSchema.safeParse` 失败即丢弃；`runtime.command`：acceptingCommands 检查 + commandId 去重（Set 插入序逐个淘汰最旧，不清空整表）+ `game.dispatch`；`client.ready`：wireVersion 不等于 `WIRE_PROTOCOL_VERSION` → close 4002 附升级说明；`audio.cache_report`/`buffer_report`：确认不回包。

#### `RuntimeWebSocket.mapCatalogEvent(event)`（private） — `src/hosts/local-web/runtime-websocket.ts:269-278`
- 用途：AudioCatalogEvent 三分支 → ServerMessage（descriptor/invalidated/priority_changed）。

#### `RuntimeWebSocket.extractToken(rawUrl)`（private） — `src/hosts/local-web/runtime-websocket.ts:280-287`
- 用途：从 URL query 提取 token（解析失败返回 null）。

#### `RuntimeWebSocket.send(ws, message)`（private） — `src/hosts/local-web/runtime-websocket.ts:289-292`
- 用途：OPEN 态才发送，JSON 序列化。

#### `RuntimeWebSocket.ensureHeartbeat()` / `stopHeartbeat()`（private） — `src/hosts/local-web/runtime-websocket.ts:294-315`
- 用途：30s ping/pong 心跳；未响应 terminate；timer unref；连接清空后停。

#### `RuntimeWebSocket.closeAllControllers()`（private） — `src/hosts/local-web/runtime-websocket.ts:317-321`
- 用途：全部 close(1000, "session ended")。

**内部辅助**：`taskStatusMessage(event)`（模块级函数，TaskStatusEvent → `audio.task_status` ServerMessage，可选 error/totalBytes 字段）；`nextSequence(ws)`（每连接递增序号）。

### src/hosts/local-web/audio-stream-route.ts

#### `AudioStreamRouteDeps` — `src/hosts/local-web/audio-stream-route.ts:19-24`
- 用途：注入 ttsTasks/catalog/token/maxBodyBytes（缺省 4096）。

#### `AudioStreamRoute` — `src/hosts/local-web/audio-stream-route.ts:72-267`
- 用途：PCM 合成流路由。状态：`activeCacheKeys` Set（§22 invariant 11：每 cacheKey 单消费者）。

#### `AudioStreamRoute.handle(req, res)` — `src/hosts/local-web/audio-stream-route.ts:87-155`
- 用途：路由入口。
- 关键步骤：① POST 检查（405）；② content-type 必须 application/json（415）；③ `x-session-token` 头校验（401）；④ readBody（413/400）+ parseRequest（`AudioFetchRequestSchema`，400）；⑤ `catalog.validateFetchRequest` 快速拒绝伪造/过期请求（404）+ ttsLog；⑥ activeCacheKeys 并发第二消费者拒绝（409）；⑦ AbortController + res close 监听（`completion.ended` 标志区分正常结束与中途断开，避免误报 canceled）；⑧ `ttsTasks.synthesize(request, signal)` → `streamSession`；⑨ 错误映射 `ttsErrorStatus`（headers 未发→JSON 错误；流中途→res.destroy()）；⑩ finally：移除 close 监听 + 释放 activeCacheKeys。

#### `AudioStreamRoute.parseRequest(raw)`（private） — `src/hosts/local-web/audio-stream-route.ts:157-166`
- 用途：JSON.parse + AudioFetchRequestSchema.safeParse，失败 null。

#### `AudioStreamRoute.readBody(req)`（private） — `src/hosts/local-web/audio-stream-route.ts:168-209`
- 用途：带大小上限的请求体读取（超限 413 且停止缓冲；error 监听防泄漏/防崩溃）。

#### `AudioStreamRoute.streamSession(res, session, taskId, completion)`（private） — `src/hosts/local-web/audio-stream-route.ts:211-260`
- 用途：写 §8.2 响应头（X-Audio-Encoding/Sample-Rate/Channels/Bit-Depth/Task-Id + no-store）后 for-await 流式写 chunk，处理背压（drain/close 等待）；正常结束先置 `completion.ended=true` 再 `res.end()`；ttsLog 记录 start/end（字节数与耗时）。

#### `AudioStreamRoute.sendError(res, status, message)`（private） — `src/hosts/local-web/audio-stream-route.ts:262-266`
- 用途：JSON 错误响应（headersSent 守卫）。

**内部辅助**：`ttsErrorStatus(error)`（TtsTaskError code → HTTP 状态：invalid_line/invalid_cache_key→404、concurrency_limit→409、audio_disabled→503、bad_request→400、canceled→499，其余→502；不泄漏 recipe/voice 细节）；`errorMessageForStatus(status)`（状态→通用文案）；`BodyResult`（判别联合类型）。

### src/hosts/local-web/vite-middleware.ts

#### `ViteDevMiddleware` — `src/hosts/local-web/vite-middleware.ts:17-25`
- 用途：接口——Connect 风格 middleware + close()。

#### `createViteDevMiddleware()` — `src/hosts/local-web/vite-middleware.ts:27-64`
- 用途：middlewareMode 挂 Vite（单端口、无独立 dev server、无 CORS/代理）。`/` 与 `/index.html` 读原始 web/index.html 经 `vite.transformIndexHtml` 返回；upgrade 头请求直接 next()；其余走 `vite.middlewares`。

**内部辅助**：`PROJECT_ROOT`（模块路径上溯三级）。

### src/hosts/local-web/last-game.ts

#### `isValidGameId(gameId)` — `src/hosts/local-web/last-game.ts:17-19`
- 用途：gameId 安全字符集校验（`^[A-Za-z0-9][A-Za-z0-9._-]*$`——首字符字母数字，排除路径分隔/遍历）。

#### `readLastGameId(gamesRoot)` — `src/hosts/local-web/last-game.ts:21-28`
- 用途：best-effort 读 `gamesRoot/.last-game`；缺失/损坏/非法 → undefined。

#### `writeLastGameId(gamesRoot, gameId)` — `src/hosts/local-web/last-game.ts:30-38`
- 用途：best-effort 写回（mkdir recursive + writeFileSync；失败 console.warn 不阻塞启动）。

#### `resolveExplicitGameId(arg, env)` — `src/hosts/local-web/last-game.ts:45-64`
- 用途：显式世界解析优先级 参数 > 环境变量 `VIBEGAL_GAME_ID`；皆缺 undefined；显式非法 id 大声抛错（中文错误信息）。
- 调用方：cli.ts:57、web.ts:58。

**内部辅助**：`LAST_GAME_FILE`（".last-game" 常量）；`GAME_ID_PATTERN`（正则）。

### src/hosts/local-web/origin-guard.ts

#### `isAllowedOrigin(originHeader, host, port, allowMissing=false)` — `src/hosts/local-web/origin-guard.ts:9-45`
- 用途：仅允许页面自身 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`）。缺 Origin 头默认拒绝（allowMissing 供非浏览器测试客户端）；非 http 协议拒绝；hostname 必须等于绑定 host 或 127.0.0.1/localhost；port≠0 时端口必须精确匹配（port 0=OS 分配接受任意端口）。
- 调用方：local-web-host.ts:166（构造时闭包传入 RuntimeWebSocket）。

### src/hosts/local-web/open-browser.ts

#### `openBrowser(url)` — `src/hosts/local-web/open-browser.ts:10-26`
- 用途：跨平台拉起默认浏览器（win32 `cmd /c start`、darwin `open`、其余 `xdg-open`）；spawn detached + unref，error/exit 均静默 resolve，绝不失败启动。
- 调用方：local-web-host.ts:227。

### src/hosts/local-web/test-fakes.ts

（生产目录中的测试支撑文件，顶部 import vitest；仅被 *.test.ts 引用。）

#### `testDescriptor` — `:16-24`；#### `testRecipe` — `:26-39`
- 用途：标准 descriptor/recipe 夹具（line_1/cache_1/heroine/女主）。

#### `FakeGameHandle`（接口） — `:41-46`；#### `makeFakeGame()` — `:48-69`
- 用途：fake Game（可 emit 的 listener 集合 + dispatch/run mock）。

#### `makeFakeProjection(snapshot)` — `:71-85`
- 用途：fake UiProjectionStore（可替换快照）。

#### `makeSession(chunks)` — `:88-99`
- 用途：合成 TtsStreamSession（两 chunk，流末 resolve completion）。

#### `FakeTtsTasks`（class） — `:105-116`
- 用途：fake TtsTaskService——记录 calls，可注入 createSession 工厂或 error。

### src/hosts/local-web/with-resolvers.d.ts

#### ambient `PromiseConstructor.withResolvers` 声明 — `src/hosts/local-web/with-resolvers.d.ts:10-18`
- 用途：tsconfig.node.json 目标 ES2022 标准库缺 ES2024.Promise 声明的本地补丁（`export {}` 使文件成为模块）。文件头注释自述：lib 升 es2024+ 后成为无害 no-op。

### src/entrypoints/cli.ts（进程脚本，无 export）

#### `parseArgs(argv)`（内部） — `src/entrypoints/cli.ts:17-50`
- 用途：解析 `--debug-runtime`、`--new-world <描述>`、`--game <id>`、位置参数 *.yaml 为 configPath。

#### `main()`（内部） — `src/entrypoints/cli.ts:52-97`
- 用途：CLI 主流程：loadConfig → `resolveExplicitGameId`（不读写 .last-game，都缺→新世界）→ 若 `--new-world`：loadAssetCatalog + loadCharacterPackRoster + WorldGenerator.generate 直通开玩 → `createRuntimeApplication` → TerminalUI + CliController → `controller.run()`（RestartRequestedError → 提示 CLI 不支持进程内重启）→ `printMetrics`。

#### `printMetrics(metrics)`（内部） — `src/entrypoints/cli.ts:103-163`
- 用途：控制台渲染指标汇总（LLM 请求/Token/延迟/预取命中/输入时机/错误/玩家时机）。

#### 顶层 catch — `src/entrypoints/cli.ts:165-176`
- 用途：UserExitError/RuntimeShutdownError → exitCode 130；其余打印错误 exitCode 1；恢复光标显示。

### src/entrypoints/web.ts（进程脚本，无 export）

#### `parseArgs(argv)`（内部） — `src/entrypoints/web.ts:27-50`
- 用途：解析 `--dev`、`--game <id>`、位置参数 configPath。

#### `main()`（内部） — `src/entrypoints/web.ts:52-206`
- 用途：Web 主流程。
- 关键步骤：① loadConfig；② gameId = `resolveExplicitGameId` ?? `readLastGameId(DEFAULT_GAMES_ROOT)`；③ `createRuntimeApplication` → `writeLastGameId`；④ 组装 WorldGenerator（供 /api/worlds）；⑤ 组装 `graphIdentity`（闭包取 `app.characterRegistry.registry?.roster` + `config.dsl?.protocol_version ?? 1`）与 `graphStoreFor(gameId)` 工厂；⑥ `new LocalWebHost({...})` 注入三通道：worlds.create（生成世界 → createRuntimeApplication → writeLastGameId）、graph.build/settlement/gallery（buildGraphView/buildSettlementView/buildGalleryView + OutlineStore + StatsStore）、reviews.submit（见下）；⑦ `host.start()`；⑧ SIGINT/SIGTERM 双击强退的 shutdown 处理。

#### `reviews.submit` 闭包（main 内） — `src/entrypoints/web.ts:137-180`
- 用途：评分提交流水线（44 行业务逻辑在入口文件内）：graph.listRuns 找最近已完结周目 → listEdges 找结局边取 memoryDigest 摘要 → 读 `sessions/<sessionId>/ending-report.json`（容错缺席）→ outline 提取 act 节点 → `ReviewAdapter.reviewRun` 产编剧评注 → `ReviewStore.save`。

#### `shutdown(signal)`（main 内） — `src/entrypoints/web.ts:187-203`
- 用途：第二次信号直接 process.exit(1) 强退；否则 host.shutdown 后 exit(0)。

### src/bootstrap/create-runtime-application.ts

#### `DEFAULT_GAMES_ROOT` — `src/bootstrap/create-runtime-application.ts:107`
- 用途：v2 剧情图根目录缺省值 `"games"`；local-web（.last-game/hasWorld）与 web.ts 共用。
- 调用方：local-web-host.ts:28、web.ts（多处）。

#### `createRuntimeApplication(options): Promise<RuntimeApplication>` — `src/bootstrap/create-runtime-application.ts:355-698`
- 用途：Node 侧组合根（§7.1），构建全部运行时对象（完整清单见 §1）。
- 关键步骤：
  1. **基础加载**（L358-370）：config（options.config 或 loadConfig）、authorConfig、gamesRoot、gameId、CanonStore+快照、voices、apiKey。
  2. **资产目录**（L373）：loadAssetCatalog(config.assets.catalog)。
  3. **registry 三分支**（L383-410）：显式 gameId 且 canon 可构建 roster → `rosterFromCanonCharacters` + `ensureDerivedCharacterCard`（mode:"roster"）；显式 gameId 且有 characters 但无 control → mode:"legacy"（registry undefined，不猜玩家）；否则 characters.yaml 静态 fallback（mode:"roster"）。registry 先于 generator/actor/director/audio 任何装配。
  4. **prompts/指标**（L412-430）：per-game prompts 目录、loadPrompts、RuntimeStatus、Metrics、StoryGenerator（带 registry 身份投影）。
  5. **TTS provider**（L432-444）：selectTtsProvider + factoryProvider（disabled→mock）/modelProfile 单一真源派生。
  6. **声音视图与音频 roster**（L452-482）：buildVoiceViews；audioRegistry 从 roster 派生（audioRosterFromViews），legacy 世界用占位单角色 roster（音频显式降级，不按名牌猜身份）。
  7. **音频栈**（L486-493）：VoiceDirectionHub + buildAudioStack（catalog/factory/planner/ttsTasks/listeners）。
  8. **投影与大纲**（L495-505）：UiProjectionStoreImpl；显式世界接 OutlineStore+OutlineWriterAdapter。
  9. **confluence/身份上下文**（L511-522）：confluenceEnabled（容忍手拼 config 缺省）；graphIdentityContext 仅在有 roster 时提供（legacy 旧 v3 快照显式报错）。
  10. **导演**（L523-533）：buildDirectorService（speakerPalette 来自 voiceViews）。
  11. **动态音乐**（L540-549）：SceneMusicService；musicEnabled 时注册 directive 监听（禁用=零 LLM 调用）。
  12. **图协调器与晋升**（L550-565）：buildGraphCoordinator（judge 来自 director.exposeConfluenceJudge()）+ buildCanonPromoter。
  13. **每会话构建**（L572-634）：`buildGameFor` 闭包——narrative director 装配（loadStoryPlan/JsonNarrativeMemoryStore/NarrativeConsolidatorAdapter/NarrativeDirectorService.initialize）+ `new Game(...)` + voiceDirectionHub.setSource 重绑；resume/restart 两模式。
  14. **会话启动与投影接线**（L640-653）：sessionId（显式或生成）→ buildGameFor → `watchGame`（每个输出喂 projection；session_ended 触发后台 canonPromoter.promoteFromRuns）。
  15. **app 组装**（L655-697）：RuntimeApplication 字面量——taskStatusSubscribe/musicScoreSubscribe/latestMusicScore/shutdown（dispatch shutdown + 一个 macrotask + game.flush 落盘）/restart（shutdown → 新 sessionId → buildGameFor("restart") → watchGame → 后台晋升 → 原地替换 game 字段返回同一 app）。
- 调用方：cli.ts:74、web.ts:59、web.ts:100（worlds.create）、create-runtime-application.test.ts。
- 依赖：import 约 40 个模块（config/voices、game、adapters[llm/storage/platform/tts/static]、application[graph/director/canon/outline/audio/ui/world/narrative/assets/characters]、core/ports、prompts、runtime）。
- 备注：测试 1193 行覆盖 20 个 it（装配完整性、dashscope env 校验、M1 registry 三分支、retrace、restart、叙事落盘等）。

**内部辅助**：`fnv1a(input)`（FNV-1a 32 位哈希，lineId → 确定性 seed → 同 cacheKey）；`selectTtsProvider(config, voices)`（provider 分支 + dashscope/local 环境变量启动期校验，非法大声抛错）；`buildAudioStack(config, voices, provider, wiring)`（catalog/factory/planner/ttsTasks + taskStatusListeners 扇出）；`buildVoiceViews(input)`（VoiceDesignStore.load + mergeVoiceDesignViews，文件损坏大声抛错）；`buildGraphCoordinator(...)`（GameGraphStore + RunGraphCoordinator + StatsStore/ReviewStore）；`buildDirectorService(options)`（DirectorService 完整装配，confluence 门控）；`buildCanonPromoter(options)`（CanonPromoter + CanonAdjudicatorAdapter）；`buildGameFor`（闭包，每会话 Game 重建）；`watchGame`（闭包，输出→投影+晋升触发）。

### src/application/runtime-application.ts

#### `RuntimeApplication`（接口） — `src/application/runtime-application.ts:20-55`
- 用途：统一组合根契约。字段：game/gameId/audioCatalog/ttsTasks/projection/config/metrics/assetCatalog/characterRegistry；方法：shutdown()/restart()/taskStatusSubscribe(listener)/musicScoreSubscribe(listener)/latestMusicScore()。
- 调用方：create-runtime-application.ts（实现）、local-web-host.ts、runtime-websocket.ts（经依赖注入）、两个 entrypoints、测试。

#### `RuntimeApplicationOptions`（接口） — `src/application/runtime-application.ts:57-83`
- 用途：装配入参——configPath/sessionDir/gamesRoot/gameId/config/voicesPath/charactersPath/storyPlanPath/sessionId（显式值使测试确定性）。

### src/config.ts

#### `ControlMode` — `:10`；#### `AudioConfig` — `:12-18`；#### `MusicGenerationConfig` — `:21-23`；#### `AudioPlannerConfig` — `:26-29`；#### `AudioPlaybackConfig` — `:32-39`；#### `AudioSynthesisConfig` — `:42-50`；#### `AudioCacheConfig` — `:53-60`；#### `InteractionPolicyConfig` — `:63-76`；#### `NarrativeConfig` — `:87-107`；#### `ControlSection` — `:284-290`；#### `RulesConfig` — `:292-296`；#### `AuthorConfig` — `:298-301`
- 用途：AppConfig/AuthorConfig 的分节类型声明（纯类型，无行为）。

#### `DEFAULT_NARRATIVE_CONFIG` — `src/config.ts:109-123`
- 用途：NarrativeConfig 缺省值对象（threads/setups/lessons/facts/beliefs/consolidation/brief/confluence.enabled=false/story_plan_path）。
- 调用方：create-runtime-application.ts:512（confluence 缺省回退）、NarrativeConfigSchema `.default()`。

#### `AppConfig`（接口） — `src/config.ts:125-210`
- 用途：全量应用配置类型：api/generation/text_buffer/assets/prefetch/input/interaction/dsl(1|2)/narrative/debug/media.audio/app/narrative/local_web/game。C7 注释：旧 `characters` 段已移除，携带即报错。
- 调用方：全仓 24 个非测试文件 import config.js（粗 grep 计数）。

#### `loadAuthorConfig(authorConfigPath)` — `src/config.ts:597-614`
- 用途：读可选 author.yaml；文件不存在（ENOENT）或空 YAML → DEFAULT_AUTHOR_CONFIG 拷贝；其余错误上抛。

#### `loadConfig(configPath)` — `src/config.ts:620-638`
- 用途：读 yaml → parse → **手工 C7 守卫**（parsed 顶层含 `characters` 键 → 显式 throw，中文错误说明）→ `ConfigSchema.parse` → AppConfig。
- 调用方：cli.ts:54、web.ts:54、create-runtime-application.ts:359、config.test.ts。

#### `loadApiKey(config)` — `src/config.ts:640-648`
- 用途：按 `config.api.api_key_env` 读环境变量；未设置抛中文错误（提示复制 .env.example）。
- 调用方：create-runtime-application.ts:370、cli.ts:66、web.ts:74/165。

**内部辅助**：`RefinementContext`（superRefine context 的最小形状类型）；12 个模块级 zod schema——`AudioPlannerConfigSchema`(L217)/`AudioPlaybackConfigSchema`(L224)/`AudioSynthesisConfigSchema`(L240)/`AudioCacheConfigSchema`(L258)/`AudioConfigSchema`(L303)/`InteractionPolicyConfigSchema`(L316，superRefine 两项跨字段规则)/`NarrativeConfigSchema`(L361，superRefine consolidation 批次规则)/`ConfigSchema`(L435，顶层 13 节)/`ControlSectionSchema`(L553)/`RulesConfigSchema`(L561)/`AuthorConfigSchema`(L567)；`DEFAULT_AUTHOR_CONFIG`(L578)。

### src/config/public-web-config.ts

#### `toPublicWebConfig(config)` — `src/config/public-web-config.ts:11-41`
- 用途：AppConfig → 浏览器安全的 PublicWebConfig（audio.playback/cache 每字段 `?? DEFAULT_PUBLIC_WEB_CONFIG` 回退、format 固定 pcm_s16le/1ch/16bit、game.show_line_ids）。文件头声明依赖方向约束：builder import wire 类型，wire 永不 import Node config；本文件 Node-only。
- 调用方：local-web-host.ts:137。

### src/schema.ts

（事件模型聚合模块：从 story/types.ts 与 core/presentation/types.ts 再导出 + 本地定义运行时/存储事件类型。）

#### 再导出（12 符号） — `src/schema.ts:12-28`
- type：InteractionEvent/ChoiceInteraction/InputInteraction/HybridInteraction/LinePerformance/StageCue；schema：PortraitSchema/DialogueDraftEventSchema/CharacterDialogueEventSchema/NarrationDraftEventSchema/LinePerformanceSchema/InteractionEventSchema。

#### `Portrait` — `:29-33`；#### `DialogueDraftEvent` — `:40-46`；#### `NarrationDraftEvent` — `:48-52`
- 用途：legacy 宽松事件形状（C2 起 frozen，仅兼容边界）。

#### `CharacterDialogueEvent` — `src/schema.ts:60-68`
- 用途：C2 严格新格式对白（characterId+displayLabel 必填，不允许 optional 兼容旧载荷）。

#### `RuntimeCharacterDialogueEvent` — `:71-74`；#### `ChoiceOption` — `:76-79`；#### `ChoiceEvent` — `:86-90`；#### `EndEvent` — `:96-100`
- 用途：运行时形态（附 line_id/stage）；运行时合成分支终点/结局终点（模型从不产出）。

#### `RuntimeDialogueEvent` — `:102-117`；#### `RuntimeNarrationEvent` — `:118-122`
- 用途：可播放事件的运行时形态（附 line_id、可选 characterId/displayLabel/stage）。

#### `PlayerDialogueEvent` — `:129-137`
- 用途：玩家输入确认时运行时合成的台词（source:"player"，模型从不产出）。

#### `RuntimePlayableEvent` — `:139-142`；#### `RuntimeBeatEvent` — `:150-155`；#### `RuntimeModelEvent` — `:157-161`；#### `RuntimeBufferEvent` — `:164`
- 用途：播放/模型流/缓冲区事件联合类型（beat 为 @beat 组播放时间线影子）。

#### `StoredEventBase` — `:166-171`；#### `StoredModelEvent` — `:173`；#### `StoredPlayerChoiceEvent` — `:175-179`；#### `StoredPlayerInputEvent` — `:181-185`；#### `StoredPlayerDialogueEvent` — `:187`；#### `StoredEvent` — `:189-193`
- 用途：会话落盘事件形状（seq/turn/timestamp/source 装饰）。

#### `StoryContextEvent` — `:195-208`
- 用途：进入模型上下文的事件超集（Stored 或 Runtime 形态）。

#### `isPlayableEvent(event)` — `src/schema.ts:210-214`
- 用途：类型守卫——dialogue/narration 为可播放。
- 调用方：全仓多处（schema.test.ts 覆盖 4 it）。

- 备注：schema.ts 被 30+ 非测试文件 import（game/adapters/application/core/runtime/interaction/apps-cli 等），是事实上的事件类型枢纽。

### src/shared/wire/schemas.ts

#### `NewFormatDialogueEventSchema` — `src/shared/wire/schemas.ts:23`
- 用途：= CharacterDialogueEventSchema 别名（新格式对白跨 wire 的唯一校验入口，strict 拒绝混写旧 speaker）。

#### `WIRE_PROTOCOL_VERSION` — `src/shared/wire/schemas.ts:33`
- 用途：wire 协议版本常量 = 4（C7=2 稳定 speakerId → 动态音乐=3 → 主题制配乐 V2=4 加 themeId）。两端共享；不匹配客户端收 4002 close。
- 调用方：runtime-websocket.ts:21（闸门）、web 侧（@shared alias import）。

#### `STALE_WIRE_CLOSE_CODE` — `src/shared/wire/schemas.ts:36`
- 用途：4002（沿用 4001 controller-limit 的拒绝模式）。

#### `AudioScopeSchema` — `:46-50`；#### `AudioDescriptorSchema` — `:52-73`
- 用途：音频范围/描述符 zod schema。speakerId 用 `SpeakerIdSchema`（稳定 ID 正则，拒绝显示名冒充）；displaySpeaker 用 `CharacterLabelSchema`（Unicode 名牌规则）。

#### `AudioFetchRequestSchema` — `:75-79`
- 用途：浏览器唯一可提交的 TTS 请求形状（taskId/lineId/cacheKey）。
- 调用方：audio-stream-route.ts:15。

#### `RuntimeCommandSchema` — `:82-109`
- 用途：运行时命令判别联合 zod（start/advance/select_choice/preview_input/confirm_input/cancel_input/shutdown/restart_session/retrace）。

#### `ClientMessageSchema` — `:111-141`
- 用途：浏览器→Node 消息判别联合（runtime.command 带 commandId、audio.cache_report、audio.buffer_report、client.ready 带 capabilities+可选 wireVersion）。
- 调用方：runtime-websocket.ts:230。

#### `ServerMessageSchema` — `:143-190`
- 用途：Node→浏览器消息判别联合（projection.snapshot/runtime.output/audio.*/music.score）。music.score 的 score 用 MusicScoreSchema 整谱校验（与作曲适配器同一 schema 真源）。

**内部辅助**：`SpeakerIdSchema`（字母开头 + `[A-Za-z0-9_-]{0,63}`，CHARACTER_ID_PATTERN refine）。

### src/shared/wire/client-message.ts

#### `AudioFetchRequest`（接口） — `src/shared/wire/client-message.ts:8-12`
- 用途：浏览器唯一可提交的 TTS 请求载荷类型。

#### `ClientMessage`（类型） — `src/shared/wire/client-message.ts:14-42`
- 用途：浏览器发送的全部消息联合（与 ClientMessageSchema 同构；wireVersion 可选注释指向 C7 拒绝语义）。

### src/shared/wire/server-message.ts

#### `ServerMessage`（类型） — `src/shared/wire/server-message.ts:11-49`
- 用途：Node 发送的全部消息联合：projection.snapshot（重连恢复）/runtime.output（带 sequence）/music.score（sceneId/themeId/cacheKey/score）/audio.descriptor/priority_changed/invalidated/task_status。

### src/shared/wire/audio-descriptor.ts

#### `AudioScope` — `:14-17`；#### `AudioPriority` — `:19-24`；#### `AudioFormatDescriptor` — `:26-30`
- 用途：范围（active/candidate/input_preview）、优先级五档、格式描述类型。

#### `AudioDescriptor`（接口） — `src/shared/wire/audio-descriptor.ts:32-42`
- 用途：Node 发布的权威音频身份（浏览器视为不透明数据、绝不重导出 provider 参数；cacheKey 是唯一回显值）。C7 字段语义：speakerId=稳定 CharacterId（身份寻址键），displaySpeaker=名牌快照（展示，改名不影响 cacheKey）。

### src/shared/wire/ui-projection.ts

#### `UiProjection`（接口） — `src/shared/wire/ui-projection.ts:16-42`
- 用途：浏览器重连恢复用的轻量服务端投影形状：sessionId?/phase(idle|running|ended|error)/currentLine?/currentInteraction?/currentPreview?/visualState?（权威舞台状态，§64/§107）/recentLines/status?/ending?。纯数据、type-only import（编译期擦除）。

### src/shared/wire/public-web-config.ts

#### `PublicWebConfig`（接口） — `src/shared/wire/public-web-config.ts:11-35`
- 用途：Node 配置的浏览器安全切片（audio.playback/cache/format + game.show_line_ids）。文件头禁令：禁止加入 API key env 名、voice ID、模型名、原始 instructions、合成 provider 秘密参数。

#### `DEFAULT_PUBLIC_WEB_CONFIG` — `src/shared/wire/public-web-config.ts:42-65`
- 用途：GET /api/config 缺席时的 web 离线缺省 + 构建器逐字段缺省（单一真源，注释自述此前在 web/src/app.ts 与 Node builder 重复）。
- 调用方：config/public-web-config.ts:8/14、web 侧 7 处 import。

### src/shared/tts-log.ts

#### `ttsLog(event, context, detail?)` — `src/shared/tts-log.ts:22-26`
- 用途：`[tts] <event> <context> <k=v>` 结构化日志，覆盖 descriptor build→task queue→provider POST→SSE→HTTP relay 全链（一次 grep 可追踪整会话）。
- 调用方：audio-stream-route.ts、application/audio/{audio-descriptor-factory,tts-task-service}.ts、adapters/tts/{dashscope-cosyvoice,local-qwen3}-provider.ts。
- 备注：`ENABLED` 在 `process.env.VITEST === "true"` 时静默；用 `declare const process` 局部声明保持浏览器安全类型。

### src/application/ui/ui-projection-store.ts

#### `UiProjectionStore`（接口） — `src/application/ui/ui-projection-store.ts:24-32`
- 用途：投影端口——applyOutput(output)/snapshot()/subscribe(listener)。
- 调用方：runtime-application.ts（类型）、create-runtime-application.ts（实现）、runtime-websocket.ts（快照消费）。

#### `UiProjectionStoreImpl` — `src/application/ui/ui-projection-store.ts:53-141`
- 用途：纯由 RuntimeOutput 事件维护的投影（§7.7）。`RECENT_LINES_LIMIT=8`。
- `applyOutput(output)`（L60-129）：不可变更新 switch——session_started→running+sessionId；playback_ready→currentLine+防御性清 currentInteraction/currentPreview+visualState+recentLines 滚动窗口；stage_beat_ready→仅 visualState；interaction_opened→currentInteraction（盖 interaction_id 章供重连寻址）；interaction_resolved→按 id 匹配才清（preview 取消会重开同一交互故不在 preview_opened 清）；input_preview_opened/canceled/committed→currentPreview 生命周期；status_changed→status；session_ended→ending+ended；runtime_error→error。每次更新后通知 listeners。
- `snapshot()`（L131-133）：返回当前不可变快照。
- `subscribe(listener)`（L135-140）：Set 退订闭包。

**内部辅助**：`interactionIdOf(value)`（从投影交互读归一化 interaction_id，无则 null）。

## 4. 域内数据流

进程启动 → 配置 → 装配 → HTTP/WS 就绪（以 web.ts 为主线）：

1. **入口**：`web.ts main()`（web.ts:52）→ `parseArgs` → `loadConfig(configPath)`（config.ts:620；yaml→C7 守卫→ConfigSchema zod 缺省/校验）。
2. **世界身份**：`resolveExplicitGameId(game, process.env)`（last-game.ts:45）→ 缺省回退 `readLastGameId("games")`（last-game.ts:21）。
3. **装配**：`createRuntimeApplication({config, configPath, gameId})`（create-runtime-application.ts:355）——内部依次 `loadAuthorConfig`/`CanonStore.load`/`loadVoices`/`loadApiKey`/`loadAssetCatalog`/registry 三分支/`loadPrompts`/`selectTtsProvider`/`buildVoiceViews`/`buildAudioStack`/`buildDirectorService`/`SceneMusicService`/`buildGraphCoordinator`/`buildCanonPromoter`/`buildGameFor`→`Game`/`watchGame`，返回 `RuntimeApplication`。随后 `writeLastGameId`（last-game.ts:30）。
4. **宿主构造**：`new LocalWebHost({config, app, dev, worlds, graph, reviews})`（local-web-host.ts:128）——`randomBytes` 生成 token → `toPublicWebConfig`（config/public-web-config.ts:11）→ `new RuntimeWebSocket({...token, startGame: () => this.startGame()})` + `new AudioStreamRoute({ttsTasks, catalog, token})`。
5. **HTTP/WS 就绪**：`host.start()`（local-web-host.ts:182）——http.createServer + WebSocketServer(noServer) + `/ws/runtime` upgrade 路由 → listen 127.0.0.1 → `openBrowser(tokenUrl)`（open-browser.ts:10）。
6. **首个连接启动游戏**：浏览器 Start 点击开 WS → `RuntimeWebSocket.handle`（runtime-websocket.ts:121）鉴权通过且为第 0 个 controller → `deps.startGame()` → `LocalWebHost.startGame`（local-web-host.ts:246，gameStarted 防重入）→ `app.game.run()`。
7. **运行期下行**：game 输出 → `watchGame` 中 `projection.applyOutput`（ui-projection-store.ts:60）+ `RuntimeWebSocket` 每 controller 以递增 sequence 下发 `runtime.output`；catalog 事件/TTS 状态/谱面事件并行订阅下发。
8. **运行期上行**：浏览器 `client.ready`（wireVersion 闸门）→ `runtime.command`（commandId 去重）→ `game.dispatch`；音频走独立 HTTP：`POST /api/audio/synthesize` → `AudioStreamRoute.handle` → `catalog.validateFetchRequest` → `ttsTasks.synthesize` → PCM chunk 流。
9. **会话终结/重启**：`session_ended` → WS 关闭全部 controller + 后台 `canonPromoter.promoteFromRuns`；`restart_session` 命令 → run 循环抛 `RestartRequestedError` → `handleRestart` → `app.restart()`（原地重建）→ `runtimeWs.rebase`。

CLI 侧（cli.ts:52）在第 3 步后直接 TerminalUI/CliController 驱动 game，无宿主/WS。

## 5. 跨域接口

**装配层向各域注入**（createRuntimeApplication 产出的对象 → 消费域）：

| 注入对象 | 生产处（create-runtime-application.ts） | 消费域 |
|---|---|---|
| StoryGenerator / GeneratorPortFacade | L420-430 | 01 运行时引擎（Game） |
| AudioIntentPlanner / AudioCatalogServiceImpl / TtsTaskServiceImpl / AudioDescriptorFactory | L172-225（buildAudioStack） | 06 音频/TTS |
| RunGraphCoordinator + GameGraphStore + StatsStore + ReviewStore | L259-287 | 05 图/剧情 |
| DirectorService + AgentRunnerAdapter + ConfluenceJudgeAdapter | L294-328 | 05（导演层） |
| SceneMusicService + ComposerAdapter + Theme/SessionStore | L541-546 | 06（动态音乐） |
| NarrativeDirectorService + JsonNarrativeMemoryStore + ConsolidatorAdapter | L579-613（buildGameFor） | 04 叙事记忆 |
| CanonStore + CanonPromoter + OutlineStore/OutlineWriterAdapter | L367/L331-353/L498-505 | 05 canon/大纲 |
| CharacterRegistry（roster/legacy/fallback）+ assetCatalog | L383-410 | 全域（身份真源，C7/C8） |
| UiProjectionStoreImpl + RuntimeStatus + Metrics | L418/L495 | 01/07（状态/投影） |

**宿主层接口**：`RuntimeApplication`（runtime-application.ts:20）是宿主唯一消费面——game/projection/audioCatalog/ttsTasks/四个订阅方法/shutdown/restart/gameId/assetCatalog/characterRegistry。宿主反向注入 entrypoint 的三个通道（worlds/graph/reviews，local-web-host.ts:56-86）由 web.ts 实现为闭包。

**wire 协议的 web 侧共享**：web/src 经 `@shared/wire/*` alias import——public-web-config 7 处、server-message 4 处、audio-descriptor 3 处、ui-projection 2 处、schemas 1 处、client-message 1 处（runtime-client.ts、audio-coordinator.ts、audio-downloader.ts、game-view-model.ts、app.ts、main 等）。Node 侧 runtime-websocket/audio-stream-route 消费同一组 schema/常量做入站校验——两端同源校验是 wire 域的核心约束（schemas.ts 文件头）。

**schema.ts 枢纽**：被 Node 侧 30+ 非测试文件 import（game/adapters/application/core/runtime/interaction/apps-cli）；ui-projection.ts 又 type-only 反向引用 schema.js 的 RuntimePlayableEvent/EndEvent——schema.ts 是事件模型的事实公共依赖。

## 6. 测试覆盖

| 测试文件 | 行数/it 数 | 覆盖的符号/行为 |
|---|---|---|
| src/bootstrap/create-runtime-application.test.ts | 1193 / 20 | createRuntimeApplication：装配完整性（L180）、configPath 重载（L214）、dashscope env 缺失两处启动抛错（L318/338）、DASHSCOPE_TTS_BASE_URL 透传（L358）、端到端会话+run 退出（L385）、shutdown 停 run 循环（L417）、shutdown 落盘叙事/game 快照（L467）、M1 registry 三分支（L568/625/655/697）、retrace（L737）、gameId 显式/生成（L818）、跨启动图世界复用（L850）、NarrativeDirectorService 装配（L980）、叙事落盘（L1042）、restart 原地重建（L1117）、story plan 缺席容忍（L1138） |
| src/hosts/local-web/local-web-host.test.ts | 491 / 26 | LocalWebHost.start/构造：127.0.0.1 绑定与 URL 上报（L152）、token URL 日志（L157）、prod 静态服务 4 项（L174-194）、/api/config（L198）、未知 API 404（L210）、manifest 无 catalog 404（L216）、manifest+/game-assets 服务（L223-）、PCM 端到端（L299）、无 token 拒绝（L313）、WS token+origin 接受（L324）、非 runtime upgrade 销毁（L337）、§15.3 顺序关停（L348）、POST /api/worlds 三项（L358-，创建换绑/400/404）、GET /api/graph（L439-） |
| src/hosts/local-web/runtime-websocket.test.ts | 514 / 28 | RuntimeWebSocket.handle 及私有逻辑：open 快照（L171）、重连快照不含已 resolved 交互（L177）、首连 startGame（L232）、descriptor 回放（L239）、输出转发+序号（L250/301）、notifyError 合成广播（L264）、interaction_resolved 直通（L280）、命令 dispatch/去重/停收（L318/325/335）、非法消息忽略（L343）、4001 限流（L351）、token/origin 拒绝（L360/393/401）、wire 4002 闸门两向（L366/380）、catalog 生命周期转发（L407）、TTS 状态转发（L434）、结局后关闭余下 controller（L452） |
| src/config.test.ts | 922 / 30 | loadConfig/loadAuthorConfig/ConfigSchema：C7 characters 类型级+运行时拒绝（L16/L580）、最小配置全缺省（L54）、全字段解析（L125）、narrative 节缺省/死键剥离/显式覆盖（L260-）、author 缺省/解析/部分/非法/空文件/真实项目文件（L428-）、12 项校验错误（L597-826：model/base_url/temperature/text_bridge/input_bridge/input.kind/interaction 五项）、dsl.protocol_version 三态（L827-） |
| src/schema.test.ts | 529 / 42 | 再导出的 zod schema 与 isPlayableEvent：PortraitSchema 5 it、DialogueDraftEventSchema 7、NarrationDraftEventSchema 2、isPlayableEvent 4、InteractionEventSchema 联合 13（choice/hybrid/input 形状与拒绝）、CharacterDialogueEventSchema 6（C2 严格语义）、DialogueDraftEventSchema legacy 兼容 1 |
| （相邻）src/hosts/local-web/audio-stream-route.test.ts | 264 / 13 | AudioStreamRoute.handle：§8.2 头、401/415/405/400/413/404 两类、错误码映射、cacheKey 并发 409、断连中止上游信号 |
| （相邻）src/hosts/local-web/last-game.test.ts | 118 / 4 describe | read/writeLastGameId、resolveExplicitGameId、isValidGameId |
| （相邻）src/hosts/local-web/origin-guard.test.ts | 52 | isAllowedOrigin 各分支 |
| （相邻）src/shared/wire/schemas.test.ts | 113 / 4 describe | AudioDescriptorSchema 名牌/speakerId 规则、client.ready 版本、NewFormatDialogueEventSchema wire 边界 |

无测试直接覆盖的文件：vite-middleware.ts、open-browser.ts、with-resolvers.d.ts、runtime-application.ts（纯契约）、config/public-web-config.ts（经宿主 /api/config 间接）、tts-log.ts、ui-projection-store.ts（经 bootstrap/WS 测试间接）、public-web-config.ts（wire）。

## 7. 重构关注点（事实清单）

1. `src/bootstrap/create-runtime-application.ts:355-698` — 343 行单函数组合根；`...(x !== undefined ? { x } : {})` 的 exactOptionalPropertyTypes 展开样板在 L267-286/274-285/309-326/341-353/391/516-522/532/564/594-608/621-626 等处出现（grep 实测 22 处）；`new GameGraphStore(gamesRoot, gameId, {identity})` 在同一函数内独立构造 3 次（L267 协调器、L309 导演、L342 晋升器）。
2. `src/config.ts:217-274` — 每个 zod 分节 schema 的默认值书写两遍（`.default(对象)` 字面量 + 每个 `.default(值)`，如 AudioPlannerConfigSchema L217-222）；`DEFAULT_NARRATIVE_CONFIG`（L109）与 NarrativeConfigSchema 内联默认（L361-433）也是两份同一事实。
3. `src/config.ts:627-636` — C7 characters 段拒绝是 zod 之外的手工检查（在 `parse` 与 `ConfigSchema.parse` 之间），config 校验链分散为「手工守卫 + zod 两段」。
4. `src/shared/wire/public-web-config.ts:42-65` 与 `src/config.ts:224-256` — `DEFAULT_PUBLIC_WEB_CONFIG` 的 playback/cache/format 数值（350/500/2500/6500/262144/300/22050）与 AudioPlaybackConfigSchema/AudioSynthesisConfigSchema 的 zod 默认值重复维护；`toPublicWebConfig`（config/public-web-config.ts:18-34）又对 zod 已填默认的字段逐个 `??` 回退（手拼 config 绕过 zod 的场景，见 create-runtime-application.ts:255 注释）。
5. `src/entrypoints/web.ts:137-180` — reviews.submit 闭包是 44 行业务逻辑（图边遍历、ending-report 读取、大纲 act 提取、ReviewAdapter 调用、ReviewStore 落盘）实现在入口装配文件内，而非 application 层。
6. `src/entrypoints/cli.ts:17-50` 与 `src/entrypoints/web.ts:27-50` — 两个入口各自手写近似重复的 parseArgs；`--new-world` 世界生成装配（cli.ts:60-73：loadAssetCatalog+loadCharacterPackRoster+WorldGenerator+OutlineWriterAdapter）与 web.ts:69-78 的 worlds 通道装配重复。
7. `src/entrypoints/web.ts:81-87` 与 `src/bootstrap/create-runtime-application.ts:516-522` — GraphIdentityContext（roster 闭包 + `config.dsl?.protocol_version ?? 1`）在装配根与入口两处独立构造；且 web.ts 的 `graphIdentity` 从**启动时的初始 app** 捕获——POST /api/worlds 换绑后（local-web-host.ts:344 `this.app = app`）图视图/reviews 通道闭包仍引用旧 app 的 registry 上下文（新世界 roster 不会反映到 graphIdentity）。
8. `src/hosts/local-web/local-web-host.ts:431-517` — handleRequest 是 87 行 if 链路由表；graph/settlement/gallery 三个分支重复同一「通道缺省 404 / 成功 200 / 失败 500」模式（L457-495）；与 local-web-host.ts:358 readJsonBody、audio-stream-route.ts:168 readBody 是两套相似但防护不同的请求体读取实现。
9. `src/bootstrap/create-runtime-application.ts:107` — `DEFAULT_GAMES_ROOT` 常量从组合根导出、被宿主（local-web-host.ts:28）与入口（web.ts）反向消费；宿主为拿一个常量依赖 bootstrap 模块（模块加载即触发其全部顶层 import，虽然都是类型/类声明）。
10. `src/hosts/local-web/local-web-host.ts:379-385` — `hasWorld()` 用 `process.cwd()` + `DEFAULT_GAMES_ROOT` + `outline.json` 文件名三个隐式约定探测「已有世界」，与 last-game.ts 的 gamesRoot 约定、装配层的 WORLD_PROMPTS_DIR 等磁盘布局知识分散三处。
11. `src/schema.ts:1-28` — 该文件一半是再导出（story/types.ts / core/presentation/types.ts），30+ 文件经它 import 事件类型；枢纽位置使 story/types 的任何改动波及全域编译。
12. `src/hosts/local-web/test-fakes.ts:5` — 生产目录中的测试支撑文件（顶层 `import { vi } from "vitest"`），生产代码若误 import 将在运行时崩溃；仅靠约定隔离。
13. `src/hosts/local-web/with-resolvers.d.ts:1-9` — ES2022 lib 缺 ES2024.Promise 的本地 ambient 补丁（文件自述为权宜）；tsconfig 升 lib 后应删除。
14. `src/hosts/local-web/runtime-websocket.ts:121-141` 与 `src/hosts/local-web/audio-stream-route.ts:97-101` — 同一 Local Session Token 在 WS 走 URL query、HTTP 走 `x-session-token` 头（§8.3 设计如此），但 token 比对逻辑分散在两处且无共享测试夹具。

## 8. 建议层级定位

- **ui-projection-store 归属**：`UiProjectionStoreImpl`（application/ui/ui-projection-store.ts:53）依赖 `core/runtime/runtime-output`（01 域）并维护有行为状态机，不宜下沉 shared（数据形状 `UiProjection` 已在 shared/wire）；它是 RuntimeApplication 的读模型组件，装配根与 WS 宿主各自消费其接口——维持 application 层，`UiProjectionStore` 接口可随重构移入 core/ports 与其他端口对齐，不并入宿主域。
- **本域分层**：L0 = `src/shared/wire/*` + `src/shared/tts-log.ts`（纯数据/zod/日志，Node 与浏览器双端可 import，无 Node 专属 import；tts-log 以 declare process 保持浏览器安全类型）；L4 = hosts/entrypoints/bootstrap/config/schema（进程边界与装配）。两点细化：① `src/schema.ts` 虽在 src 根，实际是事件类型枢纽（被 30+ 文件引用、一半内容再导出 story/types），宜标注为「L0.5 类型聚合」或并入 wire 相邻的共享类型层，而非随宿主域走；② `src/config.ts` 同时承担「类型 + zod + 加载器」三职且被全域 import，属独立的配置层（L4 之内）而非宿主子模块——`src/config/public-web-config.ts` 是 config→wire 的单向桥，方向约束已在文件头固定。

## 附A · 设计评注（观察与可能方向，非约束）

1. **三个配置开关**：
   - `debug.runtime_status`（config.ts:183-186，cli.ts:82 与 `--debug-runtime` 或合）——不带 CLI 参数也能持久打开运行时状态面板，功能完整。
   - `input.show_generation_status`（config.ts:166-167，terminal-ui.ts:104 与 debug mode 双重门控）——两面旗帜管一件事；合为一面时"默认不显示"的行为不变。
   - `app.default_host`（config.ts:192，zod 默认 "web"，全仓无消费者）——现状是死键。
2. **wire 版本闸门时序**（runtime-websocket.ts）：现状快照 setImmediate 先下发、`client.ready` 才验版本——旧客户端白收一份完整快照再被 close(4002)。连接时先验版本是另一种形态；runtime-websocket.test.ts:366/380 断言现序，改动与测试同批。
3. **快照异步下发时机**：快照在连接后异步（setImmediate）而非握手内同步——前端 BOOTSTRAP 态的容忍依赖这个时序，两端契约，改动需两端同批。
