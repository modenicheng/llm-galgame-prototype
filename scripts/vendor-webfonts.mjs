#!/usr/bin/env node
/**
 * vendor-webfonts — 一次性把 Google Fonts 的 woff2 子集缓存到本地
 * web/public/fonts/，供 web UI 离线自托管（替换 index.html 里的 Google
 * Fonts <link>）。
 *
 * 保留 Google 的 unicode-range 子集结构：浏览器仍按需懒加载子集文件，
 * 只是从本机静态服务取（~ms 级，swap 窗口不可见；配合 dialogue-box 的
 * 字体就绪门控彻底消除逐字换装闪烁）。
 *
 * 用法：node scripts/vendor-webfonts.mjs
 * 重新运行会幂等覆盖 fonts.css 与 files/。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve(process.cwd(), "web", "public", "fonts");
const FILES_DIR = path.join(OUT_DIR, "files");

/** 与 styles.css 实际使用的字重对齐：正文 400 / 名牌与按钮 600 / 结局标题 700。 */
const CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Noto+Serif+SC:wght@400;600;700" +
  "&family=Ma+Shan+Zheng" +
  "&display=swap";

/** 现代 Chrome UA：css2 据此返回 woff2 + unicode-range 子集切分。 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** OFL 1.1 许可文本（Noto Serif SC / Ma Shan Zheng 均为 OFL 发布）。 */
const LICENSE_URLS = {
  "OFL-noto-serif-sc.txt":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/OFL.txt",
  "OFL-ma-shan-zheng.txt":
    "https://raw.githubusercontent.com/google/fonts/main/ofl/mashanzheng/OFL.txt",
};

const FONT_CONCURRENCY = 8;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  console.log("[vendor-webfonts] fetching css2 …");
  const css = await fetchText(CSS_URL);

  // 逐个 @font-face 块解析：记录 url 与其所在块，下载后改写为相对路径。
  const blocks = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  if (blocks.length === 0) throw new Error("css2 response contains no @font-face blocks");

  const jobs = [];
  const seen = new Set();
  const rewritten = [];
  for (const block of blocks) {
    const urlMatch = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (urlMatch === null) throw new Error(`no gstatic url in block: ${block.slice(0, 80)}…`);
    const name = urlMatch[1].split("/").pop();
    // css2 may emit duplicate @font-face blocks (same url/unicode-range);
    // one copy per unique file is enough.
    if (seen.has(name)) continue;
    seen.add(name);
    jobs.push({ url: urlMatch[1], name });
    rewritten.push(block.replace(urlMatch[0], `url(./files/${name})`));
  }

  await mkdir(FILES_DIR, { recursive: true });
  let bytes = 0;
  const failed = [];
  await mapLimit(jobs, FONT_CONCURRENCY, async (job) => {
    const res = await fetch(job.url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      failed.push(`${job.name}: HTTP ${res.status}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    bytes += buf.length;
    await writeFile(path.join(FILES_DIR, job.name), buf);
  });
  if (failed.length > 0) throw new Error(`failed downloads:\n${failed.join("\n")}`);

  await writeFile(
    path.join(OUT_DIR, "fonts.css"),
    [
      "/* Vendored from Google Fonts (see README.md). Regenerate: node scripts/vendor-webfonts.mjs */",
      ...rewritten,
      "",
    ].join("\n\n"),
  );

  for (const [name, url] of Object.entries(LICENSE_URLS)) {
    try {
      await writeFile(path.join(OUT_DIR, name), await fetchText(url));
    } catch (error) {
      console.warn(`[vendor-webfonts] license fetch failed for ${name}: ${error.message}`);
    }
  }

  await writeFile(
    path.join(OUT_DIR, "README.md"),
    [
      "# Vendored webfonts",
      "",
      "Source: Google Fonts (`fonts.googleapis.com/css2`), fetched with a modern-Chrome UA",
      "so each family arrives as unicode-range woff2 subsets (lazy per-subset loading is",
      "preserved; the browser now fetches them from this local static server).",
      "",
      `- Noto Serif SC 400/600/700 — body serif (SIL Open Font License 1.1, see OFL-noto-serif-sc.txt)`,
      `- Ma Shan Zheng 400 — display title font (SIL Open Font License 1.1, see OFL-ma-shan-zheng.txt)`,
      "",
      `Fetched: ${new Date().toISOString()}`,
      "",
      "Regenerate with `node scripts/vendor-webfonts.mjs`.",
      "",
    ].join("\n"),
  );

  console.log(
    `[vendor-webfonts] ${jobs.length} subset files (${(bytes / 1024 / 1024).toFixed(1)} MB) + fonts.css → web/public/fonts/`,
  );
}

main().catch((error) => {
  console.error(`[vendor-webfonts] FAILED: ${error.message}`);
  process.exitCode = 1;
});
