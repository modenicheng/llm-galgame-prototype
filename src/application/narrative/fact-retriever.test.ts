/**
 * fact-retriever 测试（记忆 spec §5.3，MA-B）：
 * 角色交集 / 地点匹配 / major 常驻 / superseded 排除 / checkpoint 倒序 / 上限。
 */

import { describe, it, expect } from "vitest";

import { retrieveFacts } from "./fact-retriever.js";
import type { FactRecord } from "../../core/narrative/memory-types.js";

function makeFact(overrides: Partial<FactRecord> & { id: string }): FactRecord {
  return {
    content: `${overrides.id} content`,
    evidenceEventSeqs: [1],
    checkpoint: 1,
    superseded: false,
    ...overrides,
  };
}

const FACTS: FactRecord[] = [
  makeFact({ id: "f_char", content: "苏遥知道密码", scope: { characters: ["苏遥"] }, checkpoint: 3 }),
  makeFact({ id: "f_loc", content: "地下室第 4 号门焊死", scope: { location: "地下室" }, checkpoint: 5 }),
  makeFact({ id: "f_major", content: "终端仍可运行", importance: "major", checkpoint: 2 }),
  makeFact({ id: "f_old", content: "无锚点旧事实", checkpoint: 1 }),
  makeFact({ id: "f_sup", content: "已被修订", checkpoint: 9, superseded: true, importance: "major" }),
];

describe("retrieveFacts", () => {
  it("selects by character intersection", () => {
    const out = retrieveFacts(FACTS, { characters: ["苏遥"], location: "", max: 8 });
    expect(out.map((f) => f.id)).toContain("f_char");
    expect(out.map((f) => f.id)).not.toContain("f_loc");
  });

  it("selects by location match", () => {
    const out = retrieveFacts(FACTS, { characters: [], location: "地下室", max: 8 });
    expect(out.map((f) => f.id)).toContain("f_loc");
  });

  it("always keeps major facts regardless of scope", () => {
    const out = retrieveFacts(FACTS, { characters: [], location: "", max: 8 });
    expect(out.map((f) => f.id)).toContain("f_major");
  });

  it("excludes superseded records even when major", () => {
    const out = retrieveFacts(FACTS, { characters: [], location: "", max: 8 });
    expect(out.map((f) => f.id)).not.toContain("f_sup");
  });

  it("sorts by checkpoint desc and caps at max", () => {
    const out = retrieveFacts(FACTS, { characters: ["苏遥"], location: "地下室", max: 2 });
    expect(out.map((f) => f.id)).toEqual(["f_loc", "f_char"]);
  });
});
