# LLM GalGame 演出 DSL 与视觉资源系统 — 设计参考

> **文档职能（2026-09-04 拆分）**：本文是 Gal DSL 协议与运行时架构的**规范性设计参考**。
> 原 87KB 单文件已按职能拆分：
>
> - 进度对照（已完成 / 未完成，与代码同步）：`docs/status.md`
> - 实施日志（原 §114–§118 摘编）：`docs/changelog.md`
> - 长线剧情系统：`docs/superpowers/specs/2026-08-09-narrative-director-design.md`
> - 浏览器资源管线：`docs/superpowers/specs/2026-08-08-asset-pipeline-browser-design.md`
>
> 为保持源码注释中的 § 引用有效，保留章节**沿用原编号**；已删除章节的编号留空：
> §1–§2（JSONL 时代基线与差异，该协议已于 2026-08-09 全量移除）、§84–§85（旧会话兼容与旧目录树）、
> §88–§97（迁移顺序，均已落地）、§108–§109（迁移纪律与第一阶段闭环，已完成）、
> §114–§118（实施日志 → changelog.md）、附录 A（实施状态 → status.md）。

## 0. 文档目的

定义 Writer LLM 与 Runtime 之间的行式演出协议（Gal DSL），以及 Runtime 各模块的职责边界。

核心原则：

> 模型输出紧凑、有限、面向演出的行式 DSL；Runtime 将 DSL 编译成内部类型，并继续负责 ID、状态、分支、持久化、媒体和 UI。

模型协议 ≠ 内部 RuntimeEvent ≠ 持久化格式。

---

# 3. 模型 DSL 的职责边界

DSL 只负责：

```text
剧情正文 / 角色发言 / 背景变化 / 角色立绘变化 / 角色位置 / 显示名称
BGM / 音效 / 玩家交互表单 / 必要的纯演出节点 / 生成段结束
```

DSL 不负责：

```text
event_id / line_id / interaction_id / option_id / branch_id / generation_id
StoryStatePatch / 玩家历史 / 数据库字段 / TTS provider / voice ID
资源真实 URL / 像素坐标 / z-index / CSS / 动画具体时间
```

架构分层：

```text
Writer LLM → Gal DSL → DSL Parser / Compiler → Runtime EventGroup
    → Story Runtime / Visual Runtime / Branch Runtime / Media Runtime / Persistence
```

---

# 4. 旁白

普通非命令文本即 narration，不需要 `n` / `narration` / `旁白:` 前缀。

模型层判定标准（详见 `prompts/dsl-protocol.txt`）：旁白是叙述者的声音——环境、动作、
他人行为观察、时间流逝、移动、氛围；**主角的第一人称动作/观察描写也是旁白**，不挂角色名。
判定方法：能否想象角色开口发声？能 → 台词；不能 → 旁白。

---

# 5. 角色台词（完整格式）

```text
<角色>[<sprite>|<position>](<display_name>): <text>
```

例：`苏遥[anxious|left](神秘女子): 你问我是谁？保密。` 三个部分都支持缺省。

---

# 6. 最简台词与状态继承

`苏遥: 我已经说过了。` 表示 sprite / position / display_name / visibility 全部 KEEP。
角色从未建立 PresentationState 时，Runtime 才从资源配置初始化默认值。

---

# 7. 默认 Sprite Set

角色通过资源配置绑定默认素材组（`resources.yaml` 的 `characters` 段）：

```yaml
characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥
    sprite_set: suyao
    default_variant: normal
    default_position: left
```

因此 `苏遥[anxious]: ...` 等价于 `character=suyao, sprite_set=suyao, variant=anxious`，
模型不需要重复输出 `suyao:`。

---

# 8. 覆写 Sprite Set

`苏遥[placeholder_char:anxious]: ...` 表示 sprite_set 换为 `placeholder_char`。
也可与位置组合：`苏遥[placeholder_char:anxious|right]: ...`。

