#!/usr/bin/env node
/**
 * 仓库卫生机械检查（docs/skills/repo-hygiene/SKILL.md §A）。
 *
 * 只做无判断的检查：文件行数阈值（源码/测试/文档分开校准）与临时标记
 * 扫描。结构类检查（函数长度、嵌套、冗余、防御过度、补丁叠加）由
 * SKILL §B 的 subagent 评审承担——不要试图用脚本猜这些。
 *
 * 用法：node scripts/hygiene-check.mjs [--print-topo]
 * 退出码：0 = 通过；1 = 有超限违规。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 阈值（与 SKILL.md §A 保持一致；校准于 2026-09-16 基线）。
const LIMITS = {
  source: { warn: 600, fail: 900 }, // src/web 非 .test.ts
  test: { warn: 1000, fail: 1500 }, // *.test.ts
  doc: { warn: 600, fail: 900 }, // docs 与根目录 .md
};

// 既有豁免：只登记"有历史原因 + 有清偿任务"的文件。新文件不得进此清单。
const ALLOWLIST = {
  "src/game.ts": "M4.5 拆分卡（执行清单）已有拆分目标 ~1500 行",
  "src/application/narrative/narrative-director-service.test.ts":
    "MA-A 任务卡含沿子系统缝拆分（执行清单）",
  "docs/llm-outputs-refactor.md": "冻结的协议规范总档（按 § 追加，不拆分）",
  "docs/superpowers/plans/2026-08-08-asset-pipeline-browser.md": "已结项的历史执行记录",
  "docs/novel-skill/": "外部参考素材，非本项目维护",
};

const SCAN_DIRS = ["src", "web/src", "docs", "scripts"];
const MARKER_RE = /\b(TODO|FIXME|HACK)\b/g;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

function category(relPath) {
  const p = relPath.replaceAll("\\", "/");
  if (p.endsWith(".test.ts")) return "test";
  if (p.endsWith(".ts")) return "source";
  if (p.endsWith(".md")) return "doc";
  return null;
}

function exemption(relPath) {
  const p = relPath.replaceAll("\\", "/");
  for (const [prefix, reason] of Object.entries(ALLOWLIST)) {
    if (p === prefix || p.startsWith(prefix)) return reason;
  }
  return null;
}

const files = [];
for (const dir of SCAN_DIRS) files.push(...(await walk(path.join(ROOT, dir))));
files.push(path.join(ROOT, "TODO.md"), path.join(ROOT, "README.md"), path.join(ROOT, "DESIGN.md"));

const violations = [];
const warnings = [];
const sizes = [];
let markers = 0;

for (const abs of files) {
  const rel = path.relative(ROOT, abs);
  const cat = category(rel);
  if (cat === null) continue;
  const info = await stat(abs);
  const text = await readFile(abs, "utf8");
  const lines = text.split("\n").length;
  sizes.push({ rel, cat, lines });
  markers += (text.match(MARKER_RE) ?? []).length;

  const limit = LIMITS[cat];
  const exempt = exemption(rel);
  if (lines > limit.fail && !exempt) {
    violations.push(`${rel}: ${lines} 行 > ${limit.fail}（${cat}）`);
  } else if (lines > limit.fail && exempt) {
    warnings.push(`${rel}: ${lines} 行（豁免：${exempt}）`);
  } else if (lines >= limit.warn && !exempt) {
    warnings.push(`${rel}: ${lines} 行，接近 ${limit.fail} 阈值（${cat}）`);
  }
}

sizes.sort((a, b) => b.lines - a.lines);
console.log("== 最大的 10 个文件 ==");
for (const s of sizes.slice(0, 10)) {
  console.log(`  ${String(s.lines).padStart(5)}  ${s.rel}  (${s.cat})`);
}
console.log(`\nTODO/FIXME/HACK 标记总数：${markers}（不得比上一卫生门增加）`);
if (warnings.length > 0) {
  console.log("\n== 提醒 ==");
  for (const w of warnings) console.log(`  ${w}`);
}
if (violations.length > 0) {
  console.log("\n== 违规（必须修复或登记豁免+清偿任务）==");
  for (const v of violations) console.log(`  ${v}`);
  process.exit(1);
}
console.log("\n卫生机械检查通过。");
