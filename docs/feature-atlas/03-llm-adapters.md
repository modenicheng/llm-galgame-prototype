# LLM 适配与生成管线域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：10 文件 / 3401 行（生产代码，不含测试；另有 `prompts/` 数据资产 5 文件 327 行，不计入代码行数）

## 1. 域职责与边界

本域是全部 LLM 调用的**唯一出口**：所有对模型端点的 HTTP 请求都发生在 `src/adapters/llm/` 与其提示词装载器 `src/prompts.ts` 中，域外代码只接触端口接口。

**模型端点**：OpenAI-compatible `chat.completions`（openai SDK `OpenAI` 客户端，`config.api.base_url` 可指向任意兼容网关，模型名 `config.api.model`）。两种调用形态：

- **流式**（`stream: true`，仅剧本生成）：`StoryGenerator.attemptDslStream`（v1）与 `attemptDslStreamV2`（v2），SSE 增量解码为行式 Gal DSL，边解析边转发可播放组；
- **非流式 JSON**（`response_format: {type: "json_object"}`，其余全部 adapter）：单次调用 + zod schema 硬校验。

请求参数在 adapter 内固定展开：`token_limit_field` 决定 `max_tokens` 或 `max_completion_tokens`；DeepSeek 类模型的 thinking 开关以 top-level 字段 `thinking: {type: "disabled"}` 强制关闭（4 处硬编码展开，见 §7）。

**实现的端口**（8 个）：

| 端口 | 定义位置 | 实现者 |
| --- | --- | --- |
| `StoryGeneratorPort` | `src/core/ports/story-generator-port.ts:138` | `GeneratorPortFacade`（内包装 `StoryGenerator`） |
| `AgentRunnerPort` | `src/core/ports/agent-runner-port.ts:25` | `AgentRunnerAdapter` |
| `ConfluenceJudgePort` | `src/core/ports/confluence-judge-port.ts:31` | `ConfluenceJudgeAdapter` |
| `MemoryConsolidatorPort` | `src/application/narrative/memory-consolidator.ts:123` | `NarrativeConsolidatorAdapter` |
| `OutlineWriterPort` + `OutlineMaintainerPort` | `src/application/outline/outline-writer.ts:109/118` | `OutlineWriterAdapter`（一类双端口） |
| `SceneMusicComposerPort` | `src/application/audio/scene-music-service.ts:62` | `SceneMusicComposerAdapter` |
| `CanonAdjudicatorPort` | `src/application/canon/canon-promoter.ts:30` | `CanonAdjudicatorAdapter` |

`ReviewAdapter` **不实现任何端口**，被 `src/entrypoints/web.ts:165` 直接实例化调用（见 §7）。

**流式管线与容错概览**（v1 与 v2 双轨）：

- 重试层 `requestDslEnvelope`：`config.generation.repair_attempts + 1` 次 attempt，每次失败把错误明细拼进下一轮 user prompt 作修复指令；attempt 结果三态 `complete / retry / fail`——已有转发前缀时 fail（运行时保留前缀修复），否则 retry。
- v1 `attemptDslStream`：冻结路径。坏行走 **strip-and-continue**（剔除该行 + assistant 前缀续写，同一 parser 实例贯穿，每 attempt 预算 1 次）+ 延迟裸 `@?` 合并 + 段尾 `@/?` 本地补齐 + 确定性 `@end` 哨兵本地补写（仅 finish_reason=stop 且单理由任务）。
- v2 `attemptDslStreamV2`：严格路径。`createV2SegmentGate` 逐组语义门控转发；首个失败后**恰好一次**非流式尾部修复（assistant 前缀 = 已提交前缀），双败走 v1 同款 fail/retry 语义。
- 其余 JSON adapter 容错策略不一致：consolidator/judge/review 抛错、canon-adjudicator 静默返回 `[]`、scene-music-composer 修复重试一次后返回 `null`。

**边界**：本域不做业务决策（canon 晋升裁决、汇流落边、记忆校验的领域规则在 application 层），只负责「组装提示词 → 调模型 → 结构校验 → 修复/重试 → 返回结构化结果」。DSL 语法/语义校验本体在 `src/core/protocol/gal-dsl/`（L0/L1），本域只编排。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 测试文件 |
| --- | --- | --- | --- | --- |
| `src/adapters/llm/openai-compatible-generator.ts` | 1927 | 剧本生成核心：流式 DSL 生成、双协议解码、修复链、重试策略、端口门面 | 4 | `src/llm.test.ts`（1861 行）、`src/adapters/llm/protocol-card-wiring.test.ts`、`src/core/ports/story-generator-port.test.ts`、`src/game-dsl-v2.test.ts`、`src/game-branch-selection.test.ts` |
| `src/adapters/llm/narrative-consolidator-adapter.ts` | 295 | 记忆整理：剧情事件 → episode/threadOps/setupOps/factOps/beliefOps/findings JSON | 1 | `narrative-consolidator-adapter.test.ts`（802 行） |
| `src/adapters/llm/outline-writer-adapter.ts` | 285 | 大纲写手：世界描述 → WorldDraft；后台维护 → OutlineOp[]（add/prune） | 1 | `outline-writer-adapter.test.ts`（173 行） |
| `src/adapters/llm/scene-music-composer-adapter.ts` | 189 | 作曲家 agent：场景 brief + 主题目录 → reuse/compose 决策 JSON（2 次尝试） | 1 | `scene-music-composer-adapter.test.ts`（203 行） |
| `src/adapters/llm/agent-runner-adapter.ts` | 107 | 通用工具循环：system+user+tools → 工具调用回喂 → 文本收束（步数上限 6） | 1 | `agent-runner-adapter.test.ts`（130 行） |
| `src/adapters/llm/canon-adjudicator-adapter.ts` | 132 | canon 裁决：候选事实 + 既有 canon → promote/exception ops（失败静默弃案） | 1 | 无直接测试 |
| `src/adapters/llm/confluence-judge-adapter.ts` | 133 | 汇流判定：两个状态快照 → {equivalent, confidence, rationale} | 1 | `confluence-judge-adapter.test.ts`（131 行） |
| `src/adapters/llm/review-adapter.ts` | 94 | 通关评注：末态 digest + 结局报告 + 大纲 → {comment, outlineFit} | 3 | 无直接测试（`src/review-flow.test.ts` 只测存储与喂回渲染） |
| `src/adapters/llm/music-composition-skill.ts` | 77 | 作曲领域知识常量（和声纪律 9 节，注入作曲家 system prompt） | 1 | 经 `scene-music-composer-adapter.test.ts:111` 间接钉死 |
| `src/prompts.ts` | 162 | 提示词装载：`prompts/` 目录 + per-game 覆盖 → PromptBundle + InstructionSet | 4 | `src/prompts.test.ts`（经 `checkInstructionTemplates` 双保险引用，见文件头注释 L95） |

数据资产 `prompts/`（5 文件，327 行）：

