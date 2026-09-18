/**
 * VoiceDirectionHub — 导演声音指导桥（角色音频特征设计 §4.2）。
 *
 * audio 栈按 runtime 生命周期构建，导演按会话构建：hub 让 factory 在行级
 * 编译时查询「当前会话 · 当前场景」对该说话人的 VoiceDirectionTarget。
 * bootstrap 建会话（含 restart 重建）后 setSource 重绑；未绑定 = 无指导，
 * 编译结果与无指导路径逐字节一致。
 */
import type { VoiceDirectionTarget } from "./performance-compiler.js";

export class VoiceDirectionHub {
  private source:
    | ((speakerId: string) => VoiceDirectionTarget | undefined)
    | undefined;

  setSource(
    source: ((speakerId: string) => VoiceDirectionTarget | undefined) | undefined,
  ): void {
    this.source = source;
  }

  for(speakerId: string): VoiceDirectionTarget | undefined {
    return this.source?.(speakerId);
  }
}
