"""Lean decode loop for the Qwen3-TTS subtalker (dual-track code predictor).

The reference implementation drives the 15-per-frame codebook steps of the
subtalker through full HuggingFace `generate()` — LogitsProcessorList setup,
stopping-criteria bookkeeping and per-step Python machinery ~15 ms × 15 steps
per audio frame, which is why stock inference runs at GPU utilization <25 %
and RTF ≈ 3 on an RTX 5060 laptop. This module replaces just that nested
`generate` with a hand-rolled KV-cache loop that calls the same `forward`
with the same tensors (identical sampling order: temperature -> top_k ->
top_p -> softmax -> multinomial).

Only `Qwen3TTSTalkerCodePredictorModelForConditionalGeneration.generate` is
patched, at runtime, from the server — site-packages stays untouched.
"""
from __future__ import annotations

from contextlib import contextmanager

import torch
import torch.nn.functional as F
from torch.nn.attention import SDPBackend, sdpa_kernel

from qwen_tts.core.models.modeling_qwen3_tts import (
    Qwen3TTSTalkerCodePredictorModelForConditionalGeneration,
)


@contextmanager
def cudnn_attention():
    """Prefer the cuDNN SDPA backend during generation.

    On Blackwell (sm_120) the flash/mem-efficient kernels in torch
    2.11+cu128 are unavailable ("No available kernel"), so stock SDPA
    silently degrades to the math path — ~20x slower per attention call.
    cuDNN has a working fused kernel; MATH stays as the last-resort
    fallback for shapes cuDNN rejects (e.g. fp32 codec-decoder attention).
    """
    with sdpa_kernel([SDPBackend.CUDNN_ATTENTION, SDPBackend.MATH]):
        yield


@torch.no_grad()
def _fast_generate(
    self: Qwen3TTSTalkerCodePredictorModelForConditionalGeneration,
    inputs_embeds=None,
    max_new_tokens=15,
    do_sample=True,
    top_k=50,
    top_p=1.0,
    temperature=0.9,
    output_hidden_states=True,
    return_dict_in_generate=True,
    **kwargs,
):
    # Prefill: multi-position embeds -> logits (b, S, V) for codebook slot 0.
    out = self(inputs_embeds=inputs_embeds, use_cache=True, output_hidden_states=False)
    past = out.past_key_values
    logits = out.logits[:, -1, :].float()
    gen_step = out.generation_steps

    seqs = []
    for i in range(max_new_tokens):
        if do_sample:
            scores = logits / temperature if temperature and temperature != 1.0 else logits
            if top_k and top_k > 0:
                kth = torch.topk(scores, min(top_k, scores.shape[-1]), dim=-1).values[..., -1, None]
                scores = scores.masked_fill(scores < kth, float("-inf"))
            if top_p and top_p < 1.0:
                sorted_scores, sorted_idx = torch.sort(scores, descending=True, dim=-1)
                probs = F.softmax(sorted_scores, dim=-1)
                cum = torch.cumsum(probs, dim=-1)
                remove = cum - probs > top_p
                sorted_scores = sorted_scores.masked_fill(remove, float("-inf"))
                scores = torch.full_like(scores, float("-inf")).scatter(-1, sorted_idx, sorted_scores)
            next_tok = torch.multinomial(F.softmax(scores, dim=-1), num_samples=1)
        else:
            next_tok = logits.argmax(dim=-1, keepdim=True)
        seqs.append(next_tok)
        if i == max_new_tokens - 1:
            break
        out = self(
            input_ids=next_tok,
            past_key_values=past,
            use_cache=True,
            generation_steps=gen_step,
            output_hidden_states=False,
        )
        past = out.past_key_values
        gen_step = out.generation_steps
        logits = out.logits[:, -1, :].float()

    sequences = torch.cat(seqs, dim=1)

    class _Result:
        pass

    res = _Result()
    res.sequences = sequences
    return res


def apply() -> None:
    """Install the lean subtalker loop + cuDNN-first attention on the wrapper."""
    # The qwen3-tts forward pair (prefill S>1 / decode S=1, past_key_values
    # None-vs-Cache, batch 1..4) burns one dynamo guard specialization per
    # combination; the default limit of 8 is exhausted mid-warmup and dynamo
    # then falls back to eager for the rest of the process (observed: batched
    # waves stuck at eager speed). Raise the limits so every hot combo gets
    # and keeps a compiled graph.
    import torch._dynamo as dynamo

    dynamo.config.recompile_limit = 128
    dynamo.config.cache_size_limit = 128

    Qwen3TTSTalkerCodePredictorModelForConditionalGeneration.generate = _fast_generate
    from qwen_tts import Qwen3TTSModel

    orig = Qwen3TTSModel.generate_voice_clone

    @torch.no_grad()
    def _clone_with_cudnn(self, *args, **kwargs):
        with cudnn_attention():
            return orig(self, *args, **kwargs)

    Qwen3TTSModel.generate_voice_clone = _clone_with_cudnn
