# 玩家前端域（音频播放·本地存储）

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：15 文件 / 6120 行（生产代码，不含测试；其中 demo-scores.ts 3929 行为纯数据资产，扣除后实质逻辑 2191 行）
> 快照：D:/coding/lgp-main-atlas（只读）。行号均为快照实际 Read 所得。

## 1. 域职责与边界

本域是 L5 玩家前端 `web/` 内部的**音频与持久化子系统**，在 app 域（`web/src/app.ts` 的 GameApp）之下提供四类原语：

- **语音播放调度**（`AudioCoordinator` + `AudioTimeline` + `pcm-worklet.js`）：全部台词共享一个 `AudioContext` + 一个 `AudioWorkletNode`；负责 startup buffer 门槛、voice_delay 挂起、跳行/弃行清理、EOF+drained 双条件收尾（§9.3/§10.3/§10.4/§10.6）。
- **PCM 流解码与下载**（`AudioDownloader` + `PcmDecoder`）：POST `/api/audio/synthesize` 流式拉取 pcm_s16le，边解码喂播放、边把原始字节 fire-and-forget 写缓存（PCM 永不走 WebSocket，§22 invariant 12/13）；按 cacheKey 跨实例去重（§12.4）。
- **IndexedDB 音频缓存**（`AudioDb`/`AudioCacheWriter`/`AudioCacheReader`/`AudioCacheCleaner`）：三 store 结构、批量写、两阶段 complete、LRU/TTL 回收；纯性能缓存，删库只损失重合成（§11.3–§11.7，§22 invariant 14）。
- **玩家偏好持久化**（`player-settings.ts`）：localStorage 的音量/静音/字速，fail-open。

另含**BGM 生成渲染支线**（`music-renderer.ts`/`generated-bgm.ts`/`demo-scores.ts`）：WS `music.score` 谱面 → 确定性离线渲染 → WAV blob URL → `BgmController.applyGenerated`，与语音通道完全独立。

**边界**：本域只提供原语；「哪些行要音频、何时下载、何时推进剧情」的编排状态机（reconcile/ensureAudio/feedFromCache/task_status 终态收敛）在 app 域 `web/src/app.ts`。本域不 import app 域任何模块；唯一反向依赖是 `generated-bgm.ts` 对 `stage/bgm-controller.ts` 的类型引用与运行时调用。

## 2. 模块清单

| 文件（相对 web/src/） | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| audio/audio-coordinator.ts | 410 | 语音播放策略（调度/门控/EOF 收尾/增益/降级） | 4 | audio-coordinator.test.ts |
| audio/audio-downloader.ts | 202 | TTS HTTP 流式下载+解码分发+去重 | 2（+1 static） | 无专测；经 app.test.ts 覆盖 |
| audio/music-renderer.ts | 405 | 符号谱→无缝循环 AudioBuffer 离线渲染 | 14 | music-renderer.test.ts |
| audio/audio-timeline.ts | 128 | 跨行播放时间线与连续缓冲计量 | 2 | audio-timeline.test.ts |
| audio/pcm-decoder.ts | 64 | pcm_s16le 字节块→Int16Array（跨块奇字节） | 1 | pcm-decoder.test.ts |
| audio/generated-bgm.ts | 58 | WS 谱面→渲染→blob URL→applyGenerated 编排 | 2 | generated-bgm.test.ts |
| audio/demo-scores.ts | 3929 | 【数据资产】试听基线谱面 fixture | 2 | 无（经 music-demo 页消费） |
| audio/pcm-worklet.d.ts | 33 | 纯 JS worklet 的 TS 声明 | 1 | pcm-worklet.test.ts |
| audio/worklet-env.d.ts | 39 | worklet 作用域 ambient 类型 + `*.js?raw` 模块声明 | 0（ambient） | — |
| storage/audio-db.ts | 279 | IndexedDB 封装（三 store，无 IDB 时全 no-op） | 4 | audio-db.test.ts |
| storage/audio-cache-writer.ts | 250 | 批量写缓存 + 两阶段 complete | 3 | audio-cache-writer.test.ts |
| storage/audio-cache-cleaner.ts | 112 | TTL + 会话保护 + LRU 回收 | 3 | audio-cache-cleaner.test.ts |
| storage/audio-cache-reader.ts | 63 | 命中查询 + 分批增量读块 | 2 | audio-cache-reader.test.ts |
| storage/player-settings.ts | 89 | localStorage 玩家偏好（fail-open） | 6 | player-settings.test.ts |
| storage/test-utils.ts | 59 | 【测试基建随生产树】fake-indexeddb 复位/记录工厂 | 3 | 被 4 个 storage 测试 import |

相邻清单外文件：`audio/pcm-worklet.js`（183 行，纯 JS 的 `PcmWorkletProcessor`，由 audio-coordinator.ts:19 以 `?raw` 导入并在浏览器内以 blob URL 注册；pcm-worklet.test.ts 直测）——类型由 pcm-worklet.d.ts 手工镜像。

## 3. 函数级明细

### 3.1 audio/audio-coordinator.ts

#### `interface AudioCoordinatorOptions` — `audio/audio-coordinator.ts:21-25`
{ context: AudioContext; playbackConfig: PublicWebConfig["audio"]["playback"]; format: PublicWebConfig["audio"]["format"] }。context 由调用方（main.ts Start 手势）创建，本类从不重建。

#### `type PlaybackMode` — `audio/audio-coordinator.ts:27`
`"manual" | "auto"`。跨域消费者：`web/src/ui/controls.ts:8`（仅 type import）。

#### `interface AudioCoordinatorEvents` — `audio/audio-coordinator.ts:29-33`
onLinePlaybackStarted / onLinePlaybackFinished / onUnderrun 三个回调。app.ts:737-776 实现三回调（auto 推进与 underrun 计数）。

