import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ScopeIntake from './ScopeIntake.jsx'
import Login from './Login.jsx'
import ForgotPassword from './ForgotPassword.jsx'
import ResetPassword from './ResetPassword.jsx'
import Join from './Join.jsx'
import Dashboard from './Dashboard.jsx'
import JobsQueue from './JobsQueue.jsx'
import SessionRegistry from './SessionRegistry.jsx'
import NotFound from './NotFound.jsx'
import ProtectedRoute from './ProtectedRoute.jsx'
import SessionExpiryWarning from './SessionExpiryWarning.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { AuthProvider } from './AuthContext.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <SessionExpiryWarning />
          <Routes>
            <Route path="/" element={<ScopeIntake />} />
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/join" element={<Join />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute allowedRoles={['owner', 'dispatcher']}>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/jobs"
              element={
                <ProtectedRoute allowedRoles={['owner', 'dispatcher']}>
                  <JobsQueue />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sessions"
              element={
                <ProtectedRoute allowedRoles={['owner', 'dispatcher', 'plumber']}>
                  <SessionRegistry />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)
