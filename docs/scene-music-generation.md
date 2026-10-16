# 场景配乐动态生成（动态音乐生成 V1）

状态：**V1 已落地（2026-10-16）**——导演指导层、作曲层、浏览器渲染层全链
贯通；真实作曲链路经 glm-5.3-flash 双情绪探针验证（scripts/probe-music-composer.ts）。
真实浏览器内的听感验收待跑一轮真实会话后回填。

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
| 作曲 | `SceneMusicService`（`src/application/audio/scene-music-service.ts`）+ `SceneMusicComposerAdapter`（`src/adapters/llm/`） | 单次 JSON LLM 调用产出符号谱（`MusicScoreSchema` 硬校验，失败携 zod issue 修复重试一次，双败降级）；同场景同指导去重；产物带 `musicCacheKey`（谱面指纹 + `MUSIC_RENDERER_VERSION`）广播 |
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

## 4. 验证记录（2026-10-16）

- 探针（真实 BigModel）：tense/2 → 138bpm A 小调 163 音符（bass 每拍、
  钢琴旋律、弦乐长音），40.9s，schema PASS；sorrowful/1 → 58bpm 稀疏
  70 音符 66s 循环，21.3s，schema PASS——情绪→编配映射成立。
- 单测：谱面 schema/服务去重降级/适配器修复轮/渲染时值数学/循环折叠/
  WAV 头/GeneratedBgm 编排（含取代丢弃与幂等）/BgmController 生成路径。
- 待办：真实浏览器会话听感验收（首次渲染含采样包加载 ~6-11MB + 解码，
  预计数秒）。
