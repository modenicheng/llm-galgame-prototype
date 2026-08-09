# LLM GalGame 演出 DSL 与视觉资源系统重构设计

## 0. 文档目的

本文基于当前 `modenicheng/llm-galgame-prototype` `main` 分支实际代码，以及近期已经确定的设计，给出下一阶段完整重构方案。

本轮重构主要解决四个问题：

1. 当前模型使用 JSONL 输出剧情，格式 Token 占用较高，模型容易产生 JSON 格式错误。
2. 当前演出协议主要只有 dialogue 上的 `portrait`，尚不能自然控制背景、BGM、角色持续视觉状态等 GalGame 核心演出。
3. 当前 interaction JSON 结构较重，模型需要自行生成 mode、interaction ID、option ID、InputSpec 等大量机器字段。
4. 现有逐行流式模型以“一行 JSON = 一个事件”为核心，难以表达“切背景 + 换 BGM + 改立绘 + 显示一句台词”这一原子演出边界。

重构后的核心原则：

> 模型输出紧凑、有限、面向演出的行式 DSL；Runtime 将 DSL 编译成内部类型，并继续负责 ID、状态、分支、持久化、媒体和 UI。

模型协议不再等同于内部 RuntimeEvent，也不再等同于持久化格式。

---

# 1. 当前仓库基线

当前仓库已经完成较多运行时基础设施，不应推倒重建。

## 1.1 当前已经具备的能力

仓库当前已经实现：

* OpenAI-compatible 流式 LLM 调用。
* 按换行增量解析模型输出。
* JSONL Schema 校验与修复重试。
* dialogue / narration。
* choice 兼容层。
* `interaction` 三种模式：

  * choice
  * input
  * hybrid
* input bridge。
* 自由输入 Preview → Confirm / Cancel 流程。
* hybrid 中选项与自由输入双路径。
* 固定选项 BranchManager 与候选分支预生成。
* candidate → active 分支提升。
* PlaybackBuffer。
* StoryState / state_patch。
* RuntimeCommand / RuntimeOutput。
* Node/Web Host 分层。
* WebSocket wire。
* Web `InteractionPanel`。
* Web 重连后的 UiProjection。
* TTS / CosyVoice / 音频缓冲与缓存。
* JSONL session 持久化。

当前模型协议仍由 `prompts/instructions.yaml` 定义为严格 JSONL，`openai-compatible-generator.ts` 按完整行执行：

```text
chunk
→ newline
→ JSON.parse
→ StatePatch / ModelEvent Schema
→ validateEvent
→ onEvent
```

随后请求结束后再次做整段 terminal contract 校验。

当前 `model-jsonl.ts` 对 opening / continuation 要求：

```text
完整剧情段
→ 最后一条必须是
   choice / interaction / end
```

而 branch prefetch：

```text
只允许 narration / dialogue
```

当前这些规则已经较稳定，因此 DSL 重构应该尽可能保留：

```text
流式增量发布
分支生命周期
InteractionPolicy
输入 Preview
InputResponse
TTS
RuntimeCommand / RuntimeOutput
SessionStore
```

而不是重新实现整套 Game。

---

# 2. 当前仓库与目标设计的主要差异

## 2.1 模型协议

当前：

```json
{"type":"dialogue","speaker":"苏遥","text":"别碰它。","portrait":{"character":"suyao","expression":"anxious","position":"left"}}
```

目标：

```text
苏遥[anxious|left]: 别碰它。
```

当前 interaction：

```json
{
  "type": "interaction",
  "interaction_id": "int_1",
  "prompt": "怎么回应？",
  "mode": "hybrid",
  "options": [
    {
      "id": "ask_reason",
      "text": "继续追问"
    }
  ],
  "input": {
    "kind": "free_text",
    "placeholder": "输入自己的回答……",
    "max_length": 200
  },
  "input_bridge": {
    "events": [...]
  }
}
```

目标：

```text
? 怎么回应？
+ 继续追问
= 输入自己的回答……
/?
```

模式由 DSL 内容推导，不再要求模型输出：

```text
mode
interaction_id
option.id
input.kind
input.max_length
```

---

# 3. 模型 DSL 的职责边界

DSL 只负责：

```text
剧情正文
角色发言
背景变化
角色立绘变化
角色位置
显示名称
BGM
音效
玩家交互表单
必要的纯演出节点
生成段结束
```

DSL 不负责：

```text
event_id
line_id
interaction_id
option_id
branch_id
generation_id

StoryStatePatch
玩家历史
数据库字段
TTS provider
voice ID

资源真实 URL / 文件路径
像素坐标
z-index
CSS
动画具体时间
```

因此架构应明确分成：

```text
Writer LLM
    │
    ▼
Gal DSL
    │
    ▼
DSL Parser / Compiler
    │
    ▼
Runtime EventGroup
    │
    ├── Story Runtime
    ├── Visual Runtime
    ├── Branch Runtime
    ├── Media Runtime
    └── Persistence
```

---

# 4. DSL 基础语法

## 4.1 旁白

普通非命令文本：

```text
地下室没有开灯。
```

即 narration。

不需要：

```text
n
narration
旁白:
```

---

# 5. 角色台词

完整格式：

```text
<角色>[<sprite>|<position>](<display_name>): <text>
```

例如：

```text
苏遥[anxious|left](神秘女子): 你问我是谁？保密。
```

三个部分都支持缺省。

---

# 6. 最简角色台词

```text
苏遥: 我已经说过了。
```

表示：

```text
角色 = 苏遥

sprite       KEEP
position     KEEP
display_name KEEP
visibility   KEEP
```

如果角色从未建立 PresentationState，Runtime 才从资源配置初始化默认值。

---

# 7. 默认 Sprite Set

角色通过资源配置绑定默认 sprite set：

```yaml
characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥

    sprite_set: suyao
    default_variant: normal
    default_position: left
```

因此：

```text
苏遥[anxious]: ...
```

等价于：

```text
character = suyao
sprite_set = suyao
variant = anxious
```

模型不需要重复输出 `suyao:`。

---

# 8. 覆写 Sprite Set

需要特殊素材时：

```text
苏遥[placeholder_char:anxious]: ...
```

表示：

```text
character = suyao

sprite_set = placeholder_char
variant = anxious
```

**§15 限制（本轮新增）**：覆写只能使用该角色 `allowed_sprite_sets`（
`resources.yaml` 角色配置的 `allowed_sprite_sets`，缺省仅自身 `sprite_set`）
内的素材组。Compiler 对超出列表的 `[spriteSet:variant]` 丢弃整条 character
cue 并记录 `FORBIDDEN_SPRITE_SET` 诊断（降级为保持现状）。换装/伪装需作者在
角色绑定中显式列出 `allowed_sprite_sets`；Loader 启动校验保证列表引用存在且
包含角色自身的 sprite_set。

也可以：

```text
苏遥[placeholder_char:anxious|right]: ...
```

---

# 9. 角色位置

第一版只允许离散槽位：

```text
far_left
left
center
right
far_right
```

例如：

```text
苏遥[|right]: 站远一点。
```

只设置：

```text
position = right
```

不要允许模型输出：

```text
x=324
y=92
scale=0.87
z-index=7
```

这些由 Renderer 负责。

---

# 10. 显示名称

```text
苏遥(神秘女子): 不要靠近。
```

其中：

```text
character_id = suyao
display_name = 神秘女子
```

角色真实身份始终是：

```text
suyao
```

因此：

* StoryState 使用 `suyao`。
* TTS 使用 `suyao`。
* 资源绑定使用 `suyao`。
* 玩家 UI 显示“神秘女子”。

