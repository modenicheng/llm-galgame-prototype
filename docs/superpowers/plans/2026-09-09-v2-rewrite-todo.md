# v2 破坏性重构执行清单（交付版）

日期：2026-09-09 立项；**2026-09-16 重整为交付版**（面向一次性自主实现的执行文档）。
设计依据：`docs/superpowers/specs/2026-09-09-game-graph-architecture-design.md`（已批准，下称「设计」；§N 均指该文件）。
本清单是**活文档**：完成即勾选；偏离处记入附录 B「偏差记录」；每阶段末过卫生门才能进入下一阶段。

**交付版说明**：本文档交给一个自主执行的实现者（agent），按序完成第 4 节全部任务卡。
附录 A 是历史实施记录（只读背景，源码注释仍引用其中的里程碑编号），附录 B 累积偏差。

---

## 1. 执行协议（动手前必读）

**工作循环**（每张任务卡）：
1. 读卡：目标 / 前置 / 关联引用。把卡内引用的 spec 章节、既有文件读完再动手。
2. 定落点：列出要新建/修改的文件清单（对照第 4 节反重复地图，先确认没有既有组件可复用）。
3. 测试先行（能写时）：先写会失败的测试，再实现到绿。
4. 验证：`npm test` 全绿 + `npm run typecheck` 通过；涉及构建产物时 `npm run build`；每 3–4 张卡加跑 repo-hygiene 机械检查（skill §A 脚本）。
5. 收尾：勾选本卡、必要时在附录 B 追加偏差记录、`git commit`（格式 `type(scope): 卡号 一句话`，如 `feat(graph): M3.1 outline store`）。不攒大包，main 直接提交。

**测试与代码惯例**（照既有代码写，不要发明新风格）：
- vitest，测试与源码同目录（`*.test.ts`）；LLM 依赖一律注入 fake OpenAI client（样例：`src/adapters/llm/plot-planner-adapter.test.ts`、`src/application/graph/run-graph-confluence.test.ts`）；存储用真 store + 临时目录；异步断言用 `vi.waitFor`。
- zod 可选字段用 `z.exactOptional(...)` 而非 `.optional()`（tsconfig `exactOptionalPropertyTypes`）。
- 实时性红线：**任何 LLM 调用不得进入生成/播放同步路径**——后台调用照汇流判定模式（fire-and-forget + 诊断告警，落盘入协调器互斥链、LLM 在链外）。

**纪律**：
- 测试红 = 停止一切推进，先修复。禁止 skip 测试、禁止 `// TODO` 顶替实现。
- **冻结契约**（§3 schema 字段集、§3.3 判定签名、§4 大纲 schema、§9 存储布局、§7 节点维护语义〔2026-09-16 D7 修订版〕）：不得增删字段。实现中发现必须改 → 登记附录 B `[BLOCKED 卡号]` 后跳卡。唯一预授权修订：`SNAPSHOT_VERSION` 递增——MA-B 的 1→2（决议 D4）与 MA-A2 的再递增（决议 D10，实际版本号记附录 B）。运行时端口（`src/core/ports/*.ts` 的方法签名）不是冻结契约，按卡内说明演进。
- 对既有行为有疑问：先读测试与 spec 引用；仍含糊 → 取与既有测试一致的保守实现，并在附录 B 注明你的解释。
- 不在卡内的文件不顺手重构；发现的卫生问题记入下一张门卡处理。
- 阻塞（需要真实 LLM、需要作者决策、环境不具备）：登记 `[BLOCKED 卡号] 原因`，继续下一张无依赖卡。

**卫生门**（每阶段末的门卡执行）：触发 **`repo-hygiene`** skill执行完整档，即：
机械检查（skill 自带脚本，读仓库根 `.hygiene.config.json` 的阈值与豁免）→ subagent 只读评审（SKILL §B 的 prompt 模板，必须派发）→ 当场修复 P1/P2 → 单一真源与依赖方向核对 → 文档卫生（本清单勾选、status.md 同步、§N 引用可解析）。快速档（仅 §A + 新文件过目）每 3–4 张卡跑一次。

## 2. 现状基线（2026-09-17，含 D9 落地）

**验证基线**：1451 测试 / 103 文件全绿；node/web 双 typecheck、build 绿；repo-hygiene 机械检查通过（5 条豁免在册、标记基线 19）。

已完成 M0–M2.2（历史细节见附录 A）。已落地组件：

| 组件 | 位置 | 要点 |
|---|---|---|
| 图契约（冻结） | `src/core/graph/types.ts`、`src/core/graph/ids.ts`、`src/core/outline/types.ts` | §3/§4 schema + ID 规则 + §9 布局常量 |
| 图存储 | `src/adapters/storage/game-graph-store.ts` | JSONL latest-wins；快照/游标原子写；endState 内联 ⟺ 结局端点 ∨ 汇流边，普通决策端点派生 + 写入校验精确一致 |
| 图协调器 | `src/application/graph/run-graph-coordinator.ts` | 恢复三态（fresh/active/ended）、restart=retrace、promise 链互斥、场景内汇流后台改绑、场景节点世界级稳定 |
| 汇流判定 | `src/core/ports/confluence-judge-port.ts` + `src/adapters/llm/confluence-judge-adapter.ts` | §3.3 冻结签名；`narrative.confluence.enabled` 门控（默认关，CI 零网络） |
| 演员管线 | `src/game.ts` + `src/runtime/*` + `src/core/protocol/*` | DSL 流式生成、低水位/预取、交互两阶段提交 |
| 叙事记忆 | `src/application/narrative/*` + `src/adapters/llm/*consolidator*/plot-planner-adapter` | consolidator（threads/setups/anchors/episodes）、PlotPlanner/DirectorPlan、getBrief 同步零 await |
| 组装根 | `src/bootstrap/create-runtime-application.ts` | gameId/gamesRoot 可注入；缺省每次启动新世界 |
| 宿主 | `src/hosts/local-web/`、`src/apps/cli/`、`src/entrypoints/` | M5.0 已接线：`--game`/`VIBEGAL_GAME_ID`/`games/.last-game` |

**不可回归的行为不变量**（既有测试已锁定，改动前先读对应测试）：
1. seq 播种 `nextSeq = max(世界最大 seq, 路径末事件 seq, digest 水位) + 1`（fresh 与 retrace 同式，跨周目单调）；
2. 「同一次快照写两处」：普通决策端点边的 endState ≡ 后继入口快照（写入门禁）；
3. 恢复 = 游标决策节点入口快照 + 全路径边负载经水位过滤重放进导演；
4. 汇流判定永不阻塞播放；改绑守卫（换周目/已完结/apply 时祖先重验）；
5. 场景节点按模型场景 id 世界级稳定（fresh 周目不重复建）。

## 3. 设计决议（本次交付前定稿，实现时不再讨论）

