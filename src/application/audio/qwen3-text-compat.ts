/**
 * qwen3-text-compat — punctuation compatibility for qwen3-tts synthesis
 * (local qwentts.cpp, the Python fallback engine, and DashScope qwen3-tts*).
 *
 * qwen3-tts has no inline pacing tags of any kind: DashScope's emotion /
 * rich-language tags (`[sad]`, `[laughing]`, …) belong to the separate
 * Qwen-Audio-TTS family, `<break>`/SSML is not supported, and the
 * `instructions` parameter exists only on qwen3-tts-instruct* models as a
 * whole-utterance style hint (never sent on the clone path). Pacing comes
 * from punctuation alone — and marks outside the model's training
 * vocabulary are silently dropped: a 破折号 reads straight through (probe
 * 2026-09-19, engine qwentts.cpp pinned seed: a line-final —— adds only
 * ~0.1 s of decay where …… produces an audible trailing fade; mid-line it
 * yields a ~0.2 s pause, weaker than a comma's ~0.44 s).
 *
 * Adaptation therefore rewrites the dash family into the supported pause
 * vocabulary, with one deliberate counter-example guard: between numerals
 * a dash is a range ("三千——五千"), and inserting a pause there distorts
 * the reading — ranges map to 「到」 instead. Everything else is left
 * untouched on purpose: ～ and · read harmlessly (measured: no garbage
 * syllables, no wrong pauses), and "fixing" them would inject pauses the
 * author never wrote.
 */

export interface Qwen3TextCompatResult {
  /** Adapted text (identical to the input when nothing applied). */
  text: string;
  /** Dash runs rendered as …… (interrupted / trailing prosody). */
  dashToPause: number;
  /** Dashes between numerals rendered as 到 (ranges must not grow a pause). */
  rangeToDao: number;
}

/** Digits + Chinese numerals: the two sides of a "X——Y" range. */
const NUMERALS = "0-9０-９零〇一二两三四五六七八九十百千万亿兆";

/**
 * Dash run: em/en/horizontal-bar/figure/minus/fullwidth hyphen/box-drawing
 * (LLM scene separators) plus ASCII `--`. A single ASCII hyphen is NOT a
 * dash — "well-known" and "10-20" must pass through untouched.
 */
const DASH_RUN = /-{2,}|[—–―‒−－─]+/g;

/** CJK ideographs + CJK/fullwidth punctuation blocks. */
const CJK = "\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef";

export function adaptQwen3TtsText(input: string): Qwen3TextCompatResult {
  let dashToPause = 0;
  let rangeToDao = 0;

  // Range first, so "三千——五千" never reaches the pause rewrite.
  const rangeRe = new RegExp(
    `([${NUMERALS}])[ \\t]*(?:-{2,}|[—–―‒−－─]+)[ \\t]*([${NUMERALS}])`,
    "g",
  );
  let text = input.replace(rangeRe, (_m, left: string, right: string) => {
    rangeToDao += 1;
    return `${left}到${right}`;
  });

  text = text.replace(DASH_RUN, () => {
    dashToPause += 1;
    return "……";
  });

  if (dashToPause > 0) {
    // "愣了一下 —— 转身" → "愣了一下……转身": a stray space around the
    // inserted mark would read as a breath inside CJK. Latin neighbors
    // keep their spacing (rare in dialogue; harmless either way).
    const stripSpaces = new RegExp(
      `([${CJK}])[ \\t]*(……)[ \\t]*(?![A-Za-z0-9])`,
      "g",
    );
    text = text.replace(stripSpaces, "$1$2");
    // A dash parked next to an existing ellipsis ("……——") must not stack.
    text = text.replace(/(?:……)+/g, "……");
  }

  return { text, dashToPause, rangeToDao };
}
