/**
 * 角色 ID / 姓名 / 名牌校验与运行时名牌状态（C2 §3.1）。
 *
 * 钉住的契约：ID 是机器键（`female_A` 等既有 ID 原样保留、区分大小写），
 * 姓名与名牌是 Unicode 文本（trim 后 1–64 个码点，拒绝控制字符，不强制
 * 汉字）；字典无原型、成员检查不走原型链。
 */
import { describe, expect, it } from "vitest";
import {
  DANGEROUS_ID_KEYS,
  CharacterDefinitionSchema,
  CharacterIdSchema,
  CharacterLabelSchema,
  CharacterRuntimeStateSchema,
  createCharacterRuntimeState,
  isDangerousKey,
  isValidCharacterId,
  resolveCharacterLabel,
  withCharacterLabel,
} from "./types.js";
import { createInitialVisualState } from "../presentation/defaults.js";
import { createVisualStateReducer } from "../presentation/reducer.js";

// ---------------------------------------------------------------------------
// isValidCharacterId / isDangerousKey
// ---------------------------------------------------------------------------
describe("isValidCharacterId", () => {
  it("接受既有稳定 ID（female_A 等不重编号）", () => {
    expect(isValidCharacterId("female_A")).toBe(true);
    expect(isValidCharacterId("raspberry")).toBe(true);
    expect(isValidCharacterId("suyao")).toBe(true);
  });

  it("区分大小写：female_A 与 Female_A 都是合法且不同的 ID", () => {
    expect(isValidCharacterId("female_A")).toBe(true);
    expect(isValidCharacterId("Female_A")).toBe(true);
    expect("female_A").not.toBe("Female_A");
  });

  it("接受英文名、连字符、下划线与数字（首字符必须是字母）", () => {
    expect(isValidCharacterId("a")).toBe(true);
    expect(isValidCharacterId("npc-1")).toBe(true);
    expect(isValidCharacterId("mysterious_woman")).toBe(true);
    expect(isValidCharacterId("A9")).toBe(true);
  });

  it("拒绝数字/下划线开头、超长、空串", () => {
    expect(isValidCharacterId("")).toBe(false);
    expect(isValidCharacterId("9lead")).toBe(false);
    expect(isValidCharacterId("_npc")).toBe(false);
    expect(isValidCharacterId("-npc")).toBe(false);
    expect(isValidCharacterId("a".repeat(64))).toBe(true);
    expect(isValidCharacterId("a".repeat(65))).toBe(false);
  });

  it("拒绝空白、冒号、括号与控制字符（不静默截断或归一化）", () => {
    expect(isValidCharacterId(" suyao")).toBe(false);
    expect(isValidCharacterId("suyao ")).toBe(false);
    expect(isValidCharacterId("su yao")).toBe(false);
    expect(isValidCharacterId("suyao:main")).toBe(false);
    expect(isValidCharacterId("suyao：main")).toBe(false);
    expect(isValidCharacterId("suyao(x)")).toBe(false);
    expect(isValidCharacterId("suyao（x）")).toBe(false);
    expect(isValidCharacterId("suyao\n")).toBe(false);
    expect(isValidCharacterId("suyao ")).toBe(false);
  });

  it("拒绝非 ASCII：显示名不是机器键", () => {
    expect(isValidCharacterId("苏遥")).toBe(false);
    expect(isValidCharacterId("神秘女子")).toBe(false);
  });
});