#### `class AudioCoordinator` — `audio/audio-coordinator.ts:35-410`

公开方法逐条：

- **`init(): Promise<void>`**（L74-130）— 加载 worklet 模块并创建唯一播放节点。步骤：
  1. 已有 `workletNode` 则幂等返回（L75-77）。
  2. 能力检测（§10.5）：`createAudioWorkletNode` 工厂与全局 `AudioWorkletNode` 都不存在、或 `audioWorklet === undefined` → 直接 return，`workletNode` 保持 null（此后 `available === false`，app 侧降级 text-only）；注释明确 addModule 抛错不属于此分支、必须上抛（L78-92）。
  3. Vite 8 会把 `?url` 内联成 data: URL 而 addModule 拒收 → 用 `?raw` 源码建 Blob URL（L93-98）。
  4. `addModule` 后创建 numberOfOutputs=1、单声道、`processorOptions.sourceRate` 的节点；兼容旧 webview 的 context 工厂（L100-110）。
  5. 建 GainNode（当前 volume/muted 立即生效）→ destination；`port.onmessage` 接 handleWorkletMessage（L111-117）。
  6. 若 init 前已 start 且有当前行（样本此前无法投喂），`flushPending` 补交（L120-124）。
  7. `finally` 中 `revokeObjectURL` 防 blob 泄漏（L125-129）。
- **`feedPcm(lineId, samples)`**（L133-153）— 投喂解码样本。步骤：①`timeline.queueSamples` 计入连续缓冲账；②块压入 `pendingByLine`；③非当前行直接 return（未来行缓冲）；④当前行累加 `fedForCurrentLine`；⑤未开播时 `startupSamples` 达 `startupThresholdSamples()`（startup_buffer_ms 换算，L376-378）→ `armPlaybackStart()`；⑥已开播则 `flushPending` 即时转 worklet。调用方：app.ts:549（downloader onPcm）、app.ts:661/664（feedFromCache）。
- **`notifyLineEof(lineId)`**（L160-185）— 生产者 EOF 门控（§10.6）。步骤：①非当前行 → 记入 `producerEof` 集合后返回（switchToLine 日后 consult）；②未开播且（该行 pending 为 0 或无 worklet）→ `finishLine` 直接收尾（空流/降级环境）；③未开播有可播内容 → 记 EOF 后 `armPlaybackStart()`（**EOF 越过 startup 门槛**）；④已开播但无 worklet → `finishLine`（降级环境永远等不到 drained）；⑤已开播且有 worklet → 仅记录，收尾交给 drained 消息。调用方：app.ts:223（downloader onEof 转发）、app.ts:668（缓存喂完）。
- **`enqueueLine(lineId, cacheKey, pauseBeforeMs, pauseAfterMs)`**（L187-189）— 追加时间线 segment。调用方：app.ts:559（恒传 0,0——pause 由 app 侧自己管）。
- **`start(lineId)` / `skip(lineId)`**（L192-199）— 同为 `switchToLine` 别名。调用方：app.ts:477（priority 变更时 start）。
- **`stop()`**（L202-212）— 静默停播：取消 startTimer、worklet `clear`、清当前行 EOF 标记与全部计数；不触发 finished。调用方：app.ts:197/254/273/318/424/438。
- **`dropLine(lineId)`**（L219-231）— §12.5 失效：当前行则先静默停播；`producerEof`/timeline segment/未投喂 pending 全清（死音频不得继续占用 bufferedAheadMs）。调用方：app.ts:490。
- **`setMode(mode)`**（L233-235）— 调用方：app.ts:356。备注：mode 在本类内只被存储、从不读取——auto/manual 的行为差异全在 app 侧事件处理。
- **`get available`**（L238-240）— `workletNode !== null`；app.ts:203 用它判定降级。
- **`setVolume(v)` / `setMuted(m)`**（L242-250）— 钳 0..1 后 `applyGain`。调用方：app.ts:208/209/362/374。
- **`bufferedAheadMs()`**（L252-254）— 委托 `timeline.contiguousBufferedMs()`。调用方：app.ts:294/590/678/822（低水位调度与 UI 上报）。
- **`isPlaying()`**（L256-260）— `(playbackStarted || startTimer !== null) && currentLineId !== null`；voice_delay 挂起窗口也算在播（场景切换/选择必须能掐掉待启定时器）。调用方：app.ts:723/760（reading/pause 定时器触发前的双检）。

私有方法：

- **`switchToLine(lineId)`**（L262-298）— 跳转核心。步骤：①timeline 无该 segment → no-op；②目标即当前行且在播 → no-op（避免行中重播丢音频）；③`cancelStartTimer` + worklet `clear`；④重置 currentLineId/playbackStarted/startupSamples/fedForCurrentLine；⑤`timeline.skipTo` 丢弃更早行；⑥把被 skip 移除的行的 pendingByLine 一并删掉；⑦用该行已有 pending 恢复两个计数；⑧`producerEof` 命中：无样本或无 worklet → finishLine，否则 `armPlaybackStart`（EOF 越门槛）；⑨否则 pending ≥ startup 阈值才 arm。
- **`armPlaybackStart()`**（L300-317）— voice_delay_ms 挂起：幂等守卫（已在播或已在倒计时则 return）→ delay ≤0 立即 `beginPlayback`，否则 setTimeout 倒计时。
- **`beginPlayback()`**（L319-330）— 置 playbackStarted、记 playbackStartMs、`flushPending` 首批投喂、`context.resume()`（autoplay 策略可能拒绝，UI 在手势内 resume，catch 吞掉）、触发 `onLinePlaybackStarted`。
- **`cancelStartTimer()`**（L332-337）；**`finishLine(lineId)`**（L339-349，非当前行守卫→清状态+删 EOF→`onLinePlaybackFinished`）；**`flushPending(lineId)`**（L351-362，先发 `{type:"line",lineId}` 标记再逐块 postMessage，块发完即从 pendingByLine 删除；无 worklet 时保留排队）；**`linePendingCount`**（L364-374）；**`startupThresholdSamples()`**（L376-378）；**`postWorkletMessage`**（L380-382）；**`handleWorkletMessage(event)`**（L384-403：`underrun`→onUnderrun；`drained`→仅当 lineId 为当前行**且 producerEof 含它**才 finishLine——EOF 门控）；**`applyGain()`**（L405-409）。

