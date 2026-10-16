/**
 * SoundfontMusicRenderer — 符号谱 → 可无缝循环的 AudioBuffer（确定性）。
 *
 * 渲染链：gleitz 按乐器 JSON 包（/game-assets/audio/soundfonts/）→ 按需
 * 解码 → OfflineAudioContext 调度（最近采样 + ≤1 半音 playbackRate 微移、
 * 分乐器包络、程序生成混响 IR）→ 渲染 = 循环体 + 混响尾 → 尾部循环折叠
 * 回头部 → 峰值护栏 → 定长循环 buffer。
 *
 * 确定性契约：同谱（cacheKey）+ 同 MUSIC_RENDERER_VERSION = 逐样本同音频；
 * 任何影响输出的改动（采样映射/包络/混响/折叠/采样率）必须升
 * src/application/audio/music-cache-key.ts 的版本号使乐谱缓存失效。
 *
 * 纯函数（时值/折叠/WAV 编码/最近采样）单独导出供测试；WebAudio 图是薄胶水。
 */
import {
  scoreLoopBeats,
  type MusicInstrument,
  type MusicScore,
} from "@shared/music/score.js";

/** 渲染采样率：BGM 频宽上限 ~16kHz 足够，比 44.1k 省 ~28% 体积/内存。 */
export const MUSIC_RENDER_SAMPLE_RATE = 32000;
/** 混响 RT60（秒）；尾部折叠区长度 ≥ 此值即无缝。 */
export const MUSIC_REVERB_SECONDS = 2.2;
/** 混响湿度（wet 占比）。 */
const REVERB_WET = 0.35;
/** 调色板 → 采样包文件名（与 assets/audio/soundfonts/ 一致）。 */
const PACK_PATH: Record<MusicInstrument, string> = {
  piano: "piano",
  strings: "strings",
  pad: "pad",
  bass: "bass",
  bell: "bell",
  choir: "choir",
};
/** 乐器基线增益（调色板平衡：点缀类压低，根基类足量）。 */
const INSTRUMENT_GAIN: Record<MusicInstrument, number> = {
  piano: 1,
  strings: 0.9,
  pad: 0.7,
  bass: 1,
  bell: 0.6,
  choir: 0.8,
};
/** 持续类乐器（长音铺底）：慢起音、采样循环、长释放。 */
const SUSTAINED = new Set<MusicInstrument>(["strings", "pad", "choir"]);

export function loopSeconds(score: MusicScore): number {
  return (scoreLoopBeats(score) * 60) / score.bpm;
}
export function tailSamples(sampleRate: number): number {
  return Math.ceil(MUSIC_REVERB_SECONDS * sampleRate);
}
/** beat（四分音符）→ 秒。 */
export function beatSeconds(score: MusicScore, beat: number): number {
  return (beat * 60) / score.bpm;
}

