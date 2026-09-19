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
      type: "client.ready";
      capabilities: {
        audioWorklet: boolean;
        indexedDb: boolean;
      };
      /**
       * C7：客户端 wire 协议版本（见 shared/wire/schemas.ts 的
       * WIRE_PROTOCOL_VERSION）。旧客户端不携带——服务端会明确拒绝。
       */
      wireVersion?: number;
    };
