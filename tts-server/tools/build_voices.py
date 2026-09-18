"""One-off: build the five reusable voice-clone prompts for the local TTS server.

Phase 1 (CustomVoice, cached HF snapshot): synthesize one persona reference
clip per ensemble character from a built-in speaker + delivery instruct.
Phase 2 (Base, local dir): encode paimeng.wav + the four clips into
VoiceClonePromptItem tensors and save them under voices/prompts/.

Runtime then loads ONLY the Base model and serves all five voices through
clone prompts — single-model, batch-friendly, fits 8 GB VRAM.
"""
from __future__ import annotations

import gc
import json
import os
from pathlib import Path

import soundfile as sf
import torch

from qwen_tts import Qwen3TTSModel

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VOICES = ROOT / "voices"

# HF repo id works everywhere (auto-download / honours HF_HOME cache);
# point CUSTOM_VOICE_DIR / TTS_MODEL_DIR at local snapshot dirs to skip it.
CUSTOM_VOICE_DIR = os.environ.get("CUSTOM_VOICE_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
BASE_MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
# Reference clip for the main character voice — content asset, never in git.
PAIMENG_REF_WAV = os.environ.get("PAIMENG_REF_WAV", "")

# voice key -> (builtin speaker, instruct, persona ref text)
# Ref texts quote each character's canonical lines so cloned prosody
# matches the persona; instruct locks the delivery on generation.
ENSEMBLE = {
    "xuwanqing": {
        "speaker": "Serena",
        "instruct": "轻声平稳的学姐口吻，句子完整，语气词少，温和地把事情定下来。",
        "ref_text": "投票我先收着，谁改主意了私下和我说。三十秒念不完的，要不先挑一句最想留的？",
    },
    "linxiaoman": {
        "speaker": "Vivian",
        "instruct": "语速快、短句、直率嘴快的后辈口吻，带一点得意的尾音。",
        "ref_text": "我什么都没说，我只是把聊天记录放大了一点。排队半小时？这顿不吃也罢，你先排着。",
    },
    "xiayiming": {
        "speaker": "Dylan",
        "instruct": "嗓门大、自来熟、爱接梗的男同学口吻，热情夸张但不油腻。",
        "ref_text": "这有什么难的，包在我身上——那个昨天弄过这个的同学在吗？都行，我不吃辣，其他随便。",
    },
    "hanche": {
        "speaker": "Uncle_Fu",
        "instruct": "低沉平静的学长口吻，短句，冷幽默，不紧不慢。",
        "ref_text": "我带了饼干。这就涉及另一个故事了。轴体到键帽，这里面讲究不少。",
    },
}


def main() -> None:
    VOICES.mkdir(exist_ok=True)
    (VOICES / "prompts").mkdir(exist_ok=True)
    registry = {}

    # ---- Phase 1: reference clips from built-in voices ----
    print("[phase1] loading CustomVoice from HF cache …", flush=True)
    cv = Qwen3TTSModel.from_pretrained(
        str(CUSTOM_VOICE_DIR), device_map="cuda:0", dtype=torch.bfloat16
    )
    for key, spec in ENSEMBLE.items():
        out_wav = VOICES / f"{key}.wav"
        if out_wav.exists():
            print(f"[phase1] {key}: exists, skip")
        else:
            wavs, sr = cv.generate_custom_voice(
                text=spec["ref_text"],
                language="Chinese",
                speaker=spec["speaker"],
                instruct=spec["instruct"],
            )
            sf.write(out_wav, wavs[0], sr)
            dur = len(wavs[0]) / sr
            print(f"[phase1] {key}: {spec['speaker']} -> {out_wav.name} ({dur:.1f}s @{sr}Hz)")
        registry[key] = {
            "origin_speaker": spec["speaker"],
            "ref_text": spec["ref_text"],
            "wav": str(out_wav),
            "prompt_pt": str(VOICES / "prompts" / f"{key}.pt"),
        }
    del cv
    gc.collect()
    torch.cuda.empty_cache()
    print(f"[phase1] done, vram freed: {torch.cuda.memory_allocated()/1e6:.0f} MB", flush=True)

    # ---- Phase 2: clone prompts on Base ----
    print("[phase2] loading Base …", flush=True)
    base = Qwen3TTSModel.from_pretrained(
        str(BASE_MODEL_DIR), device_map="cuda:0", dtype=torch.bfloat16
    )
    paimeng_txt = (VOICES / "paimeng.txt").read_text(encoding="utf-8").strip()
    if not PAIMENG_REF_WAV:
        raise SystemExit("set PAIMENG_REF_WAV to the main character's reference clip (content asset, not in git)")
    paimeng_wav = PAIMENG_REF_WAV
    registry["paimeng"] = {
        "origin_speaker": None,
        "ref_text": paimeng_txt,
        "wav": paimeng_wav,
        "prompt_pt": str(VOICES / "prompts" / "paimeng.pt"),
    }

    jobs = [("paimeng", paimeng_wav, paimeng_txt)] + [
        (key, registry[key]["wav"], registry[key]["ref_text"]) for key in ENSEMBLE
    ]
    for key, wav, text in jobs:
        out_pt = VOICES / "prompts" / f"{key}.pt"
        if out_pt.exists():
            print(f"[phase2] {key}: exists, skip")
            continue
        items = base.create_voice_clone_prompt(ref_audio=wav, ref_text=text)
        item = items[0]
        # detach to CPU so the .pt loads without a GPU present
        item.ref_code = item.ref_code.detach().to("cpu") if item.ref_code is not None else None
        item.ref_spk_embedding = item.ref_spk_embedding.detach().to("cpu")
        torch.save(item, out_pt)
        code_shape = tuple(item.ref_code.shape) if item.ref_code is not None else None
        print(f"[phase2] {key}: prompt saved (code={code_shape}, emb={tuple(item.ref_spk_embedding.shape)})")

    with open(VOICES / "registry.json", "w", encoding="utf-8") as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
    print("[done] registry.json written")


if __name__ == "__main__":
    main()
