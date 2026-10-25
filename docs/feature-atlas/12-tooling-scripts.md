# 工具链域（图像生产·评估探针·测试基建）

> 基线：origin/main @ 78704e9（2026-10-24）｜规模：21 文件 / 5959 行（生产代码，不含测试）
> 快照：`D:/coding/lgp-main-atlas`（只读）。目录：`src/tools/image-gen/`、`scripts/`、`src/test-helpers.ts`、`src/game-test-kit.ts`、`src/test-support/character-contract-cases.ts`
> 配套配置：`package.json`（scripts 段）、`vitest.config.ts`（15 行）
> 自身测试：`src/tools/image-gen/` 下 6 个 colocated 测试文件共 77 个 it 块（client 18 / cutout 20 / env 5 / files 6 / matting 5 / validate 23）；其余工具零测试、靠自身运行自验

## 1. 域职责与边界

本域收集三类"服务于产品但不被产品引用"的代码：

**A. 图像生产工具（`src/tools/image-gen/`，10 文件 / 2321 行）**——对接 gpt-image-2 / 2.5（OpenAI Images API 兼容形态）的独立出图工具，core + CLI 双层设计（`src/tools/image-gen/README.md:3-4`）。解决两个问题：① 作者手工/脚本化生成角色立绘、CG（`pnpm image generate/edit`）；② 生成结果的透明底兜底（gpt-image 对 `background: transparent` 遵从度非 100%，工具以「请求侧注入白底提示词 + 结果侧 alpha 检测 + AI/几何双引擎抠图」双保险，见 `cutout.ts:1-17` 头注释）。**依赖方向：完全独立**——image-gen 内部只 import 同目录模块 + 第三方包（zod/pngjs/onnxruntime-node/@imgly），不引用任何 `src/` 生产代码；生产代码也不引用它（grep 验证双向为零）。它读取 `.env` 的 `IMAGE_GEN_*` 变量，产出写入 `output/`（`.gitignore:34-35` 明确忽略）。与 `assets/` 管线的关系是**人工中转而非自动管线**：当前 `assets/` 内立绘/背景素材来源是第三方素材站 わたおきば（`assets/ATTRIBUTION.md:3-8`），image-gen 产出的图由作者挑选后手工放入 `assets/`（README §3.2 示例即以 `./assets/raw/standee.png` 作 edit 参考图）。

**B. 评估与探针脚本（`scripts/`，8 文件 / 2827 行）**——两类：
- **离线评估 harness**：`scripts/evaluate-character-dsl.ts`（2084 行）是角色 DSL v2 的契约向量回放器 + 双协议场景回放器 + 注入缺陷修复模拟器 + §10.2 发布门槛表生成器，零模型调用、输出确定性（同输入 → 逐字节相同 report.json，含 sha256 摘要，`evaluate-character-dsl.ts:31-36`）。它与角色域的关系：**评估器 import 生产代码**（12 个生产模块：gal-dsl 编译器全链、character registry、presentation defaults/reducer、asset catalog、AudioDescriptorFactory、memory-validator、voices 配置、context-builder），是角色域与 DSL 域的"验收面板"。
- **真实链路探针 / 一次性脚本**：`probe-music-composer.ts`（真实 BigModel 调用验证作曲家 compose/reuse 两分支）、`probe-tts-params.mjs`（真实 DashScope SSE 合成一条台词验证 voice-id 配对）、`smoke-e2e.mjs`（真实组合根 + LocalWebHost + WS 客户端的端到端冒烟）、`serve-music-demo.mjs`（配乐试听页静态服务）、`vendor-soundfonts.mjs` / `vendor-webfonts.mjs`（第三方资源本地化）、`verify-voice-guide.mjs`（协作文档完整性检查）。除 probe/smoke 探针 import 生产模块外，vendor/serve/verify 三类零生产依赖。

**C. 测试基建（`src/test-helpers.ts` 378 行 + `src/game-test-kit.ts` 341 行 + `src/test-support/character-contract-cases.ts` 92 行）**——横切层：`test-helpers` 提供全仓库测试共用的 AppConfig fixture、内存 ports（RunGraph/Clock/IdGenerator）与 `MemoryController` 运行时驱动；`game-test-kit` 在其上叠 Game 套件专用 mock（generator/media/status/director）与 DSL envelope 构造器；`character-contract-cases` 是双分支（main/campus）字节一致的角色身份契约向量数据，同时被 evaluate-character-dsl 评估器与 5 个单测消费。

**npm scripts 与测试配置**（`package.json:7-23`、`vitest.config.ts`）：scripts 段共 16 条——`dev`/`dev:web`/`dev:cli`（tsx 起 entrypoints）、`build`/`build:node`/`build:web`、`start:web`/`start:cli`（跑 dist 产物）、`typecheck`（node+web 双 tsconfig noEmit）、`demo:music`（vite build + serve-music-demo）、`verify:voice-guide`、`image`（tsx 起 image-gen CLI）、`test`/`test:watch`。vitest 配置极简：`globals: true`、`environment: "node"`、`include: ["src/**/*.test.ts", "web/**/*.test.ts"]`、唯一 alias `@shared → src/shared`。仓库**无 .github 目录**，以上脚本无 CI 工作流引用（TODO-未核实是否有外部 CI）。

## 2. 模块清单

| 文件 | 行数 | 职责 | 导出符号数 | 用途形态 |
|---|---|---|---|---|
| `src/tools/image-gen/types.ts` | 138 | 模型枚举/参数与结果类型（零依赖零副作用） | 20 | 被 import（core 各层共用） |
| `src/tools/image-gen/defaults.ts` | 27 | 内置默认参数（回退链最后一层） | 1 | 被 import |
| `src/tools/image-gen/validate.ts` | 466 | 参数归一化 + 全量校验（非法参数本地拦截） | 8 | 被 import |
| `src/tools/image-gen/client.ts` | 498 | HTTP 客户端：JSON/multipart、SSE 流、超时、退避重试 | 8 | 被 import |
| `src/tools/image-gen/env.ts` | 145 | .env 配置加载（IMAGE_GEN_*） | 3 | 被 import |
| `src/tools/image-gen/files.ts` | 90 | 文件 IO（读参考图、结果落盘） | 5 | 被 import |
| `src/tools/image-gen/cutout.ts` | 326 | 几何泛洪抠图 + 抠图决策入口（双引擎） | 16 | 被 import |
| `src/tools/image-gen/matting.ts` | 162 | AI 抠图引擎（ISNet，onnxruntime-node 直载） | 6 | 被 import |
| `src/tools/image-gen/cli.ts` | 438 | 命令行入口（generate/edit 子命令） | 0 | CLI（`pnpm image`） |
| `src/tools/image-gen/onnxruntime-node.d.ts` | 31 | onnxruntime-node@1.17.x 最小类型声明 shim | 0 | ambient 声明 |
| `scripts/evaluate-character-dsl.ts` | 2084 | 角色 DSL v2 离线评估 harness | 21 | CLI（`npm exec tsx --`） |
| `scripts/probe-music-composer.ts` | 128 | 作曲家决策流真实链路探针（两轮） | 0 | 一次性脚本（真实 LLM 调用） |
| `scripts/probe-tts-params.mjs` | 105 | TTS voice-id 配对探针（DashScope SSE） | 0 | 一次性脚本（真实 API 调用） |
| `scripts/serve-music-demo.mjs` | 95 | 配乐试听页零依赖静态服务 | 0 | 常驻脚本（`npm run demo:music`） |
| `scripts/smoke-e2e.mjs` | 149 | 全栈 E2E 冒烟（WS/TTS/控制器限额） | 0 | 一次性脚本（`node scripts/`） |
| `scripts/vendor-soundfonts.mjs` | 88 | FluidR3_GM 采样包裁剪本地化（12 调色板） | 0 | 一次性/按需重采 |
| `scripts/vendor-webfonts.mjs` | 143 | Google Fonts woff2 子集本地自托管 | 0 | 一次性脚本 |
| `scripts/verify-voice-guide.mjs` | 35 | TTS 协作文档完整性检查 | 0 | 一次性脚本（`npm run verify:voice-guide`） |
| `src/test-helpers.ts` | 378 | 全仓库测试共享 fixture/内存 ports/控制器 | 9 | 被 import（19 个 .test.ts + game-test-kit） |
| `src/game-test-kit.ts` | 341 | Game 套件专用 mock 与 envelope 构造器 | 18 | 被 import（5 个 game*.test.ts） |
| `src/test-support/character-contract-cases.ts` | 92 | 双分支共享角色身份契约向量（纯数据） | 4 | 被 import（评估器 + 5 个 .test.ts） |

