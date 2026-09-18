"""Test/bench client for the local qwen3-tts server.

Usage:
  python tools/client.py <voice> <text> [--out file.wav]
  python tools/client.py --par N            # 4-way parallel bench across voices
  python tools/client.py --cancel           # cancel-under-pressure probe
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import urllib.request
import wave

BASE = "http://127.0.0.1:9765"

PAR_LINES = [
    ("paimeng", "欢迎来到网络协会的展位！要来试试我们的小游戏吗？答对了有奖励哦。"),
    ("xuwanqing", "投票我先收着，谁改主意了私下和我说。要不先挑一句最想留的？"),
    ("linxiaoman", "排队半小时？这顿不吃也罢——你先排着。我什么都没说，我只是把聊天记录放大了一点。"),
    ("xiayiming", "这有什么难的，包在我身上！都行，我不吃辣，其他随便。"),
]


def save_wav(path: str, pcm: bytes, sr: int = 24000) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)


async def fetch(client_session, voice: str, text: str,
                cancel_after: float | None = None) -> dict:
    import aiohttp  # lazy import for the plain-single mode below

    t0 = time.perf_counter()
    first = None
    total = 0
    status = "ok"
    try:
        async with client_session.post(
            "/tts", json={"text": text, "voice": voice}
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                return {"error": f"http {resp.status}: {body[:200]}"}
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
        "voice": voice, "status": status, "http_first_ms": None if first is None else round(first),
        "pcm_first_ms": None if first is None else round(first),
        "total_ms": round(total_ms), "audio_s": round(audio_s, 2),
        "rtf": round((total_ms / 1000) / audio_s, 2) if audio_s > 0 else None,
        "bytes": total,
    }


class _Cancelled(Exception):
    pass


async def single(voice: str, text: str, out: str | None) -> None:
    import aiohttp

    async with aiohttp.ClientSession(BASE) as s:
        # collect full pcm for wav out
        t0 = time.perf_counter()
        first = None
        buf = b""
        async with s.post("/tts", json={"text": text, "voice": voice}) as resp:
            if resp.status != 200:
                print("error:", await resp.text())
                return
            async for chunk in resp.content.iter_any():
                if first is None:
                    first = (time.perf_counter() - t0) * 1000
                buf += chunk
        total_ms = (time.perf_counter() - t0) * 1000
        audio_s = len(buf) / 2 / 24000
        print(json.dumps({
            "voice": voice, "first_ms": round(first or -1), "total_ms": round(total_ms),
            "audio_s": round(audio_s, 2),
            "rtf": round((total_ms / 1000) / audio_s, 2) if audio_s else None,
        }, ensure_ascii=False))
        if out and buf:
            save_wav(out, buf)
            print("wav:", out)


async def par(n: int) -> None:
    import aiohttp

    lines = (PAR_LINES * ((n + len(PAR_LINES) - 1) // len(PAR_LINES)))[:n]
    async with aiohttp.ClientSession(BASE) as s:
        t0 = time.perf_counter()
        results = await asyncio.gather(*[fetch(s, v, t) for v, t in lines])
        wall = (time.perf_counter() - t0) * 1000
        for r in results:
            print(json.dumps(r, ensure_ascii=False))
        ok = [r for r in results if r.get("status") == "ok"]
        print(f"[par{ n }] wall_ms={wall:.0f} avg_rtf={sum(r['rtf'] for r in ok if r['rtf'])/max(len(ok),1):.2f}")


async def cancel_probe() -> None:
    """Fire a long line, cancel reads after 0.6s; then immediately request a
    short line and measure whether the server recovers quickly."""
    import aiohttp

    async with aiohttp.ClientSession(BASE) as s:
        long_text = "这个故事要从很久以前讲起。那年夏天特别热，我们几个在机房里吹空调。韩澈带来了一箱冰可乐。夏一鸣非说自己能一个人搬完。结果他确实搬完了，就是第二天胳膊抬不起来。后来我们每次提这件事，他都说那是战术性休息。" * 3
        r1 = asyncio.create_task(fetch(s, "paimeng", long_text, cancel_after=0.6))
        await asyncio.sleep(0.15)
        t0 = time.perf_counter()
        r2 = await fetch(s, "linxiaoman", "我什么都没说。")
        r2["next_line_ms_after_cancel"] = round((time.perf_counter() - t0) * 1000)
        print(json.dumps(await r1, ensure_ascii=False))
        print(json.dumps(r2, ensure_ascii=False))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("voice", nargs="?", default=None)
    ap.add_argument("text", nargs="?", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--par", type=int, default=None)
    ap.add_argument("--cancel", action="store_true")
    args = ap.parse_args()

    if args.par:
        asyncio.run(par(args.par))
    elif args.cancel:
        asyncio.run(cancel_probe())
    elif args.voice and args.text:
        asyncio.run(single(args.voice, args.text, args.out))
    else:
        ap.error("need voice+text, --par N, or --cancel")


if __name__ == "__main__":
    main()
