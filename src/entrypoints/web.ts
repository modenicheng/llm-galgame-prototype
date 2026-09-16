/**
 * Web entrypoint — the single local Node process hosting the browser UI
 * (§6). Usage: `tsx src/entrypoints/web.ts [--dev] [--game <id>] [config.yaml]`.
 */
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createRuntimeApplication } from "../bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../hosts/local-web/local-web-host.js";
import {
  readLastGameId,
  resolveExplicitGameId,
  writeLastGameId,
} from "../hosts/local-web/last-game.js";

function parseArgs(argv: string[]): {
  dev: boolean;
  configPath: string;
  game: string | undefined;
} {
  let dev = false;
  let configPath = "config.yaml";
  let game: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dev") {
      dev = true;
    } else if (arg === "--game") {
      game = argv[i + 1];
      if (game === undefined) {
        throw new Error("--game 需要一个世界 id 参数");
      }
      i += 1;
    } else if (!arg.startsWith("--") && arg.endsWith(".yaml")) {
      configPath = arg;
    }
  }
  return { dev, configPath, game };
}

async function main(): Promise<void> {
  const { dev, configPath, game } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  // M5.0：世界身份解析顺序 显式参数 > 环境变量 > games/.last-game；都缺
  // 则开新世界。世界落定后写回 .last-game（best-effort），下次启动续玩。
  const gamesRoot = "games";
  const gameId = resolveExplicitGameId(game, process.env) ?? readLastGameId(gamesRoot);
  const app = await createRuntimeApplication({
    config,
    configPath,
    ...(gameId !== undefined ? { gameId } : {}),
  });
  writeLastGameId(gamesRoot, app.gameId);
  const host = new LocalWebHost({
    config,
    app,
    dev,
    logger: (line) => console.log(line),
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
