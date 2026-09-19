/**
 * 任务协议能力卡（C4，计划 §5.2 表逐行）。能力卡是命令能力与结束方式的
 * 单一数据源：实际 validator（compileSegmentV2）与修复模板同源引用，
 * 这里把表钉死，防漂移。
 */
import { describe, it, expect } from "vitest";
import {
  DSL_V2_COMMANDS,
  capabilityAllowsCommand,
  commandOfDslLineV2,
  dslTaskCapability,
  formatV2RepairInstruction,
  protocolRepairCapability,
} from "./capabilities.js";
import type { DslDiagnosticV2, DslLineV2 } from "./types.js";

describe("dslTaskCapability — §5.2 任务协议卡", () => {
  it("opening：@say/@n、本场角色操作、场景资源、表单；interaction/ending，不用 buffer", () => {
    const cap = dslTaskCapability("opening");
    expect(cap.commands).toContain("@say");
    expect(cap.commands).toContain("@n");
    expect(cap.commands).toContain("@name");
    expect(cap.commands).toContain("@ch");
    expect(cap.commands).toContain("@bg");
    expect(cap.commands).toContain("@?");
    expect(cap.commands).toContain("@/?");
    expect(cap.endReasons).toEqual(["interaction", "ending"]);
    expect(cap.ending).toBe(true);
    expect(capabilityAllowsCommand(cap, "@end")).toBe(true);
  });

  it("continuation：与 opening 同一语法；buffer/interaction/ending", () => {
    const cap = dslTaskCapability("continuation");
    const opening = dslTaskCapability("opening");
    expect(cap.commands).toEqual(opening.commands);
    expect(cap.endReasons).toEqual(["buffer", "interaction", "ending"]);
    expect(cap.ending).toBe(true);
  });

  it("branch_prefetch：台词、旁白、受控舞台；不生成表单；buffer", () => {
    const cap = dslTaskCapability("branch_prefetch");
    expect(capabilityAllowsCommand(cap, "@say")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@n")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@ch")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@?")).toBe(false);
    expect(capabilityAllowsCommand(cap, "@+")).toBe(false);
    expect(capabilityAllowsCommand(cap, "@/?")).toBe(false);
    expect(capabilityAllowsCommand(cap, "@ending")).toBe(false);
    expect(cap.endReasons).toEqual(["buffer"]);
    expect(cap.ending).toBe(false);
  });

  it("input_response：台词、旁白、角色/音效操作；buffer", () => {
    const cap = dslTaskCapability("input_response");
    expect(capabilityAllowsCommand(cap, "@say")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@n")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@name")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@ch")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@se")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@?")).toBe(false);
    expect(cap.endReasons).toEqual(["buffer"]);
  });

  it("input_bridge：仅旁白与过渡能力；不代玩家发声；buffer 收束", () => {
    const cap = dslTaskCapability("input_bridge");
    expect(capabilityAllowsCommand(cap, "@n")).toBe(true);
    expect(capabilityAllowsCommand(cap, "@say")).toBe(false);
    expect(capabilityAllowsCommand(cap, "@name")).toBe(false);
    expect(capabilityAllowsCommand(cap, "@?")).toBe(false);
    expect(cap.endReasons).toEqual(["buffer"]);
    expect(cap.ending).toBe(false);
  });

  it("protocol repair：继承原任务能力，限定未提交尾部", () => {
    const base = dslTaskCapability("continuation");
    const repair = protocolRepairCapability("continuation");
    expect(repair.task).toBe("protocol_repair");
    expect(repair.commands).toEqual(base.commands);
    expect(repair.endReasons).toEqual(base.endReasons);
    expect(repair.ending).toBe(base.ending);
    expect(repair.scope).toContain("continuation");
    // 分支预取的修复不得借机拿到表单/结局能力。
    const prefetchRepair = protocolRepairCapability("branch_prefetch");
    expect(capabilityAllowsCommand(prefetchRepair, "@?")).toBe(false);
    expect(capabilityAllowsCommand(prefetchRepair, "@ending")).toBe(false);
  });

  it("每张卡的命令集都是全集的子集且必含 @end", () => {
    for (const task of [
      "opening",
      "continuation",
      "branch_prefetch",
      "input_response",
      "input_bridge",
    ] as const) {
      const cap = dslTaskCapability(task);
      expect(capabilityAllowsCommand(cap, "@end")).toBe(true);
      for (const command of cap.commands) {
        expect(DSL_V2_COMMANDS).toContain(command);
      }
    }
  });
});

