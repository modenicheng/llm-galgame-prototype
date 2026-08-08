/**
 * Tests for the asset catalog YAML loader (docs §57–§58).
 */

import { afterAll, describe, expect, it } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAssetCatalog } from "./asset-catalog-loader.js";

// ---------------------------------------------------------------------------
// Temp file helpers (same pattern as src/config.test.ts)
// ---------------------------------------------------------------------------

let cleanupFiles: string[] = [];

function registerCleanup(filePath: string): void {
  cleanupFiles.push(filePath);
}

afterAll(async () => {
  for (const filePath of cleanupFiles) {
    try {
      await unlink(filePath);
    } catch {
      // best effort
    }
  }
});

async function writeTempYaml(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpdir(), `galgame-assets-${name}-${Date.now()}.yaml`);
  await writeFile(filePath, content, "utf8");
  registerCleanup(filePath);
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixture YAML (docs §58 shape)
// ---------------------------------------------------------------------------

const SAMPLE_YAML = `
guidance: |
  当前素材覆盖校园与地下设施。

  背景应尽量复用已有资源。

backgrounds:
  basement:
    src: backgrounds/basement.webp
    description: |
      昏暗地下设备间。
      主要用于旧终端相关剧情。

  classroom_day:
    src: backgrounds/classroom_day.webp
    description: 白天普通教室。

bgm:
  mystery:
    src: audio/bgm/mystery.ogg
    description: 轻度悬疑和未知感。

sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: 旧终端发出的短促电子提示音。

sprite_sets:
  suyao:
    description: 苏遥正式立绘。

    variants:
      normal:
        src: characters/suyao/normal.webp
        description: 默认冷静状态。

      anxious:
        src: characters/suyao/anxious.webp

characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥

    sprite_set: suyao
    default_variant: normal
    default_position: left
`;

// ---------------------------------------------------------------------------
// Successful load + snake_case → camelCase mapping
// ---------------------------------------------------------------------------

describe("loadAssetCatalog", () => {
  it("maps the snake_case YAML onto the camelCase AssetCatalog", async () => {
    const filePath = await writeTempYaml("sample", SAMPLE_YAML);
    const catalog = await loadAssetCatalog(filePath);

    expect(catalog.guidance).toBe("当前素材覆盖校园与地下设施。\n\n背景应尽量复用已有资源。");

    // Backgrounds
    expect(catalog.backgrounds.basement).toEqual({
      id: "basement",
      src: "backgrounds/basement.webp",
      description: "昏暗地下设备间。\n主要用于旧终端相关剧情。",
    });
    expect(catalog.backgrounds.classroom_day!.description).toBe("白天普通教室。");

    // BGM / sound effects
    expect(catalog.bgm.mystery!.src).toBe("audio/bgm/mystery.ogg");
    expect(catalog.bgm.mystery!.id).toBe("mystery");
    expect(catalog.soundEffects.terminal_beep!.src).toBe("audio/se/terminal_beep.ogg");

    // Sprite sets (optional description preserved; variant description optional)
    expect(catalog.spriteSets.suyao).toEqual({
      id: "suyao",
      description: "苏遥正式立绘。",
      variants: {
        normal: { id: "normal", src: "characters/suyao/normal.webp", description: "默认冷静状态。" },
        anxious: { id: "anxious", src: "characters/suyao/anxious.webp" },
      },
    });

    // Character bindings
    expect(catalog.characters.suyao).toEqual({
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
    });
  });

  it("strips leading/trailing whitespace from descriptions", async () => {
    const filePath = await writeTempYaml(
      "trimmed",
      [
        "guidance: ' 指引 '",
        "backgrounds:",
        "  a:",
        "    src: backgrounds/a.webp",
        "    description: '  描述内容  '",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets: {}",
        "characters: {}",
      ].join("\n"),
    );
    const catalog = await loadAssetCatalog(filePath);
    expect(catalog.guidance).toBe("指引");
    expect(catalog.backgrounds.a!.description).toBe("描述内容");
  });

  it("loads the real assets/resources.yaml", async () => {
    const resourcesPath = fileURLToPath(
      new URL("../../../assets/resources.yaml", import.meta.url),
    );
    const catalog = await loadAssetCatalog(resourcesPath);

    expect(catalog.guidance).toContain("整体采用偏冷色调");
    expect(Object.keys(catalog.backgrounds)).toEqual([
      "classroom_day",
      "classroom_evening",
      "basement",
    ]);
    expect(catalog.bgm.mystery!.src).toBe("audio/bgm/mystery.ogg");
    expect(catalog.soundEffects.terminal_beep!.src).toBe("audio/se/terminal_beep.ogg");
    expect(Object.keys(catalog.spriteSets)).toEqual(["suyao", "placeholder_char"]);
    expect(catalog.characters.suyao).toEqual({
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "normal",
      defaultPosition: "left",
    });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("loadAssetCatalog failures", () => {
  it("throws with the file path on invalid YAML", async () => {
    const filePath = await writeTempYaml("broken", "backgrounds: [unclosed\n  oops: {");
    await expect(loadAssetCatalog(filePath)).rejects.toThrow(/assets-broken/);
  });

  it("throws when the YAML root is not an object", async () => {
    const filePath = await writeTempYaml("scalar", "just a string");
    await expect(loadAssetCatalog(filePath)).rejects.toThrow(/顶层必须是一个对象/);
  });

  it("throws on a schema violation (invalid position)", async () => {
    const filePath = await writeTempYaml(
      "bad-position",
      [
        "guidance: x",
        "backgrounds: {}",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets: {}",
        "characters:",
        "  suyao:",
        "    script_name: 苏遥",
        "    display_name: 苏遥",
        "    sprite_set: suyao",
        "    default_variant: normal",
        "    default_position: top",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(filePath)).rejects.toThrow(/default_position/);
  });

  it("throws when a required asset field is missing", async () => {
    const filePath = await writeTempYaml(
      "missing-src",
      [
        "guidance: x",
        "backgrounds:",
        "  a:",
        "    description: 没有 src",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets: {}",
        "characters: {}",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(filePath)).rejects.toThrow(/src/);
  });

  it("throws when the file does not exist", async () => {
    const missing = path.join(tmpdir(), `galgame-assets-missing-${Date.now()}.yaml`);
    await expect(loadAssetCatalog(missing)).rejects.toThrow(/无法读取资产目录/);
  });
});
