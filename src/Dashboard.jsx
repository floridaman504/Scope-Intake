import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { supabase } from './supabaseClient.js';

export default function Dashboard() {
  const { employee, signOut, signOutEverywhere } = useAuth();
  const [everywhereBusy, setEverywhereBusy] = useState(false);
  const [everywhereMsg, setEverywhereMsg] = useState('');
  const [unclaimedCount, setUnclaimedCount] = useState(0);

  useEffect(() => {
    let active = true;

    const loadCount = async () => {
      const { count } = await supabase
        .from('jobs')
        .select('id', { count: 'exact', head: true })
        .is('claimed_by', null);
      if (active) setUnclaimedCount(count || 0);
    };

    loadCount();

    // Live badge: updates the moment a new job lands or one gets claimed,
    // without needing to leave the dashboard.
    const channel = supabase
      .channel('dashboard-jobs-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, loadCount)
      .subscribe();

    return () => { active = false; supabase.removeChannel(channel); };
  }, []);

  const handleSignOutEverywhere = async () => {
    // This is destructive and hard to undo (kills every active session,
    // including this one) -- confirm before firing it. Flagged as missing
    // in docs/audits/2026-08-08-frontend-health-audit.md.
    if (!window.confirm('Sign out every device signed into your account, including this one? This cannot be undone.')) {
      return;
    }
    setEverywhereBusy(true);
    setEverywhereMsg('');
    try {
      await signOutEverywhere();
      setEverywhereMsg('All your other sessions have been signed out. This device will sign out shortly too.');
    } catch (e) {
      setEverywhereMsg('Could not sign out other sessions: ' + (e.message || 'unknown error'));
    } finally {
      setEverywhereBusy(false);
    }
  };

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="font-sans p-8">
      <div className="flex items-center gap-2 mb-8">
        <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
        <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
      </div>

      <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-2">
        You're logged in.
      </h1>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-1">
        Name: {employee?.full_name || '—'}
      </p>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-6">
        Role: <span style={{ color: '#C9A227' }}>{employee?.role || '—'}</span>
      </p>

      <Link
        to="/jobs"
        style={{ backgroundColor: unclaimedCount > 0 ? '#1E1A0A' : '#161616', border: `1px solid ${unclaimedCount > 0 ? '#C9A227' : '#2A2A2A'}` }}
        className="flex items-center justify-between gap-4 rounded-lg px-5 py-4 mb-6 max-w-sm transition-colors"
      >
        <div>
          <p style={{ color: '#EDEAE3' }} className="text-sm font-semibold">Jobs</p>
          <p style={{ color: '#9A9A9A' }} className="text-xs mt-0.5">View and claim submitted jobs</p>
        </div>
        {unclaimedCount > 0 && (
          <span style={{ backgroundColor: '#E8BD3A', color: '#0A0A0A' }} className="text-xs font-bold px-2.5 py-1 rounded-full shrink-0">
            {unclaimedCount} new
          </span>
        )}
      </Link>

      <div className="flex flex-wrap gap-3 mb-4">
        {employee?.role === 'owner' && (
          <Link
            to="/employees"
            style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
            className="text-sm px-4 py-2 rounded-md"
          >
            Manage team
          </Link>
        )}
        {employee?.role === 'owner' && (
          <Link
            to="/audit-log"
            style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
            className="text-sm px-4 py-2 rounded-md"
          >
            Audit log
          </Link>
        )}
        <button
          onClick={signOut}
          style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
          className="text-sm px-4 py-2 rounded-md"
        >
          Sign Out
        </button>
        <Link
          to="/sessions"
          style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
          className="text-sm px-4 py-2 rounded-md"
        >
          {employee?.role === 'owner' ? 'Manage team sessions' : 'Your active sessions'}
        </Link>
        <button
          onClick={handleSignOutEverywhere}
          disabled={everywhereBusy}
          style={{ border: '1px solid #E07A6E', color: '#E07A6E' }}
          className="text-sm px-4 py-2 rounded-md"
        >
          {everywhereBusy ? 'Signing out everywhere…' : 'Sign out everywhere'}
        </button>
      </div>
      {everywhereMsg && (
        <p style={{ color: '#C4C4C4' }} className="text-xs max-w-md">{everywhereMsg}</p>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
