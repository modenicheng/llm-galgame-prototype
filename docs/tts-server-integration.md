# 本地 TTS Server 接入指南（OpenAI 协议）

接入视角的指南：任何讲 **OpenAI 协议**的客户端/服务要**消费本机 TTS**，或者要把
**另一个 OAI 协议服务**接进本仓库，看这一篇。部署、构建、音色制作与排障见
[docs/local-tts.md](local-tts.md)；这台机器的实况路径、端口与实测数字见
[tts-server/README.md](../tts-server/README.md)。

## 1. 服务一览

| 引擎 | 默认地址 | 协议 | 定位 |
|---|---|---|---|
| A：qwentts.cpp | `http://127.0.0.1:9766` | **OpenAI 兼容**（`/v1/audio/speech`） | 默认 |
| B：仓库 `tts-server/server.py` | `http://127.0.0.1:9765` | 私有方言（`POST /tts` + `X-Audio-*` 头） | 回退 |

两引擎输出同规格音频：**s16le / 24 kHz / 单声道 PCM**。这正好是 OpenAI `pcm`
格式的定义（24 kHz 16-bit LE mono），按 OAI 规范消费即可。

接入前提（ applies to 两引擎）：

- **无鉴权、无 TLS**。仓库启动脚本 `start-qwentts.cmd` 现绑 `0.0.0.0`——开放
  内网，供局域网内另一台虚拟主播取流（本机客户端仍走 `127.0.0.1`）；暴露面
  = 整个内网，跨不可信网络要自己加鉴权/反代（服务没有），仅本机使用可改回
  `--host 127.0.0.1`。音色参考音频与 latent 属内容资产，不出机器、不进 git。
- 引擎 A 的 CORS 放开（GET/POST/DELETE/OPTIONS + Content-Type），浏览器页面可直连。
- 启动：引擎 A 用仓库 `tts-server\start-qwentts.cmd`（起服务 + 注册音色一步到位）；
  引擎 B 见 docs/local-tts.md 引擎 B 一节。

## 2. 引擎 A 的 OAI 端点

| 方法与路径 | 作用 |
|---|---|
| `POST /v1/audio/speech` | 合成（核心端点，见下） |
| `GET /v1/models` | 单模型对象（别名，本机为 `local-qwen3-tts`） |
| `GET /v1/audio/voices` | 可用音色名列表（内置 speaker + 已注册克隆） |
| `POST /v1/audio/voices` | 注册克隆音色：`{name, ref_text, wav_b64}`（服务端抽 latent）或 `{name, ref_text, spk_b64, rvq_b64}`（直交 latent） |
| `DELETE /v1/audio/voices/{name}` | 注销克隆音色 |
| `GET /health` | 存活探针，`{"status":"ok"}` |

### POST /v1/audio/speech

请求体（JSON）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `input` | ✓ | 要念的文本 |
| `voice` | ✓ | 音色名。本机现注册五个：`paimeng` / `xuwanqing` / `linxiaoman` / `xiayiming` / `hanche`（以 `GET /v1/audio/voices` 实查为准） |
| `response_format` | | `pcm`（**默认**，分块流）/ `wav`（一次性 RIFF 文件）。只实现这两种；要 mp3 等自行转码 |
| `model` | | 忽略（单模型服务；SDK 必须带时填 `local-qwen3-tts`） |
| `instructions` / `speed` | | 解析后忽略（克隆路径无该控制） |
| `seed` / `temperature` / `top_k` / `top_p` / `max_new_tokens` / `repetition_penalty` | | 可选采样覆盖；缺省用引擎默认；固定 `seed` 可复现 |

响应：

- `pcm`：chunked `audio/pcm`，**边合成边推流**（实时），首句合成完即出首块。
  响应头只有 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`（防代理缓冲），
  **没有音频元数据头**——规格按 OAI pcm 定义理解，不要猜头。
- `wav`：一次性 `audio/wav`（整句合成完才返回）。
- 错误：OAI 风格 error JSON。请求/音色校验失败 → `400 invalid_request_error`；
  合成失败 → `502 server_error`；后端无注册能力 → `501`。

⚠ **音色注册表在进程内存**：引擎重启即空，必须重新注册。游戏侧由
`start-qwentts.cmd` 收尾的 `tools/register_qwentts_voices.py` 完成；**别的服务
自己拉起引擎时要补这一步**，否则所有请求 400 unknown voice。

连接层参数（消费方容量/超时规划）：读超时 60s、写超时 120s、请求体上限 32MB、
`TCP_NODELAY` 开（小块即发）。注意 Windows 下同端口重复绑定**不报错**：双实例
会静默共存、互相抢端口（`netstat -ano` 出现两条 9766 LISTEN 即实锤），处置见
docs/local-tts.md 排障表。

## 3. 消费端典型接法

### 3.1 curl 验活

```bash
# 一次性 wav 文件
curl -X POST http://127.0.0.1:9766/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"你好呀，我是树莓娘。","voice":"paimeng","response_format":"wav"}' \
  -o out.wav

# pcm 裸流（无 RIFF 头），回放：
#   ffplay -f s16le -ar 24000 -ac 1 out.pcm
curl -X POST http://127.0.0.1:9766/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"你好呀，我是树莓娘。","voice":"paimeng"}' \
  --no-buffer -o out.pcm
```

### 3.2 OpenAI SDK（Python）

```python
from openai import OpenAI

# api_key 不校验，占位非空即可；base_url 指到 /v1
client = OpenAI(base_url="http://127.0.0.1:9766/v1", api_key="local")

# 一次性拿 wav 文件
client.audio.speech.create(
    model="local-qwen3-tts", voice="paimeng",
    input="欢迎来到网络协会的展位！", response_format="wav",
).write_to_file("out.wav")

