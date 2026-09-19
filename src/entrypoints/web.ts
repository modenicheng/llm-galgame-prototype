/**
 * Web entrypoint — the single local Node process hosting the browser UI
 * (§6). Usage: `tsx src/entrypoints/web.ts [--dev] [config.yaml]`.
 */
import "dotenv/config";
import path from "node:path";
import { loadConfig } from "../config.js";
import { AudioDspStore, loadAudioDspConfig, type AudioDspLogger } from "../config/audio-dsp.js";
import { createRuntimeApplication } from "../bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../hosts/local-web/local-web-host.js";

function parseArgs(argv: string[]): { dev: boolean; configPath: string } {
  let dev = false;
  let configPath = "config.yaml";
  for (const arg of argv) {
    if (arg === "--dev") {
      dev = true;
    } else if (!arg.startsWith("--") && arg.endsWith(".yaml")) {
      configPath = arg;
    }
  }
  return { dev, configPath };
}

async function main(): Promise<void> {
  const { dev, configPath } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const app = await createRuntimeApplication({ config, configPath });
  // audio-dsp.yaml 与 config.yaml 同目录（程序所有的 sidecar，见
  // config/audio-dsp.ts；缺文件用默认参数，首次保存自动创建）。
  const audioDspPath = path.join(path.dirname(path.resolve(configPath)), "audio-dsp.yaml");
  const dspLog: AudioDspLogger = { info: (l) => console.log(l), warn: (l) => console.error(l) };
  const audioDsp = new AudioDspStore(audioDspPath, await loadAudioDspConfig(audioDspPath, dspLog), dspLog);
  const host = new LocalWebHost({
    config,
    app,
    dev,
    logger: (line) => console.log(line),
    audioDsp,
  });
  const { url } = await host.start();
  console.log(`listening ${url}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    await host.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
