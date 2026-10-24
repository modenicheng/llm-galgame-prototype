/**
 * PlayerSettings — persisted player preferences: per-channel volumes, master
 * mute and text speed. localStorage-backed so the booth session survives a
 * page reload; every access is fail-open (private mode, quota, corrupt JSON
 * degrade to defaults) — settings are a convenience, never a session blocker.
 */

export interface PlayerSettings {
  /** 语音（TTS 回放）音量，0..1。 */
  voiceVolume: number;
  /** BGM 音量，0..1。 */
  bgmVolume: number;
  /** 总静音（语音 + BGM）。 */
  muted: boolean;
  /** 打字机字速（字/秒）。 */
  textSpeed: number;
}

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  voiceVolume: 1,
  bgmVolume: 1,
  muted: false,
  textSpeed: 32,
};

const STORAGE_KEY = "dengying.player-settings.v1";

/** Minimal storage surface (localStorage shape) — injectable for tests. */
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function clamp01(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function clampSpeed(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(120, Math.max(5, value)));
}

/** Merge stored partials onto defaults, dropping anything invalid. */
export function normalizePlayerSettings(raw: unknown): PlayerSettings {
  const settings: PlayerSettings = { ...DEFAULT_PLAYER_SETTINGS };
  if (raw === null || typeof raw !== "object") return settings;
  const record = raw as Record<string, unknown>;
  const voice = clamp01(record.voiceVolume);
  if (voice !== null) settings.voiceVolume = voice;
  const bgm = clamp01(record.bgmVolume);
  if (bgm !== null) settings.bgmVolume = bgm;
  if (typeof record.muted === "boolean") settings.muted = record.muted;
  const speed = clampSpeed(record.textSpeed);
  if (speed !== null) settings.textSpeed = speed;
  return settings;
}

/** Read persisted settings; missing or unreadable storage yields defaults. */
export function loadPlayerSettings(storage?: SettingsStorage): PlayerSettings {
  const store = storage ?? defaultStorage();
  if (store === null) return { ...DEFAULT_PLAYER_SETTINGS };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_PLAYER_SETTINGS };
    return normalizePlayerSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PLAYER_SETTINGS };
  }
}

/** Persist settings; storage failures are swallowed by design. */
export function savePlayerSettings(
  settings: PlayerSettings,
  storage?: SettingsStorage,
): void {
  const store = storage ?? defaultStorage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota / private mode: settings stay session-local.
  }
}

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
