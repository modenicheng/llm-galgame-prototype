/**
 * Architecture guard: the portable core must stay free of Node.js
 * builtins, the OpenAI SDK, and CLI/adapter imports.
 *
 * Checks import/export declarations only, so business text that happens
 * to contain words like "path" or "process" cannot produce false
 * positives.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

const coreRoot = path.dirname(fileURLToPath(import.meta.url));

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Import/export declarations, normalized (single line each). */
function importDeclarations(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith("import") ||
        line.startsWith("export ") && line.includes("from "),
    );
}

describe("core portability boundaries", () => {
  let files: string[];

  beforeAll(async () => {
    files = await listTypeScriptFiles(coreRoot);
    expect(files.length).toBeGreaterThan(0);
  });

  it("should not import Node builtin modules", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const decl of importDeclarations(source)) {
        expect(decl, `${file}: ${decl}`).not.toMatch(/from\s+["']node:/);
        expect(decl, `${file}: ${decl}`).not.toMatch(/from\s+["'](fs|path|os|readline)["']/);
      }
    }
  });

  it("should not import the OpenAI SDK", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const decl of importDeclarations(source)) {
        expect(decl, `${file}: ${decl}`).not.toMatch(/from\s+["']openai["']/);
      }
    }
  });

  it("should not reference process or console globals", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file}`).not.toMatch(/\bprocess\./);
      expect(source, `${file}`).not.toMatch(/\bconsole\./);
    }
  });

  it("should not import CLI app or adapter modules", async () => {
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const decl of importDeclarations(source)) {
        expect(decl, `${file}: ${decl}`).not.toMatch(/apps\//);
        expect(decl, `${file}: ${decl}`).not.toMatch(/adapters\//);
      }
    }
  });
});
