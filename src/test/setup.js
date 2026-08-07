// Global Vitest setup, loaded via vitest.config.js `test.setupFiles`.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// React Testing Library doesn't auto-unmount between tests under Vitest
// (that's a Jest-specific default) -- without this, components from one
// test can leak DOM nodes/effects into the next.
afterEach(() => {
  cleanup();
});

// sessionStorage carries real state between AuthContext/Login/
// ProtectedRoute (the restore-snapshot key, the session-id key) -- jsdom
// gives each test file one shared instance, so clear it between every
// test or an earlier test's snapshot silently changes a later test's
// redirect target.
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// jsdom doesn't implement scrollIntoView / matchMedia, and nothing in
// this app needs real values from them for the login flow -- stub so a
// stray call doesn't throw and crash an otherwise-passing test.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
