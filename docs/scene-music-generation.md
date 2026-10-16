# 场景配乐动态生成（动态音乐生成 V1）

状态：**V1 已落地（2026-10-16）**——导演指导层、作曲层、浏览器渲染层全链
贯通；真实作曲链路经 glm-5.3-flash 双情绪探针验证（scripts/probe-music-composer.ts）。
**V1.1（同日）**：per-game 复用谱库（token 上界 21 首/世界）+ 独立试听页
（`npm run demo:music` → /music-demo.html，零 token 听感调参）。真实浏览器
内的听感验收待跑一轮真实会话后回填。

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
| 导演指导 | `SceneDirective.music`（`src/application/director/director-service.ts`） | 场景边界产出 `{mood, intensity, note?}`；情绪词表 `MUSIC_MOODS` 单一真源（`src/shared/music/score.ts`），插值进导演 prompt；词表外整段丢弃并告警 |
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

## 4. 复用谱库与 token 上界（V1.1）

重新生成即重新花 token，而 GalGame BGM 的可听身份只有 (情绪, 强度)——
note 是编配提示不是身份。因此复用键 = `mood:intensity`（7×3 = 21 上界，
通常一世界 4~8 首），谱库落盘 `games/<gameId>/music/library.json`
（`MusicLibraryStore`，沿 stats.json 先例：tmp+rename 原子写、缺文件空库、
损坏大声抛错、**首写即定稿**——同键覆写 no-op，世界音乐身份不漂移）。

- 命中谱库 → 零 token 直接广播（跨场景、跨周目、跨进程重启同曲 =
  Leitmotif 一致性）；note 只在首作时进 prompt。
- 未命中 → 作曲一次（同键并发合流为单次 LLM 调用）→ put 落盘 → 广播。
  落盘失败只告警（谱面仍本会话生效）。
- 新世界（缺省时间戳 gameId）= 新谱库新曲；续玩同一 gameId = 复用旧曲。
- 浏览器不缓存渲染音频：跨曲往返重渲染（秒级、确定性）；内存峰值恒为
  单曲 blob。

## 5. 听感调参与试听工具

`npm run demo:music`（= `vite build` + `scripts/serve-music-demo.mjs`，零
依赖静态服务）→ http://127.0.0.1:4319/music-demo.html：内置 4 首基线谱面
（真实 glm-5.3-flash 作曲，`web/src/audio/demo-scores.ts`）+ file picker 载入
`probe-music-composer.ts --save=xx.json` 产物 → 生产渲染器渲染 → WAV 循环
播放/下载。调参闭环零 token：改增益/混响/prompt → build → A/B 对比，基线
谱面恒定。改渲染输出（采样映射/包络/混响/折叠/采样率）记得升
`MUSIC_RENDERER_VERSION`。

## 6. 验证记录（2026-10-16）

- 探针（真实 BigModel）：tense/2 → 138bpm A 小调 163 音符（bass 每拍、
  钢琴旋律、弦乐长音），40.9s，schema PASS；sorrowful/1 → 58bpm 稀疏
  70 音符 66s 循环，21.3s，schema PASS——情绪→编配映射成立。
- 基线四曲（V1.1，--save 采入试听页）：tense/2 132bpm 210 音符 29s 循环；
  sorrowful/1 54bpm 64 音符 71s；warm/1 76bpm C 大调 钢琴+music box 互答
  78 音符（按 note 编配）；climax/3 138bpm 五轨全奏 156 音符。单首作曲
  16.7~40.0s、~2-4k 输出 token。
- 单测：谱面 schema/服务复用语义（谱库命中零 LLM、同键合流、落盘失败
  降级、note 不进键）/谱库 store（原子写、首写定稿、损坏拒收、跨实例恢复）
  /适配器修复轮/渲染时值数学/循环折叠/WAV 头/GeneratedBgm 编排（含取代
  丢弃与幂等）/BgmController 生成路径。
- 待办：真实浏览器会话听感验收（首次渲染含采样包加载 ~6-11MB + 解码，
  预计数秒）。