- **D1 不使用 pi 框架**：编剧 = 现有 openai-compatible client 上的**单次 JSON 调用 adapter**（沿用 PlotPlanner adapter 模式）；导演 = 同 client 上的**工具循环**（`AgentRunner` port + adapter）。角色边界与红线不变。不引入任何外部 agent 框架。
- **D2 M2.3 归人工验证**：「偏离输入→防守节拍引回→图上汇流」的端到端验证前置依赖 M4.3（防守节拍在位）且需真实 LLM；协调器层自动化等价物已由 `run-graph-confluence.test.ts` 7 例覆盖。移入第 6 节人工清单，不阻塞开发。
- **D3 执行序重排**（对设计 §11 建议的偏离）：M5.0 宿主接线提前到最前（后续一切实测依赖它）；M3.5 收束与 M3.6 canon、M3.7 清理挪到 M4 之后——收束压力与 canon 读取必须走导演剪报通道（§5.2 防火墙），导演在位前实现即破防火墙。
- **D4 SNAPSHOT_VERSION 1→2 预授权**：MA-B 在 `MemoryDigest` 增加 facts/beliefs 时执行；旧 v1 快照读取即拒（zod literal 不匹配走结构损坏路径），dev 存档废弃、不做迁移，登记附录 B。
- **D5 场景→大纲绑定规则**：场景节点创建时 outlineRef = 当前前沿 act 节点（首个未 realized 的 act），创建后不改绑；错绑接受（act 粒度粗，影响限于完成度统计）。大纲维护只增/剪前沿节点（§4 冻结原则）。
- **D6 digest 事实嵌入制**：digest 内嵌路径层 facts/beliefs **全文**（恢复不得依赖 canon 可用性）；canon 晋升不回改既有快照；读取侧 canon 优先去重。这是对附录 A「引用制」决议的落地细则。
- **D7 已演出内容不可删**（作者 2026-09-16 修订原 §7）：经历过的分支/节点/边是冻结的叙事事实，删除会使跨周目一致性失真。回溯只新增路径（`abandonedAt` 仅流水记账，不是内容作废）；「玩家删除决策」特性整体移除，§7 重写为不可达内容的内部 GC（孤儿/被汇流取代节点，无玩家入口）；导演/编剧输入始终包含全部已实现路径（**含已弃周目**，已回写 spec §5.1/§7）。
- **D8 相同物理场景不同具体状态**：同幕内的状态漂移由各决策入口快照承载（既有设计，快照层天然分工）；跨幕的同地不同阶段 = 多个幕节点共享 `OutlineNode.location?`（物理地点标签，§4 演化区新增，契约代码已同步），场景总览与通关回顾按 location 并排分组展示。
- **D9 演员上下文布局与不压缩立场**（作者 2026-09-17，已随基线落地）：`buildDslUserPrompt` 段落按「稳定 → 易变」排序——剧情历史（单调追加，回溯 = 恢复重放天然截尾）与素材目录（每世界静态）构成公共前缀，故事状态/便签/舞台居中，任务头（回合/nonce/指令）置尾；目标是 provider 前缀缓存命中。`game.history_events` 截断删除：截断/摘要移动公共前缀起点，破坏缓存局部性；单周目全量历史远小于现代上下文。极长流程逃生舱 = **场景锚定 compact**（对上一场景节点之前的内容做摘要替换，锚点 = 场景边界），不是事件数滑窗；规范见 `docs/llm-outputs-refactor.md` §70。M4.2 剪报组装必须继承该布局。
- **D10 StoryState 瘦身预授权**（作者 2026-09-17）：MA-A2 执行时 `SNAPSHOT_VERSION` 递增（实际版本号以落地顺序为准，记附录 B），dev 存档废弃不做迁移。删除字段清单见卡；设计 §3.2 无需改——其对 storyState 的定义（reconcile 产物：location/characters/summary）本就是瘦身后的形态。物品/场景关键细节的语义记录归 MA-B facts 承载，不进 storyState 结构字段。

## 4. 任务卡（执行序）

**开工前**：先跑 `npm test`、`npm run typecheck` 与 repo-hygiene 机械检查，确认与第 2 节基线一致；不一致即停止并登记 `[BLOCKED]`（基线损坏不是你的修复对象）。

### P1 快速见效

- [x] **M5.0 宿主接线**（提前执行，原属 P6）
  前置：无。关联：`create-runtime-application.ts` 的 `options.gameId`（已支持）。
  目标：世界身份跨进程固定，「继续游戏」对真实用户可达。
  要点：① web/cli 入口接受 gameId（启动参数 `--game <id>` 与环境变量 `VIBEGAL_GAME_ID`，参数优先）传入 `options.gameId`；② local-web 在未显式指定时持久化最近世界到 `games/.last-game`（best-effort 读写，损坏/缺失即开新世界，读写失败不阻塞启动）；③ 新世界的正式入口随 M3.3，本卡不做 UI。
  验收：单测——同一 gameId 两次 `createRuntimeApplication`（tmpdir gamesRoot）得到同一图位置并恢复游标；显式指定优先于 `.last-game`；`.last-game` 损坏容错。
  落地（2026-09-17）：解析器与读写集中在 `src/hosts/local-web/last-game.ts`（非法 id 大声抛错、`.last-game` 非法内容视为无记录、id 字符集白名单防路径逃逸）；`RuntimeApplication.gameId` 暴露给宿主；CLI 不读写 `.last-game`（那是 web 的续玩通道）。

### P2 记忆审计（memory-audit Phase A/B）

依据：`docs/superpowers/specs/2026-09-06-narrative-memory-audit-design.md`（下称「记忆 spec」，§N 均指该文件）。该 spec 已定稿且高度可执行，任务卡只做排期与冲突决议，细则以 spec 为准。

- [x] **MA-A 确定性规则与存储骨架**（记忆 spec §12 Phase A 条目 1–5）
  前置：无。关联：§5–§8、§10 变更表、§14 测试矩阵。
  要点：① depth 字段 + scheduler 门控 + RESOLVE_OR_DROP 第三档（§8.1/8.3）；② intendedPayoff 必填（runtime 拒绝 + author seed warning，§8.2）；③ 终局报告 ending-report.json（§8.4，确定性聚合，EndEvent 提交后异步）；④ lessons 存储 + rejection 自动晋升 + brief 规避清单（§7）；⑤ facts.jsonl/lessons.jsonl 存储通道（§5.3，B 阶段才有写入者）。新增配置键（facts/lessons/setups/beliefs 各上限）全部带 zod 默认值并被读取。
  **卫生前置**：`src/application/narrative/narrative-director-service.test.ts`（2421 行）沿子系统缝拆分（consolidation / replan / brief / 生命周期；§14 矩阵即分缝参考），新测试进对应文件；完成后把它移出仓库根 `.hygiene.config.json` 的 allowlist。
  验收：记忆 spec §12 Phase A 验收的自动化等价（全量绿；RESOLVE_OR_DROP 进 brief 的单测；ending-report 数值单测）；getBrief 零新增 await 的断言（§11 红线）。
  落地（2026-09-17）：①–⑤ 全部落地——`memory-types` 增 depth/Lesson/FactRecord/EndingReport（含 schema）；`memory-validator` 拒绝 reason 带稳定规则码前缀（`[CODE] `，`rejectionRule()` 解析）+ SETUP_SEED_WITHOUT_INTENDED_PAYOFF 规则；`classifySetup` 增超期第三档（先于前置门）与 heavy 积累门控（ready 无法 reinforce 时 hold 观望）；`lesson-service.ts`（新）拒绝码计数晋升 + 滚动窗口 + brief 排序；`ending-report.ts`（新）确定性聚合，service 在 observeCommitted 检测 `type:"end"` 后 fire-and-forget 写 `ending-report.json`（零 game.ts 改动）；store 增 facts/lessons jsonl 通道与 ending-report 原子写；brief 增 `avoidanceLessons` + [规避清单]/超期语气/「未定回收计划」渲染；story-plan loader 缺 intended_payoff 记 warning。测试拆分完成（4 文件 + test-kit，2421 行原文件删除，allowlist 移除）。偏差：facts/beliefs 配置键（facts.brief_max / beliefs.max_active_per_character）随 MA-B 与其读取者同期加入，避免当前成为死键（记附录 B）。

