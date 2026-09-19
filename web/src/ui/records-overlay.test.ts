/**
 * RecordsOverlay tests — the start-screen 「过往记录」 panel. Covers the
 * /api/saves narrowing (ended-only, defaults for legacy saves), rendering,
 * and the loading/empty/failure states. DOM via happy-dom.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RecordsOverlay,
  asPlayerRecord,
  formatRecordDate,
  type PlayerRecord,
} from "./records-overlay.js";

function endedSave(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "2026-09-19T19-40-43-029Z",
    phase: "ended",
    lastPlayedAt: "2026-09-19T19:52:00.000Z",
    turnCount: 7,
    endingId: "end_13",
    endingGrade: "HE",
    endingTitle: "三十一秒的招新稿",
    endingText: "故事到此结束。",
    ...overrides,
  };
}

function record(overrides: Partial<PlayerRecord> = {}): PlayerRecord {
  return {
    sessionId: "2026-09-19T19-40-43-029Z",
    endedAt: "2026-09-19T19:52:00.000Z",
    grade: "HE",
    title: "三十一秒的招新稿",
    text: "故事到此结束。",
    turnCount: 7,
    ...overrides,
  };
}

function fetchResponding(payload: unknown, ok = true): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })),
  );
}

describe("asPlayerRecord", () => {
  it("narrows an ended save and keeps the ending fields", () => {
    expect(asPlayerRecord(endedSave())).toEqual(record());
  });

  it("skips active saves and malformed rows", () => {
    expect(asPlayerRecord(endedSave({ phase: "active" }))).toBeNull();
    expect(asPlayerRecord({ sessionId: "x" })).toBeNull();
    expect(asPlayerRecord("nope")).toBeNull();
  });

  it("falls back to NE/剧终 for legacy saves without ending metadata", () => {
    const legacy = asPlayerRecord({
      sessionId: "legacy",
      phase: "ended",
      endingId: "end_old",
    });
    expect(legacy).toEqual({
      sessionId: "legacy",
      endedAt: null,
      grade: "NE",
      title: "剧终",
      text: "",
      turnCount: 0,
    });
  });

  it("rejects grades outside the TE/HE/NE/BE set", () => {
    expect(asPlayerRecord(endedSave({ endingGrade: "SS" }))?.grade).toBe("NE");
  });
});

describe("formatRecordDate", () => {
  it("formats ISO timestamps as local YYYY-MM-DD HH:mm", () => {
    const date = new Date(Date.UTC(2026, 8, 19, 19, 52));
    expect(formatRecordDate(date.toISOString())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("passes through values it cannot parse", () => {
    expect(formatRecordDate("not-a-date")).toBe("not-a-date");
  });
});

describe("RecordsOverlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function build(fetchImpl?: typeof fetch): { root: HTMLElement; overlay: RecordsOverlay } {
    const root = document.createElement("section");
    document.body.append(root);
    const overlay = new RecordsOverlay(root, { onClose: vi.fn() }, fetchImpl);
    return { root, overlay };
  }

  it("renders one row per ended save with grade, title, turns and date", async () => {
    const fetchImpl = fetchResponding({
      saves: [
        endedSave(),
        endedSave({
          sessionId: "second",
          endingGrade: "BE",
          endingTitle: "未被带走的纸",
          endingText: "",
          turnCount: 0,
          lastPlayedAt: undefined,
          createdAt: "2026-09-18T10:00:00.000Z",
        }),
        { sessionId: "still-running", phase: "active" },
      ],
    });
    const { root, overlay } = build(fetchImpl as unknown as typeof fetch);
    overlay.open();
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".records__item")).toHaveLength(2);
    });
    const rows = [...root.querySelectorAll<HTMLElement>(".records__item")];
    expect(rows[0]!.querySelector(".records__grade--he")?.textContent).toBe("HE");
    expect(rows[0]!.querySelector(".records__ending")?.textContent).toBe("三十一秒的招新稿");
    expect(rows[0]!.querySelector(".records__turns")?.textContent).toBe("第 7 回");
    expect(root.querySelector(".records__count")?.textContent).toBe("2 段结局");
    // BE 行：无全文时不出摘录节点；无 lastPlayedAt 回退 createdAt。
    expect(rows[1]!.querySelector(".records__grade--be")).not.toBeNull();
    expect(rows[1]!.querySelector(".records__text")).toBeNull();
    expect(rows[1]!.querySelector(".records__date")?.textContent).not.toBe("");
    // 加载态提示收起。
    expect((root.querySelector(".records__status") as HTMLElement).hidden).toBe(true);
  });

  it("shows a friendly empty state when no save has ended", async () => {
    const { root, overlay } = build(fetchResponding({ saves: [] }) as unknown as typeof fetch);
    overlay.open();
    await vi.waitFor(() => {
      const status = root.querySelector(".records__status") as HTMLElement;
      expect(status.hidden).toBe(false);
      expect(status.textContent).toContain("还没有完结");
    });
    expect(root.querySelectorAll(".records__item")).toHaveLength(0);
  });

  it("surfaces fetch failures without throwing", async () => {
    const { root, overlay } = build(fetchResponding({}, false) as unknown as typeof fetch);
    overlay.open();
    await vi.waitFor(() => {
      expect((root.querySelector(".records__status") as HTMLElement).textContent).toContain(
        "读取失败",
      );
    });
  });

  it("close hides the panel; a response landing after close is not rendered", async () => {
    let resolveFetch: ((value: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { root, overlay } = build(fetchImpl as unknown as typeof fetch);
    overlay.open();
    overlay.close();
    expect(root.hidden).toBe(true);
    resolveFetch!(new Response(JSON.stringify({ saves: [endedSave()] }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelectorAll(".records__item")).toHaveLength(0);
  });
});
