# 监控后台（Monitor Dashboard）

运行时观测面板：编剧 LLM 的 DSL 流式实时解析 + 语法高亮、后台异步上下文
管理 LLM 的输出、剧情图与全部游戏状态、缓冲状态栏。面向开发/展位运维，
不面向玩家。

## 打开方式

服务启动时控制台会打印：

```
monitor dashboard: http://127.0.0.1:<port>/monitor?token=<local-session-token>
```

浏览器打开该 URL 即可（与游戏页同一个 Local Session Token，§8.3）。监控页
是只读的：连多少个标签页都不影响游戏，也不占用 `/ws/runtime` 的单
controller 名额。游戏页不需要开着——不开局时监控页显示空缓冲与空闲状态。

## 排版

- **底栏**（VSCode 风格状态条）：图标化紧凑读数，完整口径悬停可见——
  连接圆点、模型·叙事模式、会话短 id、调度相位图标（开场/后台续写/等待
  选择/等待输入/切换分支/强制收束/结束等）、缓冲水位（阈值刻度条 +
  `行数/目标` + 待播句数 + 待播事件数）、生成三态（⟳ 请求中实时首字等待
  / ▶ 生成中显示已确认首字延迟 / ✓ 空闲保留上次首字与耗时，✕ 表示上次
  请求失败）、分级收束（L0–L3 + 交互进度）、token 用量（↑输入 ↓输出
  ·缓存命中率 ·请求次数）、事件总数。图标为 Lucide SVG（web/public/icons，
  ISC 许可），经 CSS mask 染色。
- **左侧最大块**：编剧 LLM。全部开场/续写/分支预取/输入回应/过场桥接
  按时间合并为一份连续 DSL 文档，不再逐段切换；文档以**生成片**为单位
  ——原始生成与其 Game 级修复续写共享同片（`sliceId`，修复续写发新
  nonce 故 taskId 不同），**修复在原位置替换展示**：片主体永远显示最新
  生成的流，片边界升计数（`生成 #N（修复续写 ×K）`），被覆盖的生成折叠
  在片尾「被覆盖的生成」区（点击展开审计：原始文本/修复/错误/token 全量
  保留，数据不删，只换展示）。每次请求的边界
  显示状态、开始时间、总耗时、首字延迟、输入/输出/缓存 token、思考耗时·
  thinking token（thinking 开启时，见 `generation.thinking` 配置）、字符、行、
  事件组、收段 reason、有限修复及错误；正文保留行号、语法高亮、解析徽章、
  错误波浪线。默认自动跟随末尾，用户向上滚动时暂停，点击「继续跟随」恢复。
  玩家当前看到的行以蓝色轨道和低饱和蓝底高亮（`aria-current`，不另加文字标记）；
  交互会高亮整个表单块。
- **右上（双 tab，tab 在面板头行内，不占纵向空间）**：
  - **编剧输入（默认）**：审计当前填入编剧 LLM 请求的完整输入提示词，
    按来源分段标注。系统提示词全话不变，作为顶部 sticky 固定块只渲染
    一次；条目按生成片分组（同片多生成时显示片组头「修复续写 ×K」，
    组内最新生成在前、条目标注 `生成 #N`，独立片无组头）；每个 attempt
    是一条窄手风琴头（状态/任务类型/生成 #/请求 #/字数/时间），展开后
    按请求列出消息（user/assistant），每段一行
    `[来源] 标签 · N 字`（文件蓝/运行时紫/收束指令橙/修复红/模型前缀
    绿），点击展开 verbatim 文本。默认跟随最新 attempt（审计「当前输
    入」），手动选择后钉住；strip-continue 续写请求作为同 attempt 的
    第二个请求展示。
  - **异步上下文**：异步上下文管理 LLM（campus 线 = 前情压缩 recap；
    longform 线另有记忆整理/剧情规划）。每次调用一条：输入批次（事件
    seq 区间）、状态（运行中/完成/已回退/失败）、最终输出文本。