- [x] **MA-B consolidator 扩展 + digest v2**（记忆 spec §12 Phase B 条目 6–9）
  前置：MA-A。关联：§5/§6/§9/§10/§14；决议 D4/D6。
  要点：① FactOp/BeliefOp/AuditFinding 进 consolidator 输出 schema 与 prompt（`adapters/llm/narrative-consolidator-adapter.ts`）；② validator 扩展 + facts/beliefs 内存与持久化 + audit→lesson 晋升（§7.2 来源 1）；③ fact-retriever + brief 三段渲染（[相关既定事实][角色认知][规避清单]）+ dsl-protocol.txt 一行规则；④ **SNAPSHOT_VERSION 1→2**：`MemoryDigestSchema` 增 facts/beliefs，`src/core/graph/memory-digest.ts` 双向映射扩展（D6：digest 内嵌全文；recentEpisodeIds 仍不入）；⑤ 幂等/去重/预算全链路测试。
  验收：恢复后 facts/beliefs 从 digest 完整重建的单测（新世界快照 v2 可往返）；spec §14 对应层全绿；spec §12 Phase B 的「跑一局」验收归人工清单。
  落地（2026-09-17）：① `FactOp/BeliefOp/AuditFinding` schema（memory-operation）进 consolidator 输出契约与 prompt（旧输出缺段容错为空数组）；② validator 增 `validateFactOp/validateBeliefOp/validateFinding`（证据范围/角色权威/amend 链/correct 目标），`MemoryConsolidator` 增批内预算（establish ≤3、每角色 belief ≤2、findings ≤5，超限拒新），facts/beliefs 影子应用保事务性；③ `fact-retriever.ts`（新）+ brief 增 `relatedFacts/characterBeliefs` + [相关既定事实]/[角色认知] 渲染 + dsl-protocol.txt 规则行；④ **SNAPSHOT_VERSION 1→2**（决议 D4），`MemoryDigestSchema` 增 facts/beliefs 全文（D6），`NarrativeMemoryState` 增 facts/beliefs 段（旧 narrative-state.json 缺段降级为空）；findings 全量落 narrative-ops.jsonl、major+ 自动成 lesson（来源 1）；facts.jsonl append-only 留痕（真源随 state 快照）。⑤ 预算/幂等/digest v2 往返/adapter 容错测试齐。

- [x] **MA-A2 StoryState 瘦身（死字段清除）**
  前置：MA-B（仅为止 D4 版本号表述漂移，无技术依赖）。关联：设计 §3.2；决议 D10；附录 A「open_threads 双台账」挂账清偿。
  背景（2026-09-17 审查）：主 DSL 的 state_patch 应用路径已删除（status.md §80–§81），StoryState 的 canon 记录（与世界层 `world/canon.json` 重名，术语污染）、open_threads（threads 台账已是 owner）、player_profile、characters 的 emotion/current_goal/relationship_to_player/known_facts 均无写入者、运行时恒为初值。设计 §3.2 对 storyState 的定义本就是「reconcile 产物（location/characters/summary）」，瘦身 = 契约代码对齐 spec。
  要点：① `StoryStateSchema` 删 canon/open_threads/player_profile；`CharacterStateSchema` 只留 location；`scene` 不动；② `SNAPSHOT_VERSION` 递增（实际号记附录 B；dev 存档废弃不迁移）；③ 同批死代码清扫：`story/patch.ts`（mergePatches/validatePatch/StoryStatePatch）、`GenerationEnvelope.state_patch`（generator 恒产 `{}`）、BranchManager 的 statePatch 参数——动手前 grep 确认无运行时消费者；④ summarizeState / createInitialState / 测试 fixture（makeRichState 等）同步收缩；⑤ 物品/场景关键细节不加 storyState 结构字段：语义记录由 MA-B facts 承载（evidence 锚定 + scope 检索），汇流确定性等价键如需物品信息从 facts scope 派生。
  验收：grep 死字段（canon/open_threads/player_profile/emotion/current_goal/relationship_to_player/known_facts/state_patch）零残留；快照往返测试更新；全量绿 + 双 typecheck。
  落地（2026-09-17）：StoryStateSchema 收缩为 scene/characters/recent_summary（CharacterState 只留 location）；`SNAPSHOT_VERSION` 2→3（决议 D10，记本附录）；删除 `story/patch.ts`（mergePatches/validatePatch/StoryStatePatch/StoryStatePatchSchema）、`GenerationEnvelope.state_patch`、`BranchCandidate.state_patch` 与 BranchManager statePatch 参数；summarizeState/createInitialState/测试 fixture 同步收缩；state.test/types.test 重写为存活面。验收 grep 零残留（仅存于描述删除行为的注释）。narrative-director-service.ts（946 行）登记豁免，清偿任务 = M4.4。

### P3 编剧与大纲

- [x] **M3.1 OutlineStore port + adapter**
  落地（2026-09-17）：`OutlineOp` 判别联合（add/activate/realize/prune，add 只接受 planned，D5）+ `OutlineStorePort`（getOutline/applyRevision/load）；`OutlineStore` adapter——整批校验（复用冻结谓词 transitionOutlineNode）非法即整批拒绝不落盘、outline.json tmp+rename 原子写、outline.log.jsonl append-only `{revision,ops,reason,at}`、损坏/结构错大声抛错（缺文件=空大纲 rev0）。
  前置：无。关联：§4（冻结）、§9；`src/core/outline/types.ts` 状态机谓词（已冻结，复用不重写）。
  目标：大纲图持久化，修订留痕。
  要点：① `src/core/ports/outline-store-port.ts`：`getOutline(): {nodes, revision}` / `applyRevision(ops, reason): Promise<number>`；`OutlineOp` = 判别联合 add/prune/activate/realize，store 做状态机校验（非法 op 整批拒绝大声抛错）+ 落盘 + 日志；② `src/adapters/storage/outline-store.ts`：`outline.json`（当前全量 + revision，tmp+rename 原子写）+ `outline-log.jsonl`（append-only `{revision, ops, reason, at}`），读损坏大声抛错（真源纪律同快照）；③ 路径常量进 `GAME_STORAGE_LAYOUT`（§9 已冻结的条目）。
  验收：单测——非法迁移整批拒绝且不落盘；日志 append-only 与全量一致；原子写；损坏抛错。

- [ ] **M3.2 编剧初版大纲（OutlineWriter）**
  前置：M3.1。关联：决议 D1；§4；`src/adapters/llm/plot-planner-adapter.ts`（模式样例）。
  目标：用户文本 → 世界设定 + 角色卡 + 初版大纲（一至两个结局）。
  要点：① `src/application/outline/outline-writer.ts`：port `writeOutline({userText, seedStoryLine?}) → WorldDraft`；`WorldDraft = {worldSetting, characters[{id,name,description,spriteBinding?}], outline: OutlineNode[]}`（act 链 + 1–2 个 ending，全部 planned；同地不同阶段的幕节点填同一 `location`，决议 D8）；schema 定义同文件（非冻结契约）；② `src/adapters/llm/outline-writer-adapter.ts`：单次 JSON 调用（json_object + zod + 明确报错「outline 输出解析失败」）；prompt 约束：purpose ≤200 字禁台词（用常量）、至少 2 act + 1 ending、id 唯一、location 为物理地点标签（如「教室」）不写状态细节。
  验收：adapter 单测三例（合法解析 / 非 JSON / schema 拒绝），形态同 plot-planner-adapter.test.ts。

- [ ] **M3.3 世界生成管线 + 直通开玩**
  前置：M3.2、M5.0。关联：§8；决议 D1/D5。
  目标：用户文本 → 编剧 → 落盘 → 直通开玩（无确认闸门，防剧透）。
  要点：① `src/application/world/world-generator.ts`：OutlineWriter → OutlineStore 写入 draft → `world/canon.json` 脚手架（worldSetting + characters，schema 与 M3.6 对齐）→ per-game prompt 文件 `world/prompts/characters.txt + story_line.txt`（由 WorldDraft 渲染）→ 返回 gameId；② prompts 装载优先级：`loadPrompts` 支持 per-game 覆盖（有 `world/prompts/` 对应文件则优先，否则回退全局 `prompts/`）；③ 入口：web `POST /api/worlds {text}` + 首屏最小改（无既有世界时显示描述输入框 + 开局按钮）；CLI `--new-world "<text>"`；gameId 复用 M5.0 通道；④ 生成失败大声报错，不静默回退全局 story_line。
  验收：world-generator 单测（fake writer：落盘文件齐全、outline revision=1、prompts 覆盖生效）；web 路由测试（fake 依赖注入）；真实生成质量归人工清单。

