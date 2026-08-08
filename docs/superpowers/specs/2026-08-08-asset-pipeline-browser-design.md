# 资源管线接通浏览器（逻辑 ID → URL → 真实渲染）设计

日期：2026-08-08
状态：已获用户逐节确认（第 1–5 节）

## 1. 背景与目标

DSL 重构（`docs/llm-outputs-refactor.md`）已完成：`resources.yaml → AssetCatalog → DSL → StageCue → VisualState → RuntimeOutput.presentation → UiProjection.visualState → GameViewModel → StageRenderer` 的链路已通，但 `StageRenderer` 仍是占位实现（HSL 色块背景、色块立绘、`data-bgm` 属性），且 `AssetResolver`（逻辑 ID → src）从未接入生产链路。

本轮目标：把 **逻辑资源 ID → 浏览器可访问 URL → 真实图片/音频渲染** 最后一段接通。背景、立绘、BGM、SE 全部端到端可用；媒体错误不阻断剧情。

**不推倒现有架构**：Core、DSL、缓冲、分支预生成不动。不发明 MediaManager/新表现协议。

## 2. 边界原则

Core 与模型只见逻辑 ID；浏览器见受控 URL；绝对路径 / `http://127.0.0.1:*` / `blob:` / `file://` 永不进入 Core 或模型输出。

```
LLM → 逻辑 id → Core/VisualState → 逻辑 id → 浏览器
                                                ├─ AssetManifest（id → /game-assets/... URL）
                                                ├─ DOM 渲染 / <audio> 播放
```

资源未来可来自本地文件、IndexedDB、生图模型或远程 CDN，均不影响剧情 Core。

## 3. 现状审计结论（已验证）

| 问题 | 状态 |
|---|---|
| 实体资源不存在 | `assets/` 仅 `resources.yaml`；用户已在 `assets/raw/` 提供真实素材（见 §4） |
| 浏览器无资源 Manifest | 只有逻辑 ID，不知道 `basement → 哪个文件` |
| Node 无资源路由 | `LocalWebHost` 只服务 `dist/web`、WS、config、TTS API |
| `AssetResolver` 未接生产链 | 仅在 catalog/tests 出现 |
| 无语义资源校验 | DSL parser 只查语法，`bg 不存在_id` 仍进入状态 |
| `config.yaml` 拼写错误 | `essets:`，schema 实际字段 `assets`（恰好落到同默认值，改路径会静默失效） |
| `GameViewModel` 丢弃 `presentation.cues` | 只存 `visualState`，SE cue 到浏览器前丢失 |

## 4. 素材加工与目录系统

### 4.1 素材现状（assets/raw/）

- `josei_03_shirowanpi.zip`、`josei_12_china.zip`：わたおきば（wataokiba.net）女性角色立绘各 9 张（base + a–h），PNG。授权允许商用/非商用（禁再分发、禁虚假作者声明）。README 未说明各字母表情含义，需看图命名。
- 10 张背景 jpg：アジト×2（照明 ON/OFF）、学校の廊下×4（日中/夕方/夜ON/夜OFF）、文化系の部室×4（同）。
- 3 首 BGM mp3（时长约 134–142s）：文件名自述 relax / soft-calm / mountain。

### 4.2 加工流程（实现阶段执行）

1. `7z` 解压两个立绘压缩包到临时区；原始压缩包保留在 `assets/raw/` 作 provenance。
2. **视觉子代理（mimo-v2.5）** 产出命名 + 详细描述：
   - 两个立绘集各 9 个表情 → 英文语义化 variant id（如 `normal`/`happy`/`angry`/`surprised`…）+ 外观/表情/使用时机描述（写入 `resources.yaml` 的 `description`，供模型选表情）。
   - 10 张背景 → 英文 id（`hallway_day`/`clubroom_night_on`/`hideout_on`…）+ 描述。
   - 3 首 BGM → 英文 id 由主代理按文件名与元数据提出；`resources.yaml` 中每首 BGM 的详细 `description`/guidance（节奏、情绪基调、适用场景、与其它 BGM 的区分度）由**用户亲自撰写**（子代理不做听音分析）。
   - 角色↔立绘集映射（如旗袍装 ↔ 苏遥）由子代理描述 + 主代理直接定夺写入；据此决定 `placeholder_char` 去留。**无需用户确认**。
