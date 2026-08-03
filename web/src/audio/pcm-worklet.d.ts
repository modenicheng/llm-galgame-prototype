/**
 * Type declarations for the plain-JS AudioWorklet module.
 *
 * The worklet runs as a browser AudioWorklet module, so it must ship as
 * plain JavaScript (Vite drops `.ts?url` assets and inlines `.js?url` as
 * an unusable data: URL — this file is loaded via `?raw` + blob URL
 * instead). These declarations restore typing for Node/vitest imports
 * (`./pcm-worklet.js`) without turning the shipped file back into TS.
 *
 * `AudioWorkletProcessor` is ambient (worklet-env.d.ts).
 */

export declare class PcmWorkletProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): readonly unknown[];
  chunks: Array<ArrayBufferView>;
  headChunk: number;
  headOffset: number;
  queued: number;
  phase: number;
  sourceRate: number;
  outputRate: number;
  constructor(options?: AudioWorkletNodeOptions);
  handlePortMessage(event: MessageEvent): void;
  process(
    inputs?: Float32Array[][],
    outputs?: Float32Array[][],
    parameters?: Record<string, Float32Array>,
  ): boolean;
  enqueue(samples: ArrayBufferView): void;
  sampleAt(offset: number): number;
  consume(count: number): void;
  resetRing(): void;
}
