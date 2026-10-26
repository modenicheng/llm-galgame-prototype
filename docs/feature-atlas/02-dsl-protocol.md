# 剧本 DSL 协议域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：11 文件 / 4180 行（生产代码，不含测试）
> 快照：`D:/coding/lgp-main-atlas`（只读）。目录：`src/core/protocol/gal-dsl/`
> 测试：12 文件 / 4413 行（`*.test.ts`，共 255 个 it 块）

## 1. 域职责与边界

**DSL 语法是什么**：模型（LLM）每段输出一个纯文本"剧本"，逐行是受限指令语言——台词/旁白正文、舞台操作（背景/BGM/音效/立绘）、交互表单（`@?`/`@+`/`@=`/`@/?`）、节拍（`@beat`），最后必须以哨兵 `@end <nonce> <reason>` 收束（reason ∈ buffer|interaction|ending；ending 哨兵后允许一行 `@ending <档位> <结尾词>` 结局元数据）。本域把这段文本确定性地转成**结构化事件组**（CompiledEventGroup / CompiledEventGroupV2），运行时据此播放。整个域是纯函数层：无 DOM、无文件、无网络、无运行时 ID（各文件头注释均声明这一点）。

**流水线顺序**（types.ts:5-7 声明的分层）：

```
StreamLineDecoder（网络块 → 完整行）
  → parseDslLine / parseDslV2Line（一行 → DslLine / DslLineV2）
  → DslSegmentParser（V2）（哨兵状态机 + 版本对应组构造器）
      → EventGroupBuilder（V2）（行 → EventGroupDraft（V2）原子组）
  → compileEventGroup（V2）（草稿 → CompiledEventGroup（V2），身份/名牌/素材校验）
  → 修复层（closing-repair 的行级确定性修复；compiler 的 v2 尾部修复编排）
```

**v1/v2 两代解析的关系与取舍**（C4 重构，见 config.ts:170-180、legacy-line-parser.ts:1-11）：

- **v1（legacy，冻结）**：`苏遥[anxious|left](神秘女子): 台词` —— 用冒号/方括号/圆括号在正文行内标记说话人、外观、名牌；指令行 `@ch <id>:<variant>`。冻结于 `legacy-line-parser.ts`，"行为与 C4 之前逐字节一致"，只服务显式 `protocolVersion: 1`（旧存档 legacy reader）；配 `compileEventGroup`（草稿级编译，speaker 名在编译期解析）。
- **v2（现行默认）**：`@say <characterId> <正文>` —— 身份/文本/表演彻底分离，机器身份只用 ASCII 角色 ID，正文 = 固定 token 数之后的剩余原文（冒号、括号在正文里是普通文本）；角色操作改为 `@ch <id> show|set|hide|exit|reset [look=… position=…]`、名牌独立为 `@name <id> set|reset`。v1 台词头的 `[...]`/`(...)` 语义由 v2 的独立指令承担。配 `compileEventGroupV2`（语义编译：registry+cast 校验、名牌快照 displayLabel、双状态域预测）。
- **版本路由不逐行猜**：`parseDslLine` 按请求携带 `protocolVersion` 路由（缺省 1 = legacy reader 口径）；服务端每局固定，zod 缺省 2（config.ts:513-515 `protocol_version: z.union([z.literal(1), z.literal(2)]).default(2)`）。
- **共享件**：`@end`/`@ending` 行形状助手（`matchEndSentinel`/`matchEndingEpilogueLine`，v1 冻结文件内、v2 复用保证语义不漂移）；哨兵/epilogue 状态机在 `DslSegmentParserBase` 基类对两版通用；表单四指令（`@?`/`@+`/`@=`/`@/?`）与 `InteractionBuilder` 两版共用；`@bg/@bgm/@se/@beat` 语义两版相同。
- **产出判别**：流式管线两版产出统一为 `AnyStreamedGroup = EventGroupDraft | CompiledEventGroupV2`（types.ts:262），运行时以 `"labelOps" in group` 判别（game.ts:1344；契约见 types.ts:247-261 注释：EventGroupDraft 永不得新增 `labelOps` 同名字段）。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|
| `compiler.ts` | 1381 | v1 草稿编译 + v2 语义编译（组/段/修复/增量门） | 16 | compiler.test.ts (972)、compiler-v2.test.ts (932) |
| `legacy-line-parser.ts` | 601 | v1 单行解析（冻结）+ v1/v2 共享哨兵形状助手 | 6 | line-parser.test.ts (611) |
| `line-parser.ts` | 426 | 版本路由入口 + v2 单行解析 + 输出卫生谓词；re-export v1 冻结面 | 11（含 5 个 re-export） | line-parser-v2.test.ts (289)、line-parser.test.ts |
| `types.ts` | 538 | 全流水线共享类型/错误码/错误类/修复指令序列化 | 42 | （类型经各测试间接钉住；DslProtocolError/formatDslErrorDetail 在全部测试中出现） |
| `group-builder.ts` | 384 | 行 → 原子事件组（v1 EventGroupBuilder / v2 EventGroupBuilderV2） | 2 | group-builder.test.ts (271)；V2 经 compiler-v2.test.ts 间接覆盖 |
| `capabilities.ts` | 244 | 任务协议能力卡（命令/结束方式单源）+ 修复指令模板 | 10 | capabilities.test.ts (204) |
| `segment-validator.ts` | 216 | 段顶哨兵/epilogue 状态机 + 两版段解析器类 | 2 | segment-validator.test.ts (283)；V2 经 compiler-v2.test.ts 间接覆盖 |
| `closing-repair.ts` | 154 | v1 行级确定性修复（哨兵残缺/槽位写反） | 4 | closing-repair.test.ts (88) |
| `interaction-builder.ts` | 125 | 单个交互表单累积器（模式推导） | 1 | interaction-builder.test.ts (114) |
| `text-pipeline.ts` | 64 | 整段文本批式入口（v1）+ markdown 围栏剥离 | 2 | text-pipeline.test.ts (171) |
| `stream-decoder.ts` | 47 | 网络块 → 完整行缓冲解码器 | 1 | stream-decoder.test.ts (70) |

导出合计 97 个声明（含 re-export 与类型）。测试另含 text-pipeline-v2.test.ts (408)——名义在 text-pipeline 下，实际测 compiler.ts 的 v2 批式/修复入口（见 §6 备注）。

## 3. 函数级明细

### 3.1 `compiler.ts`（1381 行）

编译器两代同文件：L269-L351 为 v1（草稿 → CompiledEventGroup），L353-L1381 为 v2（C4 §4.2/§4.3 语义编译）。文件中部（L357-389）出现第二批 import（characters/types、segment-validator、line-parser、text-pipeline、capabilities、presentation/defaults），是 v2 段的依赖。

#### `compileEventGroup(group: EventGroupDraft, options: CompileEventGroupsOptions): { group: CompiledEventGroup; tailState: VisualState }` — `src/core/protocol/gal-dsl/compiler.ts:L269-L336`
- 用途：编译**单个** v1 草稿组为运行时组，并产出应用 cue 后的新尾态。
- 关键步骤：
  1. prelude 内 `character_patch` 的 character 键经 `resolveCharacterKey`（脚本名或 id → 稳定 id）归一（L276-282）；
  2. 按 `group.main.type` 分派：`dialogue` → `resolveDialogue` 得 characterId/玩家可见 speaker/character_patch cue；`narration`/`interaction`/`beat` 直接构造（L287-316）；
  3. 排序：对白自身 patch 排最前、prelude 其后——显式 `ch` cue 在首触初始化之后生效，隐藏的说话人保持隐藏（§19，L318-321）；
  4. 提供了 `options.catalog` 时经 `filterInvalidCues` 做素材语义校验 + 冗余去重（L322-332）；
  5. `reduce(tailState, filteredCues)` 计算新尾态，返回组+尾态（L333-335）。
- 调用方：域内 `compileEventGroups`（compiler.ts:346）；跨域生产 `src/runtime/dsl-group-compiler.ts:10,51`（Game 的组级物化）；测试 character-contract.test.ts、protocol-card.test.ts、dynamic-character-e2e.test.ts、compiler.test.ts。
- 依赖：`resolveDialogue`、`resolveCharacterKey`、`filterInvalidCues`（本文件内部）；类型来自 types.ts / presentation/types.ts。
- 备注：v1 会话流式路径的唯一生产编译入口（生成器 emit 的 EventGroupDraft 由 Game 侧编译，见 types.ts:247-252 注释）。

#### `compileEventGroups(groups: EventGroupDraft[], options: CompileEventGroupsOptions): CompileEventGroupsResult` — `src/core/protocol/gal-dsl/compiler.ts:L339-L351`
- 用途：整段 v1 草稿组批式编译，链式传递尾态（每组用上一组的 tailState）。
- 关键步骤：循环逐组调 `compileEventGroup`，`tailState = result.tailState` 推进（L345-349）。
- 调用方：scripts/evaluate-character-dsl.ts:71（角色 DSL 离线评估 harness，见 12 域文档）＋测试（compiler.test.ts、character-contract.test.ts、protocol-card.test.ts、dynamic-character-e2e.test.ts）；运行时零调用。
- 依赖：`compileEventGroup`。
- 备注：批式便利入口，生产 v1 流式路径只用单组版本。

#### `CompileEventGroupV2Result`（type） — `src/core/protocol/gal-dsl/compiler.ts:L524-L533`
- 用途：v2 单组编译结果判别联合：`{ ok: true; group; visualState; characterState; assetDiagnostics } | { ok: false; diagnostic: DslDiagnosticV2 }`。