**限制**：覆写只能使用该角色 `allowed_sprite_sets`（缺省仅自身 `sprite_set`）内的素材组。
Compiler 对越界的 `[spriteSet:variant]` 丢弃整条 character cue 并记录
`FORBIDDEN_SPRITE_SET` 诊断（降级为保持现状）。换装/伪装需作者在角色绑定中显式列出；
Loader 启动校验保证列表引用存在且包含角色自身 sprite_set。

---

# 9. 角色位置

第一版只允许离散槽位：`far_left` `left` `center` `right` `far_right`。
`苏遥[|right]: 站远一点。` 只设置 position。
不允许模型输出坐标/缩放/z-index，这些由 Renderer 负责。

---

# 10. 显示名称与 characterId

`苏遥(神秘女子): 不要靠近。` → 玩家 UI 显示「神秘女子」，但角色真实身份始终是 `suyao`：
StoryState、TTS、资源绑定全部使用 `suyao`。

因此 RuntimeDialogue 必须携带稳定身份 `characterId`（`speaker` 仅为该句玩家可见名称）：

```ts
{ type: "dialogue", characterId: "suyao", speaker: "神秘女子", text: "...", line_id: "..." }
```

TTS 按 `characterId` 查音色，不按 `speaker`——否则身份隐藏时找不到苏遥音色。
旧事件只有 speaker 时回退旧显示名映射。

---

# 11. PresentationState 的 KEEP / SET / RESET

总规则：**省略 = KEEP，填写 = SET，空容器 = RESET**。

```ts
type PatchValue<T> = { op: "keep" } | { op: "set"; value: T } | { op: "reset" };
```

---

# 12. `[]` 视觉复位

`苏遥[]: 算了。` → sprite_set / variant / position 恢复角色 YAML 默认值，visible → true；
显示名称继续继承。

---

# 13. `()` 名称复位

`苏遥(): ……我的名字是苏遥。` → 只把 display_name 恢复默认；sprite / position 不变。

---

# 14. `[]()` 完整复位

恢复全部 Presentation 默认值（sprite_set / variant / position / display_name / visible）。

---

# 15. 禁止模糊空格式

只定义 `[]` 为 Visual Reset；`[|]` `[:]` `[:|]` 无意义，Parser 直接拒绝。

---

# 16. 状态继承示例

```text
苏遥[anxious|right](神秘女子): 你不该来这里。   → anxious / right / 神秘女子
苏遥: 现在离开还来得及。                       → anxious / right / 神秘女子
苏遥[angry]: 我说，出去。                      → angry   / right / 神秘女子
苏遥(): ……我的名字是苏遥。                     → angry   / right / 苏遥
苏遥[]: 抱歉，刚才有些失态。                    → normal  / left  / 苏遥
```

---

# 17. Standalone `ch`

没有台词但需要操作立绘时，使用稳定内部 character ID（台词头才能做 script_name →
characterId 映射，`ch` 没有台词头）：

```text
ch <character_id>:<variant> [position]
ch <character_id> hide|show|exit
```

`hide` 仅隐藏（保留状态）；`exit` 彻底离开舞台（状态移除，下次台词重新按默认登台）。

---

# 18. 隐藏与重新显示

`ch suyao hide` 只置 visible=false，保留 sprite_set / variant / position / display_name；
`ch suyao show` 以隐藏前状态恢复。

---

# 19. Hidden 角色说话 / 站位互斥 / 退场

**Hidden 角色说话不自动显示**：`ch suyao hide` 后 `苏遥: 别回头。` 保持隐藏，
天然支持画外音、电话、隔墙说话、幕后角色。需要显示时用 `ch suyao show` 或带立绘的台词。

**站位互斥（§19b）**：一个槽位同时只能有一个可见角色。角色以可见状态占到一个已被
占用的位置时，原占位者自动 `visible = false`（保留状态，可被 `show` 或显式换位恢复）。
这是引擎强制的确定性规则——不依赖模型记得 `hide`。

**退场（§19c）**：`ch <id> exit` 从 VisualState 彻底移除该角色（渲染器删除其 DOM 节点）。
`hide` 保留状态，`exit` 撤离舞台。

---

# 20. 背景

`bg basement` 使用逻辑资源 ID。背景持续存在直到新的 `bg`；模型不得重复输出当前背景。