# 流式读 pcm，边收边播
with client.audio.speech.with_streaming_response.create(
    model="local-qwen3-tts", voice="xuwanqing",
    input="投票我先收着。", response_format="pcm",
) as r:
    for chunk in r.iter_bytes():
        ...  # s16le/24k/mono，直接喂播放器
```

### 3.3 fetch 流式（浏览器 / Node 18+）

```js
const ctrl = new AbortController();
const res = await fetch("http://127.0.0.1:9766/v1/audio/speech", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input, voice: "hanche", response_format: "pcm" }),
  signal: ctrl.signal,
});
const reader = res.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  playPcmChunk(value); // s16le/24k/mono
}
// 取消 = 断开：ctrl.abort() 后服务端即停
```

没有 SSE、没有 JSON 包装——就是裸二进制分块流；OAI 客户端（各种 TTS 封装库）
按标准 pcm 处理即可。

### 3.4 取消与超时语义

- **取消 = 断开连接**。引擎 A 实时生成，断即停；引擎 B 按句取消，在飞句跑完、
  后续句不再进批。
- 超时只该卡**首包**（连接建立 → 第一个字节）。游戏侧 120s；注意引擎 B 冷启动
  有 4–7 分钟编译预热，预热完成前首包必超——就绪后再接流量。
- 长文本不需要一次到齐：服务按句出声，边收边播即可。

## 4. 容量与限制

- **批宽 4**（`--max-batch`）：≤4 路并发共享批处理、吞吐最优（本机四路吞吐
  RTF ~0.13–0.20，流式首包 ~530ms）；更高并发排队。游戏侧
  `synthesis.max_concurrency: 3`——有意低于批宽，让一路给局域网内另一台
  虚拟主播取流。
- 24 kHz 固定输出；speed / rate / 音量 / 音高 / 逐请求指令均不支持。
- 单 GPU 单实例；模型常驻显存（~2.4 GB Q8）。

## 5. 本仓库的接线（参照实现）

游戏本体就是本服务最完整的消费端参考，四处：

1. **配置** `config.yaml` → `media.audio.synthesis`：`provider: local`、
   `max_concurrency: 3`（低于批宽：给局域网另一台虚拟主播让一路推理）、
   `format: pcm_s16le`、`sample_rate: 24000`（启动校验拦截）。
2. **音色绑定** `voices.yaml` → `providers.local`：
   `{model: local-qwen3-tts, voice: <引擎音色名>, voice_revision: N}`，
   再由 `characters.<key>.voice_profile` 绑到角色。`voice_revision` 在重建音色后
   +1 使音频缓存失效。
3. **适配器** `src/adapters/tts/local-qwen3-tts-provider.ts`：实现
   `core/ports/tts-provider-port.ts` 的 `start(request, signal) → {metadata,
   chunks, completion}`（PCM 异步流 + 完成态 Promise）。方言 `openai`（默认）|
   `tts-server` 双分支；env `LOCAL_TTS_BASE_URL` / `LOCAL_TTS_DIALECT` 覆盖。
   错误分类：`canceled` / `connection` / `http_<status>` / `first_chunk_timeout`
   （首包看门狗 120s，后续句排队不触发）。
4. **装配与降级** `src/bootstrap/create-runtime-application.ts`（§7.6）：按
   config 选 provider；**引擎不在时游戏照常跑**——单句重试耗尽后该句降级纯文本，
   不阻塞播放。取消链：上层 AbortSignal → fetch body 销毁 → 服务端视为断开。

## 6. 接入另一个 OAI 协议服务

- **TTS 形态（对方实现了 `/v1/audio/speech`）**：零代码。`LOCAL_TTS_BASE_URL`
  指过去即可（方言保持 `openai`）。只有私有协议才需要加 dialect 分支——
  provider 里 `openai` / `tts-server` 双分支是现成样板，配
  `local-qwen3-tts-provider.test.ts` 的注入 fetch 测试样式，以及
  `create-runtime-application.ts` 的 env 接线。
- **LLM 形态（`/v1/chat/completions`）**：不走 TTS 链。用
  `generation.model / base_url / api_key_env` 与 `agents.<name>.*` 三件套
  （适配器在 `src/adapters/llm/openai-compatible-generator.ts`），本机服务
  api_key 照样随便填（`api_key_env` 指一个非空 env 即可）。
- **其他能力**：按既有分层走——`core/ports` 定义端口 → `adapters/` 写 OAI
  适配器 → config + env 接线 → mock 与降级路径 → 注入依赖的测试。
  测试纪律：只锁不变量，不 pin 生产配置内容。

## 7. 常见坑速查

| 症状 | 原因与处置 |
|---|---|
| 400 unknown voice | 引擎重启后没重新注册（注册表在内存）；先 `GET /v1/audio/voices` 自查名字 |
| pcm 存成文件播放不出 | `pcm` 是无头裸流；要文件就 `response_format:"wav"`，或播放器指定 `-f s16le -ar 24000 -ac 1` |
| 隔 nginx 拿不到流 | 显式 `proxy_buffering off`（服务已带 `X-Accel-Buffering: no`，老版本 nginx 不认） |
| 采样率猜错、声音变速 | 别猜响应头（引擎 A 不回 `X-Audio-*`）；固定按 24000 处理 |
| 首包超时 | 引擎 B 冷启动编译预热中；或引擎根本没起（游戏侧此时表现为该句静默降级纯文本） |
| 想要 mp3/opus | 服务只出 pcm/wav，自行用 ffmpeg 转码 |
| 升级 qwentts.cpp/ggml 后吞吐崩 | 上游 ggml 0572d60+ 有 `--max-batch>1` 回归；升级前先 `bench_qwentts.py --par 4` 验证（详见 tts-server/README 勘误） |
