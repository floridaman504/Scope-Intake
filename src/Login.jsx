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

  const lockoutMessage = (lockedUntil) => {
    const minutes = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
    return `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    // Server-side lockout check, ahead of the real sign-in attempt.
    // Fails OPEN (allows the attempt) if this RPC itself is unreachable --
    // an outage in the lockout system should never be the reason a
    // legitimate user can't sign in. See docs/migrations/2026-08-08-login-
    // lockout.sql for the full design (including the known
    // limitation: this is keyed on email alone, not IP, so it raises the
    // bar against naive password guessing but isn't a complete defense
    // against someone deliberately locking out a known account).
    try {
      const { data, error: lockoutErr } = await supabase.rpc('check_login_allowed', { p_email: email });
      const row = Array.isArray(data) ? data[0] : data;
      if (!lockoutErr && row && row.allowed === false) {
        setLoading(false);
        setError(lockoutMessage(row.locked_until));
        return;
      }
    } catch (e) {
      // RPC unavailable -- proceed to the real sign-in attempt.
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setLoading(false);
      setError('Incorrect email or password.');
      try {
        await supabase.rpc('record_failed_login', { p_email: email });
      } catch (e) {
        // best-effort -- a failure here shouldn't change what the user sees
      }
      return;
    }

    try {
      await supabase.rpc('clear_login_attempts', { p_email: email });
    } catch (e) {
      // best-effort
    }

    setLoading(false);

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
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
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
            <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">Email</label>
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
            <div className="flex items-center justify-between mb-1.5">
              <label style={{ color: '#C4C4C4' }} className="text-xs block">Password</label>
              <Link to="/forgot-password" style={{ color: '#C9A227' }} className="text-xs">Forgot password?</Link>
            </div>
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

        <p style={{ color: '#9A9A9A' }} className="text-xs text-center mt-6">
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
