# 角色·世界观·资产域

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：11 文件 / 2246 行（生产代码，不含测试）｜只读快照：D:/coding/lgp-main-atlas

## 1. 域职责与边界

本域回答三个问题：**有谁**（角色/身份）、**在哪个世界**（世界观与 canon）、**有什么素材**（资产目录）。

- **角色身份（v2 真源）**：身份真源是 `CharacterRoster`（`schemaVersion: 2`，不可变、版本化、带稳定 revision 摘要），来自两个入口——静态 fallback 世界 `characters.yaml` 内容包（`src/adapters/static/character-pack-loader.ts` 装载），或动态生成世界的 canon（`rosterFromCanonCharacters`）。注册表 `createCharacterRegistry` 做全量校验（唯一 ID、恰好一名玩家、look→spriteSet/variant 资源绑定、revision 完整性）后提供 `get/require` 查询。原则：**不从「有哪些立绘」推导「有哪些人」**——无立绘 NPC 合法。
- **v1 兼容边界**：`core/presentation/types.ts` 的 scriptName 展示注册表是冻结的 v1 边界；`core/assets/catalog.ts#toCharacterRegistry` 从 v2 roster 派生 v1 展示注册表（`game.ts:347` 消费）。`legacy-identity.ts` 只做旧 scriptName / 旧 TTS 键 → `CharacterId` 的作用域化（scopeId + schemaVersion 1）解析，结果四态（resolved/ambiguous/unknown/invalid），**新生成路径禁止调用**（文件头注释 L7-8）。
- **world-generator 生成什么**：用户文本 → OutlineWriter port（LLM 单次 JSON）产出 `WorldDraft` → 创建前校验（fail-before-write，任何正式世界文件落盘前）→ 依次落盘：初版大纲（outline revision 1）、`world/canon.json` 脚手架（角色携带 control/initialLabel 权威元信息）、`voice-design.json`（有音频画像的 NPC，按 ID join）、per-game prompts（`world/prompts/characters.txt` 派生人物卡 + `story_line.txt`）→ 返回 `{ gameId, draft }`。
- **canon-promoter 晋升什么**：后台管线（周目完结或弃局后 fire-and-forget）。收集全部已定格周目（完结取 ending 边 endState facts，弃局取 abandonedAt 决策入口快照）的 major 未废止 facts；同一内容（trim 全等）出现在 ≥2 个不同周目才成候选；候选交编剧裁决 port `adjudicateCanon`（promote / exception）；`applyPromotion` 落盘 canon 的 `promotedFacts`/`exceptions`。晋升不回改既有快照。
- **资产目录装载校验**：`loadAssetCatalog` 读 YAML（默认 `assets/resources.yaml`，snake_case）→ zod schema 校验 → 映射为 camelCase `AssetCatalog` → 启动校验（bgm 播放窗口合并后交叉校验、每条 `src` 文件存在、路径不得逃逸素材根）。C7 后目录**不承载角色身份**：YAML 顶层出现 `characters` 键直接报错。目录有三个投影：模型目录（`toModelCatalog`，只有 id+description 无路径）、公开 manifest（`buildPublicAssetManifest`，id→受控 URL）、v1 展示注册表（roster 派生）。

## 2. 模块清单

| 文件 | 行数 | 层 | 职责 | 导出符号数 | 测试文件 |
|---|---|---|---|---|---|
| src/core/characters/types.ts | 361 | L1 | 角色领域类型、纯校验（ID/姓名/名牌）、zod schema、名牌运行时状态 | 26 | types.test.ts |
| src/core/characters/registry.ts | 376 | L1 | roster 校验、稳定 revision（FNV-1a）、注册表构造与端口类型 | 8 | registry.test.ts |
| src/core/characters/legacy-identity.ts | 176 | L1 | 旧 scriptName/TTS 键 → CharacterId 的作用域化解析（兼容边界） | 8 | legacy-identity.test.ts |
| src/core/assets/types.ts | 112 | L1 | 资产目录类型与三个投影形状（模型/公开/resolver） | 13（含 3 个 re-export） | （随 catalog.test.ts） |
| src/core/assets/catalog.ts | 146 | L1 | 目录纯投影：模型目录、v1 展示注册表派生、resolver、立绘存在性 | 5 | catalog.test.ts |
| src/application/characters/world-roster.ts | 322 | L2 | world draft/canon ↔ C2 roster 互转与创建前校验 | 10 | world-roster.test.ts |
| src/application/canon/canon-promoter.ts | 165 | L2 | 跨周目 major facts 的 canon 晋升管线 | 4 | canon-promoter.test.ts |
| src/application/assets/asset-catalog-loader.ts | 259 | L2 | 资产目录 YAML 装载 + zod 校验 + 启动完整性校验 | 1 | asset-catalog-loader.test.ts |
| src/application/assets/asset-manifest.ts | 38 | L2 | id → 受控 URL 的公开 manifest 投影 | 1 | asset-manifest.test.ts |
| src/application/assets/asset-manifest.fixtures.ts | 30 | L2 | 测试用最小内存 AssetCatalog（fixture） | 1 | 供 asset-manifest.test.ts、hosts/local-web/local-web-host.test.ts |
| src/application/world/world-generator.ts | 261 | L2 | 世界生成编排：writer→校验→四类落盘→派生人物卡 | 9 | world-generator.test.ts、dynamic-character-e2e.test.ts |

合计 11 文件 / 2246 行 / 86 个导出符号。

数据资产（非 TS）：