#### `compileEventGroupV2(group: EventGroupDraftV2, options: CompileEventGroupV2Options): CompileEventGroupV2Result` — `src/core/protocol/gal-dsl/compiler.ts:L557-L816`
- 用途：v2 单组语义编译——先完成该组**全部**校验再提交（§4.3 原子性），失败组任何改动不落地、输入状态原样奉还。
- 关键步骤：
  1. 克隆双状态域（`cloneVisualState`/`cloneCharacterState`），初始化 cues/labelOps/软诊断容器与 `currentLine` 诊断行号（L561-568）；
  2. 定义 `applyCue` 闭包：catalog 存在时未知 background/bgm/sound_effect 丢弃并记软诊断；非 `sound_effect` 的 cue 预归约做零变化去重（REDUNDANT_STAGE_CUE）；`sound_effect` 一次性播放永不判冗余（L571-608）；
  3. 逐 prelude op 处理：`label_set`（requireStageTarget(false) + `validateCharacterText` 名牌校验 + `withCharacterLabel`）、`label_reset`（`withoutCharacterLabel` 移除覆盖键）、`ch_show`/`ch_set`（requireStageTarget(true) + `requireLook`；不存在时 `presentationDefaultsFor` 默认初始化，show 可见/set 隐藏；存在时 show 保外观仅改显式参数、set 不隐式显示）、`ch_hide`（不存在 no-op）、`ch_exit`（移除立绘条目，名牌保留）、`ch_reset`（恢复默认 look/position，保留 visibility）、`background`/`bgm`/`sound_effect` 直通 applyCue（L613-733）；
  4. 主事件：`dialogue` 三重校验——registry 内（UNKNOWN_CHARACTER_ID）、非玩家（PLAYER_SPEECH_FORBIDDEN）、在 allowedSpeakerIds 内（CHARACTER_NOT_ALLOWED）——通过后 `resolveCharacterLabel(labels, definition)` 生成发射时刻名牌快照 displayLabel，**无任何舞台副作用**（画外对白合法，§4.2）；narration/interaction/beat 透传（L735-792）；
  5. 成功返回 `{ ok: true, group, visualState, characterState, assetDiagnostics }`；捕获 `DslProtocolError` 经 `diagnosticFromError` 转结构化诊断（含 task/attempt/绝对行号），非协议错误原样重抛（L794-815）。
- 调用方：域内 `compileSegmentV2`（compiler.ts:1017）、`createV2SegmentGate`（compiler.ts:1295）；测试 compiler-v2.test.ts。
- 依赖：`requireStageTarget`、`requireLook`、`applyCue`、`bounded`、`presentationDefaultsFor`、`resolveCharacterLabel`/`validateCharacterText`/`withCharacterLabel`（characters/types.js）、`visualStateEquals`（presentation/equals.js）。
- 备注：§4.2 状态语义表逐行落地在 L391-409 的注释表（@say/@name/@ch 各形态的身份/舞台效果）。

#### `CompileSegmentV2Options`（interface） — `src/core/protocol/gal-dsl/compiler.ts:L823-L840`
- 用途：v2 段级编译入参：text、expectedNonce、task（BaseDslTaskType）、registry、cast、reduce、已提交 visualState/characterState（输入永不修改）、可选 catalog/attempt/lineOffset。

#### `CompileSegmentV2Result`（interface） — `src/core/protocol/gal-dsl/compiler.ts:L842-L858`
- 用途：v2 段级结果：ok、groups（失败 = 已提交前缀）、预测双状态、diagnostics（失败 = 首个）、assetDiagnostics（软）、status（SegmentEndStatus）、failureLine / committedThroughLine（1 基绝对行号；后者 = 修复尾部起点）。

#### `compileSegmentV2(options: CompileSegmentV2Options): CompileSegmentV2Result` — `src/core/protocol/gal-dsl/compiler.ts:L939-L1069`
- 用途：单遍 v2 段级批式编译（流式分行 → v2 解析 → 分组 → 任务能力校验 → 身份/资源语义校验 → 组副本归约 → label 快照 → 原子提交；§4.3 顺序，L818-821）。
- 关键步骤：
  1. `dslTaskCapability(options.task)` 取能力卡；attempt 缺省 "attempt:0"、lineOffset 缺省 0；构造失败兜底 `base`/`failure()`（补 task/attempt 出处）（L940-960）；
  2. `walkV2Lines` 逐行 `parseDslV2Line`，解析失败即返回（L962-965）；
  3. 任务能力巡检：逐行 `commandOfDslLineV2` + `capabilityAllowsCommand`，越权即 `commandNotAllowedDiagnostic`（L969-978）；
  4. `new DslSegmentParserV2({ expectedNonce, allowedReasons: capability.endReasons })` 逐行 `pushLine` 分组（盖 0 基相对 lineIndex 戳），组冲刷行记入 flushLines、组源戳 `{ attemptId, lineIndex }`（L981-1008）；parser 抛错（哨兵/表单）定位当前喂入行（L1001-1007）；
  5. 逐组 `compileEventGroupV2` 在累积预测状态上归约：坏组丢弃其软诊断并返回已提交前缀（原子性）（L1012-1043）；
  6. `parser.finish().status` 非 complete → `sentinelMissingDiagnostic`（行号 = 已提交组数+1+lineOffset）（L1045-1057）；
  7. 成功返回全部组 + 最终预测状态 + committedThroughLine（L1059-1068）。
- 调用方：域内 `compileSegmentV2WithRepair`（compiler.ts:1109,1131）；scripts/evaluate-character-dsl.ts:72（离线评估 harness）；测试 compiler-v2.test.ts、text-pipeline-v2.test.ts、protocol-card.test.ts；运行时零调用（生产流式路径走 createV2SegmentGate）。
- 依赖：`dslTaskCapability`、`walkV2Lines`、`commandOfDslLineV2`、`capabilityAllowsCommand`、`DslSegmentParserV2`、`compileEventGroupV2`、`commandNotAllowedDiagnostic`、`sentinelMissingDiagnostic`。
- 备注：与 `createV2SegmentGate` 共用同一批内部件，批式契约由 C4 测试钉住；两者 ok 路径逐字段等价（等价性测试在 compiler-v2.test.ts:704）。

#### `V2TailRepairRequester`（type） — `src/core/protocol/gal-dsl/compiler.ts:L1080-L1083`
- 用途：修复请求回调签名：`(diagnostics, tail: { text; startLine; instruction }) => Promise<string | null>`，返回改写后的尾部全文（须自带合法哨兵），null = 放弃。

#### `CompileSegmentV2WithRepairResult`（interface） — `src/core/protocol/gal-dsl/compiler.ts:L1085-L1090`
- 用途：段级结果扩展 `repairRequested` / `repairApplied`（"请求后放弃"与"从未请求"分开计数）。

#### `compileSegmentV2WithRepair(options, requestRepair): Promise<CompileSegmentV2WithRepairResult>` — `src/core/protocol/gal-dsl/compiler.ts:L1104-L1148`
- 用途：段级编译 + 至多一次未提交尾部协议修复（§4.3）。
- 关键步骤：
  1. 首编 `compileSegmentV2`，成功直接返回（L1109-1110）；
  2. 行号归一化：committedThroughLine 是含 lineOffset 的 1 基绝对行号，尾部切片下标 = `committedAbsolute - lineOffset`，offset 不双计（C5，L1112-1120）；
  3. `formatV2RepairInstruction(capability, diagnostics, expectedNonce)` 生成修复指令，调 `requestRepair`（L1121-1126）；
  4. null → 返回首编结果 + repairRequested:true / repairApplied:false（L1127-1129）；
  5. 第二次 `compileSegmentV2`：text = 修复尾部、lineOffset = tailIndex+lineOffset、attempt:"attempt:1"、在首编已提交前缀的预测状态上继续（前缀不重放）（L1131-1139）；
  6. 拼接两组/软诊断，返回（L1141-1147）。
- 调用方：scripts/evaluate-character-dsl.ts:73（离线评估 harness）＋测试（compiler-v2.test.ts、text-pipeline-v2.test.ts）；运行时零调用——生产修复编排在 openai-compatible-generator.ts:1755 用第二个 `createV2SegmentGate` 手工实现（同语义）。
- 依赖：`compileSegmentV2`、`splitV2RawLines`、`formatV2RepairInstruction`。
- 备注：编译纯函数——未选预取、被拒 repair、取消请求都不污染调用方已提交状态。

#### `V2SegmentGateOptions`（type） — `src/core/protocol/gal-dsl/compiler.ts:L1168`
- 用途：`Omit<CompileSegmentV2Options, "text">` —— 段门按行/按段文本喂入。

#### `V2GateCommit`（interface） — `src/core/protocol/gal-dsl/compiler.ts:L1171-L1180`
- 用途：一次组提交：编译组 + committedThroughLine（1 基绝对）+ 提交后预测双状态 + 本组软诊断。

#### `V2GateFeed`（type） — `src/core/protocol/gal-dsl/compiler.ts:L1183-L1185`
- 用途：一次喂入的结果：`{ ok: true; commits: V2GateCommit[] } | { ok: false; diagnostic: DslDiagnosticV2 }`（失败门即封口）。

#### `V2GateFinish`（type） — `src/core/protocol/gal-dsl/compiler.ts:L1188-L1190`
- 用途：finish() 判定：哨兵完整 → SegmentEndStatus；否则 SENTINEL_MISSING（已提交组保持）。

#### `V2SegmentGate`（interface） — `src/core/protocol/gal-dsl/compiler.ts:L1192-L1215`
- 用途：增量式段门公共面：`pushLine(raw)` / `pushText(text)` / `finish()` + 只读属性 committedGroups、committedThroughLine、visualState、characterState、assetDiagnostics。pushLine 契约：组一闭合即编译提交；任何失败封口，之后 pushLine 是编程错误。

#### `createV2SegmentGate(options: V2SegmentGateOptions): V2SegmentGate` — `src/core/protocol/gal-dsl/compiler.ts:L1222-L1381`
- 用途：创建增量式 v2 段门（Ruling 16 per-group gated forwarding）：逐行喂入、组一闭合即编译提交，调用方（生成器 v2 路径）据此把每个组在通过校验的瞬间转发给运行时，恢复边流边播延迟并保住组级原子性与"已提交组永不重写"修复边界。生产 v2 主路径的编译入口。
- 关键步骤（闭包实现）：
  1. 初始化：能力卡、attempt/lineOffset 缺省、`new DslSegmentParserV2`、输入双状态克隆、`sealed`/`finished` 门状态（L1223-1238）；
  2. `pushLine`：封口后喂入抛 Error（L1252-1256）；行号换算（1 基绝对 lineNo / 0 基相对 rel，L1257-1259）；`parseDslV2Line` 解析失败封口（L1261-1274）；能力校验失败封口（L1277-1280）；`parser.pushLine` 哨兵/表单错误封口（L1282-1290）；逐 emitted 组 `compileEventGroupV2` 即时提交——坏组封口且软诊断随组丢弃，成功则推进双状态、更新 committedThroughLine、构造 V2GateCommit（L1292-1327）；
  3. `pushText`：`splitV2RawLines` 切行后逐行 pushLine，首个失败即停（L1330-1338）；
  4. `finish`：幂等——complete → 状态原样奉还；incomplete → `sentinelMissingDiagnostic`（与批式同一行号公式，L1340-1359）；
  5. getter 暴露四项只读视图（L1361-1380）。
