"""Why does the batched path skip compilation? TORCH_LOGS=recompiles."""
from __future__ import annotations

import json
import os
import sys
import time

os.environ["TORCH_LOGS"] = "recompiles"

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fastpath

fastpath.apply()

from qwen_tts import Qwen3TTSModel  # noqa: E402

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
talker = model.model.talker
talker.model = torch.compile(talker.model, dynamic=True)
pred = talker.code_predictor
pred.model = torch.compile(pred.model, dynamic=True)
pred.small_to_mtp_projection = torch.compile(pred.small_to_mtp_projection, dynamic=True)

registry = json.loads(open(os.path.join(os.path.dirname(__file__), "..", "voices", "registry.json"), encoding="utf-8").read())
keys = ["paimeng", "xuwanqing", "linxiaoman", "xiayiming"]
prompts4 = [torch.load(registry[k]["prompt_pt"], map_location="cuda:0", weights_only=False) for k in keys]
texts4 = [
    "欢迎来到网络协会的展位！",
    "投票我先收着，谁改主意了私下和我说。",
    "排队半小时？这顿不吃也罢，你先排着。",
    "这有什么难的，包在我身上！",
]

print("=== warmup single ===", flush=True)
t0 = time.perf_counter()
model.generate_voice_clone(text=["预热。"], language=["Chinese"], voice_clone_prompt=[prompts4[0]])
print(f"single warm: {time.perf_counter()-t0:.0f}s", flush=True)

print("=== batch4 first ===", flush=True)
t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=texts4, language=["Chinese"]*4, voice_clone_prompt=prompts4)
torch.cuda.synchronize()
print(f"batch4 first: {time.perf_counter()-t0:.0f}s audio_sum={sum(len(w) for w in wavs)/sr:.1f}s", flush=True)

t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=texts4, language=["Chinese"]*4, voice_clone_prompt=prompts4)
torch.cuda.synchronize()
print(f"batch4 warm: {(time.perf_counter()-t0)*1000:.0f}ms rtf={(time.perf_counter()-t0)/(sum(len(w) for w in wavs)/sr):.2f}", flush=True)
