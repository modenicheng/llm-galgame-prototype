/**
 * ClientMessage — everything the browser sends over the Runtime
 * WebSocket. JSON only; PCM never travels on this channel.
 */
import type { RuntimeCommand } from "../../core/runtime/runtime-command.js";

/** The only TTS request payload the browser may submit. */
export interface AudioFetchRequest {
  taskId: string;
  lineId: string;
  cacheKey: string;
}

export type ClientMessage =
  | {
      type: "runtime.command";
      commandId: string;
      command: RuntimeCommand;
    }
  | {
      type: "audio.cache_report";
      lineId: string;
      cacheKey: string;
      result: "hit" | "miss" | "partial" | "corrupt";
    }
  | {
      type: "audio.buffer_report";
      bufferedAheadMs: number;
      underrunCount: number;
    }
  | {
      /** 玩家端音频链遥测（≤10Hz 聚合），供 /monitor 音频面板仪表。 */
      type: "audio.telemetry";
      outDb: number;
      gateOpen: boolean;
      compGrDb: number;
      limGrDb: number;
      duckDb: number;
    }
  | {
      type: "client.ready";
      capabilities: {
        audioWorklet: boolean;
        indexedDb: boolean;
      };
    };