合计 21 文件 / 5959 行 / 119 个导出符号。

## 3. 函数级明细

### `src/tools/image-gen/cli.ts`（438 行，无 export——CLI 入口，顶层直接执行）

入口链：`main()`（L411-423）分派 `generate`/`edit`/`help`，末尾 `main().catch(...)`（L425-438）按错误类型映射退出码（ImageParamError→2、ImageApiError→1、未知→1）。

**内部函数**（全部私有，按执行顺序）：

- `errMessage(error)` — L138-140：unknown → message 字符串。
- `parseCli(options, argv)` — L143-153：`node:util` parseArgs 包装；未知 flag/缺值抛 `ImageParamError`（退出码 2，不发请求）。
- `parseGenerate(argv)` / `parseEdit(argv)` — L155-158 / L160-163：按共用/edit 选项表解析（选项表 L108-136：`--cutout`/`--cutout-engine`/`--cutout-device`/`--cutout-clean`/`--keep-raw`/`--save-partials` 等）。
- `requirePrompt(positionals)` — L165-173：位置参数必须恰好 1 个（提示词）。
- `intOption(label, raw, min)` — L175-182：非负整数选项校验（--timeout/--retries）。
- `baseParams(values, prompt)` — L184-199：CLI values → `GenerationParamsInput` 宽松形态。
- `applyCutoutParams(params)` — L202-217：--cutout 请求侧改写——与 `--background opaque`/非 png `--format` 冲突即报错；否则注入 `withCutoutPromptHint` + `background: transparent` + `outputFormat: png`。
- `buildCutoutOptions(values, env)` — L227-249：合并 CLI flag 与 env 的抠图引擎/设备配置，产出 `CutoutRunOptions`。
- `formatUsage(usage)` — L251-258：token 用量格式化为单行。
- `reportResult(result, outDir, baseName, cutout)` — L260-308：结果汇报落盘——逐张 `processForCutout`（若 --cutout），按 action 打印中文提示（ai-matting/cutout/kept-alpha/no-background），`--keep-raw` 时原图存为 `{前缀}-raw-NN.png`，最后 `saveImages` + 打印路径/revisedPrompt/usage。
- `consumeStream(stream, outDir, baseName, savePartials)` — L310-330：消费 SSE 流事件，partial 可选落盘，completed 收敛为 `ImageGenResult`；流未返回最终图抛 `ImageApiError(200, ...)`。
- `runGenerate(argv)` — L332-362：generate 主流程（见 §4 数据流）。
- `runEdit(argv)` — L364-409：edit 主流程——额外要求 `--image` 1~16 张、`loadImageFile` 读入、可选 `--mask`/`--input-fidelity`；流式分支与 generate 对称。
- `main()` — L411-423：命令分派；`help`/`--help`/`-h`/缺省打 USAGE（L35-77 完整用法文本）。

**内部辅助**：`SharedValues`/`EditValues` 类型（L79-106）、`sharedOptions`/`editOptions` 选项表（L108-136）。

### `src/tools/image-gen/client.ts`（498 行，8 export）

#### `DEFAULT_BASE_URL = "https://api.openai.com/v1"` — `client.ts:36`

#### `DEFAULT_TIMEOUT_MS = 300_000` — `client.ts:38`
超时放宽到 5 分钟：图像生成耗时波动大（xhigh 大图可超 2 分钟，L37 注释）。

#### `DEFAULT_MAX_RETRIES = 2` — `client.ts:39`

#### `class ImageApiError extends Error` — `client.ts:49-61`
API/网络层失败；字段 `status`（HTTP 状态码，0=未拿到响应）、`code?`、`requestId?`。调用方：cli.ts 顶层 catch、README §4.2 错误处理范式。

#### `interface ImageGenClientOptions` — `client.ts:63-75`
`apiKey` 必填；`baseUrl`/`timeoutMs`/`maxRetries` 可选；`fetchImpl`/`sleepImpl` 测试注入点（单测全程无网络，L10 注释）。

#### `interface ImageGenClient` — `client.ts:77-86`
四个方法签名：`generate` / `edit` / `generateStream` / `editStream`。

#### `normalizeBaseUrl(input: string): string` — `client.ts:89-104`
去尾斜杠；裸域名（无路径）自动补 `/v1`；非 http(s) 抛 `ImageApiError`。调用方：`createImageClient` 内部；有 env.test/client.test 覆盖。

#### `createImageClient(options: ImageGenClientOptions): ImageGenClient` — `client.ts:291-498`
工厂：校验 apiKey/timeoutMs/maxRetries → 组装 authHeaders → 返回四方法对象。每个方法入口先过 `resolveGenerationParams`/`resolveEditParams` 校验（非法参数本地抛、绝不发请求）。`generate`/`edit` 在 `stream=true` 时走 `collectStream` 内部消费 SSE 只回最终结果；`*Stream` 强制 stream=true 逐事件 yield。
关键步骤（闭包内协作者）：
1. `sendWithRetry(prepare)`（L315-346）：POST + `AbortSignal.timeout`；网络错误与 `RETRYABLE_STATUS`（408/429/500/502/503/504，L44）指数退避重试（`backoffDelay` L348-350：500ms×2^n 封顶 8s）；非 2xx 转 `toApiError`。
2. `generateJson(resolved)`（L352-364）/ `editJson(resolved)`（L366-377）：generations 用 JSON body（`toGenerationRequestBody`），edits 用 `buildEditFormData`（L259-285，multipart 含 image[]/mask/input_fidelity）。
3. `streamEvents(resolved, path, form?)`（L380-457）：SSE 流——`parseSseData` 逐块取 data 载荷；`image_generation.partial_image` 事件 yield `{type:"partial"}`；`image_generation.completed` 事件组装 `ImageGenResult` yield 后 return；`error` 事件/非法 JSON 抛 `ImageApiError`；未知事件忽略（向前兼容，L454）。
4. `collectStream`（L459-472）：吞掉 partial 只留 completed 的结果。

依赖：`validate.ts`（resolve*/toGenerationRequestBody）、`types.ts`、zod（响应结构校验）。

**内部辅助**：`errMessage`（L106）、`toApiError`（L111-135，解析服务端 error.message/type/code 与 x-request-id）、`imageUsageSchema`/`imageResponseSchema`（L137-155，zod）、`toUsage`（L157-164）、`toResult`（L167-194，b64_json 解码为 bytes；缺 b64_json 报中转站改写响应的中文提示）、`findBlockBoundary`/`extractDataPayload`/`parseSseData`（L199-240，SSE 块边界/载荷/字节流解析器）、`toBlobPart`/`toBlob`（L250-257，TS 5.7 协变窄化）、`buildEditFormData`（L259-285）。

### `src/tools/image-gen/validate.ts`（466 行，8 export）

#### `MAX_PROMPT_LENGTH = 32_000` — `validate.ts:41`
gpt-image 系列 prompt 上限。

#### `MAX_EDIT_IMAGES = 16` — `validate.ts:52`
edits 单次参考图上限。

#### `class ImageParamError extends Error` — `validate.ts:55-63`
参数校验失败；`issues` 为字段级中文原因数组（一次校验全部收集，L17 设计目标）。

#### `resolveGenerationParams(params, fallbacks?): ResolvedGenerationParams` — `validate.ts:401-410`
文生图参数归一化主入口。步骤：`mergeLayers`（显式参数 > fallback > GENERATION_DEFAULTS 三层合并，含 snake_case→camelCase 别名归一与未知/禁用键检查）→ `resolveGenerationKeys`（逐字段校验 + 跨字段规则）→ issues 非空即抛 `ImageParamError`。调用方：client.ts 全部四方法入口、cli.ts 流式分支预解析（L352）、env.ts 间接。

#### `resolveEditParams(params, fallbacks?): ResolvedEditParams` — `validate.ts:415-436`
编辑参数 = 文生图参数 + `imagesField`（1~16 张结构检查）+ `imageFileField`（mask）+ `inputFidelity` 枚举。

#### `isKnownModel(value): value is GptImageModelId` — `validate.ts:439-441`
供 env.ts 预检 IMAGE_GEN_MODEL。

#### `isValidSize(value): boolean` — `validate.ts:444-447`
不抛错版 size 校验，供 env.ts 预检。

#### `toGenerationRequestBody(p): Record<string, unknown>` — `validate.ts:450-466`
Resolved 参数 → `/v1/images/generations` JSON body（snake_case，缺省键不发送）。调用方：client.ts `generateJson`/`streamEvents`。

