# 资源管线接通浏览器（Asset Pipeline → Browser）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已完成的 `AssetCatalog + VisualState` 真正接到浏览器：真实素材落地（LFS 管理）、逻辑 ID → 受控 URL（manifest + 静态路由）、真实背景/立绘/BGM/SE 渲染与播放、媒体错误降级。

**Architecture:** Core 只见逻辑 ID；`LocalWebHost` 提供 `GET /api/assets/manifest`（`PublicAssetManifest`，id → `/game-assets/...` URL）与 `GET /game-assets/*`（带穿越防护的静态服务）；浏览器 `BrowserAssetResolver` 做 id→URL 纯映射，keyed `StageRenderer`（持久节点，只换 src/class）、`BgmController`（薄 `<audio>` 封装）、`SoundEffectController`（消费瞬态 cues）各司其职。

**Tech Stack:** TypeScript（Node + Vite/web）、vitest + happy-dom、git-lfs 3.7.1、ffmpeg（素材转换/合成）、mimo-v2.5（视觉命名子代理）、zod、yaml。

## Global Constraints

- 测试命令：`npx vitest run <file>`（单文件）/ `npm test`（全量）；类型检查 `npm run typecheck`。
- Web 测试用 happy-dom；Node 测试用 node 环境。文件内测试按现有命名约定 `*.test.ts` 与被测文件同目录。
- **git LFS**：`.gitattributes` 必须先于任何二进制素材提交（否则素材以普通 blob 入库）。LFS 模式：`*.png *.jpg *.jpeg *.webp *.ogg *.mp3 *.zip filter=lfs diff=lfs merge=lfs -text`。已有 git-lfs 3.7.1。
- **BGM guidance 由用户撰写**：执行者不得臆造 BGM 的情绪/节奏描述。`resources.yaml` 的 bgm `description` 只写来源事实（文件名/时长/编码），并在 YAML 中加 `# USER: 请撰写该 BGM 的详细 guidance（节奏/情绪/适用场景）` 注释待用户填充。
- Core 与模型输出永不出现绝对路径 / `http://` / `blob:` / `file://`；浏览器只从 manifest 拿受控 URL。
- 角色↔立绘映射由执行者依据视觉报告直接定夺（用户已授权，无需确认），并在提交信息与 `resources.yaml` 注释中说明理由。
- 参考文档：`docs/superpowers/specs/2026-08-08-asset-pipeline-browser-design.md`（本计划源头）；`docs/llm-outputs-refactor.md` §52–§70、§86–§87、§107。
- 每次任务结束时 `npm test`（或该任务相关测试文件）全绿再 commit。

---

## 目录结构总览（本计划产生的文件）

```
.gitattributes                                (T1)
.gitignore                                    (T1 改)
config.yaml                                   (T1 改: essets→assets)
src/config.ts                                 (T1 改: output_dir 默认值)
assets/
  ATTRIBUTION.md                              (T1 建)
  backgrounds/*.jpg|webp                      (T1: 10 张英文名)
  characters/josei_03/*.png  → (T3 git mv) characters/<id>/
  characters/josei_12/*.png  → (T3 git mv) characters/<id>/
  audio/bgm/*.mp3                             (T1: 3 首英文名)
  audio/se/terminal_beep.ogg                  (T1: ffmpeg 合成)
  resources.yaml                              (T3 重写)
src/core/assets/types.ts                      (T5 加 PublicAssetManifest)
src/application/assets/asset-manifest.ts      (T5 新建)
src/application/runtime-application.ts        (T5 加 assetCatalog)
src/bootstrap/create-runtime-application.ts   (T5 加 assetCatalog)
src/hosts/local-web/local-web-host.ts         (T5 加路由 + MIME)
src/core/protocol/gal-dsl/types.ts            (T10 加诊断类型)
src/core/protocol/gal-dsl/compiler.ts         (T10 语义校验)
src/runtime/metrics.ts                        (T10 加诊断计数)
src/game.ts                                   (T10 compileGroup 接线)
web/src/stage/stage-types.ts                  (T6/T9 加 wire 类型)
web/src/stage/asset-manifest-client.ts        (T6 新建)
web/src/stage/browser-asset-resolver.ts       (T6 新建)
web/src/stage/stage-renderer.ts               (T7 重写)
web/src/stage/bgm-controller.ts               (T8 新建)
web/src/stage/sound-effect-controller.ts      (T9 新建)
web/src/runtime/game-view-model.ts            (T9 改: consumeCues)
web/src/app.ts                                (T8 加 bgmController seam)
web/src/main.ts                               (T11 接线)
web/src/ui/styles.css                         (T7 改)
docs/superpowers/notes/asset-vision-report-2026-08-08.md  (T2 产出)
测试: 每任务对应 *.test.ts
```

---

### Task 1: git/LFS 基建 + config 修复 + 素材解压落地

**Files:**
- Create: `.gitattributes`, `assets/ATTRIBUTION.md`
- Modify: `.gitignore`, `config.yaml:31`, `src/config.ts:266`
- Test: `src/config.test.ts`（现有，补充输出目录断言）

**Interfaces:**
- Consumes: 无（起点任务）。
- Produces: 素材文件物理落位（背景/BGM/beep 最终英文名；立绘暂以源 id `josei_03`/`josei_12` 命名目录，T3 改名）；`.gitattributes` 已提交（后续任务才能安全 add 二进制素材）。

- [ ] **Step 1: 写 .gitattributes 并提交（先于任何素材）**

创建 `.gitattributes`：

```gitattributes
*.png filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.webp filter=lfs diff=lfs merge=lfs -text
*.ogg filter=lfs diff=lfs merge=lfs -text
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.zip filter=lfs diff=lfs merge=lfs -text
```

```bash
cd /mnt/d/code-linux/llm-galgame-prototype
git lfs install   # 幂等；已装 3.7.1
git add .gitattributes
git commit -m "chore(lfs): track binary asset extensions via git-lfs"
```

- [ ] **Step 2: 改 .gitignore 与 config**

`.gitignore`：把 `assets/audio/*` 替换为 `assets/.tts-cache/*`（TTS 输出目录约定；`output_dir` 现无生产代码使用，属防御性一致）。

`config.yaml` 第 31 行：`essets:` → `assets:`。

`src/config.ts:266`：`output_dir: z.string().min(1).default("assets/audio")` → `output_dir: z.string().min(1).default("assets/.tts-cache")`。

- [ ] **Step 3: 补充 config 测试断言**

`src/config.test.ts` 中为 `makeTestConfig` 默认配置添加（或修改现有）断言：

```ts
expect(config.assets.catalog).toBe("assets/resources.yaml");
expect(config.media.audio.output_dir).toBe("assets/.tts-cache");
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/config.test.ts
```

预期：PASS（若原测试断言了旧默认值，一并更新）。

- [ ] **Step 5: 解压立绘 + 生成 beep + 摆放背景/BGM**

```bash
cd /mnt/d/code-linux/llm-galgame-prototype
mkdir -p assets/characters/josei_03 assets/characters/josei_12 assets/backgrounds assets/audio/bgm assets/audio/se
7z e assets/raw/josei_03_shirowanpi.zip -oassets/characters/josei_03 -y
7z e assets/raw/josei_12_china.zip -oassets/characters/josei_12 -y
rm -f assets/characters/josei_03/*.txt assets/characters/josei_12/*.txt   # README 授权文本留 raw 原包即可
# 背景：日文名 → 英文（内容语义固定，直接定名）
git mv 待办  # 见下：背景用 cp 后删原文件，见 Step 6 说明
```

背景映射（`assets/raw/*.jpg` → `assets/backgrounds/*.jpg`，cp 后 `git rm` 原文件——raw 属 T1 之后提交，见 Step 6）：

```
アジト（照明ON）.jpg        → hideout_on.jpg
アジト（照明OFF）.jpg       → hideout_off.jpg
学校の廊下（日中）.jpg      → hallway_day.jpg
学校の廊下（夕方）.jpg      → hallway_evening.jpg
学校の廊下（夜・照明ON）.jpg → hallway_night_on.jpg
学校の廊下（夜・照明OFF）.jpg → hallway_night_off.jpg
文化系の部室（日中）.jpg    → clubroom_day.jpg
文化系の部室（夕方）.jpg    → clubroom_evening.jpg
文化系の部室（夜・照明ON）.jpg → clubroom_night_on.jpg
文化系の部室（夜・照明OFF）.jpg → clubroom_night_off.jpg
```

BGM（`assets/raw/*.mp3` → `assets/audio/bgm/`，源文件名派生 id，guidance 由用户写）：

```
andriig-relax-relaxing-background-music-572285.mp3  → relax.mp3
krasnoshchok-background-music-soft-calm-404429.mp3  → calm.mp3
the_mountain-background-music-440706.mp3            → mountain.mp3
```

beep（vorbis/opus 编码器均可用）：

```bash
ffmpeg -y -f lavfi -i "sine=frequency=1200:duration=0.12" \
  -af "afade=t=out:st=0.08:d=0.04" -c:a libvorbis \
  assets/audio/se/terminal_beep.ogg
```

- [ ] **Step 6: 写 ATTRIBUTION.md 并提交**

`assets/ATTRIBUTION.md`：