- **右下 tabs**：
  - **剧情图**：本局的运行图——开局节点 → 每个正式交互一个节点（选项全
    列出、已选项高亮、边标注玩家选择/输入、当前等待节点脉冲）→ 结局节
    点；顶部是分级收束进度条（L1/L2/L3 阈值刻度）；等待节点下挂当前分支
    预取状态。
  - **剧情状态**：StoryState 投影（场景/角色/开放线索/canon/[Recap]/玩家
    画像）。
  - **指标**：MetricsSnapshot 卡片（请求计数、token 含思考拆分、延迟分位
    含首字/思考 p50·p95、写手修复按 kind 计数与 attempt 结局分布、预取命中、
    校验失败、玩家时序样本、资产诊断）。
  - **事件**：已提交事件时间线（seq/kind/文本）。高频台词/旁白使用安静的
    普通行；交互和玩家行为使用琥珀色结构提示；结局使用绿色终止面。
  - **日志**：DiagnosticSink 广播（info/warn，scope 过滤在页内）。

## 架构

```
StoryGenerator ──(DslStreamObserver: prompt/start/delta/line/group/repair/usage/end)──┐
RecapSummarizer/Consolidator/PlotPlanner ──(instrumented ports)────┤
DiagnosticSink ──(BroadcastDiagnosticSink)────────────────────────┤
Game.getMonitorState() ──(400ms 轮询，JSON 变化才推)───────────────┤
                                                                    ▼
                                                            MonitorHub（环形缓冲）
                                                                    ▼ WS /ws/monitor
                                                        monitor.snapshot / event / state
                                                                    ▼
                                              web/src/monitor/*（boot 于 /monitor 路由）
```

关键决策：

- **语法单一来源**：前端通过 `@core` 别名直接 import core 的
  `parseDslLine`（分类）与 `StreamLineDecoder`（切行），高亮层
  （`web/src/monitor/dsl-tokens.ts`）只做「解析结果 → spans」的渲染切片，
  不复制语法。`knownSpeakers` 随快照下发，保证全角冒号归一化行为与服务端
  逐字一致。
- **观察者端口在 core**（`src/core/ports/dsl-stream-observer.ts`）：
  StoryGenerator（adapter）依赖接口而非反向；MonitorHub（application）实现
  它。观察者异常/缺失都不影响生成路径。
- **有限收尾修复**：正式协议仍要求 `@end <nonce> <reason>`。只有携带本次
  精确 nonce 和允许 reason、且形态属于已知 `end` 关键字机械错误的整行才
  会被规范化；合法 `interaction` 哨兵前若完整表单只缺闭合行，可补入
  `@/?`。错误 nonce/reason、附加正文和无法完成的表单仍进入严格失败/重试
  路径，每次修复都记录在请求边界中。
- **当前位置来源**：生成器给事件组附带 `attemptId + lineIndex`，Game 在实时
  会话中维护事件到 DSL 的映射。该映射只用于监控、不写存档，因此恢复旧存档
  后位置可以暂时为空。
- **上下文 LLM 无流式**：recap/整理/规划都是一次性补全，监控呈现的是生命
  周期 + 最终输出；`null` → 「已回退」（确定性摘要由 Game 落地，日志可查）。
- **提示词审计与发送字节同源**：`src/story/context-builder.ts` 的分段构造
  器（`buildSystemContextSegments` / `buildDslUserPromptSegments`）是唯一
  组装点，字符串构造函数由分段 join 派生——`join(segments)` 逐字节等于实
  际发送的 prompt（对照测试钉死，前缀缓存不受影响）。生成器在每次
  `createStream` 前经 `DslStreamObserver.onPrompt` 上报完整 messages
  （含 strip-continue 续写请求，`requestIndex` 1+）。system 消息全话不
  变：hub 只存一份（快照 `writer.systemPrompt`），attempt 记录只存
  user/assistant 消息；`writer.prompt` 事件始终携带 system（客户端幂等
  折叠）。上限：单段 20KB / 单 attempt 合计 64KB，截断置 `truncated`。
  前端只订阅 `writerPrompt` topic，流式 delta 不会重绘审计面板。
- **只读通道**：`/ws/monitor` 复用 token + origin 校验，但忽略一切入站消
  息；上限 8 连接。
- **有界内存**：writer 任务环 12 条（每尝试文本 48KB 截断）、context 任务
  24 条、诊断 200 条；状态帧仅 JSON 变化时推送。
