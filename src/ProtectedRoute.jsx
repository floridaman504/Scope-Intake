import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { RESTORE_SNAPSHOT_KEY } from './sessionConfig.js';

// Wrap any page in this to require login.
// Optionally pass allowedRoles={['owner', 'dispatcher']} to also restrict by role.
export default function ProtectedRoute({ children, allowedRoles }) {
  const { session, employee, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ backgroundColor: '#0A0A0A', color: '#C4C4C4', minHeight: '100vh' }}
        className="flex items-center justify-center text-sm font-sans">
        Loading…
      </div>
    );
  }

  if (!session) {
    // Save where they were trying to go (a direct/bookmarked link to a
    // protected page, or a bounce from an expired session that a slower
    // network beat AuthContext's own snapshot-then-navigate to) so Login
    // can send them back after they re-authenticate. Uses the same
    // sessionStorage key AuthContext's forceSignOut() writes, so whichever
    // one runs first wins and Login only has one format to read.
    try {
      const existing = sessionStorage.getItem(RESTORE_SNAPSHOT_KEY);
      if (!existing) {
        sessionStorage.setItem(RESTORE_SNAPSHOT_KEY, JSON.stringify({
          path: location.pathname + location.search,
          savedAt: Date.now(),
          reason: 'unauthenticated_direct_access',
          formData: null,
        }));
      }
    } catch (e) {
      // sessionStorage unavailable -- redirect still works, just without restore
    }
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && (!employee || !allowedRoles.includes(employee.role))) {
    return (
      <div style={{ backgroundColor: '#0A0A0A', color: '#C4C4C4', minHeight: '100vh' }}
        className="flex items-center justify-center text-sm font-sans px-6 text-center">
        You don't have access to this page.
      </div>
    );
  }

  return children;
}
