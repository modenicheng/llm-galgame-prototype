# 场景配乐动态生成（V2 主题制架构）

状态：**V2 已落地（2026-10-18）**——主题制决策流、作曲家第四 agent
（skill 注入 + 持久会话）、渲染 V2 混音母带链、乐器 12 件全链贯通；
真实 BigModel 双轮探针验证 compose+reuse 两分支（scripts/probe-music-composer.ts）。
历史：V1（2026-10-16 三层贯通）、V1.1（复用谱库+试听页）、V1.2（地区
维度，已于 V2 拆除——地区身份误解了「主题制」的真实需求）。
设计定稿：`docs/superpowers/specs/2026-10-18-music-v2-theme-architecture.md`。

## 0. 定位与选型结论（V1 继承，不变）

GalGame 场景 BGM 的需求画像：1–3 分钟**无人声、可无缝循环、情绪匹配、
多周目可复现**。本机无 CUDA 独显排除本地神经模型，走 **LLM 符号作曲 +
soundfont 确定性渲染**：免费、离线、秒级渲染、无缝循环是构造性质、
同谱同渲染器版本 = 逐样本同音频。云 API/本地神经模型留作未来 OP/ED
整曲的第二渲染后端。

## 1. V2 核心转变：复用键 → 主题实体 + 作曲家决策

V1.x 的可听身份是情绪档位的函数（复用键 mood:intensity），意味着同一
地点的日夜两访、同一区域的不同场景会拿到不同曲子——OST 专辑感不存在。
V2 把可听身份改为**作曲家命名的主题实体**：

- 同一场景日夜共用一个主题（sceneId 绑定）
- 同一游戏区域（如地下堡垒）共用一个主题（作曲家 reuse 决策）
- 一局游戏最终形成 5–15 首主题曲目（专辑纪律）
- 复用与否由**作曲家 agent**在看过场景 brief 与已有主题目录后决定——
  导演只给情绪/情境（prompt 不膨胀），目录与会话在作曲家侧

决策流（`SceneMusicService`，V2 重写）：

```
导演 SceneDirective.music{mood,intensity,note}   ← note =「情境一句话+编配提示」（≤60 字）
  1) bindings[sceneId] 已绑定主题 → 直接发布该主题谱面，零 LLM
     （覆盖日夜重访/重启续玩；谱面缺失 = 告警走决策重建）
  2) 未绑定 → 组装 brief 调作曲家 agent：
       输入 = brief + 全量主题目录（含 motifHint 与谱面统计）+ 最近 30 轮会话 + 作曲 skill
       输出 = {action:"reuse", themeId, reason} | {action:"compose", theme, score, reason}
  3) 持久化（主题目录 + 谱面 + sceneId 绑定 + 追加会话轮）→ publish
```

## 2. 数据层（games/<gameId>/music/）

| 文件 | 内容 | 惯例 |
|---|---|---|
| `themes.json` | `{version:1, themes:[MusicThemeMeta], bindings:Record<sceneId,themeId>}` | tmp+rename 原子写、ENOENT=空、损坏大声抛错；运行期可增长（沿 stats.json 模式）；bindings 只增不删 |
| `scores/<themeId>.json` | 每主题一份 MusicScore | MusicScoreSchema 复验；首写即定稿（同 id 覆写 no-op） |
| `session.jsonl` | 作曲家持久会话：user=brief / assistant=决策摘要（**不含完整谱面**） | 追加式；窗口截断最近 30 轮，V2 不做 LLM 压缩（估算字符 > 300k 再引入） |

`MusicThemeMeta = { id: slug; title: 中文曲名; concept: 一句话主题概念;
style?: 风格短语（原地区知识降级为风格提示语汇）; motifHint?: 头 4–8 音
MIDI 序列（服务层从谱面旋律轨**确定性提取**，LLM 不写防幻觉——schema
拒收）; parentTheme?: 变体主题引用的母题 }`。单一真源
`src/shared/music/theme.ts`（含 ComposerDecision 判别联合与
SceneMusicBrief 契约）。store：`music-theme-store.ts`（一类管两处）+
`composer-session-store.ts`。

V1.1/V1.2 的 `music/library.json`、V1.2 的 `world/music-identity.json`
自然孤儿化不迁移（本机无存量档；旧文件留存无害）。

## 3. 作曲家 agent（第四 agent）

- **作曲 skill**（`src/adapters/llm/music-composition-skill.ts`，TS 模板
  字符串注入 system prompt）：和声纪律硬约束——全轨同 key/mode、先定
  2~4 和弦循环、非和弦音仅 ≤半拍经过/邻音且须解决、跨轨禁小二度/三全音
  碰撞（延留解决除外）、bell 必落和弦音、避平行五八度、bass 走根音、
  pad 补根三五、声部不交叠、末小节回主和弦或属七悬置；调式色彩用法
  （dorian 自然 6 级、和声小调增二度只在旋律声部）；原 7 地区创作思路
  降级为可选 style 语汇（east-asia 五声/celtic drone/…）；主题动机复现
  规则（引用母题 motifHint 变形发展、变体填 parentTheme）——针对 V1
  试听违和点（半音碰撞/非和弦音长鸣/声部交叠）可执行化。
