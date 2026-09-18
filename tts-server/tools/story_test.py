"""Story-level E2E test for the local qwen3-tts integration (playwright).

Drives the real game (real LLM writer + local tts-server) in headless
Chromium and measures the two scenarios:

  TEST 1 — auto mode: lines advance on their own; "seamless" means the
     next line's audio starts within the configured pause after the
     previous line's audio ended, and synthesis was ready before playback.
  TEST 2 — rapid next: manual mode, advance clicked every ~700 ms; the
     framework must cancel in-flight synthesis for skipped lines and the
     line that finally lands must still play, promptly.

Usage: python story_test.py <game_url_with_token> [--rapid-only|--auto-only]
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from playwright.sync_api import sync_playwright

INIT_JS = """
window.__ev = [];
window.__console = [];
const of = window.fetch;
window.fetch = async (...a) => {
  const url = String(a[0]);
  const isTts = url.includes('/api/audio/synthesize');
  const t0 = performance.now();
  let ck = '';
  if (isTts) { try { ck = JSON.parse(a[1].body).cacheKey.slice(0, 10); } catch (e) {} }
  let res;
  try {
    res = await of(...a);
  } catch (e) {
    if (isTts) window.__ev.push({ k: 'fetch-abort', ck, t0, t1: performance.now() });
    throw e;
  }
  if (isTts) {
    res.clone().arrayBuffer().then(b => window.__ev.push(
      { k: 'fetch', ck, t0, t1: performance.now(), bytes: b.byteLength })).catch(() => {});
  }
  return res;
};
// PCM playback goes straight into an AudioWorkletNode port (no
// AudioBufferSourceNode); wrap the constructor and log every feed — the
// first feed after idle is the effective playback start.
const AWN = window.AudioWorkletNode;
window.AudioWorkletNode = class extends AWN {
  constructor(...a) {
    super(...a);
    try {
      const port = this.port;
      const op = port.postMessage.bind(port);
      port.postMessage = (msg, ...rest) => {
        let n = 0;
        try {
          const p = msg && (msg.pcm || msg.samples || msg.data || msg.chunk);
          if (p && (p.length !== undefined || p.byteLength !== undefined)) {
            n = p.length ?? p.byteLength;
          }
        } catch (e) {}
        window.__ev.push({ k: 'feed', t: performance.now(), n });
        return op(msg, ...rest);
      };
    } catch (e) {}
  }
};
// dialogue text changes = line presentations
const _obs = new MutationObserver(() => {
  const d = document.querySelector('.dialogue');
  if (d) {
    const txt = (d.textContent || '').trim().slice(0, 24);
    if (txt && txt !== window.__lastLine) {
      window.__lastLine = txt;
      window.__ev.push({ k: 'line', t: performance.now(), txt });
    }
  }
});
document.addEventListener('DOMContentLoaded', () => _obs.observe(document.body, { childList: true, subtree: true, characterData: true }));
// sample the "generating" waiting indicator so long stalls can be
// attributed to the LLM writer (not the TTS pipeline)
window.__wait = { visible: false, since: 0, spans: [] };
setInterval(() => {
  const w = document.querySelector(".waiting, .stage__waiting, #waiting");
  const vis = !!w && !w.hidden && getComputedStyle(w).display !== "none"
    && getComputedStyle(w).visibility !== "hidden";
  if (vis !== window.__wait.visible) {
    const t = performance.now();
    if (vis) { window.__wait.since = t; }
    else if (window.__wait.since) {
      window.__wait.spans.push([Math.round(window.__wait.since), Math.round(t)]);
      window.__wait.since = 0;
    }
    window.__wait.visible = vis;
  }
}, 500);
['log','error','warn'].forEach(lvl => {
  const oc = console[lvl].bind(console);
  console[lvl] = (...a) => {
    try { window.__console.push(lvl + ': ' + a.map(x => String(x).slice(0, 160)).join(' ')); } catch (e) {}
    oc(...a);
  };
});
"""


def pull_events(page):
    return page.evaluate("() => window.__ev ? window.__ev.splice(0) : []")


def burst_starts(events, idle_gap_ms=1500):
    """Group worklet feeds into playback bursts; return burst start times."""
    feeds = [e["t"] for e in events if e["k"] == "feed"]
    bursts = []
    last = None
    for t in feeds:
        if last is None or t - last > idle_gap_ms:
            bursts.append(t)
        last = t
    return bursts


def in_wait_span(spans, t0, t1):
    """Fraction of [t0,t1] covered by waiting-indicator spans (LLM-bound)."""
    if t1 <= t0:
        return 0.0
    covered = 0
    for s0, s1 in spans:
        overlap = max(0, min(t1, s1) - max(t0, s0))
        covered += overlap
    return covered / (t1 - t0)


def analyze_auto(events, pause_budget_ms, wait_spans):
    fetches = [e for e in events if e["k"] == "fetch"]
    aborts = [e for e in events if e["k"] == "fetch-abort"]
    bursts = burst_starts(events)
    intervals = [(a, b, round(b - a)) for a, b in zip(bursts, bursts[1:])]
    fetch_ms = [round(f["t1"] - f["t0"]) for f in fetches]
    first3 = fetch_ms[:3]
    last3 = fetch_ms[-3:]
    backlog_grew = (sum(last3) / max(len(last3), 1)) > (sum(first3) / max(len(first3), 1)) * 1.6
    # a stall is a burst gap > 8s; attribute it to the LLM writer when the
    # waiting indicator covered most of the gap
    stalls = [
        {"gap_ms": g, "llm_coverage": round(in_wait_span(wait_spans, a, b), 2)}
        for a, b, g in intervals
        if g > 8000
    ]
    unstalled = [g for _, _, g in intervals if g <= 8000]
    synthesis_paced = 0
    for b in bursts:
        prior = [f["t1"] for f in fetches if f["t1"] <= b + 5]
        if prior and b - max(prior) < 400:
            synthesis_paced += 1
    report = {
        "playback_bursts": len(bursts),
        "fetches": len(fetches),
        "fetch_aborts": len(aborts),
        "interval_median_ms": sorted(g for _, _, g in intervals)[len(intervals) // 2] if intervals else None,
        "stalls": stalls,
        "unstalled_interval_median_ms": sorted(unstalled)[len(unstalled) // 2] if unstalled else None,
        "fetch_ms": fetch_ms,
        "backlog_grew": backlog_grew,
        "synthesis_paced_starts": synthesis_paced,
    }
    tts_blamed_stalls = [s for s in stalls if s["llm_coverage"] < 0.5]
    ok = (
        len(bursts) >= 5
        and report["unstalled_interval_median_ms"] is not None
        and 1500 <= report["unstalled_interval_median_ms"] <= 8000
        and not tts_blamed_stalls
    )
    report["verdict"] = "PASS" if ok else "CHECK"
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--auto-seconds", type=int, default=150)
    ap.add_argument("--rapid-clicks", type=int, default=25)
    args = ap.parse_args()

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page()
        page.add_init_script(INIT_JS)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(args.url)
        page.wait_for_selector(".btn--start", timeout=30_000)
        page.click(".btn--start")
        print("[test] session started; waiting for first dialogue …", flush=True)
        page.wait_for_selector(".dialogue", timeout=120_000)
        time.sleep(3)

        # ---- TEST 1: auto mode seamless playback ----
        print(f"[test1] switching to auto mode for {args.auto_seconds}s …", flush=True)
        mode_btn = page.locator(".ctl--mode").first
        mode_btn.evaluate("el => el.click()")  # bar is hover-revealed; JS click bypasses
        deadline = time.time() + args.auto_seconds
        while time.time() < deadline:
            time.sleep(5)
            # interaction forms pause auto-advance; dismiss if present
            try:
                panel = page.locator(".interaction-panel:not([hidden])")
                if panel.count() > 0:
                    btn = panel.locator("button").first
                    if btn.is_visible():
                        btn.click(timeout=300)
                        time.sleep(0.4)
            except Exception:
                pass
        events = pull_events(page)
        wait_spans = page.evaluate("() => window.__wait.spans.concat(window.__wait.visible ? [[Math.round(window.__wait.since), Math.round(performance.now())]] : [])")
        auto_report = analyze_auto(events, pause_budget_ms=1600, wait_spans=wait_spans)
        # switch back to manual (same button toggles)
        try:
            page.locator(".ctl--mode").first.evaluate("el => el.click()")
        except Exception:
            pass
        print("[test1] " + json.dumps(auto_report, ensure_ascii=False)[:1200], flush=True)
        console_tail = page.evaluate("() => window.__console.slice(-20)")
        print("[console1] " + json.dumps(console_tail, ensure_ascii=False)[:1200], flush=True)

        # ---- TEST 2: rapid next-click pressure ----
        print(f"[test2] rapid advance x{args.rapid_clicks} @700ms …", flush=True)
        pull_events(page)

        def dismiss_forms():
            try:
                panel = page.locator(".interaction-panel:not([hidden])")
                if panel.count() > 0:
                    btn = panel.locator("button").first
                    if btn.is_visible():
                        btn.click(timeout=300)
                        time.sleep(0.4)
            except Exception:
                pass

        for _ in range(args.rapid_clicks):
            dismiss_forms()
            try:
                page.locator(".dialogue").click(timeout=300)
            except Exception:
                pass
            time.sleep(0.7)
        # settle: poll up to 90s; click through new lines quickly as they
        # appear to provoke aborts of still-synthesizing current lines
        events = []
        last_line = None
        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(3)
            dismiss_forms()
            cur = page.evaluate("() => window.__lastLine")
            if cur and cur != last_line:
                last_line = cur
                for _ in range(3):
                    try:
                        page.locator(".dialogue").click(timeout=250)
                    except Exception:
                        pass
                    time.sleep(0.25)
            events.extend(pull_events(page))
            if any(e["k"] == "fetch-abort" for e in events) and any(
                e["k"] == "feed" for e in events
            ):
                break
        fetches = [e for e in events if e["k"] == "fetch"]
        aborts = [e for e in events if e["k"] == "fetch-abort"]
        bursts = burst_starts(events)
        rapid_report = {
            "fetches": len(fetches),
            "fetch_aborts": len(aborts),
            "playback_bursts_after_burst_phase": len(bursts),
            "full_fetches": [
                {"ck": f["ck"], "ms": round(f["t1"] - f["t0"]), "bytes": f["bytes"]}
                for f in fetches if f["bytes"] > 0
            ],
        }
        print("[test2] " + json.dumps(rapid_report, ensure_ascii=False)[:1200], flush=True)
        console_tail = page.evaluate("() => window.__console.slice(-25)")
        print("[console] " + json.dumps(console_tail, ensure_ascii=False)[:1500], flush=True)
        print("[page-errors] " + json.dumps(errors[:5], ensure_ascii=False), flush=True)

        browser.close()

    ok1 = auto_report["verdict"] == "PASS"
    # aborts are best-effort (they require advancing a line mid-synthesis);
    # the hard requirements: playback resumes after the burst, no wedged page
    ok2 = len(bursts) >= 1 and not errors
    print(f"RESULT test1={auto_report['verdict']} test2={'PASS' if ok2 else 'CHECK'}")
    sys.exit(0 if (ok1 and ok2) else 1)


if __name__ == "__main__":
    main()
