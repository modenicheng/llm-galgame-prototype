// 输入确认时序探针（真实 API）：验证自由输入的「分支预测」调度——
//   输入 → Enter(preview_input) → 预览打开(零阻塞) 且后台开始生成
//       → 确认(confirm_input) → 玩家台词 → bridge → 生成台词
//   Esc(cancel_input) → 生成中止、交互原样重开。
//
// 驱动一局：快进到第一个 input/hybrid 交互，对该交互做两轮 preview：
//   第 1 轮预览打开后立即取消（验证取消回编辑）；
//   第 2 轮预览打开后停留 ~1.5s 再确认（验证预测生成收益），
// 之后等 input_response attempt 结束即 shutdown。
//
// 用法：pnpm exec tsx scripts/probe-input-timing.mjs [--dwell-ms 1500]
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { RuntimeShutdownError } from "../src/game.js";

function parseArgs(argv) {
  const out = { dwellMs: 1500, maxWaitMin: 12 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dwell-ms") out.dwellMs = Number(argv[++i]);
    if (argv[i] === "--max-wait-min") out.maxWaitMin = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const PLAYER_SPEAKER = "你";

const report = {
  sessionId: null,
  targetInteraction: null, // { id, mode, prompt }
  rounds: [], // 每轮 preview：{ round, action, previewOpenLatencyMs, ... }
  speculative: [], // input_response attempts：{ attemptId, startedAt, ttftMs, latencyMs, state }
  playbackAfterConfirm: [], // { kind, speaker, dtMs }
  stallsAfterConfirm: [], // { kind, gapMs }
  cancelReopen: null, // { sameInteraction, reopenLatencyMs }
  metricsInput: null,
  errors: [],
};

const state = {
  phase: "warmup", // warmup → armed → cancel-preview → confirm-preview → committed → draining
  interactionId: null,
  previewSentAt: null,
  previewRound: 0,
  confirmSentAt: null,
  advanceSentAt: null,
  lastPlaybackAt: null,
  seenResponseLine: false,
  responseAttemptIds: new Set(),
  finishedAttemptIds: new Set(),
  shutdownScheduled: false,
};

const config = await loadConfig("config.yaml");
config.generation.thinking = { type: "disabled" };
const app = await createRuntimeApplication({
  configPath: "config.yaml",
  config,
  sessionId: `probe-input-${Date.now().toString(36)}`,
});
report.sessionId = app.game.sessionId ?? null;

// ---------------------------------------------------------------------------
// 监控事件：抓 input_response attempt 的启动/首字/时延（预测证据链）
// ---------------------------------------------------------------------------
app.monitor?.subscribe((message) => {
  if (message.type !== "monitor.event") return;
  for (const ev of message.events) {
    if (ev.type === "writer.start" && ev.task?.taskType === "input_response") {
      const attempt = ev.task.attempts.at(-1);
      if (attempt) {
        state.responseAttemptIds.add(attempt.attemptId);
        report.speculative.push({
          attemptId: attempt.attemptId,
          startedAt: attempt.startedAt,
          ttftMs: null,
          latencyMs: null,
          state: null,
        });
      }
    } else if (ev.type === "writer.delta" && ev.firstTokenMs != null) {
      const row = report.speculative.find((r) => r.attemptId === ev.attemptId);
      if (row && row.ttftMs == null) row.ttftMs = ev.firstTokenMs;
    } else if (ev.type === "writer.usage") {
      const row = report.speculative.find((r) => r.attemptId === ev.attemptId);
      if (row) row.latencyMs = ev.usage.latencyMs;
    } else if (ev.type === "writer.end") {
      const row = report.speculative.find((r) => r.attemptId === ev.attemptId);
      if (row) {
        row.state = ev.state;
        state.finishedAttemptIds.add(ev.attemptId);
        maybeFinish();
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 游戏输出驱动
// ---------------------------------------------------------------------------
function dispatchPreview(text) {
  state.previewSentAt = Date.now();
  app.game.dispatch({
    type: "preview_input",
    interactionId: state.interactionId,
    text,
  });
}

const INPUT_TEXTS = [
  "好，我帮你一起弄，弄完你就能去准备了。",
  "那我们先检查供电线路吧，我带了万用表。",
];

app.game.subscribe((output) => {
  try {
    handle(output);
  } catch (e) {
    report.errors.push({ code: "driver", message: String(e) });
  }
});

function handle(output) {
  switch (output.type) {
    case "playback_ready": {
      const ev = output.event;
      if (state.phase === "warmup") {
        // 快进：立即翻页冲向第一个交互。
        app.game.dispatch({ type: "advance" });
      } else if (state.phase === "committed") {
        const dtMs = Date.now() - state.confirmSentAt;
        // 停顿 = advance（或 confirm）发出到 playback_ready 到达的等待；
        // 探针自身 400ms 翻页节奏不计入。
        const waitSince = state.advanceSentAt ?? state.confirmSentAt;
        const waitMs = Date.now() - waitSince;
        if (waitMs > 300) report.stallsAfterConfirm.push({ kind: ev.type, gapMs: waitMs });
        state.lastPlaybackAt = Date.now();
        const isPlayerLine = ev.type === "player_dialogue" ||
          (ev.type === "dialogue" && ev.speaker === PLAYER_SPEAKER);
        report.playbackAfterConfirm.push({
          kind: ev.type,
          speaker: ev.speaker ?? "",
          dtMs,
        });
        if (!state.seenResponseLine && !isPlayerLine && ev.type === "dialogue") {
          state.seenResponseLine = true;
          report.rounds.at(-1).confirmToFirstResponseMs = dtMs;
        }
        // manual 模式播放靠 advance 驱动：推进直到看到回应首行。
        if (!state.seenResponseLine) {
          setTimeout(() => {
            state.advanceSentAt = Date.now();
            app.game.dispatch({ type: "advance" });
          }, 400);
        }
        maybeFinish();
      }
      break;
    }
    case "interaction_opened": {
      const it = output.interaction;
      const acceptsInput = it.type !== "choice" && it.mode !== "choice";
      if (state.phase === "warmup") {
        if (!acceptsInput) {
          // 纯选项交互：代选第一项，继续快进到 input/hybrid。
          const options = it.options ?? [];
          if (options.length > 0) {
            console.log(`[${stamp()}] 跳过选项交互，代选「${options[0].text?.slice(0, 20)}」`);
            setTimeout(
              () =>
                app.game.dispatch({
                  type: "select_choice",
                  interactionId: output.interactionId,
                  optionId: options[0].id,
                }),
              30,
            );
          }
          break;
        }
        state.phase = "armed";
        state.interactionId = output.interactionId;
        state.previewRound = 0;
        report.targetInteraction = {
          id: output.interactionId,
          mode: it.mode ?? it.type,
          prompt: it.prompt ?? "",
        };
        console.log(`[${stamp()}] 目标交互 ${it.mode ?? it.type}："${(it.prompt ?? "").slice(0, 40)}"`);
        setTimeout(() => {
          state.previewRound = 1;
          state.phase = "cancel-preview";
          report.rounds.push({ round: 1, action: "cancel" });
          dispatchPreview(INPUT_TEXTS[0]);
          console.log(`[${stamp()}] R1 preview_input（将取消）`);
        }, 30);
      } else if (
        (state.phase === "cancel-round" || state.phase === "cancel-preview") &&
        output.interactionId === state.interactionId
      ) {
        // 取消后交互原样重开 → 立即发起第 2 轮 preview（确认轮）。
        const cancelRow = report.rounds.find((r) => r.action === "cancel");
        if (cancelRow && state.previewSentAt !== null && cancelRow.reopenLatencyMs === undefined) {
          cancelRow.reopenLatencyMs = Date.now() - cancelRow.canceledAt;
          report.cancelReopen = {
            sameInteraction: output.interactionId === state.interactionId,
            reopenLatencyMs: cancelRow.reopenLatencyMs,
          };
          console.log(`[${stamp()}] 取消后交互重开（+${cancelRow.reopenLatencyMs}ms）→ R2 preview_input`);
          state.previewRound = 2;
          state.phase = "confirm-preview";
          report.rounds.push({ round: 2, action: "confirm" });
          setTimeout(() => dispatchPreview(INPUT_TEXTS[1]), 30);
        }
      }
      break;
    }
    case "input_preview_opened": {
      const row = report.rounds.at(-1);
      if (row) row.previewOpenLatencyMs = Date.now() - state.previewSentAt;
      console.log(`[${stamp()}] R${state.previewRound} 预览打开（+${row?.previewOpenLatencyMs}ms）`);
      if (state.phase === "cancel-preview") {
        state.phase = "cancel-round";
        setTimeout(() => {
          app.game.dispatch({ type: "cancel_input", previewId: output.previewId });
          const cancelRow = report.rounds.find((r) => r.action === "cancel");
          cancelRow.canceledAt = Date.now();
          console.log(`[${stamp()}] R1 cancel_input（Esc 等价）`);
        }, 120);
      } else if (state.phase === "confirm-preview") {
        // 模拟真人停留后按 Enter 确认。
        setTimeout(() => {
          state.confirmSentAt = Date.now();
          state.lastPlaybackAt = state.confirmSentAt;
          state.phase = "committed";
          app.game.dispatch({ type: "confirm_input", previewId: output.previewId });
          console.log(`[${stamp()}] R2 confirm_input（停留 ${args.dwellMs}ms 后）`);
        }, args.dwellMs);
      }
      break;
    }
    case "input_preview_canceled": {
      const cancelRow = report.rounds.find((r) => r.action === "cancel");
      if (cancelRow) cancelRow.canceledAt = Date.now();
      break;
    }
    case "runtime_error":
      report.errors.push({ code: output.code, message: output.message });
      break;
    default:
      break;
  }
}

function maybeFinish() {
  // 确认轮的 input_response attempt 全部落定（或超时兜底）→ shutdown。
  if (state.phase !== "committed" || state.shutdownScheduled) return;
  if (!state.seenResponseLine) return;
  const pending = [...state.responseAttemptIds].filter(
    (id) => !state.finishedAttemptIds.has(id),
  );
  if (pending.length === 0) {
    state.shutdownScheduled = true;
    setTimeout(() => app.game.dispatch({ type: "shutdown" }), 200);
  }
}

const watchdog = setTimeout(
  () => {
    console.log(`[${stamp()}] ⏱ watchdog 到点，shutdown`);
    app.game.dispatch({ type: "shutdown" });
  },
  args.maxWaitMin * 60_000,
);

try {
  await app.game.run();
} catch (e) {
  if (!(e instanceof RuntimeShutdownError)) throw e;
} finally {
  clearTimeout(watchdog);
}

report.metricsInput = app.metrics.snapshot().input;

// ---------------------------------------------------------------------------
// 断言汇总
// ---------------------------------------------------------------------------
const cancelRow = report.rounds.find((r) => r.action === "cancel");
const confirmRow = report.rounds.find((r) => r.action === "confirm");
const confirmAttempt = report.speculative.at(-1) ?? null;

console.log("\n──────── 输入时序探针 ────────");
console.log(`目标交互：${report.targetInteraction?.mode} "${report.targetInteraction?.prompt?.slice(0, 40)}"`);
for (const row of report.rounds) {
  console.log(`R${row.round}(${row.action})：预览打开 +${row.previewOpenLatencyMs ?? "?"}ms` +
    (row.action === "cancel"
      ? `，重开 +${row.reopenLatencyMs ?? "?"}ms`
      : `，确认→首行台词 +${row.confirmToFirstResponseMs ?? "?"}ms`));
}
console.log(`input_response attempts：${report.speculative.length}` +
  report.speculative.map((r, i) =>
    `\n  #${i + 1} ${r.attemptId} ttft=${r.ttftMs ?? "?"}ms latency=${r.latencyMs ?? "?"}ms state=${r.state ?? "?"}`).join(""));
if (confirmRow && confirmAttempt?.startedAt && state.confirmSentAt) {
  const headStart = state.confirmSentAt - confirmAttempt.startedAt;
  console.log(`预测收益：确认前生成已跑 ${headStart}ms（startedAt 早于 confirm=${headStart > 0}）`);
}
console.log(`确认后播放时间线：${report.playbackAfterConfirm.map((p) => `${p.kind}(${p.speaker})+${p.dtMs}ms`).join(" → ")}`);
console.log(`确认后 >300ms 停顿：${report.stallsAfterConfirm.length} 次`);
console.log(`metrics.input：preview_count=${report.metricsInput?.preview_count} canceled=${report.metricsInput?.response_canceled_count} promoted_live=${report.metricsInput?.response_promoted_live_count} stale_dropped=${report.metricsInput?.stale_input_event_dropped_count} confirm→首行样本=${JSON.stringify(report.metricsInput?.confirm_to_first_response_line_ms ?? [])}`);

// 断言：预览打开近零阻塞、确认轮生成早于确认启动、取消重开同一交互。
const problems = [];
if (!cancelRow || cancelRow.previewOpenLatencyMs === undefined) problems.push("取消轮未完成");
if (!confirmRow || confirmRow.previewOpenLatencyMs === undefined) problems.push("确认轮未完成");
for (const row of report.rounds) {
  if (row.previewOpenLatencyMs !== undefined && row.previewOpenLatencyMs > 150) {
    problems.push(`R${row.round} 预览打开耗时 ${row.previewOpenLatencyMs}ms（应≈0，生成不得阻塞预览）`);
  }
}
if (report.cancelReopen && !report.cancelReopen.sameInteraction) problems.push("取消后未重开同一交互");
if (confirmRow && confirmAttempt?.startedAt && state.confirmSentAt) {
  const headStart = state.confirmSentAt - confirmAttempt.startedAt;
  if (headStart <= 0) problems.push(`确认轮生成未早于确认启动（headStart=${headStart}ms）`);
} else {
  problems.push("缺少确认轮 input_response attempt 的启动证据");
}
if (report.errors.length > 0) problems.push(`runtime_error ×${report.errors.length}`);

const dir = "output/probe-input";
await mkdir(dir, { recursive: true });
const path = `${dir}/probe-input-${Date.now().toString(36)}.json`;
await writeFile(path, JSON.stringify(report, null, 2), "utf8");
console.log(`完整数据：${path}`);
console.log(`\nPROBE RESULT: ${problems.length === 0 ? "PASS" : "FAIL"}` +
  (problems.length > 0 ? `\n  - ${problems.join("\n  - ")}` : ""));
process.exit(problems.length === 0 ? 0 : 2);
