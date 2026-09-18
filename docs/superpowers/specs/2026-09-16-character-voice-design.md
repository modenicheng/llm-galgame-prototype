# 角色音频特征设计（导演/编剧产出）——接口与实现方案

> 日期：2026-09-16。状态：**设计稿，待实施**。
> 关联：`docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md`（三角色模型）、
> `docs/llm-outputs-refactor.md` §14（性能编译器）、§67（TTS 查音色）、§7.6（provider 装配）。

## 1. 问题

角色音频特征（声学画像、表达调色板、表演指导）目前只有一条来源：作者手写的
`voices.yaml` + `config.yaml characters` 静态映射。这与 v2 三角色架构脱节：

1. **动态世界没有画像**：M3.3 WorldGenerator 生成角色的流程
   （WorldDraft → canon 脚手架 → per-game prompts）不含任何音频维度，
   `AudioDescriptorFactory.resolveCharacter` 按 `config.yaml characters`
   查不到动态角色 → 生成的角色**全程无声**。
2. **导演无音频抓手**：导演已产出逐场景演出指令（SceneDirective：
   场景目标/防守节拍/收束压力/相位门），但「这场戏谁该压低声音、谁在嘶哑」
   无处安放；声音演出完全依赖演员逐行标签的自觉。
3. **编剧的设计无处落**：角色卡的声学想象（年龄感/质感/口音）只存在于
   description 的散文里，到不了合成管线。

## 2. 三层模型与职责归属

音频特征按生命周期拆三层，各归其主：

| 层 | 内容 | 设计者 | 生命周期 | 真源 |
|---|---|---|---|---|
| **身份** | 嗓子是谁的（克隆注册表键 / voice-id + model） | 作者/部署侧 | 部署期 | `voices.yaml` providers + （V3）per-game voice-bindings |
| **画像** | 声学画像 + 表达调色板 + 表演先验 | **编剧**（authoring） | 世界创建期，随世界持久化 | （新）`games/<id>/world/voice-design.json`，author voices.yaml 为预置世界的权威 |
| **指导** | 此刻怎么演（delivery/pace/volume/自由提示） | **导演**（runtime） | runtime 内逐场景，不入图契约 | SceneDirective 扩展段（runtime 内存，跨 restart 延续） |

演员层**不变**：DSL 协议冻结不动；台词头 `[anxious]`（§14.3）仍是逐行
表演意图的唯一模型侧通道。

## 3. 数据契约

### 3.1 编剧层：角色音频画像

```ts
// src/application/outline/outline-writer.ts —— WorldDraft.characters 元素扩展
export interface DraftCharacter {
  id: string;
  name: string;
  description: string;
  spriteBinding?: string;
  /** 编剧设计的音频画像（新）。缺省 = 无设计，回落既有链路。 */
  voice?: CharacterVoiceDesign;
}

/** 角色音频画像——描述性词汇，不涉供应商参数。 */
export interface CharacterVoiceDesign {
  /** 声学画像：年龄感/质感/音区/口音，≤120 字。free 档 instruction 的
   *  画像锚（对应 author 侧 base_description 的角色）；V3 兼作声音设计
   *  API 的 description 入参。 */
  timbre: string;
  /** 表达调色板：该角色"怎么说话"的允许集合（语义同 allowedDelivery）。 */
  delivery: string[];
  /** 明确禁止的表达（语义同 forbiddenDelivery）。 */
  avoid?: string[];
  /** 表演先验：编译器基线（词汇表与 LinePerformance 同枚举）。 */
  baseline?: {
    pace?: LinePerformance["pace"];
    energy?: LinePerformance["energy"];
    volume?: LinePerformance["volume"];
  };
}
```

落盘与渲染（WorldGenerator.generate 增两步）：

- `games/<id>/world/voice-design.json`：`{ version: 1, characters: Record<characterId, CharacterVoiceDesign> }`，
  zod strict + 原子写（沿 canon.json 脚手架先例：形状唯一真源、拒绝覆写）。
- `characters.txt` 角色卡追加一行 `嗓音：<timbre>`——画像常驻 system prompt，
  演员可见是**有意为之**（写出贴合嗓音的台词），无泄密面（设计描述非剧透）。