```markdown
# 素材来源与授权

## 角色立绘（立ち絵）
- 来源：立ち絵素材 わたおきば（作者：わたおび）https://wataokiba.net/
- 压缩包：`raw/josei_03_shirowanpi.zip`、`raw/josei_12_china.zip`
- 授权：商用/非商用免费可用；禁止再分发素材本身、禁止虚假作者声明（见包内 README.txt）。
- 原始压缩包保留在 `assets/raw/` 作 provenance。

## 背景
- 来源：同上 わたおきば 背景素材（`raw/*.jpg`）。
- 授权：同上。

## BGM
- 来源：`raw/*.mp3`（文件名含源站 ID：572285 / 404429 / 440706）。
- 授权：按各源站条款；如需署名请补充作者信息。

## 音效
- `audio/se/terminal_beep.ogg`：本仓库 ffmpeg 合成占位音，无第三方版权。
```

提交（LFS 生效验证：`git lfs ls-files` 应列出刚 add 的二进制）：

```bash
git add .gitignore config.yaml src/config.ts src/config.test.ts assets/
git commit -m "assets: land real assets (backgrounds/bgm/beep/chars) + LFS + config fixes"
```

验证：

```bash
git lfs ls-files | head -5          # 应列出 .jpg/.png/.mp3/.ogg
find assets -type f | wc -l         # 素材文件总数（不含 raw 内 zip）
```

---

### Task 2: mimo-v2.5 视觉子代理命名与描述

**Files:**
- Create: `docs/superpowers/notes/asset-vision-report-2026-08-08.md`（子代理报告的落盘）

**Interfaces:**
- Consumes: Task 1 落位的素材（`assets/characters/josei_03/*.png`、`assets/characters/josei_12/*.png`、`assets/backgrounds/*.jpg`）。
- Produces: 每张立绘的表情英文 variant id + 详细中文描述；每张背景的英文 id 确认 + 描述；角色↔立绘集映射建议。Task 3 据此写 `resources.yaml`。

- [ ] **Step 1: 生成联系表（可选，辅助子代理总览）**

```bash
cd /tmp && mkdir -p sheets
# josei_03：9 图横排（base + a–h），缩放 1/2
ffmpeg -y -i /mnt/d/code-linux/llm-galgame-prototype/assets/characters/josei_03/josei_03.png \
  -i .../josei_03_a.png -i .../josei_03_b.png -i .../josei_03_c.png -i .../josei_03_d.png \
  -i .../josei_03_e.png -i .../josei_03_f.png -i .../josei_03_g.png -i .../josei_03_h.png \
  -filter_complex "[0][1][2][3][4][5][6][7][8]xstack=inputs=9:layout=0_0|w0_0|w0+w1_0|w0+w1+w2_0|w0+w1+w2+w3_0|w0+w1+w2+w3+w4_0|w0+w1+w2+w3+w4+w5_0|w0+w1+w2+w3+w4+w5+w6_0|w0+w1+w2+w3+w4+w5+w6+w7_0,scale=iw/2:ih/2" /tmp/sheets/josei_03_row.png -y
# josei_12 同理（png 小写目录名 josei_12）
# 背景：10 图横排 scale=iw/5:ih/5 → /tmp/sheets/bgs_row.png
```

- [ ] **Step 2: 派发视觉子代理**

使用 Agent 工具：`subagent_type: "general-purpose"`，`model: "mimo-v2.5"`，前台等待。提示词必须包含（自包含、无需仓库上下文）：

```
你在为一个校园悬疑视觉小说整理素材命名。任务只读，禁止修改任何文件。

素材位置（用 read 工具看图；每张单独看，也可先看联系表 /tmp/sheets/*.png）：
1. 角色立绘 A：/mnt/d/code-linux/llm-galgame-prototype/assets/characters/josei_03/ 下 josei_03.png（无后缀=基础/默认）+ josei_03_a.png … josei_03_h.png（8 个表情）。
2. 角色立绘 B：…/josei_12/ 下 josei_12.png + josei_12_a.png … josei_12_h.png。
3. 背景：…/assets/backgrounds/ 下 10 张（hideout_on/off、hallway_day/evening/night_on/night_off、clubroom_day/evening/night_on/night_off）——请逐张核对内容是否与文件名相符，不符要指出。

背景：校园悬疑视觉小说。女主角苏遥：冷静、神秘、与地下室里一台旧终端有关联的女生；"神秘女子"可能是她隐藏身份。角色立绘为 わたおきば 素材。

输出要求（markdown 报告，写好后把内容直接作为你的最终回复返回，不要写文件）：
## 立绘集 A（josei_03）
表格：文件 → 建议英文 variant id（语义化，如 normal/happy/angry/surprised/thinking/sad/smiling/embarrassed/crying…，9 个 id 必须互不相同、全小写下划线）→ 一句话表情判定 → 详细外观描述（发型/瞳色/服饰/气质，供 LLM 选表情）→ 建议使用时机（剧情情绪）。
## 立绘集 B（josei_12）
同上。
## 角色映射建议
依据外观气质，建议哪个立绘集绑定苏遥、哪个绑定另一角色（或备用）；给出理由与不确定性说明。
## 背景核对
10 张逐一确认内容；任何与文件名不符处指出并建议改名。
## 立绘技术信息
每集：图片尺寸（像素）、是否透明背景、人物在画面中的位置（居中/偏左）与脚底是否对齐画面底部——用于前端槽位定位。
```

- [ ] **Step 3: 报告落盘**

把子代理返回的报告写入 `docs/superpowers/notes/asset-vision-report-2026-08-08.md`，提交：

```bash
git add docs/superpowers/notes/asset-vision-report-2026-08-08.md
git commit -m "docs: asset vision report (mimo-v2.5 naming + descriptions)"
```

---

### Task 3: 最终素材结构 + resources.yaml 重写 + 角色映射

**Files:**
- Modify: `assets/resources.yaml`（重写）、`assets/characters/*`（git mv 改名目录）
- Test: `src/core/assets/catalog.test.ts`（现有 loader 测试，若资源名变化同步更新 fixture）

**Interfaces:**
- Consumes: Task 2 报告（variant id、描述、映射）。
- Produces: 最终 `resources.yaml`（与磁盘目录一一对应；bgm guidance 留用户字段）、角色映射。

- [ ] **Step 1: 依据报告 git mv 立绘目录**

假设报告建议（以实际报告为准）：立绘集 B（旗袍）→ 苏遥 `suyao`；立绘集 A（白连衣裙）→ 绑定新角色 `mysterious_woman` 或作为 `suyao` 备用——**执行者依据报告外观气质直接定夺**，并在提交说明理由。

```bash
cd /mnt/d/code-linux/llm-galgame-prototype
git mv assets/characters/josei_12 assets/characters/suyao        # 示例：若映射为苏遥
git mv assets/characters/josei_03 assets/characters/other_girl    # 示例：另一角色
# 目录内文件同时改名：josei_12.png → normal.png，josei_12_a.png → <variant_id>.png（按报告）
```

同时删除立绘目录下不再需要的 `.txt`（已在 raw 保留）。

- [ ] **Step 2: 重写 resources.yaml**

结构（variant id 与描述取自报告；路径与磁盘一致）：

```yaml
guidance: |
  当前素材覆盖校园、住宅、地下设施和夜间城市场景。
  整体采用偏冷色调的写实二次元风格。
  背景应尽量复用已有资源，不要因为轻微视角变化频繁切换。
  角色表情资源有限；按情绪强弱谨慎使用。

backgrounds:
  hideout_on:
    src: backgrounds/hideout_on.jpg
    description: |
      （由执行者按报告/常识填写：地下据点、照明开启。）

  # ... hallway_day / hallway_evening / hallway_night_on / hallway_night_off
  # ... clubroom_day / clubroom_evening / clubroom_night_on / clubroom_night_off
  # ... hideout_off

bgm:
  relax:
    src: audio/bgm/relax.mp3
    description: |
      来源：andriig-relax（时长约 139s）。
      # USER: 请撰写该 BGM 的详细 guidance（节奏/情绪/适用场景）。

  calm:
    src: audio/bgm/calm.mp3
    description: |
      来源：krasnoshchok soft-calm（时长约 142s）。
      # USER: 请撰写该 BGM 的详细 guidance。

  mountain:
    src: audio/bgm/mountain.mp3
    description: |
      来源：the_mountain（时长约 135s）。
      # USER: 请撰写该 BGM 的详细 guidance。

sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: |
      旧终端发出的短促电子提示音（合成占位）。

sprite_sets:
  suyao:
    description: |
      苏遥正式立绘（报告摘要）。
    variants:
      normal:
        src: characters/suyao/normal.png
        description: 默认冷静状态。
      # ... 其余 8 个 variant（报告 id + 描述）

  other_girl:
    description: |
      （报告摘要）。
    variants:
      normal: { src: characters/other_girl/normal.png, description: ... }
      # ... 其余 8 个

characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥
    sprite_set: suyao
    default_variant: normal
    default_position: left

  other_girl:
    script_name: <按报告定>
    display_name: <按报告定>
    sprite_set: other_girl
    default_variant: normal
    default_position: right
```

- [ ] **Step 3: 更新 catalog 测试 fixture**

`src/core/assets/catalog.test.ts` 若硬编码了旧资源名（`classroom_day`、`suyao/normal.webp` 等），改为新路径。运行：

```bash
npx vitest run src/core/assets/catalog.test.ts src/application/assets/asset-catalog-loader.test.ts
```

- [ ] **Step 4: 提交**

```bash
git add assets/
git commit -m "assets: final layout + resources.yaml (variant naming from vision report; bgm guidance pending user)"
```

---

### Task 4: loader 启动校验（交叉引用 + 文件存在 + 逃逸）

**Files:**
- Modify: `src/application/assets/asset-catalog-loader.ts`（mapToCatalog 之后追加校验）
- Test: `src/application/assets/asset-catalog-loader.test.ts`

**Interfaces:**
- Consumes: `loadAssetCatalog(filePath): Promise<AssetCatalog>`（现有签名）。
- Produces: 启动时抛错（描述性中文信息）的校验；`AssetCatalog` 不变。

- [ ] **Step 1: 写失败测试**

在 `src/application/assets/asset-catalog-loader.test.ts` 添加（用临时目录 + 真实小文件模拟素材根；可复用现有测试的 temp dir 工具）：

```ts
it("拒绝 characters.sprite_set 引用不存在的 sprite_set", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
  await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
  await writeFile(
    path.join(dir, "resources.yaml"),
    [
      "backgrounds:",
      "  a: { src: bg.png, description: d }",
      "sprite_sets:",
      "  good:",
      "    variants:",
      "      normal: { src: sprite.png }",
      "characters:",
      "  c:",
      "    script_name: 测试",
      "    display_name: 测试",
      "    sprite_set: missing",
      "    default_variant: normal",
      "    default_position: left",
    ].join("\n"),
  );
  await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/sprite_set/);
});

it("拒绝 default_variant 不存在于 sprite_set", async () => {
  // 同上，sprite_set: good，default_variant: nope → 抛 /default_variant/
});

it("拒绝 src 逃逸素材根目录", async () => {
  // backgrounds: a: { src: ../secret.png, ... } → 抛 /逃逸|escape/
});

it("拒绝 src 指向不存在的文件", async () => {
  // backgrounds: a: { src: missing.png, ... } → 抛 /不存在|missing/
});
```

（`makeTempDir` 若测试文件无此工具，用 `fs.mkdtemp(path.join(os.tmpdir(), "catalog-"))` 自建并在 afterEach 清理。）

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/application/assets/asset-catalog-loader.test.ts
```

预期：4 个新用例 FAIL（现有用例仍 PASS）。

- [ ] **Step 3: 实现校验**

`asset-catalog-loader.ts` 中 `mapToCatalog` 之后（`loadAssetCatalog` 返回前）追加 `validateCatalog(catalog, assetRoot)`：

```ts
import { resolve, sep } from "node:path";
import { access } from "node:fs/promises";

async function validateCatalog(
  catalog: AssetCatalog,
  assetRoot: string,
): Promise<void> {
  const rootResolved = resolve(assetRoot);

  for (const [characterId, binding] of Object.entries(catalog.characters)) {
    const set = catalog.spriteSets[binding.spriteSet];
    if (set === undefined) {
      throw new Error(
        `资产目录校验失败: characters.${characterId}.sprite_set "${binding.spriteSet}" 不存在于 sprite_sets`,
      );
    }
    if (!(binding.defaultVariant in set.variants)) {
      throw new Error(
        `资产目录校验失败: characters.${characterId}.default_variant "${binding.defaultVariant}" 不存在于 sprite_set "${binding.spriteSet}"`,
      );
    }
  }

  const srcs: Array<{ where: string; src: string }> = [
    ...Object.entries(catalog.backgrounds).map(([id, a]) => ({ where: `backgrounds.${id}`, src: a.src })),
    ...Object.entries(catalog.bgm).map(([id, a]) => ({ where: `bgm.${id}`, src: a.src })),
    ...Object.entries(catalog.soundEffects).map(([id, a]) => ({ where: `sound_effects.${id}`, src: a.src })),
    ...Object.entries(catalog.spriteSets).flatMap(([id, set]) =>
      Object.entries(set.variants).map(([v, vv]) => ({ where: `sprite_sets.${id}.variants.${v}`, src: vv.src })),
    ),
  ];

  for (const { where, src } of srcs) {
    const filePath = resolve(rootResolved, src);
    if (filePath !== rootResolved && !filePath.startsWith(rootResolved + sep)) {
      throw new Error(`资产目录校验失败: ${where}.src "${src}" 逃逸素材根目录`);
    }
    try {
      await access(filePath);
    } catch {
      throw new Error(`资产目录校验失败: ${where}.src 文件不存在: ${filePath}`);
    }
  }
}
```

`loadAssetCatalog` 内调用：

```ts
const assetRoot = path.dirname(absolutePath);
const catalog = mapToCatalog(result.data);
await validateCatalog(catalog, assetRoot);
return catalog;
```

（`path` 已 import；`access`/`resolve`/`sep` 补充 import。）

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run src/application/assets/asset-catalog-loader.test.ts
```

预期：全部 PASS（含 4 个新用例）。全量 `npm test` 不应有回归（现有测试的 temp yaml 若无文件，需补真实小文件——若旧测试因此失败，在旧 fixture 的 temp 目录补写同名占位文件）。

- [ ] **Step 5: 提交**

```bash
git add src/application/assets/
git commit -m "feat(assets): startup validation (cross-refs, file existence, path escape)"
```

---

### Task 5: PublicAssetManifest + manifest 端点 + /game-assets 路由

**Files:**
- Create: `src/application/assets/asset-manifest.ts`
- Modify: `src/core/assets/types.ts`（加 `PublicAssetManifest`）、`src/application/runtime-application.ts`、`src/bootstrap/create-runtime-application.ts`、`src/hosts/local-web/local-web-host.ts`
- Test: `src/application/assets/asset-manifest.test.ts`（新建）、`src/hosts/local-web/local-web-host.test.ts`

**Interfaces:**
- Consumes: `AssetCatalog`（Task 1 素材落位后真实可加载）；`LocalWebHostOptions`（现有 `{ config, app, dev, logger? }`）。
- Produces:
  - `PublicAssetManifest` 类型；
  - `buildPublicAssetManifest(catalog: AssetCatalog, urlPrefix: string): PublicAssetManifest`；
  - `RuntimeApplication.assetCatalog: AssetCatalog`（新增字段）；
  - LocalWebHost 路由：`GET /api/assets/manifest` → 200 JSON；`GET /game-assets/*` → 文件（403 穿越 / 404 缺失 / 405 非 GET）。

- [ ] **Step 1: 写失败测试（manifest 构建 + 路由）**

`src/application/assets/asset-manifest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildPublicAssetManifest } from "./asset-manifest.js";
import { makeAssetCatalog } from "./asset-manifest.fixtures.js"; // 或内联构造

it("把 src 投影为带前缀的受控 URL，且不泄露绝对路径", () => {
  const catalog = makeAssetCatalog();
  const manifest = buildPublicAssetManifest(catalog, "/game-assets/");
  expect(manifest.backgrounds.basement.url).toBe("/game-assets/backgrounds/basement.jpg");
  expect(manifest.spriteSets.suyao.variants.anxious.url).toBe("/game-assets/characters/suyao/anxious.png");
  expect(manifest.bgm.mystery.url).toBe("/game-assets/audio/bgm/mystery.mp3");
  expect(JSON.stringify(manifest)).not.toMatch(/^\/|\.\.\//); // 无绝对路径/回溯
});
```

`local-web-host.test.ts` 追加（复用现有 `startServer`/`request` 工具与 `makeConfig()`；`makeConfig` 需在 `makeTestConfig` 中注入 `assets: { catalog: <temp 目录>/resources.yaml }` 并在 temp 目录放真实素材文件 + 走 `loadAssetCatalog` 构造 app，或直接构造 `makeAssetCatalog` 传给 host options——优先：测试里构造最小 `AssetCatalog` 对象直接传入 `new LocalWebHost({ ..., assetCatalog })`，绕开磁盘）：

```ts
it("GET /api/assets/manifest 返回投影 URL", async () => {
  const host = await startHost(); // 现有 helper + assetCatalog 参数
  const res = await request(port, "/api/assets/manifest", "GET");
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body).backgrounds).toBeDefined();
});

it("GET /game-assets/... 返回素材文件", async () => {
  const res = await request(port, "/game-assets/backgrounds/basement.jpg", "GET");
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("image/jpeg");
});

it("GET /game-assets/../config.yaml 拒绝穿越", async () => {
  const res = await request(port, "/game-assets/../config.yaml", "GET");
  expect(res.status).toBe(403);
});

it("GET /game-assets/%2e%2e/config.yaml 拒绝编码穿越", async () => {
  const res = await request(port, "/game-assets/%2e%2e/config.yaml", "GET");
  expect(res.status).toBe(403);
});

it("GET /game-assets/missing.png 返回 404", async () => {
  const res = await request(port, "/game-assets/missing.png", "GET");
  expect(res.status).toBe(404);
});

it("无 assetCatalog 时 manifest 返回 404", async () => {
  // 构造不传 assetCatalog 的 host → /api/assets/manifest 404
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/application/assets/asset-manifest.test.ts src/hosts/local-web/local-web-host.test.ts
```

预期：新用例 FAIL（类型错误也算失败——先写类型后再跑，或接受 TS 编译期失败）。

- [ ] **Step 3: 实现类型与构建函数**

`src/core/assets/types.ts` 追加：

```ts
/** Browser-facing projection: logical id → controlled URL (spec §5.2). */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<string, { variants: Record<string, { url: string }> }>;
}
```

`src/application/assets/asset-manifest.ts`：

```ts
import type { AssetCatalog, PublicAssetManifest } from "../../core/assets/types.js";

