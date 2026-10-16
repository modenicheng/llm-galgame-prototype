#!/usr/bin/env node
/**
 * serve-music-demo — 配乐试听页的零依赖静态服务。
 *
 * 服务 dist/web（vite build 产物，含 /music-demo.html）并把 /game-assets/
 * 映射到 assets/（镜像 local-web 宿主的资源映射——SoundfontStore 的
 * baseUrl 不变）。听感调参工作流：改渲染器/prompt → npm run build:web →
 * 本服务重开 → 浏览器 A/B 对比；全程零 token、不启游戏。
 *
 * 用法：npm run demo:music   （或 node scripts/serve-music-demo.mjs [port]）
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distWeb = path.join(repoRoot, "dist", "web");
const assetsRoot = path.join(repoRoot, "assets");
const port = Number(process.argv[2] ?? process.env.MUSIC_DEMO_PORT ?? 4319);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
};

if (!existsSync(path.join(distWeb, "music-demo.html"))) {
  console.error("dist/web 缺 music-demo.html —— 先跑 npm run build:web");
  process.exit(1);
}

/** 解析 base 内的相对路径；越界（../、绝对路径）= null。 */
function resolveUnder(base, relative) {
  const target = path.resolve(base, `.${path.sep}${relative}`);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function serveFile(res, filePath) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  if (!stats.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": stats.size,
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  if (pathname.startsWith("/game-assets/")) {
    const target = resolveUnder(assetsRoot, pathname.slice("/game-assets/".length));
    if (target === null) {
      res.writeHead(403).end();
      return;
    }
    serveFile(res, target);
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = resolveUnder(distWeb, relative);
  if (target === null) {
    res.writeHead(403).end();
    return;
  }
  serveFile(res, target);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`配乐试听页：http://127.0.0.1:${port}/music-demo.html`);
  console.log("（采样包首载约数秒；Ctrl+C 退出）");
});