| 文件 | 行数 | 用途 |
| --- | --- | --- |
| `prompts/dsl-protocol.txt` | 181 | Gal DSL 输出协议**语法基座** system prompt（v1/v2 行头版本门、指令 vs 正文总规则）→ `PromptBundle.dslProtocol` |
| `prompts/instructions.yaml` | 102 | 第四层**任务模板**（opening/branch_prefetch/input_response/continuation/input_bridge/recovery），`{placeholder}` 由 `renderTemplate` 单遍替换；`ending` 键已删（C6 弃用警告） |
| `prompts/author.yaml` | 21 | 作者控制配置（world/characters/plot/endings/style 各自 preferred/free/locked + locked 规则），由 `loadAuthorConfig` 读取（装配点 `create-runtime-application.ts:361`） |
| `prompts/guideline.txt` | 14 | 文风纪律 14 条（简体中文、台词长度、不替玩家选择、禁 Markdown 等）→ `PromptBundle.guideline` |
| `prompts/characters.txt` | 9 | 静态 fallback 世界人物卡投影（派生产物，身份真源为根目录 `characters.yaml`；支持 per-game `world/prompts/characters.txt` 覆盖）→ `PromptBundle.characters` |

## 3. 函数级明细

### `src/adapters/llm/openai-compatible-generator.ts`（1927 行）

#### `generateNonce(): string` — `src/adapters/llm/openai-compatible-generator.ts:153-155`
- 用途：为本次生成请求生成 4 位十六进制 nonce，用于 DSL `@end <nonce> <reason>` 结束哨兵防伪（每次请求随机化，旧 attempt 的过期哨兵不可能满足本次校验）。
- 调用方：域内 `StoryGenerator.generateOpening/generateBranchPrefetch/generateInputResponse/generateInputBridge/generateContinuation`（5 个公开方法各自调用一次）；测试 `llm.test.ts:552`（describe `generateNonce`）。
- 依赖：无（`Math.random`）。

#### `GenerationStreamOptions`（interface） — `src/adapters/llm/openai-compatible-generator.ts:157-191`
- 用途：生成调用的流式回调与上下文选项：`onGroup`（组提交即转发，v1 为 `EventGroupDraft`、v2 为 `CompiledEventGroupV2`，联合类型 `AnyStreamedGroup`）、`onSegmentEnd`、`repairReason`（Game 级修复原因）、`tailVisualState`（DSL 续写起点视觉状态）、`briefing`（导演逐轮简报）、`identity`（C5 身份四件套：协议版本/roster revision/cast/characterState）。
- 调用方：`StoryGenerator` 全部公开方法签名、`GeneratorPortFacade` 5 个门面方法组装。
- 备注：`onGroup` 回调是「边流边播」的挂点——组一经转发不可收回，因此决定 fail（保留前缀）与 retry（整段重来）的分界。

#### `StoryGenerator`（class） — `src/adapters/llm/openai-compatible-generator.ts:284-1816`

构造器（L310-353）：`constructor(config, prompts, instructions, apiKey, authorConfig?, metrics?, catalog?, characterRegistry?)`。步骤：① `new OpenAI`（baseURL/timeout 来自 `config.api`，L320-324）；② `checkInstructionTemplates` 启动期模板变量检查（配置错误构造时炸，L329）；③ `buildSystemContext` 预渲染 system prompt（L330-332）；④ `toModelCatalog` 投影模型资产目录（L333）；⑤ registry 注入时派生 `v2Reduce`（`createVisualStateReducer` + `createPresentationDefaultsFromRoster`，与 Game 侧同构，L338-342）与 `knownSpeakers`（roster name + id 集合，L345-352）。

公开方法（5 个生成入口，模式一致：`generateNonce` → `buildDslCtx` → `taskInstructions`（协议卡 + `renderTemplate` 模板）→ `buildDslUserPrompt` → `requestDslEnvelope`）：

- `generateOpening(turn, state, signal?, options?)` L471-497：开场段；任务类型 `opening`，允许收束理由 `["buffer","interaction","ending"]`。
- `generateBranchPrefetch(turn, state, history, choice, option, signal?, options?)` L499-540：分支预取；理由仅 `["buffer"]`；envelope 返回后校验台词数 ≥ `config.prefetch.branch_dialogue_lines`，不足抛错（L529-539）。
- `generateInputResponse(turn, state, history, interaction, playerInput, signal?, options?)` L542-582：自由输入的 NPC 回应；玩家输入经 `playerInputDataBlock` 序列化为结构化 JSON 数据块（防伪指令注入，L555-560）；后校验台词数 ≥ 1（L573-581）。
- `generateInputBridge(turn, state, interaction, signal?, options?)` L589-616：输入确认后的转场旁白（独立预取任务）；理由 `["buffer"]`。
- `generateContinuation(turn, state, history, prefetchedEvents, signal?, options?)` L618-647：常规续写；预取事件经 `serializeHistory`（有 registry 走身份稳定 JSON，否则 legacy 渲染，L408-412）注入模板 `{prefetched}`。

私有方法：

- `makeCtx(state, recentEvents)` L360-373：组装 `ContextInput`（prompts/state/recentEvents/可选 registry/authorConfig），处理 `exactOptionalPropertyTypes`。
- `buildDslCtx(...)` L376-402：DSL 模式上下文（taskType/generationNonce/targetLines/tailVisualState/actorBriefing/modelAssetCatalog/identity）。
- `serializeHistory(events)` L408-412：身份稳定事件 JSON 与 legacy 渲染的分派。
- `protocolCardText(task, nonce, options?)` L420-455：按任务类型从能力表派生任务协议卡（`buildProtocolCard`）；identity 缺席时 cast 从 roster 派生全体 NPC 可发声（与 Game legacy 视图等价）；`bindProtocolCardNonce` 绑定 nonce。
- `taskInstructions(task, template, nonce, options?)` L461-469：协议卡拼在任务模板之前（同处易变尾部，不打断稳定前缀缓存）。
- `buildRepairInstruction(lastError, repairReason?)` L653-682：重试修复指令合成；措辞按路径分化——无 assistant 回放的 provider 内重试要求「重新完整输出」，Game 级修复（用户 prompt 已序列化失败前缀）要求「从失败位置继续」。

