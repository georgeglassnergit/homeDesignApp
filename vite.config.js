import { defineConfig } from 'vite';

// Minimal config. Vite serves index.html, bundles src/main.js, and serves public/ at the web root.
// `npm run dev` for a hot-reload dev server; `npm run build` emits a static site to dist/ that
// deploys to Cloudflare Pages exactly like the current demo.
export default defineConfig({
  base: './',
  server: { port: 5173, open: true },
  build: { target: 'es2020', outDir: 'dist' },
});
