# LLM 实时生成 GalGame：预取式预研版设计

## 1. 目标

本版验证一条低等待、可扩展到语音和图像资源的运行链路：

1. 作者通过 `prompts/` 提供角色设定、故事大纲和写作限制。
2. 启动时先生成开场剧情，直到首个 `choice` 或 `end`。
3. 一段完整剧情生成后，程序已知末尾分支，因此不必等玩家走到选项界面才开始工作；它会立刻并行预取每个选项后续短片段。
4. 玩家逐句阅读当前剧情时，分支文本和候选分支媒体资源在后台生成。
5. 玩家确认选择后，程序取消未选分支，立即播放已选缓冲，同时继续生成到下一分支。
6. 所有可播放文本由运行时分配稳定 `line_id`，后续语音、口型、字幕时间轴等资源均以此关联。

预研版仍以文本为主，不接入真实 TTS、立绘生成或 WebGAL。项目附带 `mock` 音频提供器，仅验证按量预生成、低水位补充、并发限制和取消逻辑。

## 2. 核心流水线

```text
启动
  │
  ├─ 生成开场完整段：文本…… → choice
  │
  ├─ 完整段就绪后，立即并发生成 choice 各选项短片段
  │                    ├─ 选项 A：3 条对白左右
  │                    ├─ 选项 B：3 条对白左右
  │                    └─ 选项 C：3 条对白左右
  │
  ├─ 玩家逐句阅读当前段；TUI 持续显示后台状态
  │
  ├─ 玩家选择 B
  │    ├─ 取消 A/C 尚未完成的任务
  │    ├─ 激活 B 的文本与媒体缓冲
  │    └─ 后台从 B 预取片段末尾继续生成，直到下一个 choice/end
  │
  └─ 循环
```

这里存在两层预生成：

- **分支预取层**：在玩家选择前，为每个候选选项生成短片段。
- **路径续写层**：玩家选择后，短片段开始播放，同时生成该路径剩余内容直到下一分支。

只要“玩家阅读短片段所需时间”大于“续写请求耗时”，下一段便已就绪，玩家不会看到模型等待界面。

## 3. 目录结构

```text
llm-galgame-prototype/
├─ config.yaml
├─ .env.example
├─ package.json
├─ tsconfig.json
├─ prompts/
│  ├─ characters.txt
│  ├─ story_line.txt
│  ├─ guideline.txt
│  ├─ instructions.yaml
│  └─ author.yaml
├─ sessions/
│  └─ .gitkeep
└─ src/
   ├─ main.ts
   ├─ config.ts
   ├─ prompts.ts
   ├─ schema.ts
   ├─ jsonl.ts
   ├─ llm.ts
   ├─ status.ts
   ├─ prefetch.ts
   ├─ media.ts
   ├─ ui.ts
   ├─ game.ts
   ├─ interaction/
   │  └─ input-engine.ts
   ├─ story/
   │  ├─ types.ts
   │  ├─ state.ts
   │  ├─ patch.ts
   │  └─ context-builder.ts
   ├─ runtime/
   │  ├─ branch-manager.ts
   │  ├─ generation-scheduler.ts
   │  ├─ playback-buffer.ts
   │  └─ metrics.ts
```

模块职责：

- `schema.ts`：模型草稿事件、运行时事件、落盘事件和 `line_id` 类型。
- `jsonl.ts`：分别校验完整剧情段和分支预取段。
- `llm.ts`：开场生成、分支短片段生成、已选路径续写。
- `prefetch.ts`：候选分支并发池、排队、优先选中项、取消未选项。
- `media.ts`：媒体低水位调度器及可选 mock 提供器。
- `status.ts`：文本任务、分支状态、缓冲量和媒体状态的统一可观察状态。
- `ui.ts`：自定义 TUI；支持逐句推进、上下键选择和动态状态重绘。
- `game.ts`：串联上述模块，维护唯一有效剧情路径。

## 4. JSONL 协议与 `line_id`

### 4.1 模型输出

模型仍只输出剧情语义，不负责运行时标识：

```jsonl
{"type":"narration","text":"旧终端的风扇忽然重新转动。"}
{"type":"dialogue","speaker":"苏遥","text":"别碰它。至少现在别碰。","portrait":{"character":"suyao","expression":"serious","position":"right"}}
{"type":"choice","prompt":"如何回应？","options":[{"id":"question_suyao","text":"追问她为何了解终端"},{"id":"touch_terminal","text":"无视警告，触碰屏幕"}]}
```

