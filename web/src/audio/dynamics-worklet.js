/**
 * DynamicsWorkletProcessor — 语音/BGM 共用的动态处理 AudioWorklet（gate →
 * compressor → limiter）。
 *
 * 纯 JavaScript（非 TS）：与 pcm-worklet.js 相同的约束——经 `?raw` + blob
 * URL 加载，blob 模块无法相对导入，必须自包含单文件。数学核心导出为纯类，
 * `registerProcessor` 条件守卫使同一文件可被 vitest 在 Node 里直接 import
 * 测曲线（类型见 dynamics-worklet.d.ts）。
 *
 * 链路共享一个电平检测（peak 包络，多声道 linked——取各声道绝对值最大
 * 者），同一路增益施加到所有声道。每隔 meterBlocks 个渲染量子向主线程
 * post 一次 {type:"state"}：输出电平 dB、gate 开合、压缩/限幅增益削减量，
 * 供 BgmDucker（闪避）与 /monitor 仪表消费。
 *
 * 参数经 port 消息 {type:"params", params} 热更，数值 normalize 时 clamp；
 * 增益状态（attack/release 平滑）跨参数更新延续，不产生爆音。
 */

const DB_FLOOR = -100;
const LINEAR_FLOOR = 10 ** (DB_FLOOR / 20);
/** 每 8 个 128 帧量子上报一次 ≈ 21ms @48k——对闪避（attack ≥150ms）与仪表都足够密。 */
const METER_BLOCKS = 8;
/** 限幅器固定快 attack（ms）：跟进瞬态压增益。 */
const LIMITER_ATTACK_MS = 0.5;
/** 电平检测包络的球面滚动：快攻慢放。 */
const ENVELOPE_ATTACK_MS = 1;
const ENVELOPE_RELEASE_MS = 60;

function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

export function dbToLinear(db) {
  return 10 ** (db / 20);
}

export function linearToDb(x) {
  return 20 * Math.log10(Math.max(Math.abs(x), LINEAR_FLOOR));
}

/** 一阶平滑系数：ms 内衰减到 1/e；ms<=0 → 立即跟随。 */
export function smoothingCoef(ms, sampleRate) {
  if (ms <= 0) return 0;
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

export class EnvelopeFollower {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    this.env = 0;
  }

  setBallistics(attackMs, releaseMs) {
    this.attackCoef = smoothingCoef(attackMs, this.sampleRate);
    this.releaseCoef = smoothingCoef(releaseMs, this.sampleRate);
  }

  process(x) {
    const abs = Math.abs(x);
    const coef = abs > this.env ? this.attackCoef : this.releaseCoef;
    this.env += (abs - this.env) * (1 - coef);
    return this.env;
  }

  get db() {
    return linearToDb(this.env);
  }
}

export class GateStage {
  constructor() {
    this.enabled = false;
    this.thresholdDb = -55;
    this.rangeDb = -70;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    this.holdSamples = 0;
    this.holdLeft = 0;
    this.open = false;
    this.gain = dbToLinear(this.rangeDb);
  }

  setParams(p, sampleRate) {
    this.enabled = p.enabled === true;
    this.thresholdDb = clamp(p.threshold_db, -80, 0);
    this.rangeDb = clamp(p.range_db, -80, 0);
    this.attackCoef = smoothingCoef(p.attack_ms, sampleRate);
    this.releaseCoef = smoothingCoef(p.release_ms, sampleRate);
    this.holdSamples = Math.max(0, Math.round((p.hold_ms / 1000) * sampleRate));
  }

  /** envDb：当前预包络 dB。返回线性增益。 */
  process(envDb) {
    if (!this.enabled) return 1;
    if (envDb > this.thresholdDb) {
      this.open = true;
      this.holdLeft = this.holdSamples;
    } else if (this.holdLeft > 0) {
      this.holdLeft -= 1;
    } else {
      this.open = false;
    }
    const target = this.open ? 1 : dbToLinear(this.rangeDb);
    const coef = this.open ? this.attackCoef : this.releaseCoef;
    this.gain += (target - this.gain) * (1 - coef);
    return this.gain;
  }
}

