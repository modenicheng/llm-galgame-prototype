# 场景配乐动态生成（动态音乐生成 V1）

状态：**V1 已落地（2026-10-16）**——导演指导层、作曲层、浏览器渲染层全链
贯通；真实作曲链路经 glm-5.3-flash 双情绪探针验证（scripts/probe-music-composer.ts）。
**V1.1（同日）**：per-game 复用谱库（token 上界 21 首/世界）+ 独立试听页
（`npm run demo:music` → /music-demo.html，零 token 听感调参）。**V1.2
（2026-10-17）**：地区音乐身份维度（编剧世界锚 + 导演场景覆盖，复用键
region:mood:intensity）；真浏览器听感验证通过（试听页双曲渲染播放）。

## 0. 定位与选型结论

GalGame 场景 BGM 的需求画像：1–3 分钟**无人声、可无缝循环、情绪匹配、
多周目可复现**——与"AI 整曲生成"（带人声、不循环、每曲成本）错位。本机
无 CUDA 独显（AMD 780M 核显）排除了本地神经模型（ACE-Step 1.5 要
≥12GB VRAM）。因此 V1 走 **LLM 符号作曲 + soundfont 确定性渲染**：

- 免费（符号层几百~几千 token）、离线（采样包随仓库分发）、秒级渲染；
- 无缝循环是构造性质（小节对齐 + 混响尾折叠回环）；
- 同谱同渲染器版本 = 逐样本同音频（回放/多周目一致性）；
- 云 API / 本地神经模型留作未来 OP/ED 整曲的第二渲染后端，接在同一
  作曲服务后面（renderer-agnostic 契约）。

## 1. 三层契约（与角色音频特征范式同构）

| 层 | 模块 | 职责 |
|---|---|---|
| 导演指导 | `SceneDirective.music`（`src/application/director/director-service.ts`） | 场景边界产出 `{mood, intensity, note?, region?}`；情绪/地区词表 `MUSIC_MOODS`/`MUSIC_REGIONS` 单一真源（`src/shared/music/score.ts`），插值进导演 prompt；mood 词表外整段丢弃并告警，region 词表外丢字段（mood 仍生效）、`"default"` 归一为缺省 |
| 作曲 | `SceneMusicService`（`src/application/audio/scene-music-service.ts`）+ `SceneMusicComposerAdapter`（`src/adapters/llm/`） | 复用键 `(mood:intensity)` 先查 per-game 谱库（命中 = 零 token 直接广播）；未命中单次 JSON LLM 调用产出符号谱（`MusicScoreSchema` 硬校验，失败携 zod issue 修复重试一次，双败降级）→ 落盘谱库；产物带 `musicCacheKey`（谱面指纹 + `MUSIC_RENDERER_VERSION`）广播；同键 in-flight 合流 |
| 渲染 | `web/src/audio/music-renderer.ts` + `generated-bgm.ts` | OfflineAudioContext + FluidR3 采样包（按乐器懒加载）→ 分乐器包络/程序混响 IR/最近采样微移 → 渲染体+尾 → 尾部循环折叠 → WAV blob URL → `BgmController.applyGenerated` |

符号谱（`src/shared/music/score.ts`，Node/Web 两侧共用）：`{version, bpm,
key, mode, bars, tracks:[{instrument, gain, notes:[{beat, dur, midi, vel}]}]}`；
乐器调色板 piano/strings/pad/bass/bell/choir；跨字段校验（音符起拍落在
循环内、每乐器一轨、总量 ≤600）。**缓存的是乐谱不是音频**——渲染确定性
使重渲染即可复现，无需浏览器端有损编码器。

## 2. 传输与接线

- 谱面经 runtime WS 新消息 `music.score {sceneId, cacheKey, score}` 推送
  （`WIRE_PROTOCOL_VERSION` 2→3，旧页面按 4002 明确拒绝）；重连时回放
  最近谱面（与 descriptor 目录回放同模式），浏览器按 cacheKey 幂等。
- Bootstrap：`director.setDirectiveListener` → `SceneMusicService`
  （fire-and-forget，失败只告警）；`media.audio.music.enabled=false`
  （默认 true）= 不注册监听，零 LLM 调用。
- 采样包：`assets/audio/soundfonts/<palette>.json`（FluidR3_GM gleitz
  抽取，A1–C7 裁剪，双 MIT 署名见同目录 LICENSE.md），经 `/game-assets/`
  静态路由分发；重建脚本 `scripts/vendor-soundfonts.mjs`。

## 3. 播放优先级语义：「最新意图胜」

- 生成曲渲染完成即接管播放（`BgmController.applyGenerated`，blob URL
  绕过资产目录；旧 URL 替换时 revoke，生成曲内存峰值恒为单曲）。
- 写手显式 `@bgm`（visualState.bgm **值变化**）随时压回——与语音合并链
  「导演 > 编剧」同哲学；重发同值不算新意图。
- 跨场景携带的旧 bgm 值不重放（main.ts 按「值变化才 apply」驱动），
  生成曲因此能跨场景存活；`@bgm stop`（值变 undefined）静音，下一场景
  生成曲到达后接管。
- 作曲/渲染失败 = 沿用当前曲目（可观测降级，不阻塞演出）。

## 4. 地区音乐身份（V1.2）与谱库复用（V1.1）

电影/游戏配乐除情绪外还有**地区创作思路**维度（原神式：同地区各情绪
曲目共享音色语汇与音阶/节奏习惯）。落地为与 voice-design 同构的两层：