---

# 21. BGM

`bgm mystery` 持续到下一个 `bgm` 或 `bgm stop`。

---

# 22. 音效

`se terminal_beep` 属于一次性 StageCue。

---

# 23. `beat`

没有正文的独立视觉节点：

```text
bg black
bgm stop
beat
```

`beat` 不要求模型提供 duration_ms，转场时间由 Renderer 决定。

---

# 24. 表单 DSL

统一使用 `?`（开始）/ `+`（选项）/ `=`（输入框）/ `/?`（结束）。
Runtime 根据内容自动推导 interaction mode，模型不输出 `mode`。

---

# 25. 纯选项（choice）

```text
? 怎么回应？
+ 追问她所谓“启动之后”究竟发生过什么
+ 暂时停手，要求她先解释自己知道多少
+ 无视警告，继续操作终端
/?
```

有 `+` 无 `=` → `mode = choice`。

---

# 26. 纯输入（input）

```text
? 你准备对她说什么？
= 输入你的回答……
/?
```

无 `+` 有 `=` → `mode = input`。

---

# 27. 混合模式（hybrid）

```text
? 怎么回应？
+ 追问她所谓“启动之后”究竟发生过什么
+ 暂时停手，要求她先解释自己知道多少
= 或输入自己的回答……
/?
```

`+` 与 `=` 同时存在 → `mode = hybrid`。

---

# 28. 表单推导规则

```text
+ >= 1 且 = 0  → choice
+ = 0  且 = 1  → input
+ >= 1 且 = 1  → hybrid
```

无效：空表单（`?` 直接 `/?`）；多个输入框（第一版一个 Interaction 只允许一个输入框）。

---

# 29. InteractionPolicy 保留

Schema/Parser 负责从 DSL 推导结构，InteractionPolicy 继续负责业务规则：
allowed_modes、options min/max、option ID unique（invariant）、input max length、
连续 pure input 数量、字段一致性。语法上能解析成 choice 的表单，若配置
`min_count: 2` 仍应被 policy 拒绝。

---

# 30. Runtime 自动生成 interaction ID

DSL 表单不含 interaction_id / option_id。Runtime 编译时生成
`interaction_<turn>` / `<id>_opt_<i>`。模型没有理由参与机器 ID 管理。

---

# 31. InputSpec 简化

模型只控制 placeholder（`= 输入自己的回答……`）；`kind` / `max_length` 由配置补全。
这些字段属于 UI / Runtime policy，不属于剧情创作。

---

# 32. Input Bridge 与新 DSL 的冲突

当前 input/hybrid 的过渡旁白不再是 Interaction 的内嵌字段，而是：
**Interaction 解析完成后自动启动的 speculative generation task**（独立预取）。

---

# 33. 新 Input Bridge 流程

Interaction 解析完成（读到 `/?`）即并发启动：

```text
Interaction discovered
       ├── option A prefetch
       ├── option B prefetch
       └── input bridge prefetch
```

玩家阅读/思考/输入的时间通常足以隐藏 bridge 请求延迟。

---

# 34. Bridge 规则

Bridge 限制为 1–2 条 narration，不得：回答玩家尚未提交的内容、引入新事实、
产生 Interaction、修改 StoryState、改变背景/BGM/立绘、产生音效。
Bridge 的目的只是：玩家确认输入后、NPC 正式回应到达前，提供一个安全、
场景相关的短过渡。

---

# 35. Hybrid 分支处理

- 玩家选择 preset option → 提交对应 BranchCandidate，取消/丢弃 input bridge。
- 玩家提交自由输入 → 丢弃 preset option candidates，提交玩家台词，播放已完成 bridge，消费正在流式生成的 NPC response。
- 玩家 Preview Cancel → 保留当前 interaction，重新开放选项 + 输入，重新建立被取消的 candidate。

不得重新引入「取消输入后 option 失效」的旧 bug（§106 硬回归）。

---

# 36. EventGroup

`bg` / `bgm` / 台词头不是三个玩家 Advance，而是一个原子演出组：

```ts
interface EventGroup {
  prelude: StageCue[];
  main: MainEvent;
}
```

