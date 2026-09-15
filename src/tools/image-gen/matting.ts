/**
 * matting — AI 抠图引擎（ISNet medium 模型，onnxruntime-node 直载推理）。
 *
 * 推理管线与 @imgly/background-removal-node 完全一致（保证输出逐像素同质）：
 *   RGBA → 双线性缩放 1024×1024 → 逐通道 (p-128)/256 归一化 → input [1,3,1024,1024]
 *   → "output" [1,1,1024,1024] → ×255 → 双线性回缩原尺寸 → 写入 alpha。
 *
 * 执行设备（device）：
 *   - "cpu"（默认）：CPU EP，无额外初始化开销，约 2s/张（1024×1536 实测）；
 *   - "dml"：DirectML（Windows GPU），推理约 7× 提速（实测 RTX 5060：
 *     1862ms → 268ms），但会话初始化约 14s —— 适合一个进程连抠多张的
 *     批处理脚本；单张生成建议 CPU。DML 初始化失败自动改用 CPU 会话。
 *
 * 模型来源：@imgly/background-removal-node 包内自带的 ISNet 分块资源，运行时
 * 仅读取其数据文件（模型 MIT 许可），不引用其 AGPL 代码；onnxruntime 为 MIT。
 * 可用 modelPath 指向独立 .onnx 文件替代。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { InferenceSession } from "onnxruntime-node";

export type MattingDevice = "cpu" | "dml";

export type AiMattingFn = (bytes: Uint8Array, options: AiMattingOptions) => Promise<Uint8Array>;

export interface AiMattingOptions {
  /** 执行设备：cpu（默认）或 dml。 */
  device?: MattingDevice;
  /** 独立 .onnx 模型文件路径；缺省从 imgly 包资源拼装（结果缓存）。 */
  modelPath?: string;
  /** 注入实现，测试用。 */
  impl?: AiMattingFn;
}

/** 模型输入分辨率（ISNet 固定 1024×1024）。 */
const INPUT_SIZE = 1024;

/**
 * 双线性缩放。与 imgly 的 tensorResizeBilinear 逐像素同算法
 * （floor/ceil 邻点 + 线性插值 + round），保证与原实现输出一致。
 */
export function bilinearResize(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  newWidth: number,
  newHeight: number,
): Uint8Array {
  const out = new Uint8Array(newWidth * newHeight * channels);
  const scaleX = width / newWidth;
  const scaleY = height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const fx = x * scaleX;
      const fy = y * scaleY;
      const x1 = Math.max(Math.floor(fx), 0);
      const x2 = Math.min(Math.ceil(fx), width - 1);
      const y1 = Math.max(Math.floor(fy), 0);
      const y2 = Math.min(Math.ceil(fy), height - 1);
      const dx = fx - x1;
      const dy = fy - y1;
      for (let c = 0; c < channels; c++) {
        const p1 = data[(y1 * width + x1) * channels + c]!;
        const p2 = data[(y1 * width + x2) * channels + c]!;
        const p3 = data[(y2 * width + x1) * channels + c]!;
        const p4 = data[(y2 * width + x2) * channels + c]!;
        out[(y * newWidth + x) * channels + c] = Math.round(
          (1 - dx) * (1 - dy) * p1 + dx * (1 - dy) * p2 + (1 - dx) * dy * p3 + dx * dy * p4,
        );
      }
    }
  }
  return out;
}

/** RGBA（HWC）→ [1,3,size,size] float32，逐通道 (p-128)/256（imgly 同款归一化）。 */
export function toModelInput(rgba1024: Uint8Array): Float32Array {
  const stride = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * stride);
  for (let i = 0, j = 0; i < rgba1024.length; i += 4, j += 1) {
    float32[j] = (rgba1024[i]! - 128) / 256;
    float32[j + stride] = (rgba1024[i + 1]! - 128) / 256;
    float32[j + stride + stride] = (rgba1024[i + 2]! - 128) / 256;
  }
  return float32;
}

let cachedModelBytes: Buffer | undefined;

/** 读取模型字节：显式 modelPath 或从 imgly 包的分块资源拼装（结果缓存）。 */
function loadModelBytes(modelPath?: string): Buffer {
  if (modelPath !== undefined) return readFileSync(modelPath);
  if (cachedModelBytes === undefined) {
    const distDir = path.dirname(fileURLToPath(import.meta.resolve("@imgly/background-removal-node")));
    const resources = JSON.parse(readFileSync(path.join(distDir, "resources.json"), "utf8")) as {
      "/models/medium": { chunks: Array<{ hash: string }> };
    };
    // offsets 描述分块在目标文件中的位置；分块文件本身即完整数据，按序整读拼接。
    const chunks = resources["/models/medium"].chunks;
    cachedModelBytes = Buffer.concat(chunks.map((chunk) => readFileSync(path.join(distDir, chunk.hash))));
  }
  return cachedModelBytes;
}

const sessionCache = new Map<string, Promise<InferenceSession>>();

async function getSession(device: MattingDevice, modelPath?: string): Promise<InferenceSession> {
  const key = `${device}:${modelPath ?? ""}`;
  const cached = sessionCache.get(key);
  if (cached !== undefined) return cached;
  const created = (async () => {
    // 懒加载原生推理库，避免不使用 AI 引擎时的加载开销
    const { InferenceSession } = await import("onnxruntime-node");
    const model = loadModelBytes(modelPath);
    if (device === "dml") {
      try {
        return await InferenceSession.create(model, {
          graphOptimizationLevel: "all",
          executionProviders: ["dml", "cpu"],
        });
      } catch {
        // DirectML 不可用（驱动/非 Windows）→ 改用 CPU 会话
      }
    }
    return InferenceSession.create(model, { graphOptimizationLevel: "all" });
  })();
  sessionCache.set(key, created);
  return created;
}

const defaultImpl: AiMattingFn = async (bytes, options) => {
  const png = PNG.sync.read(Buffer.from(bytes));
  const { width, height, data } = png;
  const small = bilinearResize(data, width, height, 4, INPUT_SIZE, INPUT_SIZE);
  const input = toModelInput(small);
  const session = await getSession(options.device ?? "cpu", options.modelPath);
  const { Tensor } = await import("onnxruntime-node");
  const results = await session.run(
    { input: new Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]) },
    { output: "output" },
  );
  const maskF32 = results["output"]!.data as Float32Array;
  // ISNet 输出经 sigmoid 落在 0~1，×255 后写 Uint8 自动截断
  const mask1024 = new Uint8Array(maskF32.length);
  for (let i = 0; i < maskF32.length; i++) mask1024[i] = maskF32[i]! * 255;
  const mask = bilinearResize(mask1024, INPUT_SIZE, INPUT_SIZE, 1, width, height);
  for (let i = 0; i < width * height; i++) png.data[4 * i + 3] = mask[i]!;
  return new Uint8Array(PNG.sync.write(png));
};

/**
 * AI 抠图：输入 PNG bytes，输出带羽化 alpha 的 PNG bytes（发丝软边）。
 * 失败时抛错（由调用方决定是否回退到几何抠图）。
 */
export async function aiMatting(bytes: Uint8Array, options: AiMattingOptions = {}): Promise<Uint8Array> {
  const impl = options.impl ?? defaultImpl;
  return impl(bytes, options);
}
