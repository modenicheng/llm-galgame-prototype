# image-gen 使用指南

对接 gpt-image-2 / gpt-image-2.5（sunburst / flare）系列图像生成与编辑 API 的独立小工具。
采用 **core + CLI 双层设计**：CLI 适合手工出图，core 可被任意脚本 import 复用。
官方 API 与 OpenAI 兼容中转站均可接入，`baseURL` 与 `apiKey` 独立配置在 `.env`。

```
src/tools/image-gen/
├── types.ts      类型与模型枚举（零依赖）
├── defaults.ts   内置默认参数（回退链最后一层）
├── validate.ts   参数归一化 + 全量校验（非法参数本地拦截，绝不发往服务端）
├── client.ts     HTTP 客户端：JSON / multipart、SSE 流、超时、429/5xx 退避重试
├── env.ts        .env 配置加载（必填 baseURL/apiKey + 可选默认层）
├── files.ts      文件读写助手（结果落盘、本地图片读取）
├── cutout.ts     几何抠图（边界连通泛洪）+ 抠图决策入口（双引擎）
├── matting.ts    AI 抠图引擎（ISNet 模型，onnxruntime-node 直载，CPU/DirectML）
├── cli.ts        命令行入口（generate / edit 子命令）
└── *.test.ts     单元测试（fetch/模型注入，无网络）
```

零新增运行时依赖：仅使用仓库已有的 `zod`（响应结构校验）与 Node 20+ 内置的
`fetch` / `FormData` / `parseArgs`；抠图功能额外使用 `pngjs`（PNG 编解码）、
`onnxruntime-node`（本地推理）与 `@imgly/background-removal-node`（仅作 ISNet
模型数据来源，不引用其代码）。要求 Node ≥ 20。

---

## 1. 快速开始

**① 配置 `.env`**（仓库根目录，`.env` 已被 .gitignore 忽略）：

```bash
IMAGE_GEN_BASE_URL=https://api.openai.com/v1
IMAGE_GEN_API_KEY=sk-xxxxxxxx
```

**② 出第一张图**：

```bash
pnpm image generate "雨夜校园天台，少女回望镜头，赛璐璐风格" --size 1024x1536
```

**③ 取结果**：图片默认写入 `output/image-gen/`，同时打印 token 用量：

```
已保存: output/image-gen/20260914-143012-gpt-image-2-1024x1536-01.png
tokens: input=52 output=1420 total=1472
```

---

## 2. .env 配置参考

| 变量 | 必填 | 说明 | 默认 |
|---|---|---|---|
| `IMAGE_GEN_BASE_URL` | ✅ | API 地址，**填到 `/v1` 这一层**（工具拼接 `/images/generations` 等路径）；裸域名会自动补 `/v1` | — |
| `IMAGE_GEN_API_KEY` | ✅ | 与 BASE_URL 配套的 Key | — |
| `IMAGE_GEN_MODEL` | — | 默认模型（中间默认层，显式传参优先） | `gpt-image-2` |
| `IMAGE_GEN_SIZE` | — | 默认尺寸 | `auto` |
| `IMAGE_GEN_QUALITY` | — | 默认画质档 | `auto` |
| `IMAGE_GEN_TIMEOUT_MS` | — | 单次请求超时（毫秒） | `300000` |
| `IMAGE_GEN_MAX_RETRIES` | — | 429/5xx/网络错误的最大重试次数（`0` 关闭重试） | `2` |
| `IMAGE_GEN_OUTPUT_DIR` | — | 结果输出目录 | `output/image-gen` |
| `IMAGE_GEN_CUTOUT_ENGINE` | — | 抠图引擎：`ai`（默认，ISNet 软边）/ `flood`（纯几何离线） | `ai` |
| `IMAGE_GEN_CUTOUT_DEVICE` | — | AI 抠图执行设备：`cpu`（默认）/ `dml`（DirectML，批量推荐） | `cpu` |
| `IMAGE_GEN_CUTOUT_MODEL_PATH` | — | 独立 .onnx 模型文件路径（缺省用 imgly 包内自带的模型资源） | — |