这点需要特别修改当前仓库。

当前 RuntimeDialogue 主要依赖 `speaker`，TTS 配置也以角色显示名称为 key。

引入 display-name override 后：

```text
speaker
```

不能继续承担角色身份。

必须新增稳定：

```ts
characterId: CharacterId;
```

例如：

```ts
{
  type: "dialogue",
  characterId: "suyao",
  speaker: "神秘女子",
  text: "别碰它。",
  line_id: "..."
}
```

TTS 查：

```text
characterId
```

而不是：

```text
speaker
```

否则身份隐藏时会找不到苏遥音色。

---

# 11. PresentationState 的 KEEP / SET / RESET

必须明确区分：

```text
省略
填写
显式空括号
```

内部推荐：

```ts
type PatchValue<T> =
  | { op: "keep" }
  | { op: "set"; value: T }
  | { op: "reset" };
```

总规则：

```text
省略      = KEEP
填写      = SET
空容器    = RESET
```

---

# 12. `[]` 视觉复位

```text
苏遥[]: 算了。
```

表示视觉状态恢复角色 YAML 默认值：

```text
sprite_set → default sprite_set
variant    → default variant
position   → default position
visible    → true
```

但显示名称继续继承。

---

# 13. `()` 名称复位

```text
苏遥(): ……我的名字是苏遥。
```

只执行：

```text
display_name → default display_name
```

sprite / position 不变。

---

# 14. `[]()` 完整复位

```text
苏遥[](): 抱歉。
```

表示恢复全部 Presentation 默认值：

```text
sprite_set
variant
position
display_name
visible
```

---

# 15. 禁止模糊空格式

只定义：

```text
[]
```

作为 Visual Reset。

以下形式无意义：

```text
[|]
[:]
[:|]
```

Parser 应直接拒绝。

---

# 16. 状态继承示例

```text
苏遥[anxious|right](神秘女子): 你不该来这里。

苏遥: 现在离开还来得及。

苏遥[angry]: 我说，出去。

苏遥(): ……我的名字是苏遥。

苏遥[]: 抱歉，刚才有些失态。
```

状态：

```text
anxious / right / 神秘女子
          ↓
anxious / right / 神秘女子
          ↓
angry   / right / 神秘女子
          ↓
angry   / right / 苏遥
          ↓
normal  / left  / 苏遥
```

---

# 17. Standalone `ch`

没有角色台词，但需要提前操作立绘时：

```text
ch suyao:anxious left
```

格式：

```text
ch <character_id>:<variant> [position]
ch <character_id> hide|show|exit
```

这里使用稳定内部 character ID，而不是 script name。

`hide` 仅隐藏（保留状态）；`exit` 彻底离开舞台（状态移除，下次台词重新按默认登台）。

原因：

`ch` 本身没有角色台词头可供 Runtime 做 script_name → characterId 映射。

例如：

```text
ch suyao:anxious left
```

---

# 18. 隐藏与重新显示

```text
ch suyao hide
```

只执行：

```text
visible = false
```

保留：

```text
sprite_set
variant
position
display_name
```

重新显示：

```text
ch suyao show
```

继续使用隐藏前状态。

---

# 19. Hidden 角色说话

```text
ch suyao hide
苏遥: 别回头。
```

不会自动显示苏遥。

这自然支持：

```text
画外音
电话
隔墙说话
幕后角色
```

若希望再次显示：

```text
苏遥[normal|left]: 别回头。
```

或者：

```text
ch suyao show
苏遥: 别回头。
```

**§19b 站位互斥（本轮新增）**：一个槽位同时只能有一个可见角色。
角色以可见状态占到一个已被占用的位置时，原占位者自动 `visible = false`
（保留 sprite_set/variant/position/display_name，可被 `show` 或显式换位恢复）。
这是引擎强制的确定性规则——不依赖模型记得 `hide`。

**§19c 退场 `ch <id> exit`（本轮新增）**：从 VisualState 中彻底移除该角色
（渲染器删除其 DOM 节点），下次台词按角色默认重新登台。`hide` 保留状态，
`exit` 撤离舞台。

---

# 20. 背景

```text
bg basement
```

使用逻辑资源 ID。

背景持续存在，直到新的：

```text
bg ...
```

模型不得重复当前背景。

---

# 21. BGM

```text
bgm mystery
```

持续到：

```text
bgm calm
```

或者：

```text
bgm stop
```

---

# 22. 音效

```text
se terminal_beep
```

属于一次性 StageCue。

---

# 23. `beat`

用于没有正文的独立视觉节点：

```text
bg black
bgm stop
beat
```

例如：

```text
苏遥: 再见。

bg black
bgm stop
beat

bg hospital_room
三天后。
```

`beat` 不要求模型提供：

```text
duration_ms
```

具体转场时间由 Renderer 决定。

---

# 24. 表单 DSL

新的表单统一使用：

```text
?
+
=
/?
```

Runtime 根据内容自动推断 interaction mode。

模型不再输出 `mode`。

---

# 25. 纯选项

```text
? 怎么回应？
+ 追问她所谓“启动之后”究竟发生过什么
+ 暂时停手，要求她先解释自己知道多少
+ 无视警告，继续操作终端
/?
```

存在：

```text
+
```

不存在：

```text
=
```

因此：

```text
mode = choice
```

---

# 26. 纯输入

```text
? 你准备对她说什么？
= 输入你的回答……
/?
```

不存在 `+`，存在 `=`：

```text
mode = input
```

---

# 27. 混合模式

```text
? 怎么回应？
+ 追问她所谓“启动之后”究竟发生过什么
+ 暂时停手，要求她先解释自己知道多少
+ 无视警告，继续操作终端
= 或输入自己的回答……
/?
```

同时存在：

```text
+
=
```

因此：

```text
mode = hybrid
```

---

# 28. 表单推导规则

Parser 只允许：

```text
+ 数量 >= 1
= 数量 = 0

→ choice
```

```text
+ 数量 = 0
= 数量 = 1

→ input
```

```text
+ 数量 >= 1
= 数量 = 1

→ hybrid
```

以下无效：

```text
?
/?
```

因为既没有选项，也没有输入。

以下同样无效：

```text
= 输入 A
= 输入 B
```

第一版一个 Interaction 只允许一个输入框。

---

# 29. InteractionPolicy 仍然保留

当前仓库已有 InteractionPolicy，检查：

* allowed_modes
* options min/max
* option ID unique
* input max length
* 连续 pure input 数量
* choice/input/hybrid 字段一致性
* input bridge

重构后不要删除这个 policy。

改变的是：

> Schema/Parser 负责从 DSL 推导结构，InteractionPolicy 继续负责业务规则。

例如：

```text
? 怎么回应？
+ A
/?
```

语法上能解析成 `choice`。

但如果配置：

```yaml
min_count: 2
```

InteractionPolicy 应拒绝。

---

# 30. Runtime 自动生成 interaction ID

DSL：

```text
? 怎么回应？
+ A
+ B
/?
```

不包含：

```text
interaction_id
option_id
```

Runtime 编译：

```ts
{
  type: "interaction",
  interaction_id: "interaction_0042",
  mode: "choice",
  prompt: "怎么回应？",
  options: [
    {
      id: "interaction_0042_opt_0",
      text: "A"
    },
    {
      id: "interaction_0042_opt_1",
      text: "B"
    }
  ]
}
```

模型没有理由参与机器 ID 管理。

---

# 31. InputSpec 简化

当前模型需要输出：

```json
{
  "kind": "free_text",
  "placeholder": "...",
  "max_length": 200
}
```

DSL 后：

