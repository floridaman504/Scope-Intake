import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import ScopeIntake from './ScopeIntake.jsx'
import Login from './Login.jsx'
import Join from './Join.jsx'
import Dashboard from './Dashboard.jsx'
import ProtectedRoute from './ProtectedRoute.jsx'
import { AuthProvider } from './AuthContext.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<ScopeIntake />} />
          <Route path="/login" element={<Login />} />
          <Route path="/join" element={<Join />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute allowedRoles={['owner', 'dispatcher']}>
                <Dashboard />
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