---

# 37. Pending Cue

Parser 持有 `pendingCues: StageCue[]`。解析 `bg`/`bgm`/`ch`/`se` 时只写入 pending，
直到遇到 dialogue / narration / interaction 完成 / beat 才形成 EventGroup。

---

# 38. 为什么必须 Pending

若流在 `bg X` / `bgm Y` 之后被截断，画面不能立即切换——模型可能本来准备输出
下一句台词。正确状态：已提交的台词保留；bg/bgm 留在 pending 不展示；
恢复后续写提交完整 EventGroup。

---

# 39. 表单同样是 EventGroup main

只有读到 `/?` 后才能提交 `prelude + interaction` 组。

---

# 40. Parser 分层

不写数百行正则大 Parser，拆四层：

```text
StreamLineDecoder → DslLineParser → EventGroupBuilder → SegmentValidator
```

---

# 41. StreamLineDecoder

网络 chunk → 拼接字符 → 遇 newline 输出完整行。

---

# 42. DslLineParser

只解析单行，输出 `DslLine` 判别联合（dialogue / narration / bg / bgm / ch / se /
表单四行 / beat / 段结束）。不在此层处理 Runtime ID。

---

# 43. EventGroupBuilder

维护 `pendingCues` 与 `openInteraction`。StageCue 入 pending；dialogue / narration /
beat 到来时 pending + main 成组发布；`?` 开表单、`+` 追加选项、`=` 设输入、
`/?` 完成表单并随 pending 成组发布。

---

# 44. SegmentValidator

维护 generation nonce、是否已见 `@end`、last main event、openInteraction、pending tail。
只有合法的 `@end <nonce> <reason>` 才认定一次请求完整结束。

---

# 45. Generation Sentinel

每次请求由 Runtime 创建 nonce，模型最后必须输出：

```text
@end a81f buffer        或  @end a81f interaction  或  @end a81f ending
```

---

# 46. `buffer`

当前只完成一段正常未来剧情，故事没结束，也没有等待玩家的 interaction。
这是低水位续写的基础。

---

# 47. `interaction`

要求最后完整 main 是 Interaction。

---

# 48. `ending`

同时承担 generation complete + story end。Runtime 自动创建内部 EndEvent 和 ending ID，
不再让模型生成 end 事件。

---

# 49. 截断判断

没有看到正确的 `@end <nonce>` = `INCOMPLETE_SEGMENT`，即使最后一行语法完整。
（旧 JSONL 只能靠尾部非法 + terminal contract 间接判断，新协议显式规定。）

---

# 50. 截断时已完成 Group 不回滚

已发布的 EventGroup 前缀保留，最后残片丢弃，segment 标记 incomplete。
流已发布的前缀不因尾部损坏而整体重试。

---

# 51. Recovery

已发布 EventGroup 后出错时，禁止从当前请求开头重新生成（会重复台词 / line_id /
TTS / 视觉变化）。应创建 recovery generation，携带：

```text
LAST_COMMITTED_GROUP / PENDING_CUES / CURRENT-TAIL VISUAL STATE /
DISCARDED_PARTIAL_TAIL / NEW NONCE
```

让模型从已确认边界继续。

---

# 52. VisualState

