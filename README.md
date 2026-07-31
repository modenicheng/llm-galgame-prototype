# LLM GalGame Prototype

TypeScript + Node.js 实现的 LLM GalGame 预研项目，支持：

- 启动时生成开场剧情直到首个分支。
- 当前剧情播放期间，并行预取所有候选分支。
- 玩家选择后立即播放已选分支缓冲，同时后台续写到下一分支。
- TUI 上下键选择、逐句推进与实时生成状态显示。
- 所有可播放文本拥有会话内稳定且跨会话不冲突的 `line_id`。
- 可配置媒体提前量、低水位阈值、批量大小和分支媒体预取量。
- 可选 `mock` 音频提供器，用于验证异步媒体调度，不生成真实音频。

详细设计见 [DESIGN.md](./DESIGN.md)。

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

## 验证媒体调度

默认只运行文本模式。若需观察音频提前量、批量补充和分支取消逻辑，将 `config.yaml` 改为：

```yaml
media:
  audio:
    enabled: true
    provider: mock
```

程序会在 `assets/audio/` 写入按 `line_id` 命名的调度演示 JSON，不包含真实音频。
