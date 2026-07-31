import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  ModelEventSchema,
  StatePatchLineSchema,
  isStatePatchLine,
  type ModelEvent,
  type ModelPlayableEvent,
  type StoredEvent
} from "./schema.js";
import type { StoryStatePatch } from "./story/types.js";

export function removeMarkdownFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:jsonl|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/** Result of parsing a JSONL document: playable events plus state patches. */
export interface ParsedJsonl {
  events: ModelEvent[];
  /** In-band state updates, in emission order. */
  patches: StoryStatePatch[];
}

function parseLines(text: string): ParsedJsonl {
  const normalized = removeMarkdownFence(text);
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("模型没有返回任何 JSONL 事件。");
  }

  const events: ModelEvent[] = [];
  const patches: StoryStatePatch[] = [];

  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`第 ${index + 1} 行不是合法 JSON：${String(error)}\n${line}`);
    }

    // In-band state update — validated here but never enters the event stream.
    if (isStatePatchLine(value)) {
      const parsed = StatePatchLineSchema.parse(value);
      patches.push(parsed.patch as StoryStatePatch);
      return;
    }

    events.push(ModelEventSchema.parse(value) as ModelEvent);
  });

  return { events, patches };
}

function isTerminalEvent(event: ModelEvent): boolean {
  return event.type === "choice" || event.type === "end" || event.type === "interaction";
}

export function parseTerminalModelJsonl(text: string): ParsedJsonl {
  const { events, patches } = parseLines(text);
  const terminalIndexes = events
    .map((event, index) => (isTerminalEvent(event) ? index : -1))
    .filter((index) => index >= 0);

  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
    throw new Error("完整剧情段必须且只能在最后一行出现一个 choice、interaction 或 end 事件。");
  }

  if (events.length < 2) {
    throw new Error("完整剧情段至少需要一条可播放文本和一个 choice/interaction/end 事件。");
  }

  return { events, patches };
}

export function parsePrefetchModelJsonl(
  text: string,
  minDialogueLines: number
): ModelPlayableEvent[] {
  const { events } = parseLines(text);

  for (const event of events) {
    if (isTerminalEvent(event)) {
      throw new Error(
        "分支预取片段只能包含 narration/dialogue，不得提前生成 choice、interaction 或 end。"
      );
    }
  }

  const playable = events as ModelPlayableEvent[];
  const dialogueCount = playable.filter((event) => event.type === "dialogue").length;
  if (dialogueCount < minDialogueLines) {
    throw new Error(
      `分支预取片段只包含 ${dialogueCount} 条 dialogue，至少需要 ${minDialogueLines} 条。`
    );
  }

  return playable;
}

export class JsonlSessionStore {
  readonly filePath: string;

  constructor(sessionsDir: string, sessionId: string) {
    this.filePath = path.resolve(sessionsDir, `${sessionId}.jsonl`);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async append(event: StoredEvent): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
