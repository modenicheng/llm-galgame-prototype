"""One-off: transcribe the Raspberry-girl reference clip with SenseVoiceSmall (CPU).

Writes the transcript to voices/paimeng.txt for the clone-prompt builder.
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("MODELSCOPE_CACHE", r"D:\modelscope_cache")

from funasr import AutoModel  # noqa: E402

REF = os.environ.get("TTS_REF_WAV", "")
if not REF:
    raise SystemExit("set TTS_REF_WAV to the reference clip (content asset, not in git)")
OUT = os.path.join(os.path.dirname(__file__), "..", "voices", "paimeng.txt")


def main() -> None:
    model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", disable_update=True)
    result = model.generate(input=REF, cache={}, language="zh", use_itn=True)
    text = result[0]["text"].strip()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"[asr] {text!r} -> {os.path.abspath(OUT)}")


if __name__ == "__main__":
    sys.exit(main())
