"""Register precomputed voice latents (.spk/.rvq/.txt) with a qwentts.cpp server.

Discovers every `*.spk` in --voices-dir and registers it under its stem;
each voice needs a sibling `<name>.rvq` (reference codes) and `<name>.txt`
(reference transcript for ICL cloning). The server registry lives in
process RAM — re-run this after every engine restart.

Usage:
  python register_qwentts_voices.py --voices-dir <dir> [--base http://127.0.0.1:9766]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices-dir", default=os.environ.get("QWENTTS_VOICES_DIR"),
                    help="dir with <name>.spk/.rvq/.txt (env QWENTTS_VOICES_DIR)")
    ap.add_argument("--base", default=os.environ.get("LOCAL_TTS_BASE_URL", "http://127.0.0.1:9766"))
    args = ap.parse_args()
    if not args.voices_dir:
        ap.error("--voices-dir is required (or set QWENTTS_VOICES_DIR)")
    voices_dir = Path(args.voices_dir)
    base = args.base.rstrip("/")

    names = sorted(p.stem for p in voices_dir.glob("*.spk"))
    if not names:
        print(f"[register] no *.spk latents in {voices_dir} — precompute with "
              f"qwen-codec --model <codec.gguf> --talker <talker.gguf> -i ref.wav")
        sys.exit(1)

    for _ in range(60):
        try:
            urllib.request.urlopen(f"{base}/health", timeout=2)
            break
        except Exception:
            time.sleep(1)
    else:
        print(f"[register] server not reachable at {base}")
        sys.exit(1)

    for name in names:
        spk = base64.b64encode((voices_dir / f"{name}.spk").read_bytes()).decode()
        rvq = base64.b64encode((voices_dir / f"{name}.rvq").read_bytes()).decode()
        ref_text = (voices_dir / f"{name}.txt").read_text(encoding="utf-8").strip()
        body = json.dumps({"name": name, "ref_text": ref_text, "spk_b64": spk, "rvq_b64": rvq}).encode()
        req = urllib.request.Request(
            f"{base}/v1/audio/voices", data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"[register] {name}: {resp.status}")
        except Exception as e:  # noqa: BLE001
            print(f"[register] {name}: FAILED {e}")
            sys.exit(1)
    with urllib.request.urlopen(f"{base}/v1/audio/voices", timeout=5) as resp:
        print("[voices]", resp.read().decode()[:400])


if __name__ == "__main__":
    main()