内部辅助：`pendingByLine`（每行未投喂块）/`producerEof`（EOF 行集合）/`startTimer`（voice_delay 定时器）三个状态容器 + 上述私有方法。

### 3.2 audio/audio-downloader.ts

#### `interface AudioDownloaderOptions` — `audio/audio-downloader.ts:18-40`
token（X-Session-Token）、writer、decoder（实例或工厂——并发流不得共享一个 PcmDecoder 的 pending 奇字节，§10.2）、onPcm、onEof、fetchImpl（测试缝，默认 `globalThis.fetch`）。

#### `class AudioDownloader` — `audio/audio-downloader.ts:53-202`

- **`static hasInFlight(cacheKey)`**（L63-65）— 查询静态 inFlight 表。**全仓无调用方**（Grep 仅命中定义处；测试也未用）——疑似遗留导出。
- **`download(descriptor, signal, taskId?)`**（L80-121）— 步骤：
  1. 按 cacheKey 查静态 `inFlight` Map（L55，**跨实例共享**）；无槽则新建：工厂建独立 decoder、新 AbortController、`lineIds = new Set([lineId])`。
  2. 启动 `run(slot.lineIds, ...)` 并把 promise 存槽；settle（成功/失败两分支）后删槽，避免 unhandled rejection（L108-115）。
  3. 已有槽：`slot.lineIds.add(lineId)`——中途加入的消费者拿到剩余 PCM 与 EOF（每行是独立时间线 segment 却要同一音频）。
  4. `wireSignal`：任一消费者 abort → 共享 controller.abort()（§12.5）；settle 后 removeEventListener 防陈旧 signal 误伤后续 fetch。
  5. 返回共享 promise。
  调用方：app.ts:633（startDownload）。taskId 由 app 生成（app.ts:628），POST 体与状态跟踪共用一个 id。
- **`private wireSignal(signal, slot)`**（L124-139）— 见上。
- **`private run(...)`**（L141-201）— 步骤：①`writer.startAsset` 先行（无会话时 append 静默丢块）；②POST `/api/audio/synthesize`（SYNTHESIZE_PATH L42，X-Session-Token 头，体 `{taskId,lineId,cacheKey}`）；③`!response.ok` 抛错；④`body.getReader()` 循环：每非空块 → `writer.append(cacheKey, value)`（fire-and-forget 缓存）+ `decoder.push(value)` 解码 → `feed` 分发给 lineIds 里**每个**消费者的 onPcm；⑤流尽 `feed(decoder.flush())`；⑥`finally` 对每个消费者 `onEof`（成功/HTTP 错/读错误/abort 一视同仁——部分行也走 EOF+drain 收尾）。

内部辅助：`InFlightSlot` 接口（L45-51，promise/controller/lineIds）、静态 `inFlight` Map。

### 3.3 audio/music-renderer.ts

常量：`MUSIC_RENDER_SAMPLE_RATE = 44100`（L29）、`MUSIC_REVERB_SECONDS = 2.2`（L31）、`MUSIC_LOUDNESS_TARGET_DB = -16`（L357）、`MUSIC_LOUDNESS_PEAK_DB = -1`（L358）；私有调音表 PACK_PATH/INSTRUMENT_GAIN/INSTRUMENT_PAN/REVERB_SEND/SUSTAINED（L46-109）。

#### `loopSeconds(score)` — `music-renderer.ts:111-113`
循环体秒数 = scoreLoopBeats×60/bpm。调用方：render（L249）、music-demo.ts。
#### `tailSamples(sampleRate)` — `music-renderer.ts:114-116`
RT60 尾区样本数。调用方：render（L254）、music-renderer.test.ts。
#### `beatSeconds(score, beat)` — `music-renderer.ts:118-120`
拍→秒。调用方：render 内音符调度（L301-302）。
#### `nearestSampleMidi(keys, target)` — `music-renderer.ts:123-134`
包内最近 MIDI 键（线性扫描）。
#### `audioBufferToWavBlob(buffer)` — `music-renderer.ts:170-201`
AudioBuffer→PCM16 WAV Blob（44 字节标准头 + 交织声道、钳 ±1）。调用方：generated-bgm.ts:49、music-demo.ts:71。
#### `class SoundfontStore` — `music-renderer.ts:207-233`
按乐器懒加载 gleitz JSON 包（`/game-assets/audio/soundfonts/{pack}.json`，L220）→ 逐音符 fetch(data-URI) → `decodeAudioData`；会话内 `packs` Map 缓存；fetchImpl 构造注入且绑死接收者（L214 注释：裸存全局 fetch 会 Illegal invocation）。
#### `interface MusicRenderer` — `music-renderer.ts:236-238`
`render(score): Promise<AudioBuffer>`——app 侧注入缝（main.ts:76、generated-bgm 构造参数）。
#### `class SoundfontMusicRenderer implements MusicRenderer` — `music-renderer.ts:240-333`
- **`render(score)`**（L247-332）步骤：①loopN=循环体样本、tailN=RT60 尾样，OfflineAudioContext(2, loopN+tailN, 44100)；②总线 DynamicsCompressor(-18dB/2.5:1/10ms/250ms) + makeup 1.25；③Convolver（程序 IR）+ wetTrim 0.35；④每轨：store.samples 取包 → trackGain→highpass(40Hz)→StereoPanner(固定声像)→[dry 全量 + 湿按 REVERB_SEND]；⑤每音符 nearestSampleMidi + `playbackRate = 2^((midi-sampleMidi)/12)` 微移；SUSTAINED 类 loop 采样（跳过起音段）+ 0.12s 起音/0.3s 释放，打击类 4ms 起音/60ms 截尾；⑥`startRendering` → `foldTailIntoLoop` → `normalizeLoudness` → `wrapLoopBuffer`。已知截断（L252-253 注释）：dur≤8 拍长音超出 2.2s 尾区的部分被丢，循环点可能轻微突断；修法须随渲染版本号（src/application/audio/music-cache-key.ts）一起。
#### `foldTailIntoLoop(rendered, loopN)` — `music-renderer.ts:340-354`
纯函数：尾区样本叠回循环头对应位置，输出通道数组（V2 起不做峰值护栏）。
#### `normalizeLoudness(channels, opts?)` — `music-renderer.ts:365-394`
纯函数：全通道联合 RMS 归一 -16 dBFS，增益同时被 -1 dBFS 峰值钳制；RMS=0/空输入不动。