- **编剧世界锚**：`WorldDraft.musicRegion`（词表 `MUSIC_CONCRETE_REGIONS`：
  east-asia/celtic/nordic/arabic/latin/jazz/slavic，单一真源 shared/music）
  ——世界创建期按世界观选定，落盘 `world/music-identity.json`
  （`MusicIdentityStore`，创建期写一次拒绝覆写）；现代都市/架空无地域
  文化则省略（无锚 = default）。旧世界无此文件 → 回落 default，无需迁移。
- **导演场景覆盖**：`SceneDirective.music.region`——仅当场景明确处于异域/
  异文化（异国场景、他乡回忆、风格突变）才给出；其余省略，世界基调由
  锚接管（导演 prompt 明示此语义）。
- **生效优先级**：导演覆盖 > 世界锚 > default（`SceneMusicService` 解析，
  作曲请求携带生效值；作曲 prompt 含地区→创作思路映射——east-asia 五声
  稀疏留白、celtic dorian+五度 drone、arabic 增二度+低音 drone 等，
  与 mood 正交）。

复用谱库（重新生成即重新花 token，而 GalGame BGM 的可听身份只有
地区 × 情绪 × 强度——note 是编配提示不是身份）。复用键 =
`region:mood:intensity`（7 地区 × 7 情绪 × 3 强度理论上界；单地区世界
即 21 首，通常 4~8 首），谱库落盘 `games/<gameId>/music/library.json`
（`MusicLibraryStore`，沿 stats.json 先例：tmp+rename 原子写、缺文件空库、
损坏大声抛错、**首写即定稿**——同键覆写 no-op，世界音乐身份不漂移）。

- 命中谱库 → 零 token 直接广播（跨场景、跨周目、跨进程重启同曲 =
  Leitmotif 一致性）；note 只在首作时进 prompt。
- 未命中 → 作曲一次（同键并发合流为单次 LLM 调用）→ put 落盘 → 广播。
  落盘失败只告警（谱面仍本会话生效）。
- 新世界（缺省时间戳 gameId）= 新谱库新曲；续玩同一 gameId = 复用旧曲。
  V1.1 时代的旧键（`mood:intensity`）不与新键（`region:mood:intensity`）
  冲突——旧条目自然孤儿化，等同一次性重作曲。
- 浏览器不缓存渲染音频：跨曲往返重渲染（秒级、确定性）；内存峰值恒为
  单曲 blob。

## 5. 听感调参与试听工具

`npm run demo:music`（= `vite build` + `scripts/serve-music-demo.mjs`，零
依赖静态服务）→ http://127.0.0.1:4319/music-demo.html：内置 6 首基线谱面
（真实 glm-5.3-flash 作曲，`web/src/audio/demo-scores.ts`；含地区维度
A/B：东亚悲伤 vs 默认悲伤、凯尔特希望）+ file picker 载入
`probe-music-composer.ts --save=xx.json [--region=xx]` 产物 → 生产渲染器
渲染 → WAV 循环播放/下载。调参闭环零 token：改增益/混响/prompt →
build → A/B 对比，基线谱面恒定。改渲染输出（采样映射/包络/混响/折叠/
采样率）记得升 `MUSIC_RENDERER_VERSION`。

已知修复：SoundfontStore 曾以裸全局 `fetch` 作默认注入参数，浏览器调用
抛 `Illegal invocation`（真浏览器验证暴露）——已绑 `globalThis.fetch.bind
(globalThis)`（沿 audio-downloader 先例）；不影响音频输出，不升渲染版本。

## 6. 验证记录（2026-10-16/17）

- 探针（真实 BigModel）：tense/2 → 138bpm A 小调 163 音符（bass 每拍、
  钢琴旋律、弦乐长音），40.9s，schema PASS；sorrowful/1 → 58bpm 稀疏
  70 音符 66s 循环，21.3s，schema PASS——情绪→编配映射成立。
- 基线四曲（V1.1，--save 采入试听页）：tense/2 132bpm 210 音符 29s 循环；
  sorrowful/1 54bpm 64 音符 71s；warm/1 76bpm C 大调 钢琴+music box 互答
  78 音符（按 note 编配）；climax/3 138bpm 五轨全奏 156 音符。单首作曲
  16.7~40.0s、~2-4k 输出 token。
- 地区双曲（V1.2）：east-asia sorrowful/1 58bpm 仅 39 音符三轨低增益
  （稀疏留白，与默认悲伤曲 64 音符钢琴主导形成可听对比）；celtic
  hopeful/2 96bpm **dorian** + 竖琴式钢琴 47 音符 + pad/strings 铺——
  地区→创作思路映射（调式/织体/密度）成立。
- 真浏览器听感验证（V1.2，试听页）：紧张曲渲染 3.6MB WAV 循环播放
  （duration=29.09s 与谱面循环长一致）、东亚曲切换渲染 8.1MB 播放正常；
  修复裸 fetch 前的同页面曾稳定抛 Illegal invocation（正式会话同样会踩）。
- 单测：谱面 schema/服务复用语义（谱库命中零 LLM、同键合流、落盘失败
  降级、note 不进键、地区键与 worldRegion 回落/覆盖）/identity store
  （写一次拒覆写、损坏拒收）/library store（原子写、首写定稿、跨实例恢复）
  /导演 region 解析（词表外丢字段保 mood、default 归一）/编剧 musicRegion
  schema/适配器修复轮/渲染时值数学/循环折叠/WAV 头/GeneratedBgm 编排
  （含取代丢弃与幂等）/BgmController 生成路径。
- 待办：真实游戏会话内的端到端听感验收（首场景边界生成曲接管体验）。
