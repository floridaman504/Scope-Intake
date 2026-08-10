// Shared color palette for the dispatcher-facing pages (JobsQueue, and the
// new JobAssignment/JobNotes components split out alongside it). Pulled out
// of JobsQueue.jsx instead of re-typing the same hex values in three files --
// purely a readability/consistency win, no behavior change. Dashboard.jsx
// and the public ScopeIntake.jsx pages are untouched and keep their own
// inline styles for now; this isn't a full design-system migration, just
// enough shared ground for the dispatcher-dashboard build (task #41/#42).
export const colors = {
  bg: '#0A0A0A',
  panel: '#161616',
  panelAlt: '#1A1A1A',
  border: '#2A2A2A',
  borderLight: '#333333',
  text: '#EDEAE3',
  textBright: '#FFFFFF',
  muted: '#C4C4C4',
  faint: '#9A9A9A',
  gold: '#C9A227',
  goldBright: '#E8BD3A',
  danger: '#E07A6E',
  dangerBg: '#221414',
  dangerBorder: '#4A1F1A',
  success: '#7DA888',
  successBg: '#142018',
  successBorder: '#1F3026',
  info: '#6EA8D8',
  infoBg: '#12202E',
  infoBorder: '#1B3A52',
};

export const fontHead = { fontFamily: 'Oswald, sans-serif' };

export const STATUS_LABELS = {
  new: 'New',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const STATUS_ORDER = ['new', 'assigned', 'in_progress', 'done', 'cancelled'];
