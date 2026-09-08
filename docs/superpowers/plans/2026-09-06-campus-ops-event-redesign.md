# 校园技术社团值班体验分支实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 LLM GalGame 框架之上，建立一个以 BITNP 树莓娘为核心、围绕校园技术社团日常事务展开的开放叙事可独立体验分支：每局从一个可选叙事种子开始，但种子只提供起点，不锁定过程或结局；同时保护 `main` 上的通用引擎、长线剧情记忆和存档发展。

**Architecture:** 先把通用框架能力与校园内容分层。现有 DSL 流式生成、choice/hybrid/input、分支预取、自由输入、`narrative.mode: event`、无限互动（`max_interactions: 0`）和 `restart_session` 优先复用，不重新发明一套短局引擎。若审计发现需要“向 opening 注入一个外部场景/事件上下文”这类通用能力，则单独形成可回流 `main` 的最小提交；校园分支只提供事件目录、提示词、人设、资源映射和展位配置，不把校园规则写进通用运行时。

**Tech Stack:** TypeScript、Node.js 20+、Zod、YAML、Vitest、现有 Gal DSL / WebSocket / Web UI / TTS。

**Spec:** `docs/superpowers/specs/2026-09-06-campus-ops-event-design.md`

## Global Constraints

- 本计划只规划，不在当前 `main` 上直接实施校园内容；执行时从 `main` 创建独立功能分支，建议名为 `feat/campus-ops-raspberry`。
- `main` 必须继续作为通用框架和长线剧情开发主线，保留 narrative director、story-plan、记忆、存档、通用 UI/runtime 能力。
- 不将固定 3–5 分钟、固定四轮、固定事件数量、固定结局数量写成协议或引擎硬限制；这些只能作为展位运营观察值。
- 事件可自然进行多轮互动；`max_interactions: 0` 继续表示不限制，若未来需要防止异常循环，只增加通用的可选保护机制，不把它当作正常剧情节拍。
- 校园事件必须独立可开始，但不要求每个事件使用同一套严格模板；事件目录提供素材和意图，LLM 在边界内自由组织过程与结尾。
- 自由输入继续遵守现有语义：它是玩家表达、提问或提出方案，不能直接把“已获得权限”“文件已恢复”等声明变成事实。
- 树莓娘的人设分为“BITNP 已核对事实”和“本项目演绎选择”，不可把未经确认的温柔、傲娇、发色、服装细节宣称为官方完整设定。
- 未获得明确授权前，不复制 BITNP 私有仓库的角色分层部件、Godot 场景、Live2D 文件或其他美术资源；公开仓库无 SPDX license 也不等于可直接再分发。
- 保留当前工作区已有的 `.gitignore` 修改；执行前必须记录并隔离用户已有改动，不得覆盖、回滚或混入功能提交。

## 当前事实基线

截至 2026-09-06 已核对：

- 当前 checkout 在 `main`，与 `origin/main` 对齐；工作区已有 `.gitignore` 修改以及本轮计划/规格文档未跟踪文件。
- 本地 `gh` 已登录 `modenicheng`，可以读取 BITNP 组织仓库。
- `BITNP/bitnp-ai-vtuber` 为公开仓库：README 称树莓娘是网络开拓者协会看板娘；公开 prompt 描述兔耳、粉红色连衣裙、协助新成员面试，并包含技术分享和面捕、Live2D、TTS、LLM、ASR 等技术语境。
- `BITNP/bitnp-desktop-pet` 为公开仓库，包含基本相同的树莓娘 prompt 和桌宠工程。
- `BITNP/bitnpResource` 为公开素材仓库，包含圆形带字树莓 logo、技术部圆形 logo、电脑诊所圆形 logo 等。
- `BITNP/bitnp-design` 为公开设计仓库，README 给出网协主题色 `#da751d`，并包含 `徽章/2024/树莓娘-粉.png`、`树莓娘-紫.png`、`树莓娘-蓝.png` 等文件以及 Clinic 设计资料。
- `BITNP/bitnp-raspberrygirl-vtuber-frontend` 当前账号可读取但为私有仓库，包含 `raspberry_girl.tscn` 和分层 `parts/*`，仓库元数据没有显示明确开源许可证。
- 当前项目 `assets/resources.yaml` 只有苏遥/林澈和校园/地下背景；当前项目的树莓娘素材不能假定已经存在。

