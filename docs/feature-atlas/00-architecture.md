# 00 · 总体架构与分层地图

> 基线：origin/main @ `78704e9`（2026-10-24，含 PR #1 合并 port/campus-general-2026-10-24）
> 全仓规模（实测）：生产代码 221 文件 / 53,993 行（src + web/src + scripts，含 .d.ts）｜测试 158 文件 / 54,375 行｜数据资产另有 prompts/（5 文件 327 行）、config.yaml（139 行）、characters.yaml（78 行）、story-plan.yaml（75 行）、voices.yaml（106 行）、assets/（背景/立绘/BGM/音效/soundfont）、web/public/fonts（195 个 woff2 子集，约 56 MB）、web/src/audio/demo-scores.ts（3,929 行谱面数据）
> 本目录共 12 份功能域文档 + 本总图 + 优化方案（optimization-plan.md），全部为函数级梳理，行号针对基线 commit。

## 1. 这个系统是什么

LLM 驱动的视觉小说引擎：玩家在浏览器游玩；服务器端 run loop 用 LLM **流式生成剧本 DSL**，编译为可播放段落，配合 TTS 语音、生成式 BGM、立绘/背景投影演出；剧情以有向图（run graph）持久化，后台跑记忆整理与 canon（正典设定）晋升。

- 双端形态：Node 服务器（`src/`）+ 浏览器前端（`web/`），经 `src/shared/wire` 共享线缆协议（`WIRE_PROTOCOL_VERSION = 4`，旧客户端以 4002 显式拒绝）。
- 服务器进程同时提供：剧本生成（流式）、TTS 合成（HTTP 取 PCM 流）、演出投影（WS 推送）、文件型持久化（sessions/ 下图快照+JSONL 事件）。

## 2. 分层总图

```
┌─ L6 工具链（三档：独立 / 贴域 / 测试基建）
│    tools/image-gen（与生产代码双向零依赖，产物经人工中转进 assets/）
│    scripts/*（贴域工具：evaluate-character-dsl 角色DSL离线评估器 2084 行 · probe 探针 · smoke-e2e · vendor 资产脚本）
│    src/test-helpers.ts · src/game-test-kit.ts（测试基建，横切被 19+ 测试消费）
│
├─ L5 玩家前端 web/src
│    L5a runtime：game-view-model（纯投影，零 DOM）· runtime-client（WS 连接层：zod 校验+序号去重+指数退避）
│    L5b app.ts（GameApp 应用壳 770 行：消息路由 + 音频获取状态机五态编排）
│    L5c main.ts（装配/render 路由）· stage/（舞台渲染·BGM·音效）· ui/（组件）
│    子系统：audio/（播放调度·PCM 解码·worklet）· storage/（IndexedDB 缓存·玩家偏好）
│
├─ L4 宿主与装配
│    hosts/local-web（HTTP+WS 宿主·音频流路由·origin 防护）· entrypoints/（cli·web 双入口）
│    bootstrap/create-runtime-application.ts（组合根：343 行装配 14 大类对象——理解全仓依赖的入口）
│    src/config.ts（zod 配置校验）· src/schema.ts（事件类型枢纽，30+ 文件引用）
│
├─ L3 外部适配 adapters/
│    llm/（openai-compatible-generator 1927 行流式生成 + 6 个 JSON 型 adapter）· tts/（3 个 provider）
│    storage/（10 个文件型 store）· static/（剧本/角色包装载）· platform/（时钟/ID/诊断）
│
├─ L2 应用服务 application/* 与机制层 runtime/*
│    narrative/（记忆导演管线：validator→consolidator→director）· director/（场景演出导演）
│    graph/（图协调 929 行·汇流·视图）· audio/（意图规划·descriptor 工厂·TTS 调度·演出编译·场景音乐）
│    characters·world·canon·assets·ui（投影存储）
│    src/runtime/*（交互驱动·分支预取·指标·播放缓冲）＋ src/game.ts（Game：run loop 编排核，事实上的 L2）
│
├─ L1 核心领域 core/
│    protocol/gal-dsl（DSL 解析编译，v1/v2 双轨，纯函数层）· graph/（图类型+纯算法）
│    narrative/（记忆类型/操作）· characters/（身份 v2 真源 CharacterRoster）· assets/（资产目录纯投影）
│    presentation/（演出状态归约）· runtime/·interaction/（运行时原语）· ports/（18 个端口契约文件，16 接口型端口）
│    L1 内部子序：protocol 最上，依赖同层的 presentation/assets/characters
│
└─ L0 共享内核（双端可 import）
     shared/wire（线缆协议 v4，zod）· shared/music（谱面/主题）· shared/tts-log
     事实内核（位置待归位）：src/story/types.ts（被 core 多处依赖，却挂在 core 外）
                              src/schema.ts（事件枢纽，现挂 L4 侧）
```

**依赖规则**：只允许高层 → 低层单向依赖；跨 L2/L3 边界必须经 L1 端口；L0 是唯一双端共享层。

## 3. 依赖方向：现状例外清单（重构的硬约束）