/** id → 受控 URL 投影；src 视为相对素材根，反斜杠归一（spec §5.2）。 */
export function buildPublicAssetManifest(
  catalog: AssetCatalog,
  urlPrefix: string,
): PublicAssetManifest {
  const url = (src: string): string => `${urlPrefix}${src.replace(/\\/g, "/")}`;
  const backgrounds: PublicAssetManifest["backgrounds"] = {};
  for (const [id, asset] of Object.entries(catalog.backgrounds)) {
    backgrounds[id] = { url: url(asset.src) };
  }
  const bgm: PublicAssetManifest["bgm"] = {};
  for (const [id, asset] of Object.entries(catalog.bgm)) {
    bgm[id] = { url: url(asset.src) };
  }
  const soundEffects: PublicAssetManifest["soundEffects"] = {};
  for (const [id, asset] of Object.entries(catalog.soundEffects)) {
    soundEffects[id] = { url: url(asset.src) };
  }
  const spriteSets: PublicAssetManifest["spriteSets"] = {};
  for (const [id, set] of Object.entries(catalog.spriteSets)) {
    const variants: Record<string, { url: string }> = {};
    for (const [variantId, variant] of Object.entries(set.variants)) {
      variants[variantId] = { url: url(variant.src) };
    }
    spriteSets[id] = { variants };
  }
  return { backgrounds, bgm, soundEffects, spriteSets };
}
```

- [ ] **Step 4: 实现 host 接线**

`src/application/runtime-application.ts`：`RuntimeApplication` 接口加 `assetCatalog: AssetCatalog;`（import 类型）。

`src/bootstrap/create-runtime-application.ts`：返回值对象加 `assetCatalog`（变量已存在，第 64 行附近 `const assetCatalog = await loadAssetCatalog(config.assets.catalog)`）。

`src/hosts/local-web/local-web-host.ts`：

```ts
// imports 追加
import type { AssetCatalog, PublicAssetManifest } from "../../core/assets/types.js";
import { buildPublicAssetManifest } from "../../application/assets/asset-manifest.js";

