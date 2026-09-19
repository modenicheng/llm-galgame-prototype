/**
 * 作用域内旧身份解析（C2 §3.2「旧世界/会话」行）。
 *
 * 钉住的契约：旧 scriptName / 旧 TTS 键只通过带版本与作用域的兼容映射
 * 解析；同名多义必须给出可诊断的 ambiguous 结果，不许静默任选其一；
 * 未知名字返回 unknown，不许“猜一次姓名”。新生成路径不得调用本模块——
 * 它只存在于 compatibility/wire 过渡边界。
 */
import { describe, expect, it } from "vitest";
import {
  createLegacyIdentityResolver,
  type LegacyIdentityMapping,
} from "./legacy-identity.js";

const mapping: LegacyIdentityMapping = {
  scope: { scopeId: "campus-ops/2026-09", schemaVersion: 1 },
  scriptNames: [
    { scriptName: "许晚晴", characterId: "female_A" },
    { scriptName: "神秘女子", characterId: "female_A" },
    { scriptName: "林小满", characterId: "female_B" },
  ],
  ttsKeys: [{ ttsKey: "xuwanqing", characterId: "female_A" }],
};

describe("createLegacyIdentityResolver", () => {
  const resolver = createLegacyIdentityResolver(mapping);

  it("按作用域解析旧 scriptName（多个旧名可指向同一 ID）", () => {
    expect(resolver.resolveScriptName("许晚晴")).toMatchObject({
      status: "resolved",
      characterId: "female_A",
    });
    expect(resolver.resolveScriptName("神秘女子")).toMatchObject({
      status: "resolved",
      characterId: "female_A",
    });
    expect(resolver.resolveScriptName("林小满")).toMatchObject({
      status: "resolved",
      characterId: "female_B",
    });
  });

  it("解析旧 TTS 配置键（键空间与资产 id 不同源）", () => {
    expect(resolver.resolveTtsKey("xuwanqing")).toMatchObject({
      status: "resolved",
      characterId: "female_A",
      via: "ttsKey",
    });
  });

  it("未知名字返回 unknown 并带诊断，不猜测", () => {
    const result = resolver.resolveScriptName("幽灵");
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.diagnostic).toContain("幽灵");
      expect(result.diagnostic).toContain("campus-ops/2026-09");
    }
  });

  it("结果携带作用域：跨世界同 ID 不共用解析", () => {
    const other = createLegacyIdentityResolver({
      ...mapping,
      scope: { scopeId: "main-fallback/2026-09", schemaVersion: 1 },
      scriptNames: [{ scriptName: "许晚晴", characterId: "linche" }],
    });
    expect(resolver.resolveScriptName("许晚晴")).toMatchObject({
      scopeId: "campus-ops/2026-09",
      characterId: "female_A",
    });
    expect(other.resolveScriptName("许晚晴")).toMatchObject({
      scopeId: "main-fallback/2026-09",
      characterId: "linche",
    });
  });
});

describe("legacy 歧义与非法绑定诊断", () => {
  it("同一旧名映射到多个 ID → ambiguous，候选齐全、不许任选", () => {
    const ambiguous = createLegacyIdentityResolver({
      scope: { scopeId: "campus-ops/2026-09", schemaVersion: 1 },
      scriptNames: [
        { scriptName: "小满", characterId: "female_B" },
        { scriptName: "小满", characterId: "female_C" },
      ],
    });
    const result = ambiguous.resolveScriptName("小满");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toEqual(["female_B", "female_C"]);
      expect(result.diagnostic).toContain("小满");
      expect(result.diagnostic).toContain("female_B");
      expect(result.diagnostic).toContain("female_C");
    }
  });

  it("同一旧名重复绑定到同一 ID 不算歧义（去重后 resolved）", () => {
    const duplicated = createLegacyIdentityResolver({
      scope: { scopeId: "campus-ops/2026-09", schemaVersion: 1 },
      scriptNames: [
        { scriptName: "许晚晴", characterId: "female_A" },
        { scriptName: "许晚晴", characterId: "female_A" },
      ],
    });
    expect(duplicated.resolveScriptName("许晚晴")).toMatchObject({
      status: "resolved",
      characterId: "female_A",
    });
  });

  it("绑定到危险键 ID 的旧名 → invalid 诊断（不产出原型键身份）", () => {
    const dangerous = createLegacyIdentityResolver({
      scope: { scopeId: "campus-ops/2026-09", schemaVersion: 1 },
      scriptNames: [{ scriptName: "许晚晴", characterId: "constructor" }],
    });
    const result = dangerous.resolveScriptName("许晚晴");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.diagnostic).toContain("constructor");
    }
  });

  it("内部字典无原型：以 “toString” 作旧名不会命中原型方法", () => {
    const resolver = createLegacyIdentityResolver(mapping);
    expect(resolver.resolveScriptName("toString").status).toBe("unknown");
    expect(resolver.resolveTtsKey("hasOwnProperty").status).toBe("unknown");
  });
});
