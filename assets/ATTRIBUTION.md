# 素材来源与授权

## 树莓娘（raspberry，campus 分支专用）——仅限内部流通
- 分层原稿：`raw/DAnew_version/DAnew_version.psd`（2026-09 由项目负责人提供），
  导出差分与图层映射见 `raw/DAnew_version/README.md`。
- **约定（2026-09-15 起）：树莓娘的所有资产——原稿 PSD、导出差分、后续任何
  正式立绘/衍生图——不得上传到任何渠道（git 提交/推送、公开网盘链接、外部
  在线服务等），只能通过直接复制文件在内部流通**，以规避素材授权与泄露问题。
- `.gitignore` 已排除 `assets/characters/raspberry/` 与 `assets/raw/`；
  严禁 `git add -f` 这两类路径。
- 当前立绘成品（`assets/characters/raspberry/` 下 base + 18 表情差分 +
  mysterious_silhouette 剪影，2026-09-15）：以分层原稿的官方基准图为底，
  经自配图像生成 API 蓝幕改图、本地色键去蓝 + despill 管线加工产出
  （管线记录见 `output/image-gen/raspberry-diff/manifest.json`，该目录同样不入库）；
  已获项目负责人授权，仅限内部流通。
- 新机器/新环境：从内部联系人处直接复制资产文件到上述目录后立绘才可用。

## 自制 AI 通用角色立绘（female_A/female_B/male_A/male_B，campus 分支专用）——仅限内部流通
- 2026-09-15 由 `scripts/gen-cast-bases.mjs` 批量生成：以树莓娘官方基准图的
  API 加工成品（calm.png）为画风与比例参考（该参考图的使用已获项目负责人
  授权），经自配图像生成 API 蓝幕整图 edit + 本地全局色键去蓝 + despill
  管线产出；角色本身为原创设计，不包含真实人物或第三方素材内容。
- 每角色 4 张：`base`（基准，默认变体）+ `smile`/`surprised`/`embarrassed`
  表情差分；产出源与管线记录在 `output/image-gen/cast/manifest.json`
  （该目录不入库）。
- **约定：同树莓娘——不入库、不上传，只能直接复制文件在内部流通**；
  `.gitignore` 已排除 `assets/characters/{female_A,female_B,male_A,male_B}/`，
  严禁 `git add -f` 这些路径。
- 新机器/新环境：从内部联系人处直接复制四个角色目录后立绘才可用。

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