describe("commandOfDslLineV2 — 行 → 命令名映射", () => {
  const table: readonly { line: DslLineV2; command: string }[] = [
    { line: { kind: "say", characterId: "female_A", text: "x" }, command: "@say" },
    { line: { kind: "narration", text: "x" }, command: "@n" },
    { line: { kind: "name_set", characterId: "female_A", label: "x" }, command: "@name" },
    { line: { kind: "name_reset", characterId: "female_A" }, command: "@name" },
    { line: { kind: "ch_show", characterId: "female_A" }, command: "@ch" },
    { line: { kind: "ch_set", characterId: "female_A", look: "smile" }, command: "@ch" },
    { line: { kind: "ch_hide", characterId: "female_A" }, command: "@ch" },
    { line: { kind: "ch_exit", characterId: "female_A" }, command: "@ch" },
    { line: { kind: "ch_reset", characterId: "female_A" }, command: "@ch" },
    { line: { kind: "background", assetId: "bg1" }, command: "@bg" },
    { line: { kind: "bgm", assetId: "stop" }, command: "@bgm" },
    { line: { kind: "sound_effect", assetId: "se1" }, command: "@se" },
    { line: { kind: "beat" }, command: "@beat" },
    { line: { kind: "form_start", prompt: "q" }, command: "@?" },
    { line: { kind: "form_option", text: "o" }, command: "@+" },
    { line: { kind: "form_input", placeholder: "p" }, command: "@=" },
    { line: { kind: "form_end" }, command: "@/?" },
    { line: { kind: "ending_epilogue", raw: "HE 标题" }, command: "@ending" },
    { line: { kind: "segment_end", nonce: "81ab", reason: "buffer" }, command: "@end" },
  ];

  it("覆盖 v2 全部行类型（映射到全部命令名）", () => {
    for (const { line, command } of table) {
      expect(commandOfDslLineV2(line)).toBe(command);
    }
    expect([...new Set(table.map((entry) => entry.command))].sort()).toEqual(
      [...DSL_V2_COMMANDS].sort(),
    );
  });
});

describe("formatV2RepairInstruction — 修复模板从同一能力卡生成", () => {
  it("包含任务命令集、结束方式与 nonce；不硬编码示例角色", () => {
    const cap = dslTaskCapability("branch_prefetch");
    const diagnostics: DslDiagnosticV2[] = [
      {
        code: "UNKNOWN_LOOK",
        message: "角色 female_A 没有外观 \"laugh\"",
        line: 3,
        legalValues: ["base", "smile"],
      },
    ];
    const instruction = formatV2RepairInstruction(cap, diagnostics, "81ab");
    expect(instruction).toContain("branch_prefetch");
    expect(instruction).toContain(cap.commands.join(" "));
    expect(instruction).toContain("@end <nonce> buffer");
    expect(instruction).toContain("81ab");
    expect(instruction).toContain("第 3 行 [UNKNOWN_LOOK]");
    expect(instruction).toContain("base、smile");
    // 不硬编码苏遥等示例（计划 §4.3：修复模板不能带旧示例角色名）。
    expect(instruction).not.toContain("苏遥");
    expect(instruction).not.toContain("许晚晴");
  });

  it("ending 能力时附 @ending 收束说明", () => {
    const withEnding = formatV2RepairInstruction(
      dslTaskCapability("continuation"),
      [],
      "81ab",
    );
    expect(withEnding).toContain("@ending <TE|HE|NE|BE>");
    const withoutEnding = formatV2RepairInstruction(
      dslTaskCapability("input_bridge"),
      [],
      "81ab",
    );
    expect(withoutEnding).not.toContain("@ending <TE|HE|NE|BE>");
  });
});