- [ ] **M3.4 大纲动态维护 + realized 冻结**
  前置：M3.3。关联：§4 冻结原则；决议 D5。
  目标：编剧扩展/剪枝前沿；outlineRevision 进快照。
  要点：① 确定性迁移（无 LLM，协调器 openDecision 时机）：场景首个决策节点落成 → 其 outlineRef 节点 activate；游玩进入不同 outlineRef 的场景 → 上一场景节点 realize（instantiatedBy=sceneId）；均走 `applyRevision`；② 后台维护（LLM）：openDecision 收束后 fire-and-forget（互斥链纪律：LLM 链外、落盘入队），outline-writer adapter 增 `maintainOutline({outline, recentSummary, memoryDigest}) → OutlineOp[]`（单次 JSON）；只允许 add(planned)/prune(planned 或未 instantiated 的 active)，store 校验兜底拒绝触碰 realized/pruned；③ `RuntimeMoment.outlineRevision` 接真值：`RunGraphPort` 增只读 `currentOutlineRevision()`（协调器缓存 store revision），Game 构造 moment 时取；④ 场景 outlineRef 绑定按 D5；⑤ outline.json 缺失时的旧单节点种子保留为 dev 回退（测试构造依赖它），记附录 B。
  验收：确定性迁移单测（activate/realize 时机与日志留痕）；维护调用产 op 落盘且 realized 拒改（状态机测试已有，接线上层测试）；快照 outlineRevision > 0 的集成断言。

### P4 导演

- [ ] **M4.1 AgentRunner + 导演骨架与工具集**
  前置：M3.4。关联：决议 D1；§5（三角色表）、§5.3；spec（设计）§3.3 落地注记。
  目标：导演 agent 骨架（工具循环）+ 首批工具；承接汇流判定。
  要点：① `src/core/ports/agent-runner-port.ts` + `src/adapters/llm/agent-runner-adapter.ts`：`run({system, messages, tools}) → {text, toolCalls}` 最小工具循环——不做通用框架；步数上限常量（默认 6，超限强制收束为最终文本输出）；② `src/application/director/director-service.ts`：场景边界/checkpoint 异步触发（fire-and-forget + 诊断告警）；首批确定性工具：`readSceneHistory(sceneId)`（边负载回放投影，复用 serialize*）、`queryCharacterState(characterId)`（入口快照）、`narrowFormModes(modes)`（相位门 → InteractionPolicy.allowed_modes）、汇流判定承接；③ 导演产出 `SceneDirective`（本场景目标/防守节拍/收束压力/表单收窄），会话内工作态，不入图契约；④ 汇流承接取低风险路径：ConfluenceJudgePort 的持有与装配移入导演（bootstrap 接线变化），协调器调度机制与既有测试零改动；⑤ **跨周目事实**（决议 D7）：导演/编剧输入可读全部已实现路径（含已弃周目——`readSceneHistory` 返回该场景全部已实现边，不分周目；NG+ 前世记忆的取材来源）；演员防火墙不变（M4.2 剪报仍是唯一通道）。
  验收：runner 循环单测（fake client：工具调用→执行→二轮文本；超步数收束）；导演服务单测（工具被调、directive 落缓存）；`run-graph-confluence.test.ts` 全绿不动。

- [ ] **M4.2 剪报防火墙**
  前置：M4.1、MA-B。关联：§5.2；反重复地图（context-builder serialize*）。
  目标：演员上下文组装迁至导演剪报，防剧透边界结构性成立。
  要点：① `src/application/director/actor-briefing.ts`：组装演员受限上下文 = canon 场景相关子集 + 当前路径已实现历史 + SceneDirective，**复用 `src/story/context-builder.ts` 的 serialize\*** 与 MA-B 三段渲染函数（随迁宿主，函数不改）；② 防火墙落为**参数形状**而非提示词：组装器输入类型上不含 outline 全量/结局候选/他周目数据；
③ 剪报组装继承决议 D9 布局：历史区保持 append-only 置前、易变区置尾，不引入窗口截断；④ Game→StoryGenerator 上下文供给切换到剪报（本卡建新通道并切换；旧 NarrativeBrief 通道 M4.4 删）。
  验收：单测——生成请求 user prompt 不含未实现 outline purpose 与结局候选文本（负面断言）；有 directive 时含防守/收束段；无 directive 时与现行为等价（回归）。

- [ ] **M4.3 防守节拍**
  前置：M4.2。关联：§5.3；设计 §3.3（拉回 = 汇流的常见情形）。
  目标：离谱输入 → 防守节拍引回（进演出指令，演员执行）。
  要点：① 触发：free_input 解决后（`beginEdge(choice.kind==="free_input")`）导演后台评估输入 vs 当前场景目标（工具：readSceneHistory + SceneDirective）→ 产出 DefenseBeat 写入下一段 directive；② 滞后一拍是有意行为：评估与生成并行，本段按既有 directive 播出，引回作用于下一段（不阻塞生成，红线）；③ 相位门接通：directive.formModes 实际作用到 InteractionPolicy（Game 侧消费点）。
  验收：集成测试（fake LLM/导演）——free_input 后下一段 prompt 含引回指令；choice 不触发；allowed_modes 收窄生效（扩既有 policy 测试）。

- [ ] **M4.4 删除 PlotPlanner / DirectorPlan / NarrativeBrief**
  前置：M4.2、M4.3。关联：§10 映射表；执行规则「不留暂时共存」（阶段内删除）。
  目标：战术规划并入导演编排，剪报取代便签。
  要点：① 删除：`application/narrative/plot-planner.ts` + `plot-planner-adapter.ts`、DirectorPlan 存储通道（director-plan.json）、NarrativeBrief 类型与便签渲染链（facts/beliefs/lessons 三段渲染已在 M4.2 随迁，删的是便签宿主）；导演输入改为携带 anchors/setups 台账（记忆 digest 投影）；② 配置死键清扫：planner 相关键（horizon_checkpoints、replan 节流等）逐键定去留（并入导演节流或删除），记附录 B；③ NarrativeDirectorService 收窄为记忆子层（consolidator/checkpoint/记忆查询），planner 分支与对应测试拆分文件删改；④ story-plan.yaml 作者种子保留（种子的是记忆锚点，非 planner）。
  验收：grep `PlotPlanner|DirectorPlan|NarrativeBrief|director-plan` 零残留；被删配置键有 config 负面断言；全量绿。

- [ ] **M4.5 game.ts 拆分**
  前置：M4.4。关联：附录 A「M4.5 挂项」。
  目标：game.ts 2668 行 → ~1500 行。
  要点：交互驱动（choice/input/hybrid + 两阶段提交）抽至 `src/runtime/`（动手前查 `src/core/interaction`、`src/interaction` 既有内容定归宿）；game.ts 保留 run 循环 + 段生命周期 + 恢复 + 图提交；game*.test.ts 沿同缝对齐（game-graph-restore / game-input / game-interactions + game-test-kit 已在缝上）。
  验收：行为零变化（既有测试只许 import 路径变化）；机械检查通过后把 game.ts 移出 `.hygiene.config.json` 的 allowlist。

### P5 收束与清理（原 M3 后半，按决议 D3 后置）

- [ ] **M3.5 结局驱动收束 + event mode 删除**
  前置：M4.2。关联：§4；决议 D3。
  要点：① 收束压力：导演编排读大纲 ending 候选（导演可见、演员不可见）——当前沿 act 全部 realized 或维护调用判定进入终章时，SceneDirective 增收束指令（方向性指令，不含结局文本）；演员照指令收束 → 既有 reachEnding 链路；② 删除：`narrative.mode` event 分支与 `narrative.event.max_interactions`、forced ending 合成路径、恢复时 interactionCount 清零逻辑（event mode 专属）、event mode 测试；`narrative.mode` 键整体删除（longform 成唯一路径，分支条件消失，记附录 B）；宿主 restart 已是图语义（M1.5），无残留可删；③ config 死键负面断言。
  验收：grep event mode 零残留；收束指令进 prompt 单测（导演在场时）；全量绿。

