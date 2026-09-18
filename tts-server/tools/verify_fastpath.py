"""A/B: stock nested-generate vs fastpath on identical greedy inputs.

Greedy (do_sample=False) makes both paths deterministic; the resulting
waveforms must match exactly for the fastpath to be trusted.
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
VOICES_DIR = os.path.join(os.path.dirname(__file__), "..", "voices")

from qwen_tts import Qwen3TTSModel  # noqa: E402

model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
registry = json.loads(open(os.path.join(VOICES_DIR, "registry.json"), encoding="utf-8").read())
prompt = torch.load(registry["paimeng"]["prompt_pt"], map_location="cuda:0", weights_only=False)

TEXT = "欢迎来到网络协会的展位，要来试试小游戏吗？"

t0 = time.perf_counter()
wavs_ref, sr = model.generate_voice_clone(
    text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt],
    do_sample=False, subtalker_dosample=False,
)
torch.cuda.synchronize()
stock_ms = (time.perf_counter() - t0) * 1000
print(f"stock greedy: {stock_ms:.0f} ms, audio {len(wavs_ref[0])/sr:.2f}s")

import fastpath  # noqa: E402

fastpath.apply()

t0 = time.perf_counter()
wavs_fast, sr2 = model.generate_voice_clone(
    text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt],
    do_sample=False, subtalker_dosample=False,
)
torch.cuda.synchronize()
fast_ms = (time.perf_counter() - t0) * 1000
print(f"fast  greedy: {fast_ms:.0f} ms, audio {len(wavs_fast[0])/sr2:.2f}s")

a, b = wavs_ref[0], wavs_fast[0]
if len(a) != len(b):
    print(f"LENGTH MISMATCH: {len(a)} vs {len(b)}")
same = a.shape == b.shape and np.array_equal(a, b)
max_diff = float(np.max(np.abs(a - b))) if a.shape == b.shape else float("nan")
print(f"identical={same} max_diff={max_diff:.6f} speedup={stock_ms/fast_ms:.2f}x")

# sampled speed check (production path)
t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
torch.cuda.synchronize()
dt = time.perf_counter() - t0
print(f"fast sampled: {dt*1000:.0f} ms, rtf={dt/(len(wavs[0])/sr):.2f}")
