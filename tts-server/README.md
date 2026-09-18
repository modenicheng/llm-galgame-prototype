# tts-server — 本地 TTS（本机实况档）

> 通用部署指南（两引擎、构建、音色制作、排障）在仓库
> [`docs/local-tts.md`](../docs/local-tts.md)；本文件只记**这台机器**的
> 实际路径、端口、实测数字与样本位置，不入库。

## 当前部署（2026-09-18 迁移至稳定位置）

- **引擎 A（默认）：qwentts.cpp，`D:\tools\qwentts.cpp`**
  - 构建：Ninja + vcvars + 显式 nvcc（CUDA 13.1，sm_120）——配方在
    `D:\tools\qwentts.cpp\mybuild.cmd`；models/（Q8_0 talker+codec，2.3G）、
    voices/（五音色 .spk/.rvq/.txt）都在该目录下。
  - 启动：仓库 `tts-server\start-qwentts.cmd`（默认指向上述目录，
    `QWENTTS_HOME` 可覆盖）；服务 127.0.0.1:9766，`--max-batch 4`。
  - 注意：**注册表在进程内存**，重启引擎后必须重跑注册
    （start-qwentts.cmd 已包含）。
- **引擎 B（回退）：Python，仓库 `tts-server/`**
  - 启动：`TTS_MODEL_DIR=D:\tmp\qwen3tts\Qwen3-TTS-12Hz-1.7B-Base`
    （权重暂存 D:\tmp，fallback 用，丢了可按 docs 重新下载）+ `server.py`；
    端口 9765；`.env` 设 `LOCAL_TTS_DIALECT=tts-server` 切换。

## 本机实测（RTX 5060 Laptop 8GB）

| 指标 | Python 引擎 | qwentts.cpp (Q8_0) |
|---|---|---|
| 单路 RTF | 0.47 | **0.27**（CLI 冷启 0.215） |
| 四路吞吐 RTF | 0.43 | **0.09**（24.8s 音频 2.33s） |
| 流式首包 | 1.9–3.9s | **~530ms**（TTFA 76ms 帧级） |
| 显存 | 4.2 GB (bf16) | ~2.4 GB (Q8) |
| 预热 | 4–7 分钟编译 | 无 |

性能优化三件套（fastpath.py）与两大坑（sm_120 SDPA 回退 math、dynamo
recompile 上限）详见 docs/local-tts.md 引擎 B 一节与 fastpath.py 头注。

## 剧情实测归档

- C++ 后端：自动模式 19 次播放、synthesis_paced_starts=0（TTS 从不卡播放，
  停顿均归因编剧 LLM 流式间隔）；疯狂下一句 22 连击后 26 次连续播放无卡死。
- Python 后端：同套测试通过；tts-server 日志大量 canceled=True 证明取消链
  （downloader→route→provider reader.cancel→server 句间丢弃）真实触发。
- 测试工具：`tools/story_test.py`（playwright，需先起游戏
  `npx tsx src/entrypoints/web.ts config.tts-story.yaml`）。

## 待人耳验收样本

- Q8_0（C++）：`D:\tmp\qwen3tts\q8_*.wav`
- bf16（Python）：`D:\tmp\qwen3tts\sample_*.wav`
- 同一批台词，供量化损耗对比；`D:\tmp\qwen3tts\` 整体是 scratch
  （日志/样本），可随时清。

## 重建音色资产

五音色 latent 源自参考音频（内容资产，git 内外都不分发）：

- 引擎 A：`qwen-codec --model <codec> --talker <talker> -i ref.wav` →
  `.spk/.rvq` + 手写 `.txt` 转写 → `register_qwentts_voices.py` 注册。
- 引擎 B：`PAIMENG_REF_WAV=<参考音> python tools/build_voices.py`
  （四配角参考音由 CustomVoice 内置音色合成，脚本内含人设台词与语气指令；
  需先 `CUSTOM_VOICE_DIR`/`TTS_MODEL_DIR` 指向本地权重或留 HF id 自动下载）。
