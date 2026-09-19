import "dotenv/config";
import { loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { createRuntimeApplication } from "../bootstrap/create-runtime-application.js";
import type { RuntimeApplication } from "../application/runtime-application.js";
import { RestartRequestedError, RuntimeShutdownError } from "../core/runtime/errors.js";
import type { Game } from "../game.js";
import type { Metrics } from "../runtime/metrics.js";
import { CliController } from "../apps/cli/cli-controller.js";
import { TerminalUI, UserExitError } from "../apps/cli/terminal-ui.js";
import { resolveExplicitGameId } from "../hosts/local-web/last-game.js";
import { WorldGenerator } from "../application/world/world-generator.js";
import { OutlineWriterAdapter } from "../adapters/llm/outline-writer-adapter.js";
import { loadApiKey } from "../config.js";
import { loadAssetCatalog } from "../application/assets/asset-catalog-loader.js";
import { loadCharacterPackRoster } from "../adapters/static/character-pack-loader.js";

function parseArgs(argv: string[]): {
  configPath: string;
  debugRuntime: boolean;
  game: string | undefined;
  newWorld: string | undefined;
} {
  let configPath = "config.yaml";
  let debugRuntime = false;
  let game: string | undefined;
  let newWorld: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--debug-runtime") {
      debugRuntime = true;
    } else if (arg === "--new-world") {
      newWorld = argv[i + 1];
      if (newWorld === undefined) {
        throw new Error("--new-world 需要一个世界描述参数");
      }
      i += 1;
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

  return { configPath, debugRuntime, game, newWorld };
}

async function main(): Promise<void> {
  const { configPath, debugRuntime, game, newWorld } = parseArgs(process.argv.slice(2));
  const config: AppConfig = await loadConfig(configPath);
  // M5.0：CLI 显式指定世界（参数 > 环境变量）；不读写 .last-game（那是
  // local-web 的「继续游戏」通道）。都缺 → 开新世界。
  let gameId = resolveExplicitGameId(game, process.env);
  // M3.3 直通开玩：--new-world "<描述>" → 编剧生成世界 → 立即在该世界开局。
  // M1：创建前校验需要素材目录（spriteBinding 引用）与 author 角色表。
  if (gameId === undefined && newWorld !== undefined) {
    const worldAssets = await loadAssetCatalog(config.assets.catalog);
    // C7：author 角色表 = 静态名册 characters.yaml（M1 真源；资产目录
    // characters 兼容形状已移除）。
    const authorRoster = await loadCharacterPackRoster("characters.yaml");
    const worldService = new WorldGenerator({
      writer: new OutlineWriterAdapter({ apiKey: loadApiKey(config), api: config.api }),
      assets: worldAssets,
      authorCharacterIds: authorRoster.characters.map((definition) => definition.id),
    });
    const generated = await worldService.generate({ userText: newWorld });
    console.log(`已生成新世界：${generated.gameId}`);
    gameId = generated.gameId;
  }
  const app: RuntimeApplication = await createRuntimeApplication({
    configPath,
    config,
    ...(gameId !== undefined ? { gameId } : {}),
  });

  const ui = new TerminalUI(
    config.game.show_line_ids,
    debugRuntime || config.debug.runtime_status,
  );
  const controller = new CliController(ui, config);
  controller.attach(app.game);

  try {
    await controller.run();
  } catch (error) {
    if (error instanceof RestartRequestedError) {
      console.log("CLI 暂不支持会话内重启，请重新启动进程。");
      return;
    }
    throw error;
  }
  printMetrics(app.game, app.metrics);
}

/**
 * Render the metrics summary. `game` is retained for call-site parity with
 * the pre-refactor host; the snapshot comes from the shared metrics
 * instance the Game was composed with (identical data to `game.getMetrics()`).
 */
function printMetrics(game: Game, metrics: Metrics): void {
  const snap = metrics.snapshot();
  console.log("\n═══════ 运行指标汇总 ═══════");

  console.log("\n── LLM 请求 ──");
  console.log(`  开场生成：     ${snap.llm.requests.opening}`);
  console.log(`  分支预取：     ${snap.llm.requests.branch_prefetch}`);
  console.log(`  剧情续写：     ${snap.llm.requests.continuation}`);

  console.log("\n── Token 用量 ──");
  console.log(`  输入 token：   ${snap.llm.tokens.input}`);
  console.log(`  输出 token：   ${snap.llm.tokens.output}`);

  console.log("\n── 生成延迟 (ms) ──");
  console.log(`  样本数：       ${snap.llm.latency_ms.samples}`);
  console.log(`  P50：          ${snap.llm.latency_ms.p50}`);
  console.log(`  P95：          ${snap.llm.latency_ms.p95}`);
  console.log(`  最大：         ${snap.llm.latency_ms.max}`);

  console.log("\n── 分支预取 ──");
  console.log(`  请求分支数：   ${snap.prefetch.branches_requested}`);
  console.log(`  命中：         ${snap.prefetch.branches_hit}`);
  console.log(`  未命中：       ${snap.prefetch.branches_missed}`);
  console.log(`  命中率：       ${(snap.prefetch.hit_rate * 100).toFixed(1)}%`);

  console.log("\n── 输入 ──");
  console.log(`  预览次数：     ${snap.input.preview_count}`);
  console.log(`  平均停留(ms)： ${snap.input.avg_dwell_ms.toFixed(0)}`);
  console.log(`  确认→首行 样本数：${snap.input.confirm_to_first_response_line_ms.length}`);
  if (snap.input.confirm_to_first_response_line_ms.length > 0) {
    const avg =
      snap.input.confirm_to_first_response_line_ms.reduce((a, b) => a + b, 0) /
      snap.input.confirm_to_first_response_line_ms.length;
    console.log(`  确认→首行 平均(ms)：${avg.toFixed(0)}`);
  }
  console.log(`  bridge 覆盖 样本数：${snap.input.bridge_cover_duration_ms.length}`);
  if (snap.input.bridge_cover_duration_ms.length > 0) {
    const avg =
      snap.input.bridge_cover_duration_ms.reduce((a, b) => a + b, 0) /
      snap.input.bridge_cover_duration_ms.length;
    console.log(`  bridge 覆盖 平均(ms)：${avg.toFixed(0)}`);
  }
  console.log(`  回应欠载次数： ${snap.input.response_underrun_count}`);
  console.log(`  回应取消次数： ${snap.input.response_canceled_count}`);
  console.log(`  迟到事件丢弃： ${snap.input.stale_input_event_dropped_count}`);
  console.log(`  直播接管次数： ${snap.input.response_promoted_live_count}`);

  console.log("\n── 错误 ──");
  console.log(`  Schema 校验失败：${snap.errors.schema_validation_failures}`);

  console.log("\n── 玩家时机 ──");
  if (snap.player.choice_to_next_line_ms.length > 0) {
    const avg = snap.player.choice_to_next_line_ms.reduce((a, b) => a + b, 0) / snap.player.choice_to_next_line_ms.length;
    console.log(`  选择→首行 样本数：${snap.player.choice_to_next_line_ms.length}`);
    console.log(`  选择→首行 平均(ms)：${avg.toFixed(0)}`);
  } else {
    console.log("  (无数据)");
  }

  console.log("\n══════════════════════════════");
}

main().catch((error: unknown) => {
  process.stdout.write("\x1b[?25h");
  if (error instanceof UserExitError || error instanceof RuntimeShutdownError) {
    console.log("\n游戏已退出。");
    process.exitCode = 130;
    return;
  }

  console.error("\n启动或运行失败：");
  console.error(error);
  process.exitCode = 1;
});