export interface LocalWebHostOptions {
  config: AppConfig;
  app: RuntimeApplication;
  dev: boolean;
  logger?: (line: string) => void;
  /** Asset catalog for manifest + /game-assets serving. 缺省时不启用资源服务。 */
  assetCatalog?: AssetCatalog;
}
```

构造函数内：

```ts
this.assetRoot =
  options.assetCatalog !== undefined
    ? path.dirname(path.resolve(this.config.assets.catalog))
    : null;
this.assetManifest =
  options.assetCatalog !== undefined
    ? buildPublicAssetManifest(options.assetCatalog, "/game-assets/")
    : null;
```

类字段：`private readonly assetRoot: string | null;`、`private readonly assetManifest: PublicAssetManifest | null;`

`handleRequest` 中（`/api/config` 分支之后、`/api/` 404 之前）：

```ts
if (req.method === "GET" && pathname === "/api/assets/manifest") {
  if (this.assetManifest === null) {
    this.sendJson(res, 404, { error: "asset catalog unavailable" });
    return;
  }
  this.sendJson(res, 200, this.assetManifest);
  return;
}
if (req.method === "GET" && pathname.startsWith("/game-assets/")) {
  if (this.assetRoot === null) {
    this.sendJson(res, 404, { error: "asset catalog unavailable" });
    return;
  }
  void serveAssetFile(this.assetRoot, req, res, pathname);
  return;
}
```

文件尾部新增（仿 `serveFile`，但无 SPA fallback）：

```ts
const ASSET_MIME_TYPES: Record<string, string> = {
  ...MIME_TYPES,
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

async function serveAssetFile(
  assetRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("method not allowed");
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/game-assets/".length));
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  const filePath = path.resolve(assetRoot, relative);
  const rootResolved = path.resolve(assetRoot);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  let content: Buffer | null = null;
  try {
    content = await readFile(filePath);
  } catch {
    // fall through to 404
  }
  if (content === null) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": ASSET_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : content);
}
```

现有 `local-web-host.test.ts` 的 `makeConfig()` 若不传 `assetCatalog`，行为不变（manifest/game-assets 404）——存量测试不受影响。

- [ ] **Step 5: 运行确认通过 + 全量**

```bash
npx vitest run src/application/assets/asset-manifest.test.ts src/hosts/local-web/local-web-host.test.ts
npm run typecheck
npm test
```

- [ ] **Step 6: 提交**

```bash
git add src/
git commit -m "feat(assets): public manifest endpoint + /game-assets static route with traversal guard"
```

---

### Task 6: BrowserAssetResolver + manifest client

**Files:**
- Create: `web/src/stage/asset-manifest-client.ts`、`web/src/stage/browser-asset-resolver.ts`、`web/src/stage/browser-asset-resolver.test.ts`
- Modify: `web/src/stage/stage-types.ts`（加 `PublicAssetManifest` wire 镜像）

**Interfaces:**
- Consumes: `GET /api/assets/manifest`（Task 5）。
- Produces:
  - `fetchAssetManifest(): Promise<PublicAssetManifest | null>`；
  - `class BrowserAssetResolver { constructor(manifest: PublicAssetManifest | null); resolveBackground(id): string | undefined; resolveBgm(id): string | undefined; resolveSoundEffect(id): string | undefined; resolveSprite(set, variant): string | undefined; get manifest(): PublicAssetManifest | null; }`；
  - `PublicAssetManifest`（web wire 镜像，结构同 core 版）。

- [ ] **Step 1: 写失败测试**

`web/src/stage/browser-asset-resolver.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: { basement: { url: "/game-assets/backgrounds/basement.jpg" } },
  bgm: { mystery: { url: "/game-assets/audio/bgm/mystery.mp3" } },
  soundEffects: { beep: { url: "/game-assets/audio/se/beep.ogg" } },
  spriteSets: { suyao: { variants: { anxious: { url: "/game-assets/characters/suyao/anxious.png" } } } },
};

describe("BrowserAssetResolver", () => {
  it("按逻辑 id 解析受控 URL", () => {
    const r = new BrowserAssetResolver(manifest);
    expect(r.resolveBackground("basement")).toBe("/game-assets/backgrounds/basement.jpg");
    expect(r.resolveBgm("mystery")).toBe("/game-assets/audio/bgm/mystery.mp3");
    expect(r.resolveSoundEffect("beep")).toBe("/game-assets/audio/se/beep.ogg");
    expect(r.resolveSprite("suyao", "anxious")).toBe("/game-assets/characters/suyao/anxious.png");
  });

  it("未知 id 返回 undefined", () => {
    const r = new BrowserAssetResolver(manifest);
    expect(r.resolveBackground("nope")).toBeUndefined();
    expect(r.resolveSprite("suyao", "nope")).toBeUndefined();
  });

  it("无 manifest 时全部 undefined", () => {
    const r = new BrowserAssetResolver(null);
    expect(r.resolveBackground("basement")).toBeUndefined();
  });
});
```

`web/src/stage/asset-manifest-client.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchAssetManifest } from "./asset-manifest-client.js";

it("成功时返回解析后的 manifest", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ backgrounds: { a: { url: "/x" } } }),
  }));
  const m = await fetchAssetManifest();
  expect(m?.backgrounds.a.url).toBe("/x");
});

