/**
 * tts-model-family — DashScope 合成模型的协议族判定。
 *
 * voices.yaml 的 `providers.dashscope.model` 是自由字符串，但两个模型族
 * 走完全不同的 HTTP 协议（端点、请求体、音频封装都不同）：
 *
 *  - `qwen3-tts*`（qwen3-tts-flash / -instruct-flash / -vc- / -vd-）：
 *    multimodal-generation 端点，参数只有 text/voice(/language_type)，
 *    SSE 返回 base64 分片的 WAV 流（RIFF 头 + 24kHz s16le mono PCM）。
 *  - 其余（cosyvoice*、qwen-audio*）：SpeechSynthesizer 端点，参数在
 *    input 下（rate/pitch/volume/seed/instruction），SSE 返回裸 PCM 分片。
 *
 * 模型族同时决定有效采样率：qwen3-tts 固定 24000；cosyvoice 由
 * `synthesis.sample_rate` 配置（支持 24000，因此混布时统一 24k 即可）。
 */

/** qwen3-tts 系非实时音频的实际采样率（实测 multimodal-generation SSE，RIFF fmt 字段）。 */
export const QWEN3_TTS_SAMPLE_RATE = 24000;

/** DashScope 合成模型协议族。 */
export type TtsModelFamily = "qwen3-tts" | "cosyvoice";

/**
 * 判定模型族：`qwen3-tts` 前缀（含 -instruct/-vc/-vd 及带日期的快照名）
 * 走 qwen3 协议，其余（cosyvoice*、qwen-audio*）走 CosyVoice
 * SpeechSynthesizer 协议——与官方端点支持模型列表一致。
 * `local-qwen3-tts`（本地 tts-server 推理服务）同样固定 24 kHz PCM 输出。
 */
export function ttsModelFamilyOf(model: string): TtsModelFamily {
  return model.startsWith("qwen3-tts") || model.startsWith("local-qwen3-tts")
    ? "qwen3-tts"
    : "cosyvoice";
}

/**
 * qwen3-tts-instruct 系才支持逐请求自然语言指令（`input.instructions`，
 * ≤1600 Token，仅中英文）。其他 qwen3 模型收到指令会被服务端拒绝，
 * 必须在 provider 层丢弃。
 */
export function isQwen3TtsInstructModel(model: string): boolean {
  return model.startsWith("qwen3-tts-instruct");
}