- `requestDslEnvelope(type, taskType, allowedReasons, nonce, userPrompt, signal?, options?)` L693-751：**重试策略层**。步骤：① `attempts = config.generation.repair_attempts + 1`（L703）；② 协议分派 `protocolV2 = options?.identity?.protocolVersion === 2`（L708），v2 但无 registry → 抛错拒绝静默降级 v1（L710-715）；③ 循环每个 attempt：abort 预检 → `buildRepairInstruction` 拼接修复指令（L722）→ 分派 `attemptDslStreamV2` / `attemptDslStream`（L724-744）；④ `complete` → 返回 envelope，`fail` → 抛出（保留前缀给运行时修复链），`retry` → `lastError = outcome.reason` 进入下一轮（L745-748）；⑤ 预算耗尽抛 `模型输出连续校验失败：${lastError}`（L750）。签名中 `type: LLMRequestCounts extends Record<infer K, number> ? K : never` 是从 `Metrics` 的请求计数表键派生请求类型标签的类型技巧。
- `attemptDslStream(...)` L765-1360：**v1 单次流式 attempt（冻结路径）**。步骤：
  1. 初始化计量与状态：`allGroups`、`rawLines`、`stripBudget = 1`、`pendingFormStart`（延迟裸 `@?`）、`endingSettled`、`finishReason`、`activeController` + 外层 signal 桥接（L776-809）；
  2. `createStream`：流式 `chat.completions.create`（`token_limit_field` 切 `max_tokens`/`max_completion_tokens`；top-level `thinking: disabled`），绑定 `activeController.signal`（L812-833）；
  3. `new DslSegmentParser`（v1 sink）+ `makeLineStream` 异步生成器：SSE chunk → `StreamLineDecoder.push` → 完整行；顺带捕获 `finish_reason`、首行耗时、字符数（L835-866）；
  4. `tryStripContinue`（闭包，L875-928）：错误码在 `STRIP_CONTINUE_CODES` 白名单且预算未耗 → 剔除坏行（连带 stale 延迟 `@?`，Stale-deferred fold），`rawLines` 回退到前缀边界，旧流 abort（finish_reason 作废），assistant 前缀 = 剔除后原文，换新 decoder/续写流；不满足返回 false 落回 `rejectLine`；
  5. `emit`（L930-935）：组入 `allGroups` 并逐个回调 `options.onGroup`；`rejectLine`（L945-958）：校验失败时按「有已转发组 → fail 保留前缀；无 → retry」生成 `failureReason`（FastAPI-style detail），abort 流；
  6. 跨流主循环 `outer: while(true)`（L962-1247）：围栏行跳过 → `repairDslClosingLine` / `repairSwappedVisualSlots`（`@` 行禁 swap）确定性修复 → `parseDslLine` → `DslProtocolError` 走 `tryStripContinue`/`rejectLine`（L985-998）；
  7. 裸 `@?` 延迟合并（L1004-1056）：空提示表单头等一行——下一行是旁白则合并为 `@? 提示`；双裸 `@?` 去重（第二个顶替第一个，第一个从 `rawLines` 删除）；空行不消耗延迟态；
  8. 段尾 interaction 哨兵前表单未闭合 → `parser.closeOpenInteraction()` 本地补 `@/?`（L1060-1070）；`pushLine` 抛 `FORM_ALREADY_OPEN` + 空提示 + 已开表单 → 该裸 `@?` 视为 `@/?` 收尾（野外观测行为，L1079-1105）；
  9. 组提交 `emit`；`parser.isEndingSettled()` → `endingSettled` 停读（结局后一切续写都是残留，L1113-1119）；
  10. 流结束尾行处理（L1122-1245）：`decoder.flush()` 取无换行尾行——延迟 `@?` 与旁白尾行合并；能干净解析才保留，否则丢弃残片（计 metrics）；流结束仍挂裸 `@?` → 构造 `EMPTY_FORM_PROMPT` 走剔除续写；
  11. 日志 `err=` 字段镜像跨 attempt 语义：本 attempt 成功时记录**上一** attempt 的失败（运维识别修复重试成功，L1249-1256）；usage 按 `streamChars/4` 估算 output token（input 恒 0，L1250）；
  12. 结果映射（L1262-1352）：`streamAborted` → fail/retry 二态；空输出（仅围栏不算）→ retry「模型返回空内容。」；`parser.finish()` complete → envelope + `onSegmentEnd`；
  13. 确定性补哨兵（L1303-1335）：`finish_reason === "stop"` + 单一 allowedReason + 无延迟 `@?` + 无打开表单 → 本地合成 `@end <nonce> <fixedReason>`（固定尾小任务漏写哨兵是纯形式缺失，campus 实测占写手失败 ~90%+）；截断（length）/多理由任务不补；
  14. 缺哨兵 → 有已转发组 fail（提示含正确哨兵格式）/ 无则 retry（L1340-1352）；
  15. catch：abort 错误透传，其余记 metrics 后抛出；finally 解绑外层 abort 监听（L1353-1359）。
- `attemptDslStreamV2(...)` L1379-1815：**v2 单次流式 attempt（严格路径）**。步骤：
  1. 前置守卫：registry/reduce 缺席或 identity 缺席 → 抛错（L1390-1399）；
  2. `gateBase` 组装 `createV2SegmentGate`（expectedNonce/task/registry/cast=identity.cast/reduce/visualState=tailVisualState/characterState/catalog，L1416-1426）；
  3. `emitCommits`（组提交即转发 + 资产诊断 metrics/告警，L1431-1440）与 `feedGate`（喂一行，失败记首个 `gateDiagnostic` 并 abort 停流，L1442-1451）；
  4. 流式请求（与 v1 同参数形状）+ `DslSegmentParserV2`（v2 sink）+ 单一 `StreamLineDecoder` 贯穿（无续写流，L1466-1571）；
  5. `consumeLine`（L1493-1541）：`parseDslV2Line` → 输出卫生观测计数（`narrationLabelLeaked` / `detectDialogueTailNarration`）→ interaction 哨兵前补 `@/?`（物化进规范文本 `canonical`）→ `pushLine` v2 sink → 返回 canonical 行；结构失败返回错误且**规范文本不被触碰**；
  6. 主循环（L1573-1606）：trim/围栏/空行过滤 → `consumeLine` 失败则坏行留在规范文本、诊断从 sink 错误携带（同码同文）→ `structuralFailure` 停流；成功则 canonical 逐行 `feedGate`；
  7. 尾行处理（L1610-1634）：能干净解析才保留，残片丢弃；门已失败不收尾；
  8. 确定性补哨兵（L1638-1661）：判据同 v1；合成行物化进 `rawLines` 并 `feedGate`；
  9. 修复阶段换新 `activeController`（L1679-1681）：失败停流的 abort 不得泄漏进修复调用（否则结构类错误永远拿不到尾部修复）；外层取消信号经 `onAbort` 桥接到新控制器；
  10. `requestTailRepair`（L1686-1728）：**非流式**一次修复调用——assistant 前缀 = `rawLines.slice(0, boundary)`（已提交前缀），空内容/异常/取消返回 null；
  11. 收束与修复（L1730-1776）：`gate.finish()` 检查哨兵收束；有 `gateDiagnostic` → `formatV2RepairInstruction`（能力卡单源）+ `requestTailRepair`；修复轮 `repairGate` 从 `gate.committedThroughLine` 边界继续（`lineOffset: boundary, attempt: "attempt:1"`），`pushText` 重放未提交尾部，修复轮的组同样通过即转发；
  12. 结果（L1778-1807）：成功 → envelope + `onSegmentEnd`；双败 → 有 `allGroups` fail（`DSL 流校验失败，已保留前面可播放的内容。`+detail）/ 无 retry。
