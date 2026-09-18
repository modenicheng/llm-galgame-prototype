import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYER_SETTINGS,
  loadPlayerSettings,
  normalizePlayerSettings,
  savePlayerSettings,
  type SettingsStorage,
} from "./player-settings.js";

function memoryStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("player-settings", () => {
  it("yields defaults when nothing was saved", () => {
    expect(loadPlayerSettings(memoryStorage())).toEqual(DEFAULT_PLAYER_SETTINGS);
  });

  it("round-trips through save/load", () => {
    const storage = memoryStorage();
    savePlayerSettings(
      { voiceVolume: 0.4, bgmVolume: 0.7, muted: true, textSpeed: 48 },
      storage,
    );
    expect(loadPlayerSettings(storage)).toEqual({
      voiceVolume: 0.4,
      bgmVolume: 0.7,
      muted: true,
      textSpeed: 48,
    });
  });

  it("normalizes corrupt or out-of-range values field by field", () => {
    const settings = normalizePlayerSettings({
      voiceVolume: 7,
      bgmVolume: "loud",
      muted: "yes",
      textSpeed: 9999,
      extra: "ignored",
    });
    expect(settings).toEqual({
      voiceVolume: 1, // clamped
      bgmVolume: DEFAULT_PLAYER_SETTINGS.bgmVolume, // invalid type → default
      muted: DEFAULT_PLAYER_SETTINGS.muted,
      textSpeed: 120, // clamped
    });
  });

  it("returns defaults on corrupt JSON and unavailable storage", () => {
    expect(loadPlayerSettings(memoryStorage())).toEqual(DEFAULT_PLAYER_SETTINGS);
    const broken = memoryStorage();
    broken.data.set("dengying.player-settings.v1", "{not json");
    expect(loadPlayerSettings(broken)).toEqual(DEFAULT_PLAYER_SETTINGS);
    expect(loadPlayerSettings(undefined)).toEqual(DEFAULT_PLAYER_SETTINGS);
  });

  it("swallows setItem failures (quota / private mode)", () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() =>
      savePlayerSettings({ ...DEFAULT_PLAYER_SETTINGS, muted: true }, storage),
    ).not.toThrow();
  });
});
