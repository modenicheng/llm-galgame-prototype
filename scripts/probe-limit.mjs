import "dotenv/config";
import WebSocket from "ws";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../src/hosts/local-web/local-web-host.js";

const app = await createRuntimeApplication({ configPath: "config.yaml" });
const config = { ...app.config, local_web: { ...app.config.local_web, open_browser: false } };
const host = new LocalWebHost({ config, app, dev: false, logger: () => {} });
const { url } = await host.start();
const port = new URL(url).port;
const token = host.getToken();
const wsUrl = `ws://127.0.0.1:${port}/ws/runtime?token=${token}`;

function connect() {
  return new Promise((resolve) => {
    const w = new WebSocket(wsUrl, { origin: `http://127.0.0.1:${port}` });
    w.on("open", () => resolve({ result: "open", w }));
    w.on("unexpected-response", (_r, res) => resolve({ result: `rejected ${res.statusCode}`, w }));
    w.on("error", () => {});
    w.on("close", (code, reason) => console.log("  closed:", code, reason.toString()));
  });
}

const first = await connect();
console.log("first:", first.result);
await new Promise((r) => setTimeout(r, 500));
const second = await connect();
console.log("second:", second.result);
await new Promise((r) => setTimeout(r, 500));
const third = await connect();
console.log("third:", third.result);
await host.shutdown();
process.exit(0);
