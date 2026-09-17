import { defineConfig } from "vite";
import path from "node:path";

/**
 * Vite build for the browser UI. In development the local web host mounts
 * this config via `createServer({ middlewareMode: true })`; `vite build`
 * emits the production bundle into `dist/web`.
 */
export default defineConfig({
  root: "web",
  // Vendored webfonts (web/public/fonts) — served at /fonts/* in dev and
  // copied into dist/web/fonts by `vite build` (the prod host serves them
  // from there; MIME map already covers woff2).
  publicDir: "public",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      // Portable core (no Node builtins — enforced by
      // src/core/architecture.test.ts): the monitor dashboard reuses the
      // DSL line parser / stream decoder directly instead of duplicating
      // the grammar in the browser.
      "@core": path.resolve(__dirname, "src/core"),
    },
  },
  server: {
    // The local web host serves the page; Vite middleware never binds a port.
    middlewareMode: true,
    hmr: false,
  },
});
