// Author-run live verification: synthesizes one line with the configured
// voice (model + voice-id from voices.yaml + .env). The protocol is selected
// by model family (see src/core/ports/tts-model-family.ts):
//   - cosyvoice* / qwen-audio*  → SpeechSynthesizer SSE (params in input, raw PCM)
//   - qwen3-tts*                → multimodal-generation SSE (text/voice only,
//                                 WAV stream → header stripped, 24 kHz PCM)
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

const isQwen3 = String(binding.model).startsWith("qwen3-tts");
const body = isQwen3
  ? { model: binding.model, input: { text, voice: voiceId } }
  : {
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
const baseUrl = isQwen3
  ? (process.env.DASHSCOPE_QWEN3_TTS_BASE_URL ??
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")
  : (process.env.DASHSCOPE_TTS_BASE_URL ??
    "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");

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

// qwen3 streams may carry a WAV container header (qwen3-tts-flash) or be
// headerless raw PCM (instruct models); strip the header when present.
let wavBuffer = Buffer.alloc(0);
let wavOffset = -2; // -2 = undecided, -1 = header still incomplete, ≥0 = decided
let sampleRate = isQwen3 ? 24000 : 22050;
function pcmBytes(decoded) {
  if (!isQwen3) return decoded;
  if (wavOffset >= 0) return decoded;
  wavBuffer = wavBuffer.length === 0 ? decoded : Buffer.concat([wavBuffer, decoded]);
  if (wavOffset === -2) {
    if (wavBuffer.length < 4) return Buffer.alloc(0);
    if (wavBuffer.toString("ascii", 0, 4) !== "RIFF") {
      wavOffset = 0; // headerless raw PCM — pass everything through
      return wavBuffer;
    }
    wavOffset = -1;
  }
  let pos = 12;
  for (;;) {
    if (pos + 8 > wavBuffer.length) return Buffer.alloc(0);
    const id = wavBuffer.toString("ascii", pos, pos + 4);
    const size = wavBuffer.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      sampleRate = wavBuffer.readUInt32LE(pos + 12);
      pos += 8 + size + (size % 2);
      continue;
    }
    if (id === "data") {
      wavOffset = pos + 8;
      return wavBuffer.subarray(wavOffset);
    }
    pos += 8 + size + (size % 2);
  }
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
      if (event.code && event.code !== 200) {
        console.error(`SSE error event: ${line.slice(0, 400)}`);
        process.exit(1);
      }
      const audio = event.output?.audio?.data;
      if (typeof audio === "string" && audio.length > 0) {
        bytes += pcmBytes(Buffer.from(audio, "base64")).byteLength;
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
      bytes += pcmBytes(Buffer.from(audio, "base64")).byteLength;
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
console.log(`OK: ${bytes} PCM bytes (${profileId}: ${voiceId} @${sampleRate}Hz), first chunk at ${firstChunkMs}ms`);
