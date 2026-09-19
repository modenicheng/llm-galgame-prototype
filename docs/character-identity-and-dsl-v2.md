# 角色身份与 Gal DSL v2 运行规范（main 分支）

计划：`docs/superpowers/plans/2026-09-19-character-identity-dsl-dual-branch-repair.md`。
本文是 C1–C8/M1–M3 落地后 **main 分支实际生效**的运行规范：身份真源链、
DSL 双版本协议、音频身份、记忆水位、图快照 v4 与发布/回滚规则。描述的是
「代码现在是什么」，不是「希望是什么」；与计划条目的出入一律注明。

旧协议的完整语法参考仍是 `docs/llm-outputs-refactor.md`（已标注为 v1
legacy 冻结文档）；本文是现行规范。校园分支的同位文档为
`docs/character-identity-and-dsl-v2.md`（campus worktree，双方按各自
现实维护，共享条目以共享契约向量为准）。

## 1. 身份真源链（M1/C2/C7）

main 与校园的关键差异：**main 有两个 roster 来源**（静态 fallback 世界
与生成世界），都归一到同一 `CharacterRoster`（C2 schemaVersion 2）后
进入同一条注入链：

```text
静态 fallback：characters.yaml（根目录，唯一手写内容包）
  → loadCharacterPackRoster()（src/adapters/static/character-pack-loader.ts；
    revision 与文件声明不符大声报错）
生成世界：world/canon.json 的 DraftCharacter/CanonCharacter（带 control/initialLabel）
  → rosterFromCanonCharacters()（src/application/characters/world-roster.ts，
    scopeId = world:<gameId>，独立身份命名空间，不掺 fallback cast）
  → CharacterRoster（两路归一）
      → createCharacterRegistry(roster, assetCatalog)（src/core/characters/registry.ts）
      ├─ writer：协议卡示例人物 + 人物卡投影（world/prompts/characters.txt
      │   为派生产物，首行 derived-from: canon@<revision>；卡过期由 canon +
      │   voice-design 再生，身份从不依赖卡的存在）
      ├─ game：展示注册表 toCharacterRegistry(roster)（v1 编译边界，派生）
      ├─ audio：registry → voiceProfileId（characters.yaml / canon）⊕
      │   voice-design 注入（按 ID join）
      ├─ memory：consolidator 请求的身份视图（§6）
      └─ storage：图快照 v4 身份块 + roster blob（§7）
```

bootstrap（`src/bootstrap/create-runtime-application.ts`）**先构建
registry、后装配 generator/state/director/audio**；三处 roster cast 派生
（快照身份块 `momentIdentity`、生成身份 `generationIdentity`、导演场景
名单 `directorSceneCast`）收敛到 `game.ts` 私有助手 `rosterDefaultCast()`
同一权威，防漂移（V1/R09）。

- **只有一份人设**：静态世界人设全文与正式姓名只在 `characters.yaml`；
  生成世界在 canon。`assets/resources.yaml` 的 `characters` 表与
  `config.yaml` 的 `characters` 别名键都已移除，携带即显式报错
  （C7：src/config.ts、src/core/assets/catalog.ts）。
- **内容契约（用户裁定 2026-09-19）**：静态 fallback 世界玩家 = 无名实体
  （`id=player`、`initialLabel=你`、无正式姓名/立绘/音色）；林澈与苏遥
  均为 NPC，可正常发声。「模型不得替玩家生成台词/选择/确认对白」防线
  指向该无名实体（此裁定取代 M1 最初的「林澈=玩家」主解读）。
- **稳定 ID 不重编号**：`player`/`linche`/`suyao` 原样保留
  （`CHARACTER_ID_PATTERN`，区分大小写）；生成世界角色 ID 与 author 素材
  集可复用素材但同键直接报错（禁止 last-wins，M1 fail-before-write）。
- **创建前失败**：`WorldGenerator.generate` 在写任何正式世界文件之前完成
  全量校验（`WorldCharacterSetError` 结构化 issues：危险 ID/玩家数/
  动态-同键冲突/玩家音色等）；拒绝后 `games/<gameId>` 目录不存在。