```ts
interface VisualState {
  background?: AssetId;
  bgm?: AssetId;
  characters: Record<CharacterId, CharacterPresentationState>;
}

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

纯函数 `reduceVisualState(state, cues): VisualState`：不访问 DOM / 文件 / 声音，
只计算状态。因此可用于正式路径、候选分支、测试、恢复、UI projection、提示词构建。

---

# 54. 实际视觉状态与未来视觉状态必须分开

Runtime 至少维护：

- `renderedVisualState`：玩家目前实际看到的状态。
- `tailVisualState`：当前正式缓冲尾部执行完成后的预测状态。
- `branchTailVisualState`：候选分支尾部状态。

玩家在看第 5 句时，第 8 句可能已预生成 `bg rooftop`；真正 UI 仍是 basement，
但生成第 9 句时模型应知道 tail 是 rooftop。

---

# 55. 为什么不能只有一个 VisualState

生成时直接改实际状态 → 背景提前切换；直到播放才改 → 下一轮 LLM 不知道预生成
内容最终留下什么状态。所以：生成 → reducer 计算 tail；播放 → reducer 更新 rendered。
二者生命周期不同。

---

# 56. Branch Visual Isolation

候选分支 A `[happy]` 与 B `[angry]` 不能互相污染，更不能污染正式画面。
BranchCandidate 携带 `groups` + `baseVisualState` + `tailVisualState`；
玩家选 A 后才提交 A 的 groups，B 直接丢弃。

---

# 57. 资源 YAML

独立资源文件 `assets/resources.yaml`。`config.yaml` 负责程序行为/阈值/provider/并发/policy；
`resources.yaml` 负责有哪些资源、资源文件在哪里、资源在剧情中代表什么、
模型什么时候应该用、角色与素材如何绑定。

---

# 58. 推荐资源结构

```yaml
guidance: |
  素材覆盖范围、风格基调、使用纪律（如“表情资源有限，anxious 仅用于……”）。
backgrounds:
  basement:
    src: backgrounds/basement.webp
    description: 昏暗地下设备间。主要用于旧终端相关剧情。
bgm:
  mystery:
    src: audio/bgm/mystery.ogg
    description: 轻度悬疑和未知感。
sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: 旧终端的短促电子提示音。
sprite_sets:
  suyao:
    description: 苏遥正式立绘。
    variants:
      normal:  { src: characters/suyao/normal.webp,  description: 默认冷静状态 }
      anxious: { src: characters/suyao/anxious.webp, description: 明显紧张/不安/隐瞒时使用 }
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

不把 `src: ...` 路径每轮发给模型。加载 YAML 后建两个投影：
`RuntimeAssetCatalog`（src/URL/Blob key/cache key）与 `ModelAssetCatalog`
（logical ID + description + guidance + 角色绑定 + variant）。

---

# 60. AssetResolver

```ts
interface AssetResolver {
  resolveBackground(id: string): AssetRef;
  resolveSprite(spriteSet: string, variant: string): AssetRef;
  resolveBgm(id: string): AssetRef;
  resolveSoundEffect(id: string): AssetRef;
}
```

第一版资源来源为静态文件；未来可接 IndexedDB / 生成资源 / 远端 URL / Blob，
DSL 不需要改变。

---

# 61. portrait 淘汰

旧 `portrait` schema（每句重复、只能挂当前 dialogue）已淘汰为 presentation patch +
VisualState。迁移期新协议不再产生 portrait JSON；旧 Session 的 portrait 字段仅作
legacy 容忍读取。

---

# 62. Runtime Dialogue 新结构

```ts
interface RuntimeDialogueEvent {
  type: "dialogue";
  characterId: CharacterId;   // 角色身份：TTS / StoryState / 资源
  speaker: string;            // 该句玩家实际看到的名称
  text: string;
  line_id: string;
  stage?: StageCue[];
}
```

---

# 63. EventGroup 是否需要永久存在

采用展平方案：Parser 和 Playback 使用 EventGroup，持久化把 group 展平到事件的
`stage` 字段——不要求所有接口都认识 EventGroup。当前实现即按此落地
（PlaybackBuffer 仍保存展平事件，见 status.md）。

---

# 64. Web UI 权威视觉状态

GameViewModel 保存 `visualState: VisualStateWire`（加入 UiProjection）。
重连时服务器必须恢复完整视觉状态，不能只靠「最近几条 stage cue」重放。

---

# 65. RuntimeOutput

保留现有 interaction 生命周期输出；`playback_ready` / `interaction_opened` 携带
`presentation` delta，纯 `beat` 增加 `stage_beat_ready`。
不重做 input_preview_opened / canceled / input_committed / interaction_resolved。

---

# 66. Web Renderer

`web/src/stage/`（stage-renderer / background-layer / character-layer / bgm-controller /
stage-types）：VisualState → DOM。背景 crossfade、人物 fade、variant crossfade、
位置 translate、hide fade out——具体动画不让 LLM 决定。

---