- 调用方：跨域生产 `src/adapters/llm/openai-compatible-generator.ts:32,1426`（首编门）与 `:1755`（修复轮门）；测试 compiler-v2.test.ts、text-pipeline-v2.test.ts。
- 依赖：`DslSegmentParserV2`、`parseDslV2Line`、`commandOfDslLineV2`、`capabilityAllowsCommand`、`compileEventGroupV2`、`splitV2RawLines`、`commandNotAllowedDiagnostic`、`sentinelMissingDiagnostic`。
- 备注：与批式入口的唯一**有意**语义差（L1161-1164 注释）：错误按首次遭遇顺序浮出——批式先全段 walk + 全段能力巡检再分组编译；本门逐行推进，首个失败即封口，因此中段错误不重置提交边界为 0。

**内部辅助**（compiler.ts）：
- `setOp(value)`（L42-44）— 构造 `{ op: "set", value }` patch 操作。
- `resetOp()`（L46-48）— 构造 `{ op: "reset" }`。
- `resolveCharacterKey(key, registry)`（L51-57）— v1：按 id/脚本名解析稳定角色 id，兜底原样返回。
- `ResolvedDialogue`（interface，L59-63）— 对白解析三元组（characterId/speaker/cue）。
- `resolveDialogue(speakerName, visual, name, state, registry, defaultsFor, diagnostics?)`（L81-169）— v1 单行对白语义：名牌覆盖必须含汉字（ASCII id 视为槽位误用，记 FORBIDDEN_DISPLAY_NAME 并忽略）；speaker = 覆盖名 / 复位默认名 / 当前尾态名；首触从默认值初始化五字段；`[]` 复位；显式 spriteSet/variant/position 各自 set。
- `filterInvalidCues(cues, initialState, catalog, registry, diagnostics?, reduce)`（L188-263）— v1 素材语义校验（spec §7）：未知 background/bgm/sound_effect 丢弃；character_patch 的 spriteSet 越权（§8 allowedSpriteSets）与 variant 非法（按组内应用顺序链式推进中间状态，audit #P2-1）丢弃；零变化 cue 记 REDUNDANT_STAGE_CUE 丢弃；@se 永不判冗余。
- `LEGAL_VALUES_BOUND`（L412）— 有界合法值列表上限 12（§4.3 不携带整套人物卡）。
- `bounded(values)`（L414-416）— 截断到上限。
- `cloneVisualState(state)`（L418-420）— 浅克隆舞台状态（characters 拷贝一层）。
- `cloneCharacterState(state)`（L422-430）— 克隆名牌状态（labels 原型空对象逐键拷贝）。
- `withoutCharacterLabel(state, characterId)`（L433-444）— 名牌复位 = 移除覆盖键（resolveCharacterLabel 自动落回 initialLabel）。
- `requireStageTarget(characterId, registry, cast, needPresentation)`（L447-487）— @name/@ch 目标三段检查：roster 内 → 场景参与者内 →（需要时）有 presentation，违例抛 DslProtocolError（legalValues 有界）。
- `requireLook(definition, look)`（L490-508）— look 键必须在该角色 looks 清单内，返回 { spriteSet, variant } 绑定。
- `CompileEventGroupV2Options`（interface，L510-522）— 单组编译选项（registry/cast/reduce/双状态/catalog/诊断出处 task/attempt/lineOffset）。
- `diagnosticFromError(error, lineIndex, options)`（L535-550）— DslProtocolError → DslDiagnosticV2（行号 = lineIndex+lineOffset+1，附 task/attempt/legalValues）。
- `splitV2RawLines(text)`（L861-866）— 去围栏、按 CRLF/LF 切行、trim、滤空行与裸 ``` 行。
- `walkV2Lines(text, lineOffset)`（L868-896）— 批式逐行解析 + 行号收集，首个解析错误即返回结构化诊断。
- `TaskScopedDiagnostic`（type，L904）— 批式/门式共用的任务无关诊断形状（`Omit<DslDiagnosticV2, "task"|"attempt">`）。
- `commandNotAllowedDiagnostic(command, task, capability, line)`（L907-919）— §4.3 第 4 步越权指令诊断（legalValues = 能力卡命令表）。
- `sentinelMissingDiagnostic(expectedNonce, capability, committedGroups, lineOffset)`（L925-936）— 哨兵缺失诊断，行号公式两入口同一（已提交组数+1+lineOffset）。

### 3.2 `legacy-line-parser.ts`（601 行）

v1 冻结解析器（文件头 L1-41 声明冻结边界：只服务显式 legacy 请求/存档；新增语法一律写 v2；唯一例外是两个被 v2 共享的纯形状助手）。

#### `normalizeDslCommandPrefix(line: string): string` — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L114-L121`
- 用途：行首指令意图位的全角/半角兼容：`＠`→`@`，`@` 后紧跟的 `？＋＝／`→半角；正文行永不以 @ 开头故不受影响。
- 调用方：域内 `parseDslV1Line`（L319）、closing-repair.ts:1,49；line-parser.ts re-export。
- 依赖：`FULLWIDTH_FORM_PUNCT` 映射表（L103-108）。

#### `matchEndSentinel(line: string): { nonce: string; reason: SegmentEndReason } | null` — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L265-L294`
- 用途：`@end <nonce> <reason>` 哨兵**形状**匹配（v1/v2 共用，冻结语义）：不匹配返回 null（交回调用方继续分发）；形状匹配但缺 reason 抛 SENTINEL_MISSING_REASON、reason 非法抛 SENTINEL_INVALID_REASON。
- 调用方：域内 `parseDslV1Line`（L322）、`parseDslV2Line`（line-parser.ts:299）。
- 备注：v2 对 v1 语法助手的唯一合法复用点（legacy-line-parser.ts:8-11 注释）。

#### `matchEndingEpilogueLine(line: string): string | null` — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L302-L305`
- 用途：`@ending` 行形状匹配，返回其后剩余原文（token 解析在 `interpretEndingEpilogue`）；前视断言 `@ending(?:\s|$)` 保证 `@ending_title` 等粘写不误匹配。
- 调用方：域内 `parseDslV1Line`（L331）、`parseDslV2Line`（line-parser.ts:303）。

#### `parseDslV1Line(rawLine: string, knownSpeakers?: ReadonlySet<string>): DslLine` — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L317-L539`
- 用途：解析一行完整 v1 DSL 为 DslLine，违规抛 DslProtocolError。
- 关键步骤（按检查序）：
  1. trim + `normalizeDslCommandPrefix`（L319）；
  2. `matchEndSentinel` → segment_end（L321-325）；`matchEndingEpilogueLine` → ending_epilogue（L327-334）；
  3. 表单四指令与裸别名废弃守卫（`/?`、`?`、`+`、`=` 命中即 RETIRED_ALIAS，L337-350）；
  4. `@beat` 与裸 `beat` 废弃守卫（L353-354）；
  5. `@bg/@bgm/@se` 正则单资产指令 + 裸 `bg/bgm/se` 废弃守卫 + 残缺形态 UNKNOWN_LINE（L357-384）；
  6. `@ch` 两种形态：set（`@ch <id>:<variant> [position]`，含变体槽写反/中文变体防御性报错 INVALID_CH_CUE，L390-442）与 hide/show/exit（L443-452），裸 `ch` 废弃守卫与残缺 @ch 报错（L453-471）；
  7. 其余一切 `@` 行 → UNKNOWN_COMMAND（带台词形状检测给出针对性修复建议，L477-495）；
  8. 台词解析：全角 `：` 定界符仅在**分隔位置且前缀是注册说话人**（knownSpeakers 门卫）时归一为半角（L507-517）；`<speaker>[<visual>](<name>): <text>` 正则匹配 → `parseVisual`/`parseName`（L518-535）；括号内的 `：` 也归一（L526-527）；
  9. 其余 → narration（L538）。
- 调用方：域内 `parseDslLine`（line-parser.ts:97）、line-parser re-export（含别名 parseDslLegacyLine）；生产经 openai-compatible-generator.ts 的 `parseDslLine` 间接调用。
- 依赖：`parseVisual`、`parseName`、`matchEndSentinel`、`matchEndingEpilogueLine`、`hasKeywordPrefix`、`retiredAlias`、`containsHan`。
- 备注：knownSpeakers 门卫是纯函数参数——解析器不持有注册表，由调用方决定哪些名字算说话人。

#### `ENDING_TITLE_MAX_CHARS`（const = 32） — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L546`
- 用途：结尾词硬上限：超长截断不报错（元数据永远不炸段）。

#### `interpretEndingEpilogue(raw: string, expectedNonce: string): SegmentEndingEpilogue` — `src/core/protocol/gal-dsl/legacy-line-parser.ts:L573-L601`
- 用途：把 `@ending` 行剩余原文确定性解析成档位/结尾词（宽容、永不报错）：档位未定时命中 TE|HE|NE|BE 记档位；nonce/reason 回声（`EPILOGUE_ECHO_TOKENS`）静默跳过；第一个其他 token 起全部作结尾词（一旦开始不再吃档位）；超长按码点截断。
- 调用方：域内 segment-validator.ts:89（哨兵窗口内消费）；line-parser re-export（segment-validator 经此路径导入）。

