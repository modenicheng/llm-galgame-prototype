import "dotenv/config";
/**
 * probe-music-composer — 动态音乐生成真实链路验证（一次性探针，可常驻
 * scripts/ 作回归工具）：真实 BigModel 调用 × 真实作曲 prompt × 真实
 * MusicScoreSchema 校验，打印谱面统计。用法：
 *   npx tsx scripts/probe-music-composer.ts [mood] [intensity] [note]
 */
import { loadConfig, loadApiKey } from "../src/config.js";
import { MusicScoreSchema } from "../src/shared/music/score.js";
import { SceneMusicComposerAdapter } from "../src/adapters/llm/scene-music-composer-adapter.js";
import { musicCacheKey } from "../src/application/audio/music-cache-key.js";
import type { SceneMusicDirection } from "../src/shared/music/score.js";

const mood = (process.argv[2] ?? "tense") as SceneMusicDirection["mood"];
const intensity = (process.argv[3] ?? "2") as SceneMusicDirection["intensity"];
const note = process.argv[4];

const config = await loadConfig("config.yaml");
const apiKey = loadApiKey(config);
const adapter = new SceneMusicComposerAdapter({ apiKey, api: config.api });

const started = Date.now();
const score = await adapter.compose({
  sceneId: "probe_scene",
  sceneGoal: "雨夜天台对峙：主角揭穿搭档的谎言，关系濒临破裂",
  direction: { mood, intensity, ...(note !== undefined ? { note } : {}) },
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (score === null) {
  console.error(`✗ 作曲失败（两次尝试均未过契约），耗时 ${elapsed}s`);
  process.exit(1);
}
// 双保险：适配器已校验，这里再过一次 schema（探针自身正确性）。
const checked = MusicScoreSchema.safeParse(score);
console.log(`✓ 作曲成功，耗时 ${elapsed}s，schema 复验=${checked.success ? "PASS" : "FAIL"}`);
console.log(
  `bpm=${score.bpm} key=${score.key} mode=${score.mode} bars=${score.bars} ` +
    `循环=${((score.bars * 4 * 60) / score.bpm).toFixed(1)}s ` +
    `cacheKey=${musicCacheKey(score)}`,
);
for (const track of score.tracks) {
  const midis = track.notes.map((n) => n.midi);
  console.log(
    `  ${track.instrument.padEnd(8)} gain=${track.gain.toFixed(2)} notes=${track.notes.length} ` +
      `音域=${Math.min(...midis)}~${Math.max(...midis)} ` +
      `拍域=0~${Math.max(...track.notes.map((n) => n.beat)).toFixed(1)}`,
  );
}
const total = score.tracks.reduce((sum, t) => sum + t.notes.length, 0);
console.log(`总音符 ${total}；首个音符 beat=${score.tracks[0]!.notes[0]!.beat}`);
