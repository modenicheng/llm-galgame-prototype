/**
 * Vite dev middleware (§6.2).
 *
 * Mounts Vite in middlewareMode so the local web host serves the browser
 * UI from a single port — no separate Vite dev server, no CORS, no proxy.
 * The wrapper serves the transformed `index.html` at `/` and falls through
 * to Vite's middleware stack for everything else (modules, assets, HMR).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "vite";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface ViteDevMiddleware {
  /** Connect-style middleware; call `next` to pass through. */
  middleware: (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => void;
  close(): Promise<void>;
}

export async function createViteDevMiddleware(): Promise<ViteDevMiddleware> {
  const vite = await createServer({
    configFile: path.join(PROJECT_ROOT, "vite.config.ts"),
    root: path.join(PROJECT_ROOT, "web"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  const indexHtmlPath = path.join(PROJECT_ROOT, "web", "index.html");

  return {
    middleware: (req, res, next) => {
      // WebSocket upgrades never reach the request middleware; guard anyway
      // so a stray upgrade can never be mistaken for a module request.
      if (req.headers.upgrade) {
        next();
        return;
      }
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname === "/" || pathname === "/index.html") {
        void (async () => {
          try {
            const raw = await readFile(indexHtmlPath, "utf8");
            const html = await vite.transformIndexHtml("/", raw);
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          } catch (error) {
            next(error);
          }
        })();
        return;
      }
      vite.middlewares(req, res, next);
    },
    close: async () => {
      await vite.close();
    },
  };
}