- 调用方（`StoryGenerator` 整体）：`GeneratorPortFacade`（域内）；装配 `create-runtime-application.ts:420`。
- 依赖：`openai` SDK；`story/context-builder`（`buildSystemContext`/`buildDslUserPrompt`/序列化器）；`core/protocol/gal-dsl` 全家（`StreamLineDecoder`、line-parser、segment-validator、compiler、capabilities、closing-repair、types）；`core/presentation`（reducer/defaults/types）；`core/assets/catalog`；`application/prompts/template` + `protocol-card`；`runtime/metrics`；`prompts.ts` 类型。
- 备注：v1 路径注释明确「整体冻结（逐字节不变）」，v2 是演进线；两方法的流式脚手架（行生成器、finish_reason 捕获、补哨兵、控制器桥接）结构性重复（见 §7）。

#### `GeneratorPortFacade`（class，implements `StoryGeneratorPort`） — `src/adapters/llm/openai-compatible-generator.ts:1826-1927`
- 用途：把 `StoryGenerator` 的 promise + options API 适配为端口要求的 handle 形态（`createGenerationHandle(label, runner)`），5 个方法 `generateOpening`（L1829）/ `generateContinuation`（L1842）/ `generateBranchPrefetch`（L1865）/ `generateInputResponse`（L1886）/ `generateInputBridge`（L1907）各自解包 request 字段、透传 `onGroup`/`identity`/`briefing`/`tailVisualState`/`repairReason`（仅 continuation）到 options。
- 调用方：`Game`（`src/game.ts:615` 构造注入；`:831`/`:839` 调 generateOpening/generateContinuation）；`src/runtime/interaction-choice.ts`、`interaction-input.ts`、`interaction-driver.ts` 调分支/输入类方法。
- 依赖：`core/ports/story-generator-port`（`createGenerationHandle` + 请求类型）。
- 备注：5 个方法是同构的字段映射样板（options 条件展开重复 5 次，见 §7）；handle label 形如 `continuation:${turn}`、`branch:${option.id}`、`input:${interaction_id}`、`bridge:${interaction_id}`。

**内部辅助**（模块级非导出）：`TASK_TEMPLATE_VARIABLES`（L96-102，任务模板→已知变量表）；`TEMPLATE_KEY_VARIABLES`（L109-112，叠加 `recovery` 死键）；`checkInstructionTemplates`（L115-121，启动期模板变量检查）；`playerInputDataBlock`（L128-135，玩家输入 JSON 数据块）；`isAbortError`（L141-146）；`STRIP_CONTINUE_CODES`（L208-222，剔除续写错误码白名单，11 个码）；`buildStripContinueInstruction`（L229-250，续写指令合成）；`DslAttemptOutcome`（L261-264，attempt 三态类型）；`formatV2DiagnosticDetail`（L270-278，v2 诊断可读明细）。

### `src/adapters/llm/narrative-consolidator-adapter.ts`（295 行）

#### `NarrativeConsolidatorAdapter`（class，implements `MemoryConsolidatorPort`） — `src/adapters/llm/narrative-consolidator-adapter.ts:97-295`
- 构造器 L102-120：`opts: {apiKey, api, config, registry?, diagnostics?, client?}`；`opts.client` 可注入（测试）；缺省 `new OpenAI`（同域 8 处样板之一）；diagnostics 缺省 `silentDiagnosticSink`。
- `consolidate(request: ConsolidationRequest): Promise<ConsolidationResult>` L122-179：单次 JSON 调用（temperature 0.3）。步骤：① 证据投影三级回退——request.evidenceEvents（C8 请求携带）→ 自带 registry `projectMemoryEvidence` → undefined（legacy 渲染，L129-133）；② `buildUserMessage` 组装；③ 调用（`response_format: json_object`，L138-146）；④ `JSON.parse` 失败 → diagnostics.warn + throw（L150-159）；⑤ `RawConsolidatorJsonSchema.safeParse` 失败 → 同上（L161-168）；⑥ 直接投影返回（L170-178）。
- `buildUserMessage(request, evidence, identity)` L185-294（private）：分区渲染——剧情事件（身份稳定 JSONL / legacy）、当前剧情线/伏笔清单、权威角色 ID 段（identity 携带时：允许集合 = 证据登场 ∪ 场景名单，空集合渲染严格空指令；legacy 走 request.stateCharacters/stateLocation）、地点 ID 段（与校验权威同源渲染）、可引用 facts/beliefs 候选清单（M2 §6.2）、上次提案被拒的定向修复段（priorIssues）。
- 调用方：`create-runtime-application.ts:590` 构造 → `NarrativeDirectorService`（经 `MemoryConsolidatorPort` 调 `consolidate`）。
- 依赖：`core/narrative/memory-operation`（5 组 zod schema）、`story/context-builder`、`story/event-projection`、`core/ports/diagnostic-sink`。
- 备注：system prompt 为 28 行中文常量 `SYSTEM_PROMPT`（L40-68），约束 MA-B 扩展字段（factOps ≤3 条/批、findings ≤5 条/批等）；`factOps/beliefOps/findings` schema 带 `.default([])` 容错旧 prompt。

**内部辅助**：`SYSTEM_PROMPT`（L40-68）、`RawConsolidatorJson`（L74-81）、`RawConsolidatorJsonSchema`（L83-91）。

### `src/adapters/llm/outline-writer-adapter.ts`（285 行）

#### `OutlineWriterAdapter`（class，implements `OutlineWriterPort, OutlineMaintainerPort`） — `src/adapters/llm/outline-writer-adapter.ts:120-265`
- 构造器 L125-140：`{apiKey, api, diagnostics?, client?}` 样板同上。
- `writeOutline(request: OutlineWriterRequest): Promise<WorldDraft>` L142-184：单次 JSON 调用（temperature 0.7）。步骤：`buildUserMessage`（世界描述 + 可选故事主线种子）→ 调用 → JSON.parse/zod 双重校验（失败 diagnostics.warn + throw）→ `RawWorldDraftSchema` 结果直接投影为 `WorldDraft`。
- `buildUserMessage(request)` L186-193（private）：`===== 世界描述 =====` + 可选 `===== 故事主线种子 =====`。
- `maintainOutline(request: OutlineMaintenanceRequest): Promise<OutlineOp[]>` L207-264：后台大纲维护（temperature 0.4）。步骤：分区渲染当前大纲/最近剧情摘要/记忆摘要/canon（前 20 晋升事实 + 前 10 例外）/历史通关评注（最近 5 条，M5.5 喂回）→ 调用（system 为静态 `MAINTENANCE_SYSTEM_PROMPT` L200-205）→ `RawMaintenanceOpsSchema` 校验 → 产出仅 `add`（只允许 kind=act、status=planned）/`prune` 两型 OutlineOp。
- 调用方：`create-runtime-application.ts:503`（outline.maintainer）；`entrypoints/cli.ts:66`、`entrypoints/web.ts:74`（writer，世界引导流程）。
- 依赖：`application/outline/outline-writer`（类型 + `CharacterVoiceDesignSchema` 唯一真源）、`application/audio/performance-compiler`（词表常量单源）、`core/characters/types`、`core/outline/types`、`core/ports/outline-store-port`、zod。
- 备注：`RawWorldDraftSchema`（L72-119）以 5 个 `.refine` 钉死玩家契约（恰好 1 名 player、player 禁 voice、id 唯一）与大纲契约（≥2 act、1~2 ending、ending id 前缀 `ol_end_`）；system prompt（L38-51）内嵌 `VOICE_CONTRACT`（L31-36，词表从 performance-compiler 常量拼接防手抄漂移）；维护 schema 定义在类之后（L267-285）。

