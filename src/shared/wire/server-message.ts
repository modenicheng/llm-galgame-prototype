/**
 * ServerMessage — everything Node sends over the Runtime WebSocket.
 * Includes the projection snapshot for reconnect recovery, runtime
 * outputs, and audio descriptor lifecycle messages.
 */
import type { RuntimeOutput } from "../../core/runtime/runtime-output.js";
import type { AudioDescriptor } from "./audio-descriptor.js";
import type { UiProjection } from "./ui-projection.js";

export type ServerMessage =
  | {
      type: "projection.snapshot";
      projection: UiProjection;
    }
  | {
      type: "runtime.output";
      sequence: number;
      output: RuntimeOutput;
    }
  | {
      type: "audio.descriptor";
      descriptor: AudioDescriptor;
    }
  | {
      type: "audio.priority_changed";
      lineId: string;
      priority: AudioDescriptor["priority"];
    }
  | {
      type: "audio.invalidated";
      lineId: string;
      reason: "branch_discarded" | "preview_canceled" | "session_closed";
    }
  | {
      type: "audio.task_status";
      taskId: string;
      lineId: string;
      status: "started" | "finished" | "failed" | "canceled";
      error?: string;
      totalBytes?: number;
    };
