import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setLoading(false);

    // Always show the same success message, whether or not an account
    // exists for this email. Supabase's own API already behaves this way
    // (it doesn't error for an unknown email) -- matching that here avoids
    // using this form to check which emails have accounts.
    if (error) {
      setError('Something went wrong. Please try again in a moment.');
      return;
    }
    setSent(true);
  };

  return (
    <main style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPE</span>
        </div>

        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
          Reset Your Password
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
          Enter your email and we'll send you a link to set a new password.
        </p>

        {sent ? (
          <div>
            <p style={{ color: '#C9A227', backgroundColor: '#1F1B0E', border: '1px solid #4A3D14' }}
              className="text-sm rounded-md px-4 py-3 mb-6 text-center">
              If an account exists for that email, a reset link is on its way. Check your inbox (and spam folder).
            </p>
            <p style={{ color: '#9A9A9A' }} className="text-xs text-center">
              <Link to="/login" style={{ color: '#C9A227' }}>Back to sign in</Link>
            </p>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
                  className="w-full rounded-lg px-4 py-3 outline-none focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[#E8BD3A] text-base"
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
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>

            <p style={{ color: '#9A9A9A' }} className="text-xs text-center mt-6">
              <Link to="/login" style={{ color: '#C9A227' }}>Back to sign in</Link>
            </p>
          </>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </main>
  );
}