it("非 200 或异常时返回 null", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  expect(await fetchAssetManifest()).toBeNull();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
  expect(await fetchAssetManifest()).toBeNull();
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run web/src/stage/browser-asset-resolver.test.ts web/src/stage/asset-manifest-client.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`web/src/stage/stage-types.ts` 追加（wire 镜像，浏览器不依赖 core）：

```ts
/** Wire mirror of the core PublicAssetManifest (spec §5.2). */
export interface PublicAssetManifest {
  backgrounds: Record<string, { url: string }>;
  bgm: Record<string, { url: string }>;
  soundEffects: Record<string, { url: string }>;
  spriteSets: Record<string, { variants: Record<string, { url: string }> }>;
}
```

`web/src/stage/asset-manifest-client.ts`：

```ts
import type { PublicAssetManifest } from "./stage-types.js";

/** 启动时请求一次；任何失败返回 null（渲染器回退占位，spec §6.1）。 */
export async function fetchAssetManifest(): Promise<PublicAssetManifest | null> {
  try {
    const res = await fetch("/api/assets/manifest");
    if (!res.ok) return null;
    return (await res.json()) as PublicAssetManifest;
  } catch {
    return null;
  }
}
```

`web/src/stage/browser-asset-resolver.ts`：

```ts
import type { PublicAssetManifest } from "./stage-types.js";

/** 逻辑 id → 受控 URL 的纯映射（spec §6.1）。 */
export class BrowserAssetResolver {
  constructor(private readonly manifest: PublicAssetManifest | null) {}

  get manifest(): PublicAssetManifest | null {
    return this.manifest;
  }

  resolveBackground(id: string): string | undefined {
    return this.manifest?.backgrounds[id]?.url;
  }

  resolveBgm(id: string): string | undefined {
    return this.manifest?.bgm[id]?.url;
  }

  resolveSoundEffect(id: string): string | undefined {
    return this.manifest?.soundEffects[id]?.url;
  }

  resolveSprite(spriteSet: string, variant: string): string | undefined {
    return this.manifest?.spriteSets[spriteSet]?.variants[variant]?.url;
  }
}
```

（注意：字段与 getter 同名会编译错——字段改名为 `private readonly manifestData`，getter 返回 `this.manifestData`。）

- [ ] **Step 4: 运行确认通过**

```bash
npx vitest run web/src/stage/browser-asset-resolver.test.ts web/src/stage/asset-manifest-client.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add web/src/stage/
git commit -m "feat(web): asset manifest client + BrowserAssetResolver"
```

---

### Task 7: Keyed StageRenderer（真实图片渲染）

**Files:**
- Modify: `web/src/stage/stage-renderer.ts`（重写）、`web/src/stage/stage-renderer.test.ts`、`web/src/ui/styles.css`
- Test: `web/src/stage/stage-renderer.test.ts`

**Interfaces:**
- Consumes: `BrowserAssetResolver`（Task 6）；`StageVisualState`/`StageCharacterState`（现有）。
- Produces: `class StageRenderer { constructor(container: HTMLElement, resolver: BrowserAssetResolver); apply(state: StageVisualState): void; }`——背景 img crossfade、角色 figure 持久节点（variant 换 src、position 换 class、visible 换 hidden、无 URL 回退色块占位）。**构造函数签名变更**（原来只有 container），main.ts 与既有测试须同步更新。

- [ ] **Step 1: 重写失败测试**

`web/src/stage/stage-renderer.test.ts` 全部替换为（保留 happy-dom 环境；resolver 用真实例 + 内联 manifest）：

```ts
import { describe, expect, it } from "vitest";
import { StageRenderer } from "./stage-renderer.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest, StageVisualState } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: { basement: { url: "/game-assets/backgrounds/basement.jpg" } },
  bgm: {},
  soundEffects: {},
  spriteSets: { suyao: { variants: { normal: { url: "/game-assets/characters/suyao/normal.png" }, anxious: { url: "/game-assets/characters/suyao/anxious.png" } } } },
};

function makeState(overrides: Partial<StageVisualState> = {}): StageVisualState {
  return {
    background: "basement",
    characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "left", displayName: "苏遥", visible: true } },
    ...overrides,
  };
}

function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const resolver = new BrowserAssetResolver(manifest);
  const renderer = new StageRenderer(container, resolver);
  return { container, resolver, renderer };
}

describe("StageRenderer", () => {
  it("背景渲染为 <img> 且带 data-asset", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const img = container.querySelector<HTMLImageElement>(".stage__bg img");
    expect(img).not.toBeNull();
    expect(img?.dataset.asset).toBe("basement");
    expect(img?.src).toContain("/game-assets/backgrounds/basement.jpg");
  });

  it("角色首次出现创建 figure，换 variant 不重建节点", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char");
    const img = figure?.querySelector("img");
    expect(img?.getAttribute("src")).toContain("normal.png");
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "anxious", position: "left", displayName: "苏遥", visible: true } } }));
    const figure2 = container.querySelector<HTMLElement>("figure.stage__char");
    expect(figure2).toBe(figure);                    // 同一节点
    expect(figure2?.querySelector("img")?.getAttribute("src")).toContain("anxious.png");
  });

  it("position 变化只换 class", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char")!;
    expect(figure.classList.contains("stage__char--left")).toBe(true);
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "right", displayName: "苏遥", visible: true } } }));
    expect(figure.classList.contains("stage__char--right")).toBe(true);
    expect(figure.classList.contains("stage__char--left")).toBe(false);
  });

  it("visible=false 加 hidden，恢复后移除", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    const figure = container.querySelector<HTMLElement>("figure.stage__char")!;
    renderer.apply(makeState({ characters: { suyao: { spriteSet: "suyao", variant: "normal", position: "left", displayName: "苏遥", visible: false } } }));
    expect(figure.hidden).toBe(true);
    renderer.apply(makeState());
    expect(figure.hidden).toBe(false);
  });

  it("无 manifest（resolver 全 undefined）回退占位：背景色块 + 角色占位 class", () => {
    const container = document.createElement("div");
    const renderer = new StageRenderer(container, new BrowserAssetResolver(null));
    renderer.apply(makeState());
    expect(container.querySelector(".stage__bg-item")).not.toBeNull();
    const figure = container.querySelector<HTMLElement>("figure.stage__char");
    expect(figure?.classList.contains("stage__char--placeholder")).toBe(true);
  });

  it("角色离开舞台时移除节点", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    renderer.apply(makeState({ characters: {} }));
    expect(container.querySelectorAll("figure.stage__char").length).toBe(0);
  });

  it("重复 apply 幂等：不重复创建层", () => {
    const { container, renderer } = setup();
    renderer.apply(makeState());
    renderer.apply(makeState());
    expect(container.querySelectorAll(".stage__bg").length).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run web/src/stage/stage-renderer.test.ts
```

预期：FAIL（构造函数签名不匹配 + 行为不符）。

- [ ] **Step 3: 重写 stage-renderer.ts**

```ts
/**
 * StageRenderer — keyed 舞台渲染（spec §6.2）。
 *
 * 背景：持久 <img>，切换时新图 load 后加 .stage__bg-img--ready 淡入，
 *       旧图随层清空移除（crossfade 由 CSS transition 完成）。
 * 角色：每 characterId 一个 <figure> 持久节点；variant 变只换 img.src，
 *       position 变只换 slot class，visible 变只切 hidden。
 *       无 URL（manifest 缺失/未知 id）时回退色块占位（deterministicHue）。
 */
import { clearChildren, el } from "../ui/dom.js";
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { StageCharacterState, StageVisualState } from "./stage-types.js";

const SLOT_CLASSES = [
  "stage__char--far_left",
  "stage__char--left",
  "stage__char--center",
  "stage__char--right",
  "stage__char--far_right",
] as const;

/** Deterministic hue (0–359) from a string id — 占位色块用。 */
export function deterministicHue(key: string): number {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
  return sum % 360;
}

interface CharacterNode {
  root: HTMLElement;
  img: HTMLImageElement;
  label: HTMLElement;
}

export class StageRenderer {
  private readonly bgLayer: HTMLDivElement;
  private readonly charsLayer: HTMLDivElement;
  private backgroundId: string | undefined;
  private readonly characterNodes = new Map<string, CharacterNode>();

  constructor(
    private readonly container: HTMLElement,
    private readonly resolver: BrowserAssetResolver,
  ) {
    this.bgLayer = el("div", "stage__bg");
    this.charsLayer = el("div", "stage__chars");
    container.append(this.bgLayer, this.charsLayer);
  }

  apply(state: StageVisualState): void {
    this.applyBackground(state.background);
    this.applyCharacters(state.characters);
    if (state.bgm !== undefined) {
      this.container.dataset.bgm = state.bgm;
    } else {
      delete this.container.dataset.bgm;
    }
  }

  private applyBackground(id: string | undefined): void {
    if (id === this.backgroundId) return;
    this.backgroundId = id;
    clearChildren(this.bgLayer);
    if (id === undefined) return;

    const url = this.resolver.resolveBackground(id);
    if (url === undefined) {
      const item = el("div", "stage__bg-item");
      item.dataset.asset = id;
      item.style.background = `hsl(${deterministicHue(id)}, 30%, 18%)`;
      item.append(el("span", "stage__bg-label", id));
      this.bgLayer.append(item);
      return;
    }

    const img = document.createElement("img");
    img.alt = id;
    img.dataset.asset = id;
    img.classList.add("stage__bg-img");
    img.addEventListener("load", () => img.classList.add("stage__bg-img--ready"), { once: true });
    img.src = url;
    this.bgLayer.append(img);
  }

  private applyCharacters(characters: Record<string, StageCharacterState>): void {
    const wanted = new Set(Object.keys(characters));

    for (const [key, node] of this.characterNodes) {
      if (!wanted.has(key)) {
        node.root.remove();
        this.characterNodes.delete(key);
      }
    }

    for (const key of Object.keys(characters).sort()) {
      const character = characters[key]!;
      let node = this.characterNodes.get(key);
      if (node === undefined) {
        node = this.ensureCharacter(key);
      }
      this.updateCharacter(node, key, character);
    }
  }

  private ensureCharacter(key: string): CharacterNode {
    const root = document.createElement("figure");
    root.className = "stage__char";
    root.dataset.char = key;
    const img = document.createElement("img");
    img.alt = key;
    const label = document.createElement("figcaption");
    root.append(img, label);
    this.charsLayer.append(root);
    const node: CharacterNode = { root, img, label };
    this.characterNodes.set(key, node);
    return node;
  }

  private updateCharacter(node: CharacterNode, key: string, character: StageCharacterState): void {
    const url = this.resolver.resolveSprite(character.spriteSet, character.variant);

    if (url === undefined) {
      node.root.classList.add("stage__char--placeholder");
      node.root.style.background = `hsl(${deterministicHue(key)}, 45%, 35%)`;
      node.img.removeAttribute("src");
    } else {
      node.root.classList.remove("stage__char--placeholder");
      node.root.style.background = "";
      if (node.img.getAttribute("src") !== url) {
        node.img.src = url;
      }
    }

    for (const slot of SLOT_CLASSES) node.root.classList.remove(slot);
    node.root.classList.add(`stage__char--${character.position}`);

    node.root.hidden = !character.visible;
    node.label.textContent = character.displayName;
  }
}
```

- [ ] **Step 4: CSS 槽位与图片样式**

`web/src/ui/styles.css`：替换 `.stage__bg` / `.stage__bg-item` / `.stage__chars` / `.stage__char*` 相关块为（保留 `.stage__bg-label`）：

```css
.stage__bg {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.stage__bg-item {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.stage__bg-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.6s ease;
}
.stage__bg-img--ready {
  opacity: 1;
}
.stage__chars {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.stage__char {
  position: absolute;
  bottom: 0;
  height: 92%;
  width: auto;
  margin: 0;
  opacity: 1;
  transition: opacity 0.4s ease;
}
.stage__char img {
  height: 100%;
  width: auto;
  object-fit: contain;
}
.stage__char figcaption {
  position: absolute;
  bottom: 2%;
  left: 50%;
  transform: translateX(-50%);
  font-size: 13px;
  color: #eee;
  text-shadow: 0 1px 3px #000;
  white-space: nowrap;
}
.stage__char[hidden] {
  opacity: 0;
  display: block !important; /* 保留布局以让淡出生效 */
}
.stage__char--placeholder img {
  display: none;
}
.stage__char--far_left {
  left: 0%;
  transform: translateX(-15%);
}
.stage__char--left {
  left: 20%;
  transform: translateX(-50%);
}
.stage__char--center {
  left: 50%;
  transform: translateX(-50%);
}
.stage__char--right {
  left: 80%;
  transform: translateX(-50%);
}
.stage__char--far_right {
  left: 100%;
  transform: translateX(-85%);
}
```

- [ ] **Step 5: 同步 main.ts 构造调用**

`web/src/main.ts` 第 51 行附近：`new StageRenderer(refs.stage)` → 先建 resolver 再传：

```ts
const manifest = await fetchAssetManifest();
const assetResolver = new BrowserAssetResolver(manifest);
const stageRenderer = new StageRenderer(refs.stage, assetResolver);
```

（`boot` 改为 `async`；`main.ts` 底部调用处 `void boot()`。T11 会统一接线，此处先保证编译。）

- [ ] **Step 6: 运行确认通过 + typecheck**

```bash
npx vitest run web/src/stage/stage-renderer.test.ts
npm run typecheck
```

- [ ] **Step 7: 提交**

```bash
git add web/src/stage/ web/src/main.ts web/src/ui/styles.css
git commit -m "feat(web): keyed StageRenderer with real image rendering + placeholder fallback"
```

---

### Task 8: BgmController + autoplay 解锁 + 音量接线

**Files:**
- Create: `web/src/stage/bgm-controller.ts`、`web/src/stage/bgm-controller.test.ts`
- Modify: `web/src/app.ts`（GameAppOptions 加 seam；setVolume/setMuted 转发）

**Interfaces:**
- Consumes: `BrowserAssetResolver`（Task 6）。
- Produces: `class BgmController { constructor(resolver, createAudio?); unlock(): void; apply(id: string | undefined): void; setVolume(v: number): void; setMuted(m: boolean): void; }`

- [ ] **Step 1: 写失败测试**

`web/src/stage/bgm-controller.test.ts`（happy-dom 无真实 Audio，注入 fake）：

```ts
import { describe, expect, it, vi } from "vitest";
import { BgmController } from "./bgm-controller.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: {},
  bgm: { mystery: { url: "/game-assets/audio/bgm/mystery.mp3" } },
  soundEffects: {},
  spriteSets: {},
};

function makeAudio() {
  const audio = {
    loop: false,
    preload: "",
    src: "",
    volume: 1,
    currentTime: 0,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
  };
  return audio;
}

describe("BgmController", () => {
  it("apply(id) 设置 src 并播放；相同 id 不重复设置", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("mystery");
    expect(audio.src).toContain("/game-assets/audio/bgm/mystery.mp3");
    expect(audio.play).toHaveBeenCalledTimes(1);
    controller.apply("mystery");
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("apply(undefined) 暂停并清空 src（bgm stop 语义）", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("mystery");
    controller.apply(undefined);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
  });

  it("未知 id 保持静音不播放", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.apply("nope");
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("setVolume/setMuted 反映到 audio.volume", () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.setVolume(0.4);
    expect(audio.volume).toBe(0.4);
    controller.setMuted(true);
    expect(audio.volume).toBe(0);
    controller.setMuted(false);
    expect(audio.volume).toBe(0.4);
  });

  it("unlock() 在 0 音量播放首曲后暂停（手势内解锁）", async () => {
    const audio = makeAudio();
    const controller = new BgmController(new BrowserAssetResolver(manifest), () => audio as unknown as HTMLAudioElement);
    controller.unlock();
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run web/src/stage/bgm-controller.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 BgmController**

`web/src/stage/bgm-controller.ts`：

```ts
/**
 * BgmController — 薄 <audio> 封装（spec §6.3）。
 * 观察 visualState.bgm；undefined（含 Core 已把 bgm stop 折叠成 undefined）
 * 即暂停清空。不接入 TTS PCM/AudioWorklet 管线。
 */
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";

export class BgmController {
  private currentId: string | undefined;
  private readonly audio: HTMLAudioElement;
  private volume = 1;
  private muted = false;

  constructor(
    private readonly resolver: BrowserAssetResolver,
    createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.audio = createAudio();
    this.audio.loop = true;
    this.audio.preload = "auto";
  }

  /** Start 手势内调用：0 音量播放一次首曲再暂停，解锁 autoplay 策略。 */
  unlock(): void {
    const firstId = Object.keys(this.resolver.manifest?.bgm ?? {})[0];
    if (firstId === undefined) return;
    const url = this.resolver.resolveBgm(firstId);
    if (url === undefined) return;
    this.audio.src = url;
    this.audio.volume = 0;
    void this.audio
      .play()
      .then(() => {
        this.audio.pause();
        this.audio.volume = this.muted ? 0 : this.volume;
      })
      .catch(() => {});
  }

  apply(id: string | undefined): void {
    if (id === this.currentId) return;
    this.currentId = id;
    if (id === undefined) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      return;
    }
    const url = this.resolver.resolveBgm(id);
    if (url === undefined) return; // 未知/不可用：保持静音
    this.audio.src = url;
    this.audio.loop = true;
    this.audio.volume = this.muted ? 0 : this.volume;
    void this.audio.play().catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.audio.volume = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.audio.volume = muted ? 0 : this.volume;
  }
}
```

- [ ] **Step 4: GameApp 音量转发 seam**

`web/src/app.ts`：`GameAppOptions` 加 `bgmController?: BgmController;`（import 类型）。GameApp 加字段 `private readonly bgmController: BgmController | null;`（构造函数 `options.bgmController ?? null`）。`setVolume` / `setMuted` 追加：

```ts
this.bgmController?.setVolume(this.volume);
// ...
this.bgmController?.setMuted(muted);
```

- [ ] **Step 5: 运行确认通过 + typecheck**

```bash
npx vitest run web/src/stage/bgm-controller.test.ts
npm run typecheck
```

- [ ] **Step 6: 提交**

```bash
git add web/src/stage/bgm-controller.ts web/src/stage/bgm-controller.test.ts web/src/app.ts
git commit -m "feat(web): BgmController (loop/stop/unlock) + volume/mute forwarding"
```

---

### Task 9: GameViewModel cue 透传 + SoundEffectController

**Files:**
- Modify: `web/src/runtime/game-view-model.ts`、`web/src/stage/stage-types.ts`、`web/src/runtime/game-view-model.test.ts`
- Create: `web/src/stage/sound-effect-controller.ts`、`web/src/stage/sound-effect-controller.test.ts`

**Interfaces:**
- Consumes: `presentation.cues`（RuntimeOutput wire）；`BrowserAssetResolver`。
- Produces: `GameViewModel.consumeCues(): StageCueWire[]`（一次性取走并清空）；`class SoundEffectController { constructor(resolver, createAudio?); consume(cues: readonly StageCueWire[]): void; }`；`StageCueWire` 类型。

- [ ] **Step 1: 写失败测试**

`web/src/runtime/game-view-model.test.ts` 追加：

```ts
it("presentation.cues 被暂存，consumeCues 一次性取走", () => {
  const vm = new GameViewModel();
  vm.handleOutput({
    type: "playback_ready",
    event: { type: "narration", text: "…", line_id: "l1" },
    presentation: {
      visualState: { background: "basement", characters: {} },
      cues: [{ type: "sound_effect", assetId: "beep" }, { type: "background", assetId: "basement" }],
    },
  });
  const cues = vm.consumeCues();
  expect(cues).toHaveLength(2);
  expect(vm.consumeCues()).toHaveLength(0); // 二次为空
});