```text
= 输入自己的回答……
```

只让模型控制：

```text
placeholder
```

Runtime 根据配置补：

```ts
{
  kind: "free_text",
  placeholder: "...",
  max_length: config.interaction.input.max_length
}
```

第一版不再让剧情模型控制：

```text
kind
max_length
```

原因：

这些字段主要属于 UI / Runtime policy，而不是剧情创作。

---

# 32. Input Bridge 与新 DSL 的冲突

这是当前仓库迁移中最重要的兼容问题。

当前：

```text
input / hybrid
```

必须由同一 InteractionEvent 内嵌：

```text
input_bridge
```

并且 InteractionPolicy 要求 bridge 含 1–2 条 narration。

新的：

```text
? / + / = /?
```

没有携带 input_bridge。

不建议为了兼容旧 JSON 结构给新 DSL 增加大量 bridge 字段。

建议：

> Input Bridge 从 Interaction 的模型字段中拆出，改成 Interaction 解析完成后自动启动的 speculative generation task。

---

# 33. 新 Input Bridge 流程

当 Parser 完成：

```text
? 怎么回应？
+ ...
= 输入自己的回答……
/?
```

Runtime 得知：

```text
mode = hybrid
```

立即并发启动：

```text
固定 option branch prefetch
+
input bridge prefetch
```

例如：

```text
Interaction discovered
       │
       ├── option A prefetch
       ├── option B prefetch
       ├── option C prefetch
       └── input bridge prefetch
```

玩家正在：

```text
阅读
思考
输入
```

因此 bridge 请求延迟通常隐藏在玩家操作时间中。

---

# 34. Bridge 规则保持现有约束

Bridge 继续限制为：

```text
1–2 条 narration
```

不得：

```text
回答玩家尚未提交的内容
引入新事实
产生 Interaction
修改 StoryState
改变背景
改变 BGM
改变角色立绘
产生音效
```

Bridge 的目的仍然只是：

> 玩家确认输入后，在 NPC 正式回应到达前提供一个安全、场景相关的短过渡。

---

# 35. Hybrid 分支处理

对于：

```text
hybrid
```

如果玩家选择 preset option：

```text
提交对应 BranchCandidate
取消 / 丢弃 input bridge
```

如果玩家提交自由输入：

```text
丢弃 preset option candidates
提交玩家台词
播放已完成 bridge
消费正在流式生成的 NPC response
```

如果玩家 Preview Cancel：

```text
保留当前 interaction
重新开放选项 + 输入
重新建立被取消的 candidate
```

必须保留当前仓库已经修好的这一行为。

不得在 DSL 重构中重新引入“取消输入后 option 失效”的旧 bug。

---

# 36. EventGroup

这是新协议最重要的中间结构。

DSL：

```text
bg abandoned_station
bgm mystery
苏遥[anxious|left]: 等等，这里不对劲。
```

不是三个玩家 Advance。

它是：

```ts
interface EventGroup {
  prelude: StageCue[];
  main: MainEvent;
}
```

例如：

```ts
{
  prelude: [
    {
      type: "background",
      assetId: "abandoned_station"
    },
    {
      type: "bgm",
      assetId: "mystery"
    },
    {
      type: "character_patch",
      characterId: "suyao",
      variant: {
        op: "set",
        value: "anxious"
      },
      position: {
        op: "set",
        value: "left"
      }
    }
  ],

  main: {
    type: "dialogue",
    characterId: "suyao",
    text: "等等，这里不对劲。"
  }
}
```

---

# 37. Pending Cue

Parser 持有：

```ts
pendingCues: StageCue[];
```

解析：

```text
bg ...
bgm ...
ch ...
se ...
```

时只写入 pending。

不立即发布。

直到遇到：

```text
dialogue
narration
interaction complete
beat
```

才形成 EventGroup。

---

# 38. 为什么必须 Pending

如果流中断：

```text
A: 我们走吧。
bg abandoned_station
bgm mystery
```

实际画面不能立即切到车站。

因为模型可能本来准备输出：

```text
苏遥: 等等。
```

但请求遭到截断。

正确状态：

```text
A 台词
→ 已提交

bg + bgm
→ pending
→ 未展示
```

恢复后：

```text
苏遥: 等等。
```

才提交完整 EventGroup。

---

# 39. 表单同样是 EventGroup main

例如：

```text
bg rooftop_night
bgm confrontation

? 怎么回答？
+ 相信她
+ 拒绝她
= 说出自己的想法……
/?
```

只有读到：

```text
/?
```

后才能提交：

```text
prelude:
  bg rooftop_night
  bgm confrontation

main:
  HybridInteraction
```

---

# 40. Parser 分层

不要写一个数百行正则 Parser。

建议拆成四层：

```text
StreamLineDecoder
        ↓
DslLineParser
        ↓
EventGroupBuilder
        ↓
SegmentValidator
```

---

# 41. StreamLineDecoder

职责：

```text
网络 chunk
→ 拼接字符
→ 遇到 newline
→ 输出完整 line
```

类似当前 StoryGenerator 中 `streamLines()`。

这一层当前代码可直接改造复用。

---

# 42. DslLineParser

只解析单行。

输出：

```ts
type DslLine =
  | DialogueLine
  | NarrationLine
  | BackgroundCueLine
  | BgmCueLine
  | CharacterCueLine
  | SoundCueLine
  | InteractionStartLine
  | InteractionOptionLine
  | InteractionInputLine
  | InteractionEndLine
  | BeatLine
  | SegmentEndLine;
```

不要在此层处理 Runtime ID。

---

# 43. EventGroupBuilder

维护：

```ts
interface GroupBuilderState {
  pendingCues: StageCue[];
  openInteraction?: InteractionBuilder;
}
```

职责：

```text
StageCue
→ pending

Dialogue
→ pending + dialogue → group

Narration
→ pending + narration → group

?
→ open form

+
→ append option

=
→ set input field

/?
→ finish form
→ pending + interaction → group

beat
→ pending + beat → group
```

---

# 44. SegmentValidator

维护：

```text
generation nonce
是否已经看到 @end
last main event
openInteraction
pending tail
```

只有合法：

```text
@end <nonce> <reason>
```

才认定一次请求完整结束。

---

# 45. Generation Sentinel

每次请求由 Runtime 创建 nonce：

```text
a81f
```

模型最后必须输出：

```text
@end a81f buffer
```

或者：

```text
@end a81f interaction
```

或者：

```text
@end a81f ending
```

---

# 46. `buffer`

```text
@end a81f buffer
```

表示：

```text
当前只完成一段正常未来剧情
故事没结束
当前也没有等待玩家 interaction
```

这是后续低水位续写的基础。

---

# 47. `interaction`

要求最后完整 main 是 Interaction：

```text
?
...
/?
@end a81f interaction
```

---

# 48. `ending`

```text
@end a81f ending
```

同时承担：

```text
generation complete
+
story end
```

Runtime 自动创建内部 EndEvent 和 ending ID。

不再让模型生成：

```json
{
  "type": "end",
  "ending_id": "..."
}
```

---

# 49. 截断判断

当前仓库只能通过：

```text
JSON 尾部非法
terminal event contract
```

间接判断截断。

新协议显式规定：

```text
没有看到正确 @end nonce
=
INCOMPLETE_SEGMENT
```

即使最后一行本身语法完整：

```text
苏遥: 等等。
```

只要：

```text
@end nonce ...
```

不存在，就不能认为请求自然完成。

---

# 50. 截断时已完成 Group 不回滚

例如：

```text
苏遥: 你来了。
地下室没有开灯。
苏遥: 其实我一直想告
```

