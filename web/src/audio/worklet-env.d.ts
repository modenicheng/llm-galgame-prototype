/**
 * Worklet ambient types + `?url` module typing.
 *
 * 1. TypeScript 7.0.2 (native preview) ships lib.dom/lib.webworker WITHOUT
 *    AudioWorkletProcessor, registerProcessor, createAudioWorkletNode, and
 *    AudioParamDescriptor. The browser has all of these, so this file
 *    restores the missing ambient surface for the audio engine. DELETE the
 *    global declarations below once the TS libs catch up.
 *
 * 2. `import workletUrl from "./pcm-worklet.ts?url"` typing. Task-UI
 *    (Wave 2) owns web/vite-env.d.ts with the full
 *    `/// <reference types="vite/client" />` set (its `*?url` declaration
 *    covers this import too). Until that file lands, this local
 *    declaration keeps the import typechecking; multiple matching wildcard
 *    declarations coexist and the more specific pattern wins.
 */

declare module "*.ts?url" {
  const url: string;
  export default url;
}

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

interface BaseAudioContext {
  createAudioWorkletNode(name: string, options?: AudioWorkletNodeOptions): AudioWorkletNode;
}
