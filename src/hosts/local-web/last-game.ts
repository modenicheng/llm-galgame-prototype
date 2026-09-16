/**
 * games/.last-game — 最近世界 id 的 best-effort 持久化（M5.0 宿主接线）。
 *
 * local-web 启动时：显式指定（--game / 环境变量）优先；未显式指定时读
 * 这里实现「继续游戏」；世界落定后写回。读写全部 best-effort：文件缺失、
 * 损坏或内容非法 → 视为无记录（开新世界）；写失败静默，不阻塞启动。
 * gameId 会成为目录名（games/<gameId>/…，§9），因此只接受安全字符集。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LAST_GAME_FILE = ".last-game";

/** 首字符须为字母/数字，其余限字母数字点横线下划线——排除路径分隔与遍历。 */
const GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidGameId(gameId: string): boolean {
  return GAME_ID_PATTERN.test(gameId);
}

export function readLastGameId(gamesRoot: string): string | undefined {
  try {
    const raw = readFileSync(path.join(gamesRoot, LAST_GAME_FILE), "utf8").trim();
    return isValidGameId(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastGameId(gamesRoot: string, gameId: string): void {
  try {
    mkdirSync(gamesRoot, { recursive: true });
    writeFileSync(path.join(gamesRoot, LAST_GAME_FILE), `${gameId}\n`, "utf8");
  } catch (error) {
    // best-effort：持久化失败不阻塞启动，但要可观测（否则「没续上世界」无从排查）。
    console.warn(`[last-game] 写入 ${path.join(gamesRoot, LAST_GAME_FILE)} 失败：`, error);
  }
}

/**
 * 显式解析：启动参数 > 环境变量（M5.0 ①，参数优先）。两者皆缺返回
 * undefined，由调用方决定回退 .last-game（web）还是直接开新世界（cli）。
 * 显式给出的非法 id 大声抛错——静默忽略会让用户落进错误的世界。
 */
export function resolveExplicitGameId(
  arg: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const fromArg = arg?.trim();
  if (fromArg !== undefined && fromArg !== "") {
    if (!isValidGameId(fromArg)) {
      throw new Error(`非法 --game id：${fromArg}（只允许字母/数字/点/横线/下划线）`);
    }
    return fromArg;
  }
  const fromEnv = env.VIBEGAL_GAME_ID?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!isValidGameId(fromEnv)) {
      throw new Error(`非法 VIBEGAL_GAME_ID：${fromEnv}（只允许字母/数字/点/横线/下划线）`);
    }
    return fromEnv;
  }
  return undefined;
}
