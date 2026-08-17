import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build target : ../internal/web/dist/ — the Go //go:embed pulls
// from there. Keeping the bundle inside the Go module tree means
// `go build` is the single source of truth for the deployed
// artefact.
// The SPA is deployed under /loom/ behind a proxy that strips the prefix, so
// every asset URL in index.html has to carry it. That was done by hand-editing
// the built index.html (4f6d69d), which meant a fresh `npm run build` silently
// replaced it with one referencing assets at the wrong path — and, because the
// hashes move with every build, referencing assets that no longer exist. A
// binary built from a clean checkout served a blank page.
//
// It is a build setting now. LOOM_BASE overrides it, which is what a local run
// wants: the server itself mounts the SPA at "/", so `LOOM_BASE=/ npm run
// build` produces a bundle that works without a proxy in front of it.
export default defineConfig({
  base: process.env.LOOM_BASE ?? '/loom/',
  plugins: [svelte(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, '../internal/web/dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev mode : Vite serves the SPA, but proxies API + WS calls
      // to the Go server. Run `weft-loom serve --config ...` in one
      // terminal, `npm run dev` in another.
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
