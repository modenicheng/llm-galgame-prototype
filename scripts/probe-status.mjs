import "dotenv/config";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../src/hosts/local-web/local-web-host.js";
import WebSocket from "ws";

const app = await createRuntimeApplication({ configPath: "config.yaml" });
const config = { ...app.config, local_web: { ...app.config.local_web, open_browser: false } };
const host = new LocalWebHost({ config, app, dev: false, logger: () => {} });
const { url } = await host.start();
const port = new URL(url).port;
const token = host.getToken();

// Register a descriptor so the route validates.
app.audioCatalog.upsertDescriptor(
  { lineId: "line_probe_001", cacheKey: "sha256:probekey", scope: { type: "active" }, priority: "current",
    speakerId: "suyao", displaySpeaker: "苏遥", format: { encoding: "pcm_s16le", sampleRate: 22050, channels: 1 } },
  { lineId: "line_probe_001", cacheKey: "sha256:probekey", text: "测试。", model: "m", voiceId: "v",
    voiceRevision: 0, rate: 1, pitch: 1, volume: 1, seed: 1, pauseBeforeMs: 0, pauseAfterMs: 0 },
);

// ALSO subscribe directly to task statuses at the app level.
const statuses = [];
app.taskStatusSubscribe((e) => { statuses.push(e); console.log("APP STATUS:", JSON.stringify(e)); });

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runtime?token=${token}`, { origin: `http://127.0.0.1:${port}` });
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "audio.task_status") console.log("WS STATUS:", JSON.stringify(m));
});
await new Promise((r) => ws.on("open", r));

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${port}/api/audio/synthesize`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Session-Token": token },
  body: JSON.stringify({ taskId: "probe", lineId: "line_probe_001", cacheKey: "sha256:probekey" }),
});
console.log("fetch status", res.status);
const reader = res.body.getReader();
let bytes = 0;
while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; }
console.log("streamed", bytes, "bytes in", Date.now() - t0, "ms; app statuses so far:", JSON.stringify(statuses));
await new Promise((r) => setTimeout(r, 2500));
console.log("final app statuses:", JSON.stringify(statuses));
await host.shutdown();
process.exit(0);