- [ ] **M3.6 canon 存储 + 晋升流程**
  前置：MA-B（facts）、M4.2（剪报读取方）。关联：§5.1；决议 D6。
  要点：① `src/core/ports/canon-store-port.ts` + `src/adapters/storage/canon-store.ts`：`world/canon.json` + `world/canon-log.jsonl`（append-only 修订留痕）；记录形状：worldSetting / characters / promotedFacts{id, content, evidenceRuns, judgedBy, promotedAt} / exceptions{id, content, reason, compensatingLimit}；② 晋升（后台，周目完结或弃局时触发）：收集**全部周目（含已弃，决议 D7）**末态/游标快照 digest 的 major facts → 编剧调用变体 `adjudicateCanon(candidates) → CanonOps[]`（单次 JSON）裁决 → promote 写 canon+log，矛盾事实过不了门（§5.1），例外登记附补偿限制；③ 读取方：导演剪报与编剧维护输入；晋升不回改既有快照（D6）。
  验收：store 单测（append-only/原子写/损坏拒绝）；晋升管线单测（fake 裁决：双周目同 fact 晋升、单周目不晋升、例外登记留痕）；canon 内容进导演输入断言。

- [ ] **M3.7 删除 story_line 静态注入**
  前置：M3.5、M3.6。
  要点：`loadPrompts` 不再全局必读 `prompts/story_line.txt`（storyLine 只来自 per-game `world/prompts/`；缺失即大声报错——破坏性纪律，无静默回退）；`prompts/story_line.txt` 与相关 dev 注入路径删除；测试 fixture 改用 per-game 文件。
  验收：grep story_line 全局注入零残留；全量绿。

- [ ] **M2.4 末态索引 + 场景间/滞后汇流**
  前置：M3.4（图形态稳定后扩候选）。关联：设计 §3.3 场景间/滞后汇流；附录 A M2.2 细则。
  要点：① 协调器维护末态索引 `Map<sceneId, {decisionId, 摘要键}[]>`（内存，hydrate 从 listDecisions 单点重建——同 ensureSceneNode 模式）；② 候选过滤去掉同场景限制（保留：非路径祖先、非自身、有入边）；确定性预筛限流（location 等价 + 在场角色集合等价优先；`OutlineNode.location` 相同 = 同物理场景不同状态，视为高优先候选——D8，同地不同状态是常见汇流点），预筛通过仍逐个交 judge，置信最高命中走既有 applyConfluenceMatch（守卫与互斥零新机制）；③ 滞后汇流天然获得：新边关闭时对索引全量预筛，旧节点即新边的候选。
  验收：跨场景命中改绑单测；预筛排除不匹配（judge 调用次数断言）；既有 7 例汇流测试零回归。

### P6 图 UI 与结算

- [ ] **M5.1 总览场景图**
  前置：M5.0。关联：§2 术语；可见性 §4（前沿不可见）。
  要点：① web API `GET /api/graph`：场景节点 + 已实现边 + 当前游标 + run 统计；**脱敏**：只返回 realized/active 场景，不含 outline 未来信息；② 前端 `web/src/ui/graph-panel.ts`：最小可视化（场景块 + 连线 + 游标高亮；CSS/SVG 均可，不引入图库依赖；场景块按 `outline.location` 并排分组——同物理场景不同状态并列展示，组内保持剧情时序，决议 D8）；③ 视图模型单测 + app 集成测试（fake 数据）。
  验收：API 脱敏负面断言（响应无 planned/pruned outline 内容）；渲染测试。

- [ ] **M5.2 决策子图展开**
  前置：M5.1。
  要点：点开场景 → 场景内决策节点 + 出边（选择文本）子图；数据复用 M5.1 API（决策粒度一并提供，前端按场景过滤）；交互测试。
  验收：子图渲染测试；未实现前沿不出现。

- [ ] **M5.3 回溯入口 + 同选项快进**
  前置：M5.2。关联：§6；决议 D7；附录 A「M1.5 快进推迟」决议（含 beginEdge 返回形状）。
  要点：① `RunGraphPort` 增 `retraceFrom(decisionId)`（= M1.5 restart 的任意节点版：活跃周目记 `abandonedAt`——**仅流水记账，图零删除**（决议 D7）——并在该节点开 retrace 新周目）；② `beginEdge` 返回判别联合 `{opened} | {fast_forward: RestorePoint}`：选择与既有出边完全一致（kind+text 严格相等）时命中快进；**结局端点不参与**（重选结局选项走新生成，如实留第二条边）；③ Game 快进处理：跳过生成，直接恢复后继节点表单；④ UI：图节点点选 → 回溯确认，文案为「在此分叉开启新周目」（旧周目内容仍是既定事实、导演/编剧继续读取——不用「放弃/删除」措辞）。
  验收：retraceFrom 任意祖先节点单测（abandonedAt 记账 + 新边产生 + 图零删除）；快进命中/未命中/结局排除三例；快进时生成器零调用断言。

- [ ] **M5.4 结算与图鉴**
  前置：M5.1。关联：§6；MA-A ending-report（复用，反重复）。
  要点：① `games/<gameId>/stats.json`：结局达成计数、边通过计数（新 run 首次通过时 +1，重放不重复计）；② 结算页：结局文本 + 伏笔回收率（ending-report 聚合）+ 大纲完成度（realized act / 总 act）；③ 图鉴页：结局列表（未达成显示 "???"，不剧透）；④ API + 页面 + 测试。
  验收：stats 增量与幂等测试；结算聚合单测；图鉴不剧透断言。

- [ ] **M5.5 通关打分 + 大纲回顾解锁**
  前置：M5.4。关联：§4 可见性（通关后解锁）；§8（评价喂回编剧）。
  要点：① 结局后评分：玩家星级 + 编剧评注（单次 LLM 调用：输入末态 digest + ending-report，输出评语与大纲贴合度）→ `games/<gameId>/reviews/<runId>.json`；② 评价喂回：编剧维护调用输入携带历史评注；③ 大纲回顾：通关后 `GET /api/graph` 增返该周目路径触及的 outline 节点与已达成结局，按 `location` 并排分组（D8）；未通关不返回（负面断言）。
  验收：评分落盘与喂回输入包含断言；未通关 outline 泄漏负面断言。

- [ ] **M5.6 图维护（不可达内容 GC；无玩家删除入口）**
  前置：M5.2。关联：§7（2026-09-16 修订，决议 D7）；附录 A「孤儿 decision」挂账（本卡清偿）。
  要点：① 协调器内部 GC，**仅回收不可达内容**：孤儿 decision（putDecision 后 putEdge 前崩溃窗口）、被汇流改绑取代的孤儿节点、孤儿 payload；级联规则：入边归零的下游递归回收，共享节点自然存活；不回滚 canon/stats/runs；② **保护不变量**：被任何周目路径（含已弃周目）到达过的节点与边不可回收——负面测试锁定；③ 存储层：JSONL latest-wins tombstone 行（adapter 增 remove* 方法，磁盘记录加 deleted 标记；§3 契约 schema 不动，记附录 B）；④ **不提供任何玩家删除 UI**（决议 D7：已演出内容 = 冻结事实；存储增长是接受成本）。
  验收：级联单测（共享存活、独占回收、幂等）；「已到达内容不可回收」负面测试；孤儿清理（挂账清偿）。

### 门（每阶段末，逐个勾选）

每道门 = `npm test` + `npm run typecheck` + `npm run build` 三绿 + repo-hygiene 机械检查通过，再触发该 skill 的**完整档**执行：机械检查之外，必须把 SKILL §B 的 subagent 只读评审 prompt 原样派发出去，P1/P2 问题当场修复。快速档（仅 §A + 新文件过目）每 3–4 张卡跑一次，同由该 skill 承载；阈值与豁免以仓库根 `.hygiene.config.json` 为准。skill 为用户级安装，未安装环境按本段要点降级执行（三绿 + 行数/标记扫描 + 七条 subagent 评审）。