- **适配器**（`scene-music-composer-adapter.ts` 重写）：`decide(brief,
  catalog, sessionTurns)`；messages = system + 会话历史 + 本轮 user；
  ComposerDecisionSchema 判别联合硬校验 × 修复重试一次 × 双败 null。
  预算（用户明示放宽）：timeout ≥300s、max_tokens 16000（reuse 不写谱面
  天然省 token）；thinking 保持 disabled（听感不达标时第一调参项）。
- **复用纪律**（system prompt）：同一地点/区域/相近情境必 reuse；mood/
  intensity 差异不 fork 主题；只有导演 note 明示质变才建 parentTheme
  变体；一局主题数目标 5–15；目录空必 compose。
- **服务降级语义**：决策双败/落盘失败只告警沿用当前曲；compose 主题 id
  与目录冲突时追加确定性短 hash 重命名（不丢作曲）；reuse 指向缺失谱面
  = 告警不发布；in-flight 按 sceneId 合流。

## 4. 传输与接线

- WS `music.score {sceneId, themeId, cacheKey, score}`（wire **v4**，
  旧客户端 4002 明确拒绝）；重连回放最近谱面；浏览器按 cacheKey 幂等。
- Bootstrap：`media.audio.music.enabled=false`（默认 true）= 不注册
  监听，零 LLM。导演 `setDirectiveListener` → SceneMusicService
  fire-and-forget。
- 采样包 12 件：`assets/audio/soundfonts/<palette>.json`（FluidR3_GM
  gleitz 抽取 A1–C7 裁剪，双 MIT）；vendor 脚本 CDN 用 fastly 镜像。

## 5. 渲染 V2（`web/src/audio/music-renderer.ts`）

- 每轨链：highpass(40Hz) → StereoPanner（乐器固定声像：bass/organ 居中、
  piano -0.15/strings +0.2/pad -0.25/choir +0.25/bell +0.3/guitar -0.25/
  harp +0.35/flute +0.15/marimba -0.35/synth +0.4）→ 轨增益 → 分轨混响
  send（bass 0.05 近干、bell 0.5/piano 0.45 多送）。
- 总线：DynamicsCompressor（-18dB/2.5:1/10ms/250ms）+ makeup 1.25。
- 后处理 `normalizeLoudness` 纯函数：全通道联合 RMS 归一 ≈ -16 dBFS +
  峰值钳 -1 dBFS（替换「>1 才缩」护栏；增益与钳制取小宁低勿削波）。
- 采样率 44100（soundfont 原生）；`MUSIC_RENDERER_VERSION = 2`——
  凡影响输出的改动必须升版使乐谱缓存失效。
- 乐器 12 件：piano/strings/pad/bass/bell/choir + **guitar/harp/flute/
  marimba/organ/synth**（枚举/vendor PACKS/渲染器声像增益混响三表同源，
  typecheck 强制穷尽）；skill 配器语汇含题材匹配表（现代 synth/古风
  harp+flute+marimba/教堂 organ+choir）。分批编辑契约不做：单次 JSON +
  16k token 预算足够。

## 6. 播放优先级语义（V1 继承，不变）

「最新意图胜」：生成曲渲染完成即接管；写手显式 `@bgm` 值变化随时压回；
`@bgm stop` 静音待下一场景；作曲/渲染失败 = 沿用当前曲目（可观测降级，
不阻塞演出）。

## 7. 试听与调参

`npm run demo:music` → `/music-demo.html`：内置 6 首基线谱面（真实
glm-5.3-flash 产物，标签去地区框架、谱面恒定作渲染 A/B 基线）+ file
picker 载 `probe-music-composer.ts --save` 产物 → 生产渲染器 → WAV
循环播放/下载。改渲染输出记得升 `MUSIC_RENDERER_VERSION`。

## 8. 验证记录

- **V2 探针（2026-10-18，真实 BigModel glm-5.3-flash）**：第一轮空目录
  brief（tense/2 夜巡地下堡垒）→ compose《地底堡垒·机械残响》
  （68bpm minor 16bars 93 音符四轨，motifHint=81,84,81,84，40.9s，
  schema PASS）；第二轮同堡垒昼访（mysterious/1）→ **reuse 同一主题**
  （理由：「昼夜共用主题身份——mood/intensity 差异不构成新主题理由」，
  2.0s）——复用纪律在真实模型上成立，reuse 轮 token/耗时断崖下降。
- 单测（V2 全量 149 文件 2195+ 绿）：theme 契约（slug/判别联合/motifHint
  拒收 LLM 幻觉）、双 store（原子写/首作定稿/跨实例恢复/损坏拒收/窗口
  截断）、服务决策流（绑定命中零 LLM/reuse 绑定落盘/compose 三件套/
  id 冲突重命名/孤儿绑定重建/双败重试/sceneId 合流/落盘失败仅告警）、
  适配器（skill 禁令子串/预算 300s·16k/会话历史进 messages/修复轮/
  围栏解析）、导演 note 60 字、wire v4、渲染归一化数学（RMS/峰值钳/
  声像保持/静音防御）。
- 待办：真实游戏会话端到端听感验收（渲染 V2 母带响度与声像真浏览器
  复听；`npm run demo:music`）。
