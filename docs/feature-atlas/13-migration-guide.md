# 13 · 迁移参考（现状评注 · 行为对照 · 工具建议）

> 2026-10-25。**读法声明**：本目录（00~12 + 各域附A + 本文）是对现状代码的观察与评注，
> **不是规范，不构成约束**。已有代码中的约定与实现，到了新设计里未必需要保留；
> 本文的每个判断都只代表"从设计逻辑看的一种解读"，后续工作者可以推翻、可以采纳，
> 也可以只是参考后走别的路。涉及义务的表述已尽量改写为后果描述——
> "漏掉它会怎样"是事实，"必须保留它"是本轮的立场，后者不在本文职责内。

## 1. 设计逻辑评注

方法：对每条已核实的事实问——它在保护什么效果？这个效果值得吗？现状实现是保护它的唯一/最简方式吗？
按答案的**证据倾向**分三组记录，组名描述的是证据状态，不是处置指令。

### 1.1 行为评注（设计意图有据：代码注释或结构清晰表达了意图）

这些行为的**效果**若在新设计中消失，会出现右列的影响——是否保留、以何种形态保留，由新设计裁量：

| # | 行为 | 若消失的已知影响 | 出处 |
|---|---|---|---|
| C1 | 预测状态与玩家可见的已提交前缀一致（快进/handoff 后孤儿流不写入） | 名牌幽灵改名、背景漂移 | 01 附A-1/2 |
| C2 | 陈旧命令过不了 dispatch 门、不滞留 deferredCommands | 上一会话的命令误触发新表单 | 01 附A-3 |
| C3 | handoff 边界不丢选中分支的最后一批事件 | 非流式 provider 下分支尾批丢失 | 01 附A-4 |
| C4 | checkpoint 晚于玩家事件正式提交 | 整理批次缺玩家选择，线程/伏笔状态从第一拍偏 | 01 附A-5 |
| C5 | 晚到但有效的桥接/事件不丢失 | 桥接内容偶发播不出 | 01 附A-6/7 |
| C6 | 停流 abort 与修复轮 abort 相互独立 | 结构类错误永远拿不到尾部修复 | 02 附A-1 |
| C7 | v2 双败分流（有前缀→fail 续修，空→retry） | 失败呈现形态改变 | 02 附A-2 |
| C8 | 演员可见面 = 导演剪报；voice/music/大纲/结局/跨周目不可见 | 信息边界消失，演员上下文泄密/剧透 | 04 附A-3 |
| C9 | defenseBeats 条件继承（新节拍替换、零节拍继承） | 丢新节拍或永久累积旧节拍 | 04 附A-1 |
| C10 | 影子事务不回滚 checkpoint 增量 | 伏笔超期数学永远偏小 | 04 附A-2 |
| C11 | 声音优先级链 导演>演员逐行>画像基线>恒等值（恒等值进 cacheKey） | 演出覆盖语义与缓存命中改变 | 04/06 附A |
| C12 | 同结局"最新文本胜" | 多周目重抵时拿到旧结局文本 | 05 附A-2 |
| C13 | 汇流改绑随迁出边、行走防环、fresh 周目 seq 世界播种 | 幽灵分叉/死循环/seq 撞号 | 05 附A-1/3/4 |
| C14 | ENOENT-only 读判据（缺文件=合法空态才吞，其余 fs 错误抛出） | seq 撞号级静默数据损坏 | 10 附A-1 |
| C15 | 缺文件 ≠ 坏文件的粒度区分（整文件 vs 单行两套） | 两种容错语义混淆 | 10 附A-2 |
| C16 | store 写三件套（writeChain 互斥、tmp+rename 随机后缀、缓存键与 recipe 配对演进） | 并发写丢失、写入撕裂、缓存静默错配 | 10/06 正文 |
| C17 | 429 语义（started 只发一次、重排队 FIFO 队尾、3 次放弃） | 任务状态流重复、队列饿死 | 06 附A-1 |
| C18 | 双层去重分工（路由 409 + 任务 refcount 合流） | 双标签页 join 半截 PCM 流或重复扣额度 | 08 附A-3 |
| C19 | §22 安全边界 8 条 + §50/§75/Ruling 14（见 §4） | PCM 泄漏上 WS、伪造请求等 | 本文 §4 |
| C20 | 架构事实：纯投影、浏览器不 import core、wire v4 版本门、v1 解析器自述冻结 | 改动这些等于改协议或破快照语义，成本另计 | 00 §2、07 域 |

### 1.2 实现形态观察（证据显示存在更简替代，行为可等价——是否采纳由实施者判断）