- **缺资源不丢身份**：生成世界角色可无立绘（roster 不含 presentation，
  spriteBinding 留在 canon 元数据、装配期校验素材集存在）、无音色
  （voiceless 降级纯文本）；素材文件缺失是可诊断降级，不是身份丢失。

## 2. 五集合分离（§3.4，as implemented）

| 集合 | 真源 | 语义 |
| --- | --- | --- |
| `CharacterRoster.characters` | characters.yaml / canon | 全体注册角色（身份全集，含玩家） |
| `CastContext.allowedSpeakerIds` | `rosterDefaultCast()`：roster 全体 NPC（game.ts 同一权威） | 本请求**允许发声**的 NPC；v2 编译层 `PLAYER_SPEECH_FORBIDDEN`/`UNKNOWN_CHARACTER_ID` 强制 |
| `CastContext.sceneParticipantIds` | 同上（playerId + NPC） | 场景参与者；不从立绘推导 |
| `VisualState.characters` | 舞台 reducer（@ch 指令） | 台上立绘/位置/可见性；`@ch exit` 只清这里 |
| `StoryState.characters` | 事件 reconcile + 记忆整理 | **累计**人物状态；隐藏、离场都不清空 |

生成请求经 `GenerationIdentity`（C5）显式携带
`{protocolVersion, rosterRevision, cast, characterState}`——每一种生成
任务变体（opening/continuation/input_response/input_bridge/分支预取/
修复续写）都携带（game.ts `generationIdentity()`；legacy 会话
`legacyGenerationIdentity()` 显式记 `"legacy"`，不伪造 roster）。

名牌（label）运行时状态单独存放（`CharacterRuntimeState.labels`）：改名
（v1 `(名称)` 槽 / v2 `@name set`）与立绘互不影响；缺省名牌用
`initialLabel`。v1 静态无立绘角色不进展示注册表（身份仍在 roster）。

## 3. DSL 协议双版本（C4/C6）

### 3.1 版本旋钮

- 配置：`config.yaml` `dsl.protocol_version: 1 | 2`，**默认 1**（zod
  default，未翻默认值——V2 评估达标后才考虑改 2）。
- 每局/世界创建时固定版本与 roster revision；已有流中途不切换。
- 版本随请求显式携带（`DslParseOptions.protocolVersion` / 协议卡头
  「DSL 协议版本」行），**不逐行猜 v1/v2**。

### 3.2 v2 语法（line-parser.ts `parseDslV2Line` + `parseDslSegmentTextV2`
+ compiler.ts `compileSegmentV2`/`compileSegmentV2WithRepair`）

```text
@say <角色id> <单行台词正文>        # 机器身份只经 ASCII 角色 ID
@n <单行旁白正文>
@name <角色id> set <单行名牌文本>
@name <角色id> reset
@ch <角色id> show [look=<外观id>] [position=<位置>]
@ch <角色id> set look=<外观id> [position=<位置>]
@ch <角色id> set position=<位置>
@ch <角色id> hide | exit | reset
@bg <背景id> / @bgm <音乐id|stop> / @se <音效id> / @beat
@? <交互问句> / @+ <选项正文> / @= <输入提示> / @/?
@end <nonce> <buffer|interaction|ending>
@ending <TE|HE|NE|BE> <结尾标题>    # main 特有：协议卡（ending 任务）教授
```

与 v1 的本质差异：台词/旁白正文起点 = 固定数量 token 之后的剩余原文，
不再用 `:`、`[]`、`()` 识别角色或外观——正文里的冒号、括号、`$&` 都是
普通文本。语义诊断码（一字不改集）：`UNKNOWN_CHARACTER_ID`、
`PLAYER_SPEECH_FORBIDDEN`、`CHARACTER_NOT_ALLOWED`、`UNKNOWN_LOOK`、
`INVALID_CH_PARAMETER`、`INVALID_DISPLAY_LABEL`、
`CHARACTER_HAS_NO_PRESENTATION`。诊断带任务、attempt、行号与**有界**
合法值列表，绝不携带整套人物卡；不降级成旁白、不剥字符猜 ID。

