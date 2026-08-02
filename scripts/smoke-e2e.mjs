// Full E2E smoke: real composition root + real LocalWebHost + real MockStreamingTtsProvider,
// driven by a real ws client. Exercises: WS auth (token), projection snapshot, runtime command,
// TTS stream (PCM bytes), task status, controller limit, and shutdown.
// Run: node scripts/smoke-e2e.mjs
import "dotenv/config";
import WebSocket from "ws";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../src/hosts/local-web/local-web-host.js";

function fail(msg) {
  console.error("SMOKE FAIL:", msg);
  process.exit(1);
}

const app = await createRuntimeApplication({ configPath: "config.yaml" });
// Force mock TTS (config.yaml synthesis.provider=mock already); disable browser open.
const config = { ...app.config, local_web: { ...app.config.local_web, open_browser: false } };
const host = new LocalWebHost({ config, app, dev: false, logger: (l) => console.log("[host]", l) });
const { url } = await host.start();
const port = new URL(url).port;
const token = host.getToken();
console.log(`host on ${url} (token ${token.slice(0, 6)}…)`);

const wsUrl = `ws://127.0.0.1:${port}/ws/runtime?token=${token}`;
const msgs = [];
const ws = new WebSocket(wsUrl, { origin: `http://127.0.0.1:${port}` });

const opened = new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  msgs.push(msg);
  if (msg.type === "projection.snapshot") {
    console.log("2. projection.snapshot:", msg.projection.phase, "recentLines:", msg.projection.recentLines?.length);
  }
  if (msg.type === "runtime.output") {
    console.log("   runtime.output:", msg.output.type, msg.sequence);
  }
  if (msg.type === "session_ended" || msg.type === "runtime_error") { console.log("   SESSION:", JSON.stringify(msg)); }
  if (msg.type === "audio.task_status") {
    console.log("   TASK_STATUS:", JSON.stringify(msg));
  }
});

await opened;
console.log("1. WS opened with token");

await new Promise((r) => setTimeout(r, 1500));
if (!msgs.some((m) => m.type === "projection.snapshot")) fail("no projection.snapshot received");

// Send a runtime command (start is accepted for symmetry).
ws.send(JSON.stringify({
  type: "runtime.command",
  commandId: "smoke-1",
  command: { type: "start" },
}));
await new Promise((r) => setTimeout(r, 800));
console.log("3. sent runtime.command start; outputs received:", msgs.filter((m) => m.type === "runtime.output").length);

// TTS stream: need a valid lineId+cacheKey. The catalog is empty until the game runs;
// instead directly exercise the route with a synthesized descriptor via the app's catalog.
// (A running game would need an LLM key; the mock TTS needs a descriptor.)
// For smoke purposes: register a descriptor through the application's catalog and fetch it.
const { AudioDescriptorFactory } = await import("../src/application/audio/audio-descriptor-factory.js");
const { AudioIntentPlanner } = await import("../src/application/audio/audio-intent-planner.js");
// The composition root already built these; reuse app.audioCatalog via upsert.
const factory = null; // we can't reach the internal factory; use the app's catalog with a manual descriptor
const manualDescriptor = {
  lineId: "line_smoke_001",
  cacheKey: "sha256:smokekey",
  scope: { type: "active" },
  priority: "current",
  speakerId: "suyao",
  displaySpeaker: "苏遥",
  format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 },
};
// The catalog's upsertDescriptor needs a recipe too; use the app's catalog directly.
// This is an integration smoke — the recipe fields must be valid for tts-task-service.
app.audioCatalog.upsertDescriptor(manualDescriptor, {
  lineId: "line_smoke_001",
  cacheKey: "sha256:smokekey",
  text: "测试台词。",
  model: "cosyvoice-v3-flash",
  voiceId: "MOCK_VOICE_suyao",
  voiceRevision: 0,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  seed: 42,
  pauseBeforeMs: 0,
  pauseAfterMs: 0,
});

const synRes = await fetch(`http://127.0.0.1:${port}/api/audio/synthesize`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Session-Token": token },
  body: JSON.stringify({ taskId: "task_smoke_1", lineId: "line_smoke_001", cacheKey: "sha256:smokekey" }),
});
console.log("4. synthesize status:", synRes.status);
console.log("   headers:", JSON.stringify({
  enc: synRes.headers.get("x-audio-encoding"),
  rate: synRes.headers.get("x-audio-sample-rate"),
  ch: synRes.headers.get("x-audio-channels"),
  bits: synRes.headers.get("x-audio-bit-depth"),
  task: synRes.headers.get("x-audio-task-id"),
}));
const reader = synRes.body.getReader();
let bytes = 0, first = true;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (first) { console.log("   first chunk bytes:", value.length); first = false; }
  bytes += value.length;
}
console.log("   total PCM bytes:", bytes);
await new Promise((r) => setTimeout(r, 3000));
const statuses = msgs.filter((m) => m.type === "audio.task_status" && m.taskId === "task_smoke_1");
const finished = statuses.find((m) => m.status === "finished");
console.log("5. task_statuses:", JSON.stringify(statuses));
if (!finished) fail("task_status finished never received");
// Controller limit: second WS should be rejected with close 4001.
const second = await new Promise((resolve) => {
  const ws2 = new WebSocket(wsUrl, { origin: `http://127.0.0.1:${port}` });
  ws2.on("open", () => { /* upgrade succeeds; the close 4001 follows */ });
  ws2.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  ws2.on("error", () => {});
  setTimeout(() => resolve({ code: null, reason: "no close within 3s" }), 3000);
});
console.log("6. second controller:", JSON.stringify(second));
if (second.code !== 4001) fail("second controller not rejected with 4001");

await host.shutdown();
console.log("7. host shutdown clean");
console.log("SMOKE E2E PASS");
process.exit(0);