模型不得生成 `line_id`。唯一 ID 由程序分配，避免模型重复、改写或伪造标识。

状态更新使用行内 `state_patch` 行，可出现在任意位置（建议段尾）：

```jsonl
{"type":"state_patch","patch":{"recent_summary":"苏遥阻止了主角触碰终端","characters":{"suyao":{"emotion":"serious"}}}}
```

`state_patch` 行不进入播放路径，由运行时校验并合并后应用到 `StoryState`（多个 patch 按顺序合并）。流式解析时逐行处理：围栏标记（```jsonl 等）被跳过；若某行解析失败且此前已发布事件，则中止并保留已发布前缀，由运行时修复续写；若尚未发布任何事件，则整体回退到全量解析（覆盖围栏包裹/单块输出）。

### 4.2 运行时与落盘事件

所有可播放文本——`dialogue` 和 `narration`——都会获得 `line_id`：

```jsonl
{
  "type": "dialogue",
  "speaker": "苏遥",
  "text": "别碰它。至少现在别碰。",
  "line_id": "line_2026-07-30T04-30-00-000Z_000002",
  "seq": 2,
  "turn": 1,
  "timestamp": "2026-07-30T04:30:02.000Z",
  "source": "model"
}
```

ID 结构：

```text
line_<session_id>_<monotonic_sequence>
```

它满足：

- 同一事件在文本显示、音频生成、缓存和落盘记录中使用同一 ID。
- 同一会话内不重复。
- 不同会话不会因从 `line_000001` 重新计数而覆盖资源。
- 候选分支在玩家选择前已有 ID，因此媒体预取可以先行启动。

未选分支可能消耗若干 ID，活动剧情 ID 出现间隔属于正常现象。

## 5. 两种模型输出模式

### 5.1 完整剧情段

用于开场和已选路径续写：

```text
narration/dialogue × N
choice 或 end × 1
```

要求末行必须且只能是 `choice` 或 `end`。

### 5.2 分支预取段

用于候选选项短片段：

```text
narration/dialogue × N
```

不得含 `choice` 或 `end`。默认要求至少 3 条 `dialogue`，由 `prefetch.branch_dialogue_lines` 调整。这里“3 条”指三个对白事件，不强行定义为三次完整问答，以免限制叙事节奏。注意：`branch_dialogue_lines` 同时作为已选分支交接正式续写的“可播放行数”阈值（live 分支在达到该行数时立即 handoff，防止纯旁白分支无法交接）。

## 6. 分支预取与取消

每个完整剧情段一生成完，程序立刻读取末尾 `choice` 并创建 `BranchPrefetchGroup`：

- 所有选项进入队列。
- 同时运行数量受 `prefetch.branch_concurrency` 限制。
- TUI 在每个选项后显示 `排队 / 生成中 / 已就绪 / 失败`。
- 玩家可以在预取完成前选择；选中且尚未启动的任务会获得优先执行权。
- 玩家选择后，程序通过 `AbortController` 尽量取消未选请求。
- 已经完成的未选请求无法追回模型成本，这是分支预取换取低延迟的必然代价。
- 已选分支预取失败时，前台自动重试一次，不会误用其他分支内容。

## 7. 媒体按量预生成

媒体调度不采用“一次生成整章”，而采用目标提前量与低水位补充：

```yaml
media:
  audio:
    active_target_lines: 3
    refill_threshold_lines: 2
    branch_prefetch_lines: 2
    batch_size: 2
    max_concurrency: 2