能力按任务派生（capabilities.ts 单源 → protocol-card.ts 协议卡）：示例
人物与素材从实际 registry/资源目录选出，不硬编码内容包专名（C6 起共享
模板零专名，`prompts/dsl-protocol.txt` 为语法基座，任务级规则唯一来源
是协议卡）。

### 3.3 v1 legacy 冻结

- v1 解析器 `legacy-line-parser.ts` **冻结**：只服务显式 legacy 请求/
  存档（protocolVersion 1），行为与冻结前一致；新增语法一律写 v2。
- 旧裸写指令（`ch`/`bg`/`bgm`/`se`/`beat`/`?`/`+`/`=`/`/?` 不带 `@`）
  已**完全废弃**：命中即 `RETIRED_ALIAS` 响亮报错。
- R09 待消除缺陷快照：未注册说话人半角/全角冒号解析分歧
  （`PARSE_COLON_DIVERGENCE_CASE`，src/test-support/character-contract-cases.ts，
  双分支字节一致；character-contract.test.ts 以钉子数据为唯一事实源——
  V1/R09 接线）。它是待消除行为的钉子，不是未来兼容规范。

### 3.4 v2 当前接线范围（main 诚实边界）

`protocol_version: 2` 在 main 生效于**协议卡与身份上下文层**：

- 协议卡（每个生成请求把双版本语法卡拼在任务模板之前）、任务头与
  `GenerationIdentity` 携带版本（C5/C6）。
- **编译层全量闭环**：`compileSegmentV2`（解析→分组→能力→身份/资源
  语义→原子提交）与恰好一次尾部修复 `compileSegmentV2WithRepair` 在
  单测（compiler-v2/line-parser-v2/text-pipeline-v2/protocol-card 等）
  与离线评估 harness（`scripts/evaluate-character-dsl.ts`，V1 移植）全量
  回放。
- **流式生成循环仍按 v1 行解码**：main 尚未接入按版本路由的 v2 流式
  解码（校园侧后续 v2 接线落地的 `attemptDslStreamV2` 路径不在 main）。
  因此「打开 v2 严格生成」（§8）的前置在 main **未完成**——协议卡教 v2
  而解码走 v1 的组合不可上线。这是本规范最重要的诚实边界，翻默认值
  前必须先补齐该接线并跑在线评估。
- v2 语义门需要 roster registry：registry 缺席的窄测试/legacy 会话不得
  声明 v2。

## 4. 玩家边界

- 玩家是独立身份（`control: player`；静态世界 `player` 条目）：无音色、
  无立绘、不进入 legacy 说话人表。生成世界恰好一名玩家（outline writer
  zod 强制：零玩家/多玩家/玩家画像均拒绝）。
- 模型不替玩家作选择、不生成玩家确认对白（`PLAYER_SPEECH_FORBIDDEN`）；
  玩家话语由运行时创建（`player_dialogue` 事件，source=player）。
- 不允许未知说话人静默变成新角色：未知 ID 在编译层拒绝并给诊断，不猜、
  不归 narrator（注入缺陷 D2/D4 离线钉死：0 起被接受）。

## 5. 音频身份链（C7/M1）

```text
事件 characterId（稳定 ID）
  → AudioDescriptorFactory.resolveIdentity()
      ├─ 新事件：只认事件携带的 characterId；label = 名牌快照（严格事件
      │  读 displayLabel，v1 形状回退 speaker），仅用于展示/播报，不进
      │  speakerId、不进缓存键
      └─ 旧事件（缺 characterId）：走注入的 legacy 解析器（scoped、
         versioned）——唯一命中才归因；main 当前未装配（无宿主登记的
         legacy 映射）→ unresolved_speaker 显式降级，文字照播，不猜
  → registry.voiceProfileId → voices.yaml profile（local 绑定按注册表
     键直取 voice，dashscope 按 voice_id_env 读环境变量）
```

