/**
 * Tests for the asset catalog YAML loader (docs §57–§58).
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

// Temp directory helpers (per-test isolation for validation tests)

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "catalog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs;
  tempDirs = [];
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

/** Write a placeholder asset file inside a temp dir, creating parent dirs. */
async function writeTempAsset(
  dir: string,
  relPath: string,
  content: string | Buffer = Buffer.from("x"),
): Promise<void> {
  const filePath = path.join(dir, relPath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

// ---------------------------------------------------------------------------
// Fixture YAML (docs §58 shape)
// ---------------------------------------------------------------------------

const SAMPLE_YAML = `
guidance: |
  当前素材覆盖校园走廊与地下据点。

  背景应尽量复用已有资源。

backgrounds:
  hideout_on:
    src: backgrounds/hideout_on.jpg
    description: |
      地下据点，顶部吊灯亮起。
      适合终端相关剧情。

  hallway_day:
    src: backgrounds/hallway_day.jpg
    description: 校园走廊白天。

bgm:
  relax:
    src: audio/bgm/relax.mp3
    description: 来源：andriig-relax（时长约 139s）。

sound_effects:
  terminal_beep:
    src: audio/se/terminal_beep.ogg
    description: 旧终端发出的短促电子提示音。

sprite_sets:
  suyao:
    description: 苏遥正式立绘。

    variants:
      neutral:
        src: characters/suyao/neutral.png
        description: 双眼睁开，接近平静常态。

      speaking_smile:
        src: characters/suyao/speaking_smile.png

characters:
  suyao:
    script_name: 苏遥
    display_name: 苏遥

    sprite_set: suyao
    default_variant: neutral
    default_position: left
`;

// ---------------------------------------------------------------------------
// Successful load + snake_case → camelCase mapping
// ---------------------------------------------------------------------------

describe("loadAssetCatalog", () => {
  it("maps the snake_case YAML onto the camelCase AssetCatalog", async () => {
    const dir = await makeTempDir();
    // Placeholder files matching SAMPLE_YAML srcs (validation requires real files).
    await writeTempAsset(dir, "backgrounds/hideout_on.jpg");
    await writeTempAsset(dir, "backgrounds/hallway_day.jpg");
    await writeTempAsset(dir, "audio/bgm/relax.mp3");
    await writeTempAsset(dir, "audio/se/terminal_beep.ogg");
    await writeTempAsset(dir, "characters/suyao/neutral.png");
    await writeTempAsset(dir, "characters/suyao/speaking_smile.png");
    await writeFile(path.join(dir, "resources.yaml"), SAMPLE_YAML, "utf8");
    const filePath = path.join(dir, "resources.yaml");
    const catalog = await loadAssetCatalog(filePath);

    expect(catalog.guidance).toBe("当前素材覆盖校园走廊与地下据点。\n\n背景应尽量复用已有资源。");

    // Backgrounds
    expect(catalog.backgrounds.hideout_on).toEqual({
      id: "hideout_on",
      src: "backgrounds/hideout_on.jpg",
      description: "地下据点，顶部吊灯亮起。\n适合终端相关剧情。",
    });
    expect(catalog.backgrounds.hallway_day!.description).toBe("校园走廊白天。");

    // BGM / sound effects
    expect(catalog.bgm.relax!.src).toBe("audio/bgm/relax.mp3");
    expect(catalog.bgm.relax!.id).toBe("relax");
    expect(catalog.soundEffects.terminal_beep!.src).toBe("audio/se/terminal_beep.ogg");

    // Sprite sets (optional description preserved; variant description optional)
    expect(catalog.spriteSets.suyao).toEqual({
      id: "suyao",
      description: "苏遥正式立绘。",
      variants: {
        neutral: { id: "neutral", src: "characters/suyao/neutral.png", description: "双眼睁开，接近平静常态。" },
        speaking_smile: { id: "speaking_smile", src: "characters/suyao/speaking_smile.png" },
      },
    });

    // Character bindings
    expect(catalog.characters.suyao).toEqual({
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "neutral",
      defaultPosition: "left",
      allowedSpriteSets: ["suyao"],
    });
  });

  it("strips leading/trailing whitespace from descriptions", async () => {
    const dir = await makeTempDir();
    await writeTempAsset(dir, "backgrounds/a.webp");
    const filePath = path.join(dir, "resources.yaml");
    await writeFile(
      filePath,
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
      "hideout_on",
      "hideout_off",
      "hallway_day",
      "hallway_evening",
      "hallway_night_on",
      "hallway_night_off",
      "clubroom_day",
      "clubroom_evening",
      "clubroom_night_on",
      "clubroom_night_off",
    ]);
    expect(catalog.bgm.relax!.src).toBe("audio/bgm/relax.mp3");
    expect(catalog.bgm.calm!.src).toBe("audio/bgm/calm.mp3");
    expect(catalog.bgm.mountain!.src).toBe("audio/bgm/mountain.mp3");
    expect(catalog.soundEffects.terminal_beep!.src).toBe("audio/se/terminal_beep.ogg");
    expect(Object.keys(catalog.spriteSets)).toEqual([
      "suyao",
      "mysterious_woman",
      "linche",
    ]);
    expect(catalog.characters.suyao).toEqual({
      characterId: "suyao",
      scriptName: "苏遥",
      displayName: "苏遥",
      spriteSet: "suyao",
      defaultVariant: "neutral",
      defaultPosition: "left",
      allowedSpriteSets: ["suyao"],
    });
    expect(catalog.characters.mysterious_woman).toEqual({
      characterId: "mysterious_woman",
      scriptName: "神秘女子",
      displayName: "神秘女子",
      spriteSet: "mysterious_woman",
      defaultVariant: "gentle_smile",
      defaultPosition: "center",
      allowedSpriteSets: ["mysterious_woman"],
    });
    expect(catalog.characters.linche).toEqual({
      characterId: "linche",
      scriptName: "林澈",
      displayName: "林澈",
      spriteSet: "linche",
      defaultVariant: "neutral",
      defaultPosition: "right",
      allowedSpriteSets: ["linche"],
    });
    // The protagonist's placeholder set shares one silhouette file.
    expect(catalog.spriteSets.linche!.variants.thinking!.src).toBe(
      "characters/linche/mysterious_silhouette.png",
    );
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

  it("拒绝 characters.sprite_set 引用不存在的 sprite_set", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: missing",
        "    default_variant: normal",
        "    default_position: left",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/sprite_set/);
  });

  it("拒绝 default_variant 不存在于 sprite_set", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: good",
        "    default_variant: nope",
        "    default_position: left",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/default_variant/);
  });

  it("allowed_sprite_sets 缺省为仅自身；显式列表被保留", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite2.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "  alt:",
        "    variants:",
        "      alt_v: { src: sprite2.png }",
        "characters:",
        "  own_only:",
        "    script_name: 默认角色",
        "    display_name: 默认角色",
        "    sprite_set: good",
        "    default_variant: normal",
        "    default_position: left",
        "  disguised:",
        "    script_name: 伪装者",
        "    display_name: 伪装者",
        "    sprite_set: good",
        "    default_variant: normal",
        "    default_position: left",
        "    allowed_sprite_sets: [good, alt]",
      ].join("\n"),
    );
    const catalog = await loadAssetCatalog(path.join(dir, "resources.yaml"));
    expect(catalog.characters.own_only!.allowedSpriteSets).toEqual(["good"]);
    expect(catalog.characters.disguised!.allowedSpriteSets).toEqual(["good", "alt"]);
  });

  it("拒绝 allowed_sprite_sets 引用不存在的 sprite_set", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: good",
        "    default_variant: normal",
        "    default_position: left",
        "    allowed_sprite_sets: [good, ghost]",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/allowed_sprite_sets/);
  });

  it("拒绝 allowed_sprite_sets 遗漏自身 sprite_set", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite2.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "  alt:",
        "    variants:",
        "      alt_v: { src: sprite2.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: good",
        "    default_variant: normal",
        "    default_position: left",
        "    allowed_sprite_sets: [alt]",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/必须包含自身/);
  });

  it("拒绝原型链键（constructor）作为 default_variant", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: good",
        "    default_variant: constructor",
        "    default_position: left",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/default_variant/);
  });

  it("拒绝原型链键（constructor）作为 sprite_set", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "bg.png"), Buffer.from("x"));
    await writeFile(path.join(dir, "sprite.png"), Buffer.from("x"));
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: bg.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets:",
        "  good:",
        "    variants:",
        "      normal: { src: sprite.png }",
        "characters:",
        "  c:",
        "    script_name: 测试",
        "    display_name: 测试",
        "    sprite_set: constructor",
        "    default_variant: normal",
        "    default_position: left",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/sprite_set/);
  });

  it("拒绝 src 逃逸素材根目录", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: ../secret.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets: {}",
        "characters: {}",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/逃逸|escape/);
  });

  it("拒绝 src 指向不存在的文件", async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, "resources.yaml"),
      [
        "guidance: x",
        "backgrounds:",
        "  a: { src: missing.png, description: d }",
        "bgm: {}",
        "sound_effects: {}",
        "sprite_sets: {}",
        "characters: {}",
      ].join("\n"),
    );
    await expect(loadAssetCatalog(path.join(dir, "resources.yaml"))).rejects.toThrow(/不存在|missing/);
  });
});
