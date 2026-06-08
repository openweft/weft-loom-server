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
export default defineConfig({
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
