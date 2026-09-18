// 校园分支节奏模拟：在 sim-campus-headless 基础上模拟真实玩家快速点击
// （默认 1.5s/句），并度量「玩家动作 → 下一个可消费事件」的感知等待，
// 用于验证快速点击下续写/预取能否支撑零中断体验。
//
// 用法：
//   pnpm exec tsx scripts/sim-campus-paced.mjs --thinking disabled|low
//        [--seed <seed-id>] [--pace-ms 1500] [--label <tag>] [--persona quick]
//
// 零中断度量：每次玩家动作（advance / 选选项 / 确认输入）记 waitingSince，
// 下一个 playback_ready / interaction_opened / input_preview_opened 到达时
// 计算 waitMs。缓冲命中 ≈0ms；等 LLM 则为生成时长。
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { RuntimeShutdownError } from "../src/game.js";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    persona: "quick",
    seed: undefined,
    maxWaitMin: 25,
    label: undefined,
    paceMs: 1500,
    thinking: "disabled",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") out.persona = argv[++i];
    else if (a === "--seed") out.seed = argv[++i];
    else if (a === "--max-wait-min") out.maxWaitMin = Number(argv[++i]);
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--pace-ms") out.paceMs = Number(argv[++i]);
    else if (a === "--thinking") out.thinking = argv[++i];
    else if (a.startsWith("--persona=")) out.persona = a.slice("--persona=".length);
    else if (a.startsWith("--seed=")) out.seed = a.slice("--seed=".length);
    else if (a.startsWith("--thinking=")) out.thinking = a.slice("--thinking=".length);
  }
  if (!["quick", "explorer", "rambler", "farewell"].includes(out.persona)) {
    throw new Error(`未知 persona: ${out.persona}`);
  }
  if (!["disabled", "low"].includes(out.thinking)) {
    throw new Error(`未知 thinking: ${out.thinking}（disabled|low）`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.seed) process.env.CAMPUS_SCENARIO_SEED_ID = args.seed;

// ---------------------------------------------------------------------------
// 玩家人格（与 sim-campus-headless 同源，quick = 合作速通玩家）
// ---------------------------------------------------------------------------
const PERSONAS = {
  quick: {
    chooseKeywords: ["解决", "修好", "修一下", "好了", "搞定", "完成", "没问题", "谢谢", "谢啦", "先回", "回去", "拜拜", "不耽误", "不用了"],
    inputs: [
      "好，我帮你一起弄，弄完你就能去准备了。",
      "看起来问题不大，咱们直接把它解决掉吧。",
      "行，就按这个办法来，快点弄完好收摊。",
    ],
    inputRatio: 0,
  },
  explorer: {
    chooseKeywords: ["看看", "为什么", "怎么回事", "检查", "问问", "了解一下", "再看看", "顺便"],
    inputs: [
      "这个现象挺有意思的，能带我看看具体是怎么坏的吗？",
      "等等，我想先弄清楚它为什么会变成这样。",
      "我们一步步排查吧，先从最可疑的地方看起。",
      "原来如此……那这台机器以前也这样过吗？",
    ],
    inputRatio: 0.5,
  },
};

// ---------------------------------------------------------------------------
// 会话驱动
// ---------------------------------------------------------------------------
const SYNTHESIZED_ENDING_TEXT = "（故事在此落幕。）";
const t0 = Date.now();

function stamp() {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function runSession() {
  const config = await loadConfig("config.yaml");
  // 思考档位 patch（不落盘，不影响 config.yaml 用户 WIP）
  config.generation.thinking =
    args.thinking === "low"
      ? { type: "enabled", effort: "low" }
      : { type: "disabled" };

  const arm = args.thinking === "low" ? "low" : "off";
  const sessionId = `paced-${arm}-${args.seed ?? "roundrobin"}-${Date.now().toString(36)}`;
  const app = await createRuntimeApplication({ configPath: "config.yaml", config, sessionId });

  const persona = PERSONAS[args.persona];

  const taskTypes = new Map();
  const attemptRows = new Map();
  function rowOf(attemptId) {
    let row = attemptRows.get(attemptId);
    if (!row) {
      const taskId = attemptId.split("#")[0];
      attemptRows.set(
        attemptId,
        (row = {
          attemptId,
          taskType: taskTypes.get(taskId) ?? taskId,
          index: null,
          startedAt: null,
          ttftMs: null,
          latencyMs: null,
          input: null,
          output: null,
          cachedInput: null,
          reasoningTokens: null,
          thinkingMs: null,
          repairs: [],
          state: null,
          error: null,
        }),
      );
    }
    return row;
  }
  app.monitor?.subscribe((message) => {
    if (message.type !== "monitor.event") return;
    for (const ev of message.events) {
      switch (ev.type) {
        case "writer.start": {
          taskTypes.set(ev.task.taskId, ev.task.taskType);
          const attempt = ev.task.attempts.at(-1);
          if (attempt) {
            const row = rowOf(attempt.attemptId);
            row.index = attempt.index;
            row.startedAt = attempt.startedAt;
          }
          break;
        }
        case "writer.delta": {
          if (ev.firstTokenMs != null) {
            const row = rowOf(ev.attemptId);
            if (row.ttftMs == null) row.ttftMs = ev.firstTokenMs;
          }
          break;
        }
        case "writer.repair":
          rowOf(ev.attemptId).repairs.push(ev.repair.kind);
          break;
        case "writer.usage": {
          const row = rowOf(ev.attemptId);
          row.latencyMs = ev.usage.latencyMs;
          row.input = ev.usage.input;
          row.output = ev.usage.output;
          row.cachedInput = ev.usage.cachedInput;
          if (ev.usage.reasoningTokens !== undefined) row.reasoningTokens = ev.usage.reasoningTokens;
          if (ev.usage.thinkingMs !== undefined) row.thinkingMs = ev.usage.thinkingMs;
          break;
        }
        case "writer.end": {
          const row = rowOf(ev.attemptId);
          row.state = ev.state;
          row.error = ev.error ?? null;
          break;
        }
        default:
          break;
      }
    }
  });

  const report = {
    sessionId,
    persona: args.persona,
    seedEnv: args.seed ?? null,
    paceMs: args.paceMs,
    thinking: {
      type: config.generation.thinking?.type ?? "disabled",
      effort: config.generation.thinking?.effort ?? null,
    },
    startedAt: new Date().toISOString(),
    lines: [],
    interactions: [],
    inputPreviews: [],
    errors: [],
    statusTrace: [],
    // 玩家感知等待：{ trigger, waitMs }；trigger = advance|choice|input|confirm
    waits: [],
    // 中断时刻表（waitMs > interruptMs 的样本），便于定位是哪次续写没跟上
    interruptMs: 300,
    ended: null,
    timedOut: false,
  };

  let interactionSeq = 0;
  let inputCursor = 0;
  let watchdog = null;
  let waitingSince = null; // { trigger, at }
  let pendingTimer = null;

  function beginWait(trigger) {
    waitingSince = { trigger, at: Date.now() };
  }

  function settleWait() {
    if (!waitingSince) return;
    report.waits.push({ trigger: waitingSince.trigger, waitMs: Date.now() - waitingSince.at });
    waitingSince = null;
  }

  function scheduleAction(fn) {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(fn, args.paceMs);
  }

  const game = app.game;
  game.subscribe((output) => {
    try {
      handle(output);
    } catch (e) {
      report.errors.push({ code: "driver", message: String(e) });
    }
  });

  function handle(output) {
    switch (output.type) {
      case "session_started":
        console.log(`[${stamp()}] session ${output.sessionId} @ ${output.location}`);
        break;
      case "playback_ready": {
        settleWait();
        const ev = output.event;
        const speaker = ev.type === "dialogue" ? ev.speaker ?? "" : "";
        const text = ev.text ?? "";
        report.lines.push({ kind: ev.type, speaker, text, t: Date.now() - t0 });
        const preview = text.length > 42 ? `${text.slice(0, 42)}…` : text;
        console.log(`[${stamp()}] ${ev.type === "dialogue" ? `${speaker}：` : ""}${preview}`);
        scheduleAction(() => {
          game.dispatch({ type: "advance" });
          beginWait("advance");
        });
        break;
      }
      case "interaction_opened": {
        settleWait();
        const it = output.interaction;
        const options = (it.options ?? []).map((o) => ({ id: o.id, text: o.text }));
        interactionSeq += 1;
        console.log(
          `[${stamp()}] interaction#${interactionSeq} mode=${it.mode ?? it.type} prompt="${(it.prompt ?? "").slice(0, 30)}" options=${options.length}`,
        );
        const inputEvery = persona.inputRatio > 0 ? Math.round(1 / persona.inputRatio) : 0;
        const formAcceptsInput =
          it.type !== "choice" && (it.mode === undefined || it.mode !== "choice");
        const useInput =
          options.length === 0 ||
          (formAcceptsInput && inputEvery > 0 && interactionSeq % inputEvery === 0);
        scheduleAction(() => {
          if (!useInput) {
            const chosen = pickOption(options, persona.chooseKeywords, interactionSeq);
            report.interactions.push({
              id: output.interactionId, mode: it.mode ?? it.type,
              options: options.map((o) => o.text), action: "choice", chosen: chosen.text,
            });
            console.log(`[${stamp()}]   → 选「${chosen.text}」`);
            game.dispatch({ type: "select_choice", interactionId: output.interactionId, optionId: chosen.id });
            beginWait("choice");
          } else {
            const text = persona.inputs[inputCursor++ % persona.inputs.length];
            report.interactions.push({
              id: output.interactionId, mode: it.mode ?? it.type,
              options: options.map((o) => o.text), action: "input", chosen: text,
            });
            console.log(`[${stamp()}]   → 输入「${text.slice(0, 30)}」`);
            game.dispatch({ type: "preview_input", interactionId: output.interactionId, text });
            beginWait("input");
          }
        });
        break;
      }
      case "input_preview_opened":
        settleWait();
        report.inputPreviews.push({ previewId: output.previewId, text: output.text });
        console.log(`[${stamp()}] preview open → confirm`);
        scheduleAction(() => {
          game.dispatch({ type: "confirm_input", previewId: output.previewId });
          beginWait("confirm");
        });
        break;
      case "session_ended": {
        settleWait();
        report.ended = {
          endingId: output.ending.ending_id,
          text: output.ending.text,
          synthesized: output.ending.text === SYNTHESIZED_ENDING_TEXT,
        };
        console.log(
          `[${stamp()}] ★ SESSION_ENDED id=${output.ending.ending_id} synthesized=${report.ended.synthesized}`,
        );
        console.log(`    结局文本：${output.ending.text}`);
        break;
      }
      case "runtime_error":
        report.errors.push({ code: output.code, message: output.message });
        console.log(`[${stamp()}] ✗ runtime_error ${output.code}: ${output.message}`);
        break;
      case "status_changed": {
        const phase = output.status?.phase;
        if (phase && phase !== report.statusTrace.at(-1)?.phase) {
          report.statusTrace.push({ phase, t: Date.now() - t0 });
        }
        break;
      }
      default:
        break;
    }
  }

  watchdog = setTimeout(() => {
    report.timedOut = true;
    console.log(`[${stamp()}] ⏱ 超时 watchdog 触发，shutdown`);
    game.dispatch({ type: "shutdown" });
  }, args.maxWaitMin * 60_000);

  try {
    await game.run();
  } catch (e) {
    if (e instanceof RuntimeShutdownError) {
      console.log(`[${stamp()}] run 被 shutdown 中止`);
    } else {
      throw e;
    }
  } finally {
    clearTimeout(watchdog);
    clearTimeout(pendingTimer);
  }

  report.elapsedMs = Date.now() - t0;
  report.metrics = compactMetrics(app.metrics.snapshot());
  report.writerAttempts = [...attemptRows.values()].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );

  // 汇总
  const dialogue = report.lines.filter((l) => l.kind === "dialogue");
  const narration = report.lines.filter((l) => l.kind === "narration");
  const storyChars = report.lines.reduce((n, l) => n + l.text.length, 0);
  const waits = report.waits.map((w) => w.waitMs).sort((a, b) => a - b);
  const interrupts = report.waits.filter((w) => w.waitMs > report.interruptMs);
  const waitP = { p50: pct(waits, 50), p95: pct(waits, 95), max: waits.at(-1) ?? null };

  console.log("\n──────── 会话汇总 ────────");
  console.log(`persona=${report.persona} seed=${report.seedEnv ?? "(按session轮换)"} thinking=${report.thinking.type}${report.thinking.effort ? `/${report.thinking.effort}` : ""} pace=${report.paceMs}ms/句 耗时=${(report.elapsedMs / 1000).toFixed(0)}s`);
  console.log(`交互数=${report.interactions.length}（choice=${report.interactions.filter((i) => i.action === "choice").length}/input=${report.interactions.filter((i) => i.action === "input").length}）`);
  console.log(`台词=${dialogue.length} 旁白=${narration.length} 剧情字符=${storyChars}`);
  console.log(`结局=${report.ended ? `${report.ended.endingId}（合成=${report.ended.synthesized}）` : "未结束"} 超时=${report.timedOut} runtime_error=${report.errors.length}`);
  console.log(`LLM 请求：${JSON.stringify(report.metrics.llm.requests)} token(in/out/cached/reasoning)=${report.metrics.llm.tokens.input}/${report.metrics.llm.tokens.output}/${report.metrics.llm.tokens.cached_input}/${report.metrics.llm.tokens.reasoning} 命中率=${(report.metrics.llm.cache_hit_rate * 100).toFixed(1)}%`);
  console.log(`延迟 p50/p95/max=${report.metrics.llm.latency_ms.p50}/${report.metrics.llm.latency_ms.p95}/${report.metrics.llm.latency_ms.max}ms 首字 p50/p95=${report.metrics.llm.ttft_ms.p50}/${report.metrics.llm.ttft_ms.p95}ms 思考 p50=${report.metrics.llm.thinking_ms.p50}ms(${report.metrics.llm.thinking_ms.samples}样本)`);
  console.log(`修复=${report.metrics.writer.repairs.total}${JSON.stringify(report.metrics.writer.repairs.by_kind)} attempt结局(done/retried/failed/cancelled)=${report.metrics.writer.outcomes.done}/${report.metrics.writer.outcomes.retried}/${report.metrics.writer.outcomes.failed}/${report.metrics.writer.outcomes.cancelled} schema失败=${report.metrics.errors.schema_validation_failures}`);
  console.log(`预取分支 requested/hit=${report.metrics.prefetch.branches_requested}/${report.metrics.prefetch.branches_hit}`);
  console.log(`玩家感知等待（${waits.length} 次动作）：p50=${waitP.p50}ms p95=${waitP.p95}ms max=${waitP.max}ms；>${report.interruptMs}ms 中断 ${interrupts.length} 次，累计等待 ${interrupts.reduce((n, w) => n + w.waitMs, 0)}ms`);
  if (interrupts.length > 0) {
    for (const w of interrupts.slice(0, 12)) {
      console.log(`  ✗ 中断 ${w.waitMs}ms after ${w.trigger}`);
    }
  }

  const dir = "output/sim-campus";
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${sessionId}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  const jsonlPath = `${dir}/${sessionId}-attempts.jsonl`;
  await writeFile(jsonlPath, report.writerAttempts.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`完整时间线：${path}`);
  console.log(`writer attempts：${jsonlPath}（${report.writerAttempts.length} 条）`);
  return report;
}

function pickOption(options, keywords, seq) {
  for (const kw of keywords) {
    const hit = options.find((o) => o.text.includes(kw));
    if (hit) return hit;
  }
  return options[seq % options.length];
}

function compactMetrics(snap) {
  return {
    llm: {
      requests: snap.llm.requests,
      tokens: snap.llm.tokens,
      cache_hit_rate: snap.llm.cache_hit_rate,
      latency_ms: snap.llm.latency_ms,
      ttft_ms: snap.llm.ttft_ms,
      thinking_ms: snap.llm.thinking_ms,
    },
    writer: snap.writer,
    prefetch: { branches_requested: snap.prefetch.branches_requested, branches_hit: snap.prefetch.branches_hit },
    errors: snap.errors,
  };
}

runSession()
  .then((r) => {
    const ok = r.ended && !r.timedOut && r.errors.length === 0;
    console.log(`\nSIM RESULT: ${ok ? "PASS" : "REVIEW"} (persona=${r.persona} thinking=${r.thinking.type})`);
    process.exit(ok ? 0 : 2);
  })
  .catch((e) => {
    console.error("SIM FAIL:", e);
    process.exit(1);
  });