内部辅助：`makeImpulseResponse`（L137-167，指数衰减+一阶低通 damping+双声道去相关白噪 IR）、`wrapLoopBuffer`（L397-405，通道数组→定长 AudioBuffer）。

### 3.4 audio/audio-timeline.ts

#### `interface TimelineSegment` — `audio/timeline.ts:9-14`
{ lineId, cacheKey, pauseBeforeMs, pauseAfterMs }。
#### `class AudioTimeline` — `audio-timeline.ts:21-128`
- `append(segment)`（L28-33）：幂等（每行恰好一个 segment）。
- `queueSamples(lineId, count)`（L36-41）：行已入线才记账。
- `currentLineId()`（L43-46）；`hasSegment(lineId)`（L48-50）；`pauseAfterMsFor(lineId)`（L52-54）。
- **`contiguousBufferedMs()`**（L61-87）：从播放头起累加 queued 样本时长 + 行间 pause 间隙，遇首个 0 样本行（缓冲洞）截断；播放头行无样本直接 0。驱动 app 低水位调度（§10.3）。
- `skipTo(lineId)`（L90-97）：splice 前缀，目标成为currentIndex=0。
- `remove(lineId)`（L103-118）：删行并修正播放头（删头行则指向后继或 -1）。
- `clear()`（L120-123）。

内部辅助：`TimelineEntry`（segment+queuedSamples，L16-19）、`find`（L125-127，线性查找）。

### 3.5 audio/pcm-decoder.ts

#### `class PcmDecoder` — `audio/pcm-decoder.ts:9-58`
- **`push(chunk: Uint8Array): Int16Array`**（L13-41）：跨块奇字节处理——`pendingByte` 作为下一样本低字节与本块首字节（高字节）拼合；奇长块末字节留存。
- **`flush()`**（L44-52）：残留单字节按高字节 0 合成 1 样本。
- **`reset()`**（L55-57）：丢弃 pending 字节。

内部辅助：`littleEndianSample(lo, hi)`（L61-64）。调用方：audio-downloader.ts:84/189/192（每下载流一个新实例）；app.ts:221（工厂）、app.ts:656-663（feedFromCache 每 cacheKey 一个实例）。

### 3.6 audio/generated-bgm.ts

#### `interface MusicScoreMessage` — `generated-bgm.ts:15-21`
{ sceneId, themeId, cacheKey, score }（WS `music.score` 载荷投影）。
#### `class GeneratedBgm` — `generated-bgm.ts:23-58`
- **`handleScore(message)`**（L39-57）步骤：①`latestKey` 记最新意图；②串行 promise 链（`rendering` 字段）排队渲染；③排队期间被更新 key 取代 → 丢弃；④同 key 重放（重连回放）→ 幂等 no-op；⑤`renderer.render` → `audioBufferToWavBlob` → createObjectURL → revoke 旧 URL（内存峰值恒单曲）→ `bgm.applyGenerated(url)`；⑥catch 只 console.warn——配乐永不阻塞演出。构造注入 createObjectUrl/revokeObjectUrl（测试缝）。
调用方：app.ts:406（`options.music?.handleScore`，music 是 GameAppOptions 的注入缝 L58）；装配在 main.ts:76 `new GeneratedBgm(bgmController, new SoundfontMusicRenderer())`。

### 3.7 audio/demo-scores.ts（数据资产）

- 导出形态：`interface DemoScore`（L10-14：label/direction/score）与 `const DEMO_SCORES: DemoScore[]`（L16-3929）。
- 规模：**6 个条目**（label 起始行 L18「紧张·强度2」、L1309「悲伤·强度1」、L1718「温暖·强度1」、L2217「高潮·强度3」、L3196「悲伤·强度1·稀疏五声」、L3461「希望·强度2·dorian 竖琴」），单条目数百至上千行内联 MusicScore JSON；来源注释（L1-7）为 2026-10-16/17 真实 glm-5.3-flash 作曲产物（scripts/probe-music-composer.ts --save 采集），用作渲染器 A/B 听感基线。
- 消费者：仅 `web/src/music-demo.ts:14`（配乐试听页 /music-demo.html）。主游戏链路不引用。

### 3.8 audio/pcm-worklet.d.ts / worklet-env.d.ts（声明文件）