**内部辅助**（legacy-line-parser.ts）：
- `CHARACTER_POSITIONS`（L53-59）— 五个合法位置词集合。
- `isCharacterPosition(token)`（L61-63）— 位置词判定（类型谓词）。
- `hasKeywordPrefix(line, keyword)`（L70-74）— 保留词前缀判定，词边界用 `\s`（含全角空格，防幻影说话人，audit A1）。
- `retiredAlias(line, atForm)`（L82-92）— 裸写法废弃的响亮报错构造器。
- `STAGE_CUE_EXPECTED`（L94-95）— 资产指令期望格式文案。
- `containsHan(text)`（L98-100）— 含汉字判定（变体槽防御）。
- `FULLWIDTH_FORM_PUNCT`（L103-108）— `@` 后全角标点映射表。
- `invalidVisualBracket(content, why)`（L126-135）— INVALID_VISUAL_BRACKET 错误构造器。
- `swappedVisualSlots(content, speakerId)`（L138-148）— 变体槽写反（放了注册角色 id）的针对性错误。
- `parseVisual(content, knownSpeakers?)`（L155-217）— `[...]` 槽解析：undefined 无槽 / `[]` 复位 / `[variant]` / `[spriteSet:variant]` / `[|position]` / `[spriteSet:variant|position]`，含两槽写反检测。
- `parseName(content)`（L224-243）— `(...)` 槽解析：undefined 无槽 / `()` 复位 / 显示名（trim 后非空）。
- `EPILOGUE_ECHO_TOKENS`（L553-557）— buffer/interaction/ending 回声词集合。

### 3.3 `line-parser.ts`（426 行）

版本路由入口 + v2 解析器 + 输出卫生谓词；同时 re-export v1 冻结面保持既有调用方（generator、closing-repair、segment-validator、text-pipeline、测试）导入路径不变（L45-53 注释）。

#### re-export 块 — `src/core/protocol/gal-dsl/line-parser.ts:L47-L53`
- `parseDslV1Line`、`normalizeDslCommandPrefix`、`interpretEndingEpilogue`、`ENDING_TITLE_MAX_CHARS`（L47-52）与别名 `parseDslLegacyLine`（L53）——注意：`parseDslLegacyLine` **全仓零引用**（grep 仅命中其自身声明行）。

#### `parseDslLine(line, options)`（三个重载） — `src/core/protocol/gal-dsl/line-parser.ts:L82-L98`
- 用途：版本路由入口：`{ protocolVersion: 2 }` → `parseDslV2Line`（返回 DslLineV2）；其余一切调用形状（缺省、knownSpeakers 集合、`{ protocolVersion: 1 }`）→ `parseDslV1Line`（返回 DslLine）。
- 关键步骤：`resolveParseOptions` 归一选项（ReadonlySet 旧形状或无 protocolVersion 字段 → v1，L64-73）；按版本分派（L94-97）。
- 调用方：域内 text-pipeline.ts:57；跨域生产 openai-compatible-generator.ts:24（v1 路径）；测试 line-parser.test.ts、protocol-card.test.ts、dynamic-character-e2e.test.ts、character-contract.test.ts。
- 备注：解析层缺省 = 1（legacy reader 口径）；服务端新局默认 2 由 config zod 缺省承担，运行时 v2 路径显式携带 2（L76-81 注释）。

#### `stripNarrationLabel(text: string): string | null` — `src/core/protocol/gal-dsl/line-parser.ts:L167-L170`
- 用途：剥离「旁白：/旁白:」自标注泄漏标签（campus c54501b 移植）：`/^旁白\s*[:：]\s*(.+)$/` 命中返回正文，否则 null。v2 的 characterId 是注册 ID，正文首部 `旁白：` 不可能是合法引用，无需 v1 的 knownSpeakers 例外。
- 调用方：域内 `parseDslV2Line` @n 分支（L354）；测试 line-parser-v2.test.ts:18,271。

#### `narrationLabelLeaked(rawLine: string): boolean` — `src/core/protocol/gal-dsl/line-parser.ts:L173-L175`
- 用途：@n 行是否带「旁白：」泄漏的**谓词**（剥离发生在 parse；此谓词供生成器计数）。
- 调用方：跨域生产 openai-compatible-generator.ts:23,1506。

#### `detectDialogueTailNarration(text: string): boolean` — `src/core/protocol/gal-dsl/line-parser.ts:L187-L189`
- 用途：台词尾缀旁白**检测**（campus 7cf90ad 移植，仅观测计数不改写）：`[。！？][”’」』"']?\s*(?:她|他)` 启发式；刻意排除省略号边界；无代词形态漏报可接受（自动剥离会吃掉正常台词）。
- 调用方：跨域生产 openai-compatible-generator.ts:22,1508。
- 备注：与生成器的计数共用 `DIALOGUE_TAIL_NARRATION_RE`（L185），"勿在两处重写"（L183 注释）。

#### `parseDslV2Line(rawLine: string): DslLineV2` — `src/core/protocol/gal-dsl/line-parser.ts:L273-L426`
- 用途：解析一行完整 v2 DSL（行允许首尾空白与 CRLF；正文逐字保留），语法违规抛 DslProtocolError；任务能力与身份/资源语义在 compiler 校验。
- 关键步骤（按分发序）：
  1. trim；空行抛 MISSING_BODY；非 `@` 开头抛 UNKNOWN_COMMAND（v2 无裸台词/旁白，也不降级——降级会静默丢说话人，L275-290）；
  2. 表单四指令（`@?`/`@+`/`@=` 粘写提示、`@/?` 精确匹配，L293-296）；
  3. 哨兵与结局行：复用 v1 冻结助手 `matchEndSentinel`/`matchEndingEpilogueLine`；`@end` 词命中但哨兵不匹配 → SENTINEL_MISSING_REASON（L299-317）；
  4. `@beat` 精确匹配（L320）；
  5. 单资产指令 `@bg/@bgm/@se` 正则 + 残缺形态 UNKNOWN_LINE（L323-339）；
  6. `@say`：`takeTokens` 取 1 个固定 token（角色 id）+ 剩余原文为正文，缺槽报错（L342-347）；
  7. `@n`：0 token + 剩余原文，经 `stripNarrationLabel` 剥泄漏标签（L351-356）；
  8. `@name`：2 token（角色 id + set/reset 子命令）+ 名牌正文；reset 后不得有内容；set 缺正文报错（L359-388）；
  9. `@ch`：2 token（角色 id + 子命令）+ `parseChParams` 参数区；hide/exit/reset 不接受参数；show/set 经 key=value 参数；set 至少一个参数（L391-422）；
  10. 其余一切 @ 行（粘写/全角/v1 独有语法）→ `unknownV2Command` 响亮报错（L425）。
- 调用方：域内 `walkV2Lines`/`compileSegmentV2`、`createV2SegmentGate`（compiler.ts:878,1263）；跨域生产 openai-compatible-generator.ts:24；测试 line-parser-v2.test.ts。
- 依赖：`takeTokens`、`hasCommandWord`、`parseChParams`、`stripNarrationLabel`、`matchEndSentinel`、`matchEndingEpilogueLine`、错误构造器组。

**内部辅助**（line-parser.ts）：
- `ResolvedParseOptions`（interface，L59-62）— 归一后的版本+说话人集合。
- `resolveParseOptions(arg?)`（L64-73）— 选项归一（新旧调用形状兼容）。
- `V2_CHARACTER_POSITIONS`（L104-110）— v2 五位置词集合。
- `isV2CharacterPosition(token)`（L112-114）— 位置词判定。
- `isSpace(ch)`（L116-118）— 空白判定。
- `hasCommandWord(line, word)`（L121-124）— 命令词判定（整词或后跟空白，禁粘写）。
- `takeTokens(source, tokenCount)`（L131-143）— 取固定数量 token 后跳一段空白，剩余全部作正文逐字返回（不 trim 内部）。
- `missingBody(what, rawLine)`（L145-155）— MISSING_BODY 错误构造器。
- `DIALOGUE_TAIL_NARRATION_RE`（L185）— 尾缀旁白启发式正则。
- `unknownV2Command(rawLine)`（L191-201）— UNKNOWN_COMMAND 错误构造器（含 v2 指令清单）。
- `invalidChParameter(message, rawLine)`（L203-216）— INVALID_CH_PARAMETER 错误构造器。
- `invalidDisplayNameLabel(message, rawLine)`（L218-227）— INVALID_DISPLAY_LABEL 错误构造器。
- `parseChParams(paramTokens, rawLine)`（L230-267）— @ch 参数区解析：key=value、只认 look/position、拒绝重复/未知/非法值。

### 3.4 `types.ts`（538 行）

全流水线共享形状（文件头 L1-13 声明分层与"Only the shared shapes"）。类型在流水线中的角色按节标注。

**单行层（解析器输出）**
#### `DialogueVisualSpec` — `types.ts:L31-L48`
- v1 台词头 `[...]` 视觉槽内容：`hasVisual`（有无括号）、`resetVisual`（`[]` 复位，与 spriteSet/variant/position 互斥）、`spriteSet?`（`[set:variant]` 跨组换装）、`variant?`、`position?`。角色：parseVisual 产出 → resolveDialogue 消费。
#### `DialogueNameSpec` — `types.ts:L51-L58`
- v1 台词头 `(...)` 名牌槽：`hasName`、`resetName`（`()` 复位）、`displayName?` 覆盖名。角色：parseName 产出 → resolveDialogue 消费。
#### `DslLine`（union，19 个变体） — `types.ts:L60-L96`
- v1 单行解析结果：narration / dialogue（speaker+text+visual+name）/ background / bgm / sound_effect / character_cue（action: set|show|hide|exit）/ beat / form_start / form_option / form_input / form_end / ending_epilogue（raw）/ segment_end（nonce+reason）。角色：parseDslV1Line 产出 → EventGroupBuilder 消费。
#### `DslProtocolVersion = 1 | 2` — `types.ts:L103`
- 协议版本判别。
#### `DslParseOptions` — `types.ts:L106-L110`
- 版本路由选项（protocolVersion? + 仅 v1 的 knownSpeakers?）。
#### `DslLineV2`（union，18 个变体） — `types.ts:L119-L148`
- v2 单行解析结果：say（characterId+text）/ narration / name_set / name_reset / ch_show / ch_set / ch_hide / ch_exit / ch_reset / background / bgm / sound_effect / beat / form_*×4 / ending_epilogue / segment_end；全部变体带可选 `lineIndex`（诊断定位盖章）。与 v1 本质差异：正文起点 = 固定 token 后剩余原文（L113-118 注释）。
#### `AnyDslLine = DslLine | DslLineV2` — `types.ts:L151`
- 两版行联合（DslSegmentParser 两变体公共输入类型）。