- 音色稳定律（R02）：同一 characterId 的事件无论名牌怎么改，voiceId/
  voiceRevision/model 不变；`speakerId` 恒为稳定 ID（wire v2 起收紧为
  CharacterId 格式，旧客户端收 4002 升级信号）。
- **voice-design 按 ID join + 冲突拒绝**（Ruling 12/R08）：设计画像瞄准
  roster 已绑定角色时，同 profile（`design:<id>`）无害 no-op；**不同
  profile → `VoiceDesignConflictError` 结构化报错**（携带 characterId/
  rosterProfileId/designProfileId，先于 provider 跳过，三 provider 都
  拒绝）——`src/application/audio/voice-design-views.ts`。
- 生成世界动态角色：canon roster 无绑定，`audioRosterFromViews()` 为其
  补注入的 `voiceProfileId`（重算 revision），工厂侧 registry 与
  writer/game 同源身份、仅绑定叠加。
- 缺音色合法：voiceless 降级为纯文本，不阻塞播放；非 mock provider 缺
  绑定 = `missing_provider_binding` 即时降级（不再静默落 mock 兜底）。

## 6. 记忆验证与水位（C8/M2/M3）

main 只有**导演泳道**（narrative director → episode/plot/facts/beliefs；
校园另有游戏泳道 `applyMemoryProposal`，main 无此路径——历史投影/状态
整理走确定性 reconcile，不经模型提案）。

- **请求侧身份接线（main 与校园的核心差异，C8）**：身份视图由**请求
  构造方** `MemoryConsolidator` 派生（constructor 注入 registry →
  `buildMemoryIdentityView` + `projectMemoryEvidence`），随
  `ConsolidationRequest.identity` / `evidenceEvents` 显式携带——校验用
  它放进请求的同一视图，与模型经 adapter 渲染被告知的权威同源；adapter
  只消费（旧式直连请求保持 C5 回退）。
- **§6.2 纪律**：拒绝必须显式可诊断（`IdentityValidationIssue`：
  UNKNOWN_CHARACTER_ID / EVIDENCE_OUT_OF_RANGE / KNOWLEDGE_NOT_SUPPORTED /
  INVALID_REFERENCE，带 path+value，结构化问题与 `[CODE]` 规则码分层）；
  episode 提案整案拒绝、一次定向修复、修复仍败降级；显示名标签一律
  UNKNOWN（同名绝不合并）；空允许集合严格为空。M2 扩展：fact amend /
  belief correct 引用权威（`citableFactIds`/`citableBeliefIds` 与请求
  渲染候选同源，超预算一起缩）、belief 获知按证据登场 ∪ 显式场景名单
  （`beliefs.request_max`，缺省 12）。
- **水位**（`src/core/narrative/memory-types.ts` +
  narrative-director-service.ts）：成功水位只在连续前沿上推进（缺口
  `consolidationFailedIntervals` 挡道停在缺口前）；尝试游标 = max(水位,
  max(失败区间 toSeq))。水位/失败区间随图快照 v4 的 `MemoryDigest`
  **必填**落盘（v3→v4 适配器补 `[]`），跨重启持久。播放关键路径不等待
  记忆提取（纯后台）。

## 7. 存档：图快照 v4 与身份升级（M3/F3 移植）

main 的持久化是**剧情图快照**（校园是 state.v2.json 信封——形态不同，
身份纪律同源）：

- **SNAPSHOT_VERSION = 4**：快照增 `SnapshotIdentityState`
  （`identitySchemaVersion`/`dslProtocolVersion`、`rosterScopeId`/
  `rosterRevision` 引用、`characterLabels`（危险键 preprocess 拒绝）、
  `cast`）。共享 roster blob 按 revision 落盘（`world/rosters/`，
  幂等不覆写）；快照/边只引用 `{scopeId, revision}`，不重复人设。
- **版本闸门**：v4 直过；**v3 走显式升级适配器**（纯函数
  `src/core/graph/snapshot-upcast.ts`）；**v1/v2 读取即拒**
  （`SnapshotVersionGateError`，不虚称兼容）；未来版本（>4）显式拒绝。
