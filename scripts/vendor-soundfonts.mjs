/**
 * vendor-soundfonts — 一次性/按需重采：从 gleitz/midi-js-soundfonts 抽取
 * FluidR3_GM 按乐器包，裁剪到 BGM 实用音域（A1–C7, midi 33–96），落成
 * assets/audio/soundfonts/<palette>.json 供浏览器渲染器消费。
 *
 * 许可链：采样本体 FluidR3_GM（Frank Wen，MIT，Debian 打包记录）+
 * 抽取格式 gleitz/midi-js-soundfonts（MIT）——双署名见同目录 LICENSE.md。
 *
 * 用法：
 *   node scripts/vendor-soundfonts.mjs            # 直连 CDN（正常网络）
 *   node scripts/vendor-soundfonts.mjs <srcDir>   # 转换已下载的 <gmName>-mp3.js
 *                                                 #（代理网络先 curl 下载）
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "assets", "audio", "soundfonts");
const CDN = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM";

/** 调色板 → GM 乐器名（MusicInstrument 枚举的采样映射单一真源）。 */
const PACKS = {
  piano: "acoustic_grand_piano",
  strings: "string_ensemble_1",
  pad: "pad_2_warm",
  bass: "acoustic_bass",
  bell: "music_box",
  choir: "choir_aahs",
};

const NOTE_OFFSETS = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const MIDI_MIN = 33; // A1（bass 低限）
const MIDI_MAX = 96; // C7（bell 高限）

function noteNameToMidi(name) {
  const match = /^([A-G][b#]?)(-?\d+)$/.exec(name);
  if (match === null) return null;
  const offset = NOTE_OFFSETS[match[1]];
  if (offset === undefined) return null;
  return (Number(match[2]) + 1) * 12 + offset;
}

function parseGleitzPack(text, gmName) {
  // gleitz 文件：两行 if 前缀 + `MIDI.Soundfont.<name> = {…键值对…};`
  // 对象字面量允许尾逗号，JSON 不允许——剥掉再解析。
  const match = new RegExp(`MIDI\\.Soundfont\\.\\w+\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$`).exec(text);
  if (match === null) throw new Error(`${gmName}: 内容不是预期的 gleitz 格式`);
  const parsed = JSON.parse(match[1].replace(/,\s*([}\]])/g, "$1"));
  const out = {};
  let kept = 0;
  for (const [note, dataUri] of Object.entries(parsed)) {
    const midi = noteNameToMidi(note);
    if (midi === null || midi < MIDI_MIN || midi > MIDI_MAX) continue;
    out[midi] = dataUri;
    kept += 1;
  }
  return { out, kept, total: Object.keys(parsed).length };
}

async function loadPackText(gmName, srcDir) {
  if (srcDir !== undefined) {
    return readFile(path.join(srcDir, `${gmName}-mp3.js`), "utf8");
  }
  const url = `${CDN}/${gmName}-mp3.js`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

const srcDir = process.argv[2];
await mkdir(OUT_DIR, { recursive: true });
console.log(`输出目录：${OUT_DIR}`);
for (const [palette, gmName] of Object.entries(PACKS)) {
  const { out, kept, total } = parseGleitzPack(await loadPackText(gmName, srcDir), gmName);
  const file = path.join(OUT_DIR, `${palette}.json`);
  await writeFile(file, JSON.stringify(out));
  const sizeMb = ((await stat(file)).size / 1048576).toFixed(1);
  console.log(`${palette} ← ${gmName}: ${kept}/${total} 音符（A1–C7），${sizeMb}MB`);
}