it("重连投影恢复时 cues 被清空（不重放）", () => {
  const vm = new GameViewModel();
  vm.handleOutput({ type: "playback_ready", event: { type: "narration", text: "…", line_id: "l1" }, presentation: { visualState: { background: "basement", characters: {} }, cues: [{ type: "sound_effect", assetId: "beep" }] } });
  vm.applyProjection({ ...makeProjection(), visualState: { background: "basement", characters: {} } });
  expect(vm.consumeCues()).toHaveLength(0);
});
```

（`handleOutput` / `applyProjection` / `makeProjection` 以现有测试为准——若 VM 对外方法名不同，用现有测试的调用方式。）

`web/src/stage/sound-effect-controller.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { SoundEffectController } from "./sound-effect-controller.js";
import { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { PublicAssetManifest, StageCueWire } from "./stage-types.js";

const manifest: PublicAssetManifest = {
  backgrounds: {},
  bgm: {},
  soundEffects: { beep: { url: "/game-assets/audio/se/beep.ogg" } },
  spriteSets: {},
};

describe("SoundEffectController", () => {
  it("只播放 sound_effect cue，且每 cue 一个一次性 Audio", () => {
    const audios: Array<{ play: ReturnType<typeof vi.fn> }> = [];
    const controller = new SoundEffectController(new BrowserAssetResolver(manifest), () => {
      const audio = { src: "", play: vi.fn().mockResolvedValue(undefined) };
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    });
    const cues: StageCueWire[] = [
      { type: "sound_effect", assetId: "beep" },
      { type: "background", assetId: "basement" },
      { type: "sound_effect", assetId: "beep" },
    ];
    controller.consume(cues);
    expect(audios).toHaveLength(2);
    expect(audios[0]?.play).toHaveBeenCalled();
    expect(audios[0]?.src).toContain("/game-assets/audio/se/beep.ogg");
  });

  it("未知音效 id 静默跳过", () => {
    const play = vi.fn();
    const controller = new SoundEffectController(new BrowserAssetResolver(manifest), () => ({ src: "", play } as unknown as HTMLAudioElement));
    controller.consume([{ type: "sound_effect", assetId: "nope" }]);
    expect(play).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run web/src/runtime/game-view-model.test.ts web/src/stage/sound-effect-controller.test.ts
```

- [ ] **Step 3: 实现**

`web/src/stage/stage-types.ts` 追加：

```ts
/** 瞬态演出 cue 的 wire 镜像（spec §6.4）；SE 是瞬时效果，不入 VisualState。 */
export type StageCueWire =
  | { type: "background"; assetId: string }
  | { type: "bgm"; assetId: string }
  | { type: "sound_effect"; assetId: string }
  | { type: "character_patch"; character: string; [key: string]: unknown };
```

`web/src/runtime/game-view-model.ts`：
- 字段 `private cues: StageCueWire[] = [];`
- 三处 `output.presentation !== undefined` 分支（playback_ready / interaction_opened / stage_beat_ready）追加：

```ts
this.cues.push(...(output.presentation.cues ?? []));
```

- `applyProjection`（或等价的重连恢复入口）中清空：`this.cues = [];`
- 新增方法：

```ts
/** 取走并清空暂存的瞬态 cues（重渲染不重放，spec §6.4）。 */
consumeCues(): StageCueWire[] {
  const cues = this.cues;
  this.cues = [];
  return cues;
}
```

`web/src/stage/sound-effect-controller.ts`：

```ts
import type { BrowserAssetResolver } from "./browser-asset-resolver.js";
import type { StageCueWire } from "./stage-types.js";

/** 消费瞬态 sound_effect cue：一次性 Audio 播放，不入 VisualState（spec §6.4）。 */
export class SoundEffectController {
  constructor(
    private readonly resolver: BrowserAssetResolver,
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  consume(cues: readonly StageCueWire[]): void {
    for (const cue of cues) {
      if (cue.type !== "sound_effect") continue;
      const url = this.resolver.resolveSoundEffect(cue.assetId);
      if (url === undefined) continue;
      const audio = this.createAudio();
      audio.src = url;
      void audio.play().catch(() => {});
    }
  }
}
```

- [ ] **Step 4: 运行确认通过 + typecheck**

```bash
npx vitest run web/src/runtime/game-view-model.test.ts web/src/stage/sound-effect-controller.test.ts
npm run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add web/src/
git commit -m "feat(web): pass through transient presentation cues + SoundEffectController"
```

---

### Task 10: Compiler 语义校验与降级 + Metrics 诊断

**Files:**
- Modify: `src/core/protocol/gal-dsl/types.ts`、`src/core/protocol/gal-dsl/compiler.ts`、`src/runtime/metrics.ts`、`src/game.ts`（compileGroup 接线）
- Test: `src/core/protocol/gal-dsl/compiler.test.ts`、`src/runtime/metrics.test.ts`

**Interfaces:**
- Consumes: `AssetCatalog`（core/assets/types）；`CompileEventGroupsOptions`（现有）；`Metrics`（现有）。
- Produces:
  - `AssetDiagnosticCode = "UNKNOWN_BACKGROUND" | "UNKNOWN_BGM" | "UNKNOWN_SOUND_EFFECT" | "UNKNOWN_SPRITE_VARIANT"`；`interface AssetDiagnostic { code: AssetDiagnosticCode; id: string; }`
  - `CompileEventGroupsOptions` 追加可选 `catalog?: AssetCatalog`、`diagnostics?: AssetDiagnostic[]`
  - `Metrics.recordAssetDiagnostic(code: AssetDiagnosticCode): void`、`Metrics.assetDiagnosticCounts(): Record<string, number>`

- [ ] **Step 1: 写失败测试**

`src/core/protocol/gal-dsl/compiler.test.ts` 追加（用现有 fixture/构造器构造 catalog 与 draft；catalog 最小可用：

```ts
const catalog: AssetCatalog = {
  backgrounds: { basement: { id: "basement", src: "backgrounds/basement.jpg", description: "" } },
  bgm: { mystery: { id: "mystery", src: "audio/bgm/mystery.mp3", description: "" } },
  soundEffects: { beep: { id: "beep", src: "audio/se/beep.ogg", description: "" } },
  spriteSets: { suyao: { id: "suyao", variants: { normal: { id: "normal", src: "characters/suyao/normal.png" }, anxious: { id: "anxious", src: "characters/suyao/anxious.png" } } } },
  characters: {},
};
```

```ts
it("未知背景 cue 被丢弃并记录 UNKNOWN_BACKGROUND，状态保持", () => {
  const diagnostics: AssetDiagnostic[] = [];
  const { group, tailState } = compileEventGroup(
    makeGroup({ prelude: [{ type: "background", assetId: "nope" }], main: { type: "narration", text: "…" } }),
    { registry: emptyRegistry, tailState: withBackground("basement"), reduce, defaultsFor, catalog, diagnostics },
  );
  expect(group.prelude).toHaveLength(0);
  expect(tailState.background).toBe("basement");
  expect(diagnostics).toEqual([{ code: "UNKNOWN_BACKGROUND", id: "nope" }]);
});

it("未知 bgm/se cue 同理（UNKNOWN_BGM / UNKNOWN_SOUND_EFFECT）", () => { /* … */ });

it("未知立绘 variant 丢弃 patch（=keep），文本照常", () => {
  const diagnostics: AssetDiagnostic[] = [];
  const start = withCharacter("suyao", { spriteSet: "suyao", variant: "normal", position: "left", displayName: "苏遥", visible: true });
  const { group, tailState } = compileEventGroup(
    makeGroup({ prelude: [{ type: "character_patch", character: "suyao", variant: { op: "set", value: "embarrassed" } }], main: { type: "narration", text: "…" } }),
    { registry: emptyRegistry, tailState: start, reduce, defaultsFor, catalog, diagnostics },
  );
  expect(group.prelude).toHaveLength(0);
  expect(tailState.characters.suyao?.variant).toBe("normal");
  expect(diagnostics).toEqual([{ code: "UNKNOWN_SPRITE_VARIANT", id: "embarrassed" }]);
});

it("合法 id / variant 原样通过，无诊断", () => {
  const diagnostics: AssetDiagnostic[] = [];
  const { group } = compileEventGroup(/* 背景 basement + 变体 anxious 的 dialogue */, { /* … */ catalog, diagnostics });
  expect(group.prelude.length).toBeGreaterThan(0);
  expect(diagnostics).toHaveLength(0);
});

it("未传 catalog 时不校验（向后兼容）", () => {
  const { group } = compileEventGroup(/* 含未知背景 cue */, { registry, tailState, reduce, defaultsFor });
  expect(group.prelude).toHaveLength(1); // 原样保留
});
```

`src/runtime/metrics.test.ts` 追加：

```ts
it("recordAssetDiagnostic 计数，assetDiagnosticCounts 返回副本", () => {
  const metrics = new Metrics();
  metrics.recordAssetDiagnostic("UNKNOWN_BACKGROUND");
  metrics.recordAssetDiagnostic("UNKNOWN_BACKGROUND");
  metrics.recordAssetDiagnostic("UNKNOWN_SPRITE_VARIANT");
  const counts = metrics.assetDiagnosticCounts();
  expect(counts.UNKNOWN_BACKGROUND).toBe(2);
  expect(counts.UNKNOWN_SPRITE_VARIANT).toBe(1);
  expect(metrics.assetDiagnosticCounts()).toEqual(counts); // 副本不影响内部
});
```

（测试用现有 fixture 的 `emptyRegistry`、`makeGroup`、`withBackground` 等——若不存在则按现有测试文件风格内联构造。）

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/core/protocol/gal-dsl/compiler.test.ts src/runtime/metrics.test.ts
```

预期：新用例 FAIL（类型/行为）。

- [ ] **Step 3: 实现类型与过滤器**

`src/core/protocol/gal-dsl/types.ts` 追加：

```ts
/** 素材语义校验诊断码（spec §7）。 */
export type AssetDiagnosticCode =
  | "UNKNOWN_BACKGROUND"
  | "UNKNOWN_BGM"
  | "UNKNOWN_SOUND_EFFECT"
  | "UNKNOWN_SPRITE_VARIANT";

export interface AssetDiagnostic {
  code: AssetDiagnosticCode;
  id: string;
}
```

`src/core/protocol/gal-dsl/compiler.ts`：

```ts
// imports 追加
import type { AssetCatalog } from "../../assets/types.js";
import type { AssetDiagnostic, CompileEventGroupsOptions } from "./types.js"; // 现有 import 扩展

// types.ts 中 CompileEventGroupsOptions 追加：
//   catalog?: AssetCatalog;
//   diagnostics?: AssetDiagnostic[];
```

`compileEventGroup` 内（`allCues` 构建之后、`reduce` 之前）：

```ts
const filteredCues =
  options.catalog !== undefined
    ? filterInvalidCues(allCues, tailState, options.catalog, options.diagnostics)
    : allCues;
const nextState = reduce(tailState, filteredCues);

return { group: { prelude: filteredCues, main }, tailState: nextState };
```

新函数（compiler.ts 文件内）：

```ts
/**
 * 素材语义校验（spec §7）：未知 id/variant 的 cue 被丢弃（降级为保持现状），
 * 剧情继续；诊断写入 options.diagnostics。保持确定性。
 */
function filterInvalidCues(
  cues: StageCue[],
  state: VisualState,
  catalog: AssetCatalog,
  diagnostics: AssetDiagnostic[] | undefined,
): StageCue[] {
  const kept: StageCue[] = [];
  for (const cue of cues) {
    let keep = true;
    if (cue.type === "background") {
      keep = cue.assetId in catalog.backgrounds;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BACKGROUND", id: cue.assetId });
    } else if (cue.type === "bgm") {
      keep = cue.assetId in catalog.bgm;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_BGM", id: cue.assetId });
    } else if (cue.type === "sound_effect") {
      keep = cue.assetId in catalog.soundEffects;
      if (!keep) diagnostics?.push({ code: "UNKNOWN_SOUND_EFFECT", id: cue.assetId });
    } else if (
      cue.type === "character_patch" &&
      cue.variant !== undefined &&
      cue.variant.op === "set"
    ) {
      const effectiveSet =
        cue.spriteSet !== undefined && cue.spriteSet.op === "set"
          ? cue.spriteSet.value
          : state.characters[cue.character]?.spriteSet;
      const variants =
        effectiveSet !== undefined ? catalog.spriteSets[effectiveSet]?.variants : undefined;
      if (variants === undefined || !(cue.variant.value in variants)) {
        keep = false;
        diagnostics?.push({ code: "UNKNOWN_SPRITE_VARIANT", id: cue.variant.value });
      }
    }
    if (keep) kept.push(cue);
  }
  return kept;
}
```

- [ ] **Step 4: Metrics 诊断**

`src/runtime/metrics.ts`：

```ts
// imports 追加
import type { AssetDiagnosticCode } from "../core/protocol/gal-dsl/types.js";

// 类内
private readonly assetDiagnostics = new Map<string, number>();

recordAssetDiagnostic(code: AssetDiagnosticCode): void {
  this.assetDiagnostics.set(code, (this.assetDiagnostics.get(code) ?? 0) + 1);
}

assetDiagnosticCounts(): Record<string, number> {
  return Object.fromEntries(this.assetDiagnostics);
}
```

- [ ] **Step 5: game.ts compileGroup 接线**

`src/game.ts` 的 `compileGroup`（约 976 行）中 `compileEventGroup` 调用：

```ts
const diagnostics: AssetDiagnostic[] = [];
const compiled = compileEventGroup(draft, {
  registry: this.registry,
  tailState: baseState,
  reduce: this.reduce,
  defaultsFor: this.defaults.defaultFor.bind(this.defaults),
  ...(this.catalog !== undefined ? { catalog: this.catalog, diagnostics } : {}),
});
for (const diagnostic of diagnostics) {
  this.metrics.recordAssetDiagnostic(diagnostic.code);
  console.warn(`[assets] ${diagnostic.code}: ${diagnostic.id}`);
}
```

（`AssetDiagnostic` 类型 import；`this.catalog` 已有字段 `AssetCatalog | undefined`；`this.metrics` 已有。）

- [ ] **Step 6: 运行确认通过 + 全量 + typecheck**

```bash
npx vitest run src/core/protocol/gal-dsl/compiler.test.ts src/runtime/metrics.test.ts
npm run typecheck
npm test
```

- [ ] **Step 7: 提交**

```bash
git add src/
git commit -m "feat(dsl): compiler asset semantic validation with graceful degradation + metrics diagnostics"
```

---

### Task 11: main.ts 接线 + 端到端手动验收

**Files:**
- Modify: `web/src/main.ts`

**Interfaces:**
- Consumes: Task 6/7/8/9 的所有产物。
- Produces: 完整浏览器接线；手动验收清单。

- [ ] **Step 1: 接线**

`web/src/main.ts`：

```ts
import { fetchAssetManifest } from "./stage/asset-manifest-client.js";
import { BrowserAssetResolver } from "./stage/browser-asset-resolver.js";
import { BgmController } from "./stage/bgm-controller.js";
import { SoundEffectController } from "./stage/sound-effect-controller.js";

export async function boot(root?: HTMLElement | null): Promise<void> {
  const appRoot = root ?? document.getElementById("app");
  if (appRoot === null) return;

  const refs: AppDomRefs = buildAppDom(appRoot);
  const manifest = await fetchAssetManifest();
  const assetResolver = new BrowserAssetResolver(manifest);
  const stageRenderer = new StageRenderer(refs.stage, assetResolver);
  const bgmController = new BgmController(assetResolver);
  const seController = new SoundEffectController(assetResolver);
  const app = new GameApp({ wsUrl: wsUrlFromLocation(), token, bgmController });
  // ...（StartScreen onStart 内，context.resume() 之后）：
  //     bgmController.unlock(); // 手势内解锁 autoplay
  // ...（render() 的 stage 段）：
  if (visualState !== undefined && visualState !== lastVisualState) {
    lastVisualState = visualState;
    stageRenderer.apply(visualState);
    bgmController.apply(visualState.bgm);
    seController.consume(view.consumeCues());
  }
}
```

底部调用：`void boot();`

- [ ] **Step 2: 运行 web 测试 + typecheck + build**

```bash
npm run typecheck
npx vitest run web/src
npm run build
```

- [ ] **Step 3: 手动验收清单（逐项核对）**

```bash
npm run dev:web   # 或项目现有 web dev 命令；另一终端启动后浏览器打开提示的 URL
```

1. 打开页面 → 无 manifest 失败告警；Start 后舞台出现**真实背景图**（示例段若含 `bg basement`）。
2. `bgm mystery` → 听到 BGM；`bgm stop` → 停止。
3. `ch suyao:anxious right` → 立绘换 anxious 变体、右槽位。
4. `se terminal_beep` → 响一声（不写入视觉状态）。
5. 手工构造未知 id（如 `bg not_exist`）→ 背景保持、故事继续、终端 console.warn 输出 `[assets] UNKNOWN_BACKGROUND: not_exist`。
6. 音量条 / 静音按钮同时作用于语音与 BGM。
7. 刷新页面（重连）→ 舞台从 `UiProjection.visualState` 恢复，无 SE 重放。

> 注：步骤 3–6 需要一段含上述指令的 DSL 剧情；可在 `prompts/instructions.yaml` 的 opening 模板或临时测试段中输入，或直接沿用 `docs/llm-outputs-refactor.md` §110 的验收文本（把 `bg basement` 换成真实存在的 id）。

- [ ] **Step 4: 提交**

```bash
git add web/src/main.ts
git commit -m "feat(web): wire manifest + stage/BGM/SE controllers into boot and render loop"
```

---

## Self-Review

（执行者写完计划后运行，发现缺漏就地修正，不需要再征求意见。）

1. **Spec 覆盖**：§4 素材加工（T1/T2/T3）；§5 服务端（T4/T5）；§6 浏览器（T6–T9、T11）；§7 语义校验（T10）；§8 测试验收（各任务测试 + T11 清单）；§10 顺序一致。
2. **占位符扫描**：无 TBD/TODO；BGM guidance 为显式用户字段（Global Constraints 已声明），非占位符。
3. **类型一致性**：`PublicAssetManifest`（core 与 web 各自定义、结构相同）；`AssetDiagnostic`/`AssetDiagnosticCode`（types.ts 单一来源）；`BrowserAssetResolver` getter 与字段不重名（Step 3 已注明）；`StageRenderer` 构造签名变更在 T7 同步 main.ts。
