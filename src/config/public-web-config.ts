/**
 * Node-side builder for the browser-safe PublicWebConfig.
 *
 * The builder imports the wire type; the wire type never imports Node
 * config. This file stays Node-only (it imports ../config.js).
 */
import type { PublicWebConfig } from "../shared/wire/public-web-config.js";
import type { AppConfig } from "../config.js";

export function toPublicWebConfig(config: AppConfig): PublicWebConfig {
  const playback = config.media.audio.playback;
  const cache = config.media.audio.cache;
  return {
    audio: {
      playback: {
        startup_buffer_ms: playback?.startup_buffer_ms ?? 350,
        critical_watermark_ms: playback?.critical_watermark_ms ?? 500,
        low_watermark_ms: playback?.low_watermark_ms ?? 2500,
        target_buffer_ms: playback?.target_buffer_ms ?? 6500,
      },
      cache: {
        write_batch_bytes: cache?.write_batch_bytes ?? 262_144,
        write_flush_interval_ms: cache?.write_flush_interval_ms ?? 300,
      },
      format: {
        encoding: "pcm_s16le",
        sampleRate: config.media.audio.synthesis?.sample_rate ?? 22050,
        channels: 1,
        bitDepth: 16,
      },
    },
    game: {
      show_line_ids: config.game.show_line_ids,
    },
  };
}