/** 最近采样选择：包内离目标最近的 MIDI 键（微移 ≤ 半音组内）。 */
export function nearestSampleMidi(keys: readonly number[], target: number): number | undefined {
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const key of keys) {
    const distance = Math.abs(key - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}

/** 程序生成混响 IR：指数衰减 + 一阶低通 damping + 双声道去相关白噪。 */
function makeImpulseResponse(
  context: BaseAudioContext,
): AudioBuffer {
  const sr = context.sampleRate;
  const length = Math.floor(MUSIC_REVERB_SECONDS * sr);
  const ir = context.createBuffer(2, length, sr);
  const tau = MUSIC_REVERB_SECONDS / 6.91; // RT60 衰减时间常数
  let lowLeft = 0;
  let lowRight = 0;
  let peak = 0;
  const left = ir.getChannelData(0);
  const right = ir.getChannelData(1);
  for (let i = 0; i < length; i += 1) {
    const t = i / sr;
    const envelope = Math.exp(-t / tau);
    const attack = Math.min(1, t / 0.01); // 10ms 淡入防硬起始
    const damp = 1 - 0.7 * (t / MUSIC_REVERB_SECONDS); // 越晚越暗
    lowLeft += 0.5 * ((Math.random() * 2 - 1) * envelope * attack - lowLeft);
    lowRight += 0.5 * ((Math.random() * 2 - 1) * envelope * attack - lowRight);
    left[i] = lowLeft * damp;
    right[i] = lowRight * damp;
    peak = Math.max(peak, Math.abs(lowLeft * damp), Math.abs(lowRight * damp));
  }
  if (peak > 0) {
    for (let i = 0; i < length; i += 1) {
      left[i] = (left[i] ?? 0) / peak;
      right[i] = (right[i] ?? 0) / peak;
    }
  }
  return ir;
}

/** AudioBuffer → PCM16 WAV Blob（BgmController 的 <audio> 直接播 blob URL）。 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) data.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  data.setUint32(4, 36 + frames * channels * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * channels * 2, true);
  data.setUint16(32, channels * 2, true);
  data.setUint16(34, 16, true);
  writeAscii(36, "data");
  data.setUint32(40, frames * channels * 2, true);
  const planes: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch += 1) planes.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, planes[ch]![i]!));
      data.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

/**
 * 采样库：按乐器懒加载 gleitz JSON 包并解码（会话内缓存）。
 * data-URI 每音符一条 → fetch(data:) → arrayBuffer → decodeAudioData。
 */
export class SoundfontStore {
  private readonly packs = new Map<MusicInstrument, Map<number, AudioBuffer>>();
  private decodeContext: OfflineAudioContext | undefined;

  constructor(
    private readonly baseUrl = "/game-assets/audio/soundfonts/",
    // 裸存全局 fetch 会脱离 window 接收者（Illegal invocation）——绑死。
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async samples(instrument: MusicInstrument): Promise<Map<number, AudioBuffer>> {
    const cached = this.packs.get(instrument);
    if (cached !== undefined) return cached;
    const response = await this.fetchImpl(`${this.baseUrl}${PACK_PATH[instrument]}.json`);
    if (!response.ok) throw new Error(`采样包 ${instrument} 加载失败：HTTP ${response.status}`);
    const dataUriMap = (await response.json()) as Record<string, string>;
    this.decodeContext ??= new OfflineAudioContext(1, 1, MUSIC_RENDER_SAMPLE_RATE);
    const decoded = new Map<number, AudioBuffer>();
    for (const [midi, dataUri] of Object.entries(dataUriMap)) {
      const audio = await this.fetchImpl(dataUri);
      const buffer = await this.decodeContext.decodeAudioData(await audio.arrayBuffer());
      decoded.set(Number(midi), buffer);
    }
    this.packs.set(instrument, decoded);
    return decoded;
  }
}

/** 渲染器接口（app 侧注入 seam；测试用 fake）。 */
export interface MusicRenderer {
  render(score: MusicScore): Promise<AudioBuffer>;
}

export class SoundfontMusicRenderer implements MusicRenderer {
  private readonly store: SoundfontStore;

  constructor(store: SoundfontStore = new SoundfontStore()) {
    this.store = store;
  }

  async render(score: MusicScore): Promise<AudioBuffer> {
    const sr = MUSIC_RENDER_SAMPLE_RATE;
    const loopN = Math.round(loopSeconds(score) * sr);
    const tailN = tailSamples(sr);
    const context = new OfflineAudioContext(2, loopN + tailN, sr);

    const dry = context.createGain();
    dry.gain.value = 1 - REVERB_WET * 0.5;
    dry.connect(context.destination);
    const convolver = context.createConvolver();
    convolver.buffer = makeImpulseResponse(context);
    const wet = context.createGain();
    wet.gain.value = REVERB_WET;
    convolver.connect(wet).connect(context.destination);

    for (const track of score.tracks) {
      const samples = await this.store.samples(track.instrument);
      const bus = context.createGain();
      bus.gain.value = INSTRUMENT_GAIN[track.instrument];
      bus.connect(dry);
      bus.connect(convolver);
      const sustained = SUSTAINED.has(track.instrument);
      for (const note of track.notes) {
        const sampleMidi = nearestSampleMidi([...samples.keys()], note.midi);
        if (sampleMidi === undefined) continue;
        const sampleBuffer = samples.get(sampleMidi);
        if (sampleBuffer === undefined) continue;
        const source = context.createBufferSource();
        source.buffer = sampleBuffer;
        // 最近采样微移 ≤1 半音（线性重采样，听感损失可忽略）。
        source.playbackRate.value = 2 ** ((note.midi - sampleMidi) / 12);
        const noteGain = context.createGain();
        const start = beatSeconds(score, note.beat);
        const duration = beatSeconds(score, note.dur);
        const peak = track.gain * (note.vel / 127);
        if (sustained) {
          source.loop = true;
          // 跳过采样的起音段再循环，避免循环点瞬态咔哒。
          if (sampleBuffer.duration > 0.4) {
            source.loopStart = 0.2;
            source.loopEnd = sampleBuffer.duration;
          }
          noteGain.gain.setValueAtTime(0, start);
          noteGain.gain.linearRampToValueAtTime(peak, start + 0.12);
          noteGain.gain.setValueAtTime(peak, Math.max(start, start + duration - 0.4));
          noteGain.gain.linearRampToValueAtTime(0, start + duration + 0.3);
        } else {
          noteGain.gain.setValueAtTime(0, start);
          noteGain.gain.linearRampToValueAtTime(peak, start + 0.004);
          // 打击类采样本体自带自然衰减：只给短释放截尾。
          noteGain.gain.setValueAtTime(peak, Math.max(start, start + duration));
          noteGain.gain.linearRampToValueAtTime(0, start + duration + 0.06);
        }
        source.connect(noteGain).connect(bus);
        source.start(start);
        source.stop(start + duration + (sustained ? 0.5 : 0.2));
      }
    }

    const rendered = await context.startRendering();
    return wrapLoopBuffer(foldTailIntoLoop(rendered, loopN), sr);
  }
}

/**
 * 循环折叠：渲染 = 循环体 + 尾（混响尾/越界音符尾巴）→ 尾叠回头部。
 * 纯函数（输出通道数组，不依赖 WebAudio 构造器）；峰值 >1 整体缩至 0.98。
 */
export function foldTailIntoLoop(
  rendered: Pick<AudioBuffer, "numberOfChannels" | "length" | "getChannelData">,
  loopN: number,
): Float32Array<ArrayBuffer>[] {
  const tailN = Math.min(rendered.length - loopN, loopN);
  const channels: Float32Array<ArrayBuffer>[] = [];
  let peak = 0;
  for (let ch = 0; ch < rendered.numberOfChannels; ch += 1) {
    const src = rendered.getChannelData(ch);
    const dst = new Float32Array(loopN);
    for (let i = 0; i < loopN; i += 1) dst[i] = src[i]!;
    for (let i = 0; i < tailN; i += 1) dst[i] = dst[i]! + src[loopN + i]!;
    for (let i = 0; i < loopN; i += 1) peak = Math.max(peak, Math.abs(dst[i]!));
    channels.push(dst);
  }
  if (peak > 1) {
    const scale = 0.98 / peak;
    for (const dst of channels) {
      for (let i = 0; i < loopN; i += 1) dst[i] = dst[i]! * scale;
    }
  }
  return channels;
}

/** 通道数组 → 定长循环 AudioBuffer（渲染器出口处一次性组装）。 */
function wrapLoopBuffer(channels: Float32Array<ArrayBuffer>[], sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate,
  });
  for (let ch = 0; ch < channels.length; ch += 1) buffer.copyToChannel(channels[ch]!, ch);
  return buffer;
}
