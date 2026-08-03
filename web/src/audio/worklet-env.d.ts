/**
 * Worklet-global ambient types + raw-module typing.
 *
 * TypeScript's DOM libraries define the main-thread `AudioWorkletNode` API,
 * but omit worklet-scope globals such as `AudioWorkletProcessor` and
 * `registerProcessor`. Keep only those missing declarations here.
 */


declare module "*.js?raw" {
  const source: string;
  export default source;
}

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  readonly currentTime: number;
  readonly sampleRate: number;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

interface AudioWorkletProcessorConstructor {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
}

declare var AudioWorkletProcessor: AudioWorkletProcessorConstructor;

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor) & {
    parameterDescriptors?: readonly unknown[];
  },
): void;

