/**
 * AudioDspStore — audio-dsp.yaml 的加载与保存（程序所有的 sidecar 配置）。
 *
 * 与 config.yaml 的纪律不同：本文件由程序写回（/monitor 音频面板保存，
 * POST /api/config/audio-dsp），首次保存前可以不存在（用内置默认值）。
 * 允许手改，但字段级坏值在下一次保存时会被规范化重写；解析失败不 brick
 * 启动——fail-open 回默认参数并告警（config.yaml 仍保持 fail-fast 不变）。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import {
  defaultAudioDspParams,
  parseAudioDspParams,
  type AudioDspParams,
} from "../shared/wire/audio-dsp.js";

export interface AudioDspLogger {
  info(line: string): void;
  warn(line: string): void;
}

/** 从 sidecar 加载；缺文件 → 默认值（info）；坏文件 → 默认值 + warn。 */
export async function loadAudioDspConfig(
  path: string,
  log: AudioDspLogger,
): Promise<AudioDspParams> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    log.info(`audio-dsp: ${path} 不存在，使用内置默认参数（首次保存时自动创建）`);
    return defaultAudioDspParams();
  }
  try {
    const parsed: unknown = yamlParse(raw);
    const params = parseAudioDspParams(parsed);
    if (params === null) throw new Error("顶层不是对象");
    return params;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`audio-dsp: ${path} 解析失败，回退默认参数（${message}）`);
    return defaultAudioDspParams();
  }
}

export class AudioDspStore {
  private params: AudioDspParams;

  constructor(
    private readonly path: string,
    params: AudioDspParams,
    private readonly log: AudioDspLogger,
  ) {
    this.params = params;
  }

  get(): AudioDspParams {
    return this.params;
  }

  /**
   * 校验后原子写回（tmp + rename）。写失败抛给调用方（路由回 500），
   * 内存态不动；写成功才替换内存态。
   */
  async save(next: AudioDspParams): Promise<void> {
    const validated = parseAudioDspParams(next);
    if (validated === null) {
      throw new Error("invalid audio dsp params");
    }
    const body = yamlStringify(validated);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, this.path);
    this.params = validated;
    this.log.info(`audio-dsp: 已保存 → ${this.path}`);
  }
}