3. 主代理汇总报告，生成最终目录结构与 `resources.yaml`。

### 4.3 目录系统

```
assets/
├── resources.yaml        # 唯一权威逻辑目录（Core/模型只见此）
├── ATTRIBUTION.md        # 素材来源与授权记录（わたおきば、BGM 来源）
├── raw/                  # 原始下载原封不动（zip/jpg/mp3，provenance）
├── backgrounds/          # 10 张英文 id（jpg 原格式）
├── characters/
│   └── <sprite_set_id>/  # 每角色一目录，9 个表情变体（png 原格式）
└── audio/
    ├── bgm/              # 3 首 mp3（原格式）
    └── se/               # ffmpeg 合成 terminal_beep（占位音效）
```

关键决策：
- **格式保留原样**（jpg/png/mp3 不二次转码，避免有损；浏览器原生支持）；webp/ogg 转换留作可选优化（非本轮）。
- **git LFS**：`.gitattributes` 标记 `*.png *.jpg *.webp *.ogg *.mp3 *.zip` 走 LFS（已装 git-lfs 3.7.1）；素材 ~40MB 不膨胀 git 仓库。
- **gitignore 调整**：TTS 缓存目录从 `assets/audio/` 迁到 `assets/.tts-cache/`（`config.output_dir` 默认值同步改，gitignore `assets/.tts-cache/*`）；BGM/SE 归入 `assets/audio/{bgm,se}` 正常入库，避免现有 `assets/audio/*` 规则误杀。
- 立绘统一规格：同高宽、脚底基准对齐（わたおきば 全身图），前端只需定位五槽位。

## 5. 服务端接线

### 5.1 修 config + 启动校验

- `config.yaml`：`essets:` → `assets:`；`output_dir` 默认 `assets/.tts-cache`。
- `loadAssetCatalog()` 增强（失败即报错阻断，错误信息点名文件）：
  - `characters.*.sprite_set` 必须存在于 `sprite_sets`；
  - `characters.*.default_variant` 必须存在于该 sprite_set；
  - 所有 `src` 相对路径、不得逃逸素材根目录、文件必须真实存在。

### 5.2 `GET /api/assets/manifest`

- 新类型 `PublicAssetManifest`：`{ backgrounds, bgm, soundEffects, spriteSets }`，每项 `id → { url }`，URL 形如 `/game-assets/backgrounds/hallway_day.jpg`。
- Node 只投影受控 URL，绝不暴露绝对路径。
- 浏览器启动时请求一次；失败/404 → 回退占位渲染。

### 5.3 `GET /game-assets/*` 静态路由

- 素材根 = `resources.yaml` 所在目录。
- 穿越防护：`path.resolve` + `startsWith(assetRoot + path.sep)`，`../`、`%2e%2e`、绝对路径 → 403（复用 `serveFile` 模式）。
- MIME 表补 `.webp/.png/.jpg/.jpeg/.ogg/.mp3/.wav`。
- dev（Vite middleware）与 prod 均走 `handleRequest` 分发。

## 6. 浏览器接线

### 6.1 AssetManifestClient + BrowserAssetResolver

- 启动时拉一次 manifest；失败 → resolver 全返回 `undefined`。
- `resolveBackground/resolveBgm/resolveSprite/resolveSoundEffect(id…) → URL | undefined`，纯映射。

### 6.2 Keyed StageRenderer（替换 clearChildren 全量重绘）

- 背景：持久 `<img>`，切换时 decode 完成后 crossfade 换源。
- 角色：`Map<characterId, HTMLImageElement>`——首次出现建节点；variant 变只换 `src`；position 变只换 slot class；visible 变只改 opacity/hidden。
- CSS 五槽位（`--far_left/left/center/right/far_right`），立绘统一 `height:92%` 脚底对齐。
- resolver 无 URL 时回退现有色块占位（保留 `deterministicHue`）。

### 6.3 BgmController（薄封装，不走 TTS PCM 管线）