**内部辅助**：尺寸常量（L43-50：16 倍数/256 下限/3840×2160 上限/宽高比 1:3~3:1）、`KNOWN_GENERATION_KEYS`/`KNOWN_EDIT_KEYS`（L66-85）、`KEY_ALIASES`（L88-94）、`BANNED_KEYS`（L97-100，responseFormat/style 专属报错文案）、`fmt`（L102）、`normalizeKeys`（L113，别名冲突检测）、`definedEntries`（L127）、`checkKeys`（L136）、`enumField`（L154）、`intField`（L170，接受整数字符串）、`boolField`（L192）、`sizeField`（L203）、`promptField`（L238）、`imageFileField`（L259）、`imagesField`（L279）、`resolveGenerationKeys`（L300-365，含跨字段规则：xhigh/max 仅 2.5 系列、transparent×jpeg 拒绝、compression×png 拒绝、partialImages×stream 依赖）、`mergeLayers`（L371-395）。

### `src/tools/image-gen/cutout.ts`（326 行，16 export）

#### `DEFAULT_TOLERANCE = 40` — `cutout.ts:25`
近白判定容差（每通道与 255 的距离上限，0~255）。

#### `ALPHA_SKIP_RATIO = 0.01` — `cutout.ts:27`
透明像素占比达到该值即认为「已有真透明」，跳过抠图。

#### `CUTOUT_MIN_REMOVED = 0.01` — `cutout.ts:29`
抠图移除占比低于该值视为「没有可抠的浅色背景」，保留原图。

#### `DEFAULT_MAX_ENCLOSED_RATIO = 0.005` — `cutout.ts:35`
封闭近白区域清除上限（占全图像素比）；依据实测立绘调整：白T恤约 1.1%、发丝/领口缝隙 ≤0.17%，取 0.5% 居中分隔（L30-34 注释）。

#### `DEFAULT_DARK_BOUNDARY_LUM = 100` — `cutout.ts:42`
cleanEnclosed 深色描边判定：分量边界 1px 内最小亮度不超过该值才清除；发丝/领口缝实测 32~66、皮肤浅边界 ≥110 得以保留；帆布鞋类有破洞风险（已知取舍，L36-42 注释）。

#### `CUTOUT_PROMPT_HINT` — `cutout.ts:45`
注入提示词末尾的抠图友好片段（"纯白色背景，主体完整，边缘清晰锐利…"）。

#### `withCutoutPromptHint(prompt: string): string` — `cutout.ts:47-53`
已含白底关键词（纯白背景/白底/white background）则不重复注入。调用方：cli.ts `applyCutoutParams`。

#### `transparentRatio(bytes: Uint8Array): number | null` — `cutout.ts:56-71`
PNG 透明像素占比（alpha<8 计数/总像素）；非 PNG 或解析失败返回 null。调用方：`processForCutout`、cli 报告、cutout.test。

#### `interface CutoutOptions` — `cutout.ts:73-85`
flood 引擎选项（tolerance/cleanEnclosed/maxEnclosedRatio/darkBoundaryLum）。

#### `interface CutoutResult` — `cutout.ts:87-91`
`{ png, removedRatio }`。

#### `cutoutBackground(bytes, options): CutoutResult | null` — `cutout.ts:97-217`
白底几何抠图核心（纯函数，pngjs 编解码）。步骤：
1. 边界播种：四边每个像素若近白或已透明则入队（L130-137）；
2. BFS 泛洪：从队列扩展近白邻居标记为背景（L139-157）——只从边界连通，绝不误伤角色内部白色区域；
3. 可选 `cleanEnclosed` 第二遍（L163-208）：对每个不与边界连通的近白连通域，若面积 ≤ maxEnclosedRatio 且边界 1px 内最小亮度 ≤ darkBoundaryLum（深色描边包围）则整体清除；
4. 标记像素 alpha 置 0，回写 PNG。
返回 null = PNG 解析失败。

#### `type CutoutAction` — `cutout.ts:220-225`
五值决策枚举：`kept-alpha`/`ai-matting`/`cutout`/`no-background`/`opaque-skip`（每值带文档注释）。

#### `type CutoutEngine = "ai" | "flood"` — `cutout.ts:227`

#### `interface CutoutProcessOptions` — `cutout.ts:229-247`
engine/cleanEnclosed/tolerance/maxEnclosedRatio/darkBoundaryLum/device/modelPath/aiMattingImpl（测试注入）。

#### `interface CutoutProcessResult` — `cutout.ts:249-258`
`{ image, action, engine?, removedRatio?, fallbackFromAi? }`。

#### `processForCutout(image, options): Promise<CutoutProcessResult>` — `cutout.ts:289-326`
单张结果图抠图决策入口（cli.ts `reportResult` 调用）。步骤：
1. 非 png 或 `transparentRatio` 为 null → `opaque-skip`；
2. 透明比 ≥ ALPHA_SKIP_RATIO → `kept-alpha`（模型已给真透明）；
3. engine=ai（默认）：`aiMatting` 推理，结果透明比达标 → `ai-matting`；异常或结果无透明 → 落到 flood 回退并标记 `fallbackFromAi: true`；
4. engine=flood：`floodCutout` → 移除比 < CUTOUT_MIN_REMOVED 判 `no-background`（背景非浅色，保留原图），否则 `cutout`。

**内部辅助**：`FloodOptions`（L260）、`floodCutout`（L268-282，cutoutBackground 包装 + 阈值判定）。

### `src/tools/image-gen/matting.ts`（162 行，6 export）

#### `type MattingDevice = "cpu" | "dml"` — `matting.ts:25`

#### `type AiMattingFn = (bytes, options) => Promise<Uint8Array>` — `matting.ts:27`
可注入的 AI 抠图函数形态（测试用）。

#### `interface AiMattingOptions` — `matting.ts:29-36`
device/modelPath/impl。

#### `bilinearResize(data, width, height, channels, newWidth, newHeight): Uint8Array` — `matting.ts:45-78`
双线性缩放；头注释声明与 imgly `tensorResizeBilinear` 逐像素同算法（floor/ceil 邻点 + 线性插值 + round），保证输出一致。

#### `toModelInput(rgba1024): Float32Array` — `matting.ts:81-90`
RGBA(HWC) → `[1,3,1024,1024]` float32，逐通道 `(p-128)/256`（imgly 同款归一化）。

#### `aiMatting(bytes, options = {}): Promise<Uint8Array>` — `matting.ts:159-162`
AI 抠图入口：`options.impl ?? defaultImpl` 委托。失败抛错（调用方 cutout.ts 决定回退）。`defaultImpl`（L135-153）管线：PNG 读 → bilinearResize 到 1024² → toModelInput → `session.run`（"output" 张量）→ mask ×255 → bilinearResize 回原尺寸 → 写入 alpha → PNG 编码。

**内部辅助**：`INPUT_SIZE=1024`（L39，ISNet 固定输入）、`cachedModelBytes`（L92，模型字节缓存）、`loadModelBytes`（L95-107，显式 modelPath 或从 `@imgly/background-removal-node` 包 resources.json 分块资源拼接，仅读数据文件不引 AGPL 代码，L14-16 注释）、`sessionCache`（L109）、`getSession`（L111-133，懒加载 onnxruntime-node；dml 尝试 `["dml","cpu"]` EP 失败自动回 CPU 会话）。

### `src/tools/image-gen/env.ts`（145 行，3 export）

#### `DEFAULT_OUTPUT_DIR = "output/image-gen"` — `env.ts:17`

#### `interface ImageGenEnvConfig` — `env.ts:23-37`
baseUrl/apiKey 必填 + fallbacks 中间层 + timeoutMs/maxRetries/outputDir + cutoutEngine/cutoutDevice/cutoutModelPath。

#### `loadEnvConfig(env = process.env): ImageGenEnvConfig` — `env.ts:64-145`
读 `IMAGE_GEN_*` 环境变量（本身无副作用，CLI 已 `import "dotenv/config"`，L2-3 注释）。必填缺失/可选项非法一次列全抛 `ImageParamError`；可传自定义 env 便于测试（env.test.ts 5 例）。MODEL/SIZE/QUALITY 经 `isKnownModel`/`isValidSize` 预检后进 fallbacks 层。

**内部辅助**：`KNOWN_QUALITIES`/`KNOWN_CUTOUT_ENGINES`/`KNOWN_CUTOUT_DEVICES`（L19-21）、`trimEnv`（L39）、`intEnv`（L45）。

