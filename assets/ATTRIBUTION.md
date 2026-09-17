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

## 自制 AI 通用角色立绘（female_A/female_B/male_A/male_B，campus 分支专用）——AI 原创，随仓库分发
- 2026-09-15 由 `scripts/gen-cast-bases.mjs` 批量生成：以树莓娘官方基准图的
  API 加工成品（calm.png）为画风与比例参考（该参考图的使用已获项目负责人
  授权），经自配图像生成 API 蓝幕整图 edit + 本地全局色键去蓝 + despill
  管线产出；角色本身为原创设计，不包含真实人物或第三方素材内容。
- 2026-09-18 全套重绘（同管线、同参考图授权）：对齐树莓娘头身比（头大萌系
  比例），每角色一个标志性站姿（许晚晴双手身前交握 / 林小满抬手挥手 /
  夏一鸣双手插兜 / 韩澈左手夹书）；每角色 8 张：`base`（基准，默认变体）+
  `smile`/`surprised`/`embarrassed`/`joyful`/`angry`/`thinking`/`smug` 表情
  差分；realcugan 2x 超分（2304×3968）。产出源与管线记录在
  `output/image-gen/cast/manifest.json`（output/ 产出目录仍不入库）。
- **约定（2026-09-15 项目负责人确认）：四个角色目录随仓库提交、分发**，
  与树莓娘的"仅限内部流通"约定不同——本项目产出为 AI 原创内容，无第三方
  授权负担；如后续加入仿照真实人物或第三方素材的设计，须先更新本节。

## 真实照片风格化背景——内部实拍，AI 风格化重绘，随仓库分发
- 以项目成员实拍的校园照片为底，经自配图像生成 API（gpt-image 系 `edit`，
  `input_fidelity: high`，构图 1:1 保留仅换渲染风格）产出：
  - `wencui_corridor_*`：文萃楼走廊实拍（2026-09 上旬，管线脚本
    `output/wencui_corridor.mts`）；
  - `campus_road_*` / `club_plaza_*`：校园林荫道与社团文化广场实拍
    （2026-09，脚本 `output/campus_bgs.mts`）；
  - `classroom_*`：阶梯教室实拍（2026-09-17）。制作时先按世界竖直参照
    （黑板框/讲台棱/窗帘边，Theil-Sen 拟合）测得画面滚转约 -4.5° 并旋转校正，
    再裁 16:9，之后才送风格化（测量 `output/measure_tilt*.py`，
    生成脚本 `output/classroom_bgs.mts`）。
- 照片均为项目内部拍摄，无第三方版权；重绘产出为 AI 原创内容，随仓库分发。
- 照片源与生成 PNG 等中间产物留在 `output/`（不入库）。

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
