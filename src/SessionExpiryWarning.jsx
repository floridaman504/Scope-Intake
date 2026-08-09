import React from 'react';
import { useAuth } from './AuthContext.jsx';

// Shown ~60s before a session's sliding-expiry deadline (see
// sessionConfig.js WARNING_LEAD_SECONDS). One click extends by touching
// the session server-side and resetting the local countdown; doing
// nothing lets the countdown finish and AuthContext signs the user out
// (saving a restore snapshot first -- see AuthContext.jsx forceSignOut).
export default function SessionExpiryWarning() {
  const { sessionWarning, extendSession, signOut } = useAuth();

  if (!sessionWarning?.visible) return null;

  const seconds = Math.max(0, sessionWarning.secondsLeft);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expiry-title"
      style={{ backgroundColor: 'rgba(10,10,10,0.85)' }}
      className="fixed inset-0 z-[9999] flex items-center justify-center px-6 font-sans"
    >
      <div
        style={{ backgroundColor: '#161616', border: '1px solid #2A2A2A' }}
        className="w-full max-w-sm rounded-lg p-6"
      >
        <h2
          id="session-expiry-title"
          style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }}
          className="text-lg font-bold mb-2"
        >
          Still there?
        </h2>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-4">
          You'll be signed out in{' '}
          <span style={{ color: '#C9A227', fontWeight: 600 }}>{seconds}s</span> due to
          inactivity. Anything you're working on stays saved.
        </p>
        <div className="flex gap-3">
          <button
            onClick={extendSession}
            style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
            className="flex-1 font-semibold py-2.5 rounded-md text-sm"
          >
            Stay signed in
          </button>
          <button
            onClick={() => signOut()}
            style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
            className="px-4 py-2.5 rounded-md text-sm"
          >
            Sign out
          </button>
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