### `src/tools/image-gen/files.ts`（90 行，5 export）

#### `extForFormat(format): string` — `files.ts:19-21`
jpeg→jpg，其余同名。

#### `loadImageFile(filePath): Promise<ImageFileInput>` — `files.ts:28-43`
按扩展名（png/jpg/jpeg/webp）判 MIME 读入内存；不支持/不可读抛 `ImageParamError`。调用方：cli.ts runEdit。

#### `defaultBasename(model, size, now?): string` — `files.ts:46-56`
`{本地时间戳}-{model}-{size}` 前缀（如 `20260914-103045-gpt-image-2-1024x1536`）。

#### `saveImages(images, dir, baseName): Promise<string[]>` — `files.ts:59-73`
逐张写 `{baseName}-{NN}.{ext}`（自动建目录）。调用方：cli.ts reportResult、README §4 脚本范式。

#### `savePartialImages(partials, dir, baseName): Promise<string[]>` — `files.ts:76-90`
SSE 部分图落盘 `{baseName}-partialNN.png`。

**内部辅助**：`MIME_BY_EXT`（L11-16）、`errMessage`（L23）。

### `src/tools/image-gen/types.ts`（138 行，20 export）

#### `GPT_IMAGE_MODELS` — `types.ts:14-21`
六模型 ID 常量表：gpt-image-2（含 -2026-04-21 快照）、gpt-image-2.5-sunburst/-flare（各含 -2026-09-08 快照）。

#### `GptImageModelId` — `types.ts:23`
上表派生的联合类型。

#### `isGptImage25(model): boolean` — `types.ts:26-28`
`model.startsWith("gpt-image-2.5")`；xhigh/max 画质门控依据。

#### `type ImageBackground = "transparent" | "opaque" | "auto"` — `types.ts:30`

#### `type ModerationLevel = "low" | "auto"` — `types.ts:31`

#### `type ImageOutputFormat = "png" | "jpeg" | "webp"` — `types.ts:32`

#### `type InputFidelity = "high" | "low"` — `types.ts:33`

#### `type ImageQuality` — `types.ts:39`
`"auto" | "low" | "medium" | "high" | "xhigh" | "max"`；注释说明 xhigh/max 仅 2.5 系列、hd/standard 为 dall-e 专属不接受（L36-38）。

#### `type ImageSizeSpec` — `types.ts:42`
`"auto"` 或 `{ width, height }`（须 ÷16、宽高比 1:3~3:1、≤3840×2160）。

#### `formatSizeSpec(spec): string` — `types.ts:45-47`
`"auto"` 或 `"WxH"` 序列化。调用方：validate 请求体映射、files 文件名、client multipart。

#### `interface ImageFileInput` — `types.ts:50-55`
`{ filename, contentType, data: Uint8Array }`（内容已在内存；core 不做文件 IO，L49 注释）。

#### `GenerationParamsInput` — `types.ts:62-76`
宽松输入形态：`[key: string]: unknown` 索引签名 + 全 unknown 可选字段（camelCase 与 snake_case 等价、字符串数字自动转换，由 validate.ts 归一化）。

#### `EditParamsInput` — `types.ts:79-83`
GenerationParamsInput + images/mask/inputFidelity。

#### `GenerationFallbacks` — `types.ts:86`
中间默认层类型（.env）。

#### `ResolvedGenerationParams` — `types.ts:89-105`
校验完毕强类型参数（outputFormat/outputCompression/partialImages/user 为 undefined = 不发送）。

#### `ResolvedEditParams` — `types.ts:107-111`

#### `GeneratedImage` — `types.ts:114-119`
`{ bytes, format, revisedPrompt? }`；format 是落盘扩展名依据（缺省 png）。

#### `ImageUsage` — `types.ts:121-125`
token 三元组。

#### `ImageGenResult` — `types.ts:127-133`
`{ model, size, images, usage?, created? }`。

#### `ImageStreamEvent` — `types.ts:136-138`
`{type:"partial", index, bytes} | {type:"completed", result}`。

### `src/tools/image-gen/defaults.ts`（27 行，1 export）

#### `GENERATION_DEFAULTS` — `defaults.ts:11-27`
兜底层常量：model=gpt-image-2 / size=auto / quality=auto / n=1 / background=auto / moderation=auto / stream=false。回退链最后一层（显式参数 > .env > 本文件，L4 注释）。调用方：validate.ts `mergeLayers`/`resolveGenerationKeys`。

### `src/tools/image-gen/onnxruntime-node.d.ts`（31 行，无 export）

Ambient `declare module "onnxruntime-node"`（L7-31）：声明 `Tensor`/`SessionOptions`/`InferenceSession` 最小 API 面。存在原因：onnxruntime-node@1.17.x 的 package.json `types` 字段指向不存在的 dist/index.d.ts（上游打包缺陷），@types 亦未覆盖（L2-5 注释）。仅 image-gen 使用；**升级 onnxruntime 版本时需复核此 shim**。

### `scripts/evaluate-character-dsl.ts`（2084 行，21 export；超长单文件 CLI，按阶段归组）

**这是什么评估器**：角色 DSL v2 的离线验收 harness（自校园分支移植，评估口径分支无关、场景数据换 main 自己的，L2-10 头注释）。评估对象是角色域 + DSL 域的公开 API 组合：契约向量（角色身份保持/音色稳定/模板替换/解析分歧/记忆校验）→ 12 固定场景双协议回放（v1 parseDslSegmentText+compileEventGroups 与 v2 compileSegmentV2）→ 6 注入缺陷修复模拟（compileSegmentV2WithRepair）→ §10.2 发布门槛表。零模型调用、确定性输出（stableStringify 键排序 + sha256 报告摘要）。安全边界：只写显式 `--out` 目录、拒绝 sessions/games 路径段（L34-36、L265-268）、在线腿为 NOT_ENABLED 桩（带齐 `--online --model --max-calls --budget` 也明确报错不跑模型，L38-42）。

**入口流程**（`main` L2021-2068）：
1. `parseArgs`（L159-262）解析 CLI（--out/--pack/--voices/--assets/--online 族）；`isForbiddenOutPath`（L265-268）守卫输出目录；
2. `buildOfflineEvaluation`（L1802-1915）构建完整报告：
   a. `buildMainContext`（L1386-1419）：loadCharacterPackRoster(characters.yaml) + loadAssetCatalog(assets/resources.yaml) + loadVoices(voices.yaml) → createCharacterRegistry / toCharacterRegistry / 双 defaults+reducer / AudioDescriptorFactory（local 绑定）；
   b. `evaluateContractVectors`（L612-704）：共享 fixture 向量 R01（改名后投影仍携带稳定 characterId）+ R02-shared（音色跨标签稳定）；
   c. `evaluateMainVectors`（L707-852）：R02-main（真实 roster suyao→suyao_main）+ R03（renderTemplate 字面单遍替换，动态 import 计划模块 L770-772）+ R09-pinned（冒号全半角解析分歧，固定当前缺陷行为）+ MAIN-MEMORY（validateCharacterTags 结构化拒绝显示名提案）；
   d. `mainScenarioSet()`（L879-1148）12 场景逐个 `evaluateScenario`（L1421-1660）：v2 段编译 → 对白组/名牌快照/素材诊断 → 槽位互斥与画外观察（S06/S10）→ 玩家投影探针（S08）→ v1 整文管线回放 → serializeStoryContext 投影检查（携带稳定 id、无裸标签头）→ observeAudioIdentity 音频身份（speakerId 匹配 + 每角色音色单例）→ 文本保真探针（S12）；
   e. `injectedDefectSet()`（L1166-1255）6 缺陷逐个 `evaluateDefect`（L1666-1722）：首过编译错误码匹配 + `compileSegmentV2WithRepair` 脚本化修复 + D5 原子性（坏组的改名不得落地）+ D2 前缀纯净（无幻影身份）；
   f. 汇总 totals → `buildGateTable`（L1724-1793，§10.2 门槛：离线可计算行给值、在线行标 TBD-online）→ `reportHash = sha256(stableStringify(report))`（L1913）；
3. `renderConsoleSummary`（L1921-1946）打印摘要；有 --out 时写 report.json + summary.md（L2058-2063）。
4. 退出码：0 完成（红灯照常报告）；2 用法/路径误用；3 在线未接线；1 内部错误（L53-54）。

