/**
 * PcmWorkletProcessor — shared AudioWorklet playback for ALL lines (§10.4).
 *
 * Plain JavaScript (not TS): this file is loaded by the browser as an
 * AudioWorklet module via `addModule(workletUrl)`, and Vite only emits a
 * real `?url` asset for non-TypeScript sources — a `.ts?url` import is
 * dropped from the production bundle, breaking audio in `npm start:web`.
 *
 * Runs in the AudioWorklet scope. Receives PCM samples (Int16Array, or a
 * pre-scaled Float32Array) through the MessagePort, holds them in a
 * Float32Array ring buffer (~1s at 22050 Hz), and pops samples into the
 * output channel inside process(). When the ring runs dry it posts an
 * `underrun` message to the main thread.
 *
 * The class is exported so tests can import it directly in Node; the
 * `registerProcessor` call is guarded because AudioWorkletProcessor does
 * not exist outside the worklet scope.
 */

const DEFAULT_SAMPLE_RATE = 22050;

/** Base class: the real worklet base in scope, a minimal stand-in in Node. */
const AudioWorkletProcessorBase =
  typeof AudioWorkletProcessor !== "undefined"
    ? AudioWorkletProcessor
    : class AudioWorkletProcessorFallback {
        port = new MessageChannel().port1;
        currentTime = 0;
        sampleRate = 22050;
      };

export class PcmWorkletProcessor extends AudioWorkletProcessorBase {
  static get parameterDescriptors() {
    return [];
  }

  chunks = [];
  headChunk = 0;
  headOffset = 0;
  queued = 0;
  phase = 0;
  sourceRate = DEFAULT_SAMPLE_RATE;
  outputRate = DEFAULT_SAMPLE_RATE;

  constructor(options = {}) {
    super(options);
    const configuredSourceRate = options.processorOptions?.sourceRate;
    this.sourceRate =
      typeof configuredSourceRate === "number" && configuredSourceRate > 0
        ? configuredSourceRate
        : DEFAULT_SAMPLE_RATE;
    this.outputRate =
      typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : this.sourceRate;
    this.port.onmessage = (event) => {
      this.handlePortMessage(event);
    };
  }

  /** Handle a message from the main thread (public for direct testing). */
  handlePortMessage(event) {
    const data = event.data;
    if (data === null || typeof data !== "object") {
      return;
    }
    if ("type" in data && data.type === "clear") {
      this.resetRing();
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.enqueue(data);
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }
    let underrun = false;
    const step = this.sourceRate / this.outputRate;
    for (let i = 0; i < output.length; i++) {
      if (this.queued === 0) {
        output[i] = 0;
        underrun = true;
        continue;
      }
      const current = this.sampleAt(0);
      const next = this.queued > 1 ? this.sampleAt(1) : current;
      output[i] = current + (next - current) * this.phase;
      this.phase += step;
      const consumed = Math.floor(this.phase);
      if (consumed > 0) {
        this.phase -= consumed;
        this.consume(consumed);
      }
    }
    if (underrun) {
      this.port.postMessage({ type: "underrun" });
    }
    return true;
  }

  enqueue(samples) {
    if (samples.length === 0) return;
    this.chunks.push(samples);
    this.queued += samples.length;
  }

  sampleAt(offset) {
    let chunkIndex = this.headChunk;
    let sampleIndex = this.headOffset + offset;
    while (chunkIndex < this.chunks.length) {
      const chunk = this.chunks[chunkIndex];
      if (sampleIndex < chunk.length) {
        const value = chunk[sampleIndex];
        return chunk instanceof Int16Array ? value / 32768 : value;
      }
      sampleIndex -= chunk.length;
      chunkIndex++;
    }
    return 0;
  }

  consume(count) {
    let remaining = Math.min(count, this.queued);
    this.queued -= remaining;
    while (remaining > 0) {
      const chunk = this.chunks[this.headChunk];
      const available = chunk.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.headChunk++;
        this.headOffset = 0;
      }
    }
    if (this.headChunk > 32 && this.headChunk * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headChunk);
      this.headChunk = 0;
    }
  }

  resetRing() {
    this.chunks = [];
    this.headChunk = 0;
    this.headOffset = 0;
    this.queued = 0;
    this.phase = 0;
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  registerProcessor("pcm-playback", PcmWorkletProcessor);
}
