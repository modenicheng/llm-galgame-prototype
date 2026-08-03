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
   ├─ main.ts                # 组合根：实例化适配器并注入运行时
   ├─ config.ts / prompts.ts / status.ts
   ├─ schema.ts              # 事件协议（含 input_bridge / player_dialogue）
   ├─ game.ts                # 运行时（命令/事件驱动；后续迁入 core/runtime）
   ├─ media.ts / prefetch.ts / llm.ts 已迁出：
   ├─ core/
   │  ├─ ports/              # Clock / IdGenerator / SessionStore / StoryGenerator /
   │  │                       # MediaProvider / DiagnosticSink（纯接口，无 Node 依赖）
   │  ├─ protocol/           # model-jsonl 纯解析
   │  ├─ runtime/            # async-event-queue、RuntimeCommand、RuntimeOutput
   │  └─ interaction/        # input-bridge 缓冲、InputResponseSession 流式会话
   ├─ adapters/
   │  ├─ llm/openai-compatible-generator.ts
   │  ├─ storage/node-jsonl-session-store.ts
   │  ├─ media/（mock 提供器）
   │  └─ platform/           # SystemClock / SessionIdGenerator / ConsoleDiagnosticSink
   └─ apps/cli/              # terminal-ui（纯 I/O）+ cli-controller（命令/事件适配）
```

依赖方向：`apps → adapters → core`，`core` 不得导入 Node、OpenAI 或 CLI 模块；
`core/architecture.test.ts` 静态扫描保证该边界。

模块职责：

- `schema.ts`：模型草稿事件、运行时事件、落盘事件和 `line_id` 类型；`input_bridge` 随 interaction 内嵌，`player_dialogue` 由运行时生成。
- `core/protocol/model-jsonl.ts`：纯 JSONL 模型协议解析（无文件系统）。
- `adapters/llm/openai-compatible-generator.ts`：OpenAI 流式调用 + 逐行解析。
- `prefetch.ts`：候选分支并发池、排队、优先选中项、取消未选项。
- `media.ts`：媒体低水位调度器及可选 mock 提供器。
- `status.ts`：文本任务、分支状态、缓冲量和媒体状态的统一可观察状态。
- `game.ts`：命令/事件运行时（`dispatch`/`subscribe`），维护唯一有效剧情路径。
- `apps/cli/cli-controller.ts`：把 RuntimeOutput 转成渲染、把键盘/行输入转成命令。

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

## 5. 自由输入与 input_bridge

### 5.1 交互协议

`interaction` 事件按 `mode` 区分为三种（Zod discriminated union），`mode` 是唯一权威的表单类型字段——禁止新增与 `mode` 平行的表单字段（如 `form_type`、`allow_input`）。字段规则：

- `choice`：仅 `options`（2–5 个，`id` 非空且互不重复）；禁止携带 `input` 与 `input_bridge`。
- `input`：必须携带 `input` 与 `input_bridge`；禁止携带 `options`。
- `hybrid`：必须携带 `options`（2–5 个）、`input` 与 `input_bridge`；页面同时显示选项与输入框。

结构约束由 Zod Schema 强制，运行时另有 `InteractionPolicy` 二次校验（允许的模式、选项数范围、`input.max_length` 上限、连续纯 input 次数上限均可在配置中调整）；非法 interaction 在进入播放缓冲前被拒绝并进入修复流程。

`input_bridge` 是 1-2 条 narration，作为玩家确认输入后、NPC 正式回应前的场景过渡：

```json
{"type":"interaction","interaction_id":"int_001","prompt":"说什么？","mode":"input","input":{"kind":"free_text","placeholder":"...","max_length":200},"input_bridge":{"events":[{"type":"narration","text":"风穿过走廊，她抬起了头。"}]}}
```

bridge 规则（写入 `prompts/instructions.yaml`）：

- 只描写环境、表情、动作、氛围；不回答或预判玩家输入。
- 不引入新事实、不修改状态、不创建新的交互点。
- 结尾自然衔接 NPC 回应；避免固定模板和重复"沉默片刻"。

Bridge 时序契约：

- Bridge 随 interaction 由模型预生成，不读取、不复述、不预判玩家输入；运行时在 interaction 到达时即为其分配稳定 `line_id` 并存入 `InputBridgeBuffer`。
- 确认输入后只消费一次（`take`），按 玩家台词 → bridge → NPC 回应 顺序播放；消费后即失效。
- hybrid 选择预设选项时 `discard` 丢弃，永远不播放。
- 取消输入预览时保留（`peek`），供同一互动再次预览复用。
- Bridge 仅以文本呈现，不进入媒体/TTS 调度。
- Bridge 永不写入正式事件日志。

### 5.2 流式回应与两阶段确认

第一次 Enter（`preview_input`）后立即发起 `generateInputResponse`，每条完整 JSONL 事件到达时立刻物化（分配稳定 `line_id`）并暂存进 `InputResponseSession`，不进入正式日志；`state_patch` 只暂存。

第二次 Enter（`confirm_input`）原地升级：

1. 创建并提交 `player_dialogue`（玩家台词，`source: "player"`）。
2. 提交 bridge（从 `InputBridgeBuffer` 取出）。
3. 提交已到达的回应事件；顺序为 玩家台词 → bridge → 回应。
4. 若回应流仍在生成：不 abort、不重新请求，提升为正式路径（live promotion），新到达事件直接进入正式 playback buffer，由 `consumeLiveStream` 播放；任务结束后再启动正常续写。

Esc（`cancel_input`）：abort 生成、会话标记 canceled、清空事件、丢弃 patch；bridge 保留供下一次预览复用；旧流迟到事件被 signal/会话校验丢弃。

状态补丁提交条件（修复了旧时序竞态）：`status === "committed"` 且生成任务已完成且 patch 校验通过。未确认时完成请求也不提交 patch；取消后永久丢弃。

失败处理：

- 流失败但已有事件：保留已到达前缀，续写以此（玩家台词 + bridge + 已有回应）为固定前缀继续。
- 流失败且无事件：确认后先播玩家台词 + bridge，同时进行一次流式 repair；repair 仍失败则静默继续（不伪造 NPC 语义回应）。

### 5.3 播放表现

确认后：

```text
你
  她看起来有心事。