| # | 现状形态 | 一种更简的替代方向 | 出处 |
|---|---|---|---|
| S1 | 快进孤儿清理三条 bespoke 路径 | 快进收口单一通道（统一 abort+discard） | 01 附A-2 |
| S2 | 活跃交互/预览 id 靠入口重置防残留 | 命令纪元 id（信封携带） | 01 附A-3 |
| S3 | final-batch 靠返回值重放兜底 | 收紧 provider 契约（全经 onEvent），兜底降为断言 | 01 附A-4 |
| S4 | 桥接缓冲竞态靠 confirm 重取容忍 | 所有权在交互开启时移交会话 | 01 附A-6 |
| S5 | 表单收尾 parser 物化+语义门修复双层归属 | 单一主（紧邻 v1 自述冻结面，动前宜想清楚） | 02 附A-3 |
| S6 | 策略数字散落（beats 5/120/3、429 延迟表、buffer 周期 2000ms） | 收进 config 或常量单源 | 04/06/08 附A |
| S7 | pumpQueue 单定时器手工纪律 | 随调度器抽象收编（OP 样板族） | 06 附A-2 |
| S8 | `input.show_generation_status` 与 debug mode 双重门控 | 合为一面（默认不显示的行为不变） | 09 附A-1 |
| S9 | 汇流行走防环靠运行时守卫 | 改绑构造上保证无环，守卫降为断言 | 05 附A-1 |
| S10 | wire 闸门时序（快照先于版本校验下发，旧客户端白收快照） | 先验版本——runtime-websocket.test.ts:366/380 断言现序，改动与测试同批 | 09 附A-2 |

### 1.3 疑似缺陷与死件（证据清单；如何处理由实施者决定）

| # | 项 | 证据 | 出处 |
|---|---|---|---|
| D1 | `audio.cache_report` 无消费者（corrupt 永不产出） | runtime-websocket.ts:262-265 仅 ack | 08 附A-1 |
| D2 | `app.default_host` 无消费者 | config.ts:192 | 09 附A-1 |
| D3 | `@ending` epilogue 能力在消费缺 | game.ts:1437-1441 合成固定文本 | 02 附A-4 |
| D4 | game-graph-store 三处 catch-all 读错误（与 C14 判据相悖） | :274-275、:551-553 | 10 附A-1 |
| D5 | web.ts graphIdentity 换绑陈旧 | OP-23 | optimization-plan |
| D6 | ttsErrorStatus 幽灵错误码 ×3 | OP-29 | optimization-plan |
| D7 | metrics 估算未标注 / resources.yaml guidance 过期 | OP-36、11 §7.9 | optimization-plan |
| D8 | 测试空洞（review-store、8 个前端组件） | 07 §6、10 §7.12 | — |

## 2. 行为对照场景（现状玩家可见行为的快照）

以下 8 个场景记录的是**当前**的玩家可见行为，供改动前后对照用。场景行为发生变化不是违规——但变化出自有意识的设计决定，还是无意的回归，对照这组场景最容易分辨：

1. 冷启动：`pnpm dev:web` → 自动开浏览器（带 token URL）→ 无世界时创建表单可用 → 有世界直接进 StartScreen。
2. 基本回路：开场流式逐字 → 点击推进 → 选项选择 → 分支推进。
3. 自由输入两阶段：输入 → 预览确认生效 / Esc 取消后草稿恢复回编辑态。
4. 快进与回溯：同选项重复体验零再生快进；图面板非游标决策回溯 → 确认 → 新周目。
5. 音频：语音播放（有 key）/ 无 key 文字模式降级不报错；BGM 淡入淡出；SE 一次性播放。
6. 断线重连：重启服务器 → 指数退避重连 → 投影快照恢复到当前剧情位（模式/交互/预览各自正确，提交锁重置）。
7. 结局与重开：EndScreen → restart_session 不刷新重开。
8. 刷新页面：IndexedDB 缓存命中免合成，已读内容正常重放。

## 3. 工具链倾向：pnpm（建议，供确认）

| 维度 | pnpm | npm |
|---|---|---|
| 幻觉依赖 | 严格 node_modules——未声明的 import 在安装期即失败。对本仓有价值：00 §3 的 10 条依赖方向违规、story/types 挂错层，正需要机制化约束 | 平铺结构，幻觉依赖静默可用 |
| 安装 | 内容寻址存储，快、省盘（onnxruntime-node 等重依赖收益明显） | 较慢 |
| 工作区 | workspaces 成熟；image-gen（重依赖、双向零依赖）若拆分成本低 | 可用但生态偏弱 |
| Windows | 符号链接走 junction，主流场景无碍；onnxruntime-node 原生模块迁移后值得跑一次验证 | 无此顾虑 |
| 迁移成本 | 一次性：`pnpm import`（转换 package-lock.json）→ 删 package-lock.json → 提交 pnpm-lock.yaml | 零 |

无论选谁，`"latest"` 版本 spec 都值得收成确定版本——lockfile 之外存在漂移面是比选谁更实在的问题。最终由实施时确认。

## 4. 横向不变式与代号（解析历史引用用）