export class CompressorStage {
  constructor() {
    this.enabled = false;
    this.thresholdDb = -26;
    /** 每超阈 1dB 的增益削减量（正数，dB）：1 − 1/ratio。 */
    this.slope = 1 - 1 / 2.5;
    this.kneeDb = 6;
    this.makeupDb = 0;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    /** 当前平滑后的增益削减（≥0，dB）。 */
    this.grDb = 0;
  }

  setParams(p, sampleRate) {
    this.enabled = p.enabled === true;
    this.thresholdDb = clamp(p.threshold_db, -80, 0);
    this.slope = 1 - 1 / clamp(p.ratio, 1, 20);
    this.kneeDb = Math.max(0.5, clamp(p.knee_db, 0, 24));
    this.makeupDb = clamp(p.makeup_db, -24, 24);
    this.attackCoef = smoothingCoef(p.attack_ms, sampleRate);
    this.releaseCoef = smoothingCoef(p.release_ms, sampleRate);
  }

  /** 增益削减曲线（软膝）：gr = slope·over（硬区）或二次插值（膝内）。 */
  static curveGr(slope, kneeDb, over) {
    if (over <= -kneeDb) return 0;
    if (over >= kneeDb) return slope * over;
    return (slope * (over + kneeDb) ** 2) / (4 * kneeDb);
  }

  /** 返回线性增益（含 makeup）。 */
  process(envDb) {
    if (!this.enabled) return 1;
    const over = envDb - this.thresholdDb;
    const gr = CompressorStage.curveGr(this.slope, this.kneeDb, over);
    const coef = gr > this.grDb ? this.attackCoef : this.releaseCoef;
    this.grDb += (gr - this.grDb) * (1 - coef);
    return dbToLinear(this.makeupDb - this.grDb);
  }
}

export class LimiterStage {
  constructor() {
    this.enabled = false;
    this.ceilingDb = -1.5;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    this.grDb = 0;
  }

  setParams(p, sampleRate) {
    this.enabled = p.enabled === true;
    this.ceilingDb = clamp(p.ceiling_db, -80, 0);
    this.attackCoef = smoothingCoef(LIMITER_ATTACK_MS, sampleRate);
    this.releaseCoef = smoothingCoef(p.release_ms, sampleRate);
  }

  /** 返回线性增益。 */
  process(envDb) {
    if (!this.enabled) return 1;
    const gr = Math.max(0, envDb - this.ceilingDb);
    const coef = gr > this.grDb ? this.attackCoef : this.releaseCoef;
    this.grDb += (gr - this.grDb) * (1 - coef);
    return dbToLinear(-this.grDb);
  }
}

/** 参数兜底：与 src/shared/wire/audio-dsp.ts 的 voice 链默认值一致。 */
export function normalizeChain(raw) {
  const r = typeof raw === "object" && raw !== null ? raw : {};
  const g = typeof r.gate === "object" && r.gate !== null ? r.gate : {};
  const c = typeof r.compressor === "object" && r.compressor !== null ? r.compressor : {};
  const l = typeof r.limiter === "object" && r.limiter !== null ? r.limiter : {};
  return {
    enabled: r.enabled !== false,
    gate: {
      enabled: g.enabled !== false,
      threshold_db: clamp(g.threshold_db ?? -55, -80, 0),
      attack_ms: clamp(g.attack_ms ?? 5, 0, 5000),
      hold_ms: clamp(g.hold_ms ?? 150, 0, 5000),
      release_ms: clamp(g.release_ms ?? 250, 0, 5000),
      range_db: clamp(g.range_db ?? -70, -80, 0),
    },
    compressor: {
      enabled: c.enabled !== false,
      threshold_db: clamp(c.threshold_db ?? -26, -80, 0),
      ratio: clamp(c.ratio ?? 2.5, 1, 20),
      attack_ms: clamp(c.attack_ms ?? 8, 0, 5000),
      release_ms: clamp(c.release_ms ?? 150, 0, 5000),
      knee_db: clamp(c.knee_db ?? 6, 0, 24),
      makeup_db: clamp(c.makeup_db ?? 0, -24, 24),
    },
    limiter: {
      enabled: l.enabled !== false,
      ceiling_db: clamp(l.ceiling_db ?? -1.5, -80, 0),
      release_ms: clamp(l.release_ms ?? 80, 0, 5000),
    },
  };
}

