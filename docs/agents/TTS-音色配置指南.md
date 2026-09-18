# TTS 音色配置指南

本文面向协作者:如何**创建**自己的音色(三种方式),以及如何把它**绑定**到游戏里。

> **本地音色（campus 分支当前默认，不走 DashScope）**：树莓娘与四配角的语音由
> 本机推理服务（`tts-server/`）合成，绑定字段是 `providers.local.voice`
> （键 = `tts-server/voices/registry.json` 的音色名），**不需要任何 API key**；
> 音色构建/重建与服务启动见 [`tts-server/README.md`](../../tts-server/README.md)。
> 本文其余部分针对云端 DashScope 音色（`synthesis.provider: dashscope`）。

音色的核心只有两个字段:

```yaml
providers:
  dashscope:
    model: qwen3-tts-flash   # 模型名,与音色配对(见下方模型族对照)
    voice_id_env: QWEN3_VOICE_SUYAO  # 存放 voice-id 的环境变量名
```

`voice-id` 放在 `.env`(和 `DASHSCOPE_API_KEY` 一样),**不提交到 git**。每个协作者可以
复刻/设计自己的音色,互不干扰、不会串模型。

**旁白不配音**:只有角色行会合成语音(narration 行没有音频),所以不需要给旁白配置音色。

---

## 〇、两个模型族(重要)

`model` 字段决定 provider 走哪条协议,两个族**端点、参数、音色库都不同**:

| | `cosyvoice*`(v3-flash / v3.5-flash …) | `qwen3-tts*`(flash / instruct-flash / vc / vd) |
| --- | --- | --- |
| 端点 | SpeechSynthesizer(HTTP SSE) | multimodal-generation(HTTP SSE) |
| 语速/音调/音量/种子 | `rate`/`pitch`/`volume`/`seed` 支持 | **不支持**,发送前自动丢弃 |
| 采样率 | `synthesis.sample_rate` 配置(支持 22050/24000/44100/48000…) | **固定 24000 Hz**(WAV 剥头后 PCM) |
| 逐请求指令 | `instruction`(≤100 字符,汉字按 2 计) | 仅 `-instruct-` 模型支持 `instructions`(≤1600 Token,中英文) |
| 系统音色 | `long*` 拼音系(longanyang、longxiaochun_v3…) | 英文人名系(Cherry、Serena、Ethan、Chelsie…)含方言音色 |
| 复刻/设计 | 免费;参考音频 ≥16kHz | 免费;参考音频 **≥24kHz 单声道** |

**音色不跨族互用**(官方 FAQ:音色创建时绑定目标模型)。cosyvoice 复刻的 id
(`cosyvoice-…-` 前缀)不能配 qwen3 模型,反之亦然;启动校验会按 id 前缀拦截并提示。

**使用 qwen3-tts 族时**,`config.yaml` 的 `media.audio.synthesis.sample_rate` 必须设为
`24000`(cosyvoice 也支持 24 kHz,混布两族时统一 24k 即可,启动校验会拦截不一致)。

---

## 一、三种音色来源

### 1. 系统音色(零配置)

DashScope 提供现成音色,直接复制音色名即可使用,无需任何上传:

| 模型族 | 模型 | 音色 voice 参数 | 特征 |
| --- | --- | --- | --- |
| cosyvoice | cosyvoice-v3-flash | `longanyang` | 阳光大男孩,20~30 岁 |
| cosyvoice | cosyvoice-v3-flash | `longanhuan` | 欢脱元气女,20~30 岁 |
| cosyvoice | cosyvoice-v3-flash | `longxiaochun_v3` | 知性积极女,25~30 岁 |
| cosyvoice | cosyvoice-v3-flash | `longhuhu_v3` | 天真烂漫女童,6~10 岁 |
| qwen3-tts | qwen3-tts-flash | `Cherry` | 阳光年轻女(中英) |
| qwen3-tts | qwen3-tts-flash | `Serena` | 温柔女(中英) |
| qwen3-tts | qwen3-tts-flash | `Ethan` | 北方口音阳光男(中英) |
| qwen3-tts | qwen3-tts-flash | `Chelsie` | 二次元少女(中英) |
| qwen3-tts | qwen3-tts-flash | `Jada`/`Dylan`/`Sunny` 等 | 方言音色(上海话/北京话/四川话…) |