**交互草稿层**
#### `InteractionMode = "choice" | "input" | "hybrid"` — `types.ts:L158`
- 表单模式（parser 推导，模型不写）。
#### `DslInteractionDraft` — `types.ts:L165-L170`
- 解析级交互：纯创意内容（prompt/optionTexts/inputPlaceholder?/mode）；机器字段（interaction_id、选项 id、InputSpec）由运行时编译器补（L161-164 注释）。角色：InteractionBuilder.finish 产出 → 两版 group-builder flush 成 interaction 主事件 → 运行时物化。

**事件组草稿层（解析器 → 编译器）**
#### `MainEventDraft`（union） — `types.ts:L176-L188`
- v1 组主事件草稿：dialogue（带 visual/name spec）/ narration / interaction / beat。
#### `DslSourceLocation` — `types.ts:L196-L199`
- 流式监控溯源戳 `{ attemptId, lineIndex }`；测试与非流式生产者缺省。
#### `EventGroupDraft` — `types.ts:L201-L204`
- v1 原子播放单元：`prelude: StageCue[]`（含从台词头折算的 character_patch）+ main。角色：EventGroupBuilder 产出 → compileEventGroup 消费；v1 流式会话的跨缝载荷（AnyStreamedGroup 一支）。
#### `V2StageOp`（union，10 个变体） — `types.ts:L218-L228`
- v2 组前奏**意图**（ch_*/label_*/background/bgm/sound_effect，按源顺序保留、未解析成 StageCue——默认值、无立绘判定、look 合法性都要 registry+状态，是 compiler 职责）。角色：EventGroupBuilderV2 产出 → compileEventGroupV2 消费。
#### `MainEventDraftV2`（union） — `types.ts:L231-L235`
- v2 组主事件草稿：dialogue 的身份是机器 ID（characterId），名牌快照由 compiler 生成。
#### `EventGroupDraftV2` — `types.ts:L238-L243`
- v2 原子播放单元：prelude: V2StageOp[] + main + 可选 source。
#### `AnyEventGroupDraft = EventGroupDraft | EventGroupDraftV2` — `types.ts:L245`
- 两版草稿联合（DslSegmentParserBase 泛型约束）。
#### `AnyStreamedGroup = EventGroupDraft | CompiledEventGroupV2` — `types.ts:L262`
- 流式组缝：v1 会话 = 冻结草稿（Game 侧编译），v2 会话 = 语义编译后已提交组（Game 侧只应用）。**判别式契约**（L247-261 注释）：运行时判别 = `"labelOps" in group`，EventGroupDraft 永不得新增 labelOps 同名字段。

**哨兵/结局层**
#### `SegmentEndReason = "buffer" | "interaction" | "ending"` — `types.ts:L268`
- 哨兵 reason 受控词表。
#### `EndingGrade = "TE" | "HE" | "NE" | "BE"` — `types.ts:L274`
- 结局档位（现场活动按档位分发奖品）。
#### `ENDING_GRADES`（const，readonly 数组） — `types.ts:L276`
- 档位词表常量（interpretEndingEpilogue 消费）。
#### `SegmentEndingEpilogue` — `types.ts:L279-L282`
- @ending 解析结果：grade?（缺省 NE）/ title?（UI 回退「剧终」）。
#### `SegmentEndStatus`（union） — `types.ts:L284-L292`
- 段收尾状态：complete（nonce+reason+epilogue?）/ incomplete（截断，已提交组存活、pending 尾丢弃）。
#### `DslSegmentResult` — `types.ts:L294-L298`
- v1 整段结果：groups + status（parseDslSegmentText 返回）。

**协议错误层**
#### `DslErrorCode`（union，28 个码） — `types.ts:L304-L339`
- v1 结构错误码（哨兵 9 个、表单 8 个、行解析 5 个等）+ v2 新增 10 个（MISSING_BODY、INVALID_CH_PARAMETER、INVALID_DISPLAY_LABEL、UNKNOWN_CHARACTER_ID、PLAYER_SPEECH_FORBIDDEN、CHARACTER_NOT_ALLOWED、UNKNOWN_LOOK、CHARACTER_HAS_NO_PRESENTATION、COMMAND_NOT_ALLOWED_FOR_TASK、SENTINEL_MISSING）。
#### `DslErrorDetail` — `types.ts:L346-L358`
- FastAPI 式结构化细节：expected?/cause?/fix?/legalValues?（有界合法值，绝不携带整套敏感人物卡）。
#### `DSL_COMMAND_LIST`（const） — `types.ts:L361-L362`
- v1 指令清单文案（未知 @ 行报错引用）。
#### `DSL_COMMAND_LIST_V2`（const） — `types.ts:L365-L366`
- v2 语法指令清单文案（v2 未知行报错引用）。
#### `DslProtocolError extends Error`（class） — `types.ts:L372-L383`
- 全域唯一错误类型：`code: DslErrorCode` + `detail?: DslErrorDetail`；message 兼作嵌入下一轮请求的修复指令正文（docs §8.5）。
#### `formatDslErrorDetail(error, lineIndex, rawLine?): string` — `types.ts:L391-L405`
- 用途：把错误序列化成多行中文修复指令（第 N 行 DSL 错误 [code] / 错误行原文 / 原因 / 期望格式 / 修正）。
- 调用方：跨域生产 openai-compatible-generator.ts:50（修复回路注入下一轮 user prompt）；测试广泛引用。

**v1 编译产物层**
#### `CompiledMainEvent`（union） — `types.ts:L411-L415`
- v1 编译后主事件：dialogue 携带 characterId + speaker（玩家可见名）。
#### `CompiledEventGroup` — `types.ts:L418-L421`
- v1 编译后组：prelude: StageCue[] + main（角色键已解析为稳定 id）。
#### `AssetDiagnosticCode`（union，7 个码） — `types.ts:L424-L431`
- 素材语义校验软诊断码：UNKNOWN_BACKGROUND/BGM/SOUND_EFFECT、UNKNOWN_SPRITE_VARIANT、FORBIDDEN_SPRITE_SET、FORBIDDEN_DISPLAY_NAME、REDUNDANT_STAGE_CUE。
#### `AssetDiagnostic` — `types.ts:L438-L441`
- 一条丢弃 cue 诊断：code + id（compiler 记录，不影响段成败）。
#### `CompileEventGroupsOptions` — `types.ts:L443-L466`
- v1 编译选项：registry、tailState（本段前已提交的尾态）、reduce（纯 reducer）、defaultsFor、catalog?（启用素材校验）、diagnostics?（软诊断收集器）。
#### `CompileEventGroupsResult` — `types.ts:L468-L472`
- v1 批式结果：groups + 新 tailState。

**v2 诊断/编译产物层**
#### `DslSemanticDiagnosticCode`（union，7 个码） — `types.ts:L482-L489`
- v2 语义诊断码（与 DslErrorCode 尾部 7 项同名字面量——两类型并存，见 §7 重构关注点）。
#### `DslDiagnosticV2` — `types.ts:L495-L509`
- v2 结构化诊断：code/message/line（1 基含 lineOffset）/task?/attempt?/value?/legalValues?（有界）。
#### `CompiledLabelOpV2`（union） — `types.ts:L512-L514`
- v2 编译后名牌操作：set label 或 resetToInitial（与 cue、主事件同组原子提交）。
#### `CompiledMainEventV2`（union） — `types.ts:L520-L524`
- v2 编译后主事件：dialogue 带 characterId + **displayLabel**（发射时刻名牌快照，C2 严格事件形状：不含旧 speaker 字段）。
#### `CompiledEventGroupV2` — `types.ts:L527-L532`
- v2 编译后组：prelude（只含 presentation cue）+ labelOps + main + source?。
#### `DslSegmentResultV2` — `types.ts:L535-L538`
- v2 段结果：groups + status（与 v1 同一收尾协议）。

#### re-export `StageCue` — `types.ts:L24`
- 从 presentation/types.js 转发（协议域消费舞台 cue 形状但不定义它）。

### 3.5 `group-builder.ts`（384 行）

#### `EventGroupBuilder`（class） — `src/core/protocol/gal-dsl/group-builder.ts:L22-L200`
- 用途：v1 行 → EventGroupDraft 组装器（docs §36-§39/§43）：舞台 cue 累积进 `pendingCues`，直到主事件（dialogue/narration/完整表单/beat）冲刷成一组；打开中的表单吞掉一切 cue 行。
- 公共方法：`hasOpenInteraction()`（L26-28）；`push(line: DslLine): EventGroupDraft[]`（L30-111）——按行类型分派：资产/角色 cue 入 pending；dialogue/narration/beat 先 `assertNoOpenForm` 再 flush；form_start 先验证再挂载（防半开 builder 残留，2026-09-17 复盘 L67-75）；form_option/form_input 经 `ensureInteraction`（一次性 builder 保证 throw 无状态，L141-153 注释）；form_end 完成 interaction 并 flush；segment_end/ending_epilogue 到达即 UNKNOWN_LINE（validator 已拦截，到达即管线误用）；`finish(): { pendingCues; openInteraction }`（L113-136）——终态调用，截断表单（不可推导）静默丢弃，所有权转移防重复交付。
- 调用方：域内 segment-validator.ts（DslSegmentParser 的 sink，L209）；测试 group-builder.test.ts。
- 依赖：`InteractionBuilder`、`DslProtocolError`、StageCue（presentation）。

#### `EventGroupBuilderV2`（class） — `src/core/protocol/gal-dsl/group-builder.ts:L214-L384`
- 用途：v2 行 → EventGroupDraftV2 组装器，分组规则与 v1 相同；差异只在 prelude 元素类型——保留**源顺序意图**（V2StageOp），StageCue 翻译/默认值初始化/语义校验都在 compiler（§4.2 状态表需要 registry+双状态域）。
- 公共方法：`hasOpenInteraction()`（L218-220）；`push(line: DslLineV2): EventGroupDraftV2[]`（L222-335）——ch_*/资产行原样按源顺序入列（与 V2StageOp 逐字段同形，L231-234）；name_set/name_reset 映射为 label_set/label_reset（身份域命名，L237-253）；say/narration/beat flush 并盖章 lineIndex；表单逻辑与 v1 同形（含穷尽性守卫 default: never，L325-333）；`finish()`（L337-355）同 v1 语义。
- 调用方：域内 segment-validator.ts（DslSegmentParserV2 的 sink，L214-215）；无专属测试文件（经 compiler-v2.test.ts 的 compileSegmentV2/createV2SegmentGate 全链路间接覆盖）。
- 依赖：同 v1。
- 备注：与 v1 builder 结构性重复（表单分支/错误文案逐字相同）——见 §7。

