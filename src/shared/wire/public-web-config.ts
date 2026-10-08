/**
 * PublicWebConfig — the browser-safe slice of the Node config (type +
 * offline fallback values).
 *
 * This file is pure data with NO Node imports so the browser can import
 * it. NEVER add: API key env names, voice IDs, model names, raw
 * instructions, or the synthesis provider's secret parameters. The
 * browser only needs playback + cache tuning and the audio format, all of
 * which are already public knowledge in the AudioDescriptor.
 */
export interface PublicWebConfig {
  audio: {
    playback: {
      startup_buffer_ms: number;
      critical_watermark_ms: number;
      low_watermark_ms: number;
      target_buffer_ms: number;
      /** 每句角色音频开播前的固定延迟（ms；0 = 不延迟）。 */
      voice_delay_ms: number;
    };
    cache: {
      write_batch_bytes: number;
      write_flush_interval_ms: number;
    };
    format: {
      encoding: "pcm_s16le";
      sampleRate: number;
      channels: 1;
      bitDepth: 16;
    };
  };
  game: {
    show_line_ids: boolean;
  };
}

/**
 * Fallback values used when `GET /api/config` is absent (web offline
 * defaults) and as the builder's per-field defaults. Single source for
 * both — previously duplicated in web/src/app.ts and the Node builder.
 */
export const DEFAULT_PUBLIC_WEB_CONFIG: PublicWebConfig = {
  audio: {
    playback: {
      startup_buffer_ms: 350,
      critical_watermark_ms: 500,
      low_watermark_ms: 2500,
      target_buffer_ms: 6500,
      voice_delay_ms: 0,
    },
    cache: {
      write_batch_bytes: 262144,
      write_flush_interval_ms: 300,
    },
    format: {
      encoding: "pcm_s16le",
      sampleRate: 22050,
      channels: 1,
      bitDepth: 16,
    },
  },
  game: {
    show_line_ids: false,
  },
};