以下违规均有 file:line 证据，明细见各域文档 §7：

| # | 违规方向 | 位置 | 性质 |
|---|---------|------|------|
| 1 | L3 → L2 | `src/adapters/llm/openai-compatible-generator.ts:67` 反向 import 并回调 `runtime/metrics`（recordLLMRequest 等十余处） | 适配层反向侵入机制层 |
| 2 | L3 → L2 | `src/adapters/storage/music-theme-store.ts:21`、`composer-session-store.ts:21`、`voice-design-store.ts:10-11` import application 层端口/类型 | 端口定义放错层的连锁反应 |
| 3 | L2 → L3 | `src/application/graph/run-graph-coordinator.ts:25` import `adapters/storage/identity-upcaster` | 应用层直连适配层 |
| 4 | L2 → L3 | `src/application/world/world-generator.ts:19-21` 直接 new 三个具体 store | 同上 |
| 5 | L2 → L4 | `src/application/world/world-generator.ts:22` import bootstrap 的 `DEFAULT_GAMES_ROOT` | 应用层反向依赖装配层 |
| 6 | L0 → L2 | `src/shared/wire/ui-projection.ts:13` import `src/runtime/status` | 共享内核反向依赖机制层 |
| 7 | L1 内部子序倒置 | `core/graph/types.ts:15` 等处依赖 `../../story/types.js`——story/types 是事实内核却不在 core 内 | 目录层级与依赖方向不一致 |
| 8 | 端口散落 | 7 个端口定义在 core/ports 之外：scene-music-service.ts:39/49/62（3 个）、canon-promoter.ts:30、memory-consolidator.ts:123、outline-writer.ts:109/118（2 个） | 端口收编清单 |
| 9 | 端口缺口 | `VoiceDesignStore` 完全无端口；`CanonStore` 未声明 `implements CanonStorePort`（结构兼容无编译期保护） | 边界裸露 |
| 10 | 编排核混合 | `src/game.ts:119-120` import `application/director`（Game 巨类内部混层） | 巨类拆分时一并解决 |

## 4. 一次玩家交互的端到端链路（跨域走读，汇总自各域文档 §4）

1. **输入**（07）：`InteractionPanel` 采集 → `GameApp` 消息路由（app.ts）→ `RuntimeClient`（zod 校验 client-message）→ WebSocket。
2. **接收**（09）：`runtime-websocket` → `Game`。
3. **交互窗口**（01）：`interaction-driver` / `interaction-choice` 开窗与一击制门控；`Game.run` 调 `story/context-builder`（05）拼装提示词上下文。
4. **生成**（03）：`OpenAICompatibleGenerator.attemptDslStreamV2` 流式请求（v2 主路径）。
5. **协议编译**（02）：`createV2SegmentGate` 逐组语义门控，坏组走尾部修复；能力开关由 `capabilities.ts` 单源控制。
6. **播放与图更新**（01/05/09）：段落进 `playback-buffer` 逐行输出；`run-graph-coordinator` 更新剧情图并做汇流判定；事件投影进 `ui-projection-store`，经 WS 推 `ui-projection`。
7. **音频**（06）：`audio-intent-planner` 规划 → `audio-descriptor-factory` 生成 descriptor（含缓存键）→ `tts-task-service` 调度 → TTS provider 合成；前端经 `POST /api/audio/synthesize` 取 PCM 流。
8. **前端演出**（07/08）：`GameViewModel` 纯投影 → stage 渲染（立绘/背景/BGM「最新意图胜」）；`audio-coordinator` 以 EOF 双条件门控推进；IndexedDB 缓存命中则免合成。
9. **后台**（04/11）：记忆整理管线（影子事务校验→身份修复→降级→copy-on-write 持久化）；canon 晋升（≥2 周目佐证+编剧裁决）fire-and-forget。

## 5. 域地图（文档索引）

