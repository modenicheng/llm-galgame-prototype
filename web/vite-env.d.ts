/// <reference types="vite/client" />

/**
 * Browser UI ambient types.
 *
 * `vite/client` supplies the `*?url` / `*?raw` / `*.css` module declarations
 * used across `web/src` (notably the AudioWorklet import
 * `./pcm-worklet.ts?url`). `web/src/audio/worklet-env.d.ts` keeps the
 * AudioWorkletProcessor ambient surface for TypeScript versions whose DOM
 * libs do not ship it yet.
 */
