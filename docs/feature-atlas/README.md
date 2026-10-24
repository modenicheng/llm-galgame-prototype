# feature-atlas · main 线功能地图（重构准备）

> 基线：origin/main @ `78704e9`（2026-10-24，含 PR #1 合并 port/campus-general-2026-10-24）
> 生成：2026-10-24，13 个子代理分 12 个功能域做函数级梳理，另有交叉复核（发现并已回改 3 处域文档偏差）
> 本目录写在 feat/campus-ops-raspberry 工作树的 `docs/` 下，但内容描述的是 **main 线代码**；如需随重构迁到 main，可整目录移植。

## 这是什么

为「重构整个项目」准备的功能整理目录：

- **12 份功能域文档**（01~12）：函数级梳理——每个导出符号的签名、file:line 跨度、用途、复杂函数的关键步骤、调用方/依赖、状态读写、事实性坏味道备注；每域另有模块清单、数据流走读、跨域接口、测试覆盖表、重构关注点清单。
- **分层总图**（00）：L0~L6 分层架构、依赖方向规则与 10 条现状例外（重构硬约束）、一次玩家交互的端到端跨域链路、全局重构主题汇总。
- **优化方案**（optimization-plan）：40 条函数层级优化条目（P0×8 / P1×17 / P2×11 / P3×4，P0/P1 全部经快照复核）、五大样板重复族、5 波次实施顺序、16 条「不动清单」（有意冻结的设计）。

## 阅读顺序

1. [00-architecture.md](00-architecture.md) —— 建立分层与依赖方向直觉（§2 总图 / §3 违规清单 / §4 端到端链路 / §5 域地图）。
2. 按需进入域文档：§2 模块清单定位文件 → §3 函数级明细 → §4 数据流 → §7 重构关注点。
3. 动手前读 [optimization-plan.md](optimization-plan.md)：对应条目的建议改法/风险/验证方式 + §5 不动清单。

## 文档清单

| 文档 | 域 | 归层 |
|------|----|------|
| [00-architecture.md](00-architecture.md) | 总体架构与分层地图 | 全局 |
| [01-runtime-engine.md](01-runtime-engine.md) | 运行时引擎：run loop·交互驱动·分支预取·game.ts 编排核 | L1 原语 + L2 机制 |
| [02-dsl-protocol.md](02-dsl-protocol.md) | 剧本 DSL：解析/编译/流式门控/修复（v1/v2 双轨） | L1 |
| [03-llm-adapters.md](03-llm-adapters.md) | LLM 适配：流式生成双管线 + 6 个 JSON adapter | L3 |
| [04-narrative-director-memory.md](04-narrative-director-memory.md) | 叙事导演与记忆：validator→consolidator→director 管线 | L1 类型 + L2 管线 |
| [05-graph-story.md](05-graph-story.md) | 剧情图：协调/汇流/视图 + 事件投影/上下文构建 | L1 图 + L2 协调 |
| [06-audio-tts.md](06-audio-tts.md) | 音频与 TTS：意图规划·descriptor 工厂·调度·3 provider·场景音乐 | L2 + L3 + L0 乐理 |
| [07-web-player-shell.md](07-web-player-shell.md) | 玩家前端：应用壳·view-model·舞台·UI 组件 | L5a/b/c |
| [08-web-audio-storage.md](08-web-audio-storage.md) | 玩家前端：播放调度·PCM 解码·IndexedDB 缓存 | L5 子系统 |
| [09-host-assembly-config.md](09-host-assembly-config.md) | 宿主·装配组合根·配置·wire 线缆协议 | L4 + L0 |
| [10-ports-storage.md](10-ports-storage.md) | 18 个端口契约全景 + 10 个文件型 store | L1 端口 + L3 |
| [11-character-world-assets.md](11-character-world-assets.md) | 角色身份 v2·世界观·canon 晋升·资产目录 | L1 + L2 |
| [12-tooling-scripts.md](12-tooling-scripts.md) | 工具链：image-gen·评估器/探针·测试基建 | L6 |
| [optimization-plan.md](optimization-plan.md) | 函数层级优化方案（40 条 + 波次 + 不动清单） | 全局 |

## 使用纪律

- **行号会漂移**：所有 file:line 针对基线 `78704e9`；main 后续演进后，用符号名 + `git grep` 重新定位，勿盲信旧行号。
- **先看不动清单**：optimization-plan §5 的 16 条有意设计（v1 解析器冻结、EventGroupDraft/labelOps 判别式、TTS abort 分界等）禁止重构时顺手改。
- **统计口径**：各域文档头部为该域自身口径（个别含数据资产/相邻文件），全局总量以 00 文档头部实测为准（生产 221 文件 / 53,993 行；测试 158 文件 / 54,375 行）。

## 维护

- main 有大改动合入后，按域增量更新对应文档并刷新头部基线 commit。
- 优化条目完成一条即在 optimization-plan §3 标记状态；依赖方向修复完成后，可用 lint/dependency-cruiser 规则固化 00 §3 的约束。