| 资产 | 规模 | 内容 |
|---|---|---|
| characters.yaml | 78 行 | main 静态 fallback 世界名册（scopeId=main-fallback-world）：player（无名玩家，initialLabel=你）、linche（NPC，9 look + voiceProfileId=linche_main）、suyao（NPC，9 look + voiceProfileId=suyao_main）。revision 不手写，由加载器计算 |
| story-plan.yaml | 75 行 | 作者静态叙事骨架：threads 2 条（terminal_origin/suyao_identity）、setups 3 条（foreshadow/mystery_clue/object）、anchors 3 条（discover_terminal/doubt_suyao_identity/reveal_suyao_origin），prerequisites 互相引用。装载器在 src/adapters/static/story-plan-loader.ts（非本域） |
| assets/ 目录 | 2 层 | `assets/resources.yaml`（208 行目录清单：guidance + backgrounds 10 + bgm 3 + sound_effects 1 + sprite_sets 2×9 变体）；实体文件：backgrounds/*.jpg ×10、audio/bgm/*.mp3 ×3、audio/se/terminal_beep.ogg、audio/soundfonts/*（12 音色 json + LICENSE）、characters/linche/*.png ×9、characters/suyao/*.png ×9、ATTRIBUTION.md |

## 3. 函数级明细

### 3.1 src/core/characters/types.ts（361 行）

#### `CharacterId`（类型别名 = string） — `src/core/characters/types.ts:21`
- 用途：稳定角色 ID；区分大小写、入口统一校验、核心不自行小写化/截断。
- 调用方：全域广泛（game.ts、compiler.ts、outline-writer.ts、story-generator-port.ts 等）。

#### `CHARACTER_ID_PATTERN` — `src/core/characters/types.ts:24`
- 用途：ID 机器键正则 `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`。
- 调用方：域内 `isValidCharacterKey`；跨域 `src/shared/wire/schemas.ts`。

#### `DANGEROUS_ID_KEYS` — `src/core/characters/types.ts:27-31`
- 用途：对象原型危险键黑名单（`__proto__`/`prototype`/`constructor`）。
- 调用方：域内 isDangerousKey/safeRecord；跨域 `core/graph/types.ts`。

#### `CharacterControl`（"player" | "npc"） — `src/core/characters/types.ts:34`
- 用途：控制类型枚举。调用方：world-roster.ts、outline-writer.ts。

#### `isDangerousKey(key)` — `src/core/characters/types.ts:36-38`
- 用途：键是否命中危险键黑名单。调用方：registry.ts、world-roster.ts、core/graph/types.ts:62。

#### `isValidCharacterKey(key)` — `src/core/characters/types.ts:41-43`
- 用途：机器键校验（格式 + 危险键，ID 与 look 键共用）。调用方：registry.ts（L145/L179）、core/graph/types.ts:73。

#### `isValidCharacterId(id)` — `src/core/characters/types.ts:46-48`
- 用途：`isValidCharacterKey` 的语义化别名。调用方：legacy-identity.ts:132、world-roster.ts:99、adapters/storage/identity-upcaster.ts。

#### `CharacterIssueCode`（联合类型，16 个错误码） — `src/core/characters/types.ts:54-70`
- 用途：结构化校验问题命名错误码（invalid_schema_version … revision_mismatch）。调用方：registry.ts、world-roster.ts（借用 invalid_name/invalid_label）。

#### `CharacterValidationIssue` — `src/core/characters/types.ts:72-77`
- 用途：`{ code, path, message }` 定位式问题结构。调用方：registry.ts（issues 列表元素）。

#### `CharacterTextError` — `src/core/characters/types.ts:80-90`
- 用途：姓名/名牌文本非法错误（携带 code 与违规文本）。
- 调用方：仅域内——`assertLabelAssignable`（types.ts:322/330）抛出；Grep 未见任何域外导入。
- 备注：导出但生产代码无外部引用（测试 types.test.ts 除外）。

#### `CHARACTER_TEXT_MAX_CODE_POINTS`（=64） — `src/core/characters/types.ts:97`
- 用途：姓名/名牌码点上限常量。调用方：域内 validateCharacterText；无域外导入。

#### `validateCharacterText(text, code, path)` — `src/core/characters/types.ts:107-129`
- 用途：姓名/名牌纯校验：拒绝任何控制字符（含内部）+ trim 后 1–64 码点；返回 issue 或 null。
- 调用方：registry.ts:152/154、world-roster.ts:110/113、core/protocol/gal-dsl/compiler.ts:619。

#### `CharacterLabelSchema` — `src/core/characters/types.ts:145`
- 用途：名牌 zod schema（校验不转换，首尾空白合法）。
- 调用方：域内 CharacterDefinitionSchema/CharacterRuntimeStateSchema；跨域 core/graph/types.ts、shared/wire/schemas.ts、story/types.ts、adapters/llm/outline-writer-adapter.ts。

#### `CharacterNameSchema` — `src/core/characters/types.ts:147`
- 用途：正式姓名 zod schema（不作机器键）。调用方：仅域内 CharacterDefinitionSchema；无域外导入。

#### `CharacterIdSchema` — `src/core/characters/types.ts:150-157`
- 用途：稳定 ID zod schema（格式 + 危险键两道 refine）。
- 调用方：域内 CharacterDefinitionSchema:247/CharacterRosterSchema:290；跨域 story/types.ts、adapters/storage/identity-upcaster.ts。

#### `CharacterDefinition`（接口） — `src/core/characters/types.ts:163-181`
- 用途：角色条目字段。关键字段：`id`（稳定 ID）；`name`（可重复、非机器键）；`control`；`initialLabel`（初始名牌，可为「神秘女子」）；`persona`（持久人设，投影按知情权限裁剪）；`presentation?`（`defaultLook` ∈ looks、`defaultPosition` 五档站位、`looks: Record<look, {spriteSet, variant}>` 换装映射）；`voiceProfileId?`（音色绑定，无音色合法）。

#### `CharacterRoster`（接口） — `src/core/characters/types.ts:183-191`
- 用途：身份真源。字段：`schemaVersion: 2`、`scopeId`（内容包/世界，非 displayName）、`revision`（规范化投影稳定摘要，无时间戳/路径）、`playerId`、`characters`。

#### `CharacterRegistry`（接口，v2） — `src/core/characters/types.ts:193-197`
- 用途：`roster` 快照 + `get`/`require`。与 v1 `core/presentation/types.ts` 的同名接口构成双轨（见 §7-1）。

#### `CastContext`（接口） — `src/core/characters/types.ts:199-204`
- 用途：`allowedSpeakerIds`（本次允许发声 NPC）+ `sceneParticipantIds`（叙事参与者，允许电话/画外）。
- 调用方：application/prompts/protocol-card.ts、core/ports/story-generator-port.ts、core/protocol/gal-dsl/compiler.ts。

#### `CharacterDefinitionSchema` — `src/core/characters/types.ts:245-274`
- 用途：角色定义 zod schema；superRefine 校验 defaultLook ∈ looks；looks 用 `safeRecord`（危险键 preprocess + record 双保险，防 zod v4 record 静默丢弃 `__proto__` 数据键，L219-243）。
- 调用方：adapters/static/character-pack-loader.ts:20、adapters/storage/identity-upcaster.ts。

#### `CharacterRuntimeStateSchema` — `src/core/characters/types.ts:276-282`
- 用途：名牌运行时状态持久化 schema（labels 记录，safeRecord）。调用方：仅 types.test.ts（生产持久化走 game-graph-store 的 roster blob，非本 schema）。

#### `CharacterRosterSchema` — `src/core/characters/types.ts:285-301`
- 用途：roster blob 落盘/读回共用校验闸门；superRefine 校验 playerId ∈ characters。
- 调用方：adapters/storage/game-graph-store.ts:253/285（图快照内 roster 的解析）。

#### `CharacterRuntimeState`（接口） — `src/core/characters/types.ts:311-313`
- 用途：局内名牌状态 `{ labels: Record<CharacterId, string> }`；与 VisualState 分域（离场只清立绘不清名牌）。
- 调用方：game.ts、core/presentation/defaults.ts、core/protocol/gal-dsl/compiler.ts、core/ports/story-generator-port.ts、application/outline/outline-writer.ts。

#### `createCharacterRuntimeState()` — `src/core/characters/types.ts:316-318`
- 用途：创建空名牌状态；labels 为无原型对象。
- 调用方：game.ts:300；测试 llm.test.ts、protocol-card.test.ts、compiler-v2.test.ts、text-pipeline-v2.test.ts。

#### `withCharacterLabel(state, characterId, label)` — `src/core/characters/types.ts:335-349`
- 用途：纯函数，返回设置了新名牌的状态（先 `assertLabelAssignable` 再整体拷贝到无原型对象）。
- 调用方：game.ts:1290、core/protocol/gal-dsl/compiler.ts:630。

#### `resolveCharacterLabel(state, definition)` — `src/core/characters/types.ts:352-361`
- 用途：解析当前名牌：自有属性 → 覆盖 label；否则 initialLabel。
- 调用方：core/presentation/defaults.ts:94、game.ts（注释 L161 描述回落语义）、compiler.ts。

内部辅助：`CONTROL_CHARACTER_PATTERN`（L96 控制字符正则）、`countCodePoints`（L99-101 码点计数）、`characterTextSchema`（L132-142 共用文本 schema）、`CharacterLookSchema`（L210-213）、`safeRecordKey`（L215-217 安全记录键 schema）、`safeRecord`（L226-243 原型链安全 record 构造器）、`assertLabelAssignable`（L320-332 名牌写入守卫，抛 CharacterTextError）。

### 3.2 src/core/characters/registry.ts（376 行）

#### `CharacterRosterError` — `src/core/characters/registry.ts:30-42`
- 用途：roster 校验失败错误，issues 携带全部结构化问题。
- 调用方（抛出/捕获）：域内 buildCharacterRoster:325、createCharacterRegistry:343；域外仅 registry.test.ts。生产代码无域外 import。

#### `UnknownCharacterError` — `src/core/characters/registry.ts:45-55`
- 用途：`require` 未注册 ID 错误（不许静默新建身份）。域内 require:358 抛出；域外仅测试引用。

#### `computeRosterRevision(draft)` — `src/core/characters/registry.ts:129-135`
- 用途：稳定 revision：`v2-` + 正/反两个 FNV-1a 32 位十六进制摘要拼接（双通道降碰撞）。
- 关键步骤：① `canonicalRoster` 规范化投影（角色按规范化串排序、looks 排序、固定键序）；② 正串 `fnv1a32(canonical, 0x811c9dc5)`；③ 反串 `fnv1a32(reversed, 0x9dc5811c)`；④ `hex32` 拼接。
- 调用方：域内 validateCharacterRoster:307、buildCharacterRoster:326；域外仅测试。

#### `validateCharacterRoster(roster, assets)` — `src/core/characters/registry.ts:298-315`
- 用途：全量校验 = `validateRosterShape` + `validateAssetBindings` + revision 摘要一致性；返回 issues 列表。
- 调用方：createCharacterRegistry:342（生产唯一入口）；测试 registry.test.ts:140。

#### `buildCharacterRoster(draft)` — `src/core/characters/registry.ts:321-327`
- 用途：构造合法 roster：结构校验通过后填入 `computeRosterRevision`；失败抛 `CharacterRosterError`。
- 调用方：adapters/static/character-pack-loader.ts:74、bootstrap/create-runtime-application.ts:467、world-roster.ts:302、character-contract.test.ts 等大量测试。

#### `createCharacterRegistry(roster, assets)` — `src/core/characters/registry.ts:338-363`
- 用途：从 roster + 素材目录构造注册表：先 `validateCharacterRoster` 全量校验，再建 Map 索引，返回 `{ roster, get, require }`。
- 调用方：bootstrap/create-runtime-application.ts:390/408/462/466（三种装配路径 + 音频 roster）、character-contract.test.ts、game-*.test.ts、audio-integrator/descriptor-factory/protocol-card-wiring 等测试。

#### `CharacterRegistryMode`（"legacy" | "roster"） — `src/core/characters/registry.ts:366`
- 用途：registry 获取方式标记。域外无导入（被 CharacterRegistryProvider.mode 引用）。

#### `CharacterRegistryProvider`（接口） — `src/core/characters/registry.ts:372-376`
- 用途：bootstrap 接线端口：`mode` + `registry`（legacy 模式为 undefined）。
- 调用方：bootstrap/create-runtime-application.ts:383、application/runtime-application.ts。

内部辅助：`fnv1a32`（L65-72）、`hex32`（L74-76）、`canonicalCharacter`（L79-110 单角色规范化投影）、`canonicalRoster`（L113-123）、`characterIssues`（L141-196 单角色结构校验）、`validateRosterShape`（L199-263 roster 级：schemaVersion/scopeId/重复 ID/玩家数/playerId 一致性）、`validateAssetBindings`（L266-292 looks→spriteSet/variant 存在性，经 `hasSpriteVariant`）。

### 3.3 src/core/characters/legacy-identity.ts（176 行）

#### `LegacyIdentityScope` — `src/core/characters/legacy-identity.ts:14-17`
- 用途：兼容映射作用域 `{ scopeId, schemaVersion: 1 }`（固定 1，不与 roster v2 混用）。

#### `LegacyScriptNameBinding` — `src/core/characters/legacy-identity.ts:19-23`
- 用途：旧台词行头名字 → CharacterId 绑定。

#### `LegacyTtsKeyBinding` — `src/core/characters/legacy-identity.ts:25-29`
- 用途：旧 TTS 配置键 → CharacterId 绑定（键空间与资产 id 不同源，如 xuwanqing ≠ female_A）。

#### `LegacyIdentityMapping` — `src/core/characters/legacy-identity.ts:31-35`
- 用途：scope + scriptNames + 可选 ttsKeys 的映射表。
- 调用方：adapters/storage/identity-upcaster.ts、core/graph/snapshot-upcast.ts、core/ports/identity-snapshot-port.ts、adapters/storage/game-graph-store(.test).ts。

#### `LegacyIdentityVia`（"scriptName" | "ttsKey"） — `src/core/characters/legacy-identity.ts:37`

#### `LegacyIdentityResolution`（四态联合） — `src/core/characters/legacy-identity.ts:44-73`
- 用途：resolved / ambiguous（同名多候选，不许任选）/ unknown（不猜姓名）/ invalid（绑定指向非法 ID）；每态携带 scopeId 与 via。

#### `LegacyIdentityResolver`（接口） — `src/core/characters/legacy-identity.ts:75-79`
- 用途：`resolveScriptName` / `resolveTtsKey` 两个解析入口。
- 调用方：application/audio/audio-descriptor-factory.ts:38/68（可选 `legacyResolver` 参数，L318 调 `resolveScriptName`）。

#### `createLegacyIdentityResolver(mapping)` — `src/core/characters/legacy-identity.ts:148-176`
- 用途：构造作用域内解析器；同名→同 ID 去重，同名→多 ID 解析时报 ambiguous。
- 关键步骤：① 对 scriptNames 建 `key → Set<CharacterId>` 表；② 对 ttsKeys 同样建表；③ 每次解析走 `resolveFromTable`（查表 → 候选排序 → 0 个 unknown / >1 个 ambiguous / 唯一候选再验 `isValidCharacterId` 不通过则 invalid）。
- 调用方：adapters/storage/identity-upcaster.ts:35、core/graph/snapshot-upcast.ts:20、测试（legacy-identity.test.ts、audio-descriptor-factory.test.ts、snapshot-upcast.test.ts、game-graph-store.test.ts）。
- 备注：bootstrap/create-runtime-application.ts:514-515 注释「legacyMapping 由宿主显式登记（当前无来源）」——生产装配当前没有任何来源构造映射。

内部辅助：`LegacyBindingTable`（L81-85 表形状）、`buildTable`（L87-101）、`resolveFromTable`（L103-142 四态判定）。

### 3.4 src/application/characters/world-roster.ts（322 行）

#### `WorldCharacterIssueCode`（联合，11 个错误码） — `src/application/characters/world-roster.ts:43-54`

#### `WorldCharacterIssue` — `src/application/characters/world-roster.ts:56-61`
- 用途：`{ code, path, message }`（与 core 的 CharacterValidationIssue 平行的世界侧问题结构）。

#### `WorldCharacterSetError` — `src/application/characters/world-roster.ts:64-76`
- 用途：世界角色集校验失败错误（携带 context 与 issues）。
- 调用方：world-generator.ts:201（generate 抛出）；域内 assertValidOrThrow/rosterFromCanonCharacters。

#### `WorldCharacterLike`（接口） — `src/application/characters/world-roster.ts:83-94`
- 用途：DraftCharacter 与 CanonCharacter 的公共超集形状（id/name/description/control?/initialLabel?/spriteBinding?/voice?）。域外无导入。

#### `validateWorldCharacters(input)` — `src/application/characters/world-roster.ts:135-222`
- 用途：世界角色集创建前/装配期共用校验，返回 issues。
- 关键步骤：① 逐角色 `idIssues`（ID 合法性/危险键、name、initialLabel）；② 重复 ID 计数；③ control 必填且 ∈ {player,npc}（missing_control/invalid_control）；④ 玩家角色带 voice → `player_voice_design`；⑤ `assets` 提供时 spriteBinding 指向的 sprite set 必须存在（引用 author 素材合法）；⑥ 全局恰好一名玩家（player_count）；⑦ `authorCharacterIds` 提供时动态角色与其同键 → `dynamic_author_conflict`（禁止 last-wins）。
- 调用方：world-generator.ts:192；域内 canonCharactersFromDraft（经 assertValidOrThrow:229）与 rosterFromCanonCharacters:285；测试 world-roster.test.ts。
- 备注：入参 `source: "draft" | "canon"`（L138）在函数体 L142-221 中从未被读取。

#### `canonCharactersFromDraft(draft, options?)` — `src/application/characters/world-roster.ts:245-260`
- 用途：world draft 角色 → canon 角色落盘形状；control 必写、initialLabel 缺省回落 name；内部经 `assertValidOrThrow` 再校验一次；**voice 字段在此被丢弃**（音频画像走 VoiceDesignStore）。
- 调用方：world-generator.ts:214。

#### `isRosterCapableCanon(canon)` — `src/application/characters/world-roster.ts:270-272`
- 用途：canon 是否携带 M1 元信息（任一角色有 control）——v2 世界判定；旧世界由调用方走 legacy 边界。
- 调用方：world-generator.ts:127、bootstrap/create-runtime-application.ts:384、game-graph-store.test.ts。

#### `rosterFromCanonCharacters(input)` — `src/application/characters/world-roster.ts:280-308`
- 用途：从当前游戏 canon 构建 roster（生成世界 registry 真源）。
- 关键步骤：① `validateWorldCharacters(source: "canon")`，失败抛 `WorldCharacterSetError`；② 逐角色映射为 CharacterDefinition（`persona = description`、`initialLabel ?? name`、`control ?? "npc"`，presentation 不进 roster——动态角色可无立绘）；③ 取玩家列表 `players[0]?.id ?? ""` 作 playerId；④ `buildCharacterRoster` 填 revision。
- 调用方：bootstrap/create-runtime-application.ts:385、application/audio/voice-design-views.ts、character-contract.test.ts、world-generator.test.ts、dynamic-character-e2e.test.ts。

#### `rosterCharacterIds(roster)` — `src/application/characters/world-roster.ts:311-313`
- 用途：roster 已知 ID 集（注释称供 reconcile 幻影过滤与导演 cast 使用）。
- 调用方：**仅测试**（world-roster.test.ts、dynamic-character-e2e.test.ts）；生产无调用点。

#### `canonRosterRevision(input)` — `src/application/characters/world-roster.ts:316-322`
- 用途：canon roster 的稳定 revision（= `rosterFromCanonCharacters(input).revision`），派生人物卡来源指纹。
- 调用方：world-generator.ts:130（ensureDerivedCharacterCard）。

内部辅助：`idIssues`（L96-121 单角色 ID/姓名/名牌校验）、`assertValidOrThrow`（L224-238 校验失败转异常）。

### 3.5 src/application/canon/canon-promoter.ts（165 行）

#### `CanonCandidate`（接口） — `src/application/canon/canon-promoter.ts:22-27`
- 用途：送裁决候选 `{ id, content, evidenceRuns(≥2) }`。调用方：adapters/llm/canon-adjudicator-adapter.ts。

#### `CanonAdjudicatorPort`（接口） — `src/application/canon/canon-promoter.ts:30-38`
- 用途：编剧裁决 port：`adjudicateCanon({candidates, existing}) → CanonOp[]`（单次 JSON，与 writeOutline/maintainOutline 同族）。
- 调用方：实现于 adapters/llm/canon-adjudicator-adapter.ts；注入于 bootstrap:341。

#### `CanonPromotionResult`（接口） — `src/application/canon/canon-promoter.ts:40-47`
- 用途：`{ settledRuns, candidates, promoted, exceptions }`。域外无导入（bootstrap 经 promoteFromRuns 返回值消费）。

#### `CanonPromoter`（类） — `src/application/canon/canon-promoter.ts:49-165`
- 用途：后台串行晋升管线；依赖注入 graph/canon/adjudicator/diagnostics(缺省 silent)。
- `promoteFromRuns()`（L72-83）：在途去重（`this.running` 非空直接复用同一 Promise，不并发写 canon）；异常仅 `diagnostics.warn` 并返回零值结果——晋升失败绝不阻塞游玩。
- `promoteUnsafe()`（L85-164）关键步骤：
  1. `canon.load()` 取当前快照（已晋升内容 + 例外，用于幂等跳过）；
  2. `graph.listRuns()` + `graph.listEdges()` 全量扫描：完结周目从 ending 边取 `endState.memoryDigest.facts`，弃局周目逐个 `graph.getDecision(abandonedAt)` 取入口快照 facts，活跃周目跳过；
  3. 分组：仅 `importance === "major"` 且未 `superseded` 的 facts，按 `content.trim()` 全等聚合到 `runsByContent`；已在 canon/例外中的内容跳过；`runIds.size ≥ 2` 才成候选；
  4. `adjudicator.adjudicateCanon`（单次 JSON，携带 existing promotedFacts/exceptions）；
  5. `canon.applyPromotion(ops, reason)` 整批落盘；按 op.type 统计 promote/exception 数返回。
- 调用方：bootstrap/create-runtime-application.ts（L331-346 buildCanonPromoter 构造、L558 装配、L650 `session_ended` 后与 L690 restart 弃局后 `void canonPromoter.promoteFromRuns()` fire-and-forget）。
- 依赖：core/ports/canon-store-port、graph-store-port、diagnostic-sink、core/narrative/memory-types（FactRecord）。
- 备注：每轮全量 listRuns+listEdges，无增量游标。

### 3.6 src/application/assets/asset-catalog-loader.ts（259 行）

#### `loadAssetCatalog(filePath)` — `src/application/assets/asset-catalog-loader.ts:84-130`
- 用途：装载并校验资产目录 YAML（docs §57-§58），snake_case → camelCase 映射，任何失败抛指名文件的 Error。
- 关键步骤：① `readFile`（失败包装错误）；② `yaml.parse`；③ 顶层必须对象；④ **顶层含 `characters` 键即报错**（C7：身份已迁移，防静默丢弃）；⑤ `ResourceYamlSchema.safeParse`；⑥ `mapToCatalog` 映射（含 bgm_playback 全局默认按字段合并，每曲优先）；⑦ `validateCatalog` 启动校验。
- 调用方：bootstrap/create-runtime-application.ts:373、entrypoints/web.ts:69、entrypoints/cli.ts:61、character-contract.test.ts。
- 依赖：node:fs/promises、node:path、yaml、zod、core/assets/types。

内部辅助（均未导出）：`AssetEntrySchema`/`BgmPlaybackFieldsSchema`/`BgmPlaybackSchema`/`BgmAssetEntrySchema`/`SpriteVariantSchema`/`SpriteSetSchema`/`ResourceYamlSchema`（L19-67 zod schema 组，playback 校验至少一字段且 end>start）；`validateCatalog`（L136-176：bgm 合并后窗口交叉校验 + 四类 src 的文件存在与路径逃逸检查）；`mergeBgmPlayback`（L183-198）；`mapToCatalog`（L200-259）。

### 3.7 src/application/assets/asset-manifest.ts（38 行）

#### `buildPublicAssetManifest(catalog, urlPrefix)` — `src/application/assets/asset-manifest.ts:7-38`
- 用途：id → 受控 URL 投影（spec §5.2）：`src` 反斜杠归一为 `/`，拼 `urlPrefix`；bgm 附带 playback（纯展示参数随 manifest 下发浏览器）；不含任何文件系统绝对路径。
- 调用方：hosts/local-web/local-web-host.ts:152（配合 L504 起的 `/game-assets/` 静态服务）。

### 3.8 src/application/assets/asset-manifest.fixtures.ts（30 行）

#### `makeAssetCatalog()` — `src/application/assets/asset-manifest.fixtures.ts:8-30`
- 用途：测试用最小内存 AssetCatalog（basement/mystery/beep/suyao 四类各一条；src 无前导斜杠无 `..`，用于断言无绝对路径泄漏）。
- 调用方：asset-manifest.test.ts、hosts/local-web/local-web-host.test.ts（纯测试 fixture）。

### 3.9 src/core/assets/types.ts（112 行）

#### `BackgroundAsset` — L18-22；`BgmAsset`（含 `playback?`） — L24-30；`BgmPlayback`（start/end/fadeIn/fadeOut，秒） — L37-46；`SoundEffectAsset` — L48-52；`SpriteVariant` — L54-58；`SpriteSet` — L60-64；`AssetCatalog`（guidance + 四类 Record） — L66-72
- 用途：内存目录类型（`src` 为真实相对路径）。

#### `ModelAssetCatalog` — `src/core/assets/types.ts:80-89`
- 用途：模型侧投影：仅逻辑 id + description，**无文件路径**（§59）；C7 后不再携带 characters 段。
- 调用方：adapters/llm/openai-compatible-generator.ts、story/context-builder.ts。

#### `PublicAssetManifest` — `src/core/assets/types.ts:96-101`
- 用途：浏览器侧投影：id → `{ url }`（bgm 附 playback）。调用方：local-web-host.ts。

#### `AssetResolver` — `src/core/assets/types.ts:103-108`
- 用途：逻辑 id/立绘 id → `{ src }` 的四个 resolve 方法形状。
- 备注：仅被 core/assets/catalog.ts 的 `createAssetResolver` 返回值引用；生产代码无消费者（见 §7-2）。

#### re-export `CharacterPosition` / `CharacterRegistry` / `CharacterRegistryEntry` — `src/core/assets/types.ts:112`
- 用途：从 `../presentation/types.js` 转发 v1 注册表类型，便于资产消费方不直插 presentation。

### 3.10 src/core/assets/catalog.ts（146 行）

#### `toModelCatalog(catalog)` — `src/core/assets/catalog.ts:11-45`
- 用途：剥离文件路径，只留 id + description（guidance 透传）。
- 调用方：adapters/llm/openai-compatible-generator.ts:333（构造 generator 时预投影，模型 prompt 序列化用）。

#### `EMPTY_CHARACTER_REGISTRY` — `src/core/assets/catalog.ts:48-58`
- 用途：无目录接线时的 v1 注册表 fallback（三个方法全部返回 undefined/空）。
- 调用方：game.ts:348（窄测试/legacy 世界）。

#### `toCharacterRegistry(roster)` — `src/core/assets/catalog.ts:71-108`
- 用途：**v2 roster → v1 展示注册表** 的派生桥（C7 后身份真源在 core/characters，本函数是编译边界）。
- 关键步骤：① 跳过无 presentation 的角色（玩家/无立绘：无舞台绑定）；② defaultLook 缺失则跳过（registry 构造已诊断）；③ `allowedSpriteSets` = defaultLook 的 spriteSet 在前 + looks 中出现过的素材组去重；④ displayName = initialLabel、scriptName = name；⑤ 建两个 Map 索引，`resolveById` 先 id 后 scriptName 回落。
- 调用方：game.ts:347；测试 protocol-card.test.ts、catalog.test.ts。

#### `createAssetResolver(catalog)` — `src/core/assets/catalog.ts:111-131`
- 用途：逻辑 id → `{ src }` 文件路径解析器（background/bgm/soundEffect/sprite 四方法）。
- 调用方：**仅 catalog.test.ts:215**；生产无调用点。

#### `hasSpriteVariant(catalog, spriteSet, variant)` — `src/core/assets/catalog.ts:137-146`
- 用途：原型链安全的立绘存在性检查（`Object.hasOwn`，`catalog.spriteSets["toString"]` 不算存在）。
- 调用方：core/characters/registry.ts:279（`validateAssetBindings`）。

### 3.11 src/application/world/world-generator.ts（261 行）

#### `WORLD_PROMPTS_DIR`（= "world/prompts"） — `src/application/world/world-generator.ts:35`
- 用途：per-game prompt 覆盖目录名。调用方：bootstrap/create-runtime-application.ts:414（loadPrompts 优先读该目录）。

#### `DERIVED_CARD_SOURCE_PREFIX`（= "# derived-from: world/canon.json@"） — `src/application/world/world-generator.ts:42`
- 用途：派生人物卡来源标记头；加载时校验，缺卡/过期由 canon 再生。调用方：域内 ensureDerivedCharacterCard；测试。

#### `WorldGenerationRequest`（接口） — L44-47（userText + seedStoryLine?）。域外无导入。

#### `WorldGeneratorOptions`（接口） — L49-66（writer port / gamesRoot? / newGameId? / assets? / authorCharacterIds?）。域外无导入（entrypoints 经字面量传参）。

#### `CharacterCardEntry`（接口） — `src/application/world/world-generator.ts:73-81`
- 用途：卡投影条目 = canon 角色 ⊕ voice-design 按 ID join 的画像。域外无导入。

#### `renderCharacters(characters)` — `src/application/world/world-generator.ts:88-103`
- 用途：角色卡文本渲染：`【名】(id)` + 控制类型行（玩家行明示「模型不得替该角色生成台词」）+ 描述 + 可选初始名牌/立绘绑定/嗓音行。调用方：域内 ensureDerivedCharacterCard:143；测试 world-generator.test.ts:178。

#### `renderStoryLine(draft)` — `src/application/world/world-generator.ts:106-112`
- 用途：故事线渲染：世界设定 + act 级 purpose 链（**不含结局文本，防剧透**）。调用方：域内 generate:251；测试。

#### `ensureDerivedCharacterCard(input)` — `src/application/world/world-generator.ts:121-161`
- 用途：校验/再生派生人物卡（M1 加载路径）。
- 关键步骤：① 非 roster 世界（`isRosterCapableCanon` 为假）直接返回（legacy 边界不动旧卡）；② `canonRosterRevision` 计算期望 revision；③ 读 VoiceDesignStore 按 ID join 出 `CharacterCardEntry[]`；④ 拼期望全文（来源头 + renderCharacters）；⑤ 读现有卡：首行来源头一致 → 原样保留返回；⑥ 否则 mkdir + `writeAtomic` 重写（canon 是唯一真源）。
- 调用方：bootstrap/create-runtime-application.ts:391（启动装配）；域内 generate:245。

#### `WorldGenerator`（类） — `src/application/world/world-generator.ts:167-255`
- 用途：世界生成编排：用户文本 → 编剧 → 校验 → 落盘 → 直通开玩。
- `generate(request)` 关键步骤（L174-254）：
  1. userText 空白即抛错（不触盘）；
  2. 生成 gameId（缺省 `game_<ISO 时间戳>`），新建 OutlineStore 并 `load()`；
  3. `writer.writeOutline`（LLM port）产出 WorldDraft；
  4. **fail-before-write 校验**：`validateWorldCharacters`（带 assets/authorCharacterIds），失败抛 `WorldCharacterSetError`，不写任何正式世界文件；
  5. OutlineStore `applyRevision`（全部 add，revision 1）；
  6. `canonCharactersFromDraft`（内部再校验一次防形状漂移）→ CanonStore `saveScaffold`（worldSetting + characters 携带 control/initialLabel）；
  7. 有音频画像的 NPC → VoiceDesignStore `save`（version 1，按 ID join；玩家角色无画像；全无画像则不落盘）；
  8. mkdir per-game prompts 目录 → `ensureDerivedCharacterCard`（characters.txt）→ `writeAtomic(story_line.txt, renderStoryLine)`；
  9. 返回 `{ gameId, draft }`。
- 调用方：entrypoints/web.ts:73、entrypoints/cli.ts:65（两入口构造时传 `authorCharacterIds: authorRoster.characters.map(→id)`，author roster 来自 `loadCharacterPackRoster("characters.yaml")`）；测试 character-contract.test.ts、world-generator.test.ts、dynamic-character-e2e.test.ts。
- 依赖：adapters/storage/{outline-store, canon-store, voice-design-store}（**具体类直连**）、bootstrap（DEFAULT_GAMES_ROOT）、application/outline/outline-writer（port 类型）、application/characters/world-roster。

内部辅助：`PLAYER_CONTROL_LINE`/`NPC_CONTROL_LINE`（L83-85 常量）、`writeAtomic`（L257-261 tmp 文件 + rename 原子写，全 src 唯一定义）。

## 4. 域内数据流

启动装配（bootstrap/create-runtime-application.ts）：

1. `loadAssetCatalog(config.assets.catalog)`（L373，默认 assets/resources.yaml）→ `AssetCatalog`。
2. registry 三分支（L383-410）：
   - 生成世界（有 gameId 且 `isRosterCapableCanon(canonSnapshot)`）：`rosterFromCanonCharacters({scopeId: "world:<gameId>", characters, assets})` → `createCharacterRegistry(roster, assetCatalog)`（mode "roster"）→ `ensureDerivedCharacterCard` 校验/再生人物卡；
   - 旧世界（有 gameId、canon 有角色但无 control 元信息）：`mode: "legacy", registry: undefined`（身份走资产目录兼容边界，不猜测）；
   - 无世界/空 canon：`loadCharacterPackRoster("characters.yaml")`（character-pack-loader，内部 `buildCharacterRoster` 计算 revision）→ `createCharacterRegistry`（mode "roster"）。
3. 音频侧第二注册表（L460-479）：roster 世界用 `audioRosterFromViews(roster, voiceViews)` 补 voiceProfileId 再 `createCharacterRegistry`；legacy 世界用硬编码无名玩家占位 roster。

世界生成（entrypoints → WorldGenerator.generate）：用户文本 → `writeOutline` → `validateWorldCharacters`（fail-before-write）→ outline revision 1 → `canonCharactersFromDraft` → `world/canon.json` scaffold → `voice-design.json` → `world/prompts/characters.txt`（派生卡，来源 revision 头）+ `story_line.txt`。下次启动回到第 2 步的生成世界分支。

运行时投影（消费侧）：`toCharacterRegistry(roster)`（game.ts:347，v1 展示注册表）→ DSL 编译/舞台；`toModelCatalog`（openai-compatible-generator.ts:333，模型 prompt）；`buildPublicAssetManifest`（local-web-host.ts:152，浏览器 /game-assets/）。

canon 晋升（跨周目）：bootstrap 在 `session_ended`（L650）与 restart 弃局（L690）后 `void canonPromoter.promoteFromRuns()` → 全量收集 settled 周目 major facts → ≥2 周目佐证候选 → `adjudicateCanon`（canon-adjudicator-adapter，LLM 单次 JSON）→ `applyPromotion` → canon.promotedFacts/exceptions（供剧情/叙事域在后续周目消费；不回改历史快照）。

story-plan.yaml 不进本域链路：由 `src/adapters/static/story-plan-loader.ts` 按 `config.narrative.story_plan_path`（config.ts:122 默认 "story-plan.yaml"）装载，供剧情线/导演域使用。

## 5. 跨域接口

**依赖（本域 → 外域）**

- core/characters/registry → core/assets/catalog（`hasSpriteVariant`）、core/assets/types（AssetCatalog）。
- application/characters/world-roster → core/characters（registry/types）、core/assets/types、core/ports/canon-store-port（CanonCharacter/CanonSnapshot）、application/outline/outline-writer（WorldDraft/CharacterVoiceDesign/DraftCharacter 类型）。
- application/canon/canon-promoter → core/ports/{canon-store-port, graph-store-port, diagnostic-sink}、core/narrative/memory-types（FactRecord）。
- application/world/world-generator → **adapters/storage 三个具体 store 类**（outline/canon/voice-design）与 **bootstrap（DEFAULT_GAMES_ROOT，L22，反向依赖）**。
- application/assets/asset-catalog-loader → node:fs、yaml、zod、core/assets/types。

**被依赖（外域 → 本域）**

- bootstrap/create-runtime-application.ts（loadAssetCatalog、createCharacterRegistry、loadCharacterPackRoster→buildCharacterRoster、rosterFromCanonCharacters、isRosterCapableCanon、ensureDerivedCharacterCard、CanonPromoter、WORLD_PROMPTS_DIR）。
- entrypoints/web.ts、entrypoints/cli.ts（WorldGenerator、loadAssetCatalog）。
- game.ts（toCharacterRegistry、EMPTY_CHARACTER_REGISTRY、createCharacterRuntimeState、withCharacterLabel）。
- adapters/llm/openai-compatible-generator.ts（toModelCatalog → ModelAssetCatalog）；adapters/llm/outline-writer-adapter.ts（CharacterLabelSchema）；adapters/llm/canon-adjudicator-adapter.ts（CanonAdjudicatorPort 实现）。
- adapters/storage/game-graph-store.ts（CharacterRosterSchema：图快照内 roster blob 解析）；adapters/storage/identity-upcaster.ts 与 core/graph/snapshot-upcast.ts（createLegacyIdentityResolver/CharacterDefinitionSchema/isValidCharacterId）。
- application/audio/audio-descriptor-factory.ts（LegacyIdentityResolver 可选注入）；application/audio/voice-design-views.ts（rosterFromCanonCharacters）。
- core/protocol/gal-dsl/compiler.ts（withCharacterLabel/resolveCharacterLabel/validateCharacterText）；core/presentation/defaults.ts（resolveCharacterLabel）；core/graph/types.ts（isDangerousKey/isValidCharacterKey/CharacterLabelSchema/DANGEROUS_ID_KEYS）；core/ports/story-generator-port.ts（CastContext/CharacterRuntimeState）；application/prompts/protocol-card.ts（CastContext）；story/types.ts、shared/wire/schemas.ts（CharacterIdSchema/CharacterLabelSchema/CHARACTER_ID_PATTERN）；story/context-builder.ts（ModelAssetCatalog）；hosts/local-web/local-web-host.ts（buildPublicAssetManifest/PublicAssetManifest）。

**assets 目录的投影与模型消费**：`AssetCatalog`（含 src 路径）只在 Node 侧；模型只见 `toModelCatalog`（id+description，无路径，序列化进 prompt）；浏览器只见 `buildPublicAssetManifest`（`/game-assets/` 前缀 URL，由 local-web-host 静态服务段 L504+ 响应）；`AssetResolver`（id→src）当前无生产消费者。

## 6. 测试覆盖

| 测试文件 | 行数 | 覆盖的符号/行为 |
|---|---|---|
| src/core/characters/registry.test.ts | 409 | `createCharacterRegistry`：同名不同 ID 不合并、重复 ID/危险键 ID 拒绝、`validateCharacterRoster` 返回命名问题列表、玩家数/playerId 一致性五种分支、无立绘无音色 NPC 合法、look 引用不存在 spriteSet/variant 拒绝、原型链成员（toString）不算素材集、共享素材不合并身份、get/require 语义、roster 快照一致；`computeRosterRevision`：键序/列表序稳定、对姓名/控制类型/look 绑定/voiceProfileId/persona/initialLabel/scopeId 敏感、确定性、revision 篡改拒绝 |
| src/character-contract.test.ts | 415 | 契约复现（红绿纪律）：R01 改名后上下文仍携带 female_A（红灯）、R02 改名标签事件音色稳定（红灯）、R03 renderTemplate 字面单遍（红灯）、R09 冒号全半角解析分歧（固定当前缺陷）；main 动态世界向量（已绿）：世界生成无素材动态角色经 `WorldGenerator.generate` + `loadAssetCatalog` + `rosterFromCanonCharacters` + `createCharacterRegistry` 形成完整 registry。向量走真实公开 API（parseDslLine → compileEventGroups → serializeStoryContext / AudioDescriptorFactory.build） |
| src/application/world/world-generator.test.ts | 477 | `WorldGenerator.generate`：空描述不触盘、writer 失败大声传播、写 outline revision 1 + canon scaffold + per-game prompts；loadPrompts 优先 per-game 覆盖、缺 story_line.txt 大声失败；`renderCharacters`/`renderStoryLine` 渲染内容；voice-design 落盘（有画像/无画像）；创建前校验六类失败（重复 ID/非法 ID/玩家数/非法 spriteBinding/动态-author 冲突/玩家带画像）；派生人物卡（revision 头、缺卡再生、过期重写、loadPrompts 装载） |

域内其余测试（存在性，未逐条调查）：types.test.ts、legacy-identity.test.ts、catalog.test.ts、world-roster.test.ts、canon-promoter.test.ts、asset-catalog-loader.test.ts、asset-manifest.test.ts、dynamic-character-e2e.test.ts。

## 7. 重构关注点（事实清单）

1. **v1/v2 双轨同名类型**：`src/core/characters/types.ts:193` 的 `CharacterRegistry`（v2，get/require）与 `src/core/presentation/types.ts` 的 `CharacterRegistry`（v1，resolveByScriptName/resolveById/entries）同名异构；character-contract.test.ts:46-48 需要 `import { CharacterRegistry as RosterRegistry }` 消歧；桥接点为 `core/assets/catalog.ts:71 toCharacterRegistry`，v1 侧被 `game.ts:347` 消费。
2. **死代码候选**：`src/core/assets/catalog.ts:111 createAssetResolver` 及 `core/assets/types.ts:103 AssetResolver` 生产无调用方（仅 catalog.test.ts:214-215）；`src/application/characters/world-roster.ts:311 rosterCharacterIds` 生产无调用方（仅 world-roster.test.ts、dynamic-character-e2e.test.ts）；`registry.ts` 的 `CharacterRosterError`/`UnknownCharacterError`/`CharacterRegistryMode`（L30/L45/L366）与 `types.ts:80 CharacterTextError`、`types.ts:147 CharacterNameSchema`、`types.ts:97 CHARACTER_TEXT_MAX_CODE_POINTS` 均无域外生产导入。
3. **legacy 残留有消费者但无来源**：legacy-identity 的生产消费者为 identity-upcaster.ts、snapshot-upcast.ts、audio-descriptor-factory.ts（可选 legacyResolver，L68）；而 bootstrap/create-runtime-application.ts:514-515 注释明言「legacyMapping 由宿主显式登记（当前无来源）」——解析器在生产装配中尚无任何映射表实例。
4. **L2 反向依赖 L3/bootstrap**：`src/application/world/world-generator.ts:22` `import { DEFAULT_GAMES_ROOT } from "../../bootstrap/create-runtime-application.js"`（应用层导入装配层）；同文件 L19-21 直连三个具体 adapter store 类（OutlineStore/CanonStore/VoiceDesignStore），未走 port 注入。
5. **未使用参数**：`src/application/characters/world-roster.ts:138` 入参 `source: "draft" | "canon"` 声明后函数体（L142-221）从未读取（注释称用于 draft/canon 诊断区分）。
6. **防御性缺省链**：`src/application/characters/world-roster.ts:297` `control ?? "npc"` 与 `:305` `playerId: players[0]?.id ?? ""`——上游 `validateWorldCharacters` 已拦截，但 `?? ""` 会把异常路径转成「playerId 非法」的二次错误（经 buildCharacterRoster 再报），错误定位变远。
7. **双重校验**：`src/application/world/world-generator.ts:192`（generate 内 validateWorldCharacters）与 `:214`（canonCharactersFromDraft 内 assertValidOrThrow 再校验）对同一 draft 角色集跑两遍校验——L212-213 注释自认是「防校验与转换之间的形状漂移」。
8. **canon-promoter 全量扫描**：`src/application/canon/canon-promoter.ts:89-90` 每轮 `listRuns()` + `listEdges()` 全表读取，`:102` 对每个弃局周目逐个 `getDecision`；无增量游标，周目数增长后每次 session_ended/restart 都重复全扫。
9. **素材 guidance 文案过期**：`assets/resources.yaml:21-23` guidance 称林澈「目前只有占位剪影立绘（全部表情共用同一张图）」，但 `assets/characters/linche/` 下 9 个表情 png 哈希互不相同（md5 实测），characters.yaml L42-51 也注册了 9 个不同 look——guidance（会投影进模型目录）与实际素材不符。
10. **世界侧/核心侧两套问题结构平行**：`world-roster.ts:43-61`（WorldCharacterIssue/Code）与 `core/characters/types.ts:54-77`（CharacterValidationIssue/Code）错误码大量重叠（invalid_character_id/dangerous_key/duplicate_character_id/player_count/invalid_name/invalid_label），但类型与文案各自维护。
11. **canon→roster 映射丢失字段**：`world-roster.ts:294-300` canon→CharacterDefinition 时 `spriteBinding` 不进 roster presentation（仅 canon 元数据留存 + assets 提供时复检）；persona = description 的字段复用使「人设」与「描述」语义合一。
