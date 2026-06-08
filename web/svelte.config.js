import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// svelte.config.js — picked up by svelte-check and the
// vite-plugin-svelte loader. We only need vitePreprocess (handles
// <script lang="ts">) ; the actual Svelte compilation happens in
// vite.config.ts via the svelte() plugin.
export default {
  preprocess: vitePreprocess(),
};
