/**
 * 配乐试听页入口（/music-demo.html）——生产渲染器 SoundfontMusicRenderer
 * 的独立听感工具。谱面来源：内置基线 fixture（真实 glm-5.3-flash 作曲，
 * 渲染器改版的 A/B 基线）或 file picker 载入的谱面 JSON（probe
 * --save 产物，过 MusicScoreSchema 校验）。渲染 → WAV blob → <audio> 循环
 * 播放（与 BgmController 同一循环体，含尾部折叠）。
 */
import { MusicScoreSchema, type MusicScore } from "@shared/music/score.js";
import {
  SoundfontMusicRenderer,
  audioBufferToWavBlob,
  loopSeconds,
} from "./audio/music-renderer.js";
import { DEMO_SCORES } from "./audio/demo-scores.js";

const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MODE_NAMES: Record<MusicScore["mode"], string> = {
  major: "大调",
  minor: "小调",
  dorian: "多利亚",
};

function scoreMeta(score: MusicScore): string {
  const tracks = score.tracks
    .map((t) => `${t.instrument}×${t.notes.length}`)
    .join(" ");
  const total = score.tracks.reduce((sum, t) => sum + t.notes.length, 0);
  return (
    `${score.bpm} bpm · ${PITCH_NAMES[score.key] ?? "?"} ${MODE_NAMES[score.mode]} · ` +
    `${score.bars} 小节 · 循环 ${loopSeconds(score).toFixed(1)}s · ${tracks}（共 ${total} 音符）`
  );
}

interface PendingTrack {
  label: string;
  score: MusicScore;
}

const renderer = new SoundfontMusicRenderer();
const player = document.getElementById("player") as HTMLAudioElement;
const statusEl = document.getElementById("status") as HTMLElement;
const fixturesEl = document.getElementById("fixtures") as HTMLElement;
const fileMetaEl = document.getElementById("fileMeta") as HTMLElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;

let currentUrl: string | undefined;
let rendering = false;
const playButtons = new Set<HTMLButtonElement>();

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function replayUrl(url: string): void {
  if (currentUrl !== undefined) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  player.src = url;
  void player.play();
}

async function playTrack(track: PendingTrack, activeEl?: HTMLElement): Promise<void> {
  if (rendering) return;
  rendering = true;
  document.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  for (const b of playButtons) b.classList.remove("playing");
  document.querySelectorAll(".track").forEach((el) => el.classList.remove("active"));
  activeEl?.classList.add("active");
  try {
    setStatus(`渲染中… ${track.label}（首次含采样包加载，约数秒）`);
    const buffer = await renderer.render(track.score);
    const blob = audioBufferToWavBlob(buffer);
    const url = URL.createObjectURL(blob);
    replayUrl(url);
    for (const b of playButtons) {
      if (b.dataset.label === track.label) b.classList.add("playing");
    }
    setStatus(
      `播放中 · ${track.label} · ${scoreMeta(track.score)} · ` +
        `WAV ${(blob.size / 1024 / 1024).toFixed(1)} MB`,
    );
    const link = activeEl?.querySelector("a.download");
    if (link instanceof HTMLAnchorElement) {
      link.href = url;
      link.download = `${track.label}.wav`;
    }
  } catch (err) {
    setStatus(`渲染失败：${String(err)}`);
  } finally {
    rendering = false;
    document.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

for (const demo of DEMO_SCORES) {
  const row = document.createElement("div");
  row.className = "track";
  const button = document.createElement("button");
  button.textContent = "播放";
  button.dataset.label = demo.label;
  playButtons.add(button);
  button.addEventListener("click", () => void playTrack({ label: demo.label, score: demo.score }, row));
  const meta = document.createElement("span");
  meta.className = "meta";
  const labelSpan = document.createElement("span");
  labelSpan.className = "label";
  labelSpan.textContent = demo.label;
  meta.append(labelSpan, document.createTextNode(scoreMeta(demo.score)));
  const download = document.createElement("a");
  download.className = "download";
  download.textContent = "渲染后可下载 WAV";
  row.append(button, meta, download);
  fixturesEl.append(row);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file === undefined) return;
  void file
    .text()
    .then((raw) => {
      const checked = MusicScoreSchema.safeParse(JSON.parse(raw));
      if (!checked.success) {
        fileMetaEl.textContent = `谱面校验未过：${checked.error.issues[0]?.message ?? "未知错误"}`;
        return;
      }
      fileMetaEl.textContent = scoreMeta(checked.data);
      void playTrack({ label: file.name.replace(/\.json$/i, ""), score: checked.data });
    })
    .catch((err: unknown) => {
      fileMetaEl.textContent = `读取失败：${String(err)}`;
    });
});
