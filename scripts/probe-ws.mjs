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
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/runtime?token=${token}`, { origin: `http://127.0.0.1:${port}` });
ws.on("open", () => console.log("OPEN"));
ws.on("message", (d) => console.log("MSG:", d.toString().slice(0, 120)));
ws.on("error", (e) => console.log("ERR:", e.message));
ws.on("close", (c, r) => console.log("CLOSE:", c, r.toString()));
setTimeout(async () => { await host.shutdown(); process.exit(0); }, 2500);