风穿过走廊，她抬起了头。

苏遥
  你来啦。我正在想你说的事。
```

每条仍按推进键等待，正常阅读节奏本身就覆盖了剩余生成时间；bridge 播完而回应首行未到时保持当前画面静默等待（`input.response_underrun_count` 计数一次）。CLI 不显示任何生成状态、Spinner 或加载提示。

### 5.4 交互关闭事件与表单生命周期

每个互动只能成功解决一次。运行时在以下时刻发布 `interaction_resolved`（携带 `interactionId` 与 `resolution: "choice" | "input"`）：

- 选择预设选项（choice 或 hybrid 的选项路径）：选项存在、采纳分支前发布 `resolution: "choice"`。
- 确认自由输入（input 或 hybrid 的输入路径）：确认时、`input_committed` 之前发布 `resolution: "input"`。
服务端投影（`UiProjectionStore`）在收到匹配 `interactionId` 的 `interaction_resolved` 时清空 `currentInteraction`；未提交的 `currentPreview` 在 `input_committed` / `input_preview_canceled` 时清空；进入播放（`playback_ready`）时互动与预览表单都会被防御性清理。因此已解决的互动不会再显示任何表单；WebSocket 重连时浏览器通过投影快照恢复页面，已解决互动的旧表单不会恢复，运行时也会在播放开始时清除遗留的互动/预览作用域。

### 5.5 陈旧命令与重复提交

运行时以"当前活跃互动/预览"为命令作用域：`interaction_opened` 记录 `activeInteractionId`，`select_choice` / `preview_input` 必须指向它；`input_preview_opened` 记录 `activePreviewId`，`confirm_input` / `cancel_input` 必须指向它。

- 指向已解决互动的陈旧命令（如重连客户端重发的选择）在入口即被丢弃，不会推迟到后续互动的等待者。
- 互动或预览一旦解决，作用域立即释放：重复选择、选项与输入双路径并发提交只接受第一条。
- 第二次 Enter 不创建第二个回应请求：确认时原地提升现有 `InputResponseSession`，未完成流直接进入正式播放路径（见 5.2 live promotion）。
- 取消输入后旧流迟到事件与未确认状态补丁被会话校验丢弃，不能进入正式路径。

## 6. 两种模型输出模式

### 6.1 完整剧情段

用于开场和已选路径续写：

```text
narration/dialogue × N
choice 或 end × 1
```

要求末行必须且只能是 `choice` 或 `end`。

### 6.2 分支预取段

用于候选选项短片段：

```text
narration/dialogue × N
```

不得含 `choice` 或 `end`。默认要求至少 3 条 `dialogue`，由 `prefetch.branch_dialogue_lines` 调整。这里“3 条”指三个对白事件，不强行定义为三次完整问答，以免限制叙事节奏。注意：`branch_dialogue_lines` 同时作为已选分支交接正式续写的“可播放行数”阈值（live 分支在达到该行数时立即 handoff，防止纯旁白分支无法交接）。

## 7. 分支预取与取消

每个完整剧情段一生成完，程序立刻读取末尾 `choice` 并创建 `BranchPrefetchGroup`：

- 所有选项进入队列。
- 同时运行数量受 `prefetch.branch_concurrency` 限制。
- TUI 在每个选项后显示 `排队 / 生成中 / 已就绪 / 失败`。
- 玩家可以在预取完成前选择；选中且尚未启动的任务会获得优先执行权。
- 玩家选择后，程序通过 `AbortController` 尽量取消未选请求。
- 已经完成的未选请求无法追回模型成本，这是分支预取换取低延迟的必然代价。
- 已选分支预取失败时，前台自动重试一次，不会误用其他分支内容。

## 8. 媒体按量预生成

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

## 9. TUI 状态显示

普通模式只显示剧情、选择、输入与确认，不显示任何生成状态（无 Spinner、无加载提示）：

```text
苏遥 [suyao/serious@right]
  别碰它。至少现在别碰。

