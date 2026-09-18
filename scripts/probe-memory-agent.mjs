// 记忆代理 / recap 压缩器真 key 探针（2026-09-19）。
// 验证 agents.memory / agents.recap 独立模型参数端到端生效：
//   - thinking enabled + effort max + 4000 token 预算下 API 是否接受、
//     输出能否解析（历史故障：「无法解析为有效提案」）；
//   - recap 细节化提示词 + frameworkDigest 查重注入是否工作。
//
// 用法：pnpm exec tsx scripts/probe-memory-agent.mjs [--skip-recap]
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { MemoryAgentAdapter } from "../src/adapters/llm/memory-agent-adapter.js";
import { RecapSummarizerAdapter } from "../src/adapters/llm/recap-summarizer-adapter.js";
import { createInitialState } from "../src/story/state.js";

const diagnostics = {
  info: (scope, message) => console.log(`[${scope}] ${message}`),
  warn: (scope, message) => console.log(`[${scope} WARN] ${message}`),
};

function ev(seq, partial) {
  return {
    seq,
    turn: 3,
    timestamp: "2026-09-19T00:35:00.000Z",
    source: "model",
    ...partial,
  };
}

const events = [
  ev(24, { type: "narration", text: "放学铃响过，维修部的活动室里只剩风扇在转。" }),
  ev(25, { type: "dialogue", speaker: "树莓娘", text: "那台服务器今天又掉线了，我想把值班记录翻出来对对时间。" }),
  ev(26, { type: "dialogue", speaker: "许晚晴", text: "记录在我这。不过上礼拜你借我的转接头还没还，先还我再给你。" }),
  ev(27, { type: "interaction", prompt: "要把转接头现在还给许晚晴吗？", mode: "choice" }),
  ev(28, { type: "player_choice", text: "把转接头还给她，顺便约周六一起查机房" }),
  ev(29, { type: "dialogue", speaker: "许晚晴", text: "成交。周六早上九点，机房门口见，迟到的人请奶茶。" }),
  ev(30, { type: "narration", text: "两人在值班表上并排写下名字，纸页边角还夹着一张便签。" }),
];

const state = {
  ...createInitialState(),
  canon: { scenario_title: "机房周末约定" },
};

async function main() {
  const config = await loadConfig("config.yaml");
  const memoryOverride = config.agents?.memory;
  console.log(
    `[probe] memory 覆盖: model=${memoryOverride?.model ?? config.api.model}(跟随主配置) ` +
      `thinking=${JSON.stringify(memoryOverride?.thinking ?? { type: "disabled" })} ` +
      `max_tokens=${memoryOverride?.max_tokens ?? "(内置默认)"}`,
  );

  const memoryAgent = new MemoryAgentAdapter({
    apiKey: process.env[config.api.api_key_env] ?? "",
    api: config.api,
    ...(memoryOverride?.thinking !== undefined ? { thinking: memoryOverride.thinking } : {}),
    ...(memoryOverride?.max_tokens !== undefined ? { maxTokens: memoryOverride.max_tokens } : {}),
    diagnostics,
  });

  const t0 = Date.now();
  const proposal = await memoryAgent.derive(events, state);
  console.log(`[probe] memory derive 耗时 ${Date.now() - t0}ms`);
  console.log("[probe] 提案:", JSON.stringify(proposal, null, 2));
  if (proposal === null || Object.keys(proposal).length === 0) {
    console.error("[probe] FAIL：提案为空/未解析");
    process.exitCode = 1;
  } else {
    console.log("[probe] memory PASS");
  }

  if (!process.argv.includes("--skip-recap")) {
    const recapOverride = config.agents?.recap;
    const recap = new RecapSummarizerAdapter({
      apiKey: process.env[config.api.api_key_env] ?? "",
      api: config.api,
      ...(recapOverride?.thinking !== undefined ? { thinking: recapOverride.thinking } : {}),
      ...(recapOverride?.max_tokens !== undefined ? { maxTokens: recapOverride.max_tokens } : {}),
      diagnostics,
    });
    const t1 = Date.now();
    const digest = await recap.summarize(events, {
      frameworkDigest:
        "[Canon] 场景=维修部活动室\n[Characters]\n  raspberry | mood:认真\n[Open Threads]\n  [active] server_downtime: 服务器反复掉线",
    });
    console.log(`[probe] recap 耗时 ${Date.now() - t1}ms`);
    console.log("[probe] 梗概:", digest);
    if (digest === null || digest.trim() === "") {
      console.error("[probe] FAIL：梗概为空");
      process.exitCode = 1;
    } else {
      console.log("[probe] recap PASS");
    }
  }
}

main().catch((error) => {
  console.error("[probe] 异常:", error);
  process.exitCode = 1;
});