describe("isDangerousKey", () => {
  it("标记对象原型危险键 __proto__/prototype/constructor", () => {
    expect(DANGEROUS_ID_KEYS).toContain("__proto__");
    expect(DANGEROUS_ID_KEYS).toContain("prototype");
    expect(DANGEROUS_ID_KEYS).toContain("constructor");
    for (const key of DANGEROUS_ID_KEYS) expect(isDangerousKey(key)).toBe(true);
  });

  it("不误伤正常键", () => {
    expect(isDangerousKey("female_A")).toBe(false);
    expect(isDangerousKey("toString")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schemas — CharacterIdSchema / CharacterLabelSchema
// ---------------------------------------------------------------------------
describe("CharacterIdSchema", () => {
  it("接受合法 ID", () => {
    expect(CharacterIdSchema.safeParse("female_A").success).toBe(true);
  });

  it("拒绝危险键与非法格式", () => {
    expect(CharacterIdSchema.safeParse("prototype").success).toBe(false);
    expect(CharacterIdSchema.safeParse("constructor").success).toBe(false);
    expect(CharacterIdSchema.safeParse("__proto__").success).toBe(false);
    expect(CharacterIdSchema.safeParse("a b").success).toBe(false);
    expect(CharacterIdSchema.safeParse("苏遥").success).toBe(false);
  });
});

describe("CharacterLabelSchema（姓名/名牌共用规则）", () => {
  it("接受中文姓名、英文名与“神秘女子”式名牌", () => {
    expect(CharacterLabelSchema.safeParse("许晚晴").success).toBe(true);
    expect(CharacterLabelSchema.safeParse("Xu Wanqing").success).toBe(true);
    expect(CharacterLabelSchema.safeParse("神秘女子").success).toBe(true);
  });

  it("接受首尾空白（trim 后 1–64 码点即合法）", () => {
    expect(CharacterLabelSchema.safeParse("  苏遥  ").success).toBe(true);
  });

  it("拒绝空串与纯空白", () => {
    expect(CharacterLabelSchema.safeParse("").success).toBe(false);
    expect(CharacterLabelSchema.safeParse("   ").success).toBe(false);
  });

  it("按 Unicode 码点计数：64 个表情合法、65 个非法", () => {
    expect(CharacterLabelSchema.safeParse("😀".repeat(64)).success).toBe(true);
    expect(CharacterLabelSchema.safeParse("😀".repeat(65)).success).toBe(false);
  });

  it("64 个汉字合法、65 个非法", () => {
    expect(CharacterLabelSchema.safeParse("苏".repeat(64)).success).toBe(true);
    expect(CharacterLabelSchema.safeParse("苏".repeat(65)).success).toBe(false);
  });

  it("拒绝换行与控制字符（含字符串内部）", () => {
    expect(CharacterLabelSchema.safeParse("苏遥\n苏遥").success).toBe(false);
    expect(CharacterLabelSchema.safeParse("苏遥\t苏遥").success).toBe(false);
    expect(CharacterLabelSchema.safeParse("苏遥\u0085苏遥").success).toBe(false);
    expect(CharacterLabelSchema.safeParse("苏遥\u007f苏遥").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CharacterDefinitionSchema
// ---------------------------------------------------------------------------
describe("CharacterDefinitionSchema", () => {
  const full = {
    id: "female_A",
    name: "许晚晴",
    control: "npc",
    initialLabel: "许晚晴",
    persona: "温柔娴静的学姐，借出的笔总记得收回。",
    presentation: {
      defaultLook: "base",
      defaultPosition: "right",
      looks: {
        base: { spriteSet: "female_A", variant: "base" },
        smile: { spriteSet: "female_A", variant: "smile" },
      },
    },
    voiceProfileId: "xuwanqing_main",
  };

  it("接受完整定义", () => {
    expect(CharacterDefinitionSchema.safeParse(full).success).toBe(true);
  });

  it("接受无立绘、无音色的 NPC（不允许因缺资源而丢失身份）", () => {
    const artless = {
      id: "npc_mysterious",
      name: "未知来电者",
      control: "npc",
      initialLabel: "神秘女子",
      persona: "只在电话里出现。",
    };
    expect(CharacterDefinitionSchema.safeParse(artless).success).toBe(true);
  });

  it("拒绝缺省 look 不在 looks 清单内的定义", () => {
    const bad = { ...full, presentation: { ...full.presentation, defaultLook: "angry" } };
    const result = CharacterDefinitionSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.success === false && JSON.stringify(result.error.issues)).toContain("defaultLook");
  });

  it("拒绝 looks 中的危险键", () => {
    const bad = {
      ...full,
      presentation: {
        ...full.presentation,
        looks: { constructor: { spriteSet: "female_A", variant: "base" } },
      },
    };
    expect(CharacterDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it("拒绝 looks 中自有 __proto__ 键（z.record 会静默丢弃的形态）", () => {
    const raw = JSON.parse(
      '{"id":"female_A","name":"许晚晴","control":"npc","initialLabel":"许晚晴","persona":"温柔娴静的学姐。","presentation":{"defaultLook":"__proto__","defaultPosition":"right","looks":{"__proto__":{"spriteSet":"female_A","variant":"base"}}}}',
    );
    expect(Object.hasOwn(raw.presentation.looks, "__proto__")).toBe(true);
    expect(CharacterDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it("拒绝未知控制类型", () => {
    expect(CharacterDefinitionSchema.safeParse({ ...full, control: "sidekick" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CharacterRuntimeState — 名牌状态
// ---------------------------------------------------------------------------
describe("CharacterRuntimeState labels", () => {
  const definition = {
    id: "npc_mysterious",
    initialLabel: "神秘女子",
  };

  it("初始状态无名牌，解析回 initialLabel", () => {
    const state = createCharacterRuntimeState();
    expect(resolveCharacterLabel(state, definition)).toBe("神秘女子");
  });

  it("无立绘角色可改名：label 独立于 VisualState 存在", () => {
    const state = withCharacterLabel(createCharacterRuntimeState(), "npc_mysterious", "许晚晴");
    expect(resolveCharacterLabel(state, definition)).toBe("许晚晴");
  });

  it("名牌字典无原型：toString 之类键不泄漏原型成员", () => {
    const state = createCharacterRuntimeState();
    expect(Object.getPrototypeOf(state.labels)).toBeNull();
    // 成员检查不走原型链：未设置的名牌键取不到 Object.prototype 成员。
    expect(state.labels["toString"]).toBeUndefined();
    expect(state.labels["constructor"]).toBeUndefined();
  });

  it("withCharacterLabel 校验名牌文本并保持纯函数", () => {
    const base = createCharacterRuntimeState();
    const next = withCharacterLabel(base, "npc_mysterious", "许晚晴");
    expect(resolveCharacterLabel(base, definition)).toBe("神秘女子");
    expect(resolveCharacterLabel(next, definition)).toBe("许晚晴");
    expect(() => withCharacterLabel(base, "npc_mysterious", "")).toThrow();
    expect(() => withCharacterLabel(base, "npc_mysterious", "苏遥\n苏遥")).toThrow();
  });

  it("label 键本身也拒绝危险键", () => {
    expect(() =>
      withCharacterLabel(createCharacterRuntimeState(), "constructor", "许晚晴"),
    ).toThrow();
  });

  it("@ch exit 只清 VisualState，不清空名牌（状态分域，C2 钉住）", () => {
    const reduce = createVisualStateReducer({ defaultFor: () => undefined });
    const visual = {
      ...createInitialVisualState(),
      characters: {
        npc_mysterious: {
          spriteSet: "none",
          variant: "base",
          position: "center" as const,
          displayName: "神秘女子",
          visible: true,
        },
      },
    };
    const afterExit = reduce(visual, [
      { type: "character_patch", character: "npc_mysterious", exit: true },
    ]);
    expect(afterExit.characters).not.toHaveProperty("npc_mysterious");

    const labels = withCharacterLabel(createCharacterRuntimeState(), "npc_mysterious", "许晚晴");
    expect(resolveCharacterLabel(labels, definition)).toBe("许晚晴");
  });
});

// ---------------------------------------------------------------------------
// CharacterRuntimeStateSchema
// ---------------------------------------------------------------------------
describe("CharacterRuntimeStateSchema", () => {
  it("接受合法名牌表", () => {
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { female_A: "神秘女子" } }).success,
    ).toBe(true);
  });

  it("拒绝非法名牌文本", () => {
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { female_A: "   " } }).success,
    ).toBe(false);
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { female_A: "许\n晚" } }).success,
    ).toBe(false);
  });

  it("labels 记录键拒绝危险键（constructor/prototype/__proto__）", () => {
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { constructor: "许晚晴" } }).success,
    ).toBe(false);
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { prototype: "许晚晴" } }).success,
    ).toBe(false);
    // 对象字面量里的 `__proto__:` 是原型赋值而非自有键——用 JSON.parse
    // 构造出自有 __proto__ 键（持久化/解析边界真实会出现的形态）。
    const withProto = JSON.parse('{"labels":{"__proto__":"许晚晴"}}');
    expect(Object.hasOwn(withProto.labels, "__proto__")).toBe(true);
    expect(CharacterRuntimeStateSchema.safeParse(withProto).success).toBe(false);
    // 正常键不受影响。
    expect(
      CharacterRuntimeStateSchema.safeParse({ labels: { female_A: "神秘女子" } }).success,
    ).toBe(true);
  });
});