- `<audio loop>`，观察 `visualState.bgm`；`undefined`（含 `bgm stop`，已在 Core reducer 转成 undefined）即暂停。
- **autoplay 解锁**：Start 按钮手势内 `unlock()`（创建元素 + load + play→pause），避免首曲被浏览器策略拦截。
- 音量/静音：`GameApp.setVolume/setMuted` 同时驱动 TTS `AudioCoordinator` 与 `BgmController`（主音量共用；未来可拆 master/voice/bgm/se）。

### 6.4 SoundEffectController + cue 透传修复

- `GameViewModel` 不再丢弃 `presentation.cues`：暂存 transient 字段，`consumeCues()` 一次性取走（避免重渲染重放）。
- `SoundEffectController` 消费 cues 中 `sound_effect`：一次性 `<Audio>` 播放；**不写入 VisualState**；重连不重放（瞬态语义）。

### 6.5 接线

`main.ts` render 循环：`stageRenderer.apply(view.visualState)` + `bgmController.apply(view.visualState.bgm)` + `seController.consume(view.consumeCues())`。

## 7. 语义校验与降级

两层校验：
1. **启动校验**（§5.1）：YAML 交叉引用 + 文件存在，失败阻断。
2. **Compiler 语义校验**：模型引用的资源必须存在于目录：
   - `bg id` → `backgrounds[id]`；`bgm id` → `bgm[id]`；`se id` → `soundEffects[id]`；
   - 角色 variant → 当前 spriteSet 下存在。

降级策略（媒体错误不阻断剧情，保持确定性——同一输入同一输出）：

| 错误 | 降级行为 |
|---|---|
| 未知背景/BGM/SE id | 丢弃该 cue，保持当前状态，文本照常 |
| 未知立绘 variant | 丢弃该 patch（=keep），保持当前立绘，文本照常 |

诊断通道：`Metrics` 计数（`UNKNOWN_BACKGROUND`/`UNKNOWN_BGM`/`UNKNOWN_SOUND_EFFECT`/`UNKNOWN_SPRITE_VARIANT`）+ `console.warn`；不新增 RuntimeOutput 类型，不新增 UI 展示（首版）。实现于 compiler：增加 catalog 引用校验，无效 cue 在 prelude 过滤并记录。

## 8. 测试与验收

### 8.1 新增测试

- loader 校验错误信息（缺文件/交叉引用/路径逃逸）。
- manifest 端点 + `/game-assets` 路由（穿越 403、MIME、404、HEAD）。
- BrowserAssetResolver 纯映射。
- StageRenderer keyed 更新（happy-dom：换 variant 不重建节点、position class、visible、占位回退）。
- BgmController 状态驱动（fake audio）；SoundEffectController；VM `consumeCues()` 一次性。
- compiler 语义校验 + 4 种 UNKNOWN_* 降级。

### 8.2 验收标准

模型输出 `bg basement` → 浏览器显示真实背景图；`bgm mystery` → 播放；`ch suyao:anxious right` → 立绘换 anxious 变体并移至右槽；`beat` → 无视觉变化；`se terminal_beep` → 响一声；`bg not_exist` → 背景保持、故事继续、诊断记录。

手动验收：启动 host → 浏览器 `/` → Start → 真实素材全流程播放。

## 9. 明确不做（Non-goals）

- 不发明 MediaManager / 新表现协议；不引入新的 VisualState 权威源（`VisualState.characters` 就是立绘唯一权威状态）。
- 不把 BGM/SE 接入 TTS PCM/AudioWorklet 管线。
- 不把 SE 写入 VisualState。
- 不做 webp/ogg 批量转码（可选优化）。
- 不改剧情 Core / DSL / 缓冲 / 分支预生成。
- 不新增 RuntimeOutput 类型或 UI 诊断展示。

## 10. 实施顺序

1. 素材加工（解压 → mimo-v2.5 子代理命名与描述 → 目录整理 → resources.yaml 重写 → ATTRIBUTION.md → LFS/.gitattributes/gitignore）。
2. 服务端：config 修复 + loader 启动校验 + manifest 端点 + `/game-assets` 路由 + MIME。
3. 浏览器：AssetManifestClient/BrowserAssetResolver → keyed StageRenderer → BgmController（含 autoplay 解锁与音量接线）→ VM cue 透传 + SoundEffectController。
4. Compiler 语义校验与降级。
5. 测试补齐 + 手动验收。
