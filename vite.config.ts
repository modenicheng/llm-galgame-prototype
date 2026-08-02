import { defineConfig } from "vite";
import path from "node:path";

/**
 * Vite build for the browser UI. In development the local web host mounts
 * this config via `createServer({ middlewareMode: true })`; `vite build`
 * emits the production bundle into `dist/web`.
 */
export default defineConfig({
  root: "web",
  publicDir: false,
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  server: {
    // The local web host serves the page; Vite middleware never binds a port.
    middlewareMode: true,
    hmr: false,
  },
});
