"""Torch profiler: where do 190ms/frame actually go?"""
from __future__ import annotations

import json
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fastpath

fastpath.apply()

from qwen_tts import Qwen3TTSModel  # noqa: E402

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
VOICES_DIR = os.path.join(os.path.dirname(__file__), "..", "voices")

model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
print("attn impl:", model.model.config._attn_implementation)
registry = json.loads(open(os.path.join(VOICES_DIR, "registry.json"), encoding="utf-8").read())
prompt = torch.load(registry["paimeng"]["prompt_pt"], map_location="cuda:0", weights_only=False)

TEXT = "要来试试我们的小游戏吗？"  # ~2s audio, ~25 frames

# warmup
model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])

from torch.profiler import ProfilerActivity, profile  # noqa: E402

with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA]) as prof:
    t0 = time.perf_counter()
    wavs, sr = model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0

print(f"profiled: {dt*1000:.0f} ms for {len(wavs[0])/sr:.2f}s audio")
print(prof.key_averages().table(sort_by="self_cpu_time_total", row_limit=25))
