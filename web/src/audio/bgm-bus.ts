/**
 * BgmBus — 把 BGM `<audio>` 元素接入 Web Audio 图（可选增强）。
 *
 * 拓扑：MediaElementSource → dynamics(立体声, 可为 null) → fadeGain →
 * duckGain → destination。
 * - dynamics 复用语音链已注册的 "dynamics" 处理器：同一 AudioContext 上
 *   处理器名只能注册一次，因此本总线必须在 AudioCoordinator.init 之后
 *   用 `new AudioWorkletNode` 创建（不能再 addModule）；
 * - fadeGain 由 BgmController 的 VolumeRamp 驱动——淡入淡出的乘法落点从
 *   audio.volume 迁移为独立 GainNode（时间分辨率仍为帧级）；
 * - duckGain 由 BgmDucker 驱动（语音闪避），与淡入淡出分节点互不打架。
 *
 * `audio.volume`（元素属性）保留用户音量/静音语义：它作用在源节点之前的
 * 元素级，与图内增益相乘。任一步失败返回 null：调用方保持旧的
 * audio.volume 直连路径（= 本模块引入前的行为）。
 */
import type { DynamicsChainParams } from "@shared/wire/audio-dsp.js";

export interface BgmBus {
  readonly fadeGain: GainNode;
  readonly duckGain: GainNode;
  readonly dynamicsNode: AudioWorkletNode | null;
  setDynamicsParams(params: DynamicsChainParams): void;
}

export function createBgmBus(
  context: AudioContext,
  element: HTMLMediaElement,
  params: DynamicsChainParams | null,
): BgmBus | null {
  try {
    const source = context.createMediaElementSource(element);
    let dynamics: AudioWorkletNode | null = null;
    try {
      dynamics = new AudioWorkletNode(context, "dynamics", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
    } catch {
      dynamics = null; // 处理器未注册（语音侧降级）——BGM 跳过动态处理
    }
    const fadeGain = context.createGain();
    const duckGain = context.createGain();
    if (dynamics !== null) {
      // BGM 链不消费遥测，但 MessagePort 队列在未启用派发时会无限堆积
      // 处理器每 ~21ms 的 postMessage——挂一个丢弃型接收方显式排空。
      dynamics.port.onmessage = () => {};
      source.connect(dynamics);
      dynamics.connect(fadeGain);
      if (params !== null) {
        dynamics.port.postMessage({ type: "params", params });
      }
    } else {
      source.connect(fadeGain);
    }
    fadeGain.connect(duckGain);
    duckGain.connect(context.destination);
    return {
      fadeGain,
      duckGain,
      dynamicsNode: dynamics,
      setDynamicsParams(p: DynamicsChainParams): void {
        dynamics?.port.postMessage({ type: "params", params: p });
      },
    };
  } catch (error) {
    console.warn("[audio] BGM graph attach failed — element stays direct", error);
    return null;
  }
}