**内部辅助**：`VOICE_CONTRACT`（L31-36）、`SYSTEM_PROMPT`（L38-51）、`DraftCharacterSchema`（L53-62）、`RawOutlineNodeSchema`（L64-70）、`RawWorldDraftSchema`（L72-119）、`MAINTENANCE_SYSTEM_PROMPT`（static，L200-205）、`RawMaintenanceAddSchema`（L267-278）、`RawMaintenancePruneSchema`（L279-282）、`RawMaintenanceOpsSchema`（L283-285）。

### `src/adapters/llm/scene-music-composer-adapter.ts`（189 行）

#### `SceneMusicComposerAdapter`（class，implements `SceneMusicComposerPort`） — `src/adapters/llm/scene-music-composer-adapter.ts:65-189`
- 构造器 L70-89：timeout 放宽到 `Math.max(api.timeout_ms, 300_000)`（决策 + 大谱面 JSON 单次产出可达数分钟，用户明示放宽）。
- `decide(input: SceneMusicComposerDecisionInput): Promise<ComposerDecision | null>` L91-135：最多 2 次尝试。步骤：① `buildUserMessage`（brief + 主题目录）+ 会话历史映射为 messages（system + history + user）；② attempt 0 直接调用（temperature 0.8，`max_tokens: 16_000`，thinking disabled）；③ `parseDecision` 校验，失败则 attempt 1 携带 assistant 原始输出回放 + zod issue 修复指令重试；④ 双败 diagnostics.warn 后返回 `null`（服务层告警降级，不抛）。修复轮回放用局部变量 `lastRaw/lastIssues`（并发 decide 不串台，对抗性评审 P2，L98-100）。
- `parseDecision(raw)` L137-159（private）：正则截取首个 `{...}` 块（容错围栏/前后说明）→ `JSON.parse` → `ComposerDecisionSchema.safeParse`，issue 格式化为 `path: message` 串。
- `buildUserMessage(brief, catalog)` L161-188（private）：brief（sceneId/场景目标/mood 词表/intensity/note）+ 目录统计行（bpm/key（附音名）/mode/bars/循环秒/乐器/音符数，供变体对齐母题）。
- 调用方：`create-runtime-application.ts:542` → `SceneMusicService`（导演 directive 监听触发，绑定命中零 LLM）。
- 依赖：`shared/music/theme`（`ComposerDecisionSchema`）、`shared/music/score`（`MUSIC_INSTRUMENTS`/`MUSIC_MOODS`）、`music-composition-skill.ts`（`MUSIC_COMPOSITION_SKILL` 拼进 system 尾部）。
- 备注：system prompt（L38-60）内含完整 score 形状与「复用纪律」（同一地点/区域必 reuse、一局主题目标 5~15）；`theme.motifHint` 由服务层提取，模型写进 compose.theme 会被 schema 拒（防幻觉，测试 `scene-music-composer-adapter.test.ts:191`）。

**内部辅助**：`COMPOSER_SYSTEM_PROMPT`（L38-60）、`KEY_NAMES`（L63，主音半音数→音名）。

### `src/adapters/llm/agent-runner-adapter.ts`（107 行）

#### `AgentRunnerAdapter`（class，implements `AgentRunnerPort`） — `src/adapters/llm/agent-runner-adapter.ts:20-107`
- 构造器 L24-33：`{apiKey, api, client?}` 样板。
- `runLoop(request: {system, user, tools, executeTool}): Promise<{text}>` L35-80：最小工具循环。步骤：① 初始 messages = system + user；② 循环 `MAX_AGENT_TOOL_STEPS`（=6，`agent-runner-port.ts:39`）次 `complete`；③ 无 toolCall → 直接返回 text；④ 有 toolCall → `request.executeTool`（异常捕获为错误文本回喂，模型可自行调整）→ assistant(tool_calls) + tool 消息入栈继续；⑤ 步数耗尽 → `complete(messages, [])` 禁用工具强制文本收束（L78-79）。
- `complete(messages, tools)` L83-106（private）：单次非流式调用；tools 空数组时不传 `tools` 字段；取首个 function toolCall 或文本。
- 调用方：`application/director/director-service.ts:211` 与 `:418`（导演的两处 `runLoop`）。
- 依赖：`core/ports/agent-runner-port`（类型 + 步数上限常量）、openai SDK。
- 备注：文件头注释声明「与演员/编剧/汇流判定共用一个 client（反重复地图：LLM 调用不建第二套）」，但装配处（`create-runtime-application.ts:308`）未传 client，实际仍是独立实例（见 §7）。

### `src/adapters/llm/canon-adjudicator-adapter.ts`（132 行）

#### `CanonAdjudicatorAdapter`（class，implements `CanonAdjudicatorPort`） — `src/adapters/llm/canon-adjudicator-adapter.ts:49-132`
- 构造器 L54-69：样板。
- `adjudicateCanon(request: {candidates, existing}): Promise<CanonOp[]>` L71-131：单次 JSON 调用（temperature 0.2）。步骤：① 渲染既有 canon（晋升事实 + 例外）与候选事实（含佐证周目）；② 调用；③ JSON 失败或 schema 失败 → diagnostics.warn 后**返回 `[]`（全部候选放弃，宁缺毋滥）**，不抛；④ promote/exception 映射为 `CanonOp[]`。
- 调用方：`create-runtime-application.ts:346` → `CanonPromoter`（后台，周目完结/弃局后触发）。
- 依赖：`application/canon/canon-promoter`（类型）、`core/ports/canon-store-port`（`CanonOp`）、zod。
- 备注：本域唯一「失败静默弃案」策略（与 consolidator/judge/review 的抛错策略不一致，见 §7）；无直接测试文件。

**内部辅助**：`SYSTEM_PROMPT`（L18-25）、`AdjudicationSchema`（L27-47，promote/exceptions 均 `.default([])`）。

### `src/adapters/llm/confluence-judge-adapter.ts`（133 行）

