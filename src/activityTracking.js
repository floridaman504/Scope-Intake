// Tracks *meaningful* user activity for session sliding-expiry purposes --
// explicitly not raw mouse movement or passive tab presence, per the
// hardening playbook. "Meaningful" here means: clicks, form submits, real
// keystrokes, and route navigation. API calls that mutate/read data can
// also count -- call `recordActivity()` directly from a data-fetching call
// site (see Join.jsx's redeem_invite_code call for an example) to treat a
// successful API call as activity even if it wasn't preceded by a click
// this tick (e.g. a programmatic retry).
//
// This is a plain module, not a React hook, because AuthProvider is the
// single owner of "when did the user last do something" and multiple
// components would otherwise fight over duplicate listeners.

let listeners = [];

export function recordActivity() {
  const now = Date.now();
  for (const cb of listeners) cb(now);
}

// Attaches DOM listeners for meaningful activity and returns a cleanup
// function. `onActivity(timestampMs)` fires on every qualifying event --
// callers are expected to throttle expensive work (server touch calls)
// themselves, since this fires on every click/keystroke.
export function startActivityTracking(onActivity) {
  listeners.push(onActivity);

  const handleClick = () => recordActivity();
  const handleSubmit = () => recordActivity();
  const handleKeydown = (e) => {
    // Ignore bare modifier presses (Shift, Control, Alt, Meta) with no
    // accompanying key -- those aren't "doing something," they're often
    // just a user resting a finger or a screen reader probing focus.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    recordActivity();
  };
  // popstate covers back/forward nav; pushState/replaceState (React
  // Router's normal in-app navigation) is covered separately by having
  // AuthProvider call recordActivity() on location change (see
  // AuthContext.jsx's useEffect on `location`).
  const handlePopstate = () => recordActivity();

  document.addEventListener('click', handleClick, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('popstate', handlePopstate);

  return () => {
    listeners = listeners.filter((cb) => cb !== onActivity);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('submit', handleSubmit, true);
    document.removeEventListener('keydown', handleKeydown, true);
    window.removeEventListener('popstate', handlePopstate);
  };
}