流结束。

结果：

```text
前两组
→ 保留

最后残片
→ 丢弃

segment
→ incomplete
```

这继续保留当前 JSONL 实现已经具备的：

> 流已经发布的前缀不能因尾部损坏而整体重试。

---

# 51. Recovery

如果已经发布 EventGroup 后出错：

禁止从当前请求开头重新生成。

否则会：

```text
重复台词
重复 line_id
重复 TTS
重复视觉变化
```

应创建 recovery generation：

```text
LAST_COMMITTED_GROUP
PENDING_CUES
CURRENT / TAIL VISUAL STATE
DISCARDED_PARTIAL_TAIL
NEW NONCE
```

让模型从已确认边界继续。

---

# 52. VisualState

新增核心类型：

```ts
interface VisualState {
  background?: AssetId;
  bgm?: AssetId;

  characters: Record<CharacterId, CharacterPresentationState>;
}
```

角色：

```ts
interface CharacterPresentationState {
  spriteSet: SpriteSetId;
  variant: VariantId;
  position: CharacterPosition;
  displayName: string;
  visible: boolean;
}
```

---

# 53. VisualState Reducer

必须是纯函数：

```ts
reduceVisualState(
  state: VisualState,
  cues: StageCue[],
): VisualState
```

它不访问 DOM。

不访问文件。

不播放声音。

只计算状态。

这样才能用于：

```text
正式路径
候选分支
测试
恢复
UI projection
提示词构建
```

---

# 54. 实际视觉状态与未来视觉状态必须分开

这是引入流式预生成后很容易出错的地方。

例如：

```text
玩家现在正在看第 5 句

第 8 句已经预生成：
bg rooftop
苏遥[angry]: ...
```

此时真正 UI 仍是：

```text
basement
anxious
```

但生成第 9 句时，模型应该知道第 8 句之后将是：

```text
rooftop
angry
```

因此 Runtime 至少维护：

```text
renderedVisualState
```

玩家目前实际看到的状态。

以及：

```text
tailVisualState
```

当前正式缓冲尾部执行完成后的预测状态。

候选分支还需要：

```text
branchTailVisualState
```

---

# 55. 为什么不能只有一个 VisualState

如果生成时直接修改实际 VisualState：

```text
背景会提前切换
```

如果直到玩家播放时才修改：

```text
下一轮 LLM 不知道已预生成内容最终留下什么视觉状态
```

所以：

```text
生成
→ reducer 计算 tail

播放
→ reducer 更新 rendered
```

二者生命周期不同。

---

# 56. Branch Visual Isolation

候选分支：

```text
A:
  苏遥[happy]

B:
  苏遥[angry]
```

两者不能互相污染，更不能污染正式画面。

BranchCandidate 新增：

```ts
interface BranchCandidate {
  ...
  groups: EventGroup[];

  baseVisualState: VisualState;
  tailVisualState: VisualState;
}
```

玩家选 A 后才提交 A 的 groups。

B 直接丢弃。

---

# 57. 资源 YAML

新增独立资源文件，建议：

```text
assets/resources.yaml
```

不要继续往 `config.yaml` 塞所有美术资源。

`config.yaml` 负责：

```text
程序行为
阈值
provider
并发
policy
```

`resources.yaml` 负责：

```text
有哪些资源
资源文件在哪里
资源在剧情中代表什么
模型什么时候应该用
角色与素材如何绑定
```

---

# 58. 推荐资源结构

```yaml
guidance: |
  当前素材主要覆盖校园、住宅、地下设施和夜间城市场景。

  整体采用偏冷色调的写实二次元风格。

  背景应尽量复用已有资源，不要因为轻微视角变化频繁切换。

  角色表情资源有限。
  anxious 仅用于明显紧张、不安、担忧或试图掩饰信息。
  普通疑问不应使用 anxious。

  placeholder_char 只用于没有正式角色素材的临时人物。

backgrounds:
  classroom_day:
    src: backgrounds/classroom_day.webp
    description: |
      白天普通教室。
      适合正常课堂、放学前和普通校园交流。

  classroom_evening:
    src: backgrounds/classroom_evening.webp
    description: |
      黄昏教室。
      适合私下交流、安静场景和剧情转折。

  basement:
    src: backgrounds/basement.webp
    description: |
      昏暗地下设备间。
      主要用于旧终端相关剧情。

bgm:
  quiet_evening:
    src: audio/bgm/quiet_evening.ogg
    description: |
      安静、略带距离感。
      不适合高强度冲突。

  mystery:
    src: audio/bgm/mystery.ogg
    description: |
      轻度悬疑和未知感。
      适合调查、异常信息和隐藏秘密。

sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: |
      旧终端发出的短促电子提示音。

sprite_sets:
  suyao:
    description: |
      苏遥正式立绘。

    variants:
      normal:
        src: characters/suyao/normal.webp
        description: 默认冷静状态。

      anxious:
        src: characters/suyao/anxious.webp
        description: |
          明显紧张、不安、担忧或试图隐瞒事实时使用。

      angry:
        src: characters/suyao/angry.webp
        description: |
          真正生气、受到明显冒犯或严重冲突时使用。

  placeholder_char:
    description: |
      通用临时角色。
      只在没有正式角色素材时使用。

    variants:
      normal:
        src: characters/placeholder/normal.webp

characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥

    sprite_set: suyao
    default_variant: normal
    default_position: left
```

---

# 59. Runtime Catalog 与 Model Catalog 分离

不要把完整：

```text
src: characters/suyao/normal.webp
```

每轮发给模型。

加载 YAML 后建立两个投影。

Runtime：

```ts
RuntimeAssetCatalog
```

包含：

```text
src
URL
Blob key
cache key
```

模型：

```ts
ModelAssetCatalog
```

只包含：

```text
logical ID
description
guidance
角色绑定
variant
```

例如模型实际看到：

```yaml
backgrounds:
  basement:
    description: 昏暗地下设备间，主要用于旧终端剧情。
```

而不是具体路径。

---

# 60. AssetManager

新增：

```ts
interface AssetResolver {
  resolveBackground(id: string): AssetRef;
  resolveSprite(spriteSet: string, variant: string): AssetRef;
  resolveBgm(id: string): AssetRef;
  resolveSoundEffect(id: string): AssetRef;
}
```

第一版资源来源可以仍是：

```text
静态文件
```

未来再接：

```text
IndexedDB
生成资源
远端 URL
Blob
```

DSL 不需要改变。

---

# 61. 当前 `portrait` 模型需要淘汰

当前 schema：

```ts
portrait: {
  character,
  expression,
  position
}
```

有两个主要问题：

1. 每句话重复完整 portrait。
2. portrait 只能挂在当前 dialogue，无法描述持续立绘状态。

目标：

```text
portrait
→ presentation patch + VisualState
```

兼容迁移期可以继续读取旧 Session portrait。

但新模型 DSL 不再产生 portrait JSON。

---

# 62. Runtime Dialogue 新结构

建议：

```ts
interface RuntimeDialogueEvent {
  type: "dialogue";

  characterId: CharacterId;
  speaker: string;

  text: string;
  line_id: string;

  stage?: StageCue[];
}
```

其中：

```text
characterId
```

用于：

```text
角色身份
TTS
StoryState
资源
```

`speaker`：

```text
该句玩家实际看到的名称
```

---

# 63. EventGroup 是否需要永久存在

推荐：

> Parser 和 PlaybackBuffer 使用 EventGroup；持久化可选择把 group 展平到事件的 `stage` 字段。

这样不要求整个仓库所有接口都认识 EventGroup。

例如：

