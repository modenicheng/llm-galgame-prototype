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

const RING_SIZE = 44100; // 1s at 22050 Hz

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

  buffer = new Float32Array(RING_SIZE);
  writeIndex = 0;
  readIndex = 0;
  queued = 0;

  constructor() {
    super();
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
    for (let i = 0; i < output.length; i++) {
      if (this.queued > 0) {
        output[i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % RING_SIZE;
        this.queued--;
      } else {
        output[i] = 0;
        underrun = true;
      }
    }
    if (underrun) {
      this.port.postMessage({ type: "underrun" });
    }
    return true;
  }

  enqueue(samples) {
    const isInt16 = samples instanceof Int16Array;
    for (let i = 0; i < samples.length; i++) {
      // Int16 → Float32 scale; Float32Array passes through as-is.
      const value = isInt16 ? samples[i] / 32768 : samples[i];
      if (this.queued >= RING_SIZE) {
        return; // ring full — drop the remainder rather than lag the timeline
      }
      this.buffer[this.writeIndex] = value;
      this.writeIndex = (this.writeIndex + 1) % RING_SIZE;
      this.queued++;
    }
  }

  resetRing() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.queued = 0;
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  registerProcessor("pcm-playback", PcmWorkletProcessor);
}
