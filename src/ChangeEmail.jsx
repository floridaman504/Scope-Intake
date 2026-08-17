import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { supabase } from './supabaseClient.js';

// Self-service email change (follow-on from the audit-trail item -- see
// docs/migrations/2026-08-16-employee-email-change.sql for the full
// rationale). This only REQUESTS the change: supabase.auth.updateUser()
// sends a confirmation link and does not touch auth.users.email (or this
// app's own employees.email, which is a separate denormalized copy) until
// that link is clicked. EmailChangeConfirmed.jsx is the other half -- it
// runs after the click and syncs employees.email to match.
export default function ChangeEmail() {
  const { employee } = useAuth();
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newEmail.trim().toLowerCase() === (employee?.email || '').toLowerCase()) {
      setError('That’s already your current email.');
      return;
    }

    setLoading(true);
    const { error: updateErr } = await supabase.auth.updateUser(
      { email: newEmail.trim() },
      { emailRedirectTo: `${window.location.origin}/email-changed` }
    );
    setLoading(false);

    if (updateErr) {
      // Generic message on screen, real error only to the console -- same
      // split this codebase uses everywhere else. Kept inline here rather
      // than importing the shared errorMessages.js helper so this PR
      // doesn't depend on PR #33 (error-handling-fix) merging first.
      console.error('Could not start email change:', updateErr);
      setError('Could not update your email right now. Please try again.');
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
          Change Your Email
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
          Current email: {employee?.email || '—'}
        </p>

        {sent ? (
          <div>
            <p style={{ color: '#C9A227', backgroundColor: '#1F1B0E', border: '1px solid #4A3D14' }}
              className="text-sm rounded-md px-4 py-3 mb-6 text-center">
              Confirm the change using the link we just emailed you. Until then, your account keeps using your current email everywhere.
            </p>
            <p style={{ color: '#9A9A9A' }} className="text-xs text-center">
              <Link to="/dashboard" style={{ color: '#C9A227' }}>Back to dashboard</Link>
            </p>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">New Email</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
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
                {loading ? 'Sending…' : 'Send Confirmation Link'}
              </button>
            </form>

            <p style={{ color: '#9A9A9A' }} className="text-xs text-center mt-6">
              <Link to="/dashboard" style={{ color: '#C9A227' }}>Back to dashboard</Link>
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