#### `ConfluenceJudgeAdapter`（class，implements `ConfluenceJudgePort`） — `src/adapters/llm/confluence-judge-adapter.ts:46-106`
- 构造器 L51-66：样板。
- `judge(input: {endState, candidateEntry}): Promise<ConfluenceJudgment>` L68-105：单次 JSON 调用（temperature 0.2）。步骤：① 两个 `StateSnapshot` 经 `renderSnapshot` 渲染为文本 → 调用；② JSON/zod 双重校验失败 → diagnostics.warn + throw；③ 返回 `{...result.data, judgedBy: "llm:" + model}`。
- 调用方：`create-runtime-application.ts:320` → `DirectorService`（`confluenceEnabled` 门控；协调器经 `director.exposeConfluenceJudge()` 使用，bootstrap L566）。
- 依赖：`core/graph/types`（`StateSnapshot`）、`story/context-builder`（`serializeVisualContext`）、`story/state`（`summarizeState`）、`core/ports/confluence-judge-port`。
- 备注：文件头声明「调用方负责异步后台执行（实时性红线），本类不做重试/缓存」——本域唯一显式无容错 adapter。

**内部辅助**：`SYSTEM_PROMPT`（L26-34，语义等价判定准则）、`JudgmentOutputSchema`（L36-40）、`renderSnapshot(label, snapshot)`（L112-133，状态摘要 + 线索 digest 行 + 舞台演出次要依据）。

### `src/adapters/llm/review-adapter.ts`（94 行）

#### `ScreenwriterReviewRequest`（interface） — `src/adapters/llm/review-adapter.ts:12-19`
- 用途：评分请求输入（digestSummary / 可选 endingReport（伏笔回收率 + 线程计数）/ outlineActs）。

#### `ScreenwriterReview`（interface） — `src/adapters/llm/review-adapter.ts:21-26`
- 用途：评分输出（comment ≤200 字 / outlineFit ≤80 字）。

#### `ReviewAdapter`（class，无端口接口） — `src/adapters/llm/review-adapter.ts:33-94`
- 构造器 L38-53：样板（diagnostics 缺省 silent）。
- `reviewRun(request): Promise<ScreenwriterReview>` L55-93：单次 JSON 调用（temperature 0.6）。步骤：① 分区渲染（末态记忆摘要 / 结局报告 / 大纲 acts）；② 调用（system prompt 内联在 L72-75，非模块常量——本域唯一）；③ `ReviewSchema.parse(JSON.parse(raw))` 一步完成，异常 diagnostics.warn + throw。
- 调用方：`entrypoints/web.ts:165`——**请求时现场 `new ReviewAdapter(...)`**（通关回顾接口）。
- 依赖：仅 config/diagnostic-sink/zod/openai。
- 备注：无端口、无直接测试；`src/review-flow.test.ts` 只测 `ReviewStore` 与维护 prompt 的评注喂回渲染。

**内部辅助**：`ReviewSchema`（L28-31）。

### `src/adapters/llm/music-composition-skill.ts`（77 行）

#### `MUSIC_COMPOSITION_SKILL`（const string） — `src/adapters/llm/music-composition-skill.ts:11-77`
- 用途：作曲家 agent 的领域知识注入文本（9 节）：调内一致与和弦骨架、非和弦音纪律、跨轨碰撞禁令、声部写作、循环终止、调式色彩、主题动机（V2 Leitmotif）、配器与音域、风格语汇；每条规则带模型可自查判定标准与具体 MIDI 正反例。
- 调用方：`scene-music-composer-adapter.ts:60`（拼在 `COMPOSER_SYSTEM_PROMPT` 尾部）。
- 依赖：`shared/music/score` 的 `MUSIC_INSTRUMENTS`（乐器词表内插）。
- 备注：仓库 prompt 走 TS 字符串（无 fs 依赖）；针对 V1 试听违和问题（跨轨半音碰撞、非和弦音长鸣、声部交叠）优先硬约束。

### `src/prompts.ts`（162 行）

#### `PromptBundle`（interface） — `src/prompts.ts:10-24`
- 用途：静态文本提示词束：`characters` / 可选 `storyLine`（M3.7：只来自 per-game `world/prompts/story_line.txt`，全局文件已删除，缺失即大声报错）/ `guideline` / `dslProtocol`。
- 调用方：`StoryGenerator` 构造（经 `makeCtx` → `buildSystemContext`）；`context-builder` 等消费。

#### `InstructionSet`（interface） — `src/prompts.ts:38-63`
- 用途：第四层任务模板键集：`opening` / `branch_prefetch` / `input_response` / `continuation` / `input_bridge` / `recovery`。`recovery` 是**已声明的死键**（main 无收尾生成路径；保留是为与 campus 分支配置形状不分叉，注释 L49-61）。
- 调用方：`StoryGenerator`（`renderTemplate(this.instructions.*)`）；`checkInstructionTemplates`。

#### `LoadedPrompts`（interface） — `src/prompts.ts:92-95`
- 用途：`loadPrompts` 返回值（bundle + instructions）。

#### `loadPrompts(promptDir?, perGamePromptDir?): Promise<LoadedPrompts>` — `src/prompts.ts:103-162`
- 用途：装载全部提示词。步骤：① `readWithPerGameOverride`（内联函数 L109-124）：per-game 目录有该文件则优先，ENOENT 回退全局（仅 `characters.txt` 走此路径）；② `readPerGameStoryLine`（L126-139）：只读 per-game，缺失抛错无回退，未提供 perGamePromptDir → undefined；③ `Promise.all` 并行读 5 个文件（characters / storyLine / guideline / dslProtocol / instructions.yaml）；④ yaml `parse` → `warnDeprecatedInstructionsKeys`（`ending` 键弃用一次性警告）→ `InstructionSetSchema.parse` 硬校验。
- 调用方：`bootstrap/create-runtime-application.ts:416`（唯一生产调用点）。
- 依赖：`node:fs/promises`、`yaml`、`zod`。
- 备注：空文件即抛（`readRequiredFile` L26-32）；per-game 目录 = `games/<gameId>/world/prompts`。

**内部辅助**：`readRequiredFile`（L26-32，空文件报错）、`InstructionSetSchema`（L65-72，六键全部 `min(1)`）、`warnDeprecatedInstructionsKeys`（L80-86）。

## 4. 域内数据流（一次剧本生成调用）

以 `Game` 发起一次常规续写为例（v2 会话，全链路函数名）：

