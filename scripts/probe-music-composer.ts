import "dotenv/config";
/**
 * probe-music-composer — 主题制作曲家决策流的真实链路验证（V2，可常驻
 * scripts/ 作回归工具）：真实 BigModel 调用 × 真实 skill/prompt × 真实
 * ComposerDecisionSchema 校验 × 真实 MusicThemeStore/ComposerSessionStore，
 * 连打两轮 brief 验证 compose（空目录）与 reuse（同区域重访）两分支。
 *
 * 用法：
 *   npx tsx scripts/probe-music-composer.ts [mood] [intensity] [note] [--save=谱面路径]
 * 第一轮 = 全新区域（空目录，期望 compose 首个主题）；第二轮 = 同一区域
 * 昼间重访（期望 reuse 同一主题）。--save 落盘首轮谱面（试听页 file picker）。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { loadConfig, loadApiKey } from "../src/config.js";
import { ComposerDecisionSchema, extractMotifHint, themeScoreStats } from "../src/shared/music/theme.js";
import type { SceneMusicBrief } from "../src/shared/music/theme.js";
import { SceneMusicComposerAdapter } from "../src/adapters/llm/scene-music-composer-adapter.js";
import { MusicThemeStore } from "../src/adapters/storage/music-theme-store.js";
import { ComposerSessionStore } from "../src/adapters/storage/composer-session-store.js";
import { COMPOSER_SESSION_WINDOW_TURNS } from "../src/shared/music/theme.js";

const mood = (process.argv[2] ?? "tense") as SceneMusicBrief["mood"];
const intensity = (process.argv[3] ?? "2") as SceneMusicBrief["intensity"];
const note = process.argv[4] ?? "夜巡地下堡垒：金属回响压迫，低音缓行，远处机械律动";
const flag = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const savePath = flag("save");

const config = await loadConfig("config.yaml");
const apiKey = loadApiKey(config);
const adapter = new SceneMusicComposerAdapter({ apiKey, api: config.api });

// 临时游戏目录：主题目录/谱面/作曲家会话全链真实落盘（探针自包含，
// 不污染真实 games/）。
const root = await mkdtemp(tmpdir() + "/probe-music-v2-");
const themes = new MusicThemeStore(root, "probe");
const session = new ComposerSessionStore(root, "probe");

async function round(label: string, brief: SceneMusicBrief): Promise<void> {
  const started = Date.now();
  const catalog = [];
  for (const meta of await themes.listThemes()) {
    const score = await themes.getScore(meta.id);
    if (score !== undefined) catalog.push({ meta, stats: themeScoreStats(score) });
  }
  const turns = await session.readRecent(COMPOSER_SESSION_WINDOW_TURNS);
  const decision = await adapter.decide({ brief, catalog, sessionTurns: turns });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // 双保险：适配器已校验，探针自身再过一次 schema。
  const checked = ComposerDecisionSchema.safeParse(decision);
  console.log(`\n===== ${label}（${elapsed}s，目录 ${catalog.length} 主题）=====`);
  console.log(`brief: sceneId=${brief.sceneId} mood=${brief.mood} intensity=${brief.intensity} note=${brief.note}`);
  if (decision === null) {
    console.log("✗ 决策失败（两次输出均未过契约）");
    process.exitCode = 1;
    return;
  }
  console.log(`✓ schema 复验=${checked.success ? "PASS" : "FAIL"} decision=${decision.action} reason=${decision.reason}`);
  if (decision.action === "reuse") {
    const score = await themes.getScore(decision.themeId);
    console.log(`  reuse 主题=${decision.themeId}${score === undefined ? "（⚠ 目录中无谱面——服务层将告警不发布）" : ""}`);
    await themes.bindScene(brief.sceneId, decision.themeId);
    await session.append({ role: "user", content: JSON.stringify(brief) });
    await session.append({
      role: "assistant",
      content: JSON.stringify({ action: "reuse", themeId: decision.themeId, reason: decision.reason }),
    });
    return;
  }
  const { theme, score } = decision;
  const motifHint = extractMotifHint(score);
  console.log(
    `  compose 主题=${theme.id}《${theme.title}》：${theme.concept}` +
      `${theme.style !== undefined ? `｜style=${theme.style}` : ""}` +
      `${theme.parentTheme !== undefined ? `｜parent=${theme.parentTheme}` : ""}`,
  );
  console.log(
    `  谱面：${score.bpm}bpm key=${score.key} mode=${score.mode} bars=${score.bars} ` +
      `循环=${((score.bars * 4 * 60) / score.bpm).toFixed(1)}s 总音符=${score.tracks.reduce((s, t) => s + t.notes.length, 0)}`,
  );
  console.log(`  motifHint=${motifHint ?? "（无可提取旋律轨）"}`);
  for (const track of score.tracks) {
    console.log(
      `    ${track.instrument.padEnd(8)} gain=${track.gain.toFixed(2)} notes=${track.notes.length}`,
    );
  }
  await themes.putScore(theme.id, score);
  await themes.addTheme(
    { ...theme, ...(motifHint !== undefined ? { motifHint } : {}) },
    { sceneId: brief.sceneId },
  );
  await session.append({ role: "user", content: JSON.stringify(brief) });
  await session.append({
    role: "assistant",
    content: JSON.stringify({
      action: "compose",
      themeId: theme.id,
      reason: decision.reason,
      stats: `${score.bpm}bpm mode=${score.mode}`,
    }),
  });
  if (savePath !== undefined) {
    await writeFile(savePath, `${JSON.stringify(score, null, 2)}\n`, "utf8");
    console.log(`  已保存谱面 → ${savePath}`);
  }
}

// 第一轮：全新区域（空目录 → 必 compose）。
await round("第一轮 · 夜访（期望 compose）", {
  sceneId: "fortress-night",
  sceneGoal: "主角夜访废弃地下堡垒，机械残响与压迫感",
  mood,
  intensity,
  note,
});
// 第二轮：同一区域昼间重访（目录非空 → 期望 reuse）。
await round("第二轮 · 昼访（期望 reuse）", {
  sceneId: "fortress-day",
  sceneGoal: "白天重返同一堡垒外围勘察，白昼下的同一片废墟",
  mood: "mysterious",
  intensity: 1,
  note: "同一堡垒的昼间勘察：静谧、空旷、微光",
});

console.log(`\n主题目录：${root}/probe/music/themes.json（临时目录，探针自包含）`);
