# 本地 TTS 推理引擎（synthesis.provider: local）

`media.audio.synthesis.provider: local` 时，台词合成走本机 GPU 推理服务，
不经云端、不需要任何 TTS API key。语音管线的其余部分（预取、缓存、播放、
跳行取消）与 DashScope 模式完全一致；云端音色的创建与绑定见
[TTS-音色配置指南](agents/TTS-音色配置指南.md)。
接入消费视角（OAI 协议客户端/第三方服务对接本服务，或本仓库接入另一个
OAI 协议服务）见 [tts-server-integration.md](tts-server-integration.md)。

引擎实现与本仓库的关系：

- **引擎 A：qwentts.cpp（默认）** —— 第三方 C++/GGML 推理引擎，部署在仓库外
  （任选目录），游戏经 HTTP 对接。本仓库只含客户端与胶水脚本。
- **引擎 B：Python tts-server（回退）** —— 本仓库 `tts-server/` 自带的
  FastAPI 服务，功能等价、性能较低，作引擎 A 不可用时的兜底。

## 协议契约与游戏侧配置

- 两个引擎都输出**固定 24 kHz s16le 单声道 PCM 流**；
  `media.audio.synthesis.sample_rate` 必须为 24000（启动校验拦截）。
- 方言由环境变量选择（provider 内建两种 wire 格式）：
  | 方言 | 引擎 | 默认地址 | 请求形态 |
  |---|---|---|---|
  | `openai`（默认） | A | `http://127.0.0.1:9766` | `POST /v1/audio/speech {model, input, voice, response_format:"pcm"}` |
  | `tts-server` | B | `http://127.0.0.1:9765` | `POST /tts {text, voice}` |
  `LOCAL_TTS_BASE_URL` 覆盖地址，`LOCAL_TTS_DIALECT` 切换方言（设为
  `tts-server` 即回退引擎 B）。
- 音色绑定在 `voices.yaml` 的 `providers.local`：

  ```yaml
  <profile_id>:
    semantic: { … }
    providers:
      local:
        model: local-qwen3-tts
        voice: <引擎音色键>      # 见各引擎的音色注册
        voice_revision: 1        # 重建音色后 +1 使音频缓存失效
  ```

  本地音色键是引擎注册表里的名字，不是密钥，不走 `.env`。
- 合成忽略 rate/pitch/volume/seed 与逐请求指令（克隆路径无此控制），
  语义同 DashScope 的 qwen3-tts-vc 族。
- `synthesis.max_concurrency` 建议与引擎批处理宽度一致（引擎 A 为
  `--max-batch`，默认 4；引擎 B 为 `TTS_MAX_BATCH`，默认 4）。
- 引擎未启动时游戏照常运行：每句合成重试耗尽后该句降级为纯文本，不阻塞播放。

## 引擎 A：qwentts.cpp（推荐）

C++17/GGML 移植版 Qwen3-TTS-12Hz。上游：<https://github.com/ServeurpersoCom/qwentts.cpp>，
GGUF 权重：<https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF>。
单模型（talker + 12Hz codec）承载任意多克隆音色，帧级流式，服务端 GPU 批处理。
显存需求：Q8_0 量化约 2.5 GB（BF16 约 4.3 GB），8GB 级消费 GPU 即可四路并行。

### 构建（Windows + CUDA 示例）

```bash
git clone --recurse-submodules https://github.com/ServeurpersoCom/qwentts.cpp.git
cd qwentts.cpp
cmake -S . -B build -G Ninja -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release ^
      -DCMAKE_CUDA_COMPILER="<CUDA 工具包>/bin/nvcc.exe"
cmake --build build
```

Linux/macOS 直接用上游 `buildcuda.sh` / `buildcpu.sh`。**Windows 注意**：
MSVC 生成器要求 VS 安装了 CUDA 集成组件，缺失时报
`No CUDA toolset found`（cmake 自动选中的 VS 实例往往没有）——
用上面的 Ninja 生成器 + 显式 `CMAKE_CUDA_COMPILER` 可完全绕开。

### 模型

从 GGUF 仓库下载两个文件放进 `models/`（对质量与显存均衡推荐 Q8_0；
更低显存选 Q4_K_M，质量优先选 BF16）：

- `qwen-talker-1.7b-base-Q8_0.gguf`（talker，约 2.1 GB）
- `qwen-tokenizer-12hz-Q8_0.gguf`（codec，约 291 MB）

下载慢可用 `aria2c -x16` 分片；上游提供 sha256，下载后应校验。

### 音色制作与注册

克隆音色的输入是「参考音频 + 逐字转写」：

1. 准备 8~15 秒干净人声 `ref.wav` 和转写 `ref.txt`（内容资产自备，
   **不入库**——含派生 latent，见下方 gitignore 约定）。
2. 预编码 latent（一次即可，运行期 bit 级复用）：

   ```bash
   ./build/qwen-codec --model models/qwen-tokenizer-12hz-Q8_0.gguf ^
        --talker models/qwen-talker-1.7b-base-Q8_0.gguf -i ref.wav
   # → ref.spk（说话人向量）+ ref.rvq（参考码），与 ref.wav/ref.txt 放同一目录
   ```

3. 启动服务（注册表在进程内存，重启后需重新注册）：

   ```bash
   ./build/tts-server --model models/qwen-talker-1.7b-base-Q8_0.gguf ^
        --codec models/qwen-tokenizer-12hz-Q8_0.gguf ^
        --alias local-qwen3-tts --host 127.0.0.1 --port 9766 --lang auto --max-batch 4
   ```

