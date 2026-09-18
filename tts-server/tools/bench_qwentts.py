"""Bench the qwentts.cpp OpenAI-compatible server (streaming PCM)."""
from __future__ import annotations

import argparse
import asyncio
import json
import time

import aiohttp

import os
BASE = os.environ.get("LOCAL_TTS_BASE_URL", "http://127.0.0.1:9766")

PAR_LINES = [
    ("paimeng", "欢迎来到网络协会的展位！要来试试我们的小游戏吗？答对了有奖励哦。"),
    ("xuwanqing", "投票我先收着，谁改主意了私下和我说。要不先挑一句最想留的？"),
    ("linxiaoman", "排队半小时？这顿不吃也罢——你先排着。我什么都没说，我只是把聊天记录放大了一点。"),
    ("xiayiming", "这有什么难的，包在我身上！都行，我不吃辣，其他随便。"),
]


async def fetch(s, voice, text, cancel_after=None):
    t0 = time.perf_counter()
    first = None
    total = 0
    status = "ok"
    try:
        async with s.post(
            "/v1/audio/speech",
            json={"model": "local-qwen3-tts", "input": text, "voice": voice, "response_format": "pcm"},
        ) as resp:
            if resp.status != 200:
                return {"error": f"http {resp.status}: {(await resp.text())[:150]}"}
            async for chunk in resp.content.iter_any():
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                    if cancel_after is not None and (time.perf_counter() - t0) >= cancel_after:
                        raise _Cancelled()
                total += len(chunk)
    except _Cancelled:
        status = "canceled"
    total_ms = (time.perf_counter() - t0) * 1000
    audio_s = total / 2 / 24000
    return {
        "voice": voice, "status": status,
        "first_ms": None if first is None else round(first),
        "total_ms": round(total_ms), "audio_s": round(audio_s, 2),
        "rtf": round((total_ms / 1000) / audio_s, 2) if audio_s > 0 else None,
    }


class _Cancelled(Exception):
    pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--par", type=int, default=0)
    ap.add_argument("--cancel", action="store_true")
    args = ap.parse_args()
    async with aiohttp.ClientSession(BASE) as s:
        if args.par:
            lines = (PAR_LINES * ((args.par + 3) // 4))[:args.par]
            t0 = time.perf_counter()
            results = await asyncio.gather(*[fetch(s, v, t) for v, t in lines])
            wall = (time.perf_counter() - t0) * 1000
            for r in results:
                print(json.dumps(r, ensure_ascii=False))
            ok = [r for r in results if r.get("status") == "ok"]
            tot_audio = sum(r["audio_s"] for r in ok)
            print(f"[par{args.par}] wall_ms={wall:.0f} audio_sum={tot_audio:.1f}s "
                  f"throughput_rtf={(wall/1000)/tot_audio:.2f}")
        elif args.cancel:
            long_text = "这个故事要从很久以前讲起。那年夏天特别热，我们几个在机房里吹空调。韩澈带来了一箱冰可乐。夏一鸣非说自己能一个人搬完。结果他确实搬完了，就是第二天胳膊抬不起来。后来我们每次提这件事，他都说那是战术性休息。" * 3
            r1 = asyncio.create_task(fetch(s, "paimeng", long_text, cancel_after=0.4))
            await asyncio.sleep(0.1)
            t0 = time.perf_counter()
            r2 = await fetch(s, "linxiaoman", "我什么都没说。")
            r2["next_line_ms"] = round((time.perf_counter() - t0) * 1000)
            print(json.dumps(await r1, ensure_ascii=False))
            print(json.dumps(r2, ensure_ascii=False))
        else:
            v, t = PAR_LINES[0]
            print(json.dumps(await fetch(s, v, t), ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