#### `declare class PcmWorkletProcessor` — `pcm-worklet.d.ts:13-33`
为 `pcm-worklet.js`（纯 JS，AudioWorklet 模块只能以 JS 发布——Vite 会丢弃 `.ts?url` 资产）手工镜像的声明：parameterDescriptors/chunks/headChunk/headOffset/queued/phase/sourceRate/outputRate + handlePortMessage/process/enqueue/sampleAt/consume/resetRing。消费方：pcm-worklet.test.ts（Node 直测 JS 类）。
#### `worklet-env.d.ts`（L1-39）
ambient 声明：`declare module "*.js?raw"`（L10-13，audio-coordinator.ts:19 的 raw 导入依赖它）、`AudioWorkletProcessor` 接口与构造器 var（L15-31）、`registerProcessor`（L33-38）。无运行时代码。

### 3.9 storage/audio-db.ts

#### `interface AudioAssetRecord` — `audio-db.ts:16-37`
cacheKey/lineId/status（streaming|complete|partial|failed|corrupt）/encoding/sampleRate/channels/bitDepth/chunkCount/totalBytes/sampleCount/durationMs/createdAt/completedAt?/lastAccessedAt/scopeAtCreation（active|candidate|input_preview）。
#### `interface AudioChunkRecord` — `audio-db.ts:39-44`；`interface WriteChunkInput` — `audio-db.ts:46-49`
#### `class AudioDb` — `audio-db.ts:51-279`
静态：DB_NAME `"llm-galgame-audio-v2"`（L52）、ASSETS/CHUNKS/META 三个 store 名（L53-55；keyPath 分别为 cacheKey、[cacheKey,sequence]、显式键）。
- `isSupported()`（L61-63）：`typeof indexedDB !== "undefined"`。
- `open()`（L69-99）：无 IDB 时 available=false 静默跳过；onupgradeneeded 建三 store。
- `close()`（L101-105）；`putAsset`（L107-117）；`getAsset`（L119-128）；`putChunk`（L130-145）。
- **`writeChunkBatch(cacheKey, chunks, asset)`**（L152-175）：单事务写整批 chunk + 刷新资产记录（BatchWriter flush 路径，§11.4/§11.5，全有或全无）。
- `getChunks(cacheKey, from, count)`（L178-197）：IDBKeyRange.bound 升序取批。
- `countChunks`（L199-209）；`deleteAsset`（L212-224，单事务级联删 chunk）；`listAssets`（L226-235）。
- `updateAsset(cacheKey, patch)`（L241-278）：读-改-写逐字段合并（15 个字段手写展开）；completedAt 仅显式提供才写（L266-270）；未知键 no-op。
调用方：app.ts:29/148（实例化）、audio-cache-writer.ts、audio-cache-cleaner.ts、audio-cache-reader.ts、storage 全部测试与 test-utils。

### 3.10 storage/audio-cache-writer.ts

#### `interface CacheWriteOptions` — `audio-cache-writer.ts:19-24`
{ writeBatchBytes, flushIntervalMs }（值来自 /api/config 的 audio.cache.*，app.ts:213-214）。
#### `interface StartAssetMeta` — `audio-cache-writer.ts:26-32`
#### `class AudioCacheWriter` — `audio-cache-writer.ts:46-250`
- **`startAsset(cacheKey, lineId, meta)`**（L61-87）：新建 streaming 会话；**先 `db.deleteAsset` 清旧**（中止的重试不留陈旧 chunk 序列）再 putAsset。
- **`append(cacheKey, chunk)`**（L93-128）：同步 fire-and-forget（播放路径永不 await，§22 invariant 13）。步骤：无会话/已 finished/空块直接丢；**拷贝字节**（调用方可能复用 buffer）；入批缓冲并更新会话资产字段（chunkCount/totalBytes/sampleCount/durationMs/lastAccessedAt 均为推算值）；批字节达阈值→立即 flush，否则挂 flushIntervalMs 定时器。调用方：audio-downloader.ts:188。
- **`finishComplete(cacheKey)`**（L136-165）：两阶段完成——flush → `countChunks` 连续性（== nextSequence）且 totalBytes 匹配 → complete+completedAt，否则 partial；finally 删会话。调用方：app.ts:508（task_status finished）。
- `markPartial(cacheKey)`（L168-170）/ `markFailed(cacheKey)`（L173-175）：经 markTerminal；**不降级已 complete 的资产**（L224）。调用方：app.ts:521/531/640/642。
- **`flush()`**（L178-213）：防陈旧批——首个 await 前**快照**每个 (cacheKey, chunks, session)；逐个写前再校验 `sessions.get(key) === job.session`（startAsset 重启过的 key 旧批直接丢弃，否则会把旧序列插进新会话）。写失败 console.warn，非致命。
- 私有 `markTerminal`（L215-232）、`scheduleFlushTimer`（L234-242）、`cancelFlushTimer`（L244-249）。

内部辅助：`PendingBatch`/`WriterSession` 接口（L34-44）。

### 3.11 storage/audio-cache-cleaner.ts

#### `interface CleanerOptions` — `audio-cache-cleaner.ts:21-26`
{ maxBytes, cleanupTargetBytes, partialTtlMinutes, candidateTtlHours }。生产默认在 app.ts:35-40（512MB/384MB/10min/1h，§17.5，非公开配置）。
#### `interface CleanupReport` — `audio-cache-cleaner.ts:28-31`
#### `class AudioCacheCleaner` — `audio-cache-cleaner.ts:44-112`
- **`run(activeCacheKeys?)` → `runInternal`**（L50-111）步骤：①`listAssets` 汇总总字节；②逐资产分流：当前会话引用（activeCacheKeys）**永不删**；streaming/partial/failed/corrupt 按 lastAccessedAt 超 partialTtl → TTL 回收（活跃 streaming 因 lastAccessedAt 持续刷新而存活）；candidate/input_preview 按 createdAt 超 candidateTtl → 过期；complete 入 LRU 候选；③删 doomed；④仅当剩余字节 > maxBytes 才按 lastAccessedAt 升序逐个删 complete 至 ≤ cleanupTargetBytes。
调用方：app.ts:837（cleanerTimer 每 10 分钟，app.ts:41）。