- **v3→v4 转换面**：visualState 角色键、digest beliefs 的 characterId、
  facts 的 scope.characters 走「roster 已验证 ID → 唯一 legacy alias
  （scope 必须一致）→ **整档拒绝**」优先级链；`SnapshotUpcastError`
  携带全部引用与说明。原载荷对象/文件字节不动。
- **⚠️ pre-M1 旧档诚实失败**：main 当前**没有宿主登记的
  `LegacyIdentityMapping`**（校园的 `CAMPUS_LEGACY_IDENTITY_MAPPING`
  是校园内容）；`GraphIdentityContext` 预留 `legacyMapping?` 注入位，
  未登记时协调器按**空 legacy 表**处理——一切旧名字按 unknown 只读回放
  或整档拒绝（不猜、不静默归因）。因此 pre-M1 世界（canon 无 control、
  registry 缺席）的旧 v3 图快照**不可恢复**，读取显式报错；在宿主登记
  映射之前这一行为是**有意的诚实失败**，不是缺陷。
- **旧边负载升级（migration-on-findings）**：恢复路径对旧边负载
  （speaker-only 对白）内存升级（`identity-upcaster.ts`，F3 移植），
  仅当出现 alias 升级或 unresolved 时在 `RestorePoint.migration` 携带
  报告；unresolved 台词原引用只读回放，Game 侧经 diagnostics.warn 透出。
- **回溯/分支隔离**：`startRestoredSegment` 按节点快照身份块还原
  `characterState.labels`（不读当前游标可变 labels）；恢复/回溯清空
  `branchCharacterStates`/`branchTailStates`（被弃分支的预测副本不跨
  周目泄漏）。
- **汇流版本闸门**：`EndStateKey` 携带 `dslProtocolVersion`/
  `rosterRevision`；候选过滤与 `applyConfluenceMatch` 互斥链内复核——
  不同身份契约绝不复用旧判定。
- **不可 upcast 的图**：恢复显式抛 `SnapshotUpcastError`（不是静默新局）；
  测试以字节指纹断言整目录只读未改写。

## 8. 发布与回滚（计划 §8 原文语义）

- 发布开关为服务端 `dsl.protocol_version: 1 | 2`；**新局默认值仅在 V2
  达标后改为 2**（当前默认 1）。
- 每局/世界创建时固定版本与 roster revision；切换开关只影响新请求所属
  的新版本会话，**不能在已有流中途切换**。
- 旧 reader 与新 writer 分离：回滚旧 runtime 时，v4 快照（版本高于旧
  程序支持）显式拒绝读取（版本闸门报错），旧档原文件仍可恢复。
- **F1/M1 入口未完成的分支不能打开 v2 严格生成**。main 的 M1 入口已完成
  （registry 装配先于演员），但 §3.4 的流式 v2 解码未接线——**main 当前
  不得宣称「只改提示词即可上线 v2」**；离线评估（§9）绿 ≠ 在线改善已
  证实（TBD-online 未采样）。

## 9. 验证命令

```bash
npm exec vitest -- run                    # 全量测试（0 红线）
npm run typecheck && npm run build        # 类型（node+web）+ 构建
npm exec tsx -- scripts/evaluate-character-dsl.ts            # 离线评估（只打印摘要）
npm exec tsx -- scripts/evaluate-character-dsl.ts --out <评估目录>  # 写报告（拒绝 sessions/games 路径）
# （npm exec 需要 `--` 分隔符，否则 --out 会被 npm 吃掉。）
```

离线评估（V1 移植自校园 branch-agnostic harness）：共享契约向量 6/6 绿
（R01/R02×2/R03/R09-pinned/MAIN-MEMORY）、main 固定场景 12/12 绿（v1+v2
双协议回放、投影、音频身份、名牌快照、文本保真）、注入缺陷检出 6/6 /
修复 6/6；确定性（同输入逐字节同输出，report.json 带 sha256）。在线腿
NOT_ENABLED（§10.1 采样设计已作 schema 存在）。
