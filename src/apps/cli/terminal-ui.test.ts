/**
 * Source-level guards for the CLI's narrative-pacing behavior.
 *
 * The terminal UI must never surface generation state: no spinner, no
 * "generating NPC response" copy, no readiness banner. Generation happens
 * behind the reading pace; status panels are debug-only.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const uiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "terminal-ui.ts");
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli-controller.ts");

async function sourceOf(file: string): Promise<string> {
  return readFile(file, "utf8");
}

describe("CLI narrative pacing", () => {
  it("should not surface generation copy outside the opt-in gate", async () => {
    const source = await sourceOf(uiPath);
    for (const banned of ["正在生成 NPC 回应", "NPC 回应已就绪", "NPC 回应生成失败"]) {
      const index = source.indexOf(banned);
      if (index === -1) continue;
      // The copy is only reachable through a helper that early-returns unless
      // debug mode AND input.show_generation_status are enabled.
      const before = source.slice(Math.max(0, index - 400), index);
      expect(before, `ungated copy near: ${banned}`).toMatch(/showGenerationStatus/);
    }
  });

  it("should not contain spinner frames", async () => {
    const source = await sourceOf(uiPath);
    expect(source).not.toMatch(/⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
  });

  it("should gate runtime status panels behind the debug flag", async () => {
    const source = await sourceOf(uiPath);
    // Every status rendering site must be guarded by showRuntimeStatus, either
    // on the same line (ternary spread) or via an enclosing if-block.
    const lines = source.split("\n");
    const unguarded: string[] = [];
    lines.forEach((line, index) => {
      if (!line.includes("compactStatus(")) return;
      if (line.trim().startsWith("function compactStatus")) return;
      const nearby = lines.slice(Math.max(0, index - 1), index + 1).join("\n");
      if (!nearby.includes("showRuntimeStatus")) {
        unguarded.push(`${index + 1}: ${line.trim()}`);
      }
    });
    expect(unguarded).toEqual([]);
  });

  it("should not compute generation state for the preview in the controller", async () => {
    const source = await sourceOf(cliPath);
    expect(source).not.toContain("input-response");
  });
});