```ts
{
  type: "dialogue",
  characterId: "suyao",
  speaker: "神秘女子",
  text: "...",
  stage: [
    { type: "background", ... },
    { type: "character_patch", ... }
  ]
}
```

PlaybackBuffer 可以先真正迁移到：

```ts
PlaybackBuffer<RuntimeEventGroup>
```

后续再决定是否展平存储。

---

# 64. Web UI 目前缺失的部分

当前 Web `GameViewModel` 主要保存：

```text
currentLine
currentInteraction
currentPreview
recentLines
status
ending
```

尚没有权威：

```text
background
bgm
characters
```

因此新增：

```ts
visualState: VisualStateWire;
```

到：

```text
UiProjection
```

重连时服务器必须恢复完整视觉状态。

不能只依赖“最近几条 stage cue”重放，因为玩家可能已经经过很长剧情。

---

# 65. RuntimeOutput

现有：

```text
playback_ready
interaction_opened
...
```

可以尽量保留。

推荐扩展：

```ts
{
  type: "playback_ready";
  event: RuntimePlayableEvent;
  presentation?: StagePresentationDelta;
}
```

以及：

```ts
{
  type: "interaction_opened";
  interactionId: string;
  interaction: RuntimeInteractionEvent;
  presentation?: StagePresentationDelta;
}
```

纯 `beat` 增加：

```ts
{
  type: "stage_beat_ready";
  presentation: StagePresentationDelta;
}
```

这样不用重写已经稳定的 InteractionPanel 生命周期。

---

# 66. Web Renderer

新增：

```text
web/src/stage/
├─ stage-renderer.ts
├─ background-layer.ts
├─ character-layer.ts
├─ bgm-controller.ts
└─ stage-types.ts
```

职责：

```text
VisualState
→ DOM / Canvas
```

第一版建议：

```text
背景变化
→ crossfade

人物显示
→ fade

variant 变化
→ crossfade

位置变化
→ translate

hide
→ fade out
```

具体动画不让 LLM 决定。

---

# 67. TTS 兼容

当前音频流水线应尽量保持不动。

但角色身份必须改成：

```text
characterId
```

否则：

```text
苏遥(神秘女子):
```

可能被当成新 speaker。

兼容阶段：

```text
characterId
→ character registry
→ voice profile
```

如果旧事件只有：

```text
speaker
```

则 fallback 到当前旧映射。

---

# 68. 主模型 Prompt 重构

当前 `instructions.yaml` 中 `output_protocol` 很长，大量 Token 用来解释 JSON。

重构后建议拆：

```text
prompts/
├─ dsl-protocol.txt
├─ instructions.yaml
├─ characters.txt
├─ story_line.txt
├─ guideline.txt
└─ author.yaml
```

其中：

```text
dsl-protocol.txt
```

为稳定 System Prompt。

`instructions.yaml` 只保存：

```text
opening
active_refill
branch_prefetch
input_bridge
input_response
recovery
ending
```

---

# 69. Context Builder 重构

当前 history 使用：

```ts
JSON.stringify(event)
```

逐行发给模型。

DSL 重构后应避免再次用 JSON 消耗大量输入 Token。

新增：

```ts
serializeStoryContext()
serializeVisualContext()
serializeResourceContext()
```

例如历史可变成：

```text
[玩家] 选择：继续追问
苏遥: 你最好别再问。
终端重新亮起。
```

不需要：

```json
{
  "seq": ...,
  "turn": ...,
  ...
}
```

---

# 70. 生成 Prompt 动态上下文

每次生成至少提供：

```text
TASK_TYPE
GENERATION_NONCE
TARGET_PLAYABLE_EVENTS

STORY_CONTEXT
CHARACTER_CONTEXT
RECENT_EVENTS

TAIL_VISUAL_STATE

MODEL_ASSET_CATALOG

PLAYER_ACTION
AUTHOR_RULES
```

注意生成后续内容时更应该提供：

```text
TAIL_VISUAL_STATE
```

而不是仅：

```text
renderedVisualState
```

因为模型是在续写缓冲尾部。

---

# 71. 模型资源选择原则

Prompt 必须强调：

```text
已有状态不变化
→ 不重复输出

存在理想素材
→ 使用 logical asset ID

没有理想素材
→ 优先保持当前状态或使用最接近现有资源

绝不猜测不存在 asset ID
```

---

# 72. 模型输出终止

当前 opening / continuation 强制：

```text
最后必须 interaction/end
```

新协议不再需要。

允许：

```text
几句正常剧情
@end nonce buffer
```

这是低水位动态续写的必要条件。

---

# 73. 当前低水位实现差距

当前 `PlaybackBuffer` 已经有：

```text
countTextLinesAhead()
hasUnconsumedInteraction()
```

但仓库目前主生成仍然以：

```text
一次生成到 interaction/end
```

为主要 segment contract。

因此之前设计的：

```text
target = 6
refill = 3
```

尚未真正成为主剧情调度规则。

DSL 迁移后应该补上这一层。

---

# 74. 文本缓冲配置

建议新增：

```yaml
text_buffer:
  start_threshold_lines: 2
  target_lines: 6
  refill_threshold_lines: 3
```

播放达到两句即可开始。

正常保持六句未来内容。

只剩三句时启动 active refill。

---

# 75. 低水位规则

必须保持不变量：

```text
如果：

未来可播放文本 <= refill threshold

并且：

没有未消费 interaction

并且：

没有 active generation

那么：

必须启动 active_refill
```

---

# 76. 为什么 DSL 的 `buffer` end 很重要

过去：

```text
一次 generation
→ 必须到 interaction
```

新设计：

```text
generation A
→ 4 句
→ @end buffer

玩家继续阅读

buffer 降低

generation B
→ 5 句
→ @end buffer

最终：

generation C
→ interaction
→ @end interaction
```

模型请求不再绑定“完整场景”。

---

# 77. 分支预取继续保留

固定选项解析完成后：

```text
+
+
+
```

Runtime 自动分配 option IDs 并启动：

```text
Branch A
Branch B
Branch C
```

Branch prefetch 同样使用 DSL。

但限制：

```text
只允许 dialogue
narration
bg
bgm
ch
se
beat
```

不得产生：

```text
?
+
=
/?
@end interaction
```

最终：

```text
@end nonce buffer
```

---

# 78. 分支预取允许视觉演出

当前 branch prefetch 只返回 narration/dialogue。

新版本应该允许分支短片段拥有：

```text
表情变化
角色移动
必要背景变化
音效
BGM
```

因为这些都可能是玩家选择的直接结果。

但它们全部进入：

```text
BranchCandidate EventGroups
```

未选分支绝不能实际执行。

---

# 79. Input Response

玩家确认后：

```text
玩家自己的 dialogue
→ bridge
→ live input response
```

InputResponse DSL 可以允许：

```text
dialogue
narration
ch
se
```

必要时允许 bg/bgm。

但第一阶段仍限制：

```text
不得生成 interaction
```

直到正式 active refill 接管。

这样保持当前仓库已经实现的：

```text
input response
→ continuation
```

逻辑。

---

# 80. StoryStatePatch 从主 DSL 移除

当前模型可以在 JSONL 中输出：

```json
{"type":"state_patch","patch":{...}}
```

这与新目标冲突。

主剧情 DSL 不再携带 StoryState。

推荐新增：

```text
StoryStateReconciler
```

输入：

```text
旧 StoryState
+
刚刚正式提交的事件
+
玩家操作
```

输出：

```text
StoryStatePatch
```

这个调用可以继续使用结构化 JSON。

因为它不在：

```text
玩家等待下一句
```

