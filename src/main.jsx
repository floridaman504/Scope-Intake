import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ScopeIntake from './ScopeIntake.jsx'
import Login from './Login.jsx'
import ForgotPassword from './ForgotPassword.jsx'
import ResetPassword from './ResetPassword.jsx'
import EmailConfirmed from './EmailConfirmed.jsx'
import ChangeEmail from './ChangeEmail.jsx'
import EmailChangeConfirmed from './EmailChangeConfirmed.jsx'
import Join from './Join.jsx'
import Dashboard from './Dashboard.jsx'
import JobsQueue from './JobsQueue.jsx'
import EmployeeManagement from './EmployeeManagement.jsx'
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
            <Route path="/email-confirmed" element={<EmailConfirmed />} />
            <Route path="/email-changed" element={<EmailChangeConfirmed />} />
            <Route
              path="/change-email"
              element={
                <ProtectedRoute allowedRoles={['owner', 'dispatcher', 'plumber']}>
                  <ChangeEmail />
                </ProtectedRoute>
              }
            />
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
                // task #41: plumbers now get their own read-only, scoped
                // view of /jobs (JobsQueue.jsx itself decides what a
                // plumber can see/do -- this route gate just needed to
                // stop blocking them entirely). Owner/dispatcher still
                // get the full assign/status/notes/search view.
                <ProtectedRoute allowedRoles={['owner', 'dispatcher', 'plumber']}>
                  <JobsQueue />
                </ProtectedRoute>
              }
            />
            <Route
              path="/employees"
              element={
                <ProtectedRoute allowedRoles={['owner']}>
                  <EmployeeManagement />
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