## 分支与提交策略

### 分支拓扑

1. 执行开始时以 `main` 的明确基线创建 `feat/campus-ops-raspberry`；不在 `main` 工作区直接替换 prompt、资源或配置。
2. 先完成“框架能力审计”。如果已有框架足够，校园分支只改内容和配置；不要为了形式新建通用抽象。
3. 如果缺少可复用的场景注入能力，先从 `main` 创建一个小型 `feat/core-scenario-context` 分支，只实现通用 API、测试和文档，合并回 `main` 后再把校园分支 rebase/cherry-pick 到新基线。
4. 校园分支只消费已合并的通用能力，专属提交不回写到 `main`，除非后续确认它确实适用于长线作品。

### 提交分层

- `core:`：不出现树莓娘、BITNP、校园具体服务或展位文案，可回流 `main`。
- `campus:`：校园技术部、七类服务、活动池、树莓娘演绎和展位配置，只留在功能分支。
- `asset:`：授权通过后才提交的组织/角色资源，并附资源来源记录。
- 计划、规格、现场运行文档单独提交，不和代码/素材混在一起。

执行前要先处理当前未跟踪计划/规格文件的归属：可以将它们作为规划提交放到功能分支，也可以在创建分支后再添加；无论选择哪种方式，都不能把 `.gitignore` 的用户改动带入提交。

## 文件边界

### 可能回流 `main` 的通用文件

只有审计确认需要时才修改：

- `src/core/ports/story-generator-port.ts`
- `src/adapters/llm/openai-compatible-generator.ts`
- `src/story/context-builder.ts`
- `src/game.ts`
- `src/story/state.ts`
- 对应 `src/*test.ts`
- `README.md` / `docs/status.md` 中与通用 event mode、restart、DSL 的说明

### 只属于校园功能分支的文件

- `prompts/characters.txt`
- `prompts/story_line.txt`
- `prompts/guideline.txt`
- `prompts/author.yaml`
- `prompts/instructions.yaml`
- 新增的校园事件/活动资料文件（最终路径依据审计决定，可放 `prompts/campus-ops.yaml` 或 `content/campus-ops.yaml`）
- `config.yaml` 中校园展示所需的 event 配置、默认角色和音频开关
- `assets/resources.yaml` 中树莓娘及获授权的组织/活动资源
- 现场文档和展位文案

### 暂不应改动的内容

- `story-plan.yaml`、narrative director 实现和长线记忆存储，除非发现通用 bug 且单独提交到 `main`。
- 现有苏遥/林澈 fixture 和旧架构兼容测试，除非测试本身需增加新的可选字段。
- 真实校园服务、镜像源、云盘、面试、工会系统的线上 API；本游戏只模拟事务，不执行运维。

## Task 0: 建立基线并完成分支隔离

**Files:**
- Inspect only: `.gitignore`, `git status`, `git log`, `git worktree list`
- Create branch: `feat/campus-ops-raspberry`（执行阶段，不在当前计划撰写阶段创建）
- Create/Modify: `docs/superpowers/notes/campus-ops-source-audit.md`

**Interfaces:**
- Produces a recorded baseline commit SHA, branch topology, dirty-file list, and the disposition of each uncommitted file.
- Produces a source-audit note listing facts, assumptions, authorization questions, and links to exact BITNP files/commits.

- [ ] **Step 1: 记录当前基线，不清理用户改动**

```bash
git status --short --branch
git log -1 --format='%H %D %s'
git worktree list
```

Expected: `main` is identified; `.gitignore` and planning files are recorded as pre-existing/uncommitted and not reset.

- [ ] **Step 2: 在隔离 workspace 创建功能分支**

优先使用 harness 的 worktree；若没有可用 native worktree，按 `using-git-worktrees` skill 先确认 `.worktrees` 是否已被 ignore，再创建 `feat/campus-ops-raspberry`。不要直接在带有 `.gitignore` 用户修改的 main checkout 里切换并开发。

- [ ] **Step 3: 安装依赖并跑干净基线**

```bash
npm install
npm test
npm run typecheck
```

Expected: 基线测试结果被写入审计记录；若基线失败，暂停校园改造并先报告失败，不能把基线失败伪装成新功能问题。

- [ ] **Step 4: 记录 BITNP 来源和授权状态**

在 `docs/superpowers/notes/campus-ops-source-audit.md` 记录至少：