export class DynamicsChain {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.enabled = true;
    this.gate = new GateStage();
    this.compressor = new CompressorStage();
    this.limiter = new LimiterStage();
    this.preEnvelope = new EnvelopeFollower(sampleRate);
    this.preEnvelope.setBallistics(ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);
    this.outEnvelope = new EnvelopeFollower(sampleRate);
    this.outEnvelope.setBallistics(ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);
  }

  setParams(raw, sampleRate) {
    const p = normalizeChain(raw);
    if (sampleRate > 0 && sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate;
      this.preEnvelope = new EnvelopeFollower(sampleRate);
      this.preEnvelope.setBallistics(ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);
      this.outEnvelope = new EnvelopeFollower(sampleRate);
      this.outEnvelope.setBallistics(ENVELOPE_ATTACK_MS, ENVELOPE_RELEASE_MS);
    }
    this.enabled = p.enabled;
    if (!p.enabled) {
      // 主开关关闭：处理旁路（g=1），残留状态清零避免仪表读数悬挂。
      this.gate.open = false;
      this.compressor.grDb = 0;
      this.limiter.grDb = 0;
    }
    this.gate.setParams(p.gate, sampleRate);
    this.compressor.setParams(p.compressor, sampleRate);
    this.limiter.setParams(p.limiter, sampleRate);
  }

  /**
   * 原地处理：input/output 为声道 Float32Array 数组。输入声道数可与输出
   * 不一致（如单声道入、立体声出，按首声道复制）。返回是否为活动处理
   * （供测试/调试，主线程不消费）。
   */
  processBlock(input, output) {
    const outChannels = output.length;
    if (outChannels === 0 || output[0].length === 0) return false;
    const inChannels = input.length;
    const frameCount = output[0].length;
    const active = this.enabled;
    const out = this.outEnvelope;
    for (let i = 0; i < frameCount; i++) {
      // linked 预包络：各声道绝对值取最大
      let peak = 0;
      for (let ch = 0; ch < inChannels; ch++) {
        const v = Math.abs(input[ch][i]);
        if (v > peak) peak = v;
      }
      let g = 1;
      if (active) {
        const envDb = linearToDb(this.preEnvelope.process(peak));
        g =
          this.gate.process(envDb) *
          this.compressor.process(envDb) *
          this.limiter.process(envDb);
      } else {
        this.preEnvelope.process(peak);
      }
      out.process(peak * g);
      for (let ch = 0; ch < outChannels; ch++) {
        const src = inChannels > 0 ? input[Math.min(ch, inChannels - 1)][i] : 0;
        output[ch][i] = src * g;
      }
    }
    return active;
  }

  /** 遥测快照（块末调用）。 */
  snapshot() {
    return {
      outDb: this.outEnvelope.db,
      gateOpen: this.enabled && this.gate.enabled && this.gate.open,
      compGrDb: this.enabled ? this.compressor.grDb : 0,
      limGrDb: this.enabled ? this.limiter.grDb : 0,
    };
  }
}

/** Base class: the real worklet base in scope, a minimal stand-in in Node. */
const AudioWorkletProcessorBase =
  typeof AudioWorkletProcessor !== "undefined"
    ? AudioWorkletProcessor
    : class AudioWorkletProcessorFallback {
        port = new MessageChannel().port1;
        sampleRate = 48000;
      };

export class DynamicsProcessor extends AudioWorkletProcessorBase {
  constructor(options = {}) {
    super(options);
    this.chain = new DynamicsChain(this.sampleRate);
    this.blockCounter = 0;
    this.port.onmessage = (event) => {
      this.handlePortMessage(event);
    };
  }

  /** Handle a message from the main thread (public for direct testing). */
  handlePortMessage(event) {
    const data = event.data;
    if (data !== null && typeof data === "object" && data.type === "params") {
      this.chain.setParams(data.params, this.sampleRate);
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }
    const input = inputs[0] ?? [];
    this.chain.processBlock(input, output);
    this.blockCounter += 1;
    if (this.blockCounter >= METER_BLOCKS) {
      this.blockCounter = 0;
      const s = this.chain.snapshot();
      this.port.postMessage({
        type: "state",
        outDb: s.outDb,
        gateOpen: s.gateOpen,
        compGrDb: s.compGrDb,
        limGrDb: s.limGrDb,
      });
    }
    return true;
  }
}

if (typeof AudioWorkletProcessor !== "undefined") {
  registerProcessor("dynamics", DynamicsProcessor);
}
