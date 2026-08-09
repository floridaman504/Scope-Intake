import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from './AuthContext.jsx';

// Landing page for the link in the password-reset email. Supabase's client
// (detectSessionInUrl: true, set in supabaseClient.js) parses the
// recovery token out of the URL automatically and turns it into a session
// -- that's what useAuth().session reflects here. There's no separate
// token to read or verify by hand.
export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();
  const { session, loading: authLoading, changePasswordAndSignOutEverywhere } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      // Sets the new password, then revokes every other active session for
      // this account (including this recovery link's own session) --
      // exactly what should happen after a password reset, and reuses the
      // same revoke-everywhere logic the "change password" flow will use
      // once that UI exists.
      await changePasswordAndSignOutEverywhere(password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
      setLoading(false);
    }
  };

  const renderCard = (content) => (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        {content}
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );

  if (authLoading) {
    return renderCard(
      <p style={{ color: '#C4C4C4' }} className="text-sm text-center">Checking your reset link…</p>
    );
  }

  // Checked BEFORE `!session`, on purpose: a successful update calls
  // changePasswordAndSignOutEverywhere, which clears the local session as
  // its last step. Without this ordering, the moment it succeeds the
  // component would fall into the "Link Expired" branch below instead of
  // showing the success message.
  if (done) {
    return renderCard(
      <>
        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-3 text-center">
          Password Updated
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm text-center">
          Your password has been changed and you've been signed out everywhere. Redirecting you to sign in…
        </p>
      </>
    );
  }

  if (!session) {
    return renderCard(
      <>
        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-3 text-center">
          Link Expired
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-6 text-center">
          This password reset link is invalid or has expired. Reset links only work once and expire after a while for security.
        </p>
        <Link
          to="/forgot-password"
          style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
          className="w-full font-semibold py-3 rounded-md text-sm block text-center"
        >
          Request a new link
        </Link>
      </>
    );
  }

  return renderCard(
    <>
      <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
        Set a New Password
      </h1>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
        Choose a new password for your account.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">New Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              required
              minLength={6}
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
        <div>
          <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">Confirm New Password</label>
          <input
            type={showPassword ? 'text' : 'password'}
            required
            minLength={6}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
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
          {loading ? 'Updating…' : 'Update Password'}
        </button>
      </form>
    </>
  );
}