- `BITNP/bitnp-ai-vtuber` 的 README 与树莓娘 prompt 路径、commit SHA；
- `BITNP/bitnp-desktop-pet` 的对应 prompt 路径、commit SHA；
- `BITNP/bitnpResource` 的树莓 logo/部门 logo 路径、commit SHA；
- `BITNP/bitnp-design` 的主题色、2024 树莓娘徽章路径、commit SHA；
- 私有 `bitnp-raspberrygirl-vtuber-frontend` 的资源路径和“未发现明确 license”的结论；
- 每项资源是否“可读取”“可引用”“可打包再分发”，未知项明确标为待确认。

### Task 1: 审计现有框架，决定是否需要通用改动

**Files:**
- Inspect: `src/game.ts`
- Inspect: `src/core/ports/story-generator-port.ts`
- Inspect: `src/adapters/llm/openai-compatible-generator.ts`
- Inspect: `src/story/context-builder.ts`
- Inspect: `src/config.ts`
- Inspect: `src/bootstrap/create-runtime-application.ts`
- Inspect: `src/hosts/local-web/runtime-websocket.ts`
- Inspect: `web/src/main.ts`
- Test references: `src/game-dsl.test.ts`, `src/bootstrap/create-runtime-application.test.ts`, `web/src/runtime/game-view-model.test.ts`

**Interfaces:**
- Produces a decision table: “现有能力直接复用 / 需要通用主线补丁 / 仅校园分支内容”。
- Confirms that scenario seeds are optional starting material, not executable workflows or fixed ending catalogs.
- No implementation output is required if current event mode and restart satisfy the campus branch.

- [ ] **Step 1: 验证现有 event mode 的实际行为**

确认以下现有事实均有代码和测试依据：

- `narrative.mode: event` 时不组装 narrative director；
- `narrative.event.max_interactions: 0` 不强制收束；
- 互动可以自然多轮直到模型输出 `ending`；
- `restart_session`/`RuntimeApplication.restart()` 会创建新 session；
- 旧 longform 的 memory/story-plan 流程不会被校园配置删除。

- [ ] **Step 2: 判断场景注入是否是通用能力**

优先尝试不改核心：将校园活动域、树莓娘人设和处理边界放入现有静态 prompt，并通过 `StoryState.canon` 或现有 opening 上下文承载本局事件。

只有当“每局选择一个事件而不把所有事件混入模型上下文”确实需要 API 扩展时，才设计通用 `OpeningContext`/`ScenarioContext`。该类型不得出现 campus、raspberry、BITNP 等词，且必须有单元测试证明 longform 也能安全忽略或消费它。

- [ ] **Step 3: 将通用补丁单独验证并回流 main**

若需要通用补丁：

```bash
npm test
npm run typecheck
```

把只涉及通用类型、上下文合并和兼容测试的提交标记为 `core:`，先合并/回提 `main`，再让校园分支基于新的 main 继续；不要在校园分支里偷偷保留只有校园能用的核心接口。

## Task 2: 建立以真实资料为基准的树莓娘角色适配

**Files:**
- Modify: `prompts/characters.txt`
- Modify: `prompts/guideline.txt`
- Modify: `prompts/author.yaml`
- Modify: `voices.yaml`（仅在音色确认后）
- Modify: `assets/resources.yaml`（仅在资源确认后）
- Create/Modify: `docs/superpowers/notes/campus-ops-source-audit.md`
- Tests: `src/prompts.test.ts`, asset loader tests if catalog changes

**Interfaces:**
- Produces a role prompt that distinguishes verified BITNP facts from campus-branch演绎。
- Produces a character binding only after a usable, authorized asset or explicitly approved temporary asset exists.
- Does not require old `suyao`/`linche` voice variables in the campus branch's text-only mode.

- [ ] **Step 1: 编写事实分层表**

角色 prompt 至少分成：

- 已确认：网协看板娘、兔耳、粉色服装语境、参与新成员面试/技术分享、熟悉网协技术相关工作；
- 本分支演绎：作为校园技术社团值班接待/协力角色，表达亲切、可爱、认真，偶尔轻微傲娇；
- 禁止擅自确定：官方完整性格、发色细节、身高年龄、服装细节、关系设定、任何私有模型/原画资源的授权状态。

- [ ] **Step 2: 先实现文本模式角色，不阻塞于立绘**

