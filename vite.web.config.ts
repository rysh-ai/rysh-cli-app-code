import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web build of the rysh renderer (web_electron_roadmap task W1).
//
// This is a PLAIN Vite build — not electron-vite — so it produces a browser
// bundle with no Electron main/preload. The same renderer that runs in the
// desktop app runs here in "browser mode": `window.electronAPI` is undefined,
// so useWebSocket.ts connects to `${location.host}/ws?stream=1` — served by
// rysh-cli/internal/web. Nothing is imported from electron; the bridge is
// accessed at runtime via `window`, so this builds without electron present.
//
// Output goes straight into internal/web/static, which internal/web embeds via
// //go:embed static/*. NOTE: because that embed is compile-time, the rysh
// binary must be rebuilt after this build — the Makefile.internal_web `all`
// target does both. Build with:
//
//   npx vite build --config vite.web.config.ts
//   # or: make -f Makefile.internal_web web   (from the repo root)
// F-48: this config only ever builds the bundle rysh-cli embeds, so it is always
// a production build. Pinned here, not by callers: Vite reads NODE_ENV from the
// caller's shell, and with NODE_ENV=development ambient it emitted the React dev
// runtime (jsxDEV) and the builder's absolute source paths into a shipped
// artifact. Vite computes isProduction after loading this file, so the pin wins.
// The Electron renderer (electron.vite.config.ts) and vitest do not read this file.
process.env.NODE_ENV = 'production'

export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../rysh-cli-code/internal/web/static'),
    emptyOutDir: true, // allow writing outside this project's root
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
})
