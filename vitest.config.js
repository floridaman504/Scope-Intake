import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Separate from vite.config.js on purpose -- vite.config.js is the app
// build config (Vercel calls `vite build`, which never needs to know
// vitest exists). Vitest reads vitest.config.js in preference to
// vite.config.js when both exist, so test-only concerns (jsdom, setup
// file, coverage) live here instead of leaking into the production
// bundle's config.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
    css: false,
    exclude: ['node_modules', 'dist', '.git'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      // Scoped to the login/auth flow files this suite (Tier 1.5) actually
      // targets. ScopeIntake.jsx, Dashboard.jsx, SessionRegistry.jsx etc.
      // are unrelated features with their own (future) test suites and
      // would just dilute this number without this suite covering them.
      include: [
        'src/AuthContext.jsx',
        'src/Login.jsx',
        'src/Join.jsx',
        'src/ProtectedRoute.jsx',
        'src/sessionConfig.js',
        'src/activityTracking.js',
        'src/SessionExpiryWarning.jsx',
      ],
      exclude: ['src/test/**'],
      // The playbook's original ask was "fail under 60%." A real run of
      // this suite against just the auth-flow files above lands at
      // ~89% statements / 79% branches / 85% functions / 94% lines (see
      // docs/audits/2026-08-06-login-test-suite.md for the full output).
      // Thresholds below are set with headroom under those real numbers --
      // strict enough to catch a real regression, loose enough that normal
      // future changes to these files don't spuriously fail CI over a
      // percentage point or two.
      thresholds: {
        lines: 85,
        statements: 80,
        functions: 75,
        branches: 65,
      },
    },
  },
});
