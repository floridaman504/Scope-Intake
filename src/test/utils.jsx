// Shared render helper for tests that need the real AuthProvider + router
// context (as opposed to ProtectedRoute.test.jsx, which mocks useAuth
// directly and renders standalone). Centralized here so every integration
// test wires up the same route shape main.jsx uses for /login, /dashboard,
// /join, rather than each test file re-inventing slightly different stub
// routes.
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../AuthContext.jsx';

// AuthProvider's mount effect (supabase.auth.getSession().then(...)) always
// resolves at least one microtask after render() returns, even with a
// mocked client, because it's a real Promise chain. Awaiting a trivial
// waitFor() here flushes that chain (and the state updates it triggers)
// before handing the component back to the test, so individual tests don't
// each need their own React "not wrapped in act(...)" workaround.
export async function renderWithProviders(routes, { initialEntries = ['/'] } = {}) {
  const result = render(
    <MemoryRouter
      initialEntries={initialEntries}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>{routes}</Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  await waitFor(() => {});
  return result;
}

export { Route };