**内部辅助**（group-builder.ts，两 class 各自私有）：
- `ensureInteraction()`（L148-153 / L357-362）— 无打开表单时返回一次性 builder（错误从 InteractionBuilder 抛，保持 throw 无状态）。
- `assertNoOpenForm()`（L156-168 / L364-376）— 主事件打断表单时抛 CONTENT_INSIDE_OPEN_FORM。
- `flush(main)`（L171-176 / L378-383）— pendingCues/ops + 主事件冲刷成一组并清空。
- `characterCue(line)`（L179-199，仅 v1）— ch 行 → character_patch StageCue（show/hide/exit/set 四动作）。

### 3.6 `capabilities.ts`（244 行）

任务协议能力卡（C4 §5.2）——命令能力、结束方式的**唯一数据源**；validator 与修复模板同源引用，禁止 task template 另写一份矛盾 DSL（文件头 L1-19）。

#### `DSL_V2_COMMANDS`（const，14 个命令） — `src/core/protocol/gal-dsl/capabilities.ts:L23-L38`
- v2 语法命令名全集（@say/@n/@name/@ch/@bg/@bgm/@se/@beat/@?/@+/@=/@/?/@end/@ending）。
#### `DslV2Command`（type） — `capabilities.ts:L40`
- 命令名联合类型（typeof DSL_V2_COMMANDS[number]）。
#### `DslTaskType`（type） — `capabilities.ts:L43-L49`
- actor 写手任务：opening/continuation/branch_prefetch/input_response/input_bridge/protocol_repair（memory/director/recap 不获 DSL 职责，不在表内）。
#### `BaseDslTaskType`（type） — `capabilities.ts:L56`
- `Exclude<DslTaskType, "protocol_repair">`——可直接发整卡的任务；修复任务必须经 protocolRepairCapability 派生。
#### `DslTaskCapability`（interface） — `capabilities.ts:L59-L69`
- 一张卡：task、commands（允许命令）、endReasons（允许 @end reason，哨兵校验与能力校验共用）、ending（是否允许 @ending）、scope（人类可读范围描述）。
#### `dslTaskCapability(task: BaseDslTaskType): DslTaskCapability` — `capabilities.ts:L147-L155`
- 用途：取卡单源入口；`protocol_repair` 入参抛 Error（强制走派生，C4 评审 minor d 收口）。
- 调用方：域内 compileSegmentV2（L940）、createV2SegmentGate（L1223）、compileSegmentV2WithRepair（L1108）；跨域生产 protocol-card.ts:290、openai-compatible-generator.ts:37；测试 capabilities.test.ts、prompts.test.ts。
- 依赖：模块内五张静态卡 OPENING/CONTINUATION/BRANCH_PREFETCH/INPUT_RESPONSE/INPUT_BRIDGE（L85-144，卡片内容逐行对应计划 §5.2 表）。
#### `protocolRepairCapability(baseTask: BaseDslTaskType): DslTaskCapability` — `capabilities.ts:L162-L169`
- 用途：修复卡派生：**继承**原任务能力（commands/endReasons/ending 原样），限定未提交尾部；不新增命令、不改 nonce/玩家选择/已提交前缀。
- 调用方：跨域生产 protocol-card.ts:289（修复请求按此派生）；测试 capabilities.test.ts:88,95。
#### `commandOfDslLineV2(line: DslLineV2): DslV2Command` — `capabilities.ts:L172-L208`
- 用途：行 → 命令名映射（@name 两种形式都映射 @name）；能力校验步的输入。
- 调用方：域内 compileSegmentV2（L971）、createV2SegmentGate（L1277）；测试 capabilities.test.ts:134。
#### `capabilityAllowsCommand(capability, command): boolean` — `capabilities.ts:L211-L216`
- 用途：`capability.commands.includes(command)`——validator 的任务能力校验判定。
- 调用方：域内 compileSegmentV2（L972）、createV2SegmentGate（L1278）。
#### `formatV2RepairInstruction(capability, diagnostics, expectedNonce): string` — `capabilities.ts:L222-L244`
- 用途：从能力卡 + 诊断生成修复指令（模板不硬编码示例角色，只引用有界合法值）：任务名 + 允许指令清单 + 哨兵格式（nonce 照抄）+ ending 附加说明 + 至多 3 条诊断明细。
- 调用方：域内 compileSegmentV2WithRepair（compiler.ts:1121）；跨域生产 openai-compatible-generator.ts:38（流式修复轮）；测试 capabilities.test.ts:167。
- 备注：`LEGAL_VALUES_BOUND=12` 的截断在此体现（diagnostic.legalValues.slice(0, 12)）。

### 3.7 `segment-validator.ts`（216 行）

#### `DslSegmentParser`（class，v1，行为冻结） — `src/core/protocol/gal-dsl/segment-validator.ts:L208-L210`
- 用途：v1 段解析器：`DslSegmentParserBase<DslLine, EventGroupDraft>`，sink = `new EventGroupBuilder()`；继承全部哨兵/epilogue 状态机。
- 调用方：域内 text-pipeline.ts:49；跨域生产 openai-compatible-generator.ts:835（v1 流式路径）；测试 segment-validator.test.ts、protocol-card.test.ts、text-pipeline.test.ts。

#### `DslSegmentParserV2`（class） — `src/core/protocol/gal-dsl/segment-validator.ts:L213-L216`
- 用途：v2 段解析器：同一哨兵/epilogue 状态机 + v2 组构造器（sink = `new EventGroupBuilderV2()`）。
- 调用方：域内 compileSegmentV2（compiler.ts:981）、createV2SegmentGate（compiler.ts:1226）；跨域生产 openai-compatible-generator.ts:1484（v2 流式严格解码路径）；测试经 compiler-v2 间接覆盖。

**内部辅助**（segment-validator.ts）：
- `SegmentGroupSink<L, G>`（interface，L35-38）— 组构造器公共面（push/hasOpenInteraction）。
- `DslSegmentParserBase<L, G>`（abstract class，L40-205）— 哨兵状态机基类（v1/v2 通用）：`pushLine`（L70-117，segment_end 分派 pushSegmentEnd；哨兵后内容 SENTINEL_NOT_LAST 或 ending 窗口收尾；哨兵前 @ending 抛 ENDING_EPILOGUE_ORPHAN；其余转 sink）；`pushSegmentEnd`（L119-173，哨兵重复/nonce 不符/reason 越界/表单未闭四类校验 + 打开 epilogue 窗口）；`closeOpenInteraction()`（L65-68，流式适配器在 interaction 哨兵前显式闭合可完成表单）；`isEndingSettled()`（L181-183，流式适配器停消费判据）；`finish()`（L185-187）/`finishStatus()`（L189-204，complete/incomplete 判定 + epilogue 附加）。

### 3.8 `closing-repair.ts`（154 行）

v1 流式路径的行级确定性修复（生成器在喂解析器**之前**逐行尝试；2026-09-17 会话审计的全部实测变体）。

#### `DslClosingRepair`（interface） — `src/core/protocol/gal-dsl/closing-repair.ts:L12-L15`
- 哨兵修复结果：`{ line: string; kind: "end_keyword" }`。
#### `DslVisualSwapRepair`（interface） — `src/core/protocol/gal-dsl/closing-repair.ts:L18-L23`
- 槽位写反修复结果：line + kind: "visual_swap" + from/to（修复事件文案用）。
#### `repairDslClosingLine(raw, expectedNonce, allowedReasons): DslClosingRepair | null` — `src/core/protocol/gal-dsl/closing-repair.ts:L43-L85`
- 用途：修复哨兵关键词残缺（`@ <nonce> <reason>`/`@<nonce> …`/`@¬end …`/`@eend …`/`@end<nonce> …`/`@el …`）；锚定**精确 expected nonce + 合法 reason**（每请求随机值，合法行不可能携带），绝不猜 nonce/reason；规范哨兵不产修复事件；缺 reason 不可推导，留给严格解析器。
- 关键步骤：非字符串/非 @ 开头返回 null（L48-50）；规范哨兵形态直通 null（L54）；`/^@(.+)\s+(buffer|interaction|ending)$/` 匹配后按 head 分三种 case：head === nonce（关键词整体缺失，L64）/ 两 token 且第二 token 是 nonce 且第一 token 是 junk（L71-78）/ head 以 nonce 结尾且前缀是 junk（粘连，L80-83）。
- 调用方：跨域生产 openai-compatible-generator.ts:975,1188；测试 closing-repair.test.ts:5。
- 依赖：`normalizeDslCommandPrefix`（line-parser re-export）、`isJunkKeyword`。
#### `repairSwappedVisualSlots(raw, knownSpeakers?): DslVisualSwapRepair | null` — `src/core/protocol/gal-dsl/closing-repair.ts:L116-L153`
- 用途：修复台词头括号槽写反（`苏遥[suyao|smug]: …`——注册角色 id 出现在变体槽；id 不可能是变体名，确定性丢弃）：`[id|position]` → `[|position]`、`[id|variant]` → `[variant]`、`[id]` → 整个省略；仅**精确注册 id** 触发。
- 关键步骤：无 knownSpeakers 返回 null；正则抓台词头（名牌槽 `(名)` 夹在括号与冒号之间时原样保留，L124）；首槽非注册 id 返回 null；两段时空第二槽（`[suyao|]`）返回 null；位置词保位、其余作变体（L132-146）。
- 调用方：跨域生产 openai-compatible-generator.ts:983,1193；测试 closing-repair.test.ts:60。

**内部辅助**（closing-repair.ts）：
- `CHARACTER_POSITIONS`（L4-10）— 位置词集合（与 legacy-line-parser 重复定义）。
- `isJunkKeyword(token)`（L93-100）— 垃圾关键词判定：1-6 个非空格/非数字/非汉字字符（数字排除防止其他 nonce 冒充）。

### 3.9 `interaction-builder.ts`（125 行）