`invokedAsCli` 判定（L2071-2073）：`process.argv[1]` 等于本文件 URL 才执行 main——注释称防"vitest 动态导入"触发；main 分支当前无任何文件 import 本模块（grep 验证零引用，防御指向 campus 分支的测试）。

**export 值符号**（10 个）：

#### `stableStringify(value: unknown): string` — `evaluate-character-dsl.ts:274-282`
规范 JSON：键排序、无空格、过滤 undefined、数组保序。报告确定性基础。

#### `SAMPLE_DESIGN` — `evaluate-character-dsl.ts:297-304`
§10.1 采样设计常量：24 确定输入 × 3 重复 × 两版本 = 144 次主生成，repair 每次 ≤1。

#### `emptyOnlineReport(): OnlineEvaluationReport` — `evaluate-character-dsl.ts:351-359`
离线运行的在线段占位（status: "not_run" + NOT_ENABLED 原因）。

#### `runOnlineEvaluation(config): Promise<OnlineEvaluationReport>` — `evaluate-character-dsl.ts:365-376`
在线评估桩：无条件抛 `ONLINE_EVALUATION_NOT_ENABLED`（带采样设计用量说明）；V2 gate 接线前绝不产生模型调用。

#### `EXPECTED_RED_VECTOR_IDS: ReadonlySet<string>` — `evaluate-character-dsl.ts:398`
已知红灯向量声明表（红灯即规格，落地后转绿移除）；**当前为空集**——R01/R02×2/R03 在 C5-C7 已绿、MAIN-MEMORY 移植起即期望通过（L393-397 注释）。

#### `mainScenarioSet(): ScenarioSpec[]` — `evaluate-character-dsl.ts:879-1148`
12 个固定场景数据（S01 苏遥 opening 表单收束 … S12 文本保真），每场景含 v2Text/v1Text 双协议全文与专项探针开关（expectedLabelSnapshots/expectSlotExclusivity/expectHiddenSpeaker/expectPlayerProjectionClean/expectedTextSubstrings）。纯数据函数。

#### `injectedDefectSet(): DefectSpec[]` — `evaluate-character-dsl.ts:1166-1255`
6 个注入缺陷数据（D1 截断尾/D2 未知 ID/D3 坏 look/D4 玩家代言/D5 原子性/D6 能力越权），每条含期望首过错误码与确定性 repair 函数。

#### `buildOfflineEvaluation(input): Promise<OfflineEvaluationReport>` — `evaluate-character-dsl.ts:1802-1915`
完整评估编排（主流程步骤见上）。报告含 inputs sha256、roster revision、pipeline 描述、contractVectors/scenarios/repairSim/online/summary.gateTable/totals/reportHash。

#### `renderConsoleSummary(report): string` — `evaluate-character-dsl.ts:1921-1946`
控制台摘要（向量/场景/缺陷绿灯数 + 门槛离线行 + sha256）。

#### `renderSummaryMarkdown(report): string` — `evaluate-character-dsl.ts:1948-2015`
Markdown 报告（契约向量表/场景表/缺陷表/门槛表/在线未运行段）。

**export 类型符号**（11 个，均报告 schema）：`OnlineExperimentConfig`（L307-319）、`OnlineTaskPackMetrics`（L322-341，按任务×内容包分组的 first-pass/repair/错误角色/串音/时延/token 指标）、`OnlineEvaluationReport`（L343-348）、`VectorResult`（L382-391，expectation 三态 expected-pass/expected-red/pinned-current）、`ScenarioSpec`（L860-877）、`DefectSpec`（L1155-1164）、`ScenarioResult`（L1261-1297，v2/v1/identity/textFidelity 全维结果）、`DefectResult`（L1299-1315）、`GateRow`（L1317-1322）、`OfflineEvaluationReport`（L1324-1362，schema `"character-dsl-v2-evaluation/1"`）、`OfflineEvaluationInput`（L1795-1799）。

**内部辅助（阶段函数）**：`parseArgs`（L159-262）、`isForbiddenOutPath`（L265-268）、`sha256`/`sha256File`（L284-290）、`FEMALE_A_ENTRY`（L400-408，契约向量角色注册条目）、`r01PresentationRegistry`/`r01RosterRegistry`/`r01CompileDialogueLine`（L410-483，R01 的最小 presentation/roster 注册表与 v1 行编译）、`stubPerformanceCompiler`（L485-493，恒等性能参数）、`r02ContractVoices`/`r02Factory`（L495-562，R02 的契约 voices 与 AudioDescriptorFactory）、`observeAudioIdentity`（L573-610，单条对白的音频身份观察）、`evaluateContractVectors`/`evaluateMainVectors`（L612-704/L707-852，两组向量执行器）、`mainCast`（L1376-1384，NPC 为允许说话人集）、`buildMainContext`（L1386-1419）、`evaluateScenario`（L1421-1660）、`escapeRegExp`（L1662-1664）、`evaluateDefect`（L1666-1722）、`buildGateTable`（L1724-1793）、`main`（L2021-2068）、`invokedAsCli`（L2071-2073）。

### `scripts/probe-music-composer.ts`（128 行，无 export——顶层 await 脚本）

主题作曲家决策流的**真实链路**验证探针：真实 BigModel 调用 × 真实 skill/prompt × 真实 `ComposerDecisionSchema` 复验 × 真实 `MusicThemeStore`/`ComposerSessionStore` 落盘（L2-7 头注释）。用法 `npx tsx scripts/probe-music-composer.ts [mood] [intensity] [note] [--save=谱面路径]`（L9）。
流程（顶层顺序执行）：
1. L24-33：argv 取参数 → `loadConfig("config.yaml")` + `loadApiKey` → `new SceneMusicComposerAdapter`；
2. L37-39：`mkdtemp` 临时游戏目录（探针自包含不污染 games/）→ 建两 store；
3. `round(label, brief)`（L41-109）打两轮：第一轮 fortress-night 空目录（期望 compose 首个主题）、第二轮 fortress-day 同区域昼间重访（期望 reuse 同一主题）——每轮列目录主题 → 读会话窗口 → `adapter.decide` → schema 复验（双保险，L53）→ compose 分支落盘谱面/主题/会话或 reuse 分支绑定场景/追加会话；
4. L128：打印临时主题目录路径。
被 `docs/scene-music-generation.md:5,121` 引用（含 --save 产物喂给试听页 file picker 的用法）。**产生真实模型费用**；退出码 1 = 决策失败（两次输出均未过契约，L56-60）。

**内部辅助**：`round`（L41-109，双轮共用）、`flag(name)`（L27-29，--save 解析）。

### `scripts/probe-tts-params.mjs`（105 行，无 export——顶层 await 脚本）

TTS voice-id × model 配对探针：按 `voices.yaml` 的 profile（默认 suyao_main）取 dashscope 绑定（model + voice_id_env），向官方 SpeechSynthesizer SSE 端点合成一条台词（默认"苏遥轻轻地笑了。"），统计 PCM 字节数与首块时延（L1-4 头注释、L105 输出）。步骤：读 voices.yaml（yaml 包裸解析，不经 src/config/voices.js）→ 校验 DASHSCOPE_API_KEY / voice_id_env 已设 → POST（X-DashScope-SSE: enable，seed=42）→ 跨块行缓冲 SSE 解析（L61-88，JSON 行可能跨网络分块）→ base64 audio.data 计数。失败退出码 1。被 `docs/agents/TTS-音色配置指南.md:145` 引用。

### `scripts/serve-music-demo.mjs`（95 行，无 export——常驻 HTTP 服务）

配乐试听页零依赖静态服务（`npm run demo:music` = vite build + 本脚本）：serve `dist/web`（含 music-demo.html），`/game-assets/` 映射到 `assets/`（镜像 local-web 宿主资源映射，L3-8 头注释）。要点：启动前检查 dist/web/music-demo.html 存在（L35-38，缺失提示先 build:web）；`resolveUnder`（L41-45）防路径穿越（../ 与绝对路径 → 403）；MIME 表 L22-33；仅 GET、仅监听 127.0.0.1、端口默认 4319（可 argv[2] 或 MUSIC_DEMO_PORT）。听感调参工作流：改渲染器/prompt → build:web → 本服务 → 浏览器 A/B（L7-9）。

**内部辅助**：`resolveUnder`（L41-45）、`serveFile`（L47-66，statSync + createReadStream）。

### `scripts/smoke-e2e.mjs`（149 行，无 export——顶层 await 脚本）

