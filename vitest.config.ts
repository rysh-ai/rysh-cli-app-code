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
    include: ['src/**/*.test.{ts,tsx}', 'electron/facetime.test.ts', 'electron/meetingPermissions.test.ts', 'electron/meetingZoomTeams.test.ts', 'electron/webPaneBootstrap.test.ts', 'electron/webPaneLoadError.test.ts', 'electron/webPanePermissions.test.ts', 'electron/instanceManager.test.ts', 'electron/defaultWorkspace.test.ts', 'electron/meetingReport.test.ts', 'electron/sidecarQuit.test.ts', 'electron/sidecarNoPattern.test.ts', 'electron/sidecarReaper.test.ts', 'electron/remoteSetup.test.ts', 'electron/controlSecret.test.ts', 'electron/sidecarControlSecret.test.ts', 'electron/daemonRegistryMode.test.ts', 'electron/sidecarStartFailure.test.ts', 'electron/companyConnect.test.ts', 'electron/companyConnectServer.test.ts', 'electron/sandboxDesktop.test.ts', 'electron/updateLog.test.ts', 'electron/linkLaunch.test.ts', 'electron/connectFile.test.ts', 'electron/updateLocation.test.ts', 'scripts/verify/*.test.ts'],
    restoreMocks: true,
  },
});