#### `InteractionBuilder`（class） — `src/core/protocol/gal-dsl/interaction-builder.ts:L13-L125`
- 用途：累积单个交互表单：`@?` 开、`@+`/`@=` 喂、`@/?` 闭；mode 在 finish() 推导（模型永不写）；全部文本 trim 存储。两版 group-builder 共用。
- 公共方法：
  - `start(prompt)`（L18-40）— 已开抛 FORM_ALREADY_OPEN；空提示抛 EMPTY_FORM_PROMPT；
  - `addOption(text)`（L42-59）— 表单外抛 FORM_LINE_OUTSIDE_FORM；空文本抛 EMPTY_OPTION_TEXT；
  - `setInput(placeholder)`（L61-85）— 表单外抛 FORM_LINE_OUTSIDE_FORM；重复抛 MULTIPLE_INPUT_FIELDS；空占位抛 EMPTY_INPUT_PLACEHOLDER；
  - `finish(): DslInteractionDraft`（L87-120）— 未开抛 FORM_END_WITHOUT_OPEN；按 options/input 推导 choice/input/hybrid；两者皆无抛 EMPTY_FORM；
  - `isOpen()`（L122-124）— prompt 非空即开。
- 调用方：域内 group-builder.ts 两个 builder（v1:72,79,83,87,117；v2 同形）。
- 依赖：types（DslProtocolError/DslInteractionDraft/InteractionMode）。

### 3.10 `text-pipeline.ts`（64 行）

#### `removeMarkdownFence(text: string): string` — `src/core/protocol/gal-dsl/text-pipeline.ts:L13-L19`
- 用途：剥离模型载荷外围 markdown 围栏（```json/```jsonl/```）。
- 调用方：域内 text-pipeline.ts:52、compiler.ts:370,862（splitV2RawLines）；测试 text-pipeline.test.ts。
#### `parseDslSegmentText(text, options): DslSegmentResult` — `src/core/protocol/gal-dsl/text-pipeline.ts:L40-L64`
- 用途：v1 整段文本批式入口（测试/整文本回退用）：去围栏 → 按 CRLF/LF 切行 trim → 滤空行与裸 ``` → 逐行 parseDslLine + DslSegmentParser.pushLine → finish()。
- 调用方：**无生产调用方**（grep 全仓仅 src/llm.test.ts:37）。
- 依赖：`parseDslLine`、`DslSegmentParser`、`removeMarkdownFence`。
- 备注：L20-21 的 `parseDslV2Line`/`DslSegmentParserV2` 导入**未被使用**（死导入，见 §7）。

### 3.11 `stream-decoder.ts`（47 行）

#### `StreamLineDecoder`（class） — `src/core/protocol/gal-dsl/stream-decoder.ts:L11-L47`
- 用途：流式行解码器（流水线最底层，docs §41）：原始网络块 → 完整行；按 `\n`/`\r\n` 切分（尾 `\r` 剥离）、空行丢弃、无换行的截断尾缓冲到 flush。
- 公共方法：`push(chunk): string[]`（L18-30，本块新可用的完整行）；`flush(): string | null`（L36-41，取走截断尾并清空）；`hasPending(): boolean`（L43-45）。
- 调用方：跨域生产 openai-compatible-generator.ts:20,865,925,1485（v1 与 v2 两条流式路径共用）；测试 stream-decoder.test.ts、text-pipeline-v2.test.ts:18。
- 依赖：无（纯文本处理）。

## 4. 域内数据流

以一段 v2 LLM 原始输出为例（生产主路径，openai-compatible-generator.ts `attemptDslStreamV2` L1389+）：

1. **网络块 → 行**：`StreamLineDecoder.push(chunk)`（stream-decoder.ts:18）吐出完整行；生成器侧累积 `rawLines`（trim、非空、非围栏——与 `splitV2RawLines` compiler.ts:861 逐行等价）。
2. **行 → DslLineV2**：`parseDslV2Line(rawLine)`（line-parser.ts:273）逐行解析；语法错误抛 `DslProtocolError`（含 expected/cause/fix/legalValues 结构化细节，types.ts:372）。v1 路径对应 `parseDslLine` → `parseDslV1Line`（legacy-line-parser.ts:317），且在喂解析器前先过 `repairDslClosingLine`/`repairSwappedVisualSlots`（closing-repair.ts:43/116）的行级确定性修复（generator L975/983、尾部 flush L1188/1193）。
3. **行 → 组草稿（结构层）**：`createV2SegmentGate(options).pushLine(raw)`（compiler.ts:1222,1251）内部先做能力校验（`commandOfDslLineV2` + `capabilityAllowsCommand`，capabilities.ts:172/211），再 `DslSegmentParserV2.pushLine`（segment-validator.ts:213）跑哨兵/epilogue 状态机，非哨兵行转 `EventGroupBuilderV2.push`（group-builder.ts:222）累积 `V2StageOp`，直到主事件行（@say/@n/表单闭合/@beat）冲刷出 `EventGroupDraftV2`。
4. **组草稿 → 语义编译**：门内对每个 emitted 组立即 `compileEventGroupV2`（compiler.ts:557）：克隆双状态域 → 逐 op 校验（requireStageTarget/requireLook/validateCharacterText）并经 applyCue 归约（未知素材丢弃、零变化去重、@se 永不去重）→ @say 三重身份校验 + `resolveCharacterLabel` 名牌快照 → 原子提交 `CompiledEventGroupV2`（cue 归约 + labelOps + displayLabel 主事件）。
5. **组 → 运行时**：`V2GateCommit` 随 pushLine 返回值即时可见，生成器 `emitCommits` 转发 `options.onGroup(commit.group)`（generator L1433+），Game 侧以 `"labelOps" in group` 判别（game.ts:1344）后**只应用不编译**（cue 归约 + labelOps 折叠 + displayLabel 快照，game.ts:1269-1371）。
6. **段收束**：`gate.finish()`（compiler.ts:1340）做哨兵收束检查——complete 返回 SegmentEndStatus（ending 时含 `interpretEndingEpilogue` 解析的档位/结尾词，经 segment-validator.ts:89 在窗口内捕获）；incomplete 产 SENTINEL_MISSING 诊断。
7. **失败 → 修复**：任何失败（结构/能力/哨兵/组语义）封口，已提交前缀即修复边界；生成器对未提交尾部发起至多一次修复（`formatV2RepairInstruction` 产指令，capabilities.ts:222），修复文本经第二个 `createV2SegmentGate`（generator L1755）在已提交前缀预测状态上续编；批式等价物为 `compileSegmentV2WithRepair`（compiler.ts:1104，测试路径）。
8. **输出卫生（旁路）**：`narrationLabelLeaked`/`detectDialogueTailNarration`（line-parser.ts:173/187）在生成器侧对产出做泄漏计数（generator L1506-1508），剥离发生在 parseDslV2Line 的 @n 分支（stripNarrationLabel）。

v1 批式全链（测试/回退）：`parseDslSegmentText`（text-pipeline.ts:40）→ `parseDslLine` → `DslSegmentParser`（sink=EventGroupBuilder）→ EventGroupDraft → `compileEventGroups`（compiler.ts:339）→ CompiledEventGroup + tailState。

## 5. 跨域接口

**谁调用本域**（grep 全仓 `from "…gal-dsl…"`，生产非测试）：

| 调用方 | 导入内容 | 用途 |
|---|---|---|
| `src/adapters/llm/openai-compatible-generator.ts`（L20-66） | StreamLineDecoder；parseDslLine/parseDslV2Line/narrationLabelLeaked/detectDialogueTailNarration；DslSegmentParser/DslSegmentParserV2；createV2SegmentGate+V2GateCommit；dslTaskCapability/formatV2RepairInstruction+BaseDslTaskType；repairDslClosingLine/repairSwappedVisualSlots；DslProtocolError/formatDslErrorDetail + AnyStreamedGroup/CompiledEventGroupV2/DslDiagnosticV2/DslLine/DslLineV2/EventGroupDraft/SegmentEndReason/SegmentEndStatus | 本域唯一的生产组装点：v1 冻结流式路径 + v2 语义门流式路径 + 修复轮 |
| `src/runtime/dsl-group-compiler.ts`（L10-15） | compileEventGroup；AssetDiagnostic/DslInteractionDraft/EventGroupDraft | Game 侧 v1 组级物化（line_id 分配） |
| `src/game.ts`（L59-66） | AnyStreamedGroup/AssetDiagnostic/CompiledEventGroupV2/DslInteractionDraft/EventGroupDraft/SegmentEndStatus | 流式组应用（labelOps 判别 game.ts:1344） |
| `src/core/ports/story-generator-port.ts`（L15-19） | AnyStreamedGroup/EventGroupDraft | 生成器端口契约（onGroup 载荷） |
| `src/runtime/interaction-driver.ts`（L57-59）、`interaction-choice.ts`（L9）、`interaction-input.ts`（L10） | AnyStreamedGroup、DslInteractionDraft | 交互事件物化 |
| `src/runtime/segment-types.ts`（L6） | SegmentEndStatus | 段生命周期类型 |
| `src/runtime/metrics.ts`（L10） | AssetDiagnosticCode | 素材软诊断计数 |
| `src/story/types.ts`（L34-37） | AnyStreamedGroup、SegmentEndStatus | 故事层信封类型 |
| `src/application/prompts/protocol-card.ts`（L14-20） | dslTaskCapability/protocolRepairCapability + BaseDslTaskType/DslTaskCapability/DslV2Command | 协议卡注入提示词（capabilitySource 溯源字符串指向本域 capabilities.ts:306） |
| `src/config.ts`（L170-180, 513-515） | 无代码导入（注释引用 + zod `protocol_version` 缺省 2） | 版本路由开关 |

测试侧消费者另含：character-contract.test.ts、game-dsl.test.ts、game-input.test.ts、game-generation-identity.test.ts、game-test-kit.ts、llm.test.ts、prompts.test.ts、bootstrap/create-runtime-application.test.ts、core/ports/story-generator-port-port.test.ts、application/prompts/protocol-card.test.ts、application/world/dynamic-character-e2e.test.ts。

