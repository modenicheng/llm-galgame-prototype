/**
 * ClipPlayer — one-shot replay of a past line's PCM for the 回看 panel.
 *
 * The live pipeline (AudioCoordinator + AudioWorklet) is a streaming,
 * timeline-owned machine designed for forward playback only; re-plugging a
 * finished line into it would fight its EOF/drain lifecycle. A finished
 * cache asset is a whole buffer, so replay is the simple Web Audio path:
 * Int16Array → AudioBuffer → source → gain → destination, one source per
 * replay, the previous source stopped when a new one starts (or on stop()).
 *
 * The gain follows the voice channel (voiceVolume + master mute) — replay
 * is speech, so it rides the same loudness knob as live speech. Sample-rate
 * differences are handled by Web Audio itself: an AudioBuffer carries its
 * own rate and the context resamples on playback.
 */

export interface ClipPlayerSource {
  buffer: AudioBuffer | null;
  connect(destination: AudioNode): void;
  start(): void;
  stop(): void;
  onended: (() => void) | null;
}

export class ClipPlayer {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private source: ClipPlayerSource | null = null;
  /** Bumped on every stop()/play() — a stale source's onended must no-op. */
  private epoch = 0;
  private volume = 1;
  private muted = false;
  private playingState = false;

  constructor(context: AudioContext) {
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(context.destination);
  }

  get playing(): boolean {
    return this.playingState;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /**
   * Play a whole decoded line. Replaces any in-flight replay. `onEnded`
   * fires once when the clip reaches its natural end — never after stop()
   * or a replacement.
   */
  play(samples: Int16Array, sampleRate: number, onEnded: () => void): void {
    this.stop();
    const length = samples.length;
    if (length === 0 || sampleRate <= 0) {
      // Nothing playable — report completion immediately so the UI state
      // does not wedge on a "playing" marker that would never clear.
      onEnded();
      return;
    }
    const epoch = ++this.epoch;
    const buffer = this.context.createBuffer(1, length, sampleRate);
    buffer.copyToChannel(int16ToFloat32(samples), 0);
    const source = this.context.createBufferSource() as unknown as ClipPlayerSource;
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      // Real sources fire onended once, but detach first anyway: a stale
      // re-entry must never double-report a completion.
      source.onended = null;
      if (epoch !== this.epoch) return; // stopped or replaced — not a real end
      this.playingState = false;
      if (this.source === source) this.source = null;
      onEnded();
    };
    source.start();
    this.source = source;
    this.playingState = true;
    void this.context.resume().catch(() => {});
  }

  /** Halt the current replay, if any; suppresses its onended callback. */
  stop(): void {
    this.epoch += 1;
    if (this.source !== null) {
      try {
        this.source.stop();
      } catch {
        // stop() before start() is illegal in some implementations; the
        // source is being discarded anyway.
      }
      this.source.onended = null;
      this.source = null;
    }
    this.playingState = false;
  }

  private applyGain(): void {
    this.gain.gain.value = this.muted ? 0 : this.volume;
  }
}

/** s16le mono samples → Web Audio's float32 [-1, 1) range. */
export function int16ToFloat32(samples: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i]! / 32768;
  }
  return out;
}