1. **请求发起**：`Game`（`src/game.ts:839`）持有 `GeneratorPortFacade`（bootstrap `create-runtime-application.ts:615` 注入），调 `generateContinuation(ContinuationRequest)` → 门面方法（`openai-compatible-generator.ts:1842`）把请求字段解包为 `GenerationStreamOptions`（onGroup/identity/briefing/tailVisualState/repairReason）并 `createGenerationHandle` 启动。
2. **提示词组装**（`StoryGenerator.generateContinuation` L618）：`generateNonce`（L153）出新 nonce → `buildDslCtx`（L376）组装 DSL 上下文（含 `tailVisualState`、`briefing`、`modelAssetCatalog`、`identity`）→ `taskInstructions`（L461）= `protocolCardText`（L420，按任务能力表 + roster 派生协议卡并 `bindProtocolCardNonce`）+ `renderTemplate(instructions.continuation, {nonce, target_lines, prefetched})`（prefetched 经 `serializeHistory` L408 身份稳定序列化）→ `buildDslUserPrompt`（story/context-builder）拼完整 user prompt。system prompt 为构造期预渲染（L330）。
3. **重试分派**（`requestDslEnvelope` L693）：`identity.protocolVersion === 2` → v2 路径；registry 缺席响亮拒绝。每 attempt 先 `buildRepairInstruction`（L653）拼接上一轮失败明细（首轮为空）。
4. **流式接收**（`attemptDslStreamV2` L1379）：OpenAI streaming create → lines 异步生成器（L1555-1571）逐 chunk 捕获 `finish_reason` 并 `StreamLineDecoder.push` 切行 → 主循环（L1573）`consumeLine`（L1493）：`parseDslV2Line` 结构校验 + v2 sink `pushLine` → canonical 行逐行 `feedGate`（L1442）喂 `createV2SegmentGate` 语义门。
5. **组提交与哨兵/结尾处理**：组一闭合 → `emitCommits`（L1431）→ `options.onGroup` 即时转发（运行时边流边播，已转发组永不重写）；`@ending` epilogue 窗口收齐即停读；流尾 `decoder.flush()` 残片能解析才保留；漏写哨兵时确定性本地补 `@end`（L1638-1661，仅 stop + 单理由任务）。
6. **修复与收束**：`gate.finish()` 哨兵收束检查（L1733-1740）；失败 → 换新控制器（L1679）→ `requestTailRepair`（L1686）一次非流式尾部修复（assistant 前缀 = 已提交前缀）→ `repairGate.pushText` 从 `committedThroughLine` 边界重放（L1755-1775）；双败 → 有已转发组 fail（前缀保留给 Game 修复链）/ 无则 retry 下一 attempt。
7. **返回**：`complete` 时 `requestDslEnvelope` 返回 `GenerationEnvelope {events: [], groups, segmentEnd}` + `onSegmentEnd(status)`；门面 handle resolve，`Game` 消费 groups 提交演出管线。

v1 会话差异：第 4-6 步换成 `attemptDslStream`（L765）——`DslSegmentParser` 逐行 push/emit、坏行 `tryStripContinue`（L875）剔除续写、`rejectLine`（L945）分界 fail/retry、`parser.finish()` 收束。

## 5. 跨域接口

**实现的端口**：见 §1 表格（`StoryGeneratorPort`、`AgentRunnerPort`、`ConfluenceJudgePort` 为 L1 core ports；`MemoryConsolidatorPort`、`OutlineWriterPort`/`OutlineMaintainerPort`、`SceneMusicComposerPort`、`CanonAdjudicatorPort` 为 L2 application 层定义的端口——端口定义位置本身分层不一，见 §7）。

**装配点**（L4 宿主与装配）：

- `src/bootstrap/create-runtime-application.ts`：`StoryGenerator`（:420）+ `GeneratorPortFacade`（:615）→ `Game`；`AgentRunnerAdapter`（:308）→ `DirectorService`；`ConfluenceJudgeAdapter`（:320，`confluenceEnabled` 门控）→ `DirectorService`；`CanonAdjudicatorAdapter`（:346）→ `CanonPromoter`；`OutlineWriterAdapter`（:503）→ outline maintainer；`SceneMusicComposerAdapter`（:542）→ `SceneMusicService`；`NarrativeConsolidatorAdapter`（:590）→ `NarrativeDirectorService`；`loadPrompts`（:416）。
- `src/entrypoints/cli.ts:66`、`src/entrypoints/web.ts:74`：`OutlineWriterAdapter` → 世界引导 writer。
- `src/entrypoints/web.ts:165`：`ReviewAdapter` 现场实例化调 `reviewRun`。

**上游调用方**（谁调本域）：`Game`（game.ts:831/839）；`src/runtime/interaction-choice.ts` / `interaction-input.ts` / `interaction-driver.ts`（分支预取/输入回应/输入桥接）；`application/director/director-service.ts:211/418`（runLoop 工具循环）；`NarrativeDirectorService`（consolidate）；`SceneMusicService.handleDirective`（decide）；`CanonPromoter`（adjudicateCanon）；图协调器经 `DirectorService.exposeConfluenceJudge()`（judge）。

**下游依赖**（本域依赖谁）：`core/protocol/gal-dsl`（StreamLineDecoder/line-parser/segment-validator/compiler/capabilities/closing-repair/types——DSL 校验与修复本体）；`core/presentation`（reducer/defaults）；`core/assets`（catalog）；`core/characters/types`；`core/narrative/memory-operation`（zod schemas）；`core/graph/types`；`core/outline/types`；`story/`（context-builder/event-projection/state/types）；`application/prompts`（template/protocol-card）；`application/audio/performance-compiler`（词表常量）；`shared/music`（score/theme）；`runtime/metrics`；`config.js`；外部 SDK：`openai`、`zod`、`yaml`。

**与叙事导演的关系**：`GenerationStreamOptions.briefing` 的产物来源在域外（`application/director/actor-briefing.ts` 的 `buildActorBriefing`，由 `Game` 在 game.ts:836/846 拼入请求）；`NarrativeDirectorPort` 不由本域实现（由 application 层 `NarrativeDirectorService` 实现，本域只提供其 `consolidator` 依赖）。

## 6. 测试覆盖

