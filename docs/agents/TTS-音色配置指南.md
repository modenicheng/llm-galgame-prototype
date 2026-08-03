# TTS 音色配置指南

本文面向协作者:如何**创建**自己的音色(三种方式),以及如何把它**绑定**到游戏里。

音色的核心只有两个字段:

```yaml
providers:
  dashscope:
    model: cosyvoice-v3-flash   # 模型名,与音色配对
    voice_id_env: COSYVOICE_VOICE_SUYAO  # 存放 voice-id 的环境变量名
```

`voice-id` 放在 `.env`(和 `DASHSCOPE_API_KEY` 一样),**不提交到 git**。每个协作者可以
复刻/设计自己的音色,互不干扰、不会串模型。

**旁白不配音**:只有角色行会合成语音(narration 行没有音频),所以不需要给旁白配置音色。

---

## 一、三种音色来源

### 1. 系统音色(零配置)

DashScope 提供现成音色,直接复制音色名即可使用,无需任何上传:

| 模型 | 音色 voice 参数 | 特征 |
| --- | --- | --- |
| cosyvoice-v3-flash | `longanyang` | 阳光大男孩,20~30 岁 |
| cosyvoice-v3-flash | `longanhuan` | 欢脱元气女,20~30 岁 |
| cosyvoice-v3-flash | `longxiaochun_v3` | 知性积极女,25~30 岁 |
| cosyvoice-v3-flash | `longhuhu_v3` | 天真烂漫女童,6~10 岁 |

完整列表见阿里云文档 [CosyVoice 音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)。

**注意:音色必须与模型配对使用**(`cosyvoice-v3-flash` 只能配 v3-flash 音色,不能配
`longxiaochun_v2` 等 v2 音色)。

### 2. 声音复刻(克隆,上传音频)

百炼控制台 → 左侧选择语音合成模型(如 `CosyVoice-v3-Flash`)→ 右侧体验区 →「复刻音色」。

音频要求:

- 时长 10~20 秒
- 人声干净、无背景噪声(有噪声可开启控制台预处理)
- 建议 16 kHz 以上、单声道 WAV 或 MP3

填写 Prefix(如 `suyao`)提交,生成后音色同步到音色列表,得到 voice-id:

```
cosyvoice-v3-flash-suyao-xxxxxx
```

格式固定为 `{模型}-{prefix}-{唯一标识}`。**CosyVoice 系列复刻免费。**

### 3. 声音设计(纯文字描述,无音频)

百炼控制台 → 选择模型 →「设计音色」→ 填写声音描述:

> 沉稳的青年女性,音色清亮偏冷,语速平稳,吐字清晰,适合用于剧情对白。

描述要点:具体而非模糊("低沉""清脆"而非"好听");多维度(性别、年龄、音调、语速、
情感、特点、用途);客观而非模仿(不要描述具体名人)。描述 ≤ 500 字符。

生成后可先试听预览,满意后复制 voice-id。**CosyVoice 系列设计免费。**

---

## 二、绑定音色

### 1. 填 `.env`

```dotenv
DASHSCOPE_API_KEY=sk-xxxx            # 你的百炼 API Key(北京地域)
COSYVOICE_VOICE_SUYAO=cosyvoice-v3-flash-suyao-xxxxxx   # 复刻/设计音色的 voice-id
COSYVOICE_VOICE_SYSTEM_SAMPLE=longanyang               # 系统音色直接填音色名
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
# voices.yaml
version: 3
profiles:
  suyao_main:
    semantic:
      base_description: 年轻女性，音色清亮偏冷，表达克制。
    providers:
      dashscope:
        model: cosyvoice-v3-flash
        voice_id_env: COSYVOICE_VOICE_SUYAO
```

### 3. 可选字段

```yaml
providers:
  dashscope:
    model: cosyvoice-v3-flash
    voice_id_env: COSYVOICE_VOICE_SUYAO
    voice_revision: 2          # 默认 1;在控制台重新复刻同一音色后 +1(使旧音频缓存失效)
    instruction_mode: free     # 默认 free;见下
```

`instruction_mode` 决定情绪/语气指令的格式:

| 模式 | 适用 | 说明 |
| --- | --- | --- |
| `free`(默认) | 复刻/设计音色 | 任意自然语言指令,≤ 100 字符(汉字按 2 字符计) |
| `fixed_emotion` | 支持 Instruct 的系统音色 | 固定格式 `你说话的情感是<emotion>。` |
| `none` | 不支持 Instruct 的音色 | 不发送指令 |

`fixed_emotion` 模式可用的 `emotion` 枚举:`neutral`、`fearful`、`angry`、`sad`、
`surprised`、`happy`、`disgusted`。

---

## 三、验证

```bash
cp .env.example .env      # 填入你的 key 和 voice-id
npm install
npm run dev               # 启动后播放剧情,应听到对应音色的语音
```

或单独探针合成一次(不启动游戏):

```bash
node scripts/probe-tts-params.mjs suyao_main "苏遥轻轻地笑了。"
# 期望输出: OK: <N> PCM bytes (suyao_main: <voice-id>), first chunk at <M>ms
```

---

## 四、排错

| 症状 | 原因 | 解决 |
| --- | --- | --- |
| 启动报错 "DashScope TTS env incomplete" | `.env` 缺 voice-id | 按报错列出的变量名补全(如 `COSYVOICE_VOICE_SUYAO`) |
| 合成报 400 / voice 无效 | voice-id 与该模型不配对(串模型) | 确认 voice-id 前缀的模型名与 `voices.yaml` 的 `model` 一致 |
| 合成报地域错误 | 用了新加坡地域的 API Key | 本项目合成走北京地域,换成北京地域的 API Key |
| 换了音色但声音没变 | 音频缓存未失效 | 该角色的 `voice_revision` +1 |
| 复刻音色效果差 | 参考音频有噪声/过短 | 用 10~20 秒干净人声重录,控制台可开预处理 |
| 旁白没有声音 | 设计如此 | 旁白不配音,只有角色行合成语音 |

---

## 参考

- [CosyVoice 音色列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)
- [实时语音合成用户指南(指令控制)](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [声音复刻用户指南](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)
- [声音设计用户指南](https://help.aliyun.com/zh/model-studio/voice-design-user-guide)