# 67. TTS 兼容

音频流水线按 `characterId` → character registry → voice profile 查音色；
旧事件只有 speaker 时 fallback 旧映射。`苏遥(神秘女子)` 不得被当成新 speaker 导致静音。

---

# 68. 主模型 Prompt 结构

`prompts/dsl-protocol.txt` 为稳定 System Prompt（完整 DSL 规范）；
`prompts/instructions.yaml` 只保存任务模板（opening / active_refill / branch_prefetch /
input_bridge / input_response / recovery / ending）。

---

# 69. Context Builder

历史不再 `JSON.stringify` 逐行发送。新增 `serializeStoryContext` /
`serializeVisualContext` / `serializeResourceContext`，历史变成紧凑文本：

```text
[玩家] 选择：继续追问
苏遥: 你最好别再问。
终端重新亮起。
```

---

# 70. 生成 Prompt 动态上下文

每次生成至少提供：

```text
TASK_TYPE / GENERATION_NONCE / TARGET_PLAYABLE_EVENTS
STORY_CONTEXT / CHARACTER_CONTEXT / RECENT_EVENTS
TAIL_VISUAL_STATE
MODEL_ASSET_CATALOG
PLAYER_ACTION / AUTHOR_RULES
```

续写时提供 `TAIL_VISUAL_STATE`（而非仅 renderedVisualState），因为模型在续写缓冲尾部。

---

# 71. 模型资源选择原则

```text
已有状态不变化 → 不重复输出
存在理想素材   → 使用 logical asset ID
没有理想素材   → 保持当前状态或使用最接近的现有资源
绝不猜测不存在的 asset ID
```

---

# 72. 模型输出终止

允许「几句正常剧情 + `@end nonce buffer`」结束一段生成——这是低水位动态续写的
必要条件，不再强制每次生成跑到 interaction/end。

---

# 73. 低水位调度（已实现 2026-08-11）

`reconcileTextBuffer` 在任务收束 / 玩家推进 / 缓冲分支处评估 §75 不变量；
`start_threshold_lines` 作首句门槛，消除段间 TTFT 空窗。

---

# 74. 文本缓冲配置

```yaml
text_buffer:
  start_threshold_lines: 2   # 播放达到两句即可开始
  target_lines: 6            # 正常保持六句未来内容
  refill_threshold_lines: 3  # 只剩三句时启动续写
```

---

# 75. 低水位规则（不变量）

```text
未来可播放文本 <= refill threshold
且 没有未消费 interaction
且 没有 active generation
→ 必须启动 active_refill
```

---

# 76. `buffer` 段边界的意义

生成请求不再绑定「完整场景」：generation A 出 4 句 `@end buffer`，玩家阅读使
buffer 降低后 generation B 续 5 句，最终某代以 interaction 收尾。多代片段拼接
成连续剧情。

---

# 77. 分支预取继续保留

固定选项解析完成后 Runtime 分配 option IDs 并启动 Branch A/B/C 预取。
分支预取同样使用 DSL，但限制只允许 dialogue / narration / bg / bgm / ch / se / beat，
不得产生表单，最终以 `@end nonce buffer` 结束。

---

# 78. 分支预取允许视觉演出

分支短片段可拥有表情变化、角色移动、必要背景变化、音效、BGM——它们可能是玩家
选择的直接结果。但全部进入 BranchCandidate EventGroups，未选分支绝不实际执行。

---

# 79. Input Response

玩家确认后：玩家 dialogue → bridge → live input response。
InputResponse DSL 允许 dialogue / narration / ch / se，必要时 bg/bgm；
第一阶段不得生成 interaction，直到正式 active refill 接管。

---

# 80. StoryStateReconciler（已实现 2026-08-11）

确定性纯函数（`src/story/reconcile.ts`），消费已提交事件投影
location / characters / recent_summary。主 DSL 的 `state_patch` 应用路径已删除
（协议字段保留为 legacy）。状态整理不在玩家等待下一句的关键路径上。

---

# 81. 状态整理时机