- [x] **GH-P1**：无附加项。（2026-09-17 过门：三绿 + 机械检查 + subagent 评审 16 条，P2 当场修复、P3 记附录 B）
- [x] **GH-P2**：narrative-director-service.test.ts 豁免移除；getBrief 零 await 断言在位。（2026-09-17 过门：三绿 + 机械检查 + subagent 评审 17 条，P2 当场修复、P3 记附录 B）
- [ ] **GH-P3**：世界生成无确认闸门行为核对；outline 冻结原则测试在位。
- [ ] **GH-P4**：M4.4 grep 清单清零；game.ts 豁免移除；`src/application/director|world|outline` 新目录进依赖方向评审。
- [ ] **GH-P5**：event mode / story_line grep 清零；config 死键负面断言齐。
- [ ] **GH-P6**：`GET /api/graph` 脱敏负面断言齐；stats 幂等。
- [ ] **GH 终检**：全部任务卡与门勾选或登记 BLOCKED；三命令全绿 + repo-hygiene skill 完整档最后一遍；`docs/status.md` 全面同步；第 6 节人工清单整理移交。

## 5. 反重复地图（动手前必查）

| 需求 | 不要新建 | 复用 |
|---|---|---|
| 剧情事件持久化 | 独立事件日志 | 边负载 `payloads/<edgeId>.jsonl` |
| 恢复 / 交接 | RUN_MEMORY 类记忆文件 | 决策节点入口快照（派生缓存须可丢弃） |
| 状态摘要 | 新的状态机 | `story/reconcile` + VisualState + MemoryDigest |
| 演员上下文 / 剪报 | 第二套序列化器 | context-builder 的 serialize\* |
| 伏笔 / 线程台账 | 大纲内重复维护 | setups/threads 台账，大纲只引用 id + 回收窗口 |
| 世界真理 | 各路径抄写事实 | canon + 引用制（D6 落地细则） |
| 图鉴 / 统计 | run 实体数据库 | stats 计数器 + ending-report 聚合 |
| 相位门 | 新 policy 系统 | InteractionPolicy.allowed_modes 收窄 |
| 汇流 | 图重写逻辑 | 边→既有节点匹配不变量（§3.3） |
| LLM 调用 | 多套 client | 演员/编剧/导演/判定 = 同一 openai-compatible client（D1） |
| 伏笔回收率结算 | 第二套聚合 | MA-A ending-report |
| 会话恢复 | 扩展 v1 restore | v1 restore 冻结，由节点快照取代（M1.4 已落地） |

## 6. 人工验证清单（不在自主实现范围，不阻塞勾选）

1. **M2.3 汇流端到端**（前置 P4 完成）：真实 LLM 会话——离谱输入 → 防守节拍引回 → 图上呈现汇流（`games/<gameId>/graph/edges.jsonl` 出现 confluence 凭据）；检查 `narrative.confluence.enabled: true` 的实际效果与判定质量。
2. **MA Phase A/B 验收**（记忆 spec §12「跑一局」项）：超期伏笔 RESOLVE_OR_DROP 出现；结局 ending-report.json 数值与体感一致；事实/认知边界端到端。
3. **M3.3 世界生成质量**：真实描述 → 大纲/角色/开场可玩性、防剧透直通体验。
4. **M5 图 UI 手测**：总览（含同物理场景并排分组）/子图/回溯/快进/结算全流程。

---

## 附录 A. 历史实施记录（M0–M2.2，只读）

> 以下为已完成的实施记录与设计细化决议，**仍然有效**（源码注释按编号引用本附录），不要据此改代码。

### 执行规则（原版，2026-09-09；纪律部分已并入第 1 节执行协议）

1. 动手前先查「反重复地图」（现第 5 节）。
2. 卫生门强制：GH-1（代码卫生）与 GH-2（文档卫生）未过，不开下一阶段。
3. ⚠ 标记 = 高风险项：先做设计细化或 spike，再动代码。
4. 破坏性重构：不留兼容层；被替换系统在所属阶段内立即删除。
5. 里程碑完成即 commit（main），不攒大包。

### M0 基线与契约冻结 ✅（2026-09-09）

- [x] M0.1 基线验证：`backup/pre-v2-prototype` 存在；main 全量测试 + 双 typecheck 绿（基线 1330 测试 / 86 文件）
- [x] M0.2 图契约代码化：`src/core/graph/types.ts`——SceneNode / DecisionNode / PlotEdge / EndingNode / RunRecord / ActiveCursor / StateSnapshot（zod schema + 类型），单测覆盖解析与拒绝
- [x] M0.3 大纲契约代码化：`src/core/outline/types.ts`——OutlineNode / 状态机（planned→active→realized；pruned），单测
- [x] M0.4 ID 规则与存储布局常量：`src/core/graph/ids.ts`（前缀 schema + GAME_STORAGE_LAYOUT + 边负载/快照路径函数）
- [x] **GH-0 卫生门**：1380 测试全绿（+50）、双 typecheck ✓、build ✓；无被替换系统残留；architecture.test 随全量通过

### M1 图存储内核 + 演员接图（存档读档闭环）✅（2026-09-14 过门）

- [x] M1.1 ⚠ 设计细化：记忆子层 v2 持久化（决议见下方「M1.1 设计细化」）
- [x] M1.2 GraphStore port + JSON/JSONL adapter（§9 布局）
- [x] M1.3 演员接图：段事件 → 边负载；交互开启 → 决策节点 + 入口快照；交互解决 → 出边 + 末态快照
- [x] M1.4 ✅ 游标与恢复：cursor.json；「继续游戏」= 载入节点入口快照重建运行时；落地形态见「游标恢复的三态入口」；恢复集成测试：协调器 6 例 + Game 真存储跨重启 2 例 + 守卫回归 1 例
- [x] M1.5 ✅ 新周目入口：root 开局 / retrace（弃局活跃周目 abandonedAt=游标位 → 游标节点开 retrace 新周目，CurrentRun 携带 origin，结局回写不覆盖来源 → 表单重放）；bootstrap `restart()`（restart_session 指令路径）以 runMode="restart" 重建。同选项快进推迟到 M5.3
- [x] M1.6 ✅ 删除：sessions JSONL store；`sessions_dir` 配置保留（narrative memory 会话文件仍用）。event mode / forced ending 暂留（M3.5 删）
- [x] **GH-1 + GH-2**（2026-09-14 过）：1408 测试 + 双 typecheck + build 绿；死代码零残留；单一真源成立；architecture.test 递归覆盖 core/graph、core/outline；config 无死键；偏差回写 spec §3；status.md 同步

#### M1.1 设计细化（2026-09-13 决议）

**真源层级**（恢复路径按此读取，不越级）：

1. `graph/snapshots/<decisionId>.json` = 运行时状态**唯一真源**（story + visual + memoryDigest）。「继续游戏」只读这里。
2. `graph/payloads/<edgeId>.jsonl` = 回放数据（UI/结算/审计），不是记忆真源。记录形状 = `StoredEvent` 直接逐行落盘。
3. `world/canon.json`（M3.6 落地）= 跨周目世界真理。
4. NarrativeMemoryStore 会话文件 = **工作缓存**（可丢弃可重建）：narrative-state.json 恢复路径不读；episodes.jsonl 恢复后从空积累；director-plan.json 维持现状到 M4.4。

**digest ↔ NarrativeMemoryState 纯映射**（`src/core/graph/memory-digest.ts`）：`memoryDigestFromState` 丢 recentEpisodeIds；`memoryStateFromDigest` 重建为 []。周目内记忆随快照走，跨周目事实走引用（引用制落地细则见交付版决议 D6）。

**NarrativeDirectorPort 扩展**：`getMemoryDigest()`（交互打开瞬间嵌入入口快照）；`restoreFromDigest(digest)`（恢复路径替代 initialize() 的 load 分支）。

**恢复点语义**：恢复 = 回到游标决策节点入口。孤儿 payload 文件恢复时删除。首个决策点之前崩溃 → 无恢复点，重开新周目（dev 接受）。

**快照复用不变量**：下一决策点入口快照 = 前一条边 endState（同一次快照写两处）；ending 收束时 endState 单独捕获。

**恢复时的记忆追赶**：快照 digest 的 consolidatedThroughEventSeq 之前的已整理、之后的未整理。恢复路径把**根→游标全路径边负载**重喂 `director.observeCommitted()`——内部按 `seq > watermark` 过滤，只入队未整理窗口（2026-09-14 修正：只喂入边会丢祖先边未整理窗口；全路径喂入在水位之下无害）。已知洞（dev 接受）：开局段事件不入图，其未整理残余恢复时不可回收。