关键路径。

---

# 81. 状态整理时机

正式路径：

```text
EventGroups 进入正式历史
→ 异步 reconcile
→ StoryState patch
```

候选分支：

第一版不要为所有 candidate 都调用状态模型。

否则浪费严重。

推荐：

```text
BranchCandidate
→ 只保存 events

玩家选中
→ 事件成为正式历史
→ 再 reconcile
```

这比现有每个候选携带 provisional state patch 更轻。

---

# 82. Runtime 内部 ID

以下全部 Runtime 生成：

```text
event_id
group_id
line_id
interaction_id
option_id
branch_id
generation_id
ending_id
```

模型一个都不生成。

---

# 83. Model Protocol 与 Session Protocol 分离

必须继续强调：

```text
Gal DSL
=
模型传输协议
```

而：

```text
events.jsonl
=
程序持久化协议
```

不要因为模型不用 JSONL，就删除 JSONL session storage。

实际上 SessionStore 继续 JSONL 很合理：

```text
可追加
可恢复
可调试
结构稳定
```

需要改变的只是存储 schema 支持：

```text
characterId
stage/presentation
interaction 新 Runtime ID
```

---

# 84. 旧 Session 兼容

当前已有：

```text
portrait
legacy choice
interaction JSON
```

新读取逻辑至少在迁移期支持：

```text
旧 portrait
→ 转 CharacterPresentationPatch

旧 choice
→ normalize choice interaction

旧 interaction
→ 当前 InteractionEvent
```

不要要求旧 session 全部失效。

---

# 85. 建议新增目录

```text
src/
├─ core/
│  ├─ protocol/
│  │  └─ gal-dsl/
│  │     ├─ types.ts
│  │     ├─ stream-decoder.ts
│  │     ├─ line-parser.ts
│  │     ├─ interaction-builder.ts
│  │     ├─ group-builder.ts
│  │     ├─ segment-validator.ts
│  │     └─ compiler.ts
│  │
│  ├─ presentation/
│  │  ├─ types.ts
│  │  ├─ reducer.ts
│  │  └─ defaults.ts
│  │
│  └─ assets/
│     ├─ types.ts
│     └─ catalog.ts
│
├─ application/
│  └─ assets/
│     └─ asset-catalog-loader.ts
│
└─ adapters/
   └─ llm/
      └─ openai-compatible-generator.ts
```

Web：

```text
web/src/
├─ stage/
│  ├─ stage-renderer.ts
│  ├─ background-layer.ts
│  ├─ character-layer.ts
│  └─ bgm-controller.ts
│
└─ runtime/
   └─ game-view-model.ts
```

---

# 86. 当前文件的具体改造

## `src/core/protocol/model-jsonl.ts`

当前职责：

```text
JSON parse
state_patch
terminal validation
prefetch validation
```

重构：

```text
保留为 LegacyModelJsonlParser
```

新增：

```text
gal-dsl/*
```

迁移期不要直接删除。

---

## `src/adapters/llm/openai-compatible-generator.ts`

保留：

```text
OpenAI-compatible client
streamLines
abort
repair
metrics
GenerationHandle
```

替换：

```text
JSON.parse(line)
ModelEventSchema.parse()
```

为：

```text
dslDecoder.pushLine()
```

`onEvent` 改为更准确：

```text
onGroup
```

或短期继续通过 compiler 将 EventGroup 转成现有模型事件。

---

## `src/schema.ts`

当前把：

```text
ModelEvent
RuntimeEvent
StoredEvent
```

混在一个文件。

这次不必一次完全拆完。

但至少新增：

```text
CharacterId
StageCue
PresentationPatch
```

并让 RuntimeDialogue 拥有：

```text
characterId
```

旧 `portrait` 保留为 legacy 字段。

---

## `src/story/types.ts`

当前 InteractionEvent 包含：

```text
interaction_id
mode
options.id
InputSpec
input_bridge
```

Runtime 内部仍可以继续使用相似类型。

但应建立：

```text
DslInteractionDraft
```

与 Runtime Interaction 分离。

例如：

```ts
interface DslInteractionDraft {
  prompt: string;
  optionTexts: string[];
  inputPlaceholder?: string;
}
```

Compiler 再生成正式 InteractionEvent。

---

## `src/story/interaction-policy.ts`

保留。

调整：

1. `mode` 由 parser 推导。
2. option ID 由 Runtime 生成，因此 duplicate ID 检查理论上永远不会失败，但可继续作为 invariant。
3. input.max_length 由配置生成。
4. `input_bridge` 不再作为 Interaction Schema 强制字段。
5. Bridge validity 转移到 `InputBridgePrefetcher`。

---

## `src/story/context-builder.ts`

当前：

```text
StoryState
recent events JSON.stringify
output protocol
```

新增：

```text
TailVisualState
ModelAssetCatalog
Task Type
Generation Nonce
Buffer Target
```

同时改掉 JSON history serialization。

---

## `prompts/instructions.yaml`

删除当前大段 JSONL 示例。

改成短任务模板。

完整 DSL 规范移到：

```text
prompts/dsl-protocol.txt
```

---

## `src/runtime/playback-buffer.ts`

当前：

```ts
RuntimeBufferEvent[]
```

目标：

```ts
RuntimeEventGroup[]
```

至少需要：

```text
countPlayableLinesAhead
hasUnconsumedInteraction
peek
advance
```

继续保留。

---

## `src/runtime/branch-manager.ts`

BranchCandidate 改存：

```text
EventGroup[]
tailVisualState
```

选中时批量提交 group。

未选时完全丢弃。

---

## `src/core/runtime/runtime-output.ts`

保留当前 interaction 生命周期输出。

增加：

```text
presentation delta
stage beat
```

不要重做：

```text
input_preview_opened
input_preview_canceled
input_committed
interaction_resolved
```

---

## `src/shared/wire/ui-projection.ts`

新增：

```ts
visualState?: VisualStateWire;
```

这样 WebSocket 重连后可恢复：

```text
背景
立绘
位置
角色可见性
当前 BGM
```

---

## `web/src/runtime/game-view-model.ts`

继续保持“纯 ServerMessage projection”。

不要让浏览器重建 Game 状态机。

只增加：

```text
VisualState projection
```

---

## `web/src/ui/interaction-panel.ts`

基本无需重构。

它已经支持：

```text
choice
hybrid
input
```

`+ / =` 只是模型协议变化。

Parser 最终仍编译成现有 RuntimeInteractionEvent。

因此这里应该只做必要类型适配和回归测试。

---

# 87. 配置修改

建议：

```yaml
generation:
  protocol: dsl
  temperature: 0.9
  max_tokens: 1400
  repair_attempts: 2

text_buffer:
  start_threshold_lines: 2
  target_lines: 6
  refill_threshold_lines: 3

assets:
  catalog: assets/resources.yaml

interaction:
  allowed_modes:
    - choice
    - hybrid
    - input

  options:
    min_count: 2
    max_count: 5

  input:
    max_length: 500
    max_consecutive_pure_input: 1
```

迁移阶段可以：

```yaml
generation:
  protocol: jsonl
```

方便 A/B 测试和快速回滚。

---

# 88. 推荐迁移顺序

不要一次将 JSONL、视觉、buffer、state patch 全部同时改掉。

## Phase 0：冻结当前行为

先增加/保留回归测试：

```text
choice
input
hybrid
preview confirm
preview cancel
hybrid cancel 后 option 仍有效
candidate promotion
input bridge
reconnect projection
audio
legacy choice
```

这一阶段不改功能。

---

# 89. Phase 1：DSL Parser 独立实现

新增：

