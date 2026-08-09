import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

// Owner-visible session registry: every active/recent session for every
// employee in the Owner's own company (RLS on user_sessions restricts the
// select to that scope automatically -- see supabase_session_hardening.sql
// policy user_sessions_select_owner_company). Non-owners who land here via
// direct URL only ever see their own rows (user_sessions_select_own), so
// this component degrades to a "your devices" view instead of leaking
// company-wide data -- but the route below is still owner-gated in
// main.jsx as defense in depth.
export default function SessionRegistry() {
  const { employee, sessionId, signOutEverywhere } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [employeesById, setEmployeesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState(null);

  const isOwner = employee?.role === 'owner';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');

    const { data: sessionRows, error: sessionErr } = await supabase
      .from('user_sessions')
      .select('id, user_id, role_at_login, device_label, user_agent, ip_address, created_at, last_activity_at, revoked_at, revoked_reason')
      .order('last_activity_at', { ascending: false });

    if (sessionErr) {
      setError('Could not load sessions: ' + sessionErr.message);
      setLoading(false);
      return;
    }
    setSessions(sessionRows || []);

    if (isOwner) {
      const { data: employeeRows } = await supabase
        .from('employees')
        .select('user_id, full_name, email, role');
      const map = {};
      (employeeRows || []).forEach((e) => { map[e.user_id] = e; });
      setEmployeesById(map);
    }

    setLoading(false);
  }, [isOwner]);

  useEffect(() => { load(); }, [load]);

  const handleRevoke = async (id) => {
    setActionBusy(id);
    await supabase.rpc('revoke_session', { p_session_id: id, p_reason: 'manual_revoke' });
    await load();
    setActionBusy(null);
  };

  const handleSignOutUserEverywhere = async (userId) => {
    setActionBusy(userId);
    await signOutEverywhere(userId);
    await load();
    setActionBusy(null);
  };

  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="font-sans p-8">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <Link to="/dashboard" style={{ color: '#C4C4C4' }} className="text-sm">Back to dashboard</Link>
      </div>

      <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-1">
        {isOwner ? 'Active Sessions — Your Team' : 'Your Active Sessions'}
      </h1>
      <p style={{ color: '#C4C4C4' }} className="text-sm mb-6">
        {isOwner
          ? 'Every session across employees in your company. Revoking a session signs that device out within seconds.'
          : 'Devices currently signed into your account.'}
      </p>

      {error && <p style={{ color: '#E07A6E' }} className="text-sm mb-4">{error}</p>}
      {loading ? (
        <p style={{ color: '#C4C4C4' }} className="text-sm">Loading…</p>
      ) : (
        <div className="space-y-3">
          {sessions.length === 0 && (
            <p style={{ color: '#C4C4C4' }} className="text-sm">No sessions found.</p>
          )}
          {sessions.map((s) => {
            const isCurrent = s.id === sessionId;
            const who = isOwner ? employeesById[s.user_id] : null;
            const isActive = !s.revoked_at;
            return (
              <div
                key={s.id}
                style={{ backgroundColor: '#161616', border: '1px solid #2A2A2A' }}
                className="rounded-lg p-4 flex items-center justify-between gap-4"
              >
                <div>
                  <p style={{ color: '#EDEAE3' }} className="text-sm font-medium">
                    {who ? `${who.full_name} (${who.role})` : (s.device_label || 'Unknown device')}
                    {isCurrent && (
                      <span style={{ color: '#C9A227' }} className="text-xs ml-2">this device</span>
                    )}
                  </p>
                  {who && (
                    <p style={{ color: '#C4C4C4' }} className="text-xs">{s.device_label || 'Unknown device'}</p>
                  )}
                  <p style={{ color: '#9A9A9A' }} className="text-xs mt-1">
                    IP: {s.ip_address || 'unknown'} · Last active: {new Date(s.last_activity_at).toLocaleString()} · Signed in: {new Date(s.created_at).toLocaleString()}
                  </p>
                  <p style={{ color: isActive ? '#7FBF7F' : '#E07A6E' }} className="text-xs mt-1">
                    {isActive ? 'Active' : `Revoked (${s.revoked_reason || 'unknown reason'}) at ${new Date(s.revoked_at).toLocaleString()}`}
                  </p>
                </div>
                {isActive && (
                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      onClick={() => handleRevoke(s.id)}
                      disabled={actionBusy === s.id}
                      style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
                      className="text-xs px-3 py-1.5 rounded-md"
                    >
                      {actionBusy === s.id ? 'Revoking…' : 'Revoke this session'}
                    </button>
                    {isOwner && who && !isCurrent && (
                      <button
                        onClick={() => handleSignOutUserEverywhere(s.user_id)}
                        disabled={actionBusy === s.user_id}
                        style={{ border: '1px solid #E07A6E', color: '#E07A6E' }}
                        className="text-xs px-3 py-1.5 rounded-md"
                      >
                        Sign out everywhere
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
