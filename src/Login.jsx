import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { Eye, EyeOff } from 'lucide-react';

const EXPIRY_MESSAGES = {
  inactivity_timeout: 'You were signed out after a period of inactivity.',
  session_revoked: 'Your session was signed out (from this device or by an admin).',
  auth_state_signed_out_externally: 'Your session ended and needed to be refreshed. Please sign in again.',
  concurrent_session_limit_exceeded: 'You were signed out because you reached the device sign-in limit.',
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { consumeRestoreSnapshot } = useAuth();

  const expiredReason = searchParams.get('expired') === '1' ? searchParams.get('reason') : null;
  const expiredMessage = expiredReason && (EXPIRY_MESSAGES[expiredReason] || 'You were signed out.');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError('Incorrect email or password.');
      return;
    }

    // Restore the page the user was on before an expiry/revocation/direct
    // link redirect, if we have one and it's still fresh. Only ever
    // restore to an in-app relative path (starts with "/", never "//" --
    // guards against an open-redirect if this value were ever tampered
    // with) -- otherwise fall back to the normal /dashboard landing.
    const snapshot = consumeRestoreSnapshot ? consumeRestoreSnapshot() : null;
    const target = snapshot?.path && snapshot.path.startsWith('/') && !snapshot.path.startsWith('//')
      ? snapshot.path
      : '/dashboard';
    navigate(target);
  };

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPE</span>
        </div>

        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
          Dispatch Login
        </h1>
        <p style={{ color: '#9A9A9A' }} className="text-sm mb-8 text-center">
          Sign in to access the dispatch dashboard.
        </p>

        {expiredMessage && (
          <p style={{ color: '#C9A227', backgroundColor: '#1F1B0E', border: '1px solid #4A3D14' }}
            className="text-xs rounded-md px-3 py-2 mb-4 text-center">
            {expiredMessage}
          </p>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
              className="w-full rounded-lg px-4 py-3 outline-none text-base"
            />
          </div>
          <div>
            <label style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
                className="w-full rounded-lg pl-4 pr-12 py-3 outline-none text-base"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                style={{ color: '#454545' }}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1"
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
          </div>

          {error && (
            <p style={{ color: '#E07A6E' }} className="text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
            className="w-full font-semibold py-3 rounded-md text-sm mt-2"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p style={{ color: '#6A6A6A' }} className="text-xs text-center mt-6">
          Have an invite code?{' '}
          <Link to="/join" style={{ color: '#C9A227' }}>Create your account</Link>
        </p>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
