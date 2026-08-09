/**
 * Tests for the author-authored static story-plan loader (Task 3).
 *
 * All yaml content is written to a mkdtemp tmp dir at test time, so the
 * suite never depends on the repo-root sample file.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStoryPlan } from "./story-plan-loader.js";
import type { DiagnosticSink } from "../../core/ports/diagnostic-sink.js";

/** DiagnosticSink double that records every warn/info message. */
function recordingDiagnostics(): DiagnosticSink & {
  warns: string[];
  infos: string[];
} {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    info: (_scope: string, message: string) => infos.push(message),
    warn: (_scope: string, message: string) => warns.push(message),
  };
}

/** Full valid plan covering every snake_case -> camelCase mapping. */
const validPlanYaml = [
  "# 合法故事计划",
  "threads:",
  "  - id: terminal_origin",
  "    kind: mystery",
  "    summary: 研究所地下的终端来历成谜。",
  "    status: developing",
  "    importance: major",
  "    introduced_at: 100",
  "    last_touched_at: 200",
  "    next_pressure: 下一次接触研究资料时，应产生一个足以推翻旧推测的新线索",
  "  - id: suyao_identity",
  "    kind: character",
  "    summary: 苏遥的身份有待揭示。",
  "    status: open",
  "    importance: major",
  "setups:",
  "  - id: terminal_reacts_to_suyao",
  "    kind: foreshadow",
  "    setup: 终端似乎会对苏遥产生异常响应。",
  "    intended_payoff: 揭示终端能够识别她记忆中留下的特征。",
  "    thread_id: terminal_origin",
  "    reinforcement_count: 2",
  "    seeded_at: 300",
  "    last_touched_at: 400",
  "    payoff_at: 500",
  "    prerequisites:",
  "      - player_has_questioned_suyao_identity",
  "    payoff_before_anchor: reveal_suyao_origin",
  "  - id: professor_disappearance",
  "    kind: mystery_clue",
  "    setup: 教授失踪。",
  "  - id: key_to_basement",
  "    kind: object",
  "    setup: 地下室的钥匙。",
  "anchors:",
  "  - id: discover_terminal",
  "    purpose: 主角发现终端。",
  "    required: true",
  "  - id: doubt_suyao_identity",
  "    purpose: 主角开始怀疑苏遥。",
  "    prerequisites:",
  "      - discover_terminal",
  "  - id: reveal_suyao_origin",
  "    purpose: 揭示苏遥的来历。",
  "    prerequisites:",
  "      - doubt_suyao_identity",
].join("\n");