Enter/Space 下一句，Ctrl+C 退出
```

输入预览只显示冻结文本与确认提示：

```text
你准备说：
"她看起来有心事。"

[Enter] 确认发送  |  [Esc] 返回修改
```

debug 模式（`--debug-runtime` 或 `config.debug.runtime_status: true`）额外显示缓冲、任务、媒体状态面板与分支徽标，供开发观察：

```text
苏遥
  别碰它。

[状态] 剧情播放：当前文本已就绪；下一分支正在后台预取
[文本] 缓冲 5 条事件 / 3 条对白；分支：追问原因=生成中
[媒体] 音频关闭，目标提前量 3，补充阈值 2
Enter/Space 下一句，Ctrl+C 退出
```

CLI 通过 `RuntimeOutput`（`status_changed`、`playback_ready`、`interaction_opened`、`input_preview_opened` 等）驱动；TerminalUI 是纯 I/O，CliController 负责把事件转成渲染、把按键转成 `RuntimeCommand`。

逐句推进既符合 GalGame 交互，也为后台续写、回应生成和媒体预取提供真实时间窗口。

## 10. 配置

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
  # input_bridge：input/hybrid 交互携带的场景过渡旁白（1-2 条 narration）。
  # schema 强制 1-2 条且只能为 narration；此处是运行时二次校验。
  input_bridge:
    enabled: true
    min_events: 1
    max_events: 2
    only_narration: true

# 自由输入表现
input:
  kind: dialogue        # 玩家台词以 dialogue 呈现（目前唯一实现）
  require_preview_confirmation: true   # 两次 Enter 流程；false 为单次 Enter 直接提交
  show_generation_status: false        # 预览中显示回应生成状态（需 debug 模式）

debug:
  runtime_status: false  # 等价于 --debug-runtime

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
- `input_bridge.min_events <= max_events`；`input.kind` 仅支持 `dialogue`。
- 不提供只有日志没有执行逻辑的配置项；每个字段都有运行时行为对应。

## 11. 成本与延迟权衡

候选分支预取必然增加无效生成量。第一版选择“每个分支都生成短片段”，因为目标是验证无缝体验。正式版本可进一步采用：

- 根据玩家历史只预取概率最高的前 K 个选项。
- 当前高亮选项提权，低概率选项延迟启动。
- 复用 KV Cache 或服务端 Prompt Cache。
- 文本预取三句，但候选分支音频只预取一至两句。
- 检测生成速度和阅读速度，自动调整提前量。
- 达到会话预算后降级为“只预取当前高亮分支”。

## 12. 从空目录运行

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

## 13. 后续演进

1. 将 `AudioSynthesizer` 提取为公开 provider 接口，接入真实 TTS。
2. 为图片、立绘、表情和背景实现同类 `MediaPrefetchScheduler`，共用 `line_id` 或独立 `asset_slot_id`。
3. 将 `game.ts` 迁入 `core/runtime/game-runtime.ts`，使运行时完全通过 `RuntimeCommand`/`RuntimeOutput` 与宿主交互（CLI 已通过命令/事件驱动）。
4. Web 版属于未来独立项目，不在当前原型范围内；届时使用 Worker 或后端流式接口运行预取任务，平台密钥仍必须留在服务端。
5. 根据实时合成速度、阅读速度和预算动态调整提前量，而不是长期使用固定 3/2 参数。
6. 根据 `input_bridge_cover_duration_ms` 与 `input_confirm_to_first_response_line_ms` 观察 bridge 长度是否足够覆盖回应等待，必要时让模型自适应。
