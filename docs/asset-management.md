# 项目资产管理与使用流程（Asset Lifecycle）

- 日期：2026-09-15
- 状态：现行（以 `feat/campus-ops-raspberry` 分支实现为准）
- 适用范围：背景、BGM、音效、立绘（sprite）五类素材，以及它们从制作、注册、校验、注入模型提示词到浏览器渲染的完整生命周期
- 上游规范：`docs/llm-outputs-refactor.md` §57–§60（资源 YAML、双投影、AssetResolver）、§7/§10/§15（角色绑定与 DSL）；`docs/superpowers/specs/2026-08-08-asset-pipeline-browser-design.md`（manifest 与 `/game-assets/` 路由）
- 关联文档：`assets/ATTRIBUTION.md`（授权与流通约定）、`src/tools/image-gen/README.md`（图像生成工具）、`docs/campus-ops-event-runbook.md`（展位运行手册）

---

## 目录

1. [总览：资产体系与设计原则](#1-总览资产体系与设计原则)
2. [目录结构与存放约定](#2-目录结构与存放约定)
3. [资产制作管线（生产侧）](#3-资产制作管线生产侧)
4. [资产注册：编写 resources.yaml](#4-资产注册编写-resourcesyaml)
5. [启动加载与校验](#5-启动加载与校验)
6. [运行时三投影与消费方](#6-运行时三投影与消费方)
7. [模型调用：素材表 → DSL → 舞台](#7-模型调用素材表--dsl--舞台)
8. [浏览器渲染与音频播放](#8-浏览器渲染与音频播放)
9. [变更操作手册（SOP）](#9-变更操作手册sop)
10. [授权与合规红线](#10-授权与合规红线)
11. [附录](#11-附录)

---

# 1. 总览：资产体系与设计原则

## 1.1 资产分类

| 类别 | YAML 段 | 典型文件 | 消费方式 |
| --- | --- | --- | --- |
| 背景 | `backgrounds` | `assets/backgrounds/*.jpg` | `bg <id>` 指令，持续存在 |
| BGM | `bgm` | `assets/audio/bgm/*.mp3` | `bgm <id>` / `bgm stop`，持续存在 |
| 音效 | `sound_effects` | `assets/audio/se/*.ogg` | `se <id>`，一次性 |
| 立绘组 | `sprite_sets` | `assets/characters/<组>/*.png` | 台词行 `[立绘]` 或 `ch <角色>:<变体>` |
| 角色绑定 | `characters` | （无文件，纯绑定关系） | 把内部 id、脚本名、显示名、立绘组、默认站位绑在一起 |

角色本身不是文件资产：`characters` 段只是一张"角色 → 立绘组"的绑定表。模型在 DSL 里用**内部 id**（如 `raspberry`）操纵角色，用**变体 id**（如 `gentle_smile`）切换表情。

## 1.2 三份关键文件的职责分工

| 文件 | 管什么 | 不管什么 |
| --- | --- | --- |
| `config.yaml` | 程序行为：目录路径（`assets.catalog`）、provider、阈值、音频开关 | 有哪些资源、资源含义 |
| `assets/resources.yaml` | 有哪些资源、文件在哪、剧情中代表什么、角色与素材如何绑定 | 程序行为与阈值 |
| `assets/ATTRIBUTION.md` | 每个素材的来源、授权条款、流通限制 | 注册与运行 |

## 1.3 设计原则

1. **逻辑 ID 解耦**。模型和 DSL 只见逻辑 ID（`clubroom_day`、`raspberry:calm`），永远不见文件路径。文件挪位置、换格式，DSL 不变。
2. **三投影、各取所需**（docs §59）：同一份 `AssetCatalog` 派生出
   - `ModelAssetCatalog` —— 喂给 LLM，只有 ID + 描述 + 角色绑定，**剥掉所有 `src` 路径**；
   - `PublicAssetManifest` —— 喂给浏览器，ID → 受控 URL（`/game-assets/...`），不含文件系统路径；
   - `AssetResolver` —— Node 侧 ID → `src` 文件路径，供本地渲染/诊断。
3. **启动期 fail-fast，运行期优雅降级**。目录自身的坏引用（文件缺失、交叉引用悬空、路径逃逸）在启动加载时直接抛错拒绝启动；模型输出里的坏引用（猜了不存在的 ID）只丢弃该条舞台指令、舞台保持现状、记诊断码，剧情不断。
4. **提示词缓存友好**。素材目录是会话级静态内容，在 user prompt 中置于**最前**且逐字稳定；逐请求变化的内容（任务头、nonce、进度）全部聚在尾部。不要往素材段插入任何易变内容，否则击穿 DeepSeek 前缀缓存。
5. **资产目录即模型的"选型依据"**。模型选素材完全依赖 `resources.yaml` 里的 `description` / `guidance` 文本——写得含糊，模型就用错或不敢用。描述是给模型看的检索文本，不是给人看的注释。

## 1.4 端到端链路图

```
制作侧                     注册                启动                      运行时
────────                  ──────             ──────                    ────────
src/tools/image-gen/  ──▶ assets/            config.yaml ──┐
output/*.mts 脚本         resources.yaml ──┼─▶ loadAssetCatalog()        ┌─▶ toModelCatalog ─▶ user prompt「可用素材」段
（PSD 导出/蓝幕差分/      （登记 id+src+    │   （yaml 解析 + zod 校验    │                      ─▶ LLM 输出 DSL（bg/bgm/se/ch）
  edit 重绘）              description）    │    + 文件存在性 + 逃逸检查） │                        │
人工 QC + 手动复制    ──▶ assets/<目录>     └─▶ AssetCatalog（内存）     ├─▶ toCharacterRegistry ─▶ Game 角色解析
                                              │                      ├─▶ createAssetResolver ─▶ cue 编译过滤
                                              └─▶ buildPublicAssetManifest("/game-assets/")
                                                                     │    ├─▶ GET /api/assets/manifest ─▶ 浏览器渲染器
                                                                     │    └─▶ GET /game-assets/<rel>   ─▶ 图片/音频字节
                                                                     └─▶ AudioIntentPlanner（TTS，独立链路，见 §8.3）
```

---

# 2. 目录结构与存放约定

## 2.1 `assets/` 布局

```
assets/
├── resources.yaml          # 资产目录（唯一注册入口，必须入库）
├── ATTRIBUTION.md          # 来源与授权记录（必须入库）
├── backgrounds/            # 背景图（2048→1920x1080 JPG；playground/north_canteen 六张为 realcugan 2x 的 3840x2160）
├── audio/
│   ├── bgm/                # 背景音乐
│   └── se/                 # 音效
├── characters/
│   ├── <角色id>/           # 一个立绘组一个目录：变体名 = 文件名（去扩展名）
│   └── raspberry/          #   ⚠ 不入库（内部流通，见 §10）
└── raw/                    # 原始素材与 provenance（⚠ 不入库）
    └── DAnew_version/      #   PSD 分层原稿 + states/ 导出差分 + export_differences.py
```

## 2.2 约定

- **变体 id = 文件名去扩展名**，全小写 snake_case（`gentle_smile.png` → 变体 `gentle_smile`）。背景/BGM/音效的 id 就是 YAML 键名，建议同样风格。
- **立绘变体必须透明底 PNG**。浏览器把立绘叠在背景上渲染，非透明底会出现色块。
- **同一立绘组的所有变体共享画布尺寸与坐标系**（见 `assets/raw/DAnew_version/README.md`），切换变体时不会跳位。
- `raw/` 保存原始压缩包、PSD、导出脚本，作为 provenance 供复现；正式目录只放"注册过的成品"。不要在 `raw/` 里注册条目到 `resources.yaml`。
- **git 红线**：`assets/characters/raspberry/` 与 `assets/raw/` 已被 `.gitignore` 排除，严禁 `git add -f`。新机器通过内部联系人直接复制文件获取（见 §10）。
- 制作过程产物（生成图、差分、QC 拼图）一律落在 `output/`（已 gitignore），不要混入 `assets/`。

---

# 3. 资产制作管线（生产侧）

## 3.1 image-gen 工具（`src/tools/image-gen/`）

独立于游戏运行时的 CLI 工具，core + cli 双层（详见 `src/tools/image-gen/README.md`）。要点：

- **零运行时依赖侵入**：不经 OpenAI SDK 直连 HTTP（保住 `input_fidelity`/`xhigh` 等新参数透传），仅 zod/pngjs/onnxruntime-node；要求 Node ≥ 20。
- **环境变量**（`.env`）：必填 `IMAGE_GEN_BASE_URL`（填到 `/v1`）、`IMAGE_GEN_API_KEY`；可选 `IMAGE_GEN_MODEL/SIZE/QUALITY/TIMEOUT_MS/MAX_RETRIES/OUTPUT_DIR/CUTOUT_ENGINE/CUTOUT_DEVICE/CUTOUT_MODEL_PATH`。
- **默认输出**：`output/image-gen/`，文件名 `{时间戳}-{model}-{size}-NN.png`；`--out` 可覆盖。
- **退出码**：0 成功 / 2 参数错误（不发请求）/ 1 API 错误。

常用命令：

```bash
# 竖版立绘（生成 + 自动抠图 + 保留白底原图备查）
pnpm image generate "<提示词>" --size 1024x1536 --quality high --cutout --keep-raw

# 基于垫图改图（edit：换表情/换光照/风格化照片）
pnpm image edit --image base.png "<修改指令>"

# 参数全集与排障
pnpm image help
```

## 3.2 抠图决策链（`cutout.ts` / `matting.ts`）

`--cutout` 时对每张产物执行 `processForCutout`：

1. 非 PNG → 跳过（opaque-skip）；
2. 已有 ≥1% 真透明像素 → 视为已完成，保留（kept-alpha）；
3. `CUTOUT_ENGINE=ai`（默认）→ ISNet AI 抠图（1024×1024 推理后回缩），失败或结果异常自动回退几何抠图；
4. 几何兜底：边界连通泛洪移除近白背景（容差 40），可选清除被深色描边包围的封闭白缝。

AI 引擎设备 `CUTOUT_DEVICE=cpu|dml`；DML（DirectML）约 7× 提速但会话初始化约 14s，适合批量；失败自动回退 CPU。

## 3.3 立绘差分：蓝幕色键管线（树莓娘实践）

单图 edit 逐张生成表情容易破坏人物一致性，项目实践是"蓝幕差分"管线：

- **已入库的通用入口**：`scripts/gen-cast-bases.mjs`——批量生成新角色基准图与表情差分（以树莓娘 `calm.png` 为画风/比例参考），产出 `output/image-gen/cast/<castId>/` + manifest + QC 拼图；
- 树莓娘本体的历史脚本在 `output/raspberry_diff*.mts`（未入库，产物含官方原稿像素）。

1. **基准合成**：PSD 分层原稿经 `assets/raw/DAnew_version/export_differences.py` 导出 12 张姿态×表情组合图（`states/normal.png` 为基准）；基准图先合成到纯蓝底（`RGB(0,0,255)`）。
2. **API edit 整图重绘**：只改表情/动作区域，蓝底保证人物主体不被模型重画。
3. **色键去蓝**：全局 `chromaKey` 去蓝 + despill 压蓝边，白裙/白袜零风险（这是从"AI 抠图白底"切换到"蓝幕"的原因）。
4. **产物分层组织**（如 `output/image-gen/raspberry-diff-layers/{face,pose,overlay}/`），QC 拼图脚本配套（`output/_contact_layers.mts`、`gen-cast-bases` 自带 contact sheet）。
5. **人工 QC 后手动复制**进 `assets/characters/raspberry/`（当前 20 张：`base` + 18 表情差分 + `mysterious_silhouette` 剪影）。

> ⚠ 脚本放在 `output/`（gitignore）是因为产物含官方原稿像素；脚本本身无授权问题，如需固化可移入 `scripts/`。树莓娘任何产物**不得上传任何渠道**（§10）。

## 3.4 背景制作（wencui_corridor 实践）

真机照片 → `edit` 风格化 → 同一机位生成时间差分（evening / night_on / night_off）→ 本地缩放到 1920×1080 转 JPG → 复制进 `assets/backgrounds/`。脚本参考 `output/wencui_corridor.mts`。

**背景成组注册**：同一场景的多时间变体用统一后缀（`_day/_evening/_night_on/_night_off`），描述里写清"同一场景 + 光照差异 + 适用情绪"，模型才会正确地在剧情推进中切换昼夜而不是跳场景。

---

# 4. 资产注册：编写 resources.yaml

`assets/resources.yaml` 是唯一注册入口。**文件放进 `assets/` 但没在这里登记 = 运行时不存在**（模型看不到、编译器当未知 id 丢弃、manifest 不含它）。

## 4.1 字段参考

顶层五段 + `guidance`，YAML 键为 snake_case，加载时映射为代码内 camelCase（`src/application/assets/asset-catalog-loader.ts`）。

### guidance（全局使用纪律，必填）

多行字符串，**逐字注入**每次生成请求的 user prompt 首段（§7.1）。写模型需要遵守的选型纪律：素材覆盖范围、背景复用原则、站位互斥规则、差分切换方式等。当前的范式见文件头部——它同时承担"目录使用说明书"的职责。

### backgrounds / bgm / sound_effects（必填，可为空映射）

每个条目两个字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `src` | ✔ | 相对 `resources.yaml` 所在目录的路径（即相对 `assets/`），**不得逃逸根目录** |
| `description` | ✔ | 给模型看的检索描述：画面/听感内容 + 适用场景/情绪 |

### bgm_playback 与每曲 playback（可选，BGM 裁切与淡入淡出）

纯播放表现参数，单位秒；**模型目录不投影**（模型只看 description），随 `PublicAssetManifest` 下发浏览器（§6）。顶层 `bgm_playback` 是全局默认，每曲 `bgm.<id>.playback` 覆盖同名字段；两边都缺省 = 整曲循环、无淡入淡出（与裸 `<audio loop>` 一致）。

| 字段 | 适用层 | 说明 |
| --- | --- | --- |
| `start` / `end` | 默认 + 每曲 | 裁切循环窗口（含两端）：到达 `end` 回卷 `start`；只配 `start` 时播到文件尾回卷。`end` 缺省即整曲 |
| `fade_in` | 默认 + 每曲 | 起曲淡入时长 |
| `fade_out` | 默认 + 每曲 | 切歌/停止前的淡出时长（顺序式：旧曲淡出完再起新曲） |

校验（fail-fast，§5.3）：单条 `end` 必须大于 `start`、playback 至少一个字段；窗口与全局默认**合并后**仍需 `start < end`。运行期兜底：`end` 超出文件时长自动钳到 duration；窗口被钳得小于 0.05s（如 `start` 越过文件尾）视为坏配置，退回整曲循环。切歌/停止的淡出按**当前装载曲目**的 `fade_out` 执行。改配置需重启（manifest 启动时一次性构建）。

### sprite_sets（必填）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `description` |   | 立绘组整体说明（画的是谁、风格） |
| `variants.<变体id>.src` | ✔ | 透明底 PNG 路径 |
| `variants.<变体id>.description` |   | 该表情/姿态的适用情绪——**表情选型全靠它**，建议必写 |

### characters（必填）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `script_name` | ✔ | 剧本脚本名，模型在台词行头使用（如 `树莓娘`） |
| `display_name` | ✔ | 玩家所见显示名（身份揭示前后的伪装名也在此层） |
| `sprite_set` | ✔ | 默认立绘组，必须存在于 `sprite_sets` |
| `default_variant` | ✔ | 登台默认变体，必须存在于该立绘组 |
| `default_position` | ✔ | 五选一：`far_left / left / center / right / far_right` |
| `allowed_sprite_sets` |   | 允许使用的立绘组列表（换装等跨组需求），**必须包含自身 `sprite_set`**；缺省为 `[sprite_set]` |

## 4.2 描述写法要点

`description` 是模型的"素材检索文本"，直接决定选型质量：

- 写**可观察特征 + 适用时机**（"窗光暖黄的傍晚收尾场景"），不写文件规格（"1920×1080 JPG"）。
- 音频写调性、节奏、乐器、情绪（参考现有 bgm 条目的写法）。
- 表情变体写触发情绪（"明显紧张/不安/隐瞒时使用"），与 `guidance` 中的切换纪律呼应。
- 同场景多时间变体要在描述里互相锚定（"同一社团活动室，……变为……"）。

## 4.3 完整示例（节选自当前文件）

```yaml
guidance: |
  当前素材覆盖文萃楼走廊、校园林荫道、社团广场、阶梯教室、操场与北食堂场景……
  按台词情绪用 `ch raspberry:<变体>` 切换表情，悬念/身份未揭示场面可用剪影。

backgrounds:
  club_plaza_day:
    src: backgrounds/club_plaza_day.jpg
    description: |
      学生社团文化广场：橙色外墙的社团用房、白色天桥与伞状顶棚，
      前面是开阔的石板广场。白天晴朗。
      网协办公室所在地。部分同学会到这里来修电脑……

bgm:
  relax:
    src: audio/bgm/relax.mp3
    description: |
      大调；氛围温暖静谧，适合室内；慢节奏，悠然……

sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: 电子设备发出的短促提示音（合成占位），可用于设备反应或提示。

sprite_sets:
  raspberry:
    description: |
      树莓娘差分立绘（基于负责人提供的官方分层原稿加工，仅限内部流通）。
      base 为基准形态，其余为表情/情绪差分与剪影，全身图、透明背景。
    variants:
      base:
        src: characters/raspberry/base.png
        description: 基准立绘，表情平和开朗（默认变体）。
      gentle_smile:
        src: characters/raspberry/gentle_smile.png
        description: 温柔的微笑。
      mysterious_silhouette:
        src: characters/raspberry/mysterious_silhouette.png
        description: 全黑剪影，用于角色未登场揭示或悬念场面。

characters:
  raspberry:
    script_name: 树莓娘
    display_name: 树莓娘
    sprite_set: raspberry
    default_variant: base
    default_position: left
```

---

# 5. 启动加载与校验

## 5.1 调用链

`pnpm dev` / `pnpm start` → `src/entrypoints/web.ts`（或 `cli.ts`）→ `src/bootstrap/create-runtime-application.ts`：

```ts
const assetCatalog = await loadAssetCatalog(config.assets.catalog); // 默认 assets/resources.yaml
```

随后 catalog 一分为三：注入 `StoryGenerator`（供 prompt 投影）、注入 `Game`（供角色注册表与 cue 过滤）、挂到 `app.assetCatalog`（供 web host 生成 manifest）。

## 5.2 加载步骤（`loadAssetCatalog`）

1. 读文件（读不到 → 抛错，指明路径）；
2. `yaml` 包解析（语法错误 → 抛错）；
3. zod schema 校验（字段缺失/类型不符 → 抛错，列出 `路径: 原因` 明细）；
4. snake_case → camelCase 映射，`description`/`guidance` 两端去空白；
5. 交叉引用与文件校验（见下）。

**任何一步失败都直接中断启动**——这是刻意设计：目录坏了宁可当场修，也不要带着悬空引用跑剧情。

## 5.3 启动期校验清单（全部 fail-fast）

| 检查 | 错误信息关键词 |
| --- | --- |
| 顶层必须是对象、五段齐全、字段类型正确 | `资产目录校验失败: <路径>: <原因>` |
| `characters.<id>.sprite_set` 必须存在于 `sprite_sets` | `不存在于 sprite_sets` |
| `default_variant` 必须存在于所属立绘组 | `不存在于 sprite_set` |
| `allowed_sprite_sets` 必须包含自身 `sprite_set` 且全部存在 | `必须包含自身` / `引用不存在` |
| bgm playback：至少一个字段、`end` > `start`（含与 `bgm_playback` 默认合并后） | `至少要有一个字段` / `end 必须大于 start` / `窗口无效` |
| 所有 `src` 解析后**不得逃逸** `assets/` 根目录 | `逃逸素材根目录` |
| 所有 `src` 文件必须真实存在 | `文件不存在` |

排错入口：直接跑 `pnpm exec tsx -e "import('./src/application/assets/asset-catalog-loader.ts').then(m=>m.loadAssetCatalog('assets/resources.yaml').then(()=>console.log('OK')))"`，或看启动报错（错误信息自带 YAML 路径与条目位置）。回归用例见 `src/application/assets/asset-catalog-loader.test.ts`。

---

# 6. 运行时三投影与消费方

加载完成后，内存中的 `AssetCatalog`（`src/core/assets/types.ts`）按消费方派生四个视图（投影函数在 `src/core/assets/catalog.ts`）：

| 投影 | 函数 | 内容 | 消费方 |
| --- | --- | --- | --- |
| `ModelAssetCatalog` | `toModelCatalog` | ID + description + guidance + 角色绑定，**无 `src`** | LLM 生成器（`src/adapters/llm/openai-compatible-generator.ts` 构造时投影一次，五种请求类型共用） |
| `CharacterRegistry` | `toCharacterRegistry` | id ↔ 脚本名双向索引 + 默认形态/站位 | `Game`（台词行归属、character patch 归约）；无 catalog 时退化为空注册表 |
| `AssetResolver` | `createAssetResolver` | ID → `{ src }` 文件路径 | cue 编译过滤（交叉校验）、本地诊断 |
| `PublicAssetManifest` | `buildPublicAssetManifest`（`src/application/assets/asset-manifest.ts`） | ID → `/game-assets/<rel>` 受控 URL（反斜杠归一） | `LocalWebHost`（`GET /api/assets/manifest`）→ 浏览器 |

要点：

- 模型端与浏览器端**互相看不到对方的信息**：prompt 里没有 URL，manifest 里没有 description。
- manifest 是**启动时一次性构建**的；运行中改 `resources.yaml` 不会热加载，需重启。
- `Game` 内部不持有完整 catalog 语义——它只用注册表 + resolver 做 DSL 编译期过滤（§7.3）。

---

# 7. 模型调用：素材表 → DSL → 舞台

## 7.1 注入位置与格式

生成请求（opening / continuation / branch_prefetch / input_response / input_bridge）的 user prompt 由 `src/story/context-builder.ts` 的 `buildDslUserPrompt` 拼装，段落顺序：

```
===== 可用素材 =====      ← serializeModelAssetCatalog(catalog)，会话级静态，永远第一段
===== 剧情历史 =====       ← 追加式增长
===== 当前故事状态 =====
===== 当前舞台状态 =====
===== 本段任务 =====       ← 任务类型/nonce/目标行数/回合/交互进度，逐请求变化，永远最后
```

**排序是提示词缓存优化**：DeepSeek 前缀缓存按命中前缀计费，静态素材段打头 + 易变任务头收尾，使会话内大部分前缀可复用。因此素材段的文本必须**逐字节稳定**——不要在 description 里放日期、计数器等易变内容。

素材段序列化格式（`serializeModelAssetCatalog`）：

```
<guidance 原文>
背景：club_plaza_day — 学生社团文化广场……
BGM：relax — 大调；氛围温暖静谧……
音效：terminal_beep — 电子设备发出的短促提示音……
立绘组 raspberry：树莓娘正式差分立绘……
  base — 默认形态
  gentle_smile — 温和微笑，日常交谈默认表情
角色：
- raspberry（脚本名：树莓娘，默认显示名：树莓娘，立绘组：raspberry，默认立绘：base，默认位置：left，可用立绘组：raspberry）
```

System prompt 侧由 `prompts/dsl-protocol.txt` 定义协议本体（指令语法 + 素材选择原则），与 user prompt 的素材表配合：协议说"用素材表中的逻辑 ID"，素材表由 `resources.yaml` 实时投影。

## 7.2 模型如何引用资产（DSL 指令速查）

| 指令 | 语义 | 持续性 |
| --- | --- | --- |
| `bg <背景id>` | 切背景 | 持续到下一次 `bg`；**不重复输出当前背景** |
| `bgm <音乐id>` / `bgm stop` | 切 BGM / 停止 | 持续；`stop` 是控制指令不是资产 id |
| `se <音效id>` | 播一次性音效 | 一次性 |
| `角色名[立绘|位置](显示名): 台词` | 台词行内同时切表情/站位/显示名 | 当行生效，立绘状态保持 |
| `ch <角色id>:<变体> [位置]` | 无台词时操作立绘（旁白中切表情/走位） | 持续 |
| `ch <角色id> hide / show / exit` | 隐藏（保留站位）/ 显示 / 离场（清除状态） | — |
| `beat` | 纯演出节点（配合 bg/bgm/ch，无正文） | — |

素材选择原则（dsl-protocol.txt）：已有状态不变化则不重复输出；没有理想素材时**保持现状或用最接近的**；**绝不猜测不存在的资源 ID**。

## 7.3 输出侧校验与降级（两层）

**第一层·语法**：流式行解析（`src/core/protocol/gal-dsl/line-parser.ts`）识别指令行；非法 DSL 行触发修复重试（repair_attempts），与资产无关。

**第二层·语义（资产 id 存在性）**：`Game.compileGroup` 调用编译器 `filterInvalidCues`（`src/core/protocol/gal-dsl/compiler.ts`），逐条对照 catalog。**未知/越权引用 = 丢弃该条 cue，舞台保持现状，剧情继续**，同时记诊断码并 `console.warn`：

| 诊断码 | 触发 | 行为 |
| --- | --- | --- |
| `UNKNOWN_BACKGROUND` | `bg` 的 id 不在 `backgrounds` | 丢弃，背景不变 |
| `UNKNOWN_BGM` | `bgm` 的 id 不在 `bgm`（`stop` 豁免） | 丢弃，曲目不变 |
| `UNKNOWN_SOUND_EFFECT` | `se` 的 id 不在 `sound_effects` | 丢弃 |
| `UNKNOWN_SPRITE_VARIANT` | 变体不存在于立绘组 | 丢弃，立绘不变 |
| `FORBIDDEN_SPRITE_SET` | 使用了 `allowed_sprite_sets` 之外的立绘组（跨角色偷穿衣服，docs §15） | 丢弃 |
| `FORBIDDEN_DISPLAY_NAME` | 覆盖显示名非中文 | 丢弃覆盖，回退默认名 |

> 浏览器端还有第三层兜底：即便 cue 合法但图片加载失败（onerror），渲染器也回退到带 id 标签的色块占位（§8.1）。运行时降级的回归用例：`src/core/protocol/gal-dsl/compiler.test.ts`（"graceful degradation" 系列）。

**给注册流程的含义**：忘记注册某个变体的后果不是报错，而是模型引用它时**静默丢弃 + 警告日志**——所以新增素材后要按 §9.6 冒烟验证一轮，别只看启动不报错。

---

# 8. 浏览器渲染与音频播放

## 8.1 图片渲染链路

1. 页面启动 `fetch("/api/assets/manifest")`（`web/src/stage/asset-manifest-client.ts`），失败返回 null，全部走占位降级；
2. 渲染循环把 `VisualState` 交给 `StageRenderer`：`BrowserAssetResolver` 用 manifest 查 `id → url`，背景/立绘用持久 `<img>` 复用；
3. 未知 id 或图片 onerror → 回退**确定性色块占位**（同 id 同色，标注 id 文本）。

`/game-assets/` 路由（`src/hosts/local-web/local-web-host.ts` 的 `serveAssetFile`）：

- 仅 GET/HEAD（其余 405）；decodeURIComponent 失败 400；
- 路径解析逃逸 `assets/` 根 → 403（原始 `../` 与 `%2e%2e` 编码回溯都挡）；
- 文件缺失 404；**无 SPA fallback**——资产 id 必须映射真实文件，否则宁可 404；
- MIME 表覆盖 webp/jpg/jpeg/ogg/mp3/wav，未知扩展 `application/octet-stream`；`Cache-Control: no-store`。

## 8.2 舞台 cue 的流动

模型 DSL → 编译产出段首 `stage` cues → 玩家实际看到该行时 reducer 归约出 `VisualState`（`bgm` 是状态性的、`se` 是一次性的）→ `playback_ready` 事件携带 presentation 投影 → WebSocket → 浏览器视图模型暂存瞬态 cues → 渲染循环消费。BGM 控制器对未知 id **保持当前曲目**；音效控制器 url 缺失直接跳过。

BGM 控制器（`web/src/stage/bgm-controller.ts`）按 manifest 里的 `playback` 执行裁切与淡入淡出（配置见 §4.1「bgm_playback 与每曲 playback」）：裁切窗口内由帧回调 + `timeupdate` 双路回卷（后者覆盖后台标签页）；淡出在先、起曲淡入在后，无配置时与裸 `<audio loop>` 行为一致。

## 8.3 语音（TTS）链路与资产目录的关系

TTS 是与素材目录并行的独立链路：`config.yaml` 的 `characters.<id>.voice_profile` → `voices.yaml` 的逻辑音色 profile（semantic 描述 + provider 绑定：本地为 `providers.local.voice`，云端为 `providers.dashscope.voice_id_env`）→ `AudioIntentPlanner` 逐行台词产出合成意图 → 浏览器经 `/api/audio/synthesize` 拉流。当前校园分支 `synthesis.provider: local`（tts-server 本机推理，树莓娘+四配角五角色已绑定本地音色，无需 API key）；tts-server 未启动时逐句降级为纯文本，不阻塞启动。启用步骤见 §9.5；音色创建细节见 `tts-server/README.md`（本地路径）与 `docs/agents/TTS-音色配置指南.md`（云端路径）。

注意：**立绘资产与音色配置互不感知**。给树莓娘加新表情变体不需要动 voices.yaml；给树莓娘配音不需要动 resources.yaml——两者只在 `characters` 这一层（一个用 `sprite_set`，一个用 `voice_profile`）交汇于 `config.yaml`/`resources.yaml` 的角色绑定。

---

# 9. 变更操作手册（SOP）

## 9.1 新增一张立绘差分（最常见）

1. **制作**：§3 管线产出透明底 PNG——已有角色补差分用蓝幕管线（`output/` 历史脚本或参考其写法），全新角色可直接 `pnpm exec tsx scripts/gen-cast-bases.mjs`（基准图 + 差分 + QC 拼图一条龙），或 `pnpm image generate ... --cutout` 单张生成；
2. **入库**：复制进 `assets/characters/<组>/`，文件名即变体 id（snake_case）；树莓娘及含官方原稿像素的资产仅内部复制，不入 git；
3. **注册**：`assets/resources.yaml` → `sprite_sets.<组>.variants` 增加 `<变体id>: { src: ..., description: <适用情绪> }`；如属默认形态另改 `characters.<id>.default_variant`；
4. **校验**：§9.6。

## 9.2 新增背景（含时间差分组）

1. 制作（§3.4），统一缩放到目标分辨率（当前 1920×1080 JPG；2026-09-18 起 playground/north_canteen 六张经 realcugan 2x（models-pro、降噪 0）替换为 3840×2160，其余 14 张维持 1920×1080，渲染端 <img> 自适应无需区分）；
2. 复制进 `assets/backgrounds/`，命名 `<场景>_<时间>.jpg`；
3. `backgrounds:` 段登记，description 写"同一场景 + 光照差异 + 适用时机"，与同组既有变体互相锚定；
4. §9.6。

## 9.3 新增 BGM / 音效

同背景，分别登记 `bgm:` / `sound_effects:` 段（BGM 建议时长 ≥ 1 分钟可循环；音效短促一次性）。同时在 `assets/ATTRIBUTION.md` 补来源与授权记录。

## 9.4 新增角色

1. 准备立绘组（`assets/characters/<新组>/`）并在 `sprite_sets` 注册；
2. `characters:` 段新增绑定：`script_name` / `display_name` / `sprite_set` / `default_variant` / `default_position`（跨组换装才需要 `allowed_sprite_sets`）；
3. 人设文本进 `prompts/characters.txt`（人设与资产分离：文件末行明确"资源名统一由可用素材段提供，此处只写人设"）；
4. 如需配音：`config.yaml` `characters` 映射 + `voices.yaml` profile（§9.5）；
5. §9.6。注意 dsl-protocol 硬性规则"不得引入未声明角色"——声明就发生在 `characters:` 段。

## 9.5 启用语音

本地推理（校园分支当前路径，无需 API key）：

1. `voices.yaml` 新增/确认 profile（`semantic` + `providers.local { model: local-qwen3-tts, voice: <registry 键>, voice_revision: N }`）；
2. tts-server 侧确保该音色已注册（`tts-server/voices/registry.json`；音色构建/重建见 `tts-server/README.md`）；
3. `config.yaml`：`characters: { <角色id>: { voice_profile: <profile> } }`；`synthesis.provider: local` 且 `sample_rate: 24000`；
4. 验证：启动 `tts-server\start-qwentts.cmd` 后跑一段剧情试听（服务单独冒烟用 `tts-server/tools/client.py`）；音色重建后 bump `voice_revision` 使缓存失效。

云端 DashScope（备用路径）：

1. `voices.yaml` 新增/确认 profile（`semantic` + `providers.dashscope { model, voice_id_env }`）；
2. `.env` 按 `voice_id_env` 填音色 id（来源三选一：系统音色/控制台复刻/控制台设计，见 `.env.example` 注释）；
3. `config.yaml`：`characters: { <角色id>: { voice_profile: <profile> } }`；`synthesis.provider: dashscope`；
4. 验证：`node scripts/probe-tts-params.mjs <profile> "<台词>"` 合成一行试听。

## 9.6 验证清单（任何资产变更后）

```bash
pnpm typecheck                      # 类型
pnpm exec vitest run src/application/assets  # 目录加载/校验回归
pnpm dev                            # 启动冒烟：加载失败会当场抛错
```

启动后人工核对两点：

- `GET /api/assets/manifest`（浏览器或 curl）里能看到新 id 与 URL；
- 实际跑一段剧情，让模型用到新素材；若怀疑没注册上，看服务端 `console.warn` 的诊断码（§7.3）——**静默丢弃是忘注册的典型症状**。

## 9.7 下线/替换资产

删掉或改名 `resources.yaml` 条目（文件可留可删）。**没有引用计数**：模型不会再用旧 id（素材表已不含它），历史存档回放时旧 id 走占位/保持现状降级。替换文件内容而 id 不变则无需改 YAML，但浏览器 `no-store`，刷新即生效。

## 9.8 立绘 presentation（裁切 / 旋转 / 统一规格）

立绘源图的取景规格常常不一（透明留白、倾斜、裁切松紧不同），直接上台会导致同套差分跳动、不同角色视觉身高失衡。`sprite_sets.<组>.presentation` 把这类修正做成配置，由 host 在启动时派生处理，**原始文件永不改动**：

```yaml
sprite_sets:
  <组>:
    presentation:
      rotate: -6        # 可选。顺时针度数（±180），扶正倾斜立绘；90° 倍数无损重排
      crop:             # 可选。旋转后按源图像素硬裁切
        left: 0
        top: 120
        width: 1152
        height: 1600
      normalize: true   # 可选。裁掉透明边 + 同套所有变体归一到统一画布
      ground: true      # 可选。各变体按自身内容底边对齐到同一地面线（见下）
      height: 0.92      # 可选。舞台显示高度占比（0–1.2），仅前端展示元数据
    variants:
      base: { src: ... }
      special:          # 变体级可覆写 rotate/crop/normalize（height/ground 只能在 set 级）
        src: ...
        presentation: { rotate: 0 }
```

处理规则：

- **顺序固定**：rotate → crop → 裁透明边 → 同套统一画布。最后一部把全套变体贴到同一个 union 画布，保证「同一套立绘裁切后规格一致」且表情差分逐像素对齐；
- **ground（地面线对齐）**：union 画布的底边由内容最低的变体决定——若源图各差分的脚底落点不一（典型：官方 PSD 导出的部分姿势整体画得偏低），其余差分在舞台上会整体悬空、观感"脚底下空了一块"。`ground: true` 把每个变体的内容底边垂直平移到画布底边（水平位置保持不动），保证任意变体切换时脚都踩在同一地面。适用：全员站姿类立绘组；不适用：含悬空/飞行姿态的组；
- 任一 `rotate`/`crop`/`normalize`/`ground` 出现即触发整套派生（含未配置的变体，保证画布统一）；只配 `height` 不动文件，仅把占比投影进 manifest；
- 派生产物写 `output/derived-game-assets/<组>/<变体>.png`（gitignore 内），manifest URL 重写为 `/game-assets/__derived__/<组>/<变体>.png`，原始路径照常服务；
- 磁盘缓存：`.meta.json` 记录参数指纹 + 源 mtime，任一变化自动重derive（冷启动全套约 10s，命中后毫秒级）；
- 失败即启动失败（fail-fast，与 §9 校验同纪律）；**树莓娘派生产物继承「仅限内部流通」约束**（§10），不入库不上传。

前端呈现（`web/src/stage/`）：立绘按 gal 惯例**全身贴底**（脚底压舞台下缘，小腿由对话框遮挡），按 manifest 里的 `presentation.height` 缩放（缺省 0.92）；整个舞台（背景/立绘/对白 UI）锚定在 16:9 舞台框内，非 16:9 窗口 letterbox，构图恒定。

---

# 10. 授权与合规红线

完整记录在 `assets/ATTRIBUTION.md`，此处为操作红线摘要：

| 素材 | 约束 |
| --- | --- |
| **树莓娘全部资产**（PSD 原稿、导出差分、蓝幕管线产物、任何衍生图） | **仅限内部流通**：不上传任何渠道（git 提交/推送、公开网盘、外部在线服务——包括把图发给图像 API 本身也要谨慎评估）；`.gitignore` 已排除 `assets/characters/raspberry/` 与 `assets/raw/`，**严禁 `git add -f`**；新机器从内部联系人处直接复制 |
| BITNP 官方其余素材 | 未获授权前**不接入、不复制、不再分发**（审计结论见 `docs/superpowers/notes/campus-ops-source-audit.md`） |
| わたおきば 立绘/背景（suyao/linche、部分 bgm） | 免费素材允许使用，**禁止再分发素材本身**、禁虚假作者声明；原始压缩包留 `assets/raw/` 作 provenance |
| BGM（源站 ID 572285/404429/440706） | 按各源站条款 |
| `terminal_beep.ogg` | 本仓库 ffmpeg 合成，无第三方版权 |

新增任何外部来源素材：先在 `ATTRIBUTION.md` 登记，确认条款允许本项目用途与分发方式，再走 §9 注册。

---

# 11. 附录

## 11.1 代码索引

| 职责 | 文件 |
| --- | --- |
| YAML schema/加载/启动校验 | `src/application/assets/asset-catalog-loader.ts` |
| 类型（三投影接口定义） | `src/core/assets/types.ts` |
| 投影函数（toModelCatalog / toCharacterRegistry / createAssetResolver） | `src/core/assets/catalog.ts` |
| 浏览器 manifest 构建 | `src/application/assets/asset-manifest.ts` |
| 组合根（加载与注入） | `src/bootstrap/create-runtime-application.ts` |
| prompt 注入与缓存友好排序 | `src/story/context-builder.ts`（`serializeModelAssetCatalog` / `buildDslUserPrompt`） |
| DSL 协议（含素材指令与选择原则） | `prompts/dsl-protocol.txt` |
| 语义校验与诊断码 | `src/core/protocol/gal-dsl/compiler.ts`（`filterInvalidCues`） |
| Game 侧角色注册表/过滤接线 | `src/game.ts` |
| web 路由（manifest + /game-assets/ + 派生服务） | `src/hosts/local-web/local-web-host.ts` |
| 立绘 presentation 派生（§9.8） | `src/application/assets/sprite-normalize.ts` |
| 浏览器渲染/音频消费 | `web/src/stage/`（asset-manifest-client / browser-asset-resolver / stage-renderer / bgm-controller / sound-effect-controller） |
| 图像生成工具 | `src/tools/image-gen/`（README 为权威用法） |
| 新角色基准图/差分批量生成 | `scripts/gen-cast-bases.mjs` |
| TTS 链路 | `src/application/audio/`、`voices.yaml`、`docs/agents/TTS-音色配置指南.md` |

## 11.2 回归测试索引

| 覆盖 | 文件 |
| --- | --- |
| 加载/校验 fail-fast（schema、交叉引用、逃逸、缺文件） | `src/application/assets/asset-catalog-loader.test.ts` |
| 投影正确性 | `src/core/assets/catalog.test.ts`、`src/application/assets/asset-manifest.test.ts` |
| 运行时降级（未知 id 丢 cue 保状态） | `src/core/protocol/gal-dsl/compiler.test.ts` |
| cue 端到端传递 | `src/game-dsl.test.ts`、`src/game.test.ts` |
| host 路由安全（403/404/405、manifest 投影） | `src/hosts/local-web/local-web-host.test.ts` |
| 派生管线（旋转/裁切/union 统一画布/缓存） | `src/application/assets/sprite-normalize.test.ts` |
| 浏览器占位降级 | `web/src/stage/*.test.ts` |
| image-gen 工具 | `src/tools/image-gen/*.test.ts`（`pnpm exec vitest run src/tools/image-gen`） |

## 11.3 上游规范章节对照

| 主题 | 章节 |
| --- | --- |
| 资源 YAML 职责划分 | `docs/llm-outputs-refactor.md` §57 |
| 推荐资源结构 | 同上 §58 |
| Runtime/Model Catalog 分离 | 同上 §59 |
| AssetResolver 接口 | 同上 §60 |
| 默认 sprite set 绑定 | 同上 §7 |
| 显示名与 characterId | 同上 §10 |
| 跨角色立绘组禁令 | 同上 §15 |
| DSL user prompt 分段 | 同上 §70 |
| manifest 与 /game-assets/ 路由 | `docs/superpowers/specs/2026-08-08-asset-pipeline-browser-design.md` §5.2–§5.3 |
| 校园分支素材策略 | `docs/superpowers/specs/2026-09-06-campus-ops-event-design.md` §7 |
