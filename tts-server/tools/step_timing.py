"""Instrument: per-step wall time split between main talker and subtalker."""
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
import qwen_tts.core.models.modeling_qwen3_tts as M  # noqa: E402

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
registry = json.loads(open(os.path.join(os.path.dirname(__file__), "..", "voices", "registry.json"), encoding="utf-8").read())
prompt = torch.load(registry["paimeng"]["prompt_pt"], map_location="cuda:0", weights_only=False)

stats = {"predictor_ms": 0.0, "predictor_calls": 0}

orig_fast = fastpath._fast_generate

def timed_fast(self, **kw):
    t0 = time.perf_counter()
    r = orig_fast(self, **kw)
    torch.cuda.synchronize()
    stats["predictor_ms"] += (time.perf_counter() - t0) * 1000
    stats["predictor_calls"] += 1
    return r

fastpath._fast_generate = timed_fast
M.Qwen3TTSTalkerCodePredictorModelForConditionalGeneration.generate = timed_fast

TEXT = "要来试试我们的小游戏吗？"
model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])  # warmup
stats["predictor_ms"] = stats["predictor_calls"] = 0

t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
torch.cuda.synchronize()
wall = (time.perf_counter() - t0) * 1000
frames = round(len(wavs[0]) / sr * 12.5)
print(f"wall={wall:.0f} ms, frames={frames}, audio={len(wavs[0])/sr:.2f}s")
print(f"subtalker total={stats['predictor_ms']:.0f} ms over {stats['predictor_calls']} frames "
      f"({stats['predictor_ms']/max(stats['predictor_calls'],1):.1f} ms/frame)")
print(f"main talker + overhead = {wall - stats['predictor_ms']:.0f} ms "
      f"({(wall - stats['predictor_ms'])/max(stats['predictor_calls'],1):.1f} ms/frame)")
