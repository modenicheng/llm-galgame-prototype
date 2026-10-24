/**
 * tts-model-family — 合成模型族判定（campus 同名模块移植，按 main 的
 * 双 provider 现实裁剪）。
 *
 * voices.yaml 的 `providers.*.model` 是自由字符串，但 qwen3-tts 族与
 * cosyvoice 族对输入文本的标点处理不同：qwen3-tts 无任何内联节奏标签、
 * 训练词表外标点被静默吞掉（行尾破折号只余 ~0.1s 衰减、句中 ~0.2s 弱于
 * 逗号；campus probe_punct 探针 2026-09-19 实测 qwentts.cpp 钉种子）——
 * 因此标点兼容适配（qwen3-text-compat）只对该族启用。
 *
 * 模型族同时决定有效采样率：qwen3-tts 固定 24000；cosyvoice 由
 * `synthesis.sample_rate` 配置（main 启动校验强制 24k，混布无需分流）。
 */

/** qwen3-tts 系非实时音频的实际采样率（实测 multimodal-generation SSE，RIFF fmt 字段）。 */
export const QWEN3_TTS_SAMPLE_RATE = 24000;

/** 合成模型族。 */
export type TtsModelFamily = "qwen3-tts" | "cosyvoice";

/**
 * 判定模型族：`qwen3-tts` 前缀（含 -instruct/-vc/-vd 及带日期的快照名）
 * 与 `local-qwen3-tts`（本地 tts-server 推理服务，同样固定 24 kHz PCM
 * 输出）走 qwen3 协议，其余（cosyvoice*、qwen-audio*）按 cosyvoice 对待。
 */
export function ttsModelFamilyOf(model: string): TtsModelFamily {
  return model.startsWith("qwen3-tts") || model.startsWith("local-qwen3-tts")
    ? "qwen3-tts"
    : "cosyvoice";
}