| 测试文件 | 行数 | 覆盖的符号/行为 |
| --- | --- | --- |
| `src/llm.test.ts` | 1861 | `StoryGenerator` 构造与 system prompt（:125-198）；context 序列化行为（:240-522，经 generator 测 context-builder 的身份稳定 JSONL / serializeVisualContext / buildDslUserPrompt）；`generateNonce`（:553）；v1 DSL 模式 22 例（:612-1163）：流式组转发/onSegmentEnd、缺 @end 修复、空 `@?` 修复、错 nonce 不修、坏行 retry、fail 保留前缀、表单提示拆行合并、strip-continue 全家（停笔@?/无关坏行/双裸@?去重/退役别名/首行裸@?整段重试/N1 空表单强闭/选项行紧邻/错哨兵/预算耗尽回退）、截断 fail、inputBridge、哨兵 autoclose 三例、协议卡等价（:1163）；v2 DSL 模式 8 例（:1380-1851）：逐组门控转发、组3语义失败只重写尾部、首行结构失败无前缀整段修复、外层取消拒绝修复、v2 sink+compiler 路由（labelOps）、v1 语法拒绝（不静默降级）、确定性 @/? 物化、恰好一次尾部修复、修复后仍败走失败路径、v2 哨兵 autoclose、v2 无 registry 响亮报错 |
| `src/adapters/llm/protocol-card-wiring.test.ts` | 208 | `protocolCardText`/`taskInstructions` 接线：v1/v2 协议卡注入与 nonce 绑定、`playerInputDataBlock` 结构化玩家输入、registry 缺席不注卡、协议卡唯一出现、模板未知变量构造即抛（:198） |
| `src/adapters/llm/narrative-consolidator-adapter.test.ts` | 802 | `consolidate`/`buildUserMessage`：请求形状、权威 ID 嵌入、合法 JSON 解析、非 JSON/缺字段抛错、空 ops 容错、MA-B 扩展容错；C8 请求携带身份视图 9 例（:411 起）：roster revision 渲染、严格空集合指令、同名双胞胎稳定 ID、evidenceEvents 渲染、C5 registry 回退、facts/beliefs 候选清单、空候选严格指令、priorIssues 定向修复、legacy 冻结渲染 |
| `src/adapters/llm/outline-writer-adapter.test.ts` | 173 | `writeOutline`：合法草案解析、未知键静默剥除、非 JSON/schema 拒绝抛错、M1 玩家契约（缺 control/零玩家/多玩家拒绝）、initialLabel 透传、voice 画像透传与非法值拒绝 |
| `src/adapters/llm/scene-music-composer-adapter.test.ts` | 203 | `decide`/`parseDecision`/`buildUserMessage`：reuse/compose 一次通过、skill 禁令注入、messages 组装（历史+brief+目录）、空目录必 compose、预算参数（16000/thinking disabled）、失败重试与双败 null、围栏 JSON 解析、motifHint 防幻觉拒绝 |
| `src/adapters/llm/agent-runner-adapter.test.ts` | 130 | `runLoop`/`complete`：工具循环两轮、步数上限强制收束、工具错误回喂 |
| `src/adapters/llm/confluence-judge-adapter.test.ts` | 131 | `judge`/`renderSnapshot`：双快照渲染进 user、judgedBy 模型名戳、坏 JSON/schema 抛错 |
| `src/core/ports/story-generator-port.test.ts` | — | 端口原语（`createGenerationHandle` 等，间接覆盖门面依赖） |
| `src/prompts.test.ts` | — | `loadPrompts`：无 per-game 目录时无 storyLine、story_line.txt 只读 per-game、缺失/空文件/缺必填键抛错、ending 键弃用诊断（C6）一次警告、真实 instructions.yaml 与 dsl-protocol.txt 分层钉死、任务模板 as-built 允许集合校准（input_bridge/input_response 的 v1 模板与 v2 能力卡等价） |
| 无直接测试 | — | `CanonAdjudicatorAdapter`、`ReviewAdapter`（`src/review-flow.test.ts` 只测 ReviewStore 与喂回渲染，不测 LLM 调用本体） |

## 7. 重构关注点

1. `src/adapters/llm/openai-compatible-generator.ts:812-828`、`:1466-1482`、`:1698-1717` —— 请求参数展开（`token_limit_field` 切换、`thinking: {type:"disabled"}` top-level hack）在 v1 流式/v2 流式/v2 修复三处逐字重复；`scene-music-composer-adapter.ts:117-123` 又是一份（thinking hack 第 4 处）。无共享的「构造 chat.completions 参数」函数。
2. 8 处相同的 `new OpenAI({apiKey, baseURL, timeout})` 构造样板：`openai-compatible-generator.ts:320-324`、`narrative-consolidator-adapter.ts:111-117`、`outline-writer-adapter.ts:131-137`、`scene-music-composer-adapter.ts:78-86`、`agent-runner-adapter.ts:25-31`、`canon-adjudicator-adapter.ts:60-66`、`confluence-judge-adapter.ts:57-63`、`review-adapter.ts:44-50`。`agent-runner-adapter.ts:1-5` 文件头声称「同一 client……不建第二套」，但装配层（`create-runtime-application.ts:308/320/346/503/542/590`）全部未传 `client`，实际每个 adapter 各持一个客户端实例——注释意图与现状不符。
3. JSON 调用样板（create → JSON.parse → zod safeParse → 失败告警）在 6 个文件重复且**失败策略不一致**：`narrative-consolidator-adapter.ts:150-168` 抛错；`canon-adjudicator-adapter.ts:107-125` 静默返回 `[]`；`scene-music-composer-adapter.ts:101-134` 重试一次后返回 `null`；`review-adapter.ts:83-92` 抛错；`confluence-judge-adapter.ts:88-102` 抛错；`outline-writer-adapter.ts:155-175` 抛错。策略本身可能各有理由，但无统一抽象，新增 adapter 只能再抄一份。
4. `openai-compatible-generator.ts:765-1360`（`attemptDslStream`，596 行）与 `:1379-1815`（`attemptDslStreamV2`，437 行）共享结构性脚手架——SSE 行生成器、finish_reason 捕获、abort 控制器桥接、哨兵 autoclose 判据、空输出 retry、fail/retry 分界——v1 有意冻结（L1362-1376 注释）导致两份并行演化；单文件 1927 行、单方法近 600 行。
5. `GeneratorPortFacade` 五个方法（`openai-compatible-generator.ts:1829-1926`）是同构字段映射样板：options 的条件展开（briefing/tailVisualState/repairReason）逐字重复 5 次，仅 label 与参数列表不同。
6. `review-adapter.ts:33` 无端口接口；`entrypoints/web.ts:165` 每次评分请求现场 `new ReviewAdapter(...)` 构造新实例（含新 OpenAI 客户端），与域内其余「装配期构造 + 端口注入」模式不一致。
7. 端口定义位置分层不一：`StoryGeneratorPort`/`AgentRunnerPort`/`ConfluenceJudgePort` 在 `core/ports/`，而 `MemoryConsolidatorPort`/`OutlineWriterPort`/`SceneMusicComposerPort`/`CanonAdjudicatorPort` 定义在 `application/` 各服务文件内（§1 表格）——同为「LLM adapter 实现的端口」却横跨 L1 与 L2 两层定义。
8. `src/prompts.ts:62`（`recovery` 键）与 `openai-compatible-generator.ts:109-112`（`TEMPLATE_KEY_VARIABLES` 含 recovery）：main 无收尾生成路径，`recovery` 是已声明的死键，靠 schema `min(1)` 启动校验 + 变量表钉住，注释自认「与已删除的 ending 键处置不对称，属有意决策」——重构接线或删除时需同步两处。
9. `openai-compatible-generator.ts:1250`、`:1664`：usage 统计按 `Math.ceil(streamChars / 4)` 估算 output token，`input` 恒为 0——metrics 层的 token 口径是估值而非真实 usage。
10. system prompt 管理双轨：剧本生成走数据资产（`prompts/dsl-protocol.txt` + 任务模板 yaml + 代码内协议卡），其余 5 个 adapter 的 system prompt 为各文件内长中文常量（`narrative-consolidator-adapter.ts:40-68`、`outline-writer-adapter.ts:38-51` 与 `:200-205`、`canon-adjudicator-adapter.ts:18-25`、`confluence-judge-adapter.ts:26-34`、`review-adapter.ts:72-75`（内联在方法体内））；提示词约束（字数上限、条数上限）与 zod schema 上限两处手工同步（如 consolidator summary ≤200 字 vs schema 无对应约束）。