### 3.2 导演层：逐场景声音指导

```ts
// src/application/director/director-service.ts —— SceneDirective 扩展
export interface VoiceDirectionTarget {
  /** 场景内表演基调标签。V1 限 LinePerformance["delivery"] 八枚举
   *  （类型安全 + 复用 DELIVERY_LABELS 词典）；越界标签编译器静默丢弃。 */
  delivery?: LinePerformance["delivery"][number];
  /** 显式表演覆盖（导演 > 演员逐行意图 > 画像基线）。 */
  pace?: LinePerformance["pace"];
  energy?: LinePerformance["energy"];
  volume?: LinePerformance["volume"];
  /** 自由提示（≤40 字），并入 free instruction 尾部，预算内自然截断。 */
  note?: string;
}

export interface SceneDirective {
  // …既有字段不动…
  /** 角色音频指导（说话人 id → 指导）。缺省 = 无。 */
  voice?: Record<string, VoiceDirectionTarget>;
}
```

导演合同变更：`DIRECTIVE_SYSTEM_PROMPT` 输出 JSON 增 `voice` 段说明
（"为需要声音变化的角色给 delivery/pace/volume/note，只给与场景状态
相关的指导"）；`refreshDirective` 的 user 输入增「在场角色音频调色板」段
（角色 id + delivery 调色板 + avoid），V1 取 author semantic、V2 起
voice-design 优先。导演工具零新增（调色板随输入直接给，无需新工具）。

### 3.3 编译器：合并优先级

`PerformanceCompileInput` 增一个字段，合并在 compiler 内部（单一职责、
可测、进 cacheKey 天然正确）：

```ts
export interface PerformanceCompileInput {
  // …既有字段不动…
  /** 导演场景指导（当前场景对该角色的 target）。 */
  direction?: VoiceDirectionTarget;
}
```

合并规则（全部确定性，保 cacheKey 安全）：

```
rate   = mapPace(direction.pace   ?? perf.pace   ?? baseline.pace)   ?? 1.0
pitch  = mapEnergy(direction.energy ?? perf.energy ?? baseline.energy) ?? 1.0
volume = mapVol(direction.volume ?? perf.volume ?? baseline.volume) ?? 50
delivery 过滤：候选 = direction.delivery 前置 + perf.delivery，
               调色板 = allowed(author.semantic ∪ design.delivery)，
               forbidden = author.forbidden ∪ design.avoid（既有 §14.1 过滤）
instruction（free 档）= 画像锚 + 语气段 + intensity + 导演 note（预算内截断不变）
```

`baseline` 与 `design.timbre` 经 factory 进入：`AudioDescriptorFactoryOptions`
增可选 `voiceDesigns?: Record<characterId, CharacterVoiceDesign>`，
`resolveBinding/compile` 处按 `author profile → voiceDesign 合成 profile → 无`
降序取用（§4 接线）。

## 4. 接线（wiring）

### 4.1 动态角色注入（V2 核心）

`buildAudioStack` 时 audio 栈先于会话构建，而 voice-design 在世界创建时
落盘——静态可读。bootstrap 在 `buildGameFor` 前读取
`games/<id>/world/voice-design.json`（世界未创建则空表）：

- factory 的 `characters` 选项 = `config.yaml characters`（author 世界）
  ⊕ design 合成条目（动态角色：`{ name, voice_profile: "design:<id>" }`）；
- factory 的 `voices` 选项包一层 `VoiceDesignAugmentedVoices` 视图对象
  （实现 `VoicesConfig` 读接口）：`profiles` = author profiles ⊕ 按
  design 合成的动态 profile（`semantic.base_description = timbre`、
  `providers.dashscope` 取全局 `model_profile` 折叠 + `instruction_mode: "free"`）。
  **只读视图，不落盘不回写**——voices.yaml 保持 author 资产纪律。

local provider 侧：动态角色 V2 无注册表键，暂不配音（factory 返回
undefined 的现状路径），V3 解决。

### 4.2 导演指导进编译器（V1 核心）

导演与 audio 栈均按 runtime 生命周期构建（DirectorService 的 directive
缓存跨 restart 随世界延续——与 formModes 既有语义一致），换绑只发生在
桥上：