全栈 E2E 冒烟：真实 `createRuntimeApplication`（config.yaml）+ 真实 `LocalWebHost` + Mock TTS，由真实 ws 客户端驱动（L1-4 头注释）。覆盖 7 步：① 组合根起服（强制 mock TTS + 不开浏览器，L18-29）；② WS 带 token 连接并等 projection.snapshot（L35-63）；③ 发 runtime.command start 收 runtime.output（L66-72）；④ 向 app.audioCatalog 手工 upsert descriptor+recipe 后 POST /api/audio/synthesize 流式收 PCM 字节（L78-129）；⑤ 等 audio.task_status finished（L130-134）；⑥ 第二个 WS 连接应被拒 close 4001（控制器限额，L136-144）；⑦ host.shutdown 干净退出（L146-149）。任一断言失败 `fail()` → exit 1（L10-13）。
备注（事实观察）：L78-81 动态 import 的 `AudioDescriptorFactory`/`AudioIntentPlanner` 与 `const factory = null` 均未再使用——L80-81 注释自认"够不到内部 factory"，改用手工 descriptor；属死代码。

### `scripts/vendor-soundfonts.mjs`（88 行，无 export——一次性/按需重采）

从 gleitz/midi-js-soundfonts CDN（fastly 镜像，L20-22 主站可达性注释）抽取 FluidR3_GM 按乐器包，裁剪到 BGM 实用音域 A1–C7（midi 33–96），落 `assets/audio/soundfonts/<palette>.json` 供浏览器渲染器消费（L2-4 头注释）。`PACKS`（L26-38）12 个调色板 → GM 乐器名映射单一真源（piano/strings/pad/bass/bell/choir/guitar/harp/flute/marimba/organ/synth）。支持离线模式：argv[2] 传已下载的 `<gmName>-mp3.js` 目录（代理网络先 curl，L11-12）。许可链双 MIT（L6-7），同目录 LICENSE.md 署名。产物已在仓库（assets/audio/soundfonts/ 下 12 个 json + LICENSE.md 实存）。

**内部辅助**：`noteNameToMidi`（L44-50）、`parseGleitzPack`（L52-67，剥 gleitz 两行 if 前缀与尾逗号再 JSON.parse，按音域过滤）、`loadPackText`（L69-77，CDN 或本地）。

### `scripts/vendor-webfonts.mjs`（143 行，无 export——一次性脚本）

把 Google Fonts 的 woff2 unicode-range 子集缓存到 `web/public/fonts/`（fonts.css + files/ + OFL 许可 + README），供 web UI 离线自托管、替换 index.html 的 Google Fonts link（L2-5 头注释；Noto Serif SC 400/600/700 + Ma Shan Zheng，与 styles.css 实际字重对齐 L20 注释）。步骤：现代 Chrome UA 拉 css2 → 正则逐 @font-face 块抽 gstatic url（去重）→ `mapLimit`（L47-59，手写 8 并发限制器）下载子集 → 改写为相对路径合成 fonts.css → 拉 OFL 许可文本（失败仅告警，L108-113）→ 生成 README。幂等覆盖（L12）。产物实存于 web/public/fonts/。

**内部辅助**：`fetchText`（L41-45）、`mapLimit`（L47-59）。

### `scripts/verify-voice-guide.mjs`（35 行，无 export——一次性检查）

协作文档完整性检查（`npm run verify:voice-guide`）：`docs/agents/TTS-音色配置指南.md` 必含 12 个关键词段落（系统音色/声音复刻/声音设计/voice-id/voices.yaml/voice_revision/instruction_mode/fixed_emotion/情感提示词/longanyang/北京/排错，L6-19），且 README.md 必须链接该指南（L28-32）；缺任一 exit 1（L1-2 头注释称"Run in CI or locally before merge"，但仓库无 .github CI 目录）。

### `src/test-helpers.ts`（378 行，9 export）

#### `makeTestConfig(overrides?: DeepPartial<AppConfig>): AppConfig` — `test-helpers.ts:30-88`
全仓库共享的完整 AppConfig fixture（L23-29 注释：所有需要 Game/StoryGenerator/ports 的测试用它，勿内联副本）；overrides 深部分覆盖。内置值：test-model API、jsonl 协议、text_buffer 2/6/3、prefetch input_bridge 开、interaction hybrid 等。

#### `class MemoryRunGraph implements RunGraphPort` — `test-helpers.ts:98-157`
剧情图运行时调用记录型 test double：只记录 Game 发出的图操作序列（rootRunsStarted/begunEdges/retracedFrom/appendedBatches/decisions/endings），不复现 RunGraphCoordinator 状态机（L94-97 注释：后者配真实 GameGraphStore 另测）；`resume` 可编程。

#### `class FakeClock implements ClockPort` — `test-helpers.ts:160-171`
确定性时钟：固定起点每次读 +1ms。

#### `class FakeIdGenerator implements IdGeneratorPort` — `test-helpers.ts:174-199`
四类 ID 计数器（session/line/generation/preview）。

#### `makeTestPorts(overrides?): GamePorts` — `test-helpers.ts:206-217`
默认 port 组：MemoryRunGraph + FakeClock + FakeIdGenerator + silentDiagnosticSink；按需替换个别 port。

#### `type InteractionOpenedOutput` / `type InputPreviewOpenedOutput` — `test-helpers.ts:223-230`
RuntimeOutput 两个 Extract 收窄类型（供 handlers 签名）。

#### `interface MemoryControllerHandlers` — `test-helpers.ts:238-251`
三个可选回调；缺省行为：playback_ready→自动 advance、input_preview_opened→自动 confirm（L233-237 注释）。

#### `class MemoryController` — `test-helpers.ts:258-378`
内存版运行时驱动：`attach(game)` 订阅并记录全部 RuntimeOutput；断言助手（`count`/`countPlayback`/`playbackEvents`/`ended`）；命令助手（`advance`/`select`/`submitInput`/`confirm`/`cancel`）；异步等待（`advanceUntilPlayed`/`advanceUntilInteractionOrEnd`，5ms 轮询 waitFor L330-336）。测试借此无终端 UI 驱动整局会话。

**内部辅助**：`DeepPartial<T>` 类型（L19-21）。

### `src/game-test-kit.ts`（341 行，18 export）

定位：Game 套件（game*.test.ts）专用 fixtures，从 game.test.ts 抽出以便按子系统拆分（L2-5 头注释）。依赖 test-helpers。

#### `makeGameConfig(overrides?): AppConfig` — `game-test-kit.ts:51-56`
makeTestConfig 变体：start_threshold=1、refill_threshold=-1 显式关闭 §73-§76 低水位调度器（Game core 测试不覆盖调度器，game-dsl.test.ts 用真实阈值另测，L43-50 注释）。

#### `makeMockGenerator(): StoryGeneratorPort` — `game-test-kit.ts:58-74`
vi.fn mock：generateOpening/Continuation/InputResponse 空 mock；generateBranchPrefetch 缺省空分支；generateInputBridge 缺省一条旁白（§34 文档默认桥接）。

#### `makeMockMedia(): MediaPlannerPort` — `game-test-kit.ts:76-86`
七方法 vi.fn mock，isReady 恒 true、waitUntilReady 恒 resolve。

#### `makeMockStatus(): RuntimeStatus` — `game-test-kit.ts:88-99`
八方法 mock，snapshot 返回 `{branches:{}}`。

#### `type EnvelopeDraft` — `game-test-kit.ts:101-106`
测试草稿事件联合（narration/dialogue/choice/InteractionEvent/EndEvent）。

#### `groupFromEvent(draft): EventGroupDraft` — `game-test-kit.ts:109-162`
单草稿 → DSL 组：narration/dialogue 直转（visual/name 关闭）、choice/input → interaction 组；end 抛错（"end 事件不是组：请用段结束哨兵表达结局"，L139）。

#### `envelope(drafts): GenerationEnvelope` — `game-test-kit.ts:170-186`
草稿数组 → 最小 envelope：组 + segmentEnd（end 草稿映射 reason=ending 哨兵而非组）。

#### `handleFromDrafts(id, drafts): GenerationHandle` — `game-test-kit.ts:194-205`
port 形态 mock handle：草稿经 onGroup 流出（与真实 generator 的 DSL 流到达方式一致，L188-193 注释）。

#### `narrationEvent(text?)` / `endEvent(endingId?, text?)` — `game-test-kit.ts:207-213`
两个事件字面量速造。

#### `makeManualInputResponse(generator, run): void` — `game-test-kit.ts:219-230`
把 generateInputResponse mock 成自定义 run 实现。

