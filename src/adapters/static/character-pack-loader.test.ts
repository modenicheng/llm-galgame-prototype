/**
 * 静态角色名册加载器（M1）测试——main 自己的 characters.yaml 内容包 →
 * C2 CharacterRoster。
 *
 * 覆盖：R18/R19（静态 fallback 世界的身份真源落盘、玩家契约
 * playerId=player（用户裁定 2026-09-19：林澈=NPC、玩家无名第一视角，
 * 对齐 campus 侧 player 条目模式）、按 ID join 音色、不引入中文别名
 * 副本）＋与 assets/resources.yaml 兼容边界的漂移检查。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCharacterPackRoster } from "./character-pack-loader.js";
import { createCharacterRegistry } from "../../core/characters/registry.js";
import { loadAssetCatalog } from "../../application/assets/asset-catalog-loader.js";
import { computeRosterRevision } from "../../core/characters/registry.js";

const REPO_PACK = fileURLToPath(new URL("../../../characters.yaml", import.meta.url));
const REPO_CATALOG = fileURLToPath(new URL("../../../assets/resources.yaml", import.meta.url));
const REPO_CARDS = fileURLToPath(new URL("../../../prompts/characters.txt", import.meta.url));

describe("loadCharacterPackRoster — 仓库静态名册（玩家契约）", () => {
  it("加载 main characters.yaml：playerId=player（无名玩家），林澈/苏遥均为 NPC（用户裁定 2026-09-19）", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    expect(roster.schemaVersion).toBe(2);
    expect(roster.playerId).toBe("player");
    const player = roster.characters.find((c) => c.id === "player");
    const linche = roster.characters.find((c) => c.id === "linche");
    const suyao = roster.characters.find((c) => c.id === "suyao");
    // 玩家 = 无名第一视角实体（对齐 campus player 条目）：无立绘、无音色，
    // persona 只含控制契约。
    expect(player?.control).toBe("player");
    expect(player?.name).toBe("玩家");
    expect(player?.initialLabel).toBe("你");
    expect(player?.presentation).toBeUndefined();
    expect(player?.voiceProfileId).toBeUndefined();
    expect(player?.persona).toContain("模型");
    expect(player?.persona).not.toContain("林澈");
    // 林澈降为普通 NPC：可正常发声（保留人物卡与音色/立绘）。
    expect(linche?.control).toBe("npc");
    expect(linche?.initialLabel).toBe("林澈");
    expect(suyao?.control).toBe("npc");
    expect(suyao?.initialLabel).toBe("苏遥");
  });

  it("林澈人设不再携带玩家控制条款（模型可写林澈台词）", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    const linche = roster.characters.find((c) => c.id === "linche")!;
    expect(linche.control).toBe("npc");
    expect(linche.persona).not.toContain("玩家控制");
    expect(linche.persona).not.toContain("不得替林澈");
  });

  it("revision 由加载器按 C2 规范化投影计算（文件不含手写 revision）", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    const { revision, ...draft } = roster;
    expect(revision).toBe(computeRosterRevision(draft));
  });

  it("音色绑定按 ID join（voiceProfileId）；玩家实体无音色", async () => {
    const roster = await loadCharacterPackRoster(REPO_PACK);
    const player = roster.characters.find((c) => c.id === "player")!;
    const linche = roster.characters.find((c) => c.id === "linche")!;
    const suyao = roster.characters.find((c) => c.id === "suyao")!;
    expect(player.voiceProfileId).toBeUndefined();
    expect(linche.voiceProfileId).toBe("linche_main");
    expect(suyao.voiceProfileId).toBe("suyao_main");
    // 不允许中文身份别名副本：每个 ID 都是机器键。
    for (const character of roster.characters) {
      expect(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(character.id)).toBe(true);
    }
  });

  it("与 assets/resources.yaml 兼容边界无漂移（presentation ↔ characters 绑定一致；玩家无 presentation）", async () => {
    const [roster, catalog] = await Promise.all([
      loadCharacterPackRoster(REPO_PACK),
      loadAssetCatalog(REPO_CATALOG),
    ]);
    expect(Object.keys(catalog.characters).length).toBeGreaterThan(0);
    for (const character of roster.characters) {
      // 玩家实体无立绘（campus player 模式）；素材绑定只校验 NPC。
      if (character.control === "player") {
        expect(character.presentation).toBeUndefined();
        continue;
      }
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
    expect(registry.require("player").control).toBe("player");
    expect(registry.require("linche").control).toBe("npc");
    expect(registry.require("suyao").control).toBe("npc");
    // 恰好一名玩家（无名实体）；林澈/苏遥都是可发声 NPC。
    const players = roster.characters.filter((c) => c.control === "player");
    expect(players.map((p) => p.id)).toEqual(["player"]);
  });

  it("派生人物卡投影（prompts/characters.txt）与名册玩家契约一致（防漂移）", async () => {
    const card = await readFile(REPO_CARDS, "utf8");
    // 旧契约（f758fe2 主解读）的痕迹必须清除：林澈不再是玩家控制角色。
    expect(card).not.toContain("playerId=linche");
    expect(card).not.toContain("不得替林澈");
    // 「模型不得替玩家生成台词/选择/确认对白」防线指向无名玩家实体。
    expect(card).toContain("玩家");
    expect(card).toContain("模型");
    // 林澈以普通 NPC 身份保留人物卡。
    expect(card).toContain("林澈");
    expect(card).toContain("苏遥");
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
