import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { startActivityTracking, recordActivity } from './activityTracking.js';
import {
  FALLBACK_ROLE_LIFETIME_MINUTES,
  WARNING_LEAD_SECONDS,
  ACTIVITY_TOUCH_THROTTLE_MS,
  BACKSTOP_POLL_INTERVAL_MS,
  WARNING_TICK_MS,
  RESTORE_SNAPSHOT_KEY,
  RESTORE_SNAPSHOT_MAX_AGE_MS,
  parseDeviceLabel,
} from './sessionConfig.js';

const AuthContext = createContext(null);
const SESSION_ID_STORAGE_KEY = 'scope_session_id';

// ---------------------------------------------------------------------------
// Tier 1.3 session/auth hardening. Read docs/audits/2026-08-06-session-auth-
// hardening.md before touching this file -- the short version:
//
// Supabase Auth's own JWT is short-lived (1hr default access token, set in
// Auth > Sessions) but otherwise mostly stateless and, on this project's
// Free plan, does NOT support per-role TTLs, concurrent-session caps, or
// inactivity timeouts natively (those toggles are Pro-plan-gated). So this
// file layers an app-level session registry (user_sessions table +
// SECURITY DEFINER functions in supabase_session_hardening.sql, NOT YET
// APPLIED to production) on top of Supabase's own auth. Every RPC call
// into that registry is wrapped in try/catch and fails OPEN (falls back to
// "just let normal Supabase auth handle it") rather than fails closed, so
// that shipping this code before the migration runs doesn't lock anyone
// out -- it just means the extra hardening is inert until the SQL is run.
// ---------------------------------------------------------------------------

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [employee, setEmployee] = useState(null); // { id, user_id, company_id, role, full_name, email }
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState(null);
  const [sessionWarning, setSessionWarning] = useState({ visible: false, secondsLeft: 0 });
  const [roleLifetimeMap, setRoleLifetimeMap] = useState({});

  const location = useLocation();
  const navigate = useNavigate();

  const sessionIdRef = useRef(null);
  const prevSessionRef = useRef(null);
  const weInitiatedSignOutRef = useRef(false);
  const lastActivityAtRef = useRef(Date.now());
  const lastServerTouchRef = useRef(0);
  const locationRef = useRef(location);
  const formSnapshotGetterRef = useRef(null);

  useEffect(() => { locationRef.current = location; }, [location]);

  const loadEmployee = async (userId) => {
    if (!userId) {
      setEmployee(null);
      return;
    }
    // id, user_id, and company_id are all included (not just
    // role/full_name/email):
    // - id is the employees-table primary key, needed anywhere the app
    //   writes a foreign key back to employees (e.g. JobsQueue.jsx sets
    //   jobs.claimed_by = employee.id -- claimed_by references
    //   employees(id), NOT the auth user id, so this was missing before
    //   and Claim silently failed to persist who claimed a job).
    // - user_id lets callers like SessionRegistry.jsx tell "is this row
    //   one of MY OWN other devices" apart from "is this a different
    //   employee entirely" -- see the isSelf check there for why that
    //   distinction matters for the Sign Out Everywhere button.
    // - company_id (added for task #41/#42, dispatcher dashboard +
    //   pricing estimator): several new inserts need it supplied directly
    //   from the client -- e.g. JobNotes.jsx's job_notes insert and the
    //   upcoming job_estimates/job_estimate_line_items inserts -- because
    //   those tables' company_id column has no default and isn't derived
    //   server-side the way jobs.company_id is. RLS still independently
    //   re-checks company_id = get_my_company_id() on every one of those
    //   inserts, so a stale or tampered value here can't grant access to
    //   another company's data -- this is just what the client sends,
    //   not what the database trusts.
    const { data, error } = await supabase
      .from('employees')
      .select('id, user_id, company_id, role, full_name, email, deactivated_at')
      .eq('user_id', userId)
      .single();
    // A deactivated employee (docs/migrations/2026-08-12-employee-
    // deactivation-and-email-constraint.sql) is treated exactly like "no
    // employee row" -- ProtectedRoute already bounces that case with a
    // clear "you don't have access" message on every route (every route in
    // main.jsx passes allowedRoles), so this doesn't need its own special
    // handling there. The real enforcement is server-side regardless:
    // get_my_company_id()/get_my_role() also return NULL for a deactivated
    // employee, so even a still-valid JWT can't read/write anything
    // RLS-gated -- this local check is just so the UI doesn't keep treating
    // them as logged in until the next query fails.
    const row = !error && data ? data : null;
    setEmployee(row && !row.deactivated_at ? row : null);
  };

  // Reuses a previously registered session row (persisted per-tab in
  // sessionStorage) if it's still valid, otherwise registers a new one.
  // Reuse matters: without it, every page refresh would register a brand
  // new session row and could evict a user's own other legitimate devices
  // via the concurrent-session cap.
  const ensureSessionRegistered = async () => {
    try {
      const existingId = sessionStorage.getItem(SESSION_ID_STORAGE_KEY);
      if (existingId) {
        const { data, error } = await supabase.rpc('touch_session', { p_session_id: existingId });
        const row = Array.isArray(data) ? data[0] : data;
        if (!error && row?.valid) {
          sessionIdRef.current = existingId;
          setSessionId(existingId);
          lastActivityAtRef.current = Date.now();
          lastServerTouchRef.current = Date.now();
          return;
        }
        sessionStorage.removeItem(SESSION_ID_STORAGE_KEY);
      }

      const { data: newId, error: regErr } = await supabase.rpc('register_session', {
        p_device_label: parseDeviceLabel(navigator.userAgent),
        p_user_agent: navigator.userAgent,
      });
      if (!regErr && newId) {
        sessionIdRef.current = newId;
        setSessionId(newId);
        sessionStorage.setItem(SESSION_ID_STORAGE_KEY, newId);
        lastActivityAtRef.current = Date.now();
        lastServerTouchRef.current = Date.now();
      } else if (regErr) {
        // Most likely cause: supabase_session_hardening.sql hasn't been
        // applied to this project yet. Degrade gracefully -- normal
        // Supabase auth still works, we just skip the extra hardening.
        console.warn('[session-hardening] register_session unavailable, continuing without it:', regErr.message);
      }
    } catch (e) {
      console.warn('[session-hardening] ensureSessionRegistered failed, continuing without it:', e);
    }
  };

  const saveRestoreSnapshot = (reason) => {
    try {
      const snapshot = {
        path: locationRef.current.pathname + locationRef.current.search,
        savedAt: Date.now(),
        reason,
        formData: formSnapshotGetterRef.current ? formSnapshotGetterRef.current() : null,
      };
      sessionStorage.setItem(RESTORE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (e) {
      // sessionStorage can throw (private-mode quota, etc). Restore is a
      // nice-to-have; never let it block sign-out.
    }
  };

  const clearSessionRegistration = () => {
    sessionStorage.removeItem(SESSION_ID_STORAGE_KEY);
    sessionIdRef.current = null;
    setSessionId(null);
    setSessionWarning({ visible: false, secondsLeft: 0 });
  };

  const forceSignOut = useCallback(async (reason) => {
    weInitiatedSignOutRef.current = true;
    saveRestoreSnapshot(reason);
    clearSessionRegistration();
    await supabase.auth.signOut();
    setSession(null);
    setEmployee(null);
    navigate(`/login?expired=1&reason=${encodeURIComponent(reason)}`, { replace: true });
  }, [navigate]);

  // --- initial load + auth state changes -----------------------------------
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      prevSessionRef.current = session;
      await loadEmployee(session?.user?.id);
      if (session) await ensureSessionRegistered();
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      const hadSession = !!prevSessionRef.current;

      if (!newSession && hadSession && !weInitiatedSignOutRef.current) {
        // The session ended without us calling signOut()/forceSignOut()
        // ourselves -- e.g. the refresh token was rejected after
        // supabase-js's own retry/backoff gave up. Don't leave the user
        // stranded on a page that will now silently 401 every call: save
        // where they were and let ProtectedRoute bounce them to /login.
        saveRestoreSnapshot('auth_state_signed_out_externally');
        clearSessionRegistration();
      }
      weInitiatedSignOutRef.current = false;

      setSession(newSession);
      prevSessionRef.current = newSession;
      await loadEmployee(newSession?.user?.id);

      if (event === 'SIGNED_IN' && newSession) {
        await ensureSessionRegistered();
      }
    });

    return () => listener.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- load per-role session policy (with hardcoded fallback) -------------
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const { data, error } = await supabase.from('session_policy').select('role, max_lifetime_minutes');
        if (!error && data) {
          const map = {};
          data.forEach((r) => { map[r.role] = r.max_lifetime_minutes; });
          setRoleLifetimeMap(map);
        }
      } catch (e) {
        // Table not migrated yet -- fall back to hardcoded values below.
      }
    })();
  }, [session]);

  // --- meaningful-activity tracking (clicks, submits, keystrokes, nav) ----
  useEffect(() => {
    if (!session || !sessionId) return;

    const handleActivity = (ts) => {
      lastActivityAtRef.current = ts;
      setSessionWarning((prev) => (prev.visible ? { visible: false, secondsLeft: 0 } : prev));

      if (ts - lastServerTouchRef.current >= ACTIVITY_TOUCH_THROTTLE_MS) {
        lastServerTouchRef.current = ts;
        supabase.rpc('touch_session', { p_session_id: sessionIdRef.current })
          .then(({ data, error }) => {
            const row = Array.isArray(data) ? data[0] : data;
            if (!error && row && !row.valid) {
              forceSignOut(row.revoked ? 'session_revoked' : 'inactivity_timeout');
            }
          })
          .catch(() => {});
      }
    };

    return startActivityTracking(handleActivity);
  }, [session, sessionId, forceSignOut]);

  // Route navigation counts as activity too.
  useEffect(() => {
    if (session && sessionId) recordActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // --- local sliding-expiry countdown + warning modal ----------------------
  useEffect(() => {
    if (!session || !sessionId || !employee) return;

    const lifetimeMinutes =
      roleLifetimeMap[employee.role] ??
      FALLBACK_ROLE_LIFETIME_MINUTES[employee.role] ??
      FALLBACK_ROLE_LIFETIME_MINUTES.plumber;
    const lifetimeMs = lifetimeMinutes * 60 * 1000;

    const tick = () => {
      const remaining = lastActivityAtRef.current + lifetimeMs - Date.now();
      if (remaining <= 0) {
        forceSignOut('inactivity_timeout');
        return;
      }
      if (remaining <= WARNING_LEAD_SECONDS * 1000) {
        setSessionWarning({ visible: true, secondsLeft: Math.ceil(remaining / 1000) });
      } else {
        setSessionWarning((prev) => (prev.visible ? { visible: false, secondsLeft: 0 } : prev));
      }
    };

    tick();
    const interval = setInterval(tick, WARNING_TICK_MS);
    return () => clearInterval(interval);
  }, [session, sessionId, employee, roleLifetimeMap, forceSignOut]);

  // --- backstop poll for server-side revocation (owner revoke, sign-out-
  // everywhere from another device/tab). Plain SELECT, not a touch --
  // must never itself count as activity or it'd defeat the inactivity
  // timeout by resetting the clock on a timer regardless of real use. ----
  useEffect(() => {
    if (!session || !sessionId) return;
    const poll = async () => {
      try {
        const { data, error } = await supabase
          .from('user_sessions')
          .select('revoked_at')
          .eq('id', sessionId)
          .single();
        if (!error && data?.revoked_at) forceSignOut('session_revoked');
      } catch (e) {
        // ignore -- next poll or the realtime channel will catch it
      }
    };
    const interval = setInterval(poll, BACKSTOP_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session, sessionId, forceSignOut]);

  // --- realtime push for near-instant revocation, poll above is the
  // fallback if this channel is ever dropped -------------------------------
  useEffect(() => {
    if (!session || !sessionId) return;
    let channel;
    try {
      channel = supabase
        .channel(`user_sessions_self_${sessionId}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'user_sessions', filter: `id=eq.${sessionId}` },
          (payload) => {
            if (payload.new?.revoked_at) forceSignOut('session_revoked');
          }
        )
        .subscribe();
    } catch (e) {
      // Realtime not reachable (offline, table not published yet) -- the
      // backstop poll above still covers revocation, just less instantly.
    }
    return () => { if (channel) supabase.removeChannel(channel); };
  }, [session, sessionId, forceSignOut]);

  const extendSession = useCallback(async () => {
    if (!sessionIdRef.current) {
      setSessionWarning({ visible: false, secondsLeft: 0 });
      lastActivityAtRef.current = Date.now();
      return;
    }
    lastActivityAtRef.current = Date.now();
    lastServerTouchRef.current = Date.now();
    setSessionWarning({ visible: false, secondsLeft: 0 });
    try {
      const { data, error } = await supabase.rpc('touch_session', { p_session_id: sessionIdRef.current });
      const row = Array.isArray(data) ? data[0] : data;
      if (!error && row && !row.valid) {
        forceSignOut(row.revoked ? 'session_revoked' : 'inactivity_timeout');
      }
    } catch (e) {
      // best-effort; local countdown was already reset above
    }
  }, [forceSignOut]);

  const signOut = useCallback(async () => {
    weInitiatedSignOutRef.current = true;
    if (sessionIdRef.current) {
      try {
        await supabase.rpc('revoke_session', { p_session_id: sessionIdRef.current, p_reason: 'user_sign_out' });
      } catch (e) {
        // proceed with sign-out regardless
      }
    }
    clearSessionRegistration();
    await supabase.auth.signOut();
    setSession(null);
    setEmployee(null);
  }, []);

  // The revocation endpoint: self-callable (e.g. "sign out everywhere"
  // button, or after a password change) and owner-callable against any
  // employee in their own company (suspicious-activity flag, manual admin
  // action). See sign_out_everywhere() in supabase_session_hardening.sql.
  //
  // BUGFIX (2026-08-09): sign_out_everywhere() on the server treats a
  // null/omitted target, OR a target that resolves to the caller's own
  // user id, as "wipe every one of MY OWN sessions" -- and that includes
  // the very session this tab is using. Before this fix, calling this from
  // the client (e.g. an owner clicking "Sign out everywhere" on one of
  // their OWN other devices in SessionRegistry.jsx) would silently revoke
  // the caller's current session server-side too, but this tab had no idea
  // until the next backstop poll or realtime event caught up -- up to
  // BACKSTOP_POLL_INTERVAL_MS of the UI looking "still logged in" while
  // actually already revoked. Detect the self-targeting case and clean up
  // locally right away instead of waiting on the poll/realtime fallback.
  const signOutEverywhere = useCallback(async (targetUserId) => {
    const { data, error } = await supabase.rpc(
      'sign_out_everywhere',
      targetUserId ? { p_target_user_id: targetUserId } : {}
    );
    if (error) throw error;

    const targetsSelf = !targetUserId || targetUserId === session?.user?.id;
    if (targetsSelf) {
      weInitiatedSignOutRef.current = true;
      clearSessionRegistration();
      await supabase.auth.signOut();
      setSession(null);
      setEmployee(null);
    }

    return data;
  }, [session]);

  // Ready for a future "change password" UI -- none exists in the app yet.
  // Revokes every session (including this one) so the new password is
  // required everywhere, then signs this device out too.
  const changePasswordAndSignOutEverywhere = useCallback(async (newPassword) => {
    const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword });
    if (updateErr) throw updateErr;
    try {
      await supabase.rpc('sign_out_everywhere', {});
    } catch (e) {
      // continue to local sign-out regardless
    }
    await signOut();
  }, [signOut]);

  // Lets a page opt into having its in-progress form data included in the
  // pre-expiry/pre-logout snapshot so it can be restored after re-auth.
  // No current authenticated page has a form worth snapshotting (Dashboard
  // is a stub), so nothing calls this yet -- it's here so the next form
  // that's added behind ProtectedRoute can use it in one line.
  const registerFormSnapshot = useCallback((getterFn) => {
    formSnapshotGetterRef.current = getterFn;
    return () => { formSnapshotGetterRef.current = null; };
  }, []);

  // Called by Login.jsx after a successful sign-in to find out whether to
  // redirect to /dashboard (default) or back to where the user was.
  const consumeRestoreSnapshot = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(RESTORE_SNAPSHOT_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(RESTORE_SNAPSHOT_KEY);
      const snapshot = JSON.parse(raw);
      if (Date.now() - snapshot.savedAt > RESTORE_SNAPSHOT_MAX_AGE_MS) return null;
      return snapshot;
    } catch (e) {
      return null;
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        employee,
        loading,
        signOut,
        signOutEverywhere,
        changePasswordAndSignOutEverywhere,
        sessionId,
        sessionWarning,
        extendSession,
        registerFormSnapshot,
        consumeRestoreSnapshot,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
