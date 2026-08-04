import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

export default function Join() {
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState(false);
  const navigate = useNavigate();
  const { session, employee } = useAuth();

  // Same reasoning as Login.jsx: wait for AuthContext to actually have both
  // a session AND the employee row loaded (redeem_invite_code() just
  // created it) before navigating, instead of racing AuthContext's own
  // async state updates.
  useEffect(() => {
    if (joined && session && employee) navigate('/dashboard');
  }, [joined, session, employee]);

  const handleJoin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // 1. Create the login (email + password). The invite code itself is
      // no longer checked from the client -- invite_codes has no client
      // read/write access under RLS anymore, so there's nothing to check
      // here. Validation happens server-side in step 2.
      const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
      });
      if (signUpErr) {
        setError(signUpErr.message);
        setLoading(false);
        return;
      }

      if (!signUpData.session) {
        // Email confirmation is required before Supabase issues a session.
        // Without a session there's no authenticated user yet, so the
        // invite code can't be redeemed until they confirm and sign in.
        setError('Account created. Check your email to confirm it, then sign in to finish joining with your invite code.');
        setLoading(false);
        return;
      }

      // 2. Redeem the invite code through the server-validated function.
      // This checks the code is real and unused, assigns the role from
      // the invite (never a role the client sends), and marks the code
      // used -- all atomically, on the server, in one transaction.
      const { error: redeemErr } = await supabase.rpc('redeem_invite_code', {
        invite_code: code.trim(),
        employee_full_name: fullName,
        employee_email: email,
      });

      if (redeemErr) {
        setError(redeemErr.message || 'That invite code is invalid or already used.');
        setLoading(false);
        return;
      }

      setJoined(true);
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 py-10 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPWELL</span>
        </div>

        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
          Join Your Team
        </h1>
        <p style={{ color: '#9A9A9A' }} className="text-sm mb-8 text-center">
          Enter the invite code your admin gave you.
        </p>

        <form onSubmit={handleJoin} className="space-y-4">
          <div>
            <label htmlFor="join-code" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Invite Code</label>
            <input
              id="join-code"
              name="inviteCode"
              type="text"
              required
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. SCOPWELL-4X7K"
              style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
              className="w-full rounded-lg px-4 py-3 outline-none text-base placeholder-[#6A6A6A] focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
            />
          </div>
          <div>
            <label htmlFor="join-name" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Your Name</label>
            <input
              id="join-name"
              name="name"
              type="text"
              required
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
              className="w-full rounded-lg px-4 py-3 outline-none text-base focus:ring-2 focus:ring-[#E8BD3A] focus:ring-offset-2 focus:ring-offset-[#0A0A0A]"
            />
          </div>
          <div>
            <label htmlFor="join-email" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Email</label>
            <input
              id="join-email"
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
            <label htmlFor="join-password" style={{ color: '#9A9A9A' }} className="text-xs mb-1.5 block">Create a Password</label>
            <div className="relative">
              <input
                id="join-password"
                name="newPassword"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                autoComplete="new-password"
                aria-describedby="join-password-hint"
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
            <p id="join-password-hint" style={{ color: '#8A8A8A' }} className="text-xs mt-1.5">At least 6 characters.</p>
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
            {loading ? 'Creating account…' : 'Join Team'}
          </button>
        </form>

        <p style={{ color: '#8A8A8A' }} className="text-xs text-center mt-6">
          Already have an account?{' '}
          <Link to="/login" style={{ color: '#C9A227' }} className="underline focus:ring-2 focus:ring-[#E8BD3A] rounded">Sign in</Link>
        </p>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