在没有授权正式立绘时，允许功能分支使用“无角色立绘/通用占位/仅文本”的明确临时方案；不要制作一个看起来像官方树莓娘但实际未经确认的伪官方 SVG。新资源 ID、声音 profile 和显示名必须与真实批准方案一致。

- [ ] **Step 3: 接入正式资源的前置检查**

资源接入前必须有一条记录：源仓库、commit、作者/许可或授权人、允许用途、是否允许打包、目标文件名。若授权未确认，保留外链和审计记录，不下载到仓库。

- [ ] **Step 4: 编写角色回归测试**

测试 prompt 包含“树莓娘”“网络开拓者协会”及技术社团语境；测试不再包含苏遥/林澈旧主线；测试文本模式配置不因缺少树莓娘音色而无法加载。

## Task 3: 将校园运维活动设计成可扩展内容，而非硬编码流程

**Files:**
- Create: `prompts/campus-ops.yaml` 或经 Task 1 决定的内容目录路径
- Create: content loader/test only if Task 1 confirms a reusable catalog is needed
- Modify: `prompts/story_line.txt`
- Modify: `prompts/instructions.yaml`
- Modify: `README.md`（校园分支说明）
- Tests: loader tests and prompt/context tests as applicable

**Interfaces:**
- A scenario seed card is descriptive input, not an executable state machine. It may include `id`、`title`、`seed`、`tags`、`context`、`common_concerns`、`boundaries`、`possible_angles`、`keywords`，但不强制固定步骤、轮数或结局。
- The content directory can grow incrementally; it must not require an arbitrary minimum event count before the program starts.
- If a generic scenario loader is added, its API must be reusable by non-campus stories and be isolated in a `core:` commit.

- [ ] **Step 1: 先写少量叙事种子，不先写固定剧本集**

首批可以从以下活动域汲取种子，但不要求覆盖全部活动域，也不要求每域有固定事件；后续按现场反馈扩展：

- 技术分享会：投影/音频/网络/讲者准备/现场提问；
- 电脑诊所：症状确认、软件配置、校园网、打印机、数据保护；
- 镜像源维护：同步延迟、版本不一致、容量、备用源、公告与影响范围；
- 诊所预约后台：时间冲突、重复提交、排班、取消和通知；
- 面试系统：错误通知、附件、时间安排、信息保护、备用流程；
- 工会/任务管理系统：优先级泛滥、模糊工单、重复任务、无人认领、跨组协作；
- 校内云盘：共享权限、链接过期、同步冲突、误删/版本恢复、容量和预览。

- [ ] **Step 2: 为每个活动写“现实边界”**

每个活动至少说明：玩家能观察什么、树莓娘可以建议什么、哪些操作需要负责人/所有者确认、哪些结果不能凭空成立。云盘尤其要覆盖权限与版本/恢复中的至少两项，但不把这些写成唯一通关路线。

- [ ] **Step 3: 设计可自然展开的生成指令**

更新 `instructions.yaml` 时只约束体验原则：开场尽快说明正在处理的校园事务；选项有明显策略差异；自由输入可提出意外方案；问题可以在两轮结束，也可以继续排查/沟通多轮；已有足够结论时主动收束；不要为了“凑轮数”制造事故。不要在模板中写“必须四轮”“必须 3–8 分钟”或“必须生成 N 个结局”。

- [ ] **Step 4: 先使用现有结局协议**

不要为了挑战/奖励立刻新增 `@result` DSL 行。第一版可以继续使用现有 `EndEvent.text`，在校园分支中让结局正文用自然语言清楚说明“处理结果/未解决部分/树莓娘评价”；若后续确实需要机器可验证的奖励，再另立通用结果协议设计，不把展位需求直接嵌入 DSL。

## Task 4: 用现有框架实现校园分支的开场与事件选择

**Files:**
- Modify only after Task 1 decision: `src/game.ts`, `src/core/ports/story-generator-port.ts`, `src/story/context-builder.ts`, `src/adapters/llm/openai-compatible-generator.ts`
- Otherwise modify: `prompts/story_line.txt`, `prompts/campus-ops.yaml`, `config.yaml`
- Tests: corresponding existing fixtures plus a campus scenario fixture

