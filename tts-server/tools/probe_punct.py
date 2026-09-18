"""Punctuation-compatibility probe for the local qwen3-tts engine.

qwen3-tts (local qwentts.cpp AND the open-source Base model) has no SSML /
break tags — pacing comes from punctuation alone. Punctuation the model was
not trained on (破折号 —— being the observed case) is silently dropped: no
pause, no sound. This probe synthesizes probe lines, saves WAVs and runs a
silence-gap analysis (frame RMS below threshold) so pause behavior shows up
as numbers, not by ear.

Usage:
  python tools/probe_punct.py [--voice linxiaoman] [--seed 7]
                              [--base http://127.0.0.1:9766] [--out DIR]

Interpretation: with a pinned seed the engine is deterministic (identical
text → identical audio), so each line is synthesized once. Per line we
report total audio length and the internal silence gaps (>100 ms below the
energy threshold): a dropped mark yields no gap and roughly baseline
duration; a real pause shows up as an internal gap of its length.
"""
from __future__ import annotations

import argparse
import array
import json
import math
import time
import urllib.request
import wave
from pathlib import Path

# (group, label, text). Every group shares one carrier sentence so the
# delta inside a group isolates the punctuation under test.
PROBES: list[tuple[str, str, str]] = [
    # 破折号 mid-line: dropped, or pause-worthy? bare = no-punct baseline
    ("mid-dash", "bare", "他愣了一下转身就走。"),
    ("mid-dash", "comma", "他愣了一下，转身就走。"),
    ("mid-dash", "em-dash", "他愣了一下——转身就走。"),
    ("mid-dash", "ellipsis", "他愣了一下……转身就走。"),
    # 破折号 line-end (interrupted speech / trailing off)
    ("trail", "bare", "你居然"),
    ("trail", "em-dash", "你居然——"),
    ("trail", "ellipsis", "你居然……"),
    # 数字区间：加停顿反而是反例，应映射为「到」或保持沉默
    ("range", "dao", "价格从三千到五千不等。"),
    ("range", "em-dash", "价格从三千——五千不等。"),
    # 波浪线（拖长语气）
    ("tilde", "bare", "好呀我们走吧。"),
    ("tilde", "comma", "好呀，我们走吧。"),
    ("tilde", "tilde", "好呀～我们走吧。"),
    # 间隔号（外文名）
    ("interpunct", "none", "哈利波特来了。"),
    ("interpunct", "middot", "哈利·波特来了。"),
    # 结巴式破折号
    ("stutter", "comma", "我，我不知道。"),
    ("stutter", "em-dash", "我——我不知道。"),
]

SR = 24000
FRAME_MS = 20  # RMS hop


def synth(base: str, voice: str, text: str, seed: int) -> bytes:
    """One synthesis round-trip, returns s16le mono 24 kHz PCM."""
    body = json.dumps(
        {
            "model": "local-qwen3-tts",
            "input": text,
            "voice": voice,
            "response_format": "pcm",
            "seed": seed,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/v1/audio/speech",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as resp:
        pcm = resp.read()
    wall = time.perf_counter() - t0
    if len(pcm) <= 0:
        raise RuntimeError(f"empty audio for {text!r}")
    print(
        json.dumps(
            {
                "text": text,
                "audio_s": round(len(pcm) / 2 / SR, 2),
                "wall_s": round(wall, 2),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return pcm


def analyze_gaps(pcm: bytes) -> dict:
    """Frame-RMS silence-gap analysis. Returns total/internal gap stats.

    Threshold is adaptive: 10 % of the frame-RMS 90th percentile, so quiet
    voices still separate speech from pause.
    """
    samples = array.array("h")
    samples.frombytes(pcm)
    frame = SR * FRAME_MS // 1000
    rms: list[float] = []
    for i in range(0, len(samples) - frame, frame):
        acc = 0
        for j in range(i, i + frame):
            acc += samples[j] * samples[j]
        rms.append(math.sqrt(acc / frame))
    if not rms:
        return {"gaps": [], "total_s": 0.0}
    sorted_rms = sorted(rms)
    thresh = max(sorted_rms[int(len(sorted_rms) * 0.9)] * 0.10, 50.0)
    # lead-in / tail trim: speech usually starts/ends with short breaths
    def is_speech(v: float) -> bool:
        return v > thresh

    gaps: list[tuple[float, float]] = []  # (start_s, dur_s)
    run = 0
    for idx, v in enumerate(rms):
        if not is_speech(v):
            run += 1
        else:
            if run * FRAME_MS >= 100:
                gaps.append(
                    (round((idx - run) * FRAME_MS / 1000, 2),
                     round(run * FRAME_MS / 1000, 2))
                )
            run = 0
    tail_s = run * FRAME_MS / 1000
    return {
        "total_s": round(len(rms) * FRAME_MS / 1000, 2),
        # "0.64s@1.02s" — position makes natural word gaps distinguishable
        # from an inserted pause at the mark's location.
        "internal_gaps": [f"{d:.2f}s@{s:.2f}s" for s, d in gaps],
        "gap_total_s": round(sum(d for _, d in gaps), 2),
        "tail_silence_s": round(tail_s, 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="linxiaoman")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--base", default="http://127.0.0.1:9766")
    ap.add_argument("--out", default=None, help="dir to save probe WAVs")
    args = ap.parse_args()
    out = Path(args.out) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)

    results: dict[tuple[str, str], dict] = {}
    for group, label, text in PROBES:
        pcm = synth(args.base, args.voice, text, args.seed)
        if out:
            with wave.open(str(out / f"{group}_{label}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SR)
                w.writeframes(pcm)
        results[(group, label)] = {"text": text, **analyze_gaps(pcm)}

    print("\n=== silence-gap analysis (internal pauses >100 ms) ===")
    groups: dict[str, list[tuple[str, dict]]] = {}
    for (group, label), r in results.items():
        groups.setdefault(group, []).append((label, r))
    for group, rows in groups.items():
        print(f"[{group}]")
        for label, r in rows:
            print(
                f"    {label:<10} total={r['total_s']:.2f}s "
                f"gaps={r['internal_gaps']} (sum {r['gap_total_s']:.2f}s) "
                f"tail={r['tail_silence_s']:.2f}s  {r['text']}"
            )


if __name__ == "__main__":
    main()
