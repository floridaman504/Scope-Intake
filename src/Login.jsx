import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { session } = useAuth();

  // Navigate off of the shared AuthContext session, not the local
  // signInWithPassword() result. AuthContext updates `session` asynchronously
  // through its own onAuthStateChange listener, and ProtectedRoute reads
  // session from that same context -- if we navigate right after
  // signInWithPassword() resolves, there's a race where ProtectedRoute can
  // render before AuthContext has caught up, see session=null, and bounce
  // straight back to /login (with `replace`, so it doesn't self-correct).
  // Waiting for `session` here guarantees ProtectedRoute never sees a stale
  // value.
  useEffect(() => {
    if (session) navigate('/dashboard');
  }, [session]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError('Incorrect email or password.');
    }
    // No explicit navigate here -- the effect above handles it once
    // AuthContext confirms the session.
  };

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPWELL</span>
        </div>

        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
          Dispatch Login
        </h1>
        <p style={{ color: '#9A9A9A' }} className="text-sm mb-8 text-center">
          Sign in to access the dispatch dashboard.
        </p>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="login-email" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Email</label>
            <input
              id="login-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
              className="w-full rounded-lg px-4 py-3 outline-none text-base focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
            />
          </div>
          <div>
            <label htmlFor="login-password" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Password</label>
            <div className="relative">
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
                className="w-full rounded-lg px-4 py-3 pr-11 outline-none text-base focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                style={{ color: '#5A5A5A' }}
                className="absolute right-0 top-0 h-full px-3 flex items-center rounded-r-lg focus:ring-2 focus:ring-[#E8BD3A] focus:ring-inset"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" style={{ color: '#E07A6E' }} className="text-sm text-center">{error}</p>
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

        <p style={{ color: '#8A8A8A' }} className="text-xs text-center mt-6">
          Have an invite code?{' '}
          <Link to="/join" style={{ color: '#C9A227' }} className="underline focus:ring-2 focus:ring-[#E8BD3A] rounded">Create your account</Link>
        </p>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