4. 注册音色——对每个音色 `POST /v1/audio/voices`：

   ```json
   {"name": "<音色键>", "ref_text": "<转写>", "spk_b64": "<…>", "rvq_b64": "<…>"}
   ```

   仓库脚本 `tts-server/tools/register_qwentts_voices.py` 会扫描目录里的
   `*.spk` 逐个注册（`--voices-dir` 指向 latent 目录）。仓库另附
   `tts-server/start-qwentts.cmd`：起服务 + 注册一键完成（部署根目录用
   `QWENTTS_HOME` 环境变量指定）。
5. `voices.yaml` 绑定 `voice: <音色键>` 即可。

冒烟验证：

```bash
curl http://127.0.0.1:9766/v1/audio/voices
curl -X POST http://127.0.0.1:9766/v1/audio/speech -H "Content-Type: application/json" ^
     -d "{\"model\":\"local-qwen3-tts\",\"input\":\"你好\",\"voice\":\"<音色键>\",\"response_format\":\"pcm\"}"
```

### 参考性能量级

消费级笔记本 GPU（8GB，50 系，Q8_0）实测参考：单句 RTF ≈ 0.3（约 3 倍实时），
流式首包 ≈ 0.5s，四路并发吞吐 RTF ≈ 0.1，无预热。本机部署的实测数字与
样本位置见 `tts-server/README.md`（本地文件，不入库）。

## 引擎 B：Python tts-server（回退）

`tts-server/server.py`（FastAPI）：请求文本按句切组，单 GPU worker 以
「浪」为单位把多个请求的下一句合成一个 batch，句子粒度流式推送、句子间可取消。
与引擎 A 使用同一批参考音频，但 latent 格式不同（`voices/prompts/*.pt`，
由 `tts-server/tools/build_voices.py` 构建）。

```bash
cd tts-server
uv venv --python 3.11 .venv
# torch 必须是 CUDA 构建——PyPI 的 Windows 轮是 CPU 版：
uv pip install --python .venv torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv qwen-tts fastapi uvicorn aiohttp triton-windows
.venv/Scripts/python.exe server.py        # 127.0.0.1:9765
```

- 模型权重默认按 HF id `Qwen/Qwen3-TTS-12Hz-1.7B-Base` 自动下载，
  `TTS_MODEL_DIR` 指向本地目录可跳过。
- 首次启动做 torch.compile 预热，需数分钟；inductor 缓存落盘后重启加快。
  `TTS_COMPILE=0` 可关闭编译（RTF 约 3，仅排障用）。
- `fastpath.py` 在运行期做三处优化（monkeypatch，不改 site-packages）：
  cuDNN attention 优先（部分新架构 GPU 上 torch 预编译的 flash/mem-efficient
  SDPA 内核缺失会静默回退到慢的 math 路径）、子 talker 手写 KV 解码环
  （贪心 A/B 与原实现逐位一致）、dynamo recompile 上限抬升（默认值会被
  prefill/decode × batch 的 guard 组合烧穿，导致批处理永久回退 eager）。

## 新增一个角色音色（通用流程）

1. 准备参考音频（8~15s 干净人声）与逐字转写——这是两引擎通用的输入。
2. 引擎 A：按上文预编码 + 注册；引擎 B：把参考音与转写交给
   `tools/build_voices.py`（内置音色转克隆的合成年线亦在该脚本）。
3. `voices.yaml` 加 profile 并在 `config.yaml` 的 `characters` 绑定。
4. 之后每次重建音色，`voice_revision` +1。

## 标点兼容与节奏控制（两引擎通用）

qwen3-tts **没有任何内联节奏标签**：DashScope 的情感/富语言标签
（`[sad]`、`[laughing]`…）属于另一条 Qwen-Audio-TTS 产品线；`<break>`/SSML
不支持；`instructions` 参数只有 qwen3-tts-instruct\* 云端模型接受，且是整句
风格描述而非逐点控制。**停顿只来自标点本身**（外加播放侧的
`pause_before_ms`/`pause_after_ms`，见 performance-compiler）。

模型词表外的标点会被**静默丢弃**。2026-09-19 用固定种子探针
（`tts-server/tools/probe_punct.py`，间隙=帧 RMS 静音分析）实测引擎 A：

| 输入 | 实测行为 |
|---|---|
| 行尾 `——`（话被打断） | 只多 ~0.1s 衰减 ≈ 被吞；`……` 则产生可闻的渐弱尾音 |
| 句中 `——` | 停顿 0.2~0.7s 随上下文波动（同位置逗号 ~0.44s）——时有时无，正是「偶尔被静默吞掉」听感的来源；`……` 是模型原生犹豫标记，稳定 |
| 数字区间 `三千——五千` | 连读无停顿（语义有风险），`到` 版本读法自然 |
| `～` / `·` | 无垃圾音、无错误停顿——**保持原样**，加停顿反而破坏节奏 |

游戏侧适配（`src/application/audio/qwen3-text-compat.ts`，在
AudioDescriptorFactory 内按 `qwen3-tts` 模型族门控）：破折号族
（`——`/`—`/`–`/`--`/LLM 分隔线等）→ `……`；数字区间 → `到`；其余标点不动。
适配发生在 cacheKey 之前，因此旧的「吞破折号」缓存音频会自动失效重合成。
探针用法：

```bash
cd tts-server && python tools/probe_punct.py --out /tmp/punct-probe
```

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| 合成 502 / connection refused | 引擎没起或端口不符；先 `curl /health` |
| 重启引擎后报 unknown voice | 注册表在内存，重跑注册脚本 |
| first_chunk_timeout | 引擎预热中（引擎 B 首启）或长句排队；看引擎日志 |
| 请求打到错误路径（/tts vs /v1/audio/speech） | 方言与引擎不匹配，检查 `LOCAL_TTS_DIALECT` |
| 换了音色但听到旧声 | bump `voice_revision`（浏览器音频缓存按它失效） |