内部辅助：`TTL_RECLAIM_STATUSES`（L33-38）、`PREFETCH_SCOPES`（L39-42）。

### 3.12 storage/audio-cache-reader.ts

#### `interface AssetLookup` — `audio-cache-reader.ts:16-20`
{ status, asset? }——asset 仅在记录存在时给出。
#### `class AudioCacheReader` — `audio-cache-reader.ts:22-63`
- **`lookup(cacheKey)`**（L33-42）：complete 命中时 best-effort 触 `lastAccessedAt`（供 LRU 区分活跃/遗弃）；**miss（无记录）返回 `{status:"partial"}` 无 asset**——"partial" 同时承担「非 complete」语义，调用方以 asset 有无区分 miss 与真中断（app.ts:602-607）。调用方：app.ts:598。
- **`readChunks(cacheKey)`**（L48-62）：async generator，每批 `READ_BATCH = 16` 块（L24）增量 yield Uint8Array；非 complete 直接 return（§22 invariant 14）。调用方：app.ts:659。

### 3.13 storage/player-settings.ts

#### `interface PlayerSettings` — `player-settings.ts:8-17`
{ voiceVolume, bgmVolume, muted, textSpeed }。
#### `const DEFAULT_PLAYER_SETTINGS` — `player-settings.ts:19-24`
全 1/false/32。消费：app.ts:27（GameApp 构造缺省初始值）。
#### `type SettingsStorage` — `player-settings.ts:29`
`Pick<Storage, "getItem" | "setItem">`（测试注入面）。
#### `normalizePlayerSettings(raw)` — `player-settings.ts:42-54`
逐字段校验：音量 clamp 0..1、字速取整钳 5..120、muted 须 boolean；非法字段回落默认。
#### `loadPlayerSettings(storage?)` — `player-settings.ts:57-67`
读 localStorage key `"dengying.player-settings.v1"`（L26）；JSON.parse 异常/无 storage 均回默认（fail-open）。调用方：main.ts:80。
#### `savePlayerSettings(settings, storage?)` — `player-settings.ts:70-81`
setItem 失败吞掉（配额/隐私模式只降级为会话内设置）。调用方：main.ts:81（persistSettings 闭包）。

内部辅助：`clamp01`（L31-34）、`clampSpeed`（L36-39）、`defaultStorage`（L83-89）。

### 3.14 storage/test-utils.ts（测试基建，随生产树存放）

#### `resetDb(db)` — `test-utils.ts:10-19`
close → deleteDatabase（blocked 也 reject）→ 重新 open；每个 storage 套件间复位。
#### `makeAsset(cacheKey, overrides?)` — `test-utils.ts:22-43`
最小合法 AudioAssetRecord 工厂（默认 streaming/22050/active）。
#### `deleteChunkRaw(cacheKey, sequence)` — `test-utils.ts:45-59`
绕过 AudioDb 直删单 chunk——模拟序列空洞，验证 finishComplete 的连续性检查。
消费者：audio-db.test.ts:8、audio-cache-writer.test.ts:11、audio-cache-cleaner.test.ts:11、audio-cache-reader.test.ts:11。

## 4. 域内数据流（一条语音 descriptor 的完整链路）

以 auto 模式一行台词为例（编号即顺序，函数名斜体引用）：

1. **descriptor 到达**：WS 投影行携带 `AudioDescriptor`（lineId/cacheKey/scope/priority/format，类型在 `src/shared/wire/audio-descriptor.ts:32-41`）；app.ts 记账后 `ensureEnqueued` → `AudioCoordinator.enqueueLine(lineId, cacheKey, 0, 0)`（app.ts:559；pause 参数恒 0，pause_after_ms 由 app 自管，app.ts:749-764）。
2. **缓存查询**：`reconcileAudio`/`ensureAudio`（app.ts:564-622）——当前行必查；未来行仅当 `AudioCoordinator.bufferedAheadMs()` ≤ low_watermark_ms（app.ts:678）且未达 target_buffer_ms（app.ts:590）；candidate 分支仅首行预合成。`AudioCacheReader.lookup(cacheKey)`：
   - **complete 命中** → `feedFromCache`（app.ts:650-669）：`readChunks` 每 16 块增量产出 → 每 cacheKey 独立 `PcmDecoder.push` → 逐批 `AudioCoordinator.feedPcm`，尾 `flush` 同样 feed，最后 `notifyLineEof`。
   - **miss/partial** → `startDownload`（app.ts:624-647）→ `AudioDownloader.download(descriptor, signal, taskId)`。