#### `inputInteractionFixture()` / `choiceFixture(options?)` / `hybridFixture(interactionId?, bridgeText?)` — `game-test-kit.ts:232-264`
三个交互事件 fixture（input/choice/hybrid 含 input_bridge）。

#### `interface GameScopingInternals` — `game-test-kit.ts:271-276`
测试窥探 Game 私有字段的结构类型（运行时抹除，非受检 cast 文档化测试依赖，L266-270 注释）。

#### `type DirectorCall` — `game-test-kit.ts:278-283`
导演 fake 的调用记录联合。

#### `makeDirectorFake(briefOverrides?)` — `game-test-kit.ts:284-334`
NarrativeDirectorPort fake：记录 getMemoryProjection/observeCommitted/checkpoint/flush 调用；restoreFromDigest 记忆摘要收集（M1.4 恢复路径，L323-326）；getMemoryDigest 返回 EMPTY_MEMORY_DIGEST。

#### `makePortsWithDirector(director): GamePorts` — `game-test-kit.ts:336-341`
makeTestPorts + 注入 narrativeDirector。

### `src/test-support/character-contract-cases.ts`（92 行，4 export）

双分支（main / campus）字节一致的角色身份契约向量纯数据（L5-9 注释：本文件不得引入分支差异；分支特有预期放各自 src/character-contract.test.ts）。红绿纪律（L11-17）：前三者断言期望行为、PARSE_COLON_DIVERGENCE_CASE 固定当前缺陷并标"待消除"。

#### `RENAME_IDENTITY_CASE` — `character-contract-cases.ts:25-38`
R01 改名后身份保持向量：female_A / 许晚晴 / 神秘女子、原名行与改名行、对白文本。

#### `VOICE_PROFILE_STABILITY_CASE` — `character-contract-cases.ts:47-56`
R02 音色跨标签稳定向量：xuwanqing 配置键（特意与资产 id 不同源，重现三路解析全落空的缺陷现场，L42-46 注释）、voiceProfile/voiceIdEnv/voiceId/lineId。

#### `TEMPLATE_LITERAL_CASE` — `character-contract-cases.ts:65-72`
R03 模板字面单遍替换向量：计划模块 ./application/prompts/template.js、模板 `{player_input}|{nonce}`、值含 `$& {nonce}`、期望 `$& {nonce}|N1`。

#### `PARSE_COLON_DIVERGENCE_CASE` — `character-contract-cases.ts:81-92`
R09 冒号全半角解析分歧向量（pinned current behavior — NOT a future compatibility spec）：半角→dialogue 幻影说话人、全角→narration 降级。

## 4. 域内数据流

### 4.1 一次图像生产（`pnpm image generate "立绘" --cutout --keep-raw`）

```
.env (IMAGE_GEN_BASE_URL/API_KEY/...)
  │ loadEnvConfig（env.ts:64；fallbacks=MODEL/SIZE/QUALITY 中间层）
  ▼
cli.ts main(L411) → runGenerate(L332)
  ├─ createImageClient（client.ts:291；timeout/retries：flag > env > 默认）
  ├─ baseParams + buildCutoutOptions（L227）
  ├─ applyCutoutParams（L202）→ withCutoutPromptHint（cutout.ts:47 注入白底提示词）
  │    + background=transparent + outputFormat=png（冲突 flag 报错）
  ▼
client.generate（client.ts:475）
  ├─ resolveGenerationParams（validate.ts:401；三层合并+全量校验，非法本地抛）
  ├─ toGenerationRequestBody（validate.ts:450）→ sendWithRetry（L315；429/5xx 指数退避）
  └─ toResult（L167；zod 校验 + b64_json → bytes）
  ▼
reportResult（cli.ts:260）
  ├─ 逐张 processForCutout（cutout.ts:289）
  │    ├─ transparentRatio ≥1% → kept-alpha（跳过）
  │    ├─ aiMatting（matting.ts:159；ISNet onnx 推理，cpu/dml）→ ai-matting
  │    └─ 失败/无透明 → floodCutout（cutoutBackground L97 边界泛洪）→ cutout
  │         （移除 <1% → no-background 保留原图）
  ├─ saveImages（files.ts:59）→ output/image-gen/{时间戳}-{model}-{size}-NN.png
  └─ --keep-raw → saveImages(raws, "{前缀}-raw") 另存原图
```

产出落 `output/`（gitignored）；作者挑选后人工入 `assets/`（当前仓库素材实际来自第三方站，见 §1）。

### 4.2 一次 evaluate-character-dsl 评估（离线，零模型调用）

```
characters.yaml + voices.yaml + assets/resources.yaml
  │ buildMainContext（L1386：pack roster / asset catalog / voices → registry×2 + factory）
  ▼
buildOfflineEvaluation（L1802）
  ├─ 契约向量：evaluateContractVectors（R01/R02-shared，共享 fixture）
  │            + evaluateMainVectors（R02-main/R03/R09-pinned/MAIN-MEMORY，main 上下文）
  ├─ 场景回放：mainScenarioSet 12 条 × evaluateScenario
  │    v2: compileSegmentV2 ──┐
  │    v1: parseDslSegmentText + compileEventGroups ──┤ 双协议对照
  │    serializeStoryContext 投影（稳定 id / 无裸标签头）
  │    AudioDescriptorFactory 音频身份（speakerId / 音色单例 / 化名稳定）
  │    专项探针：槽位互斥(S06) 画外(S10) 玩家投影(S08) 名牌快照(S07) 文本保真(S12)
  ├─ 修复模拟：injectedDefectSet 6 条 × evaluateDefect
  │    compileSegmentV2 首过（错误码匹配）→ compileSegmentV2WithRepair（脚本化修复）
  │    D5 原子性 / D2 前缀纯净专项断言
  ├─ buildGateTable（§10.2 门槛：离线行给值，在线行 TBD-online）
  └─ reportHash = sha256(stableStringify(report))（L1913，确定性指纹）
  ▼
stdout 摘要（renderConsoleSummary）；--out 时 report.json + summary.md
```

## 5. 跨域接口

**工具 → 生产模块（import 方向）**：

| 工具 | import 的生产模块 |
|---|---|
| `scripts/evaluate-character-dsl.ts` | `src/test-support/character-contract-cases.js`；`src/core/protocol/gal-dsl/`（line-parser、text-pipeline、compiler、capabilities、types）；`src/core/characters/`（registry、types）；`src/core/presentation/`（types、defaults、reducer）；`src/core/assets/catalog.js`；`src/adapters/static/character-pack-loader.js`；`src/application/assets/asset-catalog-loader.js`；`src/application/audio/`（audio-descriptor-factory、performance-compiler 类型）；`src/application/narrative/memory-validator.js`；`src/config/voices.js`；`src/story/context-builder.js`；`src/schema.js`（类型）——共 12 个生产模块 + 1 个测试支撑模块 |
| `scripts/probe-music-composer.ts` | `src/config.js`（loadConfig/loadApiKey）；`src/shared/music/theme.js`（schema/extractMotifHint/themeScoreStats/COMPOSER_SESSION_WINDOW_TURNS）；`src/adapters/llm/scene-music-composer-adapter.js`；`src/adapters/storage/music-theme-store.js`、`composer-session-store.js` |
| `scripts/smoke-e2e.mjs` | `src/bootstrap/create-runtime-application.js`；`src/hosts/local-web/local-web-host.js`；动态 `src/application/audio/audio-descriptor-factory.js`、`audio-intent-planner.js`（后两个 import 后未使用，见 §7） |
| `scripts/probe-tts-params.mjs` | 无（裸读 voices.yaml，yaml 包直解析） |
| `src/tools/image-gen/**` | 无（域内自洽；仅第三方包 zod/pngjs/onnxruntime-node/@imgly） |
| `scripts/serve-music-demo.mjs` / `vendor-*.mjs` / `verify-voice-guide.mjs` | 无 |

**生产 → 工具**：零。`src/`（image-gen 目录外）与 `web/` 无任何 `tools/image-gen` 引用；评估器与探针也不被生产代码 import。

