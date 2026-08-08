import { describe, it, expect } from "vitest";
import {
  parseTerminalModelJsonl,
  parsePrefetchModelJsonl
} from "./core/protocol/model-jsonl.js";

// ---------------------------------------------------------------------------
// parseTerminalModelJsonl
// ---------------------------------------------------------------------------

describe("parseTerminalModelJsonl", () => {
  const MAX_EVENTS = 12;

  // --- backward compat: legacy choice accepted only on session-read paths ---

  it("parses valid terminal JSONL with legacy choice event when allowLegacyChoice=true", () => {
    const text = [
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"dialogue","speaker":"小樱","text":"早上好！"}',
      '{"type":"choice","prompt":"如何回答？","options":[{"id":"greet","text":"早上好"},{"id":"ignore","text":"无视她"}]}'
    ].join("\n");

    const { events } = parseTerminalModelJsonl(text, { allowLegacyChoice: true });
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe("choice");
  });

  // --- gate: new model calls must not emit legacy choice ---

  it("rejects legacy choice terminal by default (new model calls)", () => {
    const text = [
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"dialogue","speaker":"小樱","text":"早上好！"}',
      '{"type":"choice","prompt":"如何回答？","options":[{"id":"greet","text":"早上好"},{"id":"ignore","text":"无视她"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      "模型不得再输出旧式 choice；请输出 type=interaction、mode=choice。"
    );
  });

  it("rejects legacy choice terminal when allowLegacyChoice=false explicitly", () => {
    const text = [
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"choice","prompt":"如何回答？","options":[{"id":"greet","text":"早上好"},{"id":"ignore","text":"无视她"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text, { allowLegacyChoice: false })).toThrow(
      "模型不得再输出旧式 choice；请输出 type=interaction、mode=choice。"
    );
  });

  // --- end event ---

  it("parses valid terminal JSONL with end event", () => {
    const text = [
      '{"type":"narration","text":"故事结束。"}',
      '{"type":"dialogue","speaker":"旁白","text":"再会。"}',
      '{"type":"end","ending_id":"ending_normal","text":"普通结局"}'
    ].join("\n");

    const { events } = parseTerminalModelJsonl(text);
    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe("end");
  });

  // --- interaction: choice mode ---

  it("parses valid terminal JSONL with interaction event (choice mode)", () => {
    const text = [
      '{"type":"narration","text":"门开了。"}',
      '{"type":"dialogue","speaker":"小明","text":"你来了。"}',
      '{"type":"interaction","interaction_id":"int_001","prompt":"如何回应？","mode":"choice","options":[{"id":"a","text":"回应"},{"id":"b","text":"离开"}]}'
    ].join("\n");

    const { events } = parseTerminalModelJsonl(text);
    expect(events).toHaveLength(3);
    const terminal = events[2]!;
    expect(terminal.type).toBe("interaction");
    if (terminal.type === "interaction" && terminal.mode === "choice") {
      expect(terminal.options).toHaveLength(2);
    }
  });

  // --- interaction: input mode ---

  it("parses valid terminal JSONL with interaction event (input mode)", () => {
    const text = [
      '{"type":"narration","text":"她看着你。"}',
      '{"type":"dialogue","speaker":"小樱","text":"你在想什么？"}',
      '{"type":"interaction","interaction_id":"int_002","prompt":"请写下你的回答：","mode":"input","input":{"kind":"free_text","placeholder":"输入你的想法...","max_length":200},"input_bridge":{"events":[{"type":"narration","text":"房间里安静下来。"}]}}'
    ].join("\n");

    const { events } = parseTerminalModelJsonl(text);
    expect(events).toHaveLength(3);
    const terminal = events[2]!;
    expect(terminal.type).toBe("interaction");
    if (terminal.type === "interaction" && terminal.mode === "input") {
      expect(terminal.input).toBeDefined();
      expect(terminal.input_bridge?.events).toHaveLength(1);
    }
  });

  // --- interaction: hybrid mode ---

  it("parses valid terminal JSONL with interaction event (hybrid mode)", () => {
    const text = [
      '{"type":"narration","text":"你需要做出决定。"}',
      '{"type":"interaction","interaction_id":"int_003","prompt":"怎么做？","mode":"hybrid","options":[{"id":"a","text":"开门"},{"id":"b","text":"等待"}],"input":{"kind":"free_text","placeholder":"或自己做决定...","max_length":100},"input_bridge":{"events":[{"type":"narration","text":"她等着你的决定。"},{"type":"narration","text":"烛火轻轻摇晃。"}]}}'
    ].join("\n");

    const { events } = parseTerminalModelJsonl(text);
    expect(events).toHaveLength(2);
    const terminal = events[1]!;
    expect(terminal.type).toBe("interaction");
    if (terminal.type === "interaction" && terminal.mode === "hybrid") {
      expect(terminal.options).toHaveLength(2);
      expect(terminal.input).toBeDefined();
    }
  });

  // --- reject: interaction in the middle ---

  it("rejects JSONL with interaction in the middle", () => {
    const text = [
      '{"type":"narration","text":"第一段。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"choice","options":[{"id":"x","text":"选"},{"id":"y","text":"等"}]}',
      '{"type":"dialogue","speaker":"A","text":"第二段。"}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      /必须且只能/
    );
  });

  // --- reject: interaction AND choice both present ---

  it("rejects JSONL with both interaction and choice events", () => {
    const text = [
      '{"type":"narration","text":"事件一。"}',
      '{"type":"choice","prompt":"选","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"choice","options":[{"id":"x","text":"X"},{"id":"y","text":"Y"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      /必须且只能/
    );
  });

  // --- reject: interaction with mode "choice" but no options ---

  it("rejects interaction with mode 'choice' but no options", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"choice"}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: interaction with mode "choice" but empty options ---

  it("rejects interaction with mode 'choice' but empty options array", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"choice","options":[]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: interaction with mode "hybrid" but no options ---

  it("rejects interaction with mode 'hybrid' but no options", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"hybrid","input":{"kind":"free_text","placeholder":"...","max_length":100}}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: interaction with mode "input" but no input spec ---

  it("rejects interaction with mode 'input' but no input spec", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"input"}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: interaction with mode "hybrid" but no input spec ---

  it("rejects interaction with mode 'hybrid' but no input spec", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"hybrid","options":[{"id":"a","text":"A"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: interaction with illegal mode ---

  it("rejects interaction with illegal mode", () => {
    const text = [
      '{"type":"narration","text":"事件。"}',
      '{"type":"interaction","interaction_id":"int_bad","prompt":"？","mode":"bogus","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow();
  });

  // --- reject: segment too short ---

  it("rejects segment without at least one playable event", () => {
    const text = [
      '{"type":"interaction","interaction_id":"int_001","prompt":"？","mode":"choice","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      /至少需要一条可播放文本/
    );
  });

  // --- reject: legacy choice gates BEFORE the playable-length check ---

  it("rejects a lone legacy choice with the legacy gate message, not the length message", () => {
    const text =
      '{"type":"choice","prompt":"如何回答？","options":[{"id":"a","text":"好"},{"id":"b","text":"不"}]}';

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      "模型不得再输出旧式 choice；请输出 type=interaction、mode=choice。",
    );
  });

  it("rejects [narration, legacy choice] with the legacy gate message", () => {
    const text = [
      '{"type":"narration","text":"天亮了。"}',
      '{"type":"choice","prompt":"如何回答？","options":[{"id":"a","text":"好"},{"id":"b","text":"不"}]}',
    ].join("\n");

    expect(() => parseTerminalModelJsonl(text)).toThrow(
      "模型不得再输出旧式 choice；请输出 type=interaction、mode=choice。",
    );
  });

  // --- reject: too many events ---

  it("accepts segment exceeding old max events limit", () => {
    const eventsList = Array.from({ length: 13 }, (_, i) =>
      i < 12
        ? `{"type":"narration","text":"${i}"}`
        : '{"type":"end","ending_id":"e","text":"end"}'
    );
    const text = eventsList.join("\n");
    // maxEvents is no longer enforced — truncation was removed
    const { events } = parseTerminalModelJsonl(text);
    expect(events).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// parsePrefetchModelJsonl
// ---------------------------------------------------------------------------

describe("parsePrefetchModelJsonl", () => {
  const MAX_EVENTS = 8;
  const MIN_DIALOGUE = 1; // use 1 for test convenience

  it("parses valid prefetch with narration and dialogue", () => {
    const text = [
      '{"type":"narration","text":"门开了。"}',
      '{"type":"dialogue","speaker":"小明","text":"欢迎。"}'
    ].join("\n");

    const events = parsePrefetchModelJsonl(text, MIN_DIALOGUE);
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.type === "dialogue")).toHaveLength(1);
  });

  // --- reject: prefetch with choice ---

  it("rejects prefetch containing choice event", () => {
    const text = [
      '{"type":"narration","text":"Narr"}',
      '{"type":"dialogue","speaker":"A","text":"Hi"}',
      '{"type":"choice","prompt":"？","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'
    ].join("\n");

    expect(() =>
      parsePrefetchModelJsonl(text, MIN_DIALOGUE)
    ).toThrow(/不得提前生成/);
  });

  // --- reject: prefetch with end ---

  it("rejects prefetch containing end event", () => {
    const text = [
      '{"type":"narration","text":"Narr"}',
      '{"type":"dialogue","speaker":"A","text":"Hi"}',
      '{"type":"end","ending_id":"e","text":"end"}'
    ].join("\n");

    expect(() =>
      parsePrefetchModelJsonl(text, MIN_DIALOGUE)
    ).toThrow(/不得提前生成/);
  });

  // --- reject: prefetch with interaction ---

  it("rejects prefetch containing interaction event", () => {
    const text = [
      '{"type":"narration","text":"Narr"}',
      '{"type":"dialogue","speaker":"A","text":"Hi"}',
      '{"type":"interaction","interaction_id":"int_001","prompt":"？","mode":"choice","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'
    ].join("\n");

    expect(() =>
      parsePrefetchModelJsonl(text, MIN_DIALOGUE)
    ).toThrow(/不得提前生成/);
  });

  // --- reject: prefetch without enough dialogue ---

  it("rejects prefetch without minimum dialogue lines", () => {
    const text = ['{"type":"narration","text":"Narr"}'].join("\n");

    expect(() =>
      parsePrefetchModelJsonl(text, 2)
    ).toThrow(/至少需要/);
  });
});