3. **下载+解码**：`AudioDownloader.run`：`AudioCacheWriter.startAsset`（streaming 会话）→ POST `/api/audio/synthesize` → 流式块双路：raw 字节 `writer.append`（批缓冲，阈值/定时器 flush 进 `AudioDb.writeChunkBatch`，播放永不等待）+ `PcmDecoder.push` → `onPcm` 分发（同 cacheKey 的多个消费者行都收到）→ app.onPcm（app.ts:548-551）→ `AudioCoordinator.feedPcm`。
4. **入队与开播门控**：`feedPcm` 把块压 `pendingByLine` 并 `AudioTimeline.queueSamples` 记账；当前行 `startupSamples` 达 startup_buffer_ms 门槛（或收到 EOF）→ `armPlaybackStart`（voice_delay_ms 挂起定时器）→ `beginPlayback`：`flushPending` 先发 `{type:"line",lineId}` 标记再逐块 postMessage 进 worklet，`context.resume()`，触发 onLinePlaybackStarted。
5. **worklet 播放**：`PcmWorkletProcessor.process`（pcm-worklet.js:87-122）从块队列取样、sourceRate→outputRate 线性插值重采样输出；空环 postMessage `{type:"underrun"}`；标记行样本耗尽且未发过 → `{type:"drained", lineId}`（后续同 line 新样本会 re-arm，pcm-worklet.js:124-133）。
6. **EOF 门控推进**：流终/失败/中止 → downloader `finally` 对每消费者 `onEof` → `notifyLineEof`（记录 producerEof；未开播则越过门槛开播）→ worklet `drained` 到达 → `handleWorkletMessage` 校验「当前行 + producerEof」双条件 → `finishLine` → `onLinePlaybackFinished` → app auto 模式按 pause_after_ms 定时器 `advance()`（app.ts:743-767）；同时 WS `audio.task_status finished` → `writer.finishComplete`（缓存定 complete，**不重读缓存避免二次播放**，app.ts:506-517）。

并行失败路径：task_status failed/canceled → `markFailed`/`markPartial` + abort（app.ts:519-537）；失效 invalidation → `coordinator.dropLine` + abort（app.ts:482-495）。

## 5. 跨域接口

**被 app 域（web/src/app.ts）调用**（import 于 L21-32）：`AudioCoordinator`（L182 构造、L195 init、feedPcm/notifyLineEof/enqueueLine/start/stop/dropLine/setMode/setVolume/setMuted/bufferedAheadMs/isPlaying/available）、`AudioDownloader`（L218 构造、L633 download）、`PcmDecoder`（L221 工厂、L656 缓存读路径）、`AudioDb`（L148）、`AudioCacheWriter`（L215、L508/521/531/640/642）、`AudioCacheReader`（L216、L598/659）、`AudioCacheCleaner`（L217、L837）、`DEFAULT_PLAYER_SETTINGS`/`PlayerSettings`（L27/56 注入缝）；回调侧 `AudioCoordinatorEvents` 实现在 app.ts:737-776；`music` 注入缝 `options.music?.handleScore`（L58/L406）。

**被入口/其它前端子系统调用**：main.ts——`loadPlayerSettings`/`savePlayerSettings`（L22-24、L80-81）、`GeneratedBgm`+`SoundfontMusicRenderer` 装配（L31-32/76）、`createAudioContext` 在 Start 手势内创建 AudioContext（main.ts:49-57/92，autoplay 解锁归入口层）；ui/controls.ts:8 仅 `type PlaybackMode`；music-demo.ts（试听工具页）——`SoundfontMusicRenderer`/`audioBufferToWavBlob`/`loopSeconds`/`DEMO_SCORES`。

**对 stage 域的单向调用**：generated-bgm.ts:10/12 引用 `BgmController` 类型，运行时 `bgm.applyGenerated(url)`（stage/bgm-controller.ts:120 接收 WAV blob URL）。

**HTTP 接缝**：`POST /api/audio/synthesize`（audio-downloader.ts:42 常量；请求头 X-Session-Token，体 `{taskId,lineId,cacheKey}`，响应体为 pcm_s16le 流）——服务器端为 `src/hosts/local-web/audio-stream-route.ts`（校验 method/content-type/token，委派 TtsTaskService，流式回 PCM，客户端断连时中止上游任务）。静态资产：`GET /game-assets/audio/soundfonts/{pack}.json`（music-renderer.ts:220）。

## 6. 测试覆盖

| 测试文件 | 覆盖的符号/行为 |
|---|---|
| audio/audio-coordinator.test.ts（486 行，24 it） | init（模块加载/工厂优先/双缺才降级）、startup buffer 门槛、EOF+drained 收尾（中途断流不提前收尾、EOF 越门槛、零样本 EOF、未来行 EOF 后切换补启、无 producerEof 的 drained 不收尾）、voice_delay（延迟开播、stop/switch 取消挂起）、manual 收尾、skip 清样、bufferedAheadMs、underrun 转发、volume/mute（init 前设置延迟生效）、stop 不发 finished、未知/当前行 no-op、init 前投喂的补 flush、dropLine 两条 |
| audio/pcm-worklet.test.ts（159 行，12 it） | PcmWorkletProcessor：Int16→Float32、超旧固定环容量的长队列、22050→48000 重采样时长不变、underrun 单发、恰好满足不发、clear、drained 单发/等整批/新样本 re-arm/clear 抑制/新 line 覆盖、parameterDescriptors |
| audio/audio-timeline.test.ts（91 行，9 it） | contiguousBufferedMs（样本求和/间隙/洞/头行空）、skipTo、currentLineId、hasSegment/clear、append 幂等 |
| audio/pcm-decoder.test.ts（52 行，7 it） | 偶长块解码、奇字节跨块（3+1）、多样本拼接、flush 残样、flush 空、reset、空 push 不扰动 pending |
| audio/music-renderer.test.ts（162 行） | 纯函数：loopSeconds/beatSeconds/尾部区、nearestSampleMidi、foldTailIntoLoop（叠回+不再做峰值护栏）、normalizeLoudness（RMS 归一/峰值钳/立体声同增益/静音空输入）、audioBufferToWavBlob 头与长度。SoundfontStore/render 的 WebAudio 图无直测（薄胶水） |
| audio/generated-bgm.test.ts（109 行，5 it） | 新谱渲染→applyGenerated、同 key 幂等、新 key 替换+revoke、失败仅告警、排队被取代丢弃 |
| storage/audio-db.test.ts（125 行，9 it） | 升级建三 store、putAsset/getAsset 往返、updateAsset 合并/未知键 no-op、putChunk/getChunks/countChunks 有序分片、deleteAsset 级联、listAssets、无 indexedDB 报不支持 |
| storage/audio-cache-writer.test.ts（236 行，11 it） | startAsset 清旧、字节阈值 flush、定时器 flush、强制 flush、阈值 flush 竞态下 finishComplete、**flush 期间重启 key 不写陈旧批**（回归）、complete/partial 判定（连续性）、markPartial/markFailed、append 同步不阻塞、流结束后 append 丢弃 |
| storage/audio-cache-cleaner.test.ts（220 行，8 it） | 过期 partial 回收、遗弃 streaming 回收、会话引用保护（含 streaming）、candidate 过期、LRU 降到 target、低于 maxBytes 不动、会话资产保护、先逐非会话资产 |
| storage/audio-cache-reader.test.ts（104 行，7 it） | lookup complete/partial/miss 三态、readChunks 顺序/跨批不丢不重/partial 与未知 key 不产出 |
| storage/player-settings.test.ts（75 行，5 it） | 默认值、save/load 往返、逐字段归一（含越界）、corrupt JSON/无 storage 回默认、setItem 失败吞掉 |
| web/src/app.test.ts（跨域集成，27 it） | 本域相关：cache 命中跳过下载、download POST 体+token+喂 PCM+complete、dedup 并发下载、invalidation 中止+partial、失败标 failed 不破流程、task_status finished 不重喂、非 owner 消费者失效中止共享 fetch、lookup 竞态、addModule 失败显式报错、无 worklet 降级不请求合成、candidate 首行预合成/深行不合成、bufferedAheadMs 达标停止填充 |

