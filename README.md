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

- 每局从一条**叙事种子**开始（`prompts/campus-ops.yaml`），种子只提供起点
  情境，不规定路线、轮数或结局；运行时按会话 ID 确定性轮换种子，
  `CAMPUS_SCENARIO_SEED_ID` 可显式指定。
- 不限制互动次数（`narrative.mode: event` + `max_interactions: 0`），
  简单事件可以很快结束，复杂事件可以多轮展开；结局由模型依据本局
  已确认的事实自然生成（`@end` 仅为引擎终止标记）。
- 文本优先：`synthesis.provider: disabled`，不依赖 TTS key；树莓娘立绘为
  项目自制占位图，BITNP 官方素材未经授权不接入。
- 现场运行（一人操作、重开、指定种子）见
  [docs/campus-ops-event-runbook.md](./docs/campus-ops-event-runbook.md)；
  设计与素材授权边界见
  [docs/superpowers/specs/2026-09-06-campus-ops-event-design.md](./docs/superpowers/specs/2026-09-06-campus-ops-event-design.md)。

## 运行

```bash
npm install
cp .env.example .env
npm run dev
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
npm run dev
```

调试运行时状态面板（缓冲、任务、媒体状态；普通模式不显示）：

```bash
npm run dev -- --debug-runtime
```

## TTS 语音（可选）

默认 `config.yaml` 的 `media.audio.synthesis.provider: dashscope` 会启用 DashScope 语音合成，
启动时需要 `.env` 中已配置 `DASHSCOPE_API_KEY` 及 `voices.yaml` 引用的音色变量
（创建与绑定方法见 [docs/agents/TTS-音色配置指南.md](./docs/agents/TTS-音色配置指南.md)）。
不配置 TTS 时，把 `synthesis.provider` 改为 `disabled` 即可纯文本运行（CLI 同理）。

## 验证媒体调度

默认只运行文本模式。若需观察音频提前量、批量补充和分支取消逻辑，将 `config.yaml` 改为：

```yaml
media:
  audio:
    enabled: true
    provider: mock
```

程序会在 `assets/audio/` 写入按 `line_id` 命名的调度演示 JSON，不包含真实音频。
