import "dotenv/config";
import { loadApiKey, loadAuthorConfig, loadConfig } from "./config.js";
import { Game } from "./game.js";
import { StoryGenerator } from "./llm.js";
import { MediaPrefetchScheduler } from "./media.js";
import { loadPrompts } from "./prompts.js";
import { Metrics } from "./runtime/metrics.js";
import { RuntimeStatus } from "./status.js";
import { TerminalUI, UserExitError } from "./ui.js";

function parseArgs(argv: string[]): { configPath: string; webMode: boolean; port: number } {
  let configPath = "config.yaml";
  let webMode = false;
  let port = 3000;

  for (const arg of argv) {
    if (arg === "--web") {
      webMode = true;
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10) || 3000;
    } else if (!arg.startsWith("--") && arg.endsWith(".yaml")) {
      configPath = arg;
    }
  }

  return { configPath, webMode, port };
}

async function main(): Promise<void> {
  const { configPath, webMode, port } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const authorConfig = await loadAuthorConfig("prompts/author.yaml");
  const { bundle, instructions } = await loadPrompts("prompts");
  const apiKey = loadApiKey(config);
  const status = new RuntimeStatus();
  const metrics = new Metrics();
  const generator = new StoryGenerator(config, bundle, instructions, apiKey, authorConfig, metrics);
  const media = new MediaPrefetchScheduler(config.media.audio, status);

  // TUI mode (default)
  const ui = new TerminalUI(config.game.show_line_ids);
  const game = new Game(config, generator, status, ui, media, metrics);

  if (webMode) {
    // Web mode: wrap game with GameBridge (replaces UI with WebUI internally)
    const { GameBridge } = await import("./ui/web/game-bridge.js");
    const bridge = new GameBridge(config, generator, game);
    await bridge.start(port);
  } else {
    await game.run();
    printMetrics(game);
  }
}

function printMetrics(game: Game): void {
  const snap = game.getMetrics();
  console.log("\n═══════ 运行指标汇总 ═══════");

  console.log("\n── LLM 请求 ──");
  console.log(`  开场生成：     ${snap.llm.requests.opening}`);
  console.log(`  分支预取：     ${snap.llm.requests.branch_prefetch}`);
  console.log(`  剧情续写：     ${snap.llm.requests.continuation}`);
  console.log(`  自动补全：     ${snap.llm.requests.autocomplete}`);
  console.log(`  推测生成：     ${snap.llm.requests.speculative}`);

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

  console.log("\n── 自动补全 ──");
  console.log(`  接受：         ${snap.autocomplete.accepted}`);
  console.log(`  忽略：         ${snap.autocomplete.ignored}`);
  console.log(`  接受率：       ${(snap.autocomplete.acceptance_rate * 100).toFixed(1)}%`);

  console.log("\n── 资源浪费 ──");
  console.log(`  浪费文本(bytes)：${snap.waste.text_bytes}`);
  console.log(`  浪费音频(文件)： ${snap.waste.audio_files}`);

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
  if (error instanceof UserExitError) {
    console.log("\n游戏已退出。");
    process.exitCode = 130;
    return;
  }

  console.error("\n启动或运行失败：");
  console.error(error);
  process.exitCode = 1;
});
