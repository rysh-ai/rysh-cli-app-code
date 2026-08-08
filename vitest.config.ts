import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Standalone rather than an extension of an existing config, deliberately:
// electron.vite.config.ts exports an electron-vite config (main/preload/renderer
// sections), which is not a plain Vite config vitest can consume, and
// vite.web.config.ts is the *web build* — its outDir writes into
// rysh-cli/internal/web/static, and importing vitest/config there would make a
// production build depend on the test toolchain. Neither carries anything the
// renderer tests need (no aliases, no define, no envPrefix) beyond the React
// plugin, so this duplicates one line instead of coupling a build to tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