**测试基建的消费方**（grep 全仓验证）：
- `src/test-helpers.ts` ← 19 个 `.test.ts`（src 根 11 个：game.test.ts 与 game-{branch-selection,defense-beat,dsl,dsl-v2,generation-identity,graph-restore,input,interactions,metrics} 9 个前缀测试 + llm.test.ts；adapters 2 个：protocol-card-wiring、game-graph-store；application/graph 4 个：run-graph-{confluence,coordinator,gc,retrace}；bootstrap/create-runtime-application、hosts/local-web/local-web-host 各 1）+ `src/game-test-kit.ts`（唯一生产侧消费者）；
- `src/game-test-kit.ts` ← 5 个：`game.test.ts`、`game-defense-beat.test.ts`、`game-graph-restore.test.ts`、`game-input.test.ts`、`game-interactions.test.ts`；
- `src/test-support/character-contract-cases.ts` ← `scripts/evaluate-character-dsl.ts` + 5 个测试：`src/character-contract.test.ts`、`src/core/protocol/gal-dsl/line-parser.test.ts`、`src/story/context-builder.test.ts`、`src/application/audio/audio-descriptor-factory.test.ts`、`src/application/prompts/template.test.ts`——同一份向量数据同时钉住单测与评估器两条验收路径。

**工具与资产的落盘关系**：vendor-soundfonts → `assets/audio/soundfonts/*.json`（12 文件已入库）；vendor-webfonts → `web/public/fonts/`（已入库）；serve-music-demo 读 `dist/web`（vite 产物，入口 `web/music-demo.html`，vite.config.ts:20 musicDemo rollup 入口）+ `assets/`；verify-voice-guide 读 `docs/agents/TTS-音色配置指南.md` + `README.md`。

## 6. 测试覆盖（工具的自验方式与被 CI/流程引用情况）

| 工具 | 自验方式 | 被流程引用 |
|---|---|---|
| image-gen core（validate/client/env/files/cutout/matting） | 6 个 colocated `.test.ts` 共 **77 个 it**（client 18 / cutout 20 / env 5 / files 6 / matting 5 / validate 23），`pnpm test` 收编（vitest include `src/**/*.test.ts`）；fetch/sleepImpl/aiMattingImpl 注入，全程无网络无模型（client.ts:10 注释） | `pnpm image`（package.json:20）；无 CI（仓库无 .github） |
| image-gen CLI（cli.ts） | 无直接测试；经 USAGE 文本与 core 测试间接保障 | 同上 |
| evaluate-character-dsl.ts | 自身即验收器：确定性输出（sha256 指纹）+ 已知红灯机制（EXPECTED_RED_VECTOR_IDS 空集 = 全绿）；`invokedAsCli` 防动态导入误执行（L2070-2073）。**main 分支无测试 import 它** | 手动 `npm exec tsx -- scripts/evaluate-character-dsl.ts`（USAGE 自带 `--` 分隔符提醒，L51）；无 CI |
| probe-music-composer.ts | 运行即验证（真实 BigModel 两轮 compose/reuse + schema 复验 + exitCode）；**真实费用** | `docs/scene-music-generation.md` 引导手动运行 |
| probe-tts-params.mjs | 运行即验证（PCM 字节数 > 0 + 首块时延）；真实 DashScope 调用 | `docs/agents/TTS-音色配置指南.md:145` 引导 |
| smoke-e2e.mjs | 内建 7 步断言（fail → exit 1），覆盖 WS auth/projection/command/TTS 流/task status/4001 限额/shutdown | 手动 `node scripts/smoke-e2e.mjs`；无 npm script、无 CI |
| serve-music-demo.mjs | 启动自检（缺 dist 产物即退出） | `npm run demo:music`（package.json:14） |
| vendor-soundfonts / vendor-webfonts | 幂等重跑；产物已入库（soundfonts 12 json、web/public/fonts/ 全套） | 手动按需重采 |
| verify-voice-guide.mjs | 自身即断言（12 关键词 + README 链接） | `npm run verify:voice-guide`（package.json:19）；头注释称 CI/pre-merge，但仓库无 CI 目录 |
| test-helpers / game-test-kit / contract-cases | 被消费方测试间接钉住（见 §5 消费方清单） | `pnpm test` 全量 |

vitest 侧：`vitest.config.ts` 仅 15 行（globals/node 环境/include src+web/`@shared` alias），无独立 setup 文件、无 coverage 配置。

## 7. 重构关注点

1. `scripts/evaluate-character-dsl.ts:1-2084` — 2084 行单文件，超出 `.hygiene.config.json` source fail=900 阈值三倍但未入 allowlist；评估逻辑（约 1000 行）与 12 场景全文数据（L879-1148，v2Text/v1Text 逐行内联约 270 行）+ 6 缺陷数据（L1166-1255）混在一体。README 目录无对应使用文档（docs/ 下无该 harness 说明）。附（optimization-plan 复核补实）：`.hygiene.config.json` allowlist 现有 5 项，其中 `src/game.ts` 豁免注释「现 1576 行」、generator 豁免注释「1172 行」均已过期（实际 1983/1927）；`memory-validator.ts`(1188)、`run-graph-coordinator.ts`(929)、`compiler.ts`(1381) 超过 fail=900 却未入 allowlist；hygiene 工具扫描范围是否含 scripts/ 仍为 TODO-未核实。
2. `scripts/evaluate-character-dsl.ts:2070-2073` — `invokedAsCli` 判定注释称防"vitest 动态导入"，但 main 分支零 import 者（grep 验证）；export 面 21 个符号全部无消费者，为跨分支复用而导出（campus 同源脚本共享的口径）。
3. `scripts/smoke-e2e.mjs:78-81` — 动态 import `AudioDescriptorFactory`/`AudioIntentPlanner` 后均未使用，`const factory = null` 死赋值（注释自认够不到内部 factory）；手写 descriptor 的注释链（L74-92 三段"we can't..."）暴露组合根封装的可达性缺口。
4. `src/tools/image-gen/README.md:347` — "仅本工具的 52 个用例"已过时：实测 6 测试文件 77 个 it（client 18/cutout 20/env 5/files 6/matting 5/validate 23）。
5. `src/tools/image-gen/cutout.ts:240` — `CutoutProcessOptions` 内 L240 的 doc 注释"AI 模型资源目录或镜像地址"后面没有对应字段（疑似删字段后残留孤儿注释）；同接口 L243 modelPath 有自己的注释。
6. `src/tools/image-gen/onnxruntime-node.d.ts:1-5` — 手写 ambient shim 钉死 onnxruntime-node@1.17.x 的 API 面（上游 types 字段缺陷）；升级依赖版本时此文件不会自动失效，需人工复核。
7. `src/tools/image-gen/types.ts:62-76` — `GenerationParamsInput` 用 `[key: string]: unknown` 索引签名 + 全 unknown 可选字段：宽松输入是刻意设计（CLI/.env 复用同一校验，validate.ts:16-17），但使编译期拼写错误不可见，全部推迟到运行时 issues。
8. `scripts/` 运行方式不统一 — `.ts` 脚本（evaluate-character-dsl、probe-music-composer）需 `npm exec tsx --`（USAGE L51 专门提醒 `--` 分隔符陷阱），`.mjs` 直接 `node`；package.json scripts 只包装了 3 个（demo:music/verify:voice-guide/image），smoke-e2e 与两个 probe 均靠文档口头引导，易失传。
9. `scripts/probe-music-composer.ts:31` / `scripts/probe-tts-params.mjs:11` — 两个探针直接产生真实模型/API 费用且无预算门控（对比 evaluate-character-dsl 的 --online 三参数门控 L235-249）；误运行成本不对称。
10. `src/game-test-kit.ts:271-276` — `GameScopingInternals` 以非受检 cast 窥探 Game 私有字段（注释已文档化该依赖）；Game 内部字段重命名会静默破坏 scoping 断言（TS 不检查 structural cast）。
11. `src/test-helpers.ts:330-336` — `MemoryController.waitFor` 为 5ms 轮询无超时：被等待条件永不满足时测试挂死而非失败。
12. `package.json:7-23` — 16 条 scripts 中 `dev`（`npm run dev:web` 别名）与 `test:watch` 等无文档交叉引用；`smoke-e2e` 未入 scripts 段（见第 8 条）。

## 附A · 设计评注（2026-10-25 复核轮——观察与可能方向，非约束）

- **包管理器**：本文与 00~12 各域的 `pnpm` 字样按 13 号文档 §3 的倾向保留（对比与理由见彼处）；若实施确认 pnpm，路径是 `pnpm import`（转换现有 package-lock.json）→ 删 package-lock.json → 提交 pnpm-lock.yaml，并顺带把 `"latest"` 版本 spec 收成确定版本。
- **`dev` 别名脚本**（`npm run dev:web`）与无交叉引用的 scripts——收口 scripts 段时一并整理即可。
- **`GameScopingInternals` 非受检 cast 与 `waitFor` 无超时轮询**：waitFor 加超时后失败而非挂死，属测试基建改进，不涉生产代码。
