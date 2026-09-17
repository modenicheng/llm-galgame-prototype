/**
 * Vite dev middleware — the SPA's client-side routes (/monitor) must serve
 * the transformed index.html. Regression: with appType "custom" Vite has no
 * HTML fallback of its own, so /monitor used to fall through to the host's
 * 404 {"error":"not found"} in dev mode (prod serveFile has its own).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createViteDevMiddleware, type ViteDevMiddleware } from "./vite-middleware.js";

interface FakeResponse {
  headers: Record<string, string>;
  body: string | null;
  setHeader(key: string, value: string): void;
  end(body?: string): void;
}

function makeRes(): FakeResponse {
  return {
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body ?? "";
    },
  };
}

function makeReq(url: string): IncomingMessage {
  return { headers: {}, url } as unknown as IncomingMessage;
}

/** Wait for the async HTML transform to land on the fake response. */
async function waitForBody(res: FakeResponse): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (res.body === null) {
    if (Date.now() > deadline) throw new Error("middleware never responded");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("createViteDevMiddleware SPA routes", () => {
  let middleware: ViteDevMiddleware;

  beforeAll(async () => {
    middleware = await createViteDevMiddleware();
  }, 30_000);

  afterAll(async () => {
    await middleware.close();
  }, 30_000);

  it.each(["/monitor", "/monitor/", "/"])("serves the app shell for %s", async (url) => {
    const res = makeRes();
    let nextCalled = false;
    middleware.middleware(makeReq(url), res as unknown as ServerResponse, () => {
      nextCalled = true;
    });
    await waitForBody(res);
    expect(nextCalled).toBe(false);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("/@vite/client");
  });

  it("leaves Vite-internal URLs to the vite stack (no HTML response)", async () => {
    const res = makeRes();
    let nextCalled = false;
    middleware.middleware(makeReq("/@vite/client"), res as unknown as ServerResponse, () => {
      nextCalled = true;
    });
    // The vite stack is expected to take over (next was called into); we
    // only assert the wrapper did NOT short-circuit with the app shell.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(nextCalled).toBe(true);
    expect(res.body).toBeNull();
  });
});
