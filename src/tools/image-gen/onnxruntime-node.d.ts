/**
 * onnxruntime-node@1.17.x 的最小类型声明。
 * 该版本的 package.json `types` 字段指向不存在的 dist/index.d.ts（上游打包缺陷），
 * 且 @types/onnxruntime-node 未覆盖此版本；此处仅声明 image-gen 用到的 API 面。
 */

declare module "onnxruntime-node" {
  export declare class Tensor {
    constructor(type: "float32", data: Float32Array, dims: readonly number[]);
    readonly type: string;
    readonly data: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray;
    readonly dims: readonly number[];
  }

  export interface SessionOptions {
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
    executionMode?: "sequential" | "parallel";
    executionProviders?: readonly string[];
  }

  export declare class InferenceSession {
    static create(model: Uint8Array | string, options?: SessionOptions): Promise<InferenceSession>;
    run(
      feeds: Record<string, Tensor>,
      outputs?: Record<string, string>,
    ): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
  }
}
