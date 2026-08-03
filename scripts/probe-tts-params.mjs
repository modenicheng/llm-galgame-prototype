// Author-run live verification: synthesizes one line with the configured
// voice (model + voice-id from voices.yaml + .env) through the official
// SpeechSynthesizer SSE endpoint.
// Usage: node scripts/probe-tts-params.mjs <profile-id> [text]
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const profileId = process.argv[2] ?? "suyao_main";
const text = process.argv[3] ?? "苏遥轻轻地笑了。";
const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  console.error("DASHSCOPE_API_KEY is not set");
  process.exit(1);
}

const voices = parse(await readFile("voices.yaml", "utf8"));
const profile = voices.profiles?.[profileId];
const binding = profile?.providers?.dashscope;
if (!binding) {
  console.error(`profile "${profileId}" has no dashscope binding`);
  process.exit(1);
}
const voiceId = process.env[binding.voice_id_env];
if (!voiceId) {
  console.error(`env var ${binding.voice_id_env} is not set for profile "${profileId}"`);
  process.exit(1);
}

const body = {
  model: binding.model,
  input: {
    text,
    voice: voiceId,
    format: "pcm",
    sample_rate: 22050,
    rate: 1,
    pitch: 1,
    volume: 50,
    seed: 42,
  },
};
const baseUrl =
  process.env.DASHSCOPE_TTS_BASE_URL ??
  "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";

const response = await fetch(baseUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-DashScope-SSE": "enable",
  },
  body: JSON.stringify(body),
});
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  process.exit(1);
}

// SSE parsing with a cross-chunk line buffer: JSON lines may span network
// chunks, so keep the partial line and re-join on the next read.
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let bytes = 0;
let firstChunkMs = null;
const start = Date.now();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5));
      const audio = event.output?.audio?.data;
      if (typeof audio === "string" && audio.length > 0) {
        bytes += Buffer.from(audio, "base64").byteLength;
        if (firstChunkMs === null) firstChunkMs = Date.now() - start;
      }
    } catch {
      // ignore keep-alives / partial JSON that slipped through
    }
  }
}
if (buffer.startsWith("data:")) {
  try {
    const event = JSON.parse(buffer.slice(5));
    const audio = event.output?.audio?.data;
    if (typeof audio === "string" && audio.length > 0) {
      bytes += Buffer.from(audio, "base64").byteLength;
      if (firstChunkMs === null) firstChunkMs = Date.now() - start;
    }
  } catch {
    // ignore
  }
}
if (bytes === 0) {
  console.error(`no audio bytes received — voice-id "${voiceId}" vs model "${binding.model}"?`);
  process.exit(1);
}
console.log(`OK: ${bytes} PCM bytes (${profileId}: ${voiceId}), first chunk at ${firstChunkMs}ms`);
