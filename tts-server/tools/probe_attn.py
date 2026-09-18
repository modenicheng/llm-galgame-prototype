"""Probe: what mask/dtype/shapes does sdpa receive per layer type?"""
from __future__ import annotations

import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fastpath

fastpath.apply()

from qwen_tts import Qwen3TTSModel  # noqa: E402
from qwen_tts.core.models import modeling_qwen3_tts as M  # noqa: E402

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
registry = json.loads(open(os.path.join(os.path.dirname(__file__), "..", "voices", "registry.json"), encoding="utf-8").read())
prompt = torch.load(registry["paimeng"]["prompt_pt"], map_location="cuda:0", weights_only=False)

calls = {"n": 0}

fn = M.ALL_ATTENTION_FUNCTIONS["sdpa"]

def probe(module, q, k, v, attention_mask, dropout=0.0, scaling=None, sliding_window=None, **kw):
    calls["n"] += 1
    if calls["n"] <= 8 or calls["n"] % 400 == 0:
        print(
            f"call#{calls['n']} layer={module.layer_idx} q={tuple(q.shape)} {q.dtype} "
            f"kv={tuple(k.shape)} mask={'None' if attention_mask is None else (tuple(attention_mask.shape), str(attention_mask.dtype))} "
            f"scaling={scaling} sw={sliding_window}"
        )
    return fn(module, q, k, v, attention_mask, dropout=dropout, scaling=scaling, sliding_window=sliding_window, **kw)

M.ALL_ATTENTION_FUNCTIONS["sdpa"] = probe

model.generate_voice_clone(text=["要来试试我们的小游戏吗？"], language=["Chinese"], voice_clone_prompt=[prompt])
print("total sdpa calls:", calls["n"])