可选变量的值为空字符串时视同未配置。完整的示例见仓库根目录 `.env.example` 的
“图像生成”段落。

---

## 3. CLI 使用

入口：`pnpm image <子命令> [参数]`（pnpm 会把脚本名后的参数原样透传，无需 `--` 分隔符）。

### 3.1 generate — 文生图

```bash
# 竖版立绘（高质量）
pnpm image generate "雨夜校园天台，少女回望镜头，赛璐璐风格" \
  --size 1024x1536 --quality high

# 透明底 PNG 立绘，一次两张
pnpm image generate "校服少女立绘，全身，白底" \
  --background transparent --format png --n 2

# 横版 CG，2.5 系列最高画质
pnpm image generate "夕阳教室，光尘浮动，电影感构图" \
  --model gpt-image-2.5-sunburst --size 1536x1024 --quality xhigh

# 任意尺寸（16 的倍数，宽高比 1:3 ~ 3:1）
pnpm image generate "手机竖屏壁纸" --size 1152x2048

# 流式生成并保存逐步精化的部分图预览
pnpm image generate "cg：天台决战" --stream --partial-images 2 --save-partials

# 透明底立绘（自动抠图兜底，见 §3.5）
pnpm image generate "大学生形象立绘，站姿全身像" --size 1024x1536 --cutout --keep-raw
```

### 3.2 edit — 图片编辑（垫图 / mask 局部重绘）

```bash
# 垫图改背景，高保真保留原图主体
pnpm image edit "把背景换成黄昏的操场" \
  --image ./assets/raw/standee.png --input-fidelity high

# 多张参考图（最多 16 张）
pnpm image edit "融合两张角色的服装设计" \
  --image ./a.png --image ./b.webp

# mask 局部重绘：mask 图中“透明区域”为重绘区（尺寸须与参考图一致）
pnpm image edit "只改变面部表情为惊讶" \
  --image ./standee.png --mask ./mask.png
```

`--image` / `--mask` 支持 `.png` / `.jpg` / `.jpeg` / `.webp`。

### 3.5 透明背景与自动抠图（--cutout）

**原生支持**：gpt-image 系列支持 `background: "transparent"`（要求输出 png/webp），
即 `--background transparent --format png`，多数情况下直接产出带 alpha 通道的立绘。

**但遵从度不是 100%**：模型偶发渲染成白底甚至棋盘格假透明；走中转站时透明参数
也可能被丢弃。因此推荐立绘一律使用 `--cutout` 模式（双保险）：

1. **请求侧自动注入**：提示词自动追加“纯白色背景，主体完整，边缘清晰锐利，无阴影，
   无渐变，无杂物”（已含白底关键词则不重复）；同时自动设置
   `background: transparent` + `output_format: png`（与显式 `--background opaque`、
   `--format jpeg|webp` 组合会直接报错）。
2. **结果侧自动处理**：逐张检测 alpha——已有真透明（占比 ≥1%）直接采用并提示
   “跳过抠图”；否则自动抠图兜底。
3. `--keep-raw` 可在抠图发生时保留原图（`{前缀}-raw-NN.png`）。

**抠图引擎**（`--cutout-engine`，默认 `ai`）：

- **`ai`（推荐）**：ISNet 分割模型，`onnxruntime-node` 本地推理（`matting.ts`
  直载，模型资源随 imgly 包本地分发，无需联网）。输出**带羽化的软边 alpha**，
  发丝、碎发边缘干净（实测立绘发丝效果远好于几何方案）。执行设备由
  `--cutout-device` 选择：默认 CPU（1024×1536 约 2s/张）；`dml`（DirectML）
  推理约 7× 提速（实测 RTX 5060：1862ms → 268ms），但会话初始化约 14s，
  **适合一个进程连抠多张的批处理脚本**，单张建议 CPU。模型失败自动回退
  `flood` 并提示。
