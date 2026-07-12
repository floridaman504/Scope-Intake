import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError('Incorrect email or password.');
    } else {
      navigate('/dashboard');
    }
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
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
              className="w-full rounded-lg px-4 py-3 outline-none text-base"
            />
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