```ts
// src/application/audio/voice-direction-hub.ts（新，~20 行）
export class VoiceDirectionHub {
  private source: ((characterId: string) => VoiceDirectionTarget | undefined) | undefined;
  setSource(source: ... | undefined): void { this.source = source; }
  for(characterId: string): VoiceDirectionTarget | undefined {
    return this.source?.(characterId);
  }
}
```

- bootstrap 创建 hub → `buildAudioStack` 把 `hub.for` 作为 factory 的
  `voiceDirectionFor` 选项 → factory 在 `build()` 里对 dialogue 事件取
  `direction = voiceDirectionFor(speaker)` 传入 compiler；
- `buildGameFor` 建完 director 后 `hub.setSource((speaker) =>
  director.getDirective(currentSceneId)?.voice?.[speaker])`；
  restart 重建会话时随 director 重建自然换绑；
- 场景号用 game 的「当前场景」（reconcile 已跟踪）。音频预取前瞻 1–4 行，
  用最近场景近似是可接受的工程折中（跨场景边界最多误指导一行；
  偏差记附录 B，MediaPlannerPort 带场景号的重合同改造不做）。

## 5. 分期落地

| 期 | 内容 | 改动面 | 效果 |
|---|---|---|---|
| **V1 导演层** | SceneDirective.voice + 导演 prompt/输入调色板 + compiler `direction` 合并 + VoiceDirectionHub 接线 | director-service / performance-compiler / audio-descriptor-factory / bootstrap / actor-briefing（可选渲染一行）+ 测试 | 预置世界（author profiles）获得逐场景声音演出 |
| **V2 编剧层** | DraftCharacter.voice + voice-design.json 落盘 + characters.txt 嗓音行 + 动态角色注入（§4.1） | outline-writer / world-generator / bootstrap / factory + 测试 | 动态世界角色全链路可配音（dashscope free 档） |
| **V3 身份合成**（默认关） | dashscope qwen3-tts-vd 设计 API / local 参考音中继合成 → per-game `world/voice-bindings.json` → factory 绑定优先级 per-game > author | 新 port + adapters + config 门控 `media.audio.voice_design.enabled` | 生成角色拥有专属音色身份 |

各期独立可交付、独立可回退；V1/V2 无新配置键（纯内部扩展，config 无死键纪律）。

## 6. 纪律与风险

- **协议冻结**：DSL 与 §3 图契约零改动；SceneDirective 本就是"会话工作态、
  不入图契约"，voice 段同性质。
- **缓存正确性**：direction/baseline/design 全部流经 `CompiledPerformance`
  进 `cacheKeyFromRecipe`，指导变化自然失效旧音频，无额外失效机制。
- **失败降级**：导演 JSON 缺 voice 段 = 无指导（现状）；compiler 永不抛
  （§14.5 不变）；voice-design.json 损坏 = 大声报错（世界资产损坏语义）。
- **单一真源**：voices.yaml 不被运行时改写；动态画像只存在于世界存储；
  导演指导在 runtime 内存（directive 缓存跨 restart 随世界延续，与 formModes 既有语义一致）。
- **防火墙**：演员可见面 = briefing（画像的嗓音行经 characters.txt 进
  system prompt，属设计描述非剧透）；outline 全量/结局候选不因本次扩展
  进入演员可见面。
- **local 身份缺口**：动态角色的 local 注册表键依赖服务端参考音构建
  （机器本地资产），V2 之内 local 对动态角色保持无声，不伪造回退。

## 7. 验收场景（分期各配）

1. 导演在某场景对某角色发 `voice: { su: { volume: "whisper", note: "夜谈压低声音" } }`
   → 该场景该角色行 volume=20、instruction 含提示；离场后回落。
2. 导演发的 delivery 不在调色板 → 编译器过滤，音频与无指导一致（cacheKey 相同）。
3. WorldGenerator 生成含 `voice.timbre` 的角色 → voice-design.json 落盘、
   characters.txt 含嗓音行、该角色行 dashscope 合成 instruction 以 timbre 为锚。
4. 无 voice 设计的旧世界 → 全链路行为与现状逐字节一致（回归底线）。