完整列表见阿里云文档 [CosyVoice 音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)
与 [Qwen-TTS 音色列表](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list)。

**注意:音色必须与模型族配对使用**(`cosyvoice-v3-flash` 不能配 `Cherry`,`qwen3-tts-flash`
不能配 `longxiaochun_v3`)。

### 2. 声音复刻(克隆,上传音频)

百炼控制台 → 左侧选择**目标语音合成模型** → 右侧体验区 →「复刻音色」。

音频要求:

- 时长 10~20 秒
- 人声干净、无背景噪声(有噪声可开启控制台预处理)
- cosyvoice 系:建议 16 kHz 以上,单声道 WAV 或 MP3
- qwen3-tts 系:**采样率 ≥24 kHz、仅单声道**
- 建议单声道 WAV

填写 Prefix(如 `suyao`)提交,生成后音色同步到音色列表,得到 voice-id
(cosyvoice 形如 `cosyvoice-v3-flash-suyao-xxxxxx`,格式 `{模型}-{prefix}-{唯一标识}`)。
**两族复刻均免费。**

### 3. 声音设计(纯文字描述,无音频)

百炼控制台 → 选择**目标模型** →「设计音色」→ 填写声音描述:

> 沉稳的青年女性,音色清亮偏冷,语速平稳,吐字清晰,适合用于剧情对白。

描述要点:具体而非模糊("低沉""清脆"而非"好听");多维度(性别、年龄、音调、语速、
情感、特点、用途);客观而非模仿(不要描述具体名人)。描述 ≤ 500 字符。

生成后可先试听预览,满意后复制 voice-id。**两族设计均免费。**

---

## 二、绑定音色

### 1. 填 `.env`

```dotenv
DASHSCOPE_API_KEY=sk-xxxx            # 你的百炼 API Key(北京地域)
# cosyvoice 族
COSYVOICE_VOICE_SUYAO=cosyvoice-v3-flash-suyao-xxxxxx   # 复刻/设计音色的 voice-id
COSYVOICE_VOICE_SYSTEM_SAMPLE=longanyang               # 系统音色直接填音色名
# qwen3-tts 族(需对该族模型复刻/设计后取得,不能沿用上面的 cosyvoice id)
QWEN3_VOICE_SUYAO=qwen3-tts-vc-suyao-xxxxxx
QWEN3_VOICE_SYSTEM_SAMPLE=Cherry
```

### 2. `voices.yaml` 引用

角色通过 `config.yaml` 的 `voice_profile` 引用 `voices.yaml` 中的逻辑音色:

```yaml
# config.yaml
characters:
  suyao:
    name: 苏遥
    voice_profile: suyao_main
```

```yaml
# voices.yaml — qwen3-tts 复刻音色
version: 3
profiles:
  suyao_main:
    semantic:
      base_description: 年轻女性，音色清亮偏冷，表达克制。
    providers:
      dashscope:
        model: qwen3-tts-vc-2026-01-22
        voice_id_env: QWEN3_VOICE_SUYAO
        instruction_mode: none
```

```yaml
# voices.yaml — cosyvoice 系统音色(备选)
#   model: cosyvoice-v3-flash
#   voice_id_env: COSYVOICE_VOICE_SUYAO
```

### 3. 可选字段

```yaml
providers:
  dashscope:
    model: qwen3-tts-vc-2026-01-22
    voice_id_env: QWEN3_VOICE_SUYAO
    voice_revision: 2          # 默认 1;在控制台重新复刻同一音色后 +1(使旧音频缓存失效)
    instruction_mode: none     # 默认 free;见下
```

`instruction_mode` 决定情绪/语气指令的格式:

