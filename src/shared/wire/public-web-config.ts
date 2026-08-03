/**
 * PublicWebConfig — the browser-safe slice of the Node config (type only).
 *
 * This file is pure data types with NO Node imports so the browser can
 * import it. NEVER add: API key env names, voice IDs, model names, raw
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