describe("loadStoryPlan", () => {
  it("fully parses a valid plan with snake_case -> camelCase mapping", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    try {
      const planPath = path.join(dir, "story-plan.yaml");
      await writeFile(planPath, validPlanYaml, "utf8");

      const plan = await loadStoryPlan(planPath);

      // threads: authored status kept, source forced to "author"
      expect(plan.threads).toHaveLength(2);
      const terminalOrigin = plan.threads.find((t) => t.id === "terminal_origin");
      expect(terminalOrigin).toMatchObject({
        id: "terminal_origin",
        kind: "mystery",
        status: "developing",
        importance: "major",
        introducedAt: 100,
        lastTouchedAt: 200,
        nextPressure: "下一次接触研究资料时，应产生一个足以推翻旧推测的新线索",
        source: "author",
      });
      const suyaoIdentity = plan.threads.find((t) => t.id === "suyao_identity");
      expect(suyaoIdentity).toMatchObject({
        id: "suyao_identity",
        kind: "character",
        status: "open",
        source: "author",
      });

      // setups: status forced to "planned", source forced to "author"
      expect(plan.setups).toHaveLength(3);
      const terminalReacts = plan.setups.find(
        (s) => s.id === "terminal_reacts_to_suyao"
      );
      expect(terminalReacts).toMatchObject({
        id: "terminal_reacts_to_suyao",
        kind: "foreshadow",
        setup: "终端似乎会对苏遥产生异常响应。",
        intendedPayoff: "揭示终端能够识别她记忆中留下的特征。",
        status: "planned",
        threadId: "terminal_origin",
        reinforcementCount: 2,
        seededAt: 300,
        lastTouchedAt: 400,
        payoffAt: 500,
        prerequisites: ["player_has_questioned_suyao_identity"],
        payoffBeforeAnchor: "reveal_suyao_origin",
        source: "author",
      });
      // defaults applied where the yaml omits optional/required fields
      const professorDisappearance = plan.setups.find(
        (s) => s.id === "professor_disappearance"
      );
      expect(professorDisappearance).toMatchObject({
        id: "professor_disappearance",
        kind: "mystery_clue",
        status: "planned",
        reinforcementCount: 0,
        prerequisites: [],
        source: "author",
      });
      expect(plan.setups.map((s) => s.id)).toEqual([
        "terminal_reacts_to_suyao",
        "professor_disappearance",
        "key_to_basement",
      ]);

      // anchors: status forced to "pending", prerequisites default []
      expect(plan.anchors).toHaveLength(3);
      const discoverTerminal = plan.anchors.find((a) => a.id === "discover_terminal");
      expect(discoverTerminal).toMatchObject({
        id: "discover_terminal",
        status: "pending",
        required: true,
        prerequisites: [],
      });
      const doubtSuyao = plan.anchors.find((a) => a.id === "doubt_suyao_identity");
      expect(doubtSuyao).toMatchObject({
        id: "doubt_suyao_identity",
        status: "pending",
        required: false,
        prerequisites: ["discover_terminal"],
      });
      const revealSuyao = plan.anchors.find((a) => a.id === "reveal_suyao_origin");
      expect(revealSuyao).toMatchObject({
        id: "reveal_suyao_origin",
        status: "pending",
        prerequisites: ["doubt_suyao_identity"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty plan when the file does not exist (no error)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    try {
      const missingPath = path.join(dir, "does-not-exist.yaml");
      await expect(loadStoryPlan(missingPath)).resolves.toEqual({
        threads: [],
        setups: [],
        anchors: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on malformed yaml syntax", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    try {
      const planPath = path.join(dir, "broken.yaml");
      await writeFile(planPath, "threads: [unclosed", "utf8");
      await expect(loadStoryPlan(planPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on structurally invalid yaml (top-level not an object)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    try {
      const planPath = path.join(dir, "array.yaml");
      await writeFile(planPath, "- just\n- a list\n", "utf8");
      await expect(loadStoryPlan(planPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips entries that fail zod validation and records warnings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "galgame-plan-"));
    try {
      const planPath = path.join(dir, "mixed.yaml");
      await writeFile(
        planPath,
        [
          "threads:",
          "  - id: good_thread",
          "    kind: character",
          "    summary: 好条目。",
          "    status: open",
          "    importance: major",
          "  - id: broken_thread",
          "    kind: not_a_kind",
          "    summary: 坏条目。",
          "    status: open",
          "    importance: major",
          "setups:",
          "  - id: broken_setup",
          "    kind: foreshadow",
          "  - id: good_setup",
          "    kind: object",
          "    setup: 好条目。",
          "anchors:",
          "  - id: broken_anchor",
          "    required: true",
          "  - id: good_anchor",
          "    purpose: 好条目。",
        ].join("\n"),
        "utf8"
      );

      const diagnostics = recordingDiagnostics();
      const plan = await loadStoryPlan(planPath, diagnostics);

      expect(plan.threads.map((t) => t.id)).toEqual(["good_thread"]);
      expect(plan.setups.map((s) => s.id)).toEqual(["good_setup"]);
      expect(plan.anchors.map((a) => a.id)).toEqual(["good_anchor"]);

      expect(diagnostics.warns).toHaveLength(3);
      expect(diagnostics.warns.some((w) => w.startsWith("thread 条目跳过: broken_thread"))).toBe(true);
      expect(diagnostics.warns.some((w) => w.startsWith("setup 条目跳过: broken_setup"))).toBe(true);
      expect(diagnostics.warns.some((w) => w.startsWith("anchor 条目跳过: broken_anchor"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
