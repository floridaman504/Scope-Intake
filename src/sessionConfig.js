// Fallback session policy, used only if the `session_policy` table can't be
// reached (offline, RLS misconfigured, etc.) so the app fails toward a safe
// default instead of failing open. The source of truth is the DB table --
// see supabase_session_hardening.sql -- which Dante can edit directly
// without a redeploy.
export const FALLBACK_ROLE_LIFETIME_MINUTES = {
  owner: 120,
  dispatcher: 1440,
  plumber: 1440,
};

// How long before expiry to show the "still there?" warning modal.
export const WARNING_LEAD_SECONDS = 60;

// Real user activity is throttled to at most one server touch_session()
// call per this many ms, so a burst of clicks doesn't hammer the DB.
export const ACTIVITY_TOUCH_THROTTLE_MS = 20_000;

// Backstop poll interval for revocation / expiry, used alongside the
// realtime subscription in case the realtime channel drops (backgrounded
// tab, network blip, free-tier connection limit momentarily hit, etc).
export const BACKSTOP_POLL_INTERVAL_MS = 30_000;

// Local countdown tick while the warning modal is showing.
export const WARNING_TICK_MS = 1_000;

// sessionStorage key for the pre-expiry snapshot (the path to return to)
// that Login.jsx reads after re-auth to restore where the user was.
export const RESTORE_SNAPSHOT_KEY = 'scope_session_restore_snapshot';

// How old a snapshot can be before we stop trying to restore to it (avoids
// bouncing someone back into a stale workflow hours later).
export const RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

// Very small, best-effort device/browser label parsed from the user agent
// string -- good enough for "which of my devices is this," not a full UA
// parser library. Falls back to a generic label rather than throwing on an
// unrecognized string.
export function parseDeviceLabel(userAgent) {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const isMobile = /Mobi|Android/i.test(ua);
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  return `${browser} on ${os}${isMobile ? ' (mobile)' : ''}`;
}