**场景节点判定（M1 无编剧过渡）**：`StoryState.scene.id` 首次出现 → 建 SceneNode（active）；种子大纲单节点作 outlineRef。realized 迁移 M3.4 落地。

**seq / turn 连续性**：契约不加字段。恢复 `nextSeq = max(路径末事件 seq, digest 水位) + 1`（2026-09-16 M2.1 升格为含世界最大 seq 的统一公式，见附录 B）；turn 取路径末事件 turn，首决策为 1。

**游标恢复的三态入口（M1.4 落地形态）**：`RunGraphPort.restoreOrCreateRun(): RunResume`——fresh（无存档）/ active（游标恢复点：decision + pathEvents + nextSeq/turnFloor；协调器水合状态机、清孤儿 payload）/ ended（最新周目已完结：补发 session_ended，结局文本从末边负载回收）。多入边节点取 payload.lastSeq 最大者。Game 删除 v1 遗留 resumeInteraction 字段；恢复时 interactionCount 清零（event mode 计数，随 M3.5 删）。

### M2 汇流（M2.1/M2.2 ✅ 2026-09-16）

- [x] M2.1 ✅ ConfluenceJudge port（§3.3 冻结签名：`judge({endState, candidateEntry}) → {equivalent, confidence, rationale, judgedBy}`；候选枚举是调用方确定性职责）+ 首个 LLM adapter（json_object + zod）。A2 seq 决议：统一 `max(世界最大 seq, 路径末, 水位) + 1`（见附录 B 2026-09-16 条）
- [x] M2.2 ✅ 场景内汇流：边收束后后台判定（候选 = 同场景、有入边、不在当前路径），置信最高命中改绑（入边改指候选 + 凭据 + 真实末态内联；出边改源；游标仍停新节点时前移）。promise 链互斥（判定在链外）。守卫：换周目/已完结放弃；apply 时重验祖先。落地细则见附录 B 2026-09-16 M2.2 条

### 卫生门清单（原 GH-1/GH-2 定义；由 repo-hygiene skill 承载并扩展；2026-09-16 自仓库内文件迁移为用户级 skill）

**GH-1 代码卫生**：全量测试 + 双 typecheck + build 绿；死代码清扫（对照反重复地图右列 grep）；单一真源核对；architecture.test 依赖方向覆盖新目录；config 无死键。
**GH-2 文档卫生**：status.md 与实际一致；偏差入册、重大偏离回写 spec；§N 引用可解析；勾选状态与实际一致。

## 附录 B. 偏差记录（实施中追加）

- 2026-09-09（M0）：tsconfig 开启 `exactOptionalPropertyTypes`，zod 可选字段必须用 `z.exactOptional(...)`（memory-types 既有惯用法）。M1 起所有含可选字段的持久化 schema 一律遵循。`StateSnapshot.snapshotVersion` 为 `z.literal(1)`，测试构造非法版本需 `as Record<string, unknown>` 绕开类型层。
- 2026-09-13（M1.3）：契约修订（M0 契约尚无落盘数据，SNAPSHOT_VERSION 仍为 1）——`InteractionFormSnapshot` 增加 `prompt` 必填字段：恢复重放表单需原样还原提示语。已回写 spec §3。
- 2026-09-13（M1.3）：`SceneNode` 延迟到首个决策点才落盘（场景与决策 1:1 惰性创建）；模型场景 id → SceneNode 映射靠扫描决策入口快照重建；无决策的场景不留图记录（M1 接受）。
- 2026-09-14（M1.4）：修复 `isStoredEvent` 的 v1 潜伏 bug——存储行外层信封使 `type:"interaction"` 事件永远无法通过 strictObject 校验；v2 边负载回放使其成为承重数据。修复：校验前剥离信封字段。
- 2026-09-14（M1.4）：`StoryStateSchema.scene.time` 与 `CharacterStateSchema` 可选字段从 `.optional()` 迁移到 `z.exactOptional(...)`（zod 惯例补齐），无运行时语义变化。
- 2026-09-14（M1.4）：删除 v1 遗留 `Game.resumeInteraction`；bootstrap 增加 `options.gameId`（世界身份跨启动固定，缺省每次新世界）。
- 2026-09-14（M1.5）：`GamePorts.runMode` + `restoreOrCreateRun({restart})`；`CurrentRun` 携带 origin（修复 reachEnding 硬编码 root 覆盖 retrace 来源的真 bug）；`listRuns` = latest-wins 折叠按最后写入排序。已知留痕缺口（dev 接受）：首决策点之前 restart，旧 root run 无 abandonedAt 可记。
- 2026-09-14（M1.5）：同选项快进推迟到 M5.3——restart 只回溯游标节点（恒无出边），快进不可达；实现即死代码。
- 2026-09-13（M0 契约审查）：修复 3 处——① `PlotEdge` 补 refine（confluence ⟹ to 为 decision 且 id === matchedNode）；② `RunRecord` 补两个 refine（ending⟹endedAt；abandonedAt⟹无终态）；③ `instantiatedBy` 收紧为 SceneIdSchema。保留项（有意不改）：open_threads 与 digest.threads 双台账（M4 统一归属）；payload 统计不设连续性不变量；表单 options ≥1 宽于运行时 ≥2；matchedNode 与 to.id 冗余（凭据自含 + refine 交叉校验，冗余即哨兵）。
- 2026-09-15（M2 前置修订 A1）：存储适配器 endState 内联条件由「仅结局端点」放宽为「结局端点 ∨ 汇流边」——原 exact-相等门禁与 §3.3「末态 ≈ 入口态」正面矛盾。修订后：汇流边内联真实末态、免相等门禁，凭据承担差异审计；普通决策端点门禁不变。
- 2026-09-15（审查记档，不修）：孤儿 decision（putDecision 后 putEdge 前崩溃窗口产物）暂不清理；M5.6 DeleteBranch 提供原语后一并处理。
- 2026-09-16（M2.1，A2 决议）：seq 播种统一 `nextSeq = max(世界最大 seq, 路径末事件 seq, digest 水位) + 1`，fresh 与 retrace 同式。世界最大 seq 取各边 payload.lastSeq 最大值。理由（正确性）：M2.2 多入边成真后，seq 回绕会让 pickLatestInEdge 选错边、让水位过滤静默丢弃整段新分支。载体：`RunResume` fresh 变体增 nextSeq 字段（运行时端口类型，非 §3 冻结 schema）。
- 2026-09-16（M2.2）：**场景节点世界级稳定修订**——原实现仅恢复路径重建场景缓存，fresh 新 root 周目会为同一模型场景重复建节点，跨周目汇流的同场景候选过滤会整体失效。修复：`ensureSceneNode` 收口为缓存 → 扫既有决策入口快照 → 惰性创建。
- 2026-09-16（M2.2 落地细则）：① 改绑窗口守卫（判定落地时创建周目已完结/已换周目即放弃）；② 候选排除无入边节点（孤儿与周目首节点，dev 接受）；③ apply 时重验祖先（悬置期间路径可能变化）；④ `narrative.confluence.enabled` 配置门控（默认关，测试/CI 零网络）；⑤ 图变更加 promise 链互斥（LLM 判定在链外）。
- 2026-09-16（交付版重整）：清单重写为一次性自主执行的交付版。变更：任务卡按依赖重排（决议 D3：M5.0 提前；M3.5/M3.6/M3.7 后置到 M4 后）；pi 框架决议 D1（作者 2026-09-16 确认不使用，已回写 spec §5）；M2.3 归人工清单（D2）；SNAPSHOT_VERSION 1→2 预授权（D4）；场景→大纲绑定规则（D5）；digest 事实嵌入制（D6，M1.1 引用制的落地细则）。新增卫生体系：`docs/skills/repo-hygiene/SKILL.md`（快速档/完整档 + subagent 评审模板）+ `npm run hygiene`（`scripts/hygiene-check.mjs`，行数阈值 + 临时标记，豁免清单含清偿任务号）。历史记录整体迁入附录 A/B，编号不变。
- 2026-09-16（卫生体系迁移至用户级）：移除 `docs/skills/repo-hygiene/SKILL.md`、`scripts/hygiene-check.mjs` 与 `npm run hygiene`，卫生自检改由用户级 `repo-hygiene` skill 承载（`~/.agents/skills/repo-hygiene/`，任意仓库可用），门定义由四绿改为三绿 + skill 机械检查。本仓库校准值迁至仓库根 `.hygiene.config.json`（阈值 + 豁免，含清偿任务号）与 `.hygiene-baseline.json`（标记基线 19）。
- 2026-09-16（回溯与删除语义修订，作者发起，决议 D7）：原 §7「玩家删除决策 + 级联 GC」整体移除——已演出内容是冻结事实，删除致跨周目一致性失真；§7 重写为不可达内容内部 GC（无玩家入口），M5.6 改为「图维护」卡；回溯（M5.3/M1.5）语义澄清：`abandonedAt` 仅流水记账、图零删除；导演/编剧输入显式包含全部已实现路径（含已弃周目，spec §5.1 注记；M4.1 ⑤ / M3.6 晋升范围同步）。
- 2026-09-16（相同物理场景不同具体状态，决议 D8）：§4 `OutlineNode` 增可选 `location`（物理地点标签，演化区字段，outline.json 尚无落盘数据、零迁移；`src/core/outline/types.ts` 已同步 + 测试）。建模分工：同幕内状态漂移由决策入口快照承载；跨幕同地不同阶段 = 多幕节点共享 location，总览（M5.1）与通关回顾（M5.5）按它并排分组；M2.4 汇流预筛将其列为高优先候选。

