# LLM GalGame Prototype

TypeScript + Node.js 实现的 LLM GalGame 预研项目，支持：

- 启动时生成开场剧情直到首个分支。
- 当前剧情播放期间，并行预取所有候选分支。
- 玩家选择后立即播放已选分支缓冲，同时后台续写到下一分支。
- 自由输入采用两阶段确认：第一次 Enter 立即启动 NPC 回应生成并逐行流式到达，第二次 Enter 直接播放玩家台词 → 场景过渡旁白 → NPC 回应，无需等待加载。
- 互动节点支持三种表单：`choice` 仅预设选项、`hybrid` 选项 + 自由输入、`input` 仅自由输入。表单模式由 DSL 语法推导（`?` 开头 + `+` 选项 / `=` 输入），模型不输出 mode；输入确认后的 1-2 条场景过渡旁白（`input_bridge`）由运行时作为独立预取任务生成，不再是 interaction 事件的字段。
- 所有可播放文本拥有会话内稳定且跨会话不冲突的 `line_id`。
- 可配置媒体提前量、低水位阈值、批量大小和分支媒体预取量。
- 可选 `mock` 音频提供器，用于验证异步媒体调度，不生成真实音频。

设计规范与架构见 [docs/llm-outputs-refactor.md](./docs/llm-outputs-refactor.md)，
当前进度见 [docs/status.md](./docs/status.md)，路线图见 [TODO.md](./TODO.md)。
TTS 音色创建与绑定见 [docs/agents/TTS-音色配置指南.md](./docs/agents/TTS-音色配置指南.md)。

## 校园技术社团值班分支（campus-ops-raspberry）

本分支是一个独立的展位体验：以网络开拓者协会看板娘**树莓娘**为核心，
围绕校园技术社团的值班日常展开**开放叙事**——

- 每局从一条**叙事种子**开始（`prompts/campus-ops.yaml`），种子提供起点
  情境与作者侧引导（context/concerns/boundaries/angles，折进 canon——模型
  可见、玩家不可见），不规定路线、轮数或结局；运行时按会话 ID 确定性轮换
  种子，`CAMPUS_SCENARIO_SEED_ID` 可显式指定。
- 互动带三级收束护栏（`narrative.mode: event`）：3 次交互软提示收束 →
  6 次强提示并停分支预取 → 8 次运行时保险丝强制收束（`wrapup_interactions`
  / `closing_push_interactions` / `max_interactions`）。简单事件可以很快
  结束，复杂事件可以多轮展开；结局由模型依据本局已确认的事实自然生成
  （`@end` 仅为引擎终止标记）。
- 本地语音：树莓娘（paimeng 克隆）与四配角共五音色由本机 GPU 推理服务合成
  （`synthesis.provider: local`，不需要任何 TTS API key，启动方式见下文
  「TTS 语音」）；BITNP 官方素材未经授权不接入。
- 树莓娘资产仅限内部流通：所有树莓娘资产不入库、不上传，只能直接复制分发
  （详见 [assets/ATTRIBUTION.md](./assets/ATTRIBUTION.md)）。
- 现场运行（一人操作、重开、指定种子）见
  [docs/campus-ops-event-runbook.md](./docs/campus-ops-event-runbook.md)；
  设计与素材授权边界见
  [docs/superpowers/specs/2026-09-06-campus-ops-event-design.md](./docs/superpowers/specs/2026-09-06-campus-ops-event-design.md)。

## 运行

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
pnpm dev
```

调试运行时状态面板（缓冲、任务、媒体状态；普通模式不显示）：

```bash
pnpm dev --debug-runtime
```

开发/运维监控面板（编剧 LLM 流式解析、缓冲水位、剧情图、提示词审计；只读，
不面向玩家）：服务启动时控制台会打印 `/monitor?token=...` 链接，详见
[docs/monitor-dashboard.md](./docs/monitor-dashboard.md)。

## TTS 语音

`config.yaml` → `media.audio.synthesis.provider` 四选一：

| provider | 说明 |
|---|---|
| `local` | **当前默认**。本机 GPU 推理（`tts-server/`，Qwen3-TTS-12Hz-1.7B-Base），无需 TTS API key |
| `dashscope` | 云端 DashScope 合成，需 `DASHSCOPE_API_KEY` 与 `voices.yaml` 引用的音色变量 |
| `mock` | 异步媒体调度验证：按种子生成正弦波 PCM 流，不写盘、不含真实语音 |
| `disabled` | 纯文本运行 |

### 本地推理（local，当前默认）

两条引擎二选一，游戏侧默认对接 **qwentts.cpp**（`LOCAL_TTS_BASE_URL` 可覆盖地址）：

1. **qwentts.cpp（C++/GGML，当前默认后端）**——OpenAI 兼容协议，默认
   `127.0.0.1:9766`，显存约 2.5 GB（Q8_0）、无预热：

   ```bash
   tts-server\start-qwentts.cmd   # 起 server + 注册音色（部署根目录用 QWENTTS_HOME 指定）
   ```

2. **Python 引擎（fallback）**——`tts-server/server.py`，默认 `127.0.0.1:9765`，
   首次启动 torch.compile 预热数分钟。游戏侧切换：`.env` 设
   `LOCAL_TTS_DIALECT=tts-server`。

两个引擎的完整部署指南（构建、模型下载、音色制作与注册、排障）见
[docs/local-tts.md](./docs/local-tts.md)。

音色绑定在 `voices.yaml` 的 `providers.local.voice`（键 = 引擎注册表里的
音色名，本仓库默认五音色：`paimeng`/`xuwanqing`/`linxiaoman`/`xiayiming`/`hanche`），
输出固定 24 kHz 流式 PCM（`synthesis.sample_rate: 24000`）。
tts-server 未启动时游戏照常运行：每句合成重试耗尽后该句降级为纯文本，不阻塞播放。

### 云端 DashScope（dashscope）

合成模型在 `voices.yaml` 逐音色配置，支持两个模型族（可混布）：

- `cosyvoice*`（v3-flash / v3.5-flash）：SpeechSynthesizer 端点，支持语速/音调/音量/种子；
- `qwen3-tts*`（flash / instruct-flash / vc / vd）：固定 24000 Hz PCM 输出，
  音色需在该族下单独复刻/设计（与 CosyVoice 音色不互用），
  启用时 `synthesis.sample_rate` 必须为 24000。

音色创建与绑定方法见 [docs/agents/TTS-音色配置指南.md](./docs/agents/TTS-音色配置指南.md)。

## 验证媒体调度

默认走本地语音（`synthesis.provider: local`）。无 GPU 环境或需观察音频提前量、
批量补充和分支取消逻辑时，将 `config.yaml` 改为：

```yaml
media:
  audio:
    synthesis:
      provider: mock
```

mock provider 按行种子生成正弦波 PCM（确定性、可复现），走与真实 provider
完全相同的调度/缓存/播放链路，便于无 GPU 环境验证调度逻辑。