### 4.1 可考的 §22 不变式（编号源文档已失传，从 21 处代码注释反推；未列编号不可考，阅读时建议只取所在句子的语义，不据编号外推）

| # | 内容 | 证据 |
|---|---|---|
| inv 2/3 | 浏览器不触碰 Game 内部、不直调 LLM/TTS——只提交 `{taskId, lineId, cacheKey}` + token | web/src/app.ts:10 |
| inv 9 | TTS 请求带 Local Session Token（HTTP 走 `x-session-token`，WS 走 query） | audio-downloader.ts:5 |
| inv 10 | TTS 取流经目录校验（stale/forged cacheKey 拒绝） | audio-catalog-service.ts:66 |
| inv 11 | 同 cacheKey 并发合成去重；每 cacheKey 单 HTTP 消费者（第二个 409） | tts-task-service.ts:120 |
| inv 12 | PCM 不经过 Runtime WebSocket（POST /api/audio/synthesize 取流） | audio-coordinator.ts:7 |
| inv 13 | PCM 缓存写入 fire-and-forget（不阻塞播放路径） | audio-cache-writer.ts:6 |
| inv 14 | 仅 status=complete 的缓存资产可跨页读取 | audio-cache-reader.ts:6 |
| inv 19 | Runtime WS 命令限流 | runtime-websocket.ts:5 |

- **§50**：交互是段落的契约边界，哨兵后杂散组丢弃（game.ts:1364）。
- **§75**：低水位不变量——未来可播放文本 ≤ refill 阈值且无未消费交互才续写（game.ts:234,473,894,1532,1540）。
- **Ruling 14**：记忆定向修复提取失败的每区间（fromSeq:toSeq）瞬时故障计数上限（narrative-director-service.ts:110-171）。
- **optimization-plan §5**：16 条注释声明为"有意设计"的条目（v1 自述冻结、EventGroupDraft 判别式、TTS abort 分界、音乐确定性、graph-view 脱敏等）——那是代码作者的自我声明，记录在此供对照；新设计是否沿用，同样是新设计的自由。

### 4.2 代号表（源文档多已失传，按语境注解）

| 代号 | 可考语境 | 状态 |
|---|---|---|
| C4 | v1 解析器自述的冻结基线（"行为与 C4 之前逐字节一致"） | 语义可考，全名失传 |
| C7 | 角色绑定收敛：characters.yaml `voiceProfileId` 取代 config.yaml 角色段 | 可考 |
| M2.1 | fresh 周目 seq 世界播种决议 | 可考 |
| M3.3 | 世界创建直通表单 | 可考 |
| M5.1/5.2/5.3 | 图面板总览 / 决策子图 / 同选项快进（零再生）；M5.x 回溯=弃局记账开新周目 | 可考 |
| M1.x、C5/C6/C8、I1/I2、§8.3、§11.4、§12.x 等 | 其余编号 | **不可考**——只取所在句子的语义；需要这些决策时在仓库内重新立项 |
| campus `c41582e` 等 | campus 工作树 commit hash（port 来源标注） | git 引用，非 spec 编号 |

## 5. 运行手册（把现状跑起来的事实）

- **Node >= 20**（ES2024 特性在使用）；包管理器倾向见 §3。
- `.env`（key 本机存储不进仓库；`.env.example` 为权威清单）：
  - `VIBEGAL_LLM_KEY`——剧本生成 LLM（变量名由 config.yaml `api.api_key_env` 指向，未设置启动即抛错）。
  - `DASHSCOPE_API_KEY` + `COSYVOICE_VOICE_*` / `DASHSCOPE_VOICE_FALLBACK` / `LOCAL_TTS_*`——TTS 可选；不配时 voiceless 降级，不是错误。
  - `IMAGE_GEN_*`——仅 `pnpm image` 工具用，运行时不需要。
- 启动：`pnpm dev:web`（开发）/ `pnpm build && pnpm start`（产物）。只绑 `127.0.0.1`；`local_web.port: 0` = 随机端口，`open_browser: true` 自动开带 `?token=` 的 URL（token 是 WS 与 TTS POST 的会话凭证）。
- CLI：`pnpm dev:cli`；`--debug-runtime` 或 config `debug.runtime_status: true` 开运行时状态面板。
- 数据文件角色速查：config.yaml（zod 配置）/ characters.yaml（LIST，`voiceProfileId` 绑 voices.yaml）/ voices.yaml（音色画像路由）/ story-plan.yaml（大纲装载）/ prompts/（提示词+DSL 版本门）/ assets/ + resources.yaml（资产目录，详见 docs/asset-management.md）。
- `/music-demo.html`：零 token 配乐试听页，不依赖游戏会话。

## 6. 维护

- 本文与各域附A 是观察记录：简化方向被采纳或被否决、疑似缺陷被处理，都更新对应条目即可。
- 新事实进入本目录时附设计评注（它保护什么效果、证据是什么），让后来者能自行判断而非接受结论。
