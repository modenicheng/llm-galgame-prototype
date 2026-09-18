"""Profile where generation time goes: speaker-prompt build vs sampling loop."""
from __future__ import annotations

import os
import time

import torch

from qwen_tts import Qwen3TTSModel

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
VOICES_DIR = os.path.join(os.path.dirname(__file__), "..", "voices")

model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
import json

registry = json.loads(open(os.path.join(VOICES_DIR, "registry.json"), encoding="utf-8").read())
prompt = torch.load(registry["paimeng"]["prompt_pt"], map_location="cuda:0", weights_only=False)
m = model.model

# --- piece 1: speaker prompt (runs on EVERY generate call today) ---
t0 = time.perf_counter()
spk = m.generate_speaker_prompt({"ref_code": [prompt.ref_code], "ref_spk_embedding": [prompt.ref_spk_embedding], "x_vector_only_mode": [False], "icl_mode": [True]})
torch.cuda.synchronize()
print(f"speaker_prompt (icl fwd): {(time.perf_counter()-t0)*1000:.0f} ms")

# --- piece 2: full generate for one short sentence, timed ---
for label, text in [("short", "我什么都没说。"), ("mid", "排队半小时？这顿不吃也罢，你先排着。")]:
    t0 = time.perf_counter()
    wavs, sr = model.generate_voice_clone(text=[text], language=["Chinese"], voice_clone_prompt=[prompt])
    torch.cuda.synchronize()
    dt = time.perf_counter() - t0
    audio = len(wavs[0]) / sr
    print(f"gen[{label}]: {dt*1000:.0f} ms, audio {audio:.2f}s, rtf={dt/audio:.2f}")

# --- piece 3: repeat short (post-warmup) ---
t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=["我什么都没说。"], language=["Chinese"], voice_clone_prompt=[prompt])
torch.cuda.synchronize()
dt = time.perf_counter() - t0
print(f"gen[short,warm]: {dt*1000:.0f} ms, rtf={dt/(len(wavs[0])/sr):.2f}")

# --- piece 4: batch of 4 mixed short sentences ---
prompts4 = [torch.load(registry[k]["prompt_pt"], map_location="cuda:0", weights_only=False)
            for k in ("paimeng", "xuwanqing", "linxiaoman", "xiayiming")]
texts4 = ["我什么都没说。", "投票我先收着。", "包在我身上。", "要来试试吗？"]
t0 = time.perf_counter()
wavs, sr = model.generate_voice_clone(text=texts4, language=["Chinese"] * 4, voice_clone_prompt=prompts4)
torch.cuda.synchronize()
dt = time.perf_counter() - t0
tot_audio = sum(len(w) for w in wavs) / sr
print(f"gen[batch4]: {dt*1000:.0f} ms, audio_sum {tot_audio:.2f}s, rtf={dt/tot_audio:.2f}")