**缺口**：audio-downloader.ts 无专属测试文件，其去重/EOF 扇出/abort 扇入完全依赖 app.test.ts 的集成路径；music-renderer 的 WebAudio 调度图（render 主体）无测试。

## 7. 重构关注点（事实清单）

1. `audio-downloader.ts:55` — `static readonly inFlight = new Map<string, InFlightSlot>()` 为模块级跨实例全局可变状态；`audio-downloader.ts:63-65` 的 `static hasInFlight` 在全仓（含测试）无任何调用方——死导出。
2. `audio-coordinator.ts:19` — `import workletSource from "./pcm-worklet.js?raw"`：构建器特例（Vite data-URL workaround，注释 L93-96）；worklet 实现 pcm-worklet.js（纯 JS）、其声明 pcm-worklet.d.ts、协调器消息协议（clear/line/chunks/drained/underrun 字面量）分散三文件且无共享类型定义，改协议需三处同步。
3. `audio-coordinator.ts:35-410` — 单类 20 个方法混合调度、门控、增益、降级检测、worklet 消息协议五类职责；`init` 的能力检测（L82-92）含 `createAudioWorkletNode` 非标准工厂兼容分支，测试需专门 mock（audio-coordinator.test.ts:83-110）。
4. `web/src/app.ts:884-890` 与 `player-settings.ts:31-39` — `clampUnit`/`clampSpeed` 与 `clamp01`/`clampSpeed` 为逐字符等价的重复实现（clampSpeed 两处均为 `Math.round(Math.min(120, Math.max(5, v)))`），app 域与本域各持一份钳制逻辑。
5. `audio-cache-writer.ts:184-205` — flush 的陈旧批防御依赖「快照 session 引用比对」，是 writer 与 startAsset 生命周期交互的高危点（有专项回归测试 audio-cache-writer.test.ts:99；注释自述为曾发 bug 的防御）。
6. `audio-cache-reader.ts:35` — miss 与真中断共用 `status:"partial"` 返回值，靠 `asset` 字段有无区分，调用方 app.ts:602-607 以 `lookup.asset !== undefined` 再判——语义重载。
7. `audio-db.ts:241-278` — updateAsset 15 字段手写展开合并，AudioAssetRecord 增字段必须记得同步此处，否则静默丢字段。
8. `demo-scores.ts`（全文件 3929 行）— 纯 fixture 位于生产源码树 `src/audio/` 下，占本域行数 64%；仅 music-demo.ts 消费，与运行时模块同目录混放。
9. `music-renderer.ts:252-253` — render 已知截断（dur≤8 拍长音越界部分丢弃，循环点可能突断），注释标明修复须连同 `src/application/audio/music-cache-key.ts` 版本号（确定性契约）。
10. `test-utils.ts` — 测试基建文件存于生产目录 `storage/` 下（非 `*.test.ts` 命名），会被生产构建图纳入解析（无运行时消费者）。
11. `audio-coordinator.ts:47` 与 `audio-coordinator.ts:233-235` — `mode` 字段被 setMode 写入但本类内无任何读取处（auto/manual 差异全在 app 侧）——字段冗余，仅作状态回显。

## 附A · 设计评注（2026-10-25 复核轮——观察与可能方向，非约束）

1. **`audio.cache_report` 现状是无消费者的协议**（web/src/app.ts:813-815、runtime-websocket.ts:262-265）：浏览器上报 `{result: "hit"|"miss"|"partial"|"corrupt"}`，服务端仅 ack——无 metrics 无 logging，不参与任何闭环。`"corrupt"` 是永不产出的防御态（全仓无生产写入点）。设计评注：一条没人读的上报，"接进 diagnostics/metrics"与"从 ClientMessageSchema 删除"都是自洽方向。
2. **`audio.buffer_report` 周期**：`BUFFER_REPORT_INTERVAL_MS = 2000`（app.ts:42）——策略数字。
3. **双层去重分工**：路由层 `activeCacheKeys` 409（每 cacheKey 单 HTTP 消费者）+ 任务层 refcount 合流——现状两层都在；只留一层时，双标签页场景可能出现 join 半截 PCM 流或重复扣并发额度。
