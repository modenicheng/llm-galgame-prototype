"""Experiment: torch.compile the predictor + talker backbones, measure per-step."""
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

TEXT = "要来试试我们的小游戏吗？"

# baseline
model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
torch.cuda.synchronize()
print(f"baseline: {(time.perf_counter()-t0)*1000:.0f} ms, rtf={(time.perf_counter()-t0)/(len(wavs[0])/sr):.2f}")

# compile backbones
talker = model.model.talker  # Qwen3TTSTalkerForConditionalGeneration
talker.model = torch.compile(talker.model, dynamic=True)
pred = talker.code_predictor
pred.model = torch.compile(pred.model, dynamic=True)
pred.small_to_mtp_projection = torch.compile(pred.small_to_mtp_projection, dynamic=True)

print("compiling (first call is slow)…", flush=True)
t0 = time.perf_counter()
model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
print(f"compile+first: {(time.perf_counter()-t0):.0f} s", flush=True)
for i in range(2):
    t0 = time.perf_counter()
    wavs, sr = model.generate_voice_clone(text=[TEXT], language=["Chinese"], voice_clone_prompt=[prompt])
    torch.cuda.synchronize()
    print(f"compiled run{i}: {(time.perf_counter()-t0)*1000:.0f} ms, rtf={(time.perf_counter()-t0)/(len(wavs[0])/sr):.2f}")