| 模式 | 适用 | 说明 |
| --- | --- | --- |
| `free`(默认) | 复刻/设计音色 | 任意自然语言指令,≤ 100 字符(汉字按 2 字符计);qwen3 侧仅 `-instruct-` 模型生效(映射为 `instructions`) |
| `fixed_emotion` | 支持 Instruct 的系统音色 | 固定格式 `你说话的情感是<emotion>。` |
| `none` | 不支持指令的音色/模型 | 不发送指令(qwen3-tts 的 vc/vd/普通 flash 模型建议此档) |

`fixed_emotion` 模式可用的 `emotion` 枚举:`neutral`、`fearful`、`angry`、`sad`、
`surprised`、`happy`、`disgusted`。

### 4. 从 CosyVoice 迁移到 qwen3-tts

1. 百炼控制台对 qwen3-tts 系模型(qwen3-tts-vc 复刻 / qwen3-tts-vd 设计)重新创建音色,
   把新 voice-id 填入 `.env` 的新变量(如 `QWEN3_VOICE_SUYAO`);
2. `voices.yaml` 对应档案:`model` 改为 qwen3 模型名、`voice_id_env` 指向新变量,
   `instruction_mode` 非 instruct 模型改 `none`;
3. `config.yaml`:`media.audio.synthesis.sample_rate: 24000`;
4. 若音色是重新复刻的,`voice_revision` +1 使旧缓存失效(不同 model 本身也会改变缓存键)。

---

## 三、验证

```bash
cp .env.example .env      # 填入你的 key 和 voice-id
npm install
npm run dev               # 启动后播放剧情,应听到对应音色的语音
```

或单独探针合成一次(不启动游戏;按 voices.yaml 的模型族自动选择协议与端点):

```bash
node scripts/probe-tts-params.mjs suyao_main "苏遥轻轻地笑了。"
# 期望输出: OK: <N> PCM bytes (suyao_main: <voice-id> @24000Hz), first chunk at <M>ms
```

---

## 四、排错

| 症状 | 原因 | 解决 |
| --- | --- | --- |
| 启动报错 "DashScope TTS env incomplete" | `.env` 缺 voice-id | 按报错列出的变量名补全(如 `QWEN3_VOICE_SUYAO`) |
| 启动报错 "model config invalid — …音色不互用" | voice-id 与模型不同族(cosyvoice id 配 qwen3 模型等) | 在控制台对正确模型重新复刻/设计,或把 `model` 改回对应族 |
| 启动报错 "sample_rate 必须 24000" | voices.yaml 有 qwen3 档案但 `synthesis.sample_rate` 不是 24000 | 改 `config.yaml` 的 `media.audio.synthesis.sample_rate: 24000` |
| 合成报 400 / voice 无效 | voice-id 与该模型不配对(同族内串模型也可能报错) | 确认 voice-id 前缀的模型名与 `voices.yaml` 的 `model` 一致 |
| 合成报地域错误 | 用了新加坡地域的 API Key | 本项目合成走北京地域,换成北京地域的 API Key |
| 换了音色但声音没变 | 音频缓存未失效 | 该角色的 `voice_revision` +1 |
| qwen3 指令不生效 | 非 `-instruct-` 模型不支持逐请求指令 | 换 `qwen3-tts-instruct-flash`,或接受 vc 音色本声 |
| 语速/音调参数没效果 | qwen3-tts 族不支持 rate/pitch/volume/seed | 属预期(协议差异);需要参数控制请用 cosyvoice 族 |
| 复刻音色效果差 | 参考音频有噪声/过短 | 用 10~20 秒干净人声重录(qwen3 需 ≥24kHz 单声道),控制台可开预处理 |
| 旁白没有声音 | 设计如此 | 旁白不配音,只有角色行合成语音 |

---

## 参考

- [语音合成模型总览](https://help.aliyun.com/zh/model-studio/tts-model)
- [CosyVoice 音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)
- [Qwen-TTS 音色列表](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list)
- [Qwen-TTS 非实时 API 参考](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
- [实时语音合成用户指南(指令控制)](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [声音复刻用户指南](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)
- [声音设计用户指南](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)