**Interfaces:**
- Produces an independent campus session whose opening introduces treeberry girl and one current campus task.
- Does not change longform defaults or mutate `story-plan.yaml`.
- If a scenario is selected deterministically, selection is based on the fresh session ID or explicit seed and is testable; if the first iteration lets the LLM choose from a domain list, that choice is documented as intentionally non-deterministic.

- [ ] **Step 1: 先做最小 vertical slice**

在校园分支使用 `narrative.mode: event`，把 `max_interactions` 保持为 `0`；替换旧 story/character/guideline prompt，使开场从“树莓娘正在值班/招新”开始，而不是旧终端、苏遥或林澈。

- [ ] **Step 2: 以最小修改验证自然多轮**

用 fake generator 增加两种 fixture：

- 简单的“显示器未开/软件配置”事件，少量互动后自然结束；
- 云盘权限或版本冲突事件，连续多轮排查、沟通后自然结束。

测试只验证 runtime 接受两种长度，不验证固定轮数或固定时长。

- [ ] **Step 3: 若需要事件卡注入，再实施通用接口**

如果静态 prompt 无法满足“每局只带一个当前事件”，实现最小的可选 scenario context，并把以下内容作为可选数据传递：事件标题、当前情况、边界、可考虑方向。不能把事件卡编译成强制状态机，也不能让 LLM 输出直接改写权限、文件或服务事实。

- [ ] **Step 4: 验证 restart 和隔离**

```bash
npx vitest run src/game.test.ts src/game-dsl.test.ts src/bootstrap/create-runtime-application.test.ts
```

Expected: 重启后获得新的 session；旧事件历史、互动表单、视觉状态和音频 candidate 不泄漏；longform 相关测试仍保持原行为。

## Task 5: 适配树莓娘和校园活动的视觉资源

**Files:**
- Modify: `assets/resources.yaml`
- Modify: `config.yaml`
- Modify: `voices.yaml`（授权且音色就绪时）
- Modify: `src/application/assets/asset-catalog-loader.test.ts`
- Modify: `src/core/assets/catalog.test.ts`
- Create: `docs/superpowers/notes/campus-ops-asset-register.md`

**Interfaces:**
- Produces a resource catalog that only references files actually present and authorized for the branch.
- Reuses existing `clubroom_*` and `hallway_*` backgrounds until replacement artwork is approved.
- Keeps audio optional; missing treeberry voice must degrade to text, not block startup.

- [ ] **Step 1: 先注册逻辑资源，不假设素材文件**

在资产登记表中为候选资源记录状态：`候选`、`待授权`、`已授权`、`已接入`。BITNP 徽章/logo 可以作为候选组织识别资源；私有 frontend 分层部件保持 `待授权`，不可复制。

- [ ] **Step 2: 接入授权通过的正式素材**

根据实际交付格式决定使用整张立绘、透明 PNG、Live2D 导出图还是其他适配层；不要为了满足旧有 sprite variant 数量而生成虚假的表情文件。若只有一张图，就只配置一个真实 variant，并让提示词不要要求不存在的表情。

- [ ] **Step 3: 配置文本优先的语音策略**

确认 `media.audio.synthesis.provider: disabled` 可以启动并完成一局。若后续确认树莓娘音色，新增独立 profile 和环境变量，不复用苏遥/林澈的 voice id。

- [ ] **Step 4: 运行资源校验**

```bash
npx vitest run src/application/assets/asset-catalog-loader.test.ts src/core/assets/catalog.test.ts
```

Expected: 所有已接入资源存在、路径不逃逸素材目录、未知资源仍被拒绝；未授权候选不会出现在正式 catalog。

## Task 6: 仅在确有需要时调整展位 UI 和结算

**Files:**
- Inspect first: `web/src/ui/layout.ts`, `web/src/ui/end-screen.ts`, `web/src/main.ts`, `web/src/ui/styles.css`
- Modify only if current UI lacks required visibility
- Tests: relevant web UI tests

**Interfaces:**
- The existing end overlay and restart path remain valid unless a concrete missing requirement is demonstrated.
- Any new campus HUD displays current activity/context without inventing a fixed interaction count.
- Rewards/challenges may initially remain outside runtime protocol (printed cards or staff flow); machine-readable result changes require a separate generic proposal.

- [ ] **Step 1: 先用现有 UI 做现场验收**

确认旁观者能看见当前对白、交互表单、树莓娘和结束文本；确认工作人员可以通过现有重新开始路径进入新 session。不要先做大面积主题重写。