正式路径：EventGroups 进入正式历史 → 异步 reconcile → StoryState patch。
候选分支：第一版只保存 events，玩家选中、事件成为正式历史后再 reconcile
（比每个候选携带 provisional patch 更轻）。

---

# 82. Runtime 内部 ID

event_id / group_id / line_id / interaction_id / option_id / branch_id /
generation_id / ending_id 全部由 Runtime 生成，模型一个都不生成。

---

# 83. Model Protocol 与 Session Protocol 分离

Gal DSL 是模型传输协议；`sessions/<sessionId>/events.jsonl` 是程序持久化协议。
Session JSONL 继续使用（可追加 / 可恢复 / 可调试 / 结构稳定），需要变的只是
存储 schema 支持 characterId、stage/presentation、interaction 新 Runtime ID。

---

# 86. 模块地图（当前实际）

```text
src/
├─ core/
│  ├─ protocol/gal-dsl/     # stream-decoder / line-parser / interaction-builder /
│  │                        # group-builder / segment-validator / compiler / text-pipeline
│  ├─ presentation/         # types / defaults / reducer（VisualState 纯计算）
│  ├─ assets/               # catalog（Runtime/Model 双投影类型）
│  ├─ narrative/            # memory-types / memory-operation / narrative-brief / director-plan
│  ├─ interaction/          # input-bridge 缓冲 / input-session
│  ├─ runtime/              # RuntimeCommand / RuntimeOutput / async-event-queue
│  └─ ports/                # StoryGenerator / NarrativeDirector / NarrativeMemoryStore /
│                           # SessionStore / TtsProvider / MediaPlanner / Clock / IdGenerator …
├─ story/                   # context-builder / interaction-policy / reconcile / state / types
├─ application/
│  ├─ assets/               # asset-catalog-loader / asset-manifest
│  ├─ audio/                # audio-intent-planner / performance-compiler / tts-task-service /
│  │                        # audio-catalog-service / audio-descriptor-factory / cache-key
│  ├─ narrative/            # narrative-director-service / memory-consolidator / memory-validator /
│  │                        # plot-planner / setup-scheduler / episode-retriever / context-builder
│  └─ ui/                   # ui-projection-store
├─ adapters/
│  ├─ llm/                  # openai-compatible-generator（DSL 流式）/
│  │                        # narrative-consolidator-adapter / plot-planner-adapter
│  ├─ tts/                  # dashscope-cosyvoice-provider / mock
│  ├─ storage/              # node-jsonl-session-store / json-narrative-memory-store
│  └─ static/               # story-plan-loader
├─ runtime/                 # playback-buffer（展平事件）
└─ apps/cli/                # terminal-ui / cli-controller

web/src/
├─ stage/                   # stage-renderer / browser-asset-resolver / asset-manifest-client /
│                           # bgm-controller / sound-effect-controller / stage-types
├─ audio/                   # audio-coordinator / audio-timeline / pcm-decoder / pcm-worklet
├─ storage/                 # audio-db（IndexedDB）/ audio-cache-reader|writer|cleaner
├─ runtime/                 # runtime-client / game-view-model（纯 ServerMessage projection）
└─ ui/                      # interaction-panel / dialogue-box / stage 布局等
```

依赖方向：`apps → adapters → application → core`；core 不导入 Node / OpenAI / CLI
（`core/architecture.test.ts` 静态扫描保证）。

---

# 87. 配置（当前生效值见 config.yaml）

```yaml
generation:
  temperature: 0.9
  max_tokens: 2200        # 1400 常在长段结尾截断（无 @end）；2200 给足预算
  repair_attempts: 2

text_buffer:               # 见 §74
assets:
  catalog: assets/resources.yaml

interaction:
  allowed_modes: [choice, hybrid, input]
  options: { min_count: 2, max_count: 5 }
  input: { max_length: 500, max_consecutive_pure_input: 1 }

narrative:                 # 长线剧情系统（见 narrative-director spec）
  mode: longform | event   # event 时 director 完全旁路
  threads / setups / consolidation / brief / plan / story_plan_path
```

---

# 98. 边界用例规范

以下用例为协议边界行为的规范定义，均已固化为 `src/core/protocol/gal-dsl/` 与
`src/game-dsl.test.ts` 的测试套件。