**本域依赖谁**（生产 import）：
- `../../presentation/types.js`：CharacterPosition、StageCue、VisualState、VisualStateReducer、CharacterPatchCue、CharacterPresentationState、CharacterRegistry（v1 素材注册表口径）；
- `../../presentation/equals.js`：visualStateEquals（冗余 cue 判定）；
- `../../presentation/defaults.js`：presentationDefaultsFor（v2 首触默认外观）；
- `../../assets/types.js`：AssetCatalog（素材语义校验）;
- `../../characters/types.js`：CharacterDefinition、CharacterRegistry（v2 roster 口径，compiler.ts:358-362 别名 RosterCharacterRegistry）、CharacterRuntimeState、CastContext、resolveCharacterLabel、validateCharacterText、withCharacterLabel。

## 6. 测试覆盖

| 测试文件（行数/it 数） | 覆盖的符号/行为 |
|---|---|
| compiler.test.ts（972/36） | compileEventGroup：对白解析（名牌覆盖/复位/首触初始化）、ch cue 顺序（§19）、compileEventGroups 尾态链式、sprite-set 绑定（§15）、素材语义校验（spec §7 各诊断码）、REDUNDANT_STAGE_CUE 冗余去重 |
| compiler-v2.test.ts（932/39） | compileSegmentV2（§4.2 状态表逐行、@say 身份校验不降级、原子性与预测状态隔离、cue 去重、任务能力校验）；compileEventGroupV2 单组入口；createV2SegmentGate（增量提交与批式 ok 路径逐字段等价、首个失败即停修复边界=已提交前缀、修复轮续接 lineOffset+前缀状态）；DslSegmentParserV2/EventGroupBuilderV2 由此全链路间接覆盖 |
| line-parser.test.ts（611/59） | parseDslLine（缺省 v1 路由）全语法表：哨兵、表单、废弃别名、@ch 两形态、全角冒号归一门卫、台词头 [ ]/( ) 槽、UNKNOWN_COMMAND；@ending 行形状；interpretEndingEpilogue token walk（档位/回声/截断） |
| line-parser-v2.test.ts（289/24） | parseDslV2Line §4.1 语法表、正文逐字保留（冒号/括号/类命令片段为普通文本）、结构化报错（MISSING_BODY/INVALID_CH_PARAMETER/UNKNOWN_COMMAND 等）、parseDslLine 版本路由（缺省 1、v2 不见 v1 语法）、输出卫生（stripNarrationLabel/narrationLabelLeaked/detectDialogueTailNarration） |
| text-pipeline-v2.test.ts（408/13） | compileSegmentV2 流式任意切块等价（CRLF/无尾换行/围栏）+ compileSegmentV2WithRepair（尾部切片、修复采纳/放弃、attempt:1、前缀续接）——**测的是 compiler.ts，不测 text-pipeline.ts** |
| text-pipeline.test.ts（171/7） | parseDslSegmentText：围栏剥离、空行/``` 行过滤、截断段 incomplete |
| group-builder.test.ts（271/17） | EventGroupBuilder（v1）：cue 累积/主事件冲刷、表单开闭与错误族、segment_end/ending_epilogue 误用报错、finish 终态语义 |
| segment-validator.test.ts（283/23） | DslSegmentParser（v1）：哨兵 nonce/reason/重复/非末行、表单未闭、ending epilogue 窗口（一行捕获/关窗丢弃/孤儿报错）——DslSegmentParserV2 无专属测试 |
| capabilities.test.ts（204/11） | dslTaskCapability 五张卡逐行（含 protocol_repair 拒绝单发）、protocolRepairCapability 继承、commandOfDslLineV2 全映射、formatV2RepairInstruction 模板（能力卡单源、legalValues 有界） |
| interaction-builder.test.ts（114/12） | InteractionBuilder：start/addOption/setInput/finish 全错误码 + 模式推导（choice/input/hybrid） |
| closing-repair.test.ts（88/4） | repairDslClosingLine 六类残缺变体 + 不误修判定；repairSwappedVisualSlots 三类写反 + 名牌槽保留 |
| stream-decoder.test.ts（70/10） | StreamLineDecoder：CRLF/空行/截断尾缓冲/flush/hasPending |

覆盖缺口（事实）：EventGroupBuilderV2 与 DslSegmentParserV2 无专属直接测试（仅经 compiler-v2 链路间接）；compileSegmentV2WithRepair 的生产等价物（生成器双门修复编排）无域内测试钉住；v1 filterInvalidCues 的链式中间状态行为仅 compiler.test.ts 覆盖。

## 7. 重构关注点

1. `src/core/protocol/gal-dsl/compiler.ts:269-351` 与 `:353-1381`——**两代编译器同居一文件**：v1 三函数（compileEventGroup/compileEventGroups，83 行）与 v2 全套（单组/段/修复/门，约 1030 行）用一条分隔注释（L353-355）切分；v2 段还在文件中部（L357-389）出现第二批 import。文件职责双倍，建议拆 v1-compiler / v2-compiler。
2. `src/core/protocol/gal-dsl/group-builder.ts:22-200` 与 `:214-384`——EventGroupBuilder 与 EventGroupBuilderV2 **结构性重复**：表单分支、FORM_ALREADY_OPEN/CONTENT_INSIDE_OPEN_FORM 错误文案、finish 语义逐字相同，仅 prelude 元素类型不同（泛型化空间明显）；segment-validator.ts 的 DslSegmentParser/DslSegmentParserV2 已用基类消重，group-builder 未跟进。
3. `src/core/protocol/gal-dsl/compiler.ts:188-263`（filterInvalidCues，v1）与 `:571-608`（applyCue 闭包，v2）——**素材校验+冗余去重逻辑双实现**：诊断码与丢弃规则相同，但 v1 是先收集后链式校验、v2 是逐 cue 即时归约；两处行为一致性无共享单源。
4. 生产 v2 路径只走 `createV2SegmentGate`（openai-compatible-generator.ts:1426,1755）；**批式入口 compileSegmentV2（compiler.ts:939）、compileSegmentV2WithRepair（compiler.ts:1104）、compileEventGroups（compiler.ts:339）、parseDslSegmentText（text-pipeline.ts:40）均无运行时调用方**——唯一域外消费者是 scripts/evaluate-character-dsl.ts:70-73 离线评估 harness（删除会破坏验收面板，见 12 域文档）。批式与门式刻意保持等价（compiler-v2.test.ts:704 等价性测试），但等价性靠测试维护而非代码共享（walkV2Lines 与 pushLine 各自实现同一管线）。
5. `src/core/protocol/gal-dsl/compiler.ts:23-28` 与 `:357-362`——**两个同名 CharacterRegistry**：v1 用 presentation/types.js 的（素材注册表），v2 用 characters/types.js 的并别名 RosterCharacterRegistry（roster）；同名不同物，跨文件阅读易混淆。
6. `src/core/protocol/gal-dsl/text-pipeline.ts:20-21`——死导入：`parseDslV2Line`、`DslSegmentParserV2` 导入后未使用（本文件只有 v1 批式入口）；`src/core/protocol/gal-dsl/line-parser.ts:53`——`parseDslLegacyLine` 别名**全仓零引用**。
7. `src/core/protocol/gal-dsl/types.ts:304-339` 与 `:482-489`——`DslErrorCode` 与 `DslSemanticDiagnosticCode` 语义码字面量重叠（UNKNOWN_CHARACTER_ID 等 7 个码在两个类型中重复声明，注释要求"一字不改"）。
8. `src/core/protocol/gal-dsl/compiler.ts:94-99`——v1 displayName 覆盖的汉字启发式（`/\p{Script=Han}/u` 判定非法 ASCII 覆盖名）是 v1 专属行为；v2 用 `validateCharacterText`（characters/types.js）做名牌校验，两套名牌合法性标准并存。
9. `src/core/protocol/gal-dsl/closing-repair.ts:4-10` 与 `legacy-line-parser.ts:53-59`——CHARACTER_POSITIONS 五位置词集合**重复定义**（line-parser.ts:104-110 还有第三份 V2_CHARACTER_POSITIONS）。
10. `src/core/protocol/gal-dsl/segment-validator.ts:114`——`this.sink.push(line as unknown as L)` 双重断言绕过泛型（类型系统未表达"实例 sink 与实例行版本恒一致"约束，注释 L113 自认）。
11. 测试文件命名错位：`text-pipeline-v2.test.ts` 不测 text-pipeline.ts，测的是 compiler.ts 的 v2 批式/修复入口（文件名会误导覆盖率归因）。
12. v1 冻结声明（legacy-line-parser.ts:4-11 文件头自述）："行为与 C4 之前逐字节一致、不许回头改"——这是代码自身的声明。该声明之下，v1 相关代码（legacy 解析器、compileEventGroup(V2 之外的 v1 路径)、closing-repair、group-builder v1 半边）整体退役或整体搬移是两种自洽路径；渐进改写会让「逐字节一致」失去可验证性。

## 附A · 设计评注（观察与可能方向，非约束）

1. **结构失败停流与修复轮的 abort 边界**（openai-compatible-generator.ts:1454-1462）：现状 `activeController` 走变量 + 修复前换新控制器（campus c41582e 注释："结构失败用它停流，语义门的修复调用前换新"）。设计评注：两类 abort 共用时，结构类错误（解析失败/能力越权）会失去那一次尾部修复——无论新实现里修复轮怎么组织，这个边界对应的效果值得有等价物。
2. **v2 双败分流**（openai-compatible-generator.ts:1773-1786）：修复后仍失败时，已有转发前缀（`allGroups.length > 0`）→ `fail` 交运行时修复链（玩家见半段+续修）；空 → `retry` 整体重试。这决定失败呈现形态。
3. **表单收尾的双层归属**（openai-compatible-generator.ts:1523-1540）：现状 parser 物化 `"@/?"`（空表单不补，交语义门修复）+ 语义门修复轮两处都能收尾。设计评注：单一职责可归一处；该代码紧邻 v1 自述冻结面与流式门控主路径，动手前值得想清楚。效果层面：玩家看到的永远是已闭合表单。
4. **`@ending` epilogue 现状**（game.ts:1437-1441 合成固定文本"故事到此结束。"；全仓无「剧终」UI 接线；generator :1454 endingSettled 后停止消费）：解析能力在、运行时消费缺——半截能力。迁移时"整体实现"与"整体裁掉"都通，随 TODO 引擎侧条目一起想。