- **事件合播**：25ms 窗口内的事件合成一条 `monitor.event` 批量帧，SSE 高频
  delta 不会打爆 WS。

## 落盘记录（llm/）

`observability.record_llm_streams`（默认 true）开启时，每次 LLM 请求都全量
落盘到 `<sessions_dir>/<sessionId>/llm/`，覆盖写手 DSL 流与四个后台代理
（记忆代理 / 前情梗概 / 长线整理 / 导演计划）的非流式请求：

```
llm/index.jsonl                       每个 settled 请求一行汇总（统一台账）
llm/<seq4>-<attemptId>/prompts.jsonl  发给 provider 的请求（写手=逐段
                                      prompt 报告；后台代理=完整请求体）
llm/<seq4>-<attemptId>/output.raw.txt 原始输出（无截断；失败请求无此文件）
llm/<seq4>-<attemptId>/events.jsonl   事件流水（start/usage/end 等，带 ts）
```

index 行字段：`seq, dir, attempt_id, task_id, task_type, task_index,
started_at, ended_at, duration_ms, outcome(done|failed|retried|cancelled),
[error], [segment_end], [meta]`。后台代理的 `task_type` 为
`memory_agent | recap_summarization | narrative_consolidation | plot_plan`，
失败请求 `outcome: failed` 携带错误信息，成功请求带触发上下文 `meta`
（事件数 / checkpoint 等）。`/monitor/records` 只读路由按同一白名单提供
三件套与 index 的访问（需会话 token）；应用关停时写队列显式排空，台账
不丢行。

## 相关文件

| 层 | 文件 |
| --- | --- |
| wire 类型 | `src/shared/wire/monitor-message.ts` |
| 观察者端口 | `src/core/ports/dsl-stream-observer.ts` |
| 游戏快照 | `src/core/runtime/monitor-state.ts`、`Game.getMonitorState()` |
| hub | `src/application/monitor/monitor-hub.ts` |
| 上下文端口包装 | `src/application/monitor/instrumented-context-ports.ts` |
| 落盘器 | `src/adapters/storage/llm-stream-recorder.ts` |
| 后台代理审计端口 | `src/core/ports/context-llm-recorder-port.ts` |
| 记录只读路由 | `src/hosts/local-web/monitor-records.ts` |
| 诊断广播 | `src/adapters/platform/broadcast-diagnostic-sink.ts` |
| WS 通道 | `src/hosts/local-web/monitor-websocket.ts` |
| 前端 | `web/src/monitor/*`（boot 于 `main.ts` 的 `/monitor` 路由分支） |

## 测试

- `src/application/monitor/monitor-hub.test.ts` — 任务生命周期、环形与文本
  截断、合播批量、变化驱动的状态帧。
- `web/src/monitor/dsl-stream-view.test.ts`（happy-dom）— 实时行渲染、partial
  尾行、连续多请求、请求遥测、当前位置/表单块，以及 model→panel 的完整
  事件链路。
- `web/src/monitor/status-bar.test.ts` — 请求中/生成中/空闲与首字延迟派生。
- `web/src/monitor/tabs/logs-tab.test.ts` — 高频、交互和终止事件的语义分级。
- `web/src/monitor/dsl-tokens.test.ts` — 高亮分类与 core 解析器一致、切片
  不丢字符。
- `web/src/monitor/tabs/story-graph.test.ts` — 交互节点/选项选中/等待/结局
  的派生。
- `src/hosts/local-web/vite-middleware.test.ts` — dev 模式 `/monitor` 必须
  返回 app shell，且 Vite 内部路由（`/@vite/client`）必须继续穿透。

## 字体

DSL 流、日志、`pre` 块统一用 **Sarasa Gothic SC（更纱黑体）**，经 CSS 变量
`--mon-mono`（`monitor.css`）落到 `web/public/fonts/files/SarasaGothicSC-*.ttf`
（Regular 400 / Bold 700，从本机系统字体原样复制、未子集化，约 24MB/字重；
`web/public/fonts/sarasa.css` 注册，`scripts/vendor-webfonts.mjs` 不覆盖该
文件）。许可证 SIL OFL 1.1，见 `web/public/fonts/OFL-sarasa-gothic-sc.txt`。
`@font-face` 惰性加载——只有用到该字族的页面才会下载字体。
