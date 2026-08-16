import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { supabase } from './supabaseClient.js';

// Landing page for the link in Supabase's email-change confirmation email.
// Same mechanism as ResetPassword.jsx: supabaseClient.js has
// detectSessionInUrl: true, so by the time this component mounts the
// session already reflects the confirmed change on the auth.users side --
// there's nothing to read or verify by hand here.
//
// This app's own employees.email column is a separate, denormalized copy
// (used everywhere in the UI -- Team page, job assignment, the audit log's
// actor label, etc.) that has no way to know the auth-side change happened
// on its own. sync_my_email() (docs/migrations/2026-08-16-employee-email-
// change.sql) is the second half: a narrow, parameterless RPC that just
// copies the caller's own already-confirmed auth email onto their own
// employees row -- called once, here, right after landing.
export default function EmailChangeConfirmed() {
  const { session, loading: authLoading } = useAuth();
  const [syncState, setSyncState] = useState('pending'); // 'pending' | 'done' | 'error'

  useEffect(() => {
    if (authLoading || !session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.rpc('sync_my_email', {});
      if (cancelled) return;
      if (error) {
        // Not fatal -- the auth-side email is already confirmed and
        // correct either way. This just means the Team page/audit log's
        // copy of it may be stale until the next successful sync (it's
        // re-attempted the next time this page loads, or can be fixed by
        // an owner if it ever matters). Log it, but don't block the user
        // with a scary error for something that isn't one.
        console.error('Could not sync employee email record:', error);
        setSyncState('error');
        return;
      }
      setSyncState('done');
    })();
    return () => { cancelled = true; };
  }, [authLoading, session]);

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
      <p style={{ color: '#C4C4C4' }} className="text-sm text-center">Confirming your new email…</p>
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
          to="/dashboard"
          style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
          className="w-full font-semibold py-3 rounded-md text-sm block text-center"
        >
          Back to dashboard
        </Link>
      </>
    );
  }

  return renderCard(
    <>
      <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1 text-center">
        Email Updated
      </h1>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-8 text-center">
        {syncState === 'error'
          ? 'Your email is confirmed. It may take a moment to show up everywhere in the app -- if it still looks off later, try reloading.'
          : 'Your new email is confirmed and up to date across the app.'}
      </p>
      <Link
        to="/dashboard"
        style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
        className="w-full font-semibold py-3 rounded-md text-sm block text-center"
      >
        Back to dashboard
      </Link>
    </>
  );
}