| 编号 | 域 | 文档 | 规模（域口径） | 归层 |
|------|----|------|---------------|------|
| 01 | 运行时引擎（run loop·交互） | [01-runtime-engine.md](01-runtime-engine.md) | 20 文件 / 5,417 行 / 72 导出 | L1 原语 + L2 机制；game.ts 为 L2 编排核 |
| 02 | 剧本 DSL 协议 | [02-dsl-protocol.md](02-dsl-protocol.md) | 11 文件 / 4,180 行 / 97 导出 | L1（protocol 最上） |
| 03 | LLM 适配与生成管线 | [03-llm-adapters.md](03-llm-adapters.md) | 10 文件 / 3,401 行 / 18 导出 + prompts/ 数据 | L3 |
| 04 | 叙事导演与记忆 | [04-narrative-director-memory.md](04-narrative-director-memory.md) | 18 文件 / 5,376 行 / 130 导出 | L1 类型 + L2 管线 |
| 05 | 剧情图与故事投影 | [05-graph-story.md](05-graph-story.md) | 16 文件 / 4,204 行 / 143 导出 | L1 图结构 + L2 协调 |
| 06 | 音频与 TTS（服务端） | [06-audio-tts.md](06-audio-tts.md) | 20 文件 / 域口径 7,855 行 / 约 133 导出 | L2 服务 + L3 provider + L0 乐理 |
| 07 | 玩家前端（壳·舞台·UI） | [07-web-player-shell.md](07-web-player-shell.md) | 23 文件 / 4,077 行 / 60 导出 | L5a/b/c |
| 08 | 玩家前端（音频·存储） | [08-web-audio-storage.md](08-web-audio-storage.md) | 15 文件 / 6,120 行（数据 3,929）/ 约 49 导出 | L5 子系统 |
| 09 | 宿主·装配·配置·线缆 | [09-host-assembly-config.md](09-host-assembly-config.md) | 22 文件 / 域口径 7,006 行 | L4 + L0 wire |
| 10 | 端口与存储适配 | [10-ports-storage.md](10-ports-storage.md) | 34 文件 / 3,591 行 | L1 端口 + L3 存储 |
| 11 | 角色·世界观·资产 | [11-character-world-assets.md](11-character-world-assets.md) | 11 文件 / 2,246 行 / 86 导出 | L1 身份/资产 + L2 编排 |
| 12 | 工具链 | [12-tooling-scripts.md](12-tooling-scripts.md) | 21 文件 / 5,959 行 / 119 导出 | L6（独立/贴域/测试基建三档） |

口径说明：各域文档头部统计为该域自身口径（个别域计入相邻文件或数据资产），全局总量以本文件头部实测为准；行号与符号均针对基线 `78704e9`，后续提交会使行号漂移，重构定位时以符号名 + `git grep` 复核。

## 6. 全局重构主题（跨域汇总，细化见 optimization-plan.md）

1. **巨类/巨文件拆分**（7 个主靶）：`src/game.ts` 1,983 行（单类 10 类职责：run loop·段生命周期·修复链·缓冲·DSL 编译路由·命令作用域·事件记账·身份剪报·逐行播放·可观测中转；run() 152 行、consumeActiveSegment() 213 行）｜`openai-compatible-generator.ts` 1,927（v1/v2 双流式管线平行）｜`memory-validator.ts` 1,188（规则校验+状态应用+身份视图族三职）｜`narrative-director-service.ts` 1,019｜`run-graph-coordinator.ts` 929（≥9 种职责）｜`web/src/app.ts` 770（GameApp 五职）｜`evaluate-character-dsl.ts` 2,084（评估逻辑与场景数据内联）。
2. **v1/v2 双轨收敛**：DSL 双编译器+双 group-builder 同文件（02）；LLM 双流式脚手架 596/437 行结构性重复（03）；双 `CharacterRegistry` 同名（11，v1 已萎缩为派生桥）；生产 v2 主路径只走 `createV2SegmentGate`，四个批式入口零生产调用（02）。
3. **端口与依赖方向修复**：§3 清单 10 条；7 个外置端口收编 + 2 个端口缺口补齐 + 4 处反向依赖改经端口注入。
4. **样板去重五大族**：存储层 tmp+rename 原子写 ×12 + enqueue 互斥链 ×4 + ENOENT 处理约 10 处（10）；`new OpenAI` 样板 ×8 + 请求参数展开逐字重复 ×3 + thinking hack ×4（03）；JSON 型调用+失败策略四分五裂 ×6 adapter（03）；TTS provider 会话状态机三重复（06）；装配层可选展开样板 ×10+（09）。
5. **死代码/死接口清理**：`metrics.recordTextWaste/recordAudioWaste` 零生产调用（01）；前端 16 个零调用公有方法（07）；`AudioDownloader.hasInFlight` 死导出（08）；`createAssetResolver`/`rosterCharacterIds` 等（11）；DSL 域死导入+零引用入口（02）。
6. **命名治理**：`director` 一词三义（DirectorService 场景演出 / NarrativeDirectorService 记忆导演 / director-service 命名误导）；同名 `CharacterRegistry`（v1 素材口径 / v2 roster 口径）。
7. **配置与缓存键一致性**：配置默认值三份重复维护（09）；缓存键双体系风格不一 + factory recipe 与 cache-key 必须同步演进的配对脆弱性（06）。

## 7. 阅读指南（重构时怎么用这套文档）

1. 先读本文件 §2/§3 建立分层与依赖方向直觉；
2. 进入目标域文档：§2 模块清单定位文件 → §3 函数级明细看签名/行号/调用方/步骤 → §4 数据流看链路；
3. 动手前查 optimization-plan.md 中对应条目（优先级/建议/风险/验证方式）与「不动清单」（有意冻结的设计决策）；
4. 行号漂移后用符号名 + `git grep` 重新定位，勿盲信旧行号。

## 8. 与既有文档的关系

- `docs/asset-management.md`：资产生产→注册→校验→投影→模型调用的权威流程（11 域文档的资产部分与其互补）。
- `docs/character-identity-and-dsl-v2.md`：身份 DSL v2 的设计文档（11/02 域的背景）。
- `docs/llm-outputs-refactor.md`、`docs/status.md`：历史设计脉络；本目录以代码现状为准，冲突时以本目录为准。
