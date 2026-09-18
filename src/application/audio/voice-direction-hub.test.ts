/**
 * Tests for VoiceDirectionHub — 导演声音指导桥的绑定/查询语义。
 */
import { describe, expect, it } from "vitest";
import { VoiceDirectionHub } from "./voice-direction-hub.js";

describe("VoiceDirectionHub", () => {
  it("starts unbound, delegates to the bound source, and rebinds on setSource", () => {
    const hub = new VoiceDirectionHub();
    expect(hub.for("suyao")).toBeUndefined();
    hub.setSource((speaker) => (speaker === "suyao" ? { volume: "whisper" } : undefined));
    expect(hub.for("suyao")).toEqual({ volume: "whisper" });
    expect(hub.for("linche")).toBeUndefined();
    // restart 重建会话：新 source 顶替旧绑定。
    hub.setSource(() => ({ pace: "very_slow" }));
    expect(hub.for("linche")).toEqual({ pace: "very_slow" });
    hub.setSource(undefined);
    expect(hub.for("suyao")).toBeUndefined();
  });
});
