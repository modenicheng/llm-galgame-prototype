import "dotenv/config";
import { loadApiKey, loadAuthorConfig, loadConfig } from "./config.js";
import { Game } from "./game.js";
import { StoryGenerator } from "./adapters/llm/openai-compatible-generator.js";
import { NodeJsonlSessionStore } from "./adapters/storage/node-jsonl-session-store.js";
import { ConsoleDiagnosticSink } from "./adapters/platform/console-diagnostic-sink.js";
import { SessionIdGenerator } from "./adapters/platform/session-id-generator.js";
import { SystemClock } from "./adapters/platform/system-clock.js";
import { MediaPrefetchScheduler } from "./media.js";
import { loadPrompts } from "./prompts.js";
import { Metrics } from "./runtime/metrics.js";
import { RuntimeStatus } from "./status.js";
import { CliController } from "./apps/cli/cli-controller.js";
import { TerminalUI, UserExitError } from "./apps/cli/terminal-ui.js";
import { RuntimeShutdownError } from "./game.js";

function parseArgs(argv: string[]): { configPath: string; debugRuntime: boolean } {
  let configPath = "config.yaml";
  let debugRuntime = false;

  for (const arg of argv) {
    if (arg === "--debug-runtime") {
      debugRuntime = true;
    } else if (!arg.startsWith("--") && arg.endsWith(".yaml")) {
      configPath = arg;
    }
  }

  return { configPath, debugRuntime };
}

async function main(): Promise<void> {
  const { configPath, debugRuntime } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const authorConfig = await loadAuthorConfig("prompts/author.yaml");
  const { bundle, instructions } = await loadPrompts("prompts");
  const apiKey = loadApiKey(config);
  const status = new RuntimeStatus();
  const metrics = new Metrics();
  const generator = new StoryGenerator(config, bundle, instructions, apiKey, authorConfig, metrics);
  const media = new MediaPrefetchScheduler(config.media.audio, status);

  const ui = new TerminalUI(
    config.game.show_line_ids,
    debugRuntime || config.debug.runtime_status,
  );
  const game = new Game(config, generator, status, media, metrics, {
    store: new NodeJsonlSessionStore(config.game.sessions_dir),
    clock: new SystemClock(),
    ids: new SessionIdGenerator(),
    diagnostics: new ConsoleDiagnosticSink(),
  });
  const controller = new CliController(ui, config);
  controller.attach(game);

  await controller.run();
  printMetrics(game);
}

function printMetrics(game: Game): void {
  const snap = game.getMetrics();
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
  console.log(`  状态补丁拒绝：    ${snap.errors.state_patch_rejections}`);

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