```text
gal-dsl/
```

只写纯 Parser 测试。

不接 LLM。

测试：

```text
旁白
台词
[]
()
[]()
variant
position
sprite override
bg
bgm
se
ch
beat
?
+
=
/?
@end
```

完成后 Parser 应能从纯文本得到 EventGroup Draft。

---

# 90. Phase 2：资源目录与 VisualState

新增：

```text
resources.yaml
AssetCatalog
CharacterRegistry
VisualState
VisualStateReducer
```

先不用真正渲染。

重点验证：

```text
KEEP
SET
RESET
hidden
show
display-name override
branch state isolation
```

---

# 91. Phase 3：Generator 双协议

`StoryGenerator` 支持：

```text
jsonl
dsl
```

通过 config 切换。

DSL 模式：

```text
streamLines
→ parser
→ EventGroup
→ compiler
```

这一步仍可以先把视觉 cue 保存在内部而不渲染。

验证：

```text
真实模型是否稳定输出 DSL
token 使用
错误率
首组延迟
截断恢复
```

---

# 92. Phase 4：Interaction DSL

把：

```text
?
+
=
/?
```

编译到当前 RuntimeInteractionEvent。

确保 Web InteractionPanel 无感运行。

随后将：

```text
input_bridge
```

从 inline interaction 移到独立 prefetch task。

这是交互层唯一较大行为迁移。

---

# 93. Phase 5：视觉播放

扩展：

```text
RuntimeOutput
UiProjection
GameViewModel
StageRenderer
```

使：

```text
bg
ch
bgm
se
beat
```

真正生效。

第一阶段只要求：

```text
背景
单/多角色立绘
位置
variant
显示/隐藏
```

复杂动画继续 Runtime 默认处理。

---

# 94. Phase 6：EventGroup PlaybackBuffer

PlaybackBuffer 正式迁移：

```text
RuntimeBufferEvent
→ RuntimeEventGroup
```

保证：

```text
prelude + main
```

同一 Advance 执行。

同时补 branch VisualState。

---

# 95. Phase 7：低水位生成

引入：

```text
start threshold
target
refill threshold
```

让：

```text
@end buffer
```

真正发挥作用。

这一步完成后，主生成不再必须一次跑到 Interaction。

---

# 96. Phase 8：StoryState 脱离主 DSL

新增：

```text
StateReconciler
```

停止解析主模型 `state_patch`。

当前 JSONL state patch 路径转为 legacy。

---

# 97. Phase 9：删除模型 JSONL

DSL 稳定一段时间后再删除：

```text
parseTerminalModelJsonl
parsePrefetchModelJsonl
JSONL output_protocol
legacy model choice output
```

但不要删除：

```text
Session JSONL
```

两者不是一回事。

---

# 98. 必须新增的 Parser 测试

### Chunk 边界

输入：

```text
苏遥[anx
```

下一 chunk：

```text
ious|left]: 等等。\n
```

必须只产生一条完整 dialogue。

---

### KEEP

```text
苏遥[anxious|right]: A
苏遥: B
```

B 保持 anxious / right。

---

### RESET Visual

```text
苏遥[anxious|right]: A
苏遥[]: B
```

B 恢复 default visual。

---

### RESET Name

```text
苏遥(神秘女子): A
苏遥(): B
```

B 显示默认名称。

---

### Full Reset

```text
苏遥[placeholder_char:anxious|right](神秘女子): A
苏遥[](): B
```

B 完全恢复默认。

---

# 99. 表单测试

Choice：

```text
? Q
+ A
+ B
/?
```

→ choice。

Input：

```text
? Q
= placeholder
/?
```

→ input。

Hybrid：

```text
? Q
+ A
+ B
= placeholder
/?
```

→ hybrid。

---

# 100. 非法表单

```text
? Q
/?
```

拒绝。

```text
? Q
= A
= B
/?
```

拒绝。

```text
+
```

出现在 form 外：

拒绝。

```text
/?
```

没有 open form：

拒绝。

---

# 101. Pending Cue 截断测试

输入：

```text
A: 第一行
bg station
bgm mystery
```

随后 EOF。

要求：

```text
A
→ committed

bg + bgm
→ pending

实际 VisualState
→ 不改变
```

---

# 102. Interaction 截断测试

```text
? 怎么回应？
+ A
= 输入……
```

EOF。

整个 Interaction：

```text
不得提交
```

---

# 103. Sentinel 测试

正确：

```text
@end a81f buffer
```

错误 nonce：

```text
@end bbbb buffer
```

必须拒绝。

没有 sentinel：

```text
INCOMPLETE
```

sentinel 后有内容：

```text
protocol error
```

---

# 104. Visual Branch Isolation 测试

Root：

```text
suyao = normal
```

Branch A：

```text
苏遥[happy]: ...
```

Branch B：

```text
苏遥[angry]: ...
```

在选择前：

```text
rendered = normal
```

选择 A：

```text
A tail = happy
B discarded
```

不得出现 angry 污染。

---

# 105. TTS Identity 测试

```text
苏遥(神秘女子): 别动。
```

必须：

```text
UI speaker = 神秘女子
TTS character = suyao
voice = suyao_main
```

不得因 displayName override 静音。

---

# 106. Hybrid 回归测试

必须保留当前仓库已修复行为：

```text
打开 hybrid
→ 输入
→ preview
→ cancel
→ hybrid 重新打开
→ option 仍可点击
→ branch 重新 prefetch
```

这是 DSL 重构的硬回归测试。

---

# 107. Reconnect 测试

玩家当前：

```text
background = basement
bgm = mystery

suyao:
  visible = true
  variant = anxious
  position = left
  displayName = 神秘女子
```

WebSocket 断开重连。

收到 UiProjection 后：

必须直接恢复完整画面。

不能要求从第一条剧情重新播放视觉 cue。

---

# 108. 迁移期间禁止做的事情

不要同时：

```text
重写 Game
重写 InteractionPanel
重写 TTS
重写 BranchManager
重写 WebSocket
重写 SessionStore
```

这些部分当前已经拥有大量测试与真实修复。

本次核心改动应聚焦：

```text
Model protocol
DSL parser
EventGroup
VisualState
AssetCatalog
Stage Renderer
```

---

# 109. 第一阶段必须交付的最小闭环

如果需要控制工程范围，第一阶段只要求完成：

```text
DSL:
  narration
  dialogue
  bg
  ch
  ?
  +
  =
  /?
  @end

Visual:
  background
  sprite variant
  position
  display name
  hide/show

Resources:
  YAML
  guidance
  description
```

暂时甚至可以不实现：

```text
BGM
SE
beat
StateReconciler
复杂资源生成
```

不过 Parser 类型应预留这些命令。

---

# 110. 第一阶段验收场景

模型输出：

```text
bg basement

地下室里只亮着终端的一点蓝光。

苏遥[normal|left](神秘女子): 你不该来这里。

苏遥[anxious]: 别碰那台机器。

? 怎么回应？
+ 追问她为什么知道机器仍能运行
+ 暂时停手
= 或说出自己的回答……
/?

@end a81f interaction
```

Runtime 应完成：

```text
1. 解析 basement。
2. 解析旁白。
3. suyao 初始化并显示 normal/left。
4. UI 名称显示“神秘女子”。
5. 下一句只切 anxious。
6. 构建 hybrid Interaction。
7. Runtime 自动分配 interaction/option ID。
8. Option branches 开始预取。
9. Input bridge 开始预取。
10. Web InteractionPanel 同时显示 options + textarea。
```

如果玩家选第一个 option：

```text
选中 BranchCandidate
→ bridge 丢弃
→ branch group 提交
→ 后台继续生成
```