- [ ] **Step 2: 只有发现缺口才增加最小 HUD**

可增加“当前事务/活动域”的一小块信息，但不显示“第 2/4 轮”这类固定结构。互动数量可以显示为“事件进行中”或不显示。

- [ ] **Step 3: 结算先保持自然语言**

结局页至少能展示完整 `EndEvent.text` 和重新开始按钮。挑战奖励、隐藏成就和活动纪念卡的第一版由工作人员根据结局/挑战卡发放；是否自动化留到真实现场测试后决定。

- [ ] **Step 4: 运行前端验证**

```bash
npx vitest run web/src/app.test.ts web/src/runtime/game-view-model.test.ts web/src/ui/interaction-panel.test.ts
npm run typecheck
```

## Task 7: 内容质量、现场流程与主线回流验收

**Files:**
- Create: `docs/campus-ops-event-runbook.md`
- Modify: `README.md`
- Modify: `docs/status.md`
- Modify: `docs/changelog.md`
- Create/Modify: `scripts/smoke-e2e.mjs`
- Tests: fake-generator campus fixtures and end-to-end smoke seam

**Interfaces:**
- Runbook describes one-person operation, one-sentence introduction, minimum player hints, audio-off operation, error handling, reward handoff and restart.
- Smoke test runs without external API and verifies scenario-seed opening, campus prompt, treeberry role, both short and multi-round continuation, free-input path, open-ended natural ending and restart isolation.
- Produces a list of changes suitable for cherry-picking to `main` and a list that must remain campus-only.

- [ ] **Step 1: 写现场 runbook，不写固定时长承诺**

工作人员只需说明“这是一个会根据你的选择和输入变化的校园技术社团互动体验”；不要向玩家承诺固定轮数。记录展位观察值（理解时间、平均体验时长、是否愿意再次体验），但这些值不进入引擎规则。

- [ ] **Step 2: 运行内容覆盖检查**

手工和 fake generator 至少覆盖：从不同叙事种子出发、同一种子的不同玩家路径、一个可快速落地的故事和一个可继续多轮的故事；可参考电脑诊所、技术分享会、镜像源、预约后台、面试系统、工会/任务管理、校内云盘等素材，但不把七类素材域当作固定覆盖门槛。检查普通玩家只点选项也能玩，自由输入失败/被拒绝时仍能继续。

- [ ] **Step 3: 执行全量验证**

```bash
npm test
npm run typecheck
npm run build
```

Expected: 命令均成功；event 分支测试和现有 longform/runtime 测试同时通过；检查 `git diff main...HEAD`，确认没有删除 main 的记忆/存档能力，也没有提交未授权资源。

- [ ] **Step 4: 做主线回流审查**

逐个检查提交：

- 能被任意故事复用、且不包含校园专名的框架改动 → 提议回流 `main`；
- 树莓娘、BITNP、校园服务、活动目录、展位文案、未确认素材 → 留在 `feat/campus-ops-raspberry`；
- 需要产品决策的奖励协议、机器可验证成就、正式立绘/音色 → 不隐式合并，列为后续决策项。

## 计划自检

- **开放叙事修订：** 每局选择一个叙事种子作为起点；种子不规定路线、互动轮数、结局枚举或固定人物反应；七类活动域只是可选素材标签。

- **没有过度限制：** 不固定轮数、时长、事件总数或结局数量；`max_interactions: 0` 保持现有“不限制”语义。
- **框架复用：** 先审计并复用当前 event mode、DSL、自由输入、分支预取和 restart；只有确有缺口才新增通用能力。
- **主线保护：** main 的长线 memory、story-plan、存档和 narrative director 不被校园配置删除；通用补丁独立回流。
- **内容开放：** 技术分享会、电脑诊所、镜像源维护、诊所预约后台、面试系统、工会/任务管理、校内云盘只是可选素材域；不要求固定数量、固定路线或七域全部实现。
- **事实准确：** BITNP 资料、私有仓库和许可证状态均记录；未知人设和美术信息不被当作事实。
- **资源安全：** 未授权资源不进正式 catalog，不复制私有 frontend 分层部件。
- **协议克制：** 第一版不强行新增 `@result`；挑战/奖励先用自然结局和现场流程验证，若将来自动化再设计通用协议。
- **测试策略：** 长短不同的 fake 事件、自由输入、restart、文本模式和全量构建均有验证路径。
