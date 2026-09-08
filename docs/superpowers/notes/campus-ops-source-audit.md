# 校园运维分支基线与来源审计（2026-09-08 复核）

## 1. 基线记录

- 分支：`feat/campus-ops-raspberry`（自 `main` = `3743ba8 feat: add session persistence restore` 创建）。
- 工作区既有改动（用户所有，不清理、不混入功能提交）：
  - `.gitignore`（`sessions/*.jsonl` → `sessions/*`）；
  - `docs/superpowers/plans/2026-09-06-campus-ops-event-redesign.md`（未跟踪）；
  - `docs/superpowers/specs/2026-09-06-campus-ops-event-design.md`（未跟踪）。
- 基线测试：`npm test`、`npm run typecheck`、`npm run build` 在实现前于 `3743ba8` 已通过（上一会话记录）；本次实现完成后重新全量验证。

## 2. BITNP 来源与授权状态（2026-09-08 经 `gh api` 复核）

| 仓库 | 可见性 | License (SPDX) | 最近 commit（复核时） | 关键内容 |
|---|---|---|---|---|
| `BITNP/bitnp-ai-vtuber` | 公开 | **无** | `f65f4ee` (2026-03-16) | README 定义树莓娘为网协看板娘；公开 prompt：兔耳、粉色连衣裙、参与面试/技术分享 |
| `BITNP/bitnp-desktop-pet` | 公开 | **无** | `0b98b35` (2026-02-01) | 基本相同的树莓娘 prompt + 桌宠前端 |
| `BITNP/bitnpResource` | 公开 | **无** | `de75cca` (2022-11-01) | 树莓 logo、技术部 logo、电脑诊所 logo |
| `BITNP/bitnp-design` | 公开 | **无** | `bbd047c` (2025-09-17) | 网协主题色 `#da751d`；`徽章/2024/树莓娘-粉/紫/蓝.png`；Clinic 设计资料 |
| `BITNP/bitnp-raspberrygirl-vtuber-frontend` | **私有**（当前账号可读） | **无** | `87470d1` (2026-08-09) | `raspberry_girl.tscn`、分层部件 |

### 结论

1. 五个仓库均**未发现标准开源许可证**。公开可见 ≠ 可复制/再分发；任何素材接入需项目所有者明确授权。
2. 私有 frontend 仓库的分层部件、Godot 场景、Live2D 资源**一律不复制**。
3. 文字事实（看板娘身份、兔耳、粉色服装语境、参与面试/技术分享）可引用为“已核对事实”；性格细节（温柔、傲娇等）只能作为本分支演绎，不宣称官方。
4. 本分支当前素材策略：**text-only / 本项目自制占位图**；组织 logo、徽章一律不打包，状态记为“待授权”。

### 授权问题清单（待确认）

- [ ] 树莓娘立绘 / Live2D 素材是否可获得明确授权（源仓库、允许用途、是否可再分发）。
- [ ] `bitnpResource` / `bitnp-design` 中的组织 logo、徽章可否用于本项目构建与现场展示。
- [ ] 树莓娘官方音色（如后续需要 TTS）。

以上任一项未确认前，正式 catalog 不引用对应资源。
