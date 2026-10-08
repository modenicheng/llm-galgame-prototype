/**
 * Node-side builder for the browser-safe PublicWebConfig.
 *
 * The builder imports the wire type; the wire type never imports Node
 * config. This file stays Node-only (it imports ../config.js).
 */
import type { PublicWebConfig } from "../shared/wire/public-web-config.js";
import { DEFAULT_PUBLIC_WEB_CONFIG } from "../shared/wire/public-web-config.js";
import type { AppConfig } from "../config.js";

export function toPublicWebConfig(config: AppConfig): PublicWebConfig {
  const playback = config.media.audio.playback;
  const cache = config.media.audio.cache;
  const defaults = DEFAULT_PUBLIC_WEB_CONFIG.audio;
  return {
    audio: {
      playback: {
        startup_buffer_ms: playback?.startup_buffer_ms ?? defaults.playback.startup_buffer_ms,
        critical_watermark_ms:
          playback?.critical_watermark_ms ?? defaults.playback.critical_watermark_ms,
        low_watermark_ms: playback?.low_watermark_ms ?? defaults.playback.low_watermark_ms,
        target_buffer_ms: playback?.target_buffer_ms ?? defaults.playback.target_buffer_ms,
        voice_delay_ms: playback?.voice_delay_ms ?? defaults.playback.voice_delay_ms,
      },
      cache: {
        write_batch_bytes: cache?.write_batch_bytes ?? defaults.cache.write_batch_bytes,
        write_flush_interval_ms:
          cache?.write_flush_interval_ms ?? defaults.cache.write_flush_interval_ms,
      },
      format: {
        encoding: "pcm_s16le",
        sampleRate: config.media.audio.synthesis?.sample_rate ?? defaults.format.sampleRate,
        channels: 1,
        bitDepth: 16,
      },
    },
    game: {
      show_line_ids: config.game.show_line_ids,
    },
  };
}