如果玩家输入：

```text
“你明明知道它还在运行。”
```

则：

```text
preview
→ confirm
→ player dialogue
→ bridge
→ streaming NPC response
```

如果 preview cancel：

```text
重新显示原 hybrid
options + input 都恢复
```

---

# 111. 最终目标架构

```text
                        ┌──────────────────┐
                        │  Author Content  │
                        │  Story / Rules   │
                        └────────┬─────────┘
                                 │
                                 ▼
┌────────────────┐      ┌──────────────────┐
│ resources.yaml │─────▶│ Context Builder  │
└────────────────┘      └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │    Writer LLM    │
                        └────────┬─────────┘
                                 │
                               DSL
                                 │
                                 ▼
                      ┌──────────────────────┐
                      │ Streaming DSL Parser │
                      └──────────┬───────────┘
                                 │
                           EventGroups
                                 │
              ┌──────────────────┼───────────────────┐
              │                  │                   │
              ▼                  ▼                   ▼
       Visual Reducer      PlaybackBuffer      BranchManager
              │                  │                   │
              │                  ├─────────────┐     │
              │                  │             │     │
              ▼                  ▼             ▼     ▼
         UiProjection       Text UI         TTS   Candidates
              │
              ▼
        Stage Renderer
```

StoryState 独立：

```text
Committed Runtime Events
          │
          ▼
 StoryState Reconciler
          │
          ▼
     StoryState
```

---

# 112. 最核心的协议边界

重构完成后必须保持以下边界：

```text
LLM
负责：
故事里发生什么
哪个已有背景适合
角色此刻该用哪个已有 variant
什么时候打开什么形式的玩家表单
```

```text
DSL Parser
负责：
这段文本究竟表示什么
结构是否完整
EventGroup 在哪里结束
生成是否遭到截断
```

```text
Runtime
负责：
ID
状态继承
Reset
分支
缓冲
交互生命周期
StoryState
```

```text
AssetManager
负责：
logical asset ID 最终对应什么资源
```

```text
Renderer
负责：
背景具体怎么淡入
立绘具体坐标
动画速度
层级
屏幕适配
```

模型不应该变成一个低级 UI 控制器。

---

# 113. 最终推荐

当前仓库不需要重新设计 interaction runtime。

现有：

```text
InteractionPolicy
Input Preview
Hybrid
BranchManager
RuntimeCommand
InteractionPanel
Web Projection
TTS
```

都应该尽可能原样保留。

真正应该替换的是：

```text
            现在
LLM → JSONL → ModelEvent

              ↓

            目标
LLM → Gal DSL → EventGroup Draft
                 ↓
               Compiler
                 ↓
           Runtime EventGroup
```

并新增：

```text
ResourceCatalog
VisualState
VisualStateReducer
StageRenderer
```

表单则从：

```json
mode + options IDs + InputSpec + interaction ID
```

收敛为：

```text
?
+
=
/?
```

其中：

```text
只有 +        → choice
只有 =        → input
+ 与 = 同时   → hybrid
```

这既保留当前已经验证的三模式交互能力，又显著降低模型协议复杂度。

整个重构的首要目标不是“造一门完整 GalGame 编程语言”，而是建立一层极小的：

> **LLM → Gal 演出意图协议。**

只要这层稳定，之后增加 CG、BGM、SE、动态生成素材、Live2D 或 IndexedDB AssetStore，都不需要再次修改剧情模型的基本输出方式。


---

# 附录 A：实施状态（2025-08 迁移快照）

本文档其余部分为设计。以下是本仓库 `main` 分支当前已完成 / 未完成的对照，供后续开发定位。

## 已完成

- **Gal DSL 解析栈** `src/core/protocol/gal-dsl/`：`types` / `stream-decoder` / `line-parser` / `interaction-builder` / `group-builder` / `segment-validator` / `compiler` / `text-pipeline`，含完整测试。
- **演出状态** `src/core/presentation/`：`types` / `defaults` / `reducer`（KEEP/SET/RESET、first-touch 初始化、hide/show、`bgm stop`、未知角色 no-op）。
- **资源目录** `src/core/assets/` + `src/application/assets/asset-catalog-loader.ts` + `assets/resources.yaml`（Runtime 目录 ↔ Model 目录投影）。
- **配置**：`generation.protocol`（jsonl|dsl）、`text_buffer`、`assets.catalog`。
- **生成器双协议** `src/adapters/llm/openai-compatible-generator.ts`：DSL 流式管道（onGroup / onSegmentEnd / tailVisualState），`generateInputBridge` 新增；JSONL 路径原样保留。
- **提示词重构**：`prompts/dsl-protocol.txt`（稳定 System Prompt）+ `prompts/instructions.yaml`（8 个任务模板）+ context-builder 新增 `buildDslUserPrompt` / `serializeStoryContext` / `serializeVisualContext` / `serializeModelAssetCatalog`。
- **Game DSL 集成** `src/game.ts`：组编译与展平（dialogue/narration 携带 `characterId` + `stage`）、交互编译（运行时生成 interaction_id / option_id / InputSpec）、`@end buffer` 作为正常段边界（BufferOutcome + 低水位续写）、`@end ending` 合成 EndEvent、DSL input/hybrid 的 bridge 独立预取任务、分支/输入回应的分支局部视觉状态与 tail 采纳、`playback_ready` / `interaction_opened` / `stage_beat_ready` 携带 presentation delta。
- **TTS 身份**：`AudioDescriptorFactory` 按 `characterId` 查音色，speaker 回退；config.yaml 双 key。
- **Web**：`UiProjection.visualState` + GameViewModel 投影 + `web/src/stage/` 舞台渲染器（占位渲染：背景/立绘/位置/可见性/BGM 指示）。
- 测试：全仓 1090+ 测试通过，其中新增 gal-dsl（107+）、presentation/assets/config、generator DSL、game-dsl（7）、web stage 渲染器。

## 未完成 / 简化（后续阶段）

- **低水位精细调度**（§73–§76）：`@end buffer` 已驱动立即续写；`text_buffer.start/refill_threshold` 已配置但未用于"读剩 3 句才启动续写"的中途触发（run 循环结构限制，见 §95 之后跟进）。
- **StoryStateReconciler**（§80–§81）：主 DSL 已不含 state_patch；模型状态补丁仍为空，reconciler 未实现（JSONL state_patch 保留为 legacy）。
- **PlaybackBuffer<EventGroup>**（§94）：采用 §63 的展平方案（事件携带 `stage`），缓冲类型未迁移。
- **beat 播放时机**：beat 组在提交时立即应用（stage_beat_ready），不做缓冲时序。
- **BGM/SE 实际音频**：仅进入 VisualState 与 presentation，无播放器；`web/src/stage/bgm-controller.ts` 为占位。
- **Web 资源 src 解析**：舞台为占位渲染（逻辑 id 标签 + 确定性色块）；真实美术接入时补 Runtime → URL 解析。
- **删除模型 JSONL**（§97）：`parseTerminalModelJsonl` / `parsePrefetchModelJsonl` / jsonl `output_protocol` 保留供回滚；SessionStore JSONL 不受影响。

## 验收对照（§110）

`prompts/dsl-protocol.txt` + `config.yaml`（protocol: dsl）下，模型输出 DSL 段即可走通：解析 → 编译 → 角色初始化/立绘/位置/显示名 → 表单（`? + = /?`）→ 运行时 ID → 分支预取 → bridge 预取 → Web 表单 → 输入 preview/confirm/cancel（hybrid 重挂载保持，§106 有回归测试）。