- 2026-09-17（演员上下文布局修订，作者发起，决议 D9）：`buildDslUserPrompt` 段落重排为「稳定 → 易变」
（历史/素材前置、任务头置尾），删除 `game.history_events`（schema、config.yaml、全部 fixture/断言）；
目的 = provider 前缀缓存命中（相邻请求共享「系统提示 + 历史 + 素材」前缀，回溯 = 重放天然截尾）。
基线由 1421 测试更新为 1422 测试（布局顺序断言重写）；规范回写 llm-outputs-refactor §70。
- 2026-09-17（GH-P2 卫生门）：subagent 只读评审 17 条（P2×5、P3×12，无 P1）。**P2 当场修复**：① `MemoryConsolidator.consolidate` 按 op 类别拆出 filterThreadOps/filterSetupOps/filterFactOps/filterBeliefOps/collectFindings 五个私有方法；② `runConsolidatePending` 的 shadow 应用段抽为 `applyOutcomeToShadow`；③ json 记忆存储三处 tmp+rename 原子写抽 `writeAtomic`，episodes/ops 旧读写并入泛化 jsonl 通道，`writeEndingReport` 接线 `EndingReportSchema` 校验；④ 死导出 `VALID_SETUP_TRANSITIONS` 删除（与 validator 规则漂移，validator 为唯一真源）；⑤ `state.ts` 的 serializeState/deserializeState/saveStateSnapshot 生产零引用，删除（序列化已由图存储接管）。**P3 记档**：getBrief/classifySetup/plot-planner.plan 函数长度与 directive 字面量重复；ACTIVE/TERMINAL 状态集合双声明（memory-validator 与 memory-consolidator）；service 的 MemoryConsolidatorPort 兼容 re-export；config 默认值三处派生；THREAD_CREATE_MISSING_FIELDS 与 zod superRefine 重复校验；hasConsolidator/hasPlanner 双层守卫；consolidationPromise 非空组合静默兜底；apply*OpToState 对无实体 op 静默 no-op；types.ts legacy ChoiceEvent 分支与半改残缺注释；testing.ts 硬编码版本号（应引 SNAPSHOT_VERSION）——除已随手修复的注释/孤儿项外，其余待后续卡顺带清偿。
- 2026-09-17（MA-A2 落地，D10 执行）：`SNAPSHOT_VERSION` 2→3——StoryState 契约收缩为 reconcile 投影产物（scene/characters/recent_summary），canon/open_threads/player_profile/角色 emotion·current_goal·relationship_to_player·known_facts 死字段清除；StoryStatePatch/patch.ts/GenerationEnvelope.state_patch/BranchCandidate.state_patch/BranchManager statePatch 参数整体删除；物品/场景关键细节语义由 MA-B facts 承载（P2 要点 ⑤），汇流等价键如需从 facts scope 派生。dev 存档废弃不迁移。
- 2026-09-17（MA-B 落地，D4 执行）：`SNAPSHOT_VERSION` 1→2——`MemoryDigest` 增 facts/beliefs 全文嵌入（决议 D6：恢复不依赖 canon 可用性）；旧 v1 快照读取即拒（zod literal 不匹配走结构损坏路径），dev 存档废弃不做迁移。facts.brief_max / beliefs.max_active_per_character 配置键随读取者同期就位（MA-A 偏差 ① 的清偿）。dsl-protocol.txt 增一行事实/认知边界规则。
- 2026-09-17（MA-A 落地）：记忆 spec Phase A 五项全部落地（depth/RESOLVE_OR_DROP、intendedPayoff 硬拒 + author warning、ending-report 异步聚合、lessons 拒绝码计数自动晋升 + brief 规避清单、facts/lessons jsonl 通道）。偏差两条：① 拒绝 reason 引入 `[CODE] ` 稳定规则码前缀（§7.2 来源 2 的计数键；人话部分未变）；② facts.brief_max / beliefs.max_active_per_character 配置键随 MA-B 与其读取者同期加入（避免阶段内成为死键）。`narrative-director-service.test.ts` 沿子系统缝拆分为 lifecycle/consolidation/brief/replan 四文件 + `narrative-director-test-kit.ts`，allowlist 移除。
- 2026-09-17（StoryState 瘦身立项，决议 D10）：审查确认 StoryState 富字段（canon/open_threads/player_profile/角色 emotion·current_goal·relationship_to_player·known_facts）自 state_patch 应用路径删除后无写入者（status.md §80–§81 记录）。立项 MA-A2 卡（P2，置于 MA-B 之后），`SNAPSHOT_VERSION` 再递增获预授权；同批清扫 patch.ts 与 GenerationEnvelope.state_patch 死代码。物品/场景关键细节的语义记录归 MA-B facts 承载，不进 storyState 结构字段。
- 2026-09-17（GH-P1 卫生门）：subagent 只读评审 16 条（P2×5、P3×11，无 P1）。**P2 当场修复**：① `create-runtime-application.ts` 主函数拆出 `selectTtsProvider`/`buildAudioStack`/`buildGraphCoordinator`，导出 `DEFAULT_GAMES_ROOT`（web.ts 不再硬编码 "games"）；② `requestDslEnvelope` 拆出 `buildStreamRequest`/`buildRepairInstruction` 方法与 processDslLine/flushTruncatedTail/finalizeAttempt 具名闭包（尾冲嵌套 5 层→早返回）；③ `media.audio` V1 平面字段全删（enabled/provider/active_target_lines/refill_threshold_lines/branch_prefetch_lines/batch_size/max_concurrency/mock_latency_ms/output_dir——生产零读取的死键，config 无死键纪律），同批清 `mergePatchesList` 死代码与 `CreateRuntimeApplication` 死导出。**P3 记档（待后续卡顺带清偿，不阻塞）**：cli.ts `printMetrics` 死参数 game 与 reduce 求均值 ×3；web/cli `parseArgs` 近重复；last-game.test 临时目录模板 ×6；config 默认值在 zod `.default` 与代码 `??` 多处派生（含 bootstrap 兜底 cosyvoice_v3_flash/22050/2）；`interaction.default_mode` 校验但运行时不消费的死键；`makeCtx(null as unknown as StoryState)` 类型欺骗（buildSystemContext 入参应收窄）；GeneratorPortFacade 5 处条件展开；`confluence?.enabled` 可选链与类型矛盾；MediaPlannerPort `isReady`/`waitUntilReady` 过渡桩。基线 1434 测试 / 97 文件。