```

含义：

- `active_target_lines: 3`：尽量保证当前播放位置前方三句资源就绪或正在生成。
- `refill_threshold_lines: 2`：就绪资源降到两句时开始补充。
- `branch_prefetch_lines: 2`：玩家选择前，每个候选分支最多先合成前两句。
- `batch_size: 2`：一次向媒体服务提交两句，减少请求次数。
- `max_concurrency: 2`：最多并行两个媒体批次，避免服务过载。

这几个值不应写死。真实 TTS 接入后，应依据以下观测动态调整：

```text
平均合成耗时 / 玩家平均读句耗时 / 请求失败率 / 单句成本 / 缓存命中率
```

当前 `media.ts` 已实现调度状态机。默认 `enabled: false`，纯文本运行不会创建资源。将 provider 改为 `mock` 后，程序会模拟延迟并生成按 `line_id` 命名的 JSON 文件，用于观察：

- 当前路径提前生成。
- 候选分支媒体预取。
- 玩家选择后的未选分支取消。
- 低水位触发补充。
- 当前句资源未及时完成时短暂等待；失败则降级为纯文本。

真实 TTS 只需实现 `AudioSynthesizer.synthesize(lines, signal)`，不应改动游戏主循环。

## 8. TUI 状态显示

TUI 不再使用一次性选择组件，而是自行处理 raw mode 输入，以便后台任务变化时重绘：

```text
苏遥 [suyao/serious@right] [line_..._000005]
  别碰它。至少现在别碰。

[状态] 剧情播放：当前文本已就绪；下一分支正在后台预取
[文本] 缓冲 5 条事件 / 3 条对白；分支：追问原因=生成中
[媒体] 音频关闭，目标提前量 3，补充阈值 2
Enter/Space 下一句，Ctrl+C 退出
```

选择界面：

```text
如何回应？
❯ 追问她为何了解终端  [已就绪 4 条/3 对白]
  无视警告，触碰屏幕  [生成中]

[状态] 等待选择：各分支正在并行预取；可随时选择
[文本] 缓冲 0 条事件 / 0 条对白；分支：无视警告=生成中
[媒体] 音频关闭，目标提前量 3，补充阈值 2
↑/↓ 选择，Enter 确认，Ctrl+C 退出
```

逐句推进既符合 GalGame 交互，也为后台续写和媒体预取提供真实时间窗口。

## 9. 配置

```yaml
api:
  model: deepseek-v4-flash
  base_url: https://api.deepseek.com
  api_key_env: OPENAI_API_KEY
  timeout_ms: 60000
  token_limit_field: max_completion_tokens

generation:
  temperature: 0.9
  max_tokens: 800
  repair_attempts: 1

prefetch:
  branch_dialogue_lines: 2
  branch_concurrency: 4

media:
  audio:
    enabled: false
    provider: disabled
    active_target_lines: 3
    refill_threshold_lines: 2
    branch_prefetch_lines: 2
    batch_size: 2
    max_concurrency: 2
    mock_latency_ms: 800
    output_dir: assets/audio

game:
  history_events: 80
  sessions_dir: sessions
  show_line_ids: true
```

校验规则包括：

- `refill_threshold_lines < active_target_lines`。
- `audio.enabled: true` 时 provider 不能是 `disabled`。

## 10. 成本与延迟权衡

候选分支预取必然增加无效生成量。第一版选择“每个分支都生成短片段”，因为目标是验证无缝体验。正式版本可进一步采用：

- 根据玩家历史只预取概率最高的前 K 个选项。
- 当前高亮选项提权，低概率选项延迟启动。
- 复用 KV Cache 或服务端 Prompt Cache。
- 文本预取三句，但候选分支音频只预取一至两句。
- 检测生成速度和阅读速度，自动调整提前量。
- 达到会话预算后降级为“只预取当前高亮分支”。

## 11. 从空目录运行

要求 Node.js 20 或更高版本：

```bash
npm install
cp .env.example .env
npm run dev
```

PowerShell：

```powershell
Copy-Item .env.example .env
npm run dev
```

编辑 `.env`：

```dotenv
OPENAI_API_KEY=你的密钥
```

验证 mock 媒体调度：

```yaml
media:
  audio:
    enabled: true
    provider: mock
```

## 12. 后续演进

1. 将 `AudioSynthesizer` 提取为公开 provider 接口，接入真实 TTS。
2. 为图片、立绘、表情和背景实现同类 `MediaPrefetchScheduler`，共用 `line_id` 或独立 `asset_slot_id`。
3. 增加状态快照和 `state_patch`，避免长剧情只依赖最近事件。
4. 将核心状态机提取为无 Node.js 依赖包，供 CLI 与未来项目共用。
5. Web 版属于未来独立项目，不在当前原型范围内；届时使用 Worker 或后端流式接口运行预取任务，平台密钥仍必须留在服务端。
6. 根据实时合成速度、阅读速度和预算动态调整提前量，而不是长期使用固定 3/2 参数。