**Chunk 边界**：台词头被网络 chunk 切断（`苏遥[anx` + `ious|left]: 等等。`）
必须只产生一条完整 dialogue，半行不得进入 parser。

**§99 表单推导**：choice / input / hybrid 按 §28 推导，编译到现有
RuntimeInteractionEvent，Web InteractionPanel 无感。

**§100 非法表单**：空表单、双输入框、表单外 `+`、无 open form 的 `/?` 一律拒绝
（`FORM_END_WITHOUT_OPEN` 等协议错误）。

**§101 Pending Cue 截断**：`台词 → bg → bgm → EOF` 时，台词已提交，bg/bgm 留在
pending 不展示，实际 VisualState 不变。

**§102 Interaction 截断**：未读到 `/?` 就 EOF，整个 Interaction 不得提交。

**§103 Sentinel**：nonce 不匹配必须拒绝；无 sentinel = INCOMPLETE；sentinel 之后
再出现内容 = protocol error。

**§104 Visual Branch Isolation**：选择前 rendered 保持 base 状态；选择 A 后 A 的
tail 生效、B 丢弃，不得出现 B 的视觉污染。

**§105 TTS Identity**：`苏遥(神秘女子): 别动。` → UI speaker = 神秘女子，
TTS character = suyao（音色按 characterId 绑定），不得因 displayName override 静音。

---

# 106. Hybrid 硬回归不变量

打开 hybrid → 输入 → preview → cancel → hybrid 重新打开 → option 仍可点击 →
branch 重新 prefetch。这是协议重构的硬回归测试，任何迁移不得破坏。

---

# 107. Reconnect 不变量

WebSocket 断开重连后，客户端收到 UiProjection 必须直接恢复完整画面
（背景 / BGM / 每个角色的可见性 / variant / position / displayName），
不能要求从第一条剧情重新播放视觉 cue。

---

# 110. 端到端验收场景

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

Runtime 应完成：解析背景 → 旁白 → suyao 初始化 normal/left → UI 名称显示
「神秘女子」→ 下一句只切 anxious → 构建 hybrid → Runtime 分配 ID → option
branches 预取 → bridge 预取 → Web 表单同时显示选项 + 输入框。选 option：提交
candidate、丢 bridge、提交 branch groups。自由输入：preview → confirm → 玩家台词
→ bridge → 流式 NPC 回应。cancel：重新显示原 hybrid，options + input 都恢复。

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
                                 │  Gal DSL
                                 ▼
                      ┌──────────────────────┐
                      │ Streaming DSL Parser │
                      └──────────┬───────────┘
                           EventGroups
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       Visual Reducer      PlaybackBuffer     BranchManager
              │                  │             (candidates)
              ▼                  ├── Text UI ── TTS
         UiProjection
              │
              ▼
        Stage Renderer

Committed Runtime Events → StoryState Reconciler → StoryState
Committed Runtime Events → NarrativeDirector（记忆过去 + 规划未来）→ 导演便签/计划
```

---

# 112. 最核心的协议边界

```text
LLM 负责：
  故事里发生什么 / 哪个已有背景适合 / 角色此刻该用哪个已有 variant /
  什么时候打开什么形式的玩家表单

DSL Parser 负责：
  这段文本究竟表示什么 / 结构是否完整 / EventGroup 在哪里结束 / 生成是否截断

Runtime 负责：
  ID / 状态继承 / Reset / 分支 / 缓冲 / 交互生命周期 / StoryState / 长线记忆

AssetManager 负责：
  logical asset ID 最终对应什么资源

Renderer 负责：
  背景具体怎么淡入 / 立绘具体坐标 / 动画速度 / 层级 / 屏幕适配
```

模型不应该变成一个低级 UI 控制器。

---

# 113. 结语

重构的首要目标不是「造一门完整 GalGame 编程语言」，而是建立一层极小的
**LLM → Gal 演出意图协议**。只要这层稳定，之后增加 CG、动态生成素材、Live2D
或 IndexedDB AssetStore，都不需要再次修改剧情模型的基本输出方式。