- **`flood`**：纯几何方案（零模型、确定性强）——从图像边界连通泛洪移除近白
  像素（容差 40），绝不误伤角色内部白色区域；可选 `--cutout-clean` 清除被
  深色描边包围的小面积封闭白缝（发丝间/领口，面积 ≤0.5%）。局限：发丝间
  封闭白缝会残留、硬边无羽化，仅作为离线兜底。

许可证说明：推理栈（onnxruntime）与模型（ISNet）均为 **MIT**；AI 引擎运行时
只读取 imgly 包内的模型数据文件，不引用其 AGPL 代码。

当前限制：

- **棋盘格假透明**与深色/复杂背景：AI 引擎通常可处理；flood 引擎无法移除
  （会提示“未能抠图，保留原图”）；
- 抠图边缘为软边但极端发丝仍可能有轻微残留，重要素材建议 `--keep-raw` 保留
  原图备选。

### 3.3 选项参考

共用选项（CLI flag > `.env` 中间默认层 > 内置默认）：

| Flag | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--model` | 见 §5 模型表 | `gpt-image-2` | 模型 ID（含日期快照） |
| `--size` | `auto` / `WxH` | `auto` | 规则见 §5 |
| `--quality` | `auto` `low` `medium` `high`（`xhigh` `max` 仅 2.5 系列） | `auto` | 画质档 |
| `--n` | 1~10 | `1` | 生成张数 |
| `--background` | `auto` `transparent` `opaque` | `auto` | 透明底需配 png/webp |
| `--format` | `png` `jpeg` `webp` | 不发送（服务端 png） | 输出格式 |
| `--compression` | 0~100 | 不发送 | 仅 jpeg/webp 有效 |
| `--moderation` | `low` `auto` | `auto` | 内容审核强度 |
| `--stream` | 布尔开关 | 关 | SSE 流式，配合 `--partial-images` 0~3 |
| `--save-partials` | 布尔开关 | 关 | 保存部分图预览（`*-partialNN.png`） |
| `--cutout` | 布尔开关 | 关 | 自动抠图模式（见 §3.5）：注入白底提示词、请求透明 png、必要时自动抠图 |
| `--cutout-engine` | `ai` / `flood` | `ai` | AI 模型抠图（软边发丝）或纯几何离线抠图 |
| `--cutout-device` | `cpu` / `dml` | `cpu` | AI 引擎执行设备：dml（DirectML）推理约 7× 提速，但会话初始化约 14s，适合批量脚本 |
| `--cutout-clean` | 布尔开关 | 关 | 仅 flood 引擎：追加清除封闭白缝（发丝间/领口）；对帆布鞋类有破洞风险 |
| `--keep-raw` | 布尔开关 | 关 | 抠图发生时保留原始图（`{前缀}-raw-NN.png`） |
| `--user` | 任意标识 | 不发送 | 终端用户标识（便于服务端归因） |
| `--out` | 目录 | `output/image-gen` | 输出目录 |
| `--timeout` | 毫秒 | `300000` | 单次请求超时 |
| `--retries` | ≥0 | `2` | 重试次数 |

edit 专属：`--image <路径>`（可重复，1~16 张）、`--mask <路径>`、
`--input-fidelity high|low`。

### 3.4 输出与退出码

- 文件名：`{本地时间戳}-{model}-{size}-{序号}.{ext}`；流式部分图为
  `{前缀}-partial{NN}.png`
- 打印内容：保存路径、`revised prompt`（模型改写的提示词，若有）、token 用量
- 退出码：**0** 成功；**2** 参数/配置错误（未发出网络请求）；**1** API/网络错误
- 进度信息（流式部分图等）走 stderr，结果路径走 stdout，便于重定向

---

## 4. 脚本调用（core API）

core 不读 `.env`、不做文件 IO，任何脚本都能安全复用。

### 4.1 一次性脚本（推荐放 `scripts/*.mjs`，与仓库现有脚本一致）

```js
// scripts/gen-assets.mjs
import "dotenv/config";
import { createImageClient } from "../src/tools/image-gen/client.js";
import { loadEnvConfig } from "../src/tools/image-gen/env.js";
import { loadImageFile, saveImages, defaultBasename } from "../src/tools/image-gen/files.js";

const env = loadEnvConfig(); // 缺配置会抛 ImageParamError，报错信息一次列全
const client = createImageClient({ apiKey: env.apiKey, baseUrl: env.baseUrl });

// 文生图（可传自己的中间默认层：client.generate(params) 的 params 键支持 snake_case）
const result = await client.generate({
  prompt: "雨夜校园天台，赛璐璐风格",
  size: "1024x1536",
  quality: "high",
  n: 2,
});
await saveImages(result.images, "output/image-gen", defaultBasename(result.model, result.size));

// 编辑（垫图）
const ref = await loadImageFile("assets/raw/standee.png");
await client.edit({ prompt: "换成冬季制服", images: [ref], inputFidelity: "high" });

// 流式：partial 事件逐张到达，completed 收敛为最终结果
for await (const event of client.generateStream({ prompt: "封面图" })) {
  if (event.type === "partial") console.log(`部分图 #${event.index + 1}`);
  else await saveImages(event.result.images, "output/image-gen", "cover");
}
```

构建后的运行时（Node 产物）等价导入路径为
`dist/node/tools/image-gen/client.js`（`pnpm build:node` 产物）。

### 4.2 错误处理范式

```js
import { ImageParamError } from "../src/tools/image-gen/validate.js";
import { ImageApiError } from "../src/tools/image-gen/client.js";

try {
  await client.generate({ prompt: "..." });
} catch (error) {
  if (error instanceof ImageParamError) {
    console.error("参数有问题，未发请求：", error.issues); // 字段级中文原因数组
  } else if (error instanceof ImageApiError) {
    console.error(`API 失败 status=${error.status}`, error.message, error.requestId);
  } else {
    throw error;
  }
}
```

### 4.3 client 选项

```ts
createImageClient({
  apiKey: string;        // 必填
  baseUrl?: string;      // 默认 https://api.openai.com/v1
  timeoutMs?: number;    // 默认 300000
  maxRetries?: number;   // 默认 2（429/5xx/网络错误，指数退避 0.5s 起）
  fetchImpl?: typeof fetch;   // 测试注入
  sleepImpl?: (ms) => Promise<void>; // 测试注入
});
```

校验在 `generate` / `edit` / `generateStream` / `editStream` 入口强制执行，
绕过 CLI 直接调用同样受保护。`resolveGenerationParams(params, fallbacks?)` /
`resolveEditParams(params, fallbacks?)` 也可单独使用（返回强类型参数或抛
`ImageParamError`）。

---

## 5. 参数全集与校验规则

校验失败的问题会**一次性全部列出**，且不发出网络请求。输入形态宽松：
camelCase 与 snake_case（`output_format`）等价、字符串数字（`"3"`）自动转换、
未知键直接报错。

### 5.1 模型

| 模型 ID | 说明 |
|---|---|
| `gpt-image-2` | 默认；稳定基础款（快照 `gpt-image-2-2026-04-21`） |
| `gpt-image-2.5-sunburst`（`-2026-09-08`） | 2.5 基础款，画质优先，编辑精度更高 |
| `gpt-image-2.5-flare`（`-2026-09-08`） | 2.5 提速款，延迟约减半 |

### 5.2 参数规则

| 参数 | 允许值 / 规则 | 默认 |
|---|---|---|
| `prompt` | 必填，非空白，≤ 32000 字符 | — |
| `size` | `auto`；标准 `1024x1024` `1536x1024` `1024x1536`；任意 `WxH`：宽高均为 16 的倍数、宽高比 1:3~3:1、≤ 3840×2160、≥ 256 | `auto` |
| `quality` | `auto` `low` `medium` `high`；`xhigh` `max` **仅 2.5 系列**（配 gpt-image-2 本地报错并给出可用档位） | `auto` |
| `n` | 整数 1~10 | `1` |
| `background` | `transparent` `opaque` `auto`；transparent 与 jpeg 组合本地报错 | `auto` |
| `outputFormat` | `png` `jpeg` `webp` | 不发送（服务端默认 png） |
| `outputCompression` | 整数 0~100，仅 jpeg/webp 有效（配 png 本地报错） | 不发送 |
| `moderation` | `low` `auto` | `auto` |
| `stream` | 布尔；`partialImages`（0~3）必须配合 stream | `false` |
| `user` | 字符串 | 不发送 |
| edit `images` | 1~16 张 png/jpg/webp | 必填 |
| edit `mask` | 单张；透明像素 = 重绘区 | 不发送 |
| edit `inputFidelity` | `high` `low` | 不发送 |
| ~~`responseFormat`~~ / ~~`style`~~ | gpt-image 系列**不支持**（固定返回 b64_json；style 为 dall-e-3 专属），传入即本地报错 | — |

### 5.3 默认值回退链

```
显式参数（CLI flag / 脚本入参）
  > .env 中间默认层（IMAGE_GEN_MODEL / SIZE / QUALITY）
    > 内置默认（defaults.ts：gpt-image-2 / auto / auto / n=1 / background=auto
      / moderation=auto / stream=false）
```

---

## 6. 排障指南

| 现象 | 原因与处理 |
|---|---|
| `缺少 IMAGE_GEN_BASE_URL / IMAGE_GEN_API_KEY` | 未配置 `.env`；复制 `.env.example` 的图像生成段落到根目录 `.env` 后填写 |
| `HTTP 401` | Key 无效或与 BASE_URL 不配套（中转站的 key 配中转站的域名） |
| `HTTP 429`（已自动重试仍失败） | 限流；降低并发、稍后再试，或提升账号 tier |
| `HTTP 400` 且消息含某参数名 | 中转站不支持该参数/模型（如 `xhigh`）；换官方端点或去掉该参数 |
| `--cutout` 提示“AI 抠图失败，已回退白底抠图” | 模型加载/推理失败；查看上方错误详情。flood 回退可用但发丝效果差，可检查 `IMAGE_GEN_CUTOUT_MODEL_PATH` 或重跑 |
| `--cutout` 提示“未能抠图，保留原图” | 背景既无真透明、flood 也没找到近白背景；改用默认 AI 引擎或调整提示词 |
| `--cutout` 与 `--background opaque` / `--format jpeg|webp` 报冲突 | 抠图模式固定透明 png 输出；去掉冲突 flag 即可 |
| `响应项缺少 b64_json…` | 中转站改写了响应结构（返回了 url 等）；确认中转未转换响应，或联系其支持 |
| status=0 且消息含 `timed out` | 超时；`--timeout 600000` 或 `IMAGE_GEN_TIMEOUT_MS` 调大（xhigh 大图可能超 2 分钟） |
| status=0 且消息含 `ECONNREFUSED` 等 | 网络不通/代理问题；检查 BASE_URL 拼写与本地代理 |
| Windows 下提示词被截断 | Git Bash / PowerShell 引号转义差异；建议整个提示词用双引号包裹，内部避免再嵌双引号 |

费用提示：计费按模型 × 画质 × 尺寸（token 计价），每次运行结束会打印 usage，
便于估算；`--quality low` + 小尺寸适合验证连通性。

---

## 7. 开发

```bash
pnpm typecheck          # 类型检查
pnpm exec vitest run src/tools/image-gen   # 仅本工具的 52 个用例
pnpm test                   # 全仓库测试
```

改动校验规则时同步更新 `validate.test.ts` 的校验矩阵；请求体结构改动以
OpenAI Images API 参考（developers.openai.com/api/reference）为准。
