// 校园分支无头模拟：真实 LLM（config.yaml + .env），无 Web UI，直接驱动 Game。
//
// 用法：
//   node scripts/sim-campus-headless.mjs --persona quick|explorer|rambler
//        [--seed <seed-id>] [--max-wait-min 15] [--label <tag>]
//
// 驱动协议与 MemoryController（src/test-helpers.ts）同源：
//   playback_ready → advance；interaction_opened → 按人格选选项或自由输入
//   （preview_input → input_preview_opened → confirm_input）。
// 结束后输出运行指标，并把完整时间线写入 output/sim-campus/<sessionId>.json。
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { createRuntimeApplication } from "../src/bootstrap/create-runtime-application.js";
import { RuntimeShutdownError } from "../src/game.js";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { persona: "quick", seed: undefined, maxWaitMin: 15, label: undefined, config: "config.yaml" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") out.persona = argv[++i];
    else if (a === "--seed") out.seed = argv[++i];
    else if (a === "--max-wait-min") out.maxWaitMin = Number(argv[++i]);
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--config") out.config = argv[++i];
    else if (a.startsWith("--persona=")) out.persona = a.slice("--persona=".length);
    else if (a.startsWith("--seed=")) out.seed = a.slice("--seed=".length);
    else if (a.startsWith("--config=")) out.config = a.slice("--config=".length);
  }
  if (!["quick", "explorer", "rambler", "farewell"].includes(out.persona)) {
    throw new Error(`未知 persona: ${out.persona}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.seed) process.env.CAMPUS_SCENARIO_SEED_ID = args.seed;

// ---------------------------------------------------------------------------
// 玩家人格：选项关键词 + 自由输入台词池
// ---------------------------------------------------------------------------
const PERSONAS = {
  // 合作玩家：目标导向，倾向直接把事情办完
  quick: {
    chooseKeywords: ["解决", "修好", "修一下", "好了", "搞定", "完成", "没问题", "谢谢", "谢啦", "先回", "回去", "拜拜", "不耽误", "不用了"],
    inputs: [
      "好，我帮你一起弄，弄完你就能去准备了。",
      "看起来问题不大，咱们直接把它解决掉吧。",
      "行，就按这个办法来，快点弄完好收摊。",
    ],
    inputRatio: 0,
  },
  // 探索玩家：对故障本身好奇，一半交互用自由输入深挖
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
  // 拖延玩家：不断绕开主线、推迟收尾，用于压测分级收束（L1/L2）
  rambler: {
    chooseKeywords: ["再", "继续", "等等", "先不", "也许", "另外", "顺便", "还", "聊聊", "看看"],
    inputs: [
      "先别急着弄这个，我想再多问几句。",
      "等一下，我有点没跟上，你再说一遍背景？",
      "不急不急，反正还早，咱们慢慢来。",
      "嗯……我突然想起另一件事，先说说那个？",
    ],
    inputRatio: 0.3,
  },
  // 告别玩家：每次都用自由输入明确表达"今天就到这里"，验证极快结束
  farewell: {
    chooseKeywords: ["就到这里", "收摊", "先这样", "谢谢", "回去", "结束", "告辞", "散了", "不耽误", "回头见"],
    inputs: [
      "今天就先到这里吧，事情也差不多了，咱们收摊吧。",
      "好啦，我先走了，你忙你的，回头见！",
      "嗯，没什么其他事了，散了吧。",
    ],
    inputRatio: 1,
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

async function runSession() {
  const config = await loadConfig(args.config);
  const sessionId = `sim-${args.persona}-${args.label ?? "run"}-${Date.now().toString(36)}`;
  const app = await createRuntimeApplication({ configPath: args.config, config, sessionId });

  const persona = PERSONAS[args.persona];

  // writer attempt fold：订阅监控事件流，把每个 attempt 的首字延迟/思考/
  // 修复/结局折叠成行（hub ring 只留 12 任务，这里是全量持久化通道）。
  const taskTypes = new Map(); // taskId -> taskType
  const attemptRows = new Map(); // attemptId -> row
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
    startedAt: new Date().toISOString(),
    lines: [],            // { kind: narration|dialogue|ending, speaker?, text, t }
    interactions: [],     // { id, mode, options: string[], action, chosen? }
    inputPreviews: [],    // { previewId, text }
    errors: [],           // runtime_error
    statusTrace: [],      // 关键 phase 变化
    ended: null,          // { endingId, text, synthesized }
    timedOut: false,
  };

  let interactionSeq = 0;
  let inputCursor = 0;
  let watchdog = null;
  let runPromise;

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
        const ev = output.event;
        const speaker = ev.type === "dialogue" ? ev.speaker ?? "" : "";
        const text = ev.text ?? "";
        report.lines.push({ kind: ev.type, speaker, text, t: Date.now() - t0 });
        const preview = text.length > 42 ? `${text.slice(0, 42)}…` : text;
        console.log(`[${stamp()}] ${ev.type === "dialogue" ? `${speaker}：` : ""}${preview}`);
        game.dispatch({ type: "advance" });
        break;
      }
      case "interaction_opened": {
        const it = output.interaction;
        const options = (it.options ?? []).map((o) => ({ id: o.id, text: o.text }));
        interactionSeq += 1;
        console.log(
          `[${stamp()}] interaction#${interactionSeq} mode=${it.mode ?? it.type} prompt="${(it.prompt ?? "").slice(0, 30)}" options=${options.length}`,
        );
        // 确定性轮换：explorer 约每 2 次交互用一次自由输入，rambler 约每 3 次。
        // 只有 input/hybrid 表单接受 preview_input；纯 choice 表单发了会被
        // waitForInteractionCommand 静默过滤并永久等待（协议违规）。
        const inputEvery = persona.inputRatio > 0 ? Math.round(1 / persona.inputRatio) : 0;
        const formAcceptsInput =
          it.type !== "choice" && (it.mode === undefined || it.mode !== "choice");
        const useInput =
          options.length === 0 ||
          (formAcceptsInput && inputEvery > 0 && interactionSeq % inputEvery === 0);
        if (!useInput) {
          const chosen = pickOption(options, persona.chooseKeywords, interactionSeq);
          report.interactions.push({
            id: output.interactionId, mode: it.mode ?? it.type,
            options: options.map((o) => o.text), action: "choice", chosen: chosen.text,
          });
          console.log(`[${stamp()}]   → 选「${chosen.text}」`);
          game.dispatch({ type: "select_choice", interactionId: output.interactionId, optionId: chosen.id });
        } else {
          const text = persona.inputs[inputCursor++ % persona.inputs.length];
          report.interactions.push({
            id: output.interactionId, mode: it.mode ?? it.type,
            options: options.map((o) => o.text), action: "input", chosen: text,
          });
          console.log(`[${stamp()}]   → 输入「${text.slice(0, 30)}」`);
          game.dispatch({ type: "preview_input", interactionId: output.interactionId, text });
        }
        break;
      }
      case "input_preview_opened":
        report.inputPreviews.push({ previewId: output.previewId, text: output.text });
        console.log(`[${stamp()}] preview open → confirm`);
        game.dispatch({ type: "confirm_input", previewId: output.previewId });
        break;
      case "session_ended": {
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
    runPromise = game.run();
    await runPromise;
  } catch (e) {
    if (e instanceof RuntimeShutdownError) {
      console.log(`[${stamp()}] run 被 shutdown 中止`);
    } else {
      throw e;
    }
  } finally {
    clearTimeout(watchdog);
  }

  report.elapsedMs = Date.now() - t0;
  report.metrics = compactMetrics(app.metrics.snapshot());
  report.thinking = {
    type: config.generation.thinking?.type ?? "disabled",
    effort: config.generation.thinking?.effort ?? null,
  };
  report.writerAttempts = [...attemptRows.values()].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );

  // 汇总
  const dialogue = report.lines.filter((l) => l.kind === "dialogue");
  const narration = report.lines.filter((l) => l.kind === "narration");
  const storyChars = report.lines.reduce((n, l) => n + l.text.length, 0);
  console.log("\n──────── 会话汇总 ────────");
  console.log(`persona=${report.persona} seed=${report.seedEnv ?? "(按session轮换)"} thinking=${report.thinking.type}${report.thinking.effort ? `/${report.thinking.effort}` : ""} 耗时=${(report.elapsedMs / 1000).toFixed(0)}s`);
  console.log(`交互数=${report.interactions.length}（choice=${report.interactions.filter((i) => i.action === "choice").length}/input=${report.interactions.filter((i) => i.action === "input").length}）`);
  console.log(`台词=${dialogue.length} 旁白=${narration.length} 剧情字符=${storyChars}`);
  console.log(`结局=${report.ended ? `${report.ended.endingId}（合成=${report.ended.synthesized}）` : "未结束"} 超时=${report.timedOut} runtime_error=${report.errors.length}`);
  console.log(`LLM 请求：${JSON.stringify(report.metrics.llm.requests)} token(in/out/cached/reasoning)=${report.metrics.llm.tokens.input}/${report.metrics.llm.tokens.output}/${report.metrics.llm.tokens.cached_input}/${report.metrics.llm.tokens.reasoning} 命中率=${(report.metrics.llm.cache_hit_rate * 100).toFixed(1)}%`);
  console.log(`延迟 p50/p95/max=${report.metrics.llm.latency_ms.p50}/${report.metrics.llm.latency_ms.p95}/${report.metrics.llm.latency_ms.max}ms 首字 p50/p95=${report.metrics.llm.ttft_ms.p50}/${report.metrics.llm.ttft_ms.p95}ms 思考 p50=${report.metrics.llm.thinking_ms.p50}ms(${report.metrics.llm.thinking_ms.samples}样本)`);
  console.log(`修复=${report.metrics.writer.repairs.total}${JSON.stringify(report.metrics.writer.repairs.by_kind)} attempt结局(done/retried/failed/cancelled)=${report.metrics.writer.outcomes.done}/${report.metrics.writer.outcomes.retried}/${report.metrics.writer.outcomes.failed}/${report.metrics.writer.outcomes.cancelled} schema失败=${report.metrics.errors.schema_validation_failures}`);

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
    console.log(`\nSIM RESULT: ${ok ? "PASS" : "REVIEW"} (persona=${r.persona})`);
    process.exit(ok ? 0 : 2);
  })
  .catch((e) => {
    console.error("SIM FAIL:", e);
    process.exit(1);
  });
