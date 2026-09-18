"""Local Qwen3-TTS streaming inference server for the galgame runtime.

Serves the five game voices (paimeng clone + four ensemble clones built from
built-in CustomVoice speakers) through a single Qwen3-TTS-12Hz-1.7B-Base
model so everything fits in 8 GB VRAM and batches across requests.

Streaming model:
  - Each request's text is split into sentence groups (Chinese punctuation).
  - A single GPU worker drains a wave queue: every wave batches the next
    pending sentence of up to MAX_BATCH requests into one generate call
    (the package API supports mixed voice-clone prompts in one batch).
  - PCM (s16le, 24 kHz, mono) is flushed per sentence as octet-stream —
    first chunk leaves as soon as the first wave containing it completes.
  - Cancellation unit = one wave/sentence: a disconnected request is
    dropped before its next sentence enters a wave; the in-flight wave
    still finishes (torch generate cannot be interrupted mid-call).

Protocol (mirrors the galgame's own audio route headers):
  POST /tts   {"text": str, "voice": str}  -> 200 octet-stream PCM
             headers: X-Audio-Encoding/…-Sample-Rate/…-Channels/…-Bit-Depth
  GET  /health -> {"ready": bool, "vram_mb": int, "queue": int, "waves": int}
  GET  /voices -> {"voices": [str]}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from qwen_tts import Qwen3TTSModel

import fastpath

SAMPLE_RATE = 24_000

MODEL_DIR = os.environ.get("TTS_MODEL_DIR", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
VOICES_DIR = Path(os.environ.get("TTS_VOICES_DIR", Path(__file__).parent / "voices"))
MAX_BATCH = int(os.environ.get("TTS_MAX_BATCH", "4"))
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "9765"))
# eager decode on this stack runs at RTF≈3 (Python/launch overhead dominates);
# triton+compile brings it to ~1.1 single-stream and much better batched.
COMPILE = os.environ.get("TTS_COMPILE", "1") == "1"
# persistent inductor cache so restarts skip most of the ~5 min first compile
os.environ.setdefault("TORCHINDUCTOR_FX_GRAPH_CACHE", "1")
os.environ.setdefault(
    "TORCHINDUCTOR_CACHE_DIR", str(Path(__file__).parent / ".inductor-cache")
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("qwen3tts")

# ---------------------------------------------------------------------------
# Sentence splitting: split on terminal punctuation, merge tiny fragments so
# prosody does not get choppy. Ellipsis/问叹号 variants kept with the clause.
# ---------------------------------------------------------------------------
_SPLIT_RE = re.compile(r"(?<=[。！？!?；;…])")
_MIN_GROUP_CHARS = 8


def split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    parts = [p.strip() for p in _SPLIT_RE.split(text) if p.strip()]
    groups: list[str] = []
    for part in parts:
        if groups and (len(groups[-1]) < _MIN_GROUP_CHARS or len(part) < _MIN_GROUP_CHARS):
            groups[-1] += part
        else:
            groups.append(part)
    return groups


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
@dataclass
class Pending:
    voice: str
    prompt: object  # VoiceClonePromptItem
    sentences: list[str]
    idx: int = 0
    # per-request PCM queue; None-entry terminates, exception propagates
    out: asyncio.Queue = field(default_factory=asyncio.Queue)
    canceled: bool = False
    enqueued_at: float = field(default_factory=time.perf_counter)
    first_chunk_at: Optional[float] = None
    audio_sec: float = 0.0


class Engine:
    def __init__(self) -> None:
        self.model: Optional[Qwen3TTSModel] = None
        self.prompts: dict[str, object] = {}
        self.pending: list[Pending] = []
        self.wakeup: asyncio.Event = asyncio.Event()
        self.stats = {"waves": 0, "batch_lines": 0, "requests": 0}
        self._gpu_lock = asyncio.Lock()

    def load(self) -> None:
        log.info("loading Base model from %s …", MODEL_DIR)
        t0 = time.perf_counter()
        fastpath.apply()
        self.model = Qwen3TTSModel.from_pretrained(
            MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16
        )
        if COMPILE:
            talker = self.model.model.talker
            talker.model = torch.compile(talker.model, dynamic=True)
            pred = talker.code_predictor
            pred.model = torch.compile(pred.model, dynamic=True)
            pred.small_to_mtp_projection = torch.compile(
                pred.small_to_mtp_projection, dynamic=True
            )
        registry = json.loads((VOICES_DIR / "registry.json").read_text(encoding="utf-8"))
        for key, entry in registry.items():
            self.prompts[key] = torch.load(entry["prompt_pt"], map_location="cuda:0", weights_only=False)
        log.info(
            "model ready in %.1fs, voices=%s, vram=%.0f MB",
            time.perf_counter() - t0,
            sorted(self.prompts),
            torch.cuda.memory_allocated() / 1e6,
        )

    def warmup(self) -> None:
        """Compile the hot guard combos (batch 1/2/4, varied lengths)."""
        if not COMPILE:
            return
        t0 = time.perf_counter()
        keys = sorted(self.prompts)
        # length variety matters: prefill length and None-vs-Cache guards
        # specialize per shape bucket, and each needs its compiled graph.
        samples = ["预热。", "这是一句稍微长一点的预热台词，用来覆盖更长的序列形状。"]
        with fastpath.cudnn_attention():
            for bs in (1, 2, MAX_BATCH):
                wave = keys[:bs]
                text = samples[(bs - 1) % len(samples)]
                self.model.generate_voice_clone(
                    text=[text] * len(wave), language=["Chinese"] * len(wave),
                    voice_clone_prompt=[self.prompts[k] for k in wave],
                )
        log.info("warmup (compile) done in %.0fs", time.perf_counter() - t0)

    async def submit(self, voice: str, text: str) -> Pending:
        if voice not in self.prompts:
            raise KeyError(f"unknown voice '{voice}'")
        p = Pending(voice=voice, prompt=self.prompts[voice], sentences=split_sentences(text))
        self.stats["requests"] += 1
        if not p.sentences:
            await p.out.put(b"")
            p.out.put_nowait(None)
            return p
        self.pending.append(p)
        self.wakeup.set()
        return p

    def cancel(self, p: Pending) -> None:
        p.canceled = True
        # wake the worker so it can purge without waiting for a wave return
        self.wakeup.set()

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            try:
                await self._run_once(loop)
            except Exception:  # noqa: BLE001 — the worker must never die
                log.exception("engine wave loop error; recovering")
                for p in self.pending:
                    p.out.put_nowait(RuntimeError("engine wave failed"))
                self.pending = []
                await asyncio.sleep(0.05)

    async def _run_once(self, loop) -> None:
        if not self.pending:
            self.wakeup.clear()
            await self.wakeup.wait()
            return
        # drop canceled entries before scheduling; terminate their queues
        still_pending: list[Pending] = []
        for p in self.pending:
            if p.canceled:
                p.out.put_nowait(None)
            else:
                still_pending.append(p)
        self.pending = still_pending
        if not self.pending:
            return

        # Wave packing: fill up to MAX_BATCH sentences total, allowing a
        # single request to contribute several of its remaining sentences
        # (round-robin first so concurrent requests share the wave).
        wave: list[tuple[Pending, int]] = []  # (pending, sentences taken)
        take = {id(p): 0 for p in self.pending}
        filled = False
        while len(wave) < MAX_BATCH and not filled:
            filled = True
            for p in self.pending:
                remaining = len(p.sentences) - p.idx
                if take[id(p)] >= remaining:
                    continue
                if len(wave) >= MAX_BATCH:
                    break
                wave.append((p, take[id(p)]))
                take[id(p)] += 1
                filled = False
        texts = [p.sentences[p.idx + i] for p, i in wave]
        prompts = [p.prompt for p, _ in wave]
        t0 = time.perf_counter()
        wavs, sr = await loop.run_in_executor(
            None, lambda: self.model.generate_voice_clone(
                text=texts,
                language=["Chinese"] * len(texts),
                voice_clone_prompt=prompts,
            )
        )
        wave_ms = (time.perf_counter() - t0) * 1000
        self.stats["waves"] += 1
        self.stats["batch_lines"] += len(wave)
        log.info("wave n=%d ms=%.0f", len(wave), wave_ms)

        # distribute results: each pending gets its sentences' PCM in order
        per_pending: dict[int, list] = {}
        for (p, _), wav in zip(wave, wavs):
            per_pending.setdefault(id(p), []).append((p, wav))
        for group in per_pending.values():
            for p, wav in group:
                p.idx += 1
                pcm = (np.clip(wav, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                p.audio_sec += len(wav) / sr
                if p.first_chunk_at is None:
                    p.first_chunk_at = time.perf_counter()
                if not p.canceled:
                    p.out.put_nowait(pcm)
            done_p = group[0][0]
            if done_p.idx >= len(done_p.sentences) and not done_p.canceled:
                done_p.out.put_nowait(None)
        self.pending = [p for p in self.pending if p.idx < len(p.sentences)]
        # yield to the event loop between waves
        await asyncio.sleep(0)


engine = Engine()
app = FastAPI()


@app.on_event("startup")
async def _startup() -> None:
    engine.load()
    engine.warmup()
    asyncio.create_task(engine.run())


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "ready": engine.model is not None,
            "voices": sorted(engine.prompts),
            "queue": len(engine.pending),
            "waves": engine.stats["waves"],
            "requests": engine.stats["requests"],
            "vram_mb": round(torch.cuda.memory_allocated() / 1e6),
        }
    )


@app.get("/voices")
async def voices() -> JSONResponse:
    return JSONResponse({"voices": sorted(engine.prompts), "sample_rate": SAMPLE_RATE})


@app.post("/tts")
async def tts(request: Request) -> StreamingResponse:
    body = await request.json()
    text = str(body.get("text", ""))
    voice = str(body.get("voice", ""))
    p = await engine.submit(voice, text)
    queue_ms = (time.perf_counter() - p.enqueued_at) * 1000

    async def stream():
        try:
            while True:
                item = await p.out.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                if item:
                    yield item
        finally:
            engine.cancel(p)
            total_ms = (time.perf_counter() - p.enqueued_at) * 1000
            first_ms = (
                (p.first_chunk_at - p.enqueued_at) * 1000 if p.first_chunk_at else -1
            )
            log.info(
                "req voice=%s chars=%d queue_ms=%.0f first_ms=%.0f total_ms=%.0f "
                "audio_s=%.1f waves=%d canceled=%s",
                p.voice, len(text), queue_ms, first_ms, total_ms,
                p.audio_sec, p.idx, p.canceled,
            )

    return StreamingResponse(
        stream(),
        media_type="application/octet-stream",
        headers={
            "X-Audio-Encoding": "pcm_s16le",
            "X-Audio-Sample-Rate": str(SAMPLE_RATE),
            "X-Audio-Channels": "1",
            "X-Audio-Bit-Depth": "16",
            "Cache-Control": "no-store",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
