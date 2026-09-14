# image-gen — gpt-image-2 / 2.5 图像生成小工具

对接 OpenAI Images API 兼容形态的 `gpt-image-2` / `gpt-image-2.5`（sunburst / flare）系列模型，
生成与编辑图像。**core + CLI 双层设计**：CLI 适合手工出图；core 可被任何脚本 import 复用。
官方 API、中转站均可（baseURL + apiKey 独立配置在 `.env`）。

```
src/tools/image-gen/
├── types.ts      类型与模型枚举（零依赖）
├── defaults.ts   内置默认参数（回退链最后一层）
├── validate.ts   参数归一化 + 全量校验（错误参数本地拦截，绝不发送）
├── client.ts     HTTP 客户端：JSON/multipart、SSE 流、超时、429/5xx 退避重试
├── env.ts        .env 配置加载（必填 baseUrl/apiKey + 可选默认层）
├── files.ts      文件读写助手（图片落盘、本地图片读取）
└── cli.ts        命令行入口（generate / edit 子命令）
```

零新增依赖：仅用仓库已有的 `zod`（响应校验）与 Node 20+ 内置 `fetch` / `FormData` / `parseArgs`。

## 1. 配置 .env

复制 `.env.example` 追加段到仓库根目录 `.env`（已被 .gitignore 忽略）：

```bash
# 必填
IMAGE_GEN_BASE_URL=https://api.openai.com/v1   # 填到 /v1 这一层；中转站填其给出的地址
IMAGE_GEN_API_KEY=sk-xxxx                      # 与 BASE_URL 配套的 Key

# 可选（参数默认值的中间层，CLI 显式参数优先）
# IMAGE_GEN_MODEL=gpt-image-2
# IMAGE_GEN_SIZE=auto
# IMAGE_GEN_QUALITY=auto
# IMAGE_GEN_TIMEOUT_MS=300000
# IMAGE_GEN_MAX_RETRIES=2
# IMAGE_GEN_OUTPUT_DIR=output/image-gen
```

裸域名（无路径）的 baseURL 会自动补 `/v1`。

## 2. CLI 用法

```bash
# 文生图（竖版立绘）
npm run image -- generate "雨夜校园天台，少女回望镜头，赛璐璐风格" --size 1024x1536 --quality high

# 透明背景 PNG，一次两张
npm run image -- generate "角色立绘，白底" --background transparent --format png --n 2

# 流式 + 保存部分图预览
npm run image -- generate "cg：夕阳下的教室" --stream --partial-images 2 --save-partials

# 图片编辑：垫图 + 局部重绘（mask 透明区域为重绘区）
npm run image -- edit "把背景换成黄昏" --image ./photo.png --input-fidelity high
npm run image -- edit "只改面部表情" --image ./standee.png --mask ./mask.png

npm run image -- help   # 全部选项
```

结果默认写入 `output/image-gen/`（已 gitignore），文件名 `{时间戳}-{model}-{size}-{序号}.png`，
并打印 usage tokens。**退出码**：0 成功；2 参数/配置错误（未发请求）；1 API/网络错误。

## 3. 脚本调用 core

```ts
import "dotenv/config";                       // 复用仓库 scripts/*.mjs 的惯例
import { createImageClient } from "../src/tools/image-gen/client.js";
import { loadEnvConfig } from "../src/tools/image-gen/env.js";
import { loadImageFile, saveImages, defaultBasename } from "../src/tools/image-gen/files.js";

const env = loadEnvConfig();
const client = createImageClient({ apiKey: env.apiKey, baseUrl: env.baseUrl });

const result = await client.generate({
  prompt: "雨夜校园天台，赛璐璐风格",
  size: "1024x1536",
  quality: "high",
  n: 2,
});
await saveImages(result.images, "output/image-gen", defaultBasename(result.model, result.size));

// 编辑（垫图）
const img = await loadImageFile("assets/raw/ref.png");
await client.edit({ prompt: "换成冬季制服", images: [img], inputFidelity: "high" });

// 流式
for await (const event of client.generateStream({ prompt: "封面图" })) {
  if (event.type === "partial") console.log(`部分图 #${event.index + 1}`);
  else saveImages(event.result.images, "output/image-gen", "cover");
}
```

脚本可传自己的默认层：`client.generate(params)` 无 env 依赖的等价形式是
`createImageClient({ apiKey, baseUrl })`；默认值回退见下。

## 4. 默认值回退链

```
显式参数（CLI flag / 脚本入参）
  > .env 中间默认层（IMAGE_GEN_MODEL / SIZE / QUALITY；loadEnvConfig().fallbacks）
    > 内置默认（defaults.ts：gpt-image-2 / auto / auto / n=1 / background=auto / moderation=auto / stream=false）
```

core 层 `resolveGenerationParams(params, fallbacks)` 亦可接收自定义中间层。

## 5. 参数全集与校验规则

校验失败的参数**在本地报错、绝不发往服务端**；问题一次性全部列出（退出码 2）。

| 参数 | 允许值 / 规则 | 默认 |
|---|---|---|
| `prompt` | 必填，非空白，≤32000 字符 | — |
| `model` | `gpt-image-2`、`gpt-image-2-2026-04-21`、`gpt-image-2.5-sunburst(-2026-09-08)`、`gpt-image-2.5-flare(-2026-09-08)` | `gpt-image-2` |
| `size` | `auto`；标准 `1024x1024` / `1536x1024` / `1024x1536`；任意 `WxH`：宽高均 16 的倍数、宽高比 1:3~3:1、≤3840×2160、≥256 | `auto` |
| `quality` | `auto` `low` `medium` `high`；`xhigh` `max` **仅 2.5 系列**（配 gpt-image-2 本地报错） | `auto` |
| `n` | 整数 1~10 | 1 |
| `background` | `transparent` `opaque` `auto`；transparent 与 jpeg 组合本地报错 | `auto` |
| `outputFormat` | `png` `jpeg` `webp` | 不发送（服务端 png） |
| `outputCompression` | 整数 0~100，仅 jpeg/webp（配 png 本地报错） | 不发送 |
| `moderation` | `low` `auto` | `auto` |
| `stream` | 布尔；`partialImages`(0~3) 必须配合 stream | `false` |
| `user` | 终端用户标识 | 不发送 |
| edit：`images` | 1~16 张 png/jpg/webp | 必填 |
| edit：`mask` | 单张，透明区域为重绘区 | 不发送 |
| edit：`inputFidelity` | `high` `low` | 不发送 |
| ~~`responseFormat`~~ / ~~`style`~~ | gpt-image 系列**不支持**，传入即本地报错 | — |

输入形态宽松：camelCase 与 snake_case（`output_format`）等价，字符串数字（`"3"`）自动转换；
未知键直接报错。

## 6. 错误类型

| 错误 | 抛出时机 | 处理建议 |
|---|---|---|
| `ImageParamError` | 参数/配置校验失败（含 .env 缺失、未知 flag） | 按 `issues` 修正后重试 |
| `ImageApiError` | HTTP 非 2xx（`status` 为状态码）或网络失败（`status=0`） | 429/5xx 已自动退避重试（默认 2 次）；查看 `message`/`code`/`requestId` |

## 7. 冒烟验证（需要真实 Key，会产生少量费用）

```bash
npm run image -- generate "smoke test: a red apple on a table" --size 1024x1024 --quality low
npm run typecheck && npm test   # 本地校验/单测不需要 Key
```
