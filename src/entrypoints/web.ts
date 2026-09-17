/**
 * Web entrypoint — the single local Node process hosting the browser UI
 * (§6). Usage: `tsx src/entrypoints/web.ts [--dev] [--game <id>] [config.yaml]`.
 */
import "dotenv/config";
import { loadConfig, loadApiKey } from "../config.js";
import { createRuntimeApplication, DEFAULT_GAMES_ROOT } from "../bootstrap/create-runtime-application.js";
import { LocalWebHost } from "../hosts/local-web/local-web-host.js";
import {
  readLastGameId,
  resolveExplicitGameId,
  writeLastGameId,
} from "../hosts/local-web/last-game.js";
import { WorldGenerator } from "../application/world/world-generator.js";
import { OutlineWriterAdapter } from "../adapters/llm/outline-writer-adapter.js";
import { GameGraphStore } from "../adapters/storage/game-graph-store.js";
import { OutlineStore } from "../adapters/storage/outline-store.js";
import { buildGraphView } from "../application/graph/graph-view.js";

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
  const gameId =
    resolveExplicitGameId(game, process.env) ?? readLastGameId(DEFAULT_GAMES_ROOT);
  const app = await createRuntimeApplication({
    config,
    configPath,
    ...(gameId !== undefined ? { gameId } : {}),
  });
  writeLastGameId(DEFAULT_GAMES_ROOT, app.gameId);
  // M3.3 直通开玩：POST /api/worlds → 生成世界 → 装配新 RuntimeApplication
  // → 宿主进程内换绑。生成失败大声报错（500 透传），不回退旧世界。
  const worldService = new WorldGenerator({
    writer: new OutlineWriterAdapter({ apiKey: loadApiKey(config), api: config.api }),
    gamesRoot: DEFAULT_GAMES_ROOT,
  });
  const host = new LocalWebHost({
    config,
    app,
    dev,
    logger: (line) => console.log(line),
    worlds: {
      create: async (text) => {
        const { gameId } = await worldService.generate({ userText: text });
        const nextApp = await createRuntimeApplication({
          config,
          configPath,
          gameId,
        });
        writeLastGameId(DEFAULT_GAMES_ROOT, gameId);
        return { gameId, app: nextApp };
      },
    },
    // M5.1：图视图通道（脱敏装配在 graph-view.ts）。
    graph: {
      build: (gameId) =>
        buildGraphView({
          gameId,
          graph: new GameGraphStore(DEFAULT_GAMES_ROOT, gameId),
          outline: new OutlineStore(DEFAULT_GAMES_ROOT, gameId),
        }),
    },
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
