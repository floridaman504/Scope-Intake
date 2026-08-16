import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { recordActivity } from './activityTracking.js';
import { logSafeError } from './errorMessages.js';
import { useAuth } from './AuthContext.jsx';

// Landing page for the link in Supabase's signup-confirmation email.
// Dormant today -- Auth > Providers > "Confirm email" is OFF on this
// project (docs/audits/2026-08-08-frontend-health-audit.md), so
// supabase.auth.signUp() currently returns a session immediately and this
// page is never reached. It's built now so the flow isn't a dead end the
// moment Confirm Email ever gets turned on.
//
// Same mechanism as ResetPassword.jsx: supabase.js has
// detectSessionInUrl: true, so the confirmation token in the URL is
// already parsed into a session by the time this component mounts --
// there's nothing to read or verify by hand here, `session` from useAuth()
// just reflects whether it worked.
//
// Why this isn't a plain "success" message: Join.jsx's handleJoin() only
// calls redeem_invite_code() in the SAME request where supabase.auth.signUp()
// returns a session directly (i.e. Confirm Email off, today's behavior). If
// signUp() returns no session (Confirm Email on), the invite code the user
// typed is never redeemed -- it only ever lived in that form's local
// state, and is gone once they navigate away to check their email. So a
// user landing here after confirming has an authenticated session but no
// employees row yet. Rather than send them back to a full Join form that
// would try to sign them up a second time (and fail -- Supabase rejects a
// signUp for an email that already exists), this page finishes the second
// half of that flow directly: just the invite code and name, redeemed
// against the session's own (already-verified) email.
//
// NOTE for whoever turns Confirm Email on: Supabase's default confirmation
// email template needs its link pointed at this route (Auth > Email
// Templates > Confirm signup, or the "Additional Redirect URLs" allow-list)
// -- e.g. `{{ .SiteURL }}/email-confirmed`. This file can't set that itself.
export default function EmailConfirmed() {
  const [inviteCode, setInviteCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { session, employee, loading: authLoading } = useAuth();

  const handleFinishJoining = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { error: redeemErr } = await supabase.rpc('redeem_invite_code', {
        invite_code: inviteCode.trim(),
        employee_full_name: fullName,
        employee_email: session.user.email,
      });
      if (redeemErr) {
        setError(logSafeError('Invite code redemption failed:', redeemErr, 'That invite code is invalid or already used.'));
        setSubmitting(false);
        return;
      }
      recordActivity();
      navigate('/dashboard');
    } catch (err) {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
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
      <p style={{ color: '#C4C4C4' }} className="text-sm text-center">Confirming your email…</p>
    );
  }

  if (!session) {
    return renderCard(
      <>
        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-3 text-center">
          Link Expired
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-6 text-center">
          This confirmation link is invalid or has expired. Confirmation links only work once and expire after a while for security.
        </p>
        <Link
          to="/join"
          style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
          className="w-full font-semibold py-3 rounded-md text-sm block text-center"
        >
          Start over
        </Link>
      </>
    );
  }

  // Already has an employee record -- either a stale re-click of an old
  // confirmation link, or they finished joining in a different tab. Either
  // way there's nothing left to do here.
  if (employee) {
    navigate('/dashboard', { replace: true });
    return renderCard(
      <p style={{ color: '#C4C4C4' }} className="text-sm text-center">You're already set up. Redirecting…</p>
    );
  }

  return renderCard(
    <>
      <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
        Email Confirmed
      </h1>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
        Enter the invite code your admin gave you to finish joining your team.
      </p>

      <form onSubmit={handleFinishJoining} className="space-y-4">
        <div>
          <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">Invite Code</label>
          <input
            type="text"
            required
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="e.g. SCOPE-4X7K"
            style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
            className="w-full rounded-lg px-4 py-3 outline-none text-base placeholder-[#9A9A9A]"
          />
        </div>
        <div>
          <label style={{ color: '#C4C4C4' }} className="text-xs mb-1.5 block">Your Name</label>
          <input
            type="text"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            style={{ color: '#111111', backgroundColor: '#F4F1E8', border: '2px solid #454545' }}
            className="w-full rounded-lg px-4 py-3 outline-none text-base"
          />
        </div>

        {error && (
          <p style={{ color: '#E07A6E' }} className="text-sm text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
          className="w-full font-semibold py-3 rounded-md text-sm mt-2"
        >
          {submitting ? 'Joining…' : 'Join Team'}
        </button>
      </form>
    </>
  );
}
