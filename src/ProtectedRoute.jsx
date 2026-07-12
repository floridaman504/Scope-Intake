import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

// Wrap any page in this to require login.
// Optionally pass allowedRoles={['owner', 'dispatcher']} to also restrict by role.
export default function ProtectedRoute({ children, allowedRoles }) {
  const { session, employee, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ backgroundColor: '#0A0A0A', color: '#9A9A9A', minHeight: '100vh' }}
        className="flex items-center justify-center text-sm font-sans">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && (!employee || !allowedRoles.includes(employee.role))) {
    return (
      <div style={{ backgroundColor: '#0A0A0A', color: '#9A9A9A', minHeight: '100vh' }}
        className="flex items-center justify-center text-sm font-sans px-6 text-center">
        You don't have access to this page.
      </div>
    );
  }

  return children;
}
