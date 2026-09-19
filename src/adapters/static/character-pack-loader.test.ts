/**
 * 静态角色名册加载器（M1）测试——main 自己的 characters.yaml 内容包 →
 * C2 CharacterRoster。
 *
 * 覆盖：R18/R19（静态 fallback 世界的身份真源落盘、玩家契约
 * playerId=linche、按 ID join 音色、不引入中文别名副本）＋与
 * assets/resources.yaml 兼容边界的漂移检查。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCharacterPackRoster } from "./character-pack-loader.js";
import { createCharacterRegistry } from "../../core/characters/registry.js";
import { loadAssetCatalog } from "../../application/assets/asset-catalog-loader.js";
import { computeRosterRevision } from "../../core/characters/registry.js";

const REPO_PACK = fileURLToPath(new URL("../../../characters.yaml", import.meta.url));
const REPO_CATALOG = fileURLToPath(new URL("../../../assets/resources.yaml", import.meta.url));

describe("loadCharacterPackRoster — 仓库静态名册（玩家契约）", () => {
  it("加载 main characters.yaml：playerId=linche，苏遥为 NPC（§3.3 内容契约）", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    expect(roster.schemaVersion).toBe(2);
    expect(roster.playerId).toBe("linche");
    const linche = roster.characters.find((c) => c.id === "linche");
    const suyao = roster.characters.find((c) => c.id === "suyao");
    expect(linche?.control).toBe("player");
    expect(linche?.initialLabel).toBe("林澈");
    expect(suyao?.control).toBe("npc");
    expect(suyao?.initialLabel).toBe("苏遥");
  });

  it("revision 由加载器按 C2 规范化投影计算（文件不含手写 revision）", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    const { revision, ...draft } = roster;
    expect(revision).toBe(computeRosterRevision(draft));
  });

  it("音色绑定按 ID join（voiceProfileId），无中文别名键", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    const linche = roster.characters.find((c) => c.id === "linche")!;
    const suyao = roster.characters.find((c) => c.id === "suyao")!;
    expect(linche.voiceProfileId).toBe("linche_main");
    expect(suyao.voiceProfileId).toBe("suyao_main");
    // 不允许中文身份别名副本：每个 ID 都是机器键。
    for (const character of roster.characters) {
      expect(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(character.id)).toBe(true);
    }
  });

  it("与 assets/resources.yaml 兼容边界无漂移（presentation ↔ characters 绑定一致）", async () => {
    const [roster, catalog] = await Promise.all([
      loadCharacterPackRoster(REPO_PACK),
      loadAssetCatalog(REPO_CATALOG),
    ]);
    expect(Object.keys(catalog.characters).length).toBeGreaterThan(0);
    for (const character of roster.characters) {
      const binding = catalog.characters[character.id];
      expect(binding, `resources.yaml 应保留 ${character.id} 兼容绑定`).toBeDefined();
      const presentation = character.presentation;
      expect(presentation).toBeDefined();
      const looks = Object.values(presentation!.looks);
      expect(new Set(looks.map((look) => look.spriteSet)).size).toBe(1);
      expect(looks[0]!.spriteSet).toBe(binding!.spriteSet);
      expect(presentation!.looks[presentation!.defaultLook]!.variant).toBe(binding!.defaultVariant);
      expect(presentation!.defaultPosition).toBe(binding!.defaultPosition);
    }
  });

  it("名册可通过 createCharacterRegistry 全量校验（素材绑定真实存在）", async () => {
    const [roster, catalog] = await Promise.all([
      loadCharacterPackRoster(REPO_PACK),
      loadAssetCatalog(REPO_CATALOG),
    ]);
    const registry = createCharacterRegistry(roster, catalog);
    expect(registry.require("linche").control).toBe("player");
    expect(registry.require("suyao").control).toBe("npc");
  });
});

describe("loadCharacterPackRoster — 破损内容包大声失败", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "char-pack-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("缺文件大声报错（身份真源缺失不是空名册）", async () => {
    await expect(loadCharacterPackRoster(path.join(dir, "missing.yaml"))).rejects.toThrow(
      /无法读取|ENOENT/,
    );
  });

  it("YAML 损坏 / schema 不符大声报错", async () => {
    const bad = path.join(dir, "bad.yaml");
    await writeFile(bad, "characters: [ { id: 1 } ]\n", "utf8");
    await expect(loadCharacterPackRoster(bad)).rejects.toThrow();
  });

  it("文件内 revision 与计算值不符时报错（防手工拼接名册）", async () => {
    const p = path.join(dir, "tampered.yaml");
    await writeFile(
      p,
      [
        "schemaVersion: 2",
        "scopeId: test-pack",
        "playerId: p1",
        "revision: v2-deadbeefdeadbeef",
        "characters:",
        "  - id: p1",
        "    name: 玩家",
        "    control: player",
        "    initialLabel: 玩家",
        "    persona: 人设。",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(loadCharacterPackRoster(p)).rejects.toThrow(/revision/);
  });

  it("无玩家/多玩家等内容问题以 CharacterRosterError 结构化失败", async () => {
    const p = path.join(dir, "two-players.yaml");
    await writeFile(
      p,
      [
        "schemaVersion: 2",
        "scopeId: test-pack",
        "playerId: p1",
        "characters:",
        "  - id: p1",
        "    name: 玩家",
        "    control: player",
        "    initialLabel: 玩家",
        "    persona: 人设。",
        "  - id: p2",
        "    name: 乙",
        "    control: player",
        "    initialLabel: 乙",
        "    persona: 人设。",
        "",
      ].join("\n"),
      "utf8",
    );
    await expect(loadCharacterPackRoster(p)).rejects.toThrow(/player_count|玩家控制角色/);
  });
});
