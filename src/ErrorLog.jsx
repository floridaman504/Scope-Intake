import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { colors, fontHead } from './theme.js';

// Owner-only error log viewer (Tier 2 #10, "Error Handling Rebuild" --
// docs/migrations/2026-08-16-error-log-pipeline.sql). Every row here was
// written by log_app_error(), a SECURITY DEFINER RPC called from
// src/errorMessages.js, src/ErrorBoundary.jsx, and the two Vercel API
// functions whenever something actually failed -- this page is the "make
// it searchable/filterable by date, route, severity" half of that work
// (the writing half is the migration + those call sites). RLS
// (error_log_select_owner) independently restricts what comes back to the
// caller's own company plus company-less (pre-auth/public) rows, and to
// owners only, regardless of what this component asks for.
const SEVERITY_COLOR = {
  error: colors.danger,
  warning: colors.gold,
  info: colors.info,
};

const DEFAULT_DAYS = 7;

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default function ErrorLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [severity, setSeverity] = useState('all');
  const [routeFilter, setRouteFilter] = useState('');
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // Most-recent-first, capped at 200 -- same review/investigation-tool
    // scope as AuditLog.jsx, not a full export.
    let query = supabase
      .from('error_log')
      .select('id, created_at, severity, source, route, http_method, message, detail')
      .order('created_at', { ascending: false })
      .limit(200)
      .gte('created_at', daysAgoIso(days));
    if (severity !== 'all') {
      query = query.eq('severity', severity);
    }
    if (routeFilter.trim()) {
      query = query.ilike('route', `%${routeFilter.trim()}%`);
    }
    const { data, error: loadErr } = await query;
    if (loadErr) {
      console.error('Could not load error log:', loadErr);
      setError('Could not load the error log. Please try again.');
    } else {
      setRows(data || []);
    }
    setLoading(false);
  }, [severity, routeFilter, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, minHeight: '100vh' }}
      className="font-sans p-4 sm:p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: colors.gold }} className="w-2 h-2 rounded-full" />
          <span style={{ ...fontHead }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <Link to="/dashboard" style={{ color: colors.muted }} className="text-sm py-2">Back to dashboard</Link>
      </div>

      <h1 style={{ ...fontHead, color: colors.textBright }} className="text-2xl font-bold mb-1">Error Log</h1>
      <p style={{ color: colors.muted }} className="text-sm mb-5">
        Every failure the app caught -- on the public intake form, the AI review step, the missed-lead alert job, and inside the dispatcher/owner screens -- with what actually went wrong, not just the friendly message customers and employees saw.
      </p>

      <div className="flex flex-wrap items-end gap-3 mb-5">
        <label className="text-xs">
          <span style={{ color: colors.faint }} className="block mb-1">Severity</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}`, color: colors.text }}
            className="rounded-md px-3 py-2 text-sm"
          >
            <option value="all">All</option>
            <option value="error">Error</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label className="text-xs">
          <span style={{ color: colors.faint }} className="block mb-1">Route contains</span>
          <input
            type="text"
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
            placeholder="e.g. /api/review-job"
            style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}`, color: colors.text }}
            className="rounded-md px-3 py-2 text-sm w-48"
          />
        </label>
        <label className="text-xs">
          <span style={{ color: colors.faint }} className="block mb-1">Since</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}`, color: colors.text }}
            className="rounded-md px-3 py-2 text-sm"
          >
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>

      {error && <p style={{ color: colors.danger }} className="text-sm mb-4">{error}</p>}

      {loading ? (
        <p style={{ color: colors.muted }} className="text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: colors.muted }} className="text-sm">No errors match these filters.</p>
      ) : (
        <div className="space-y-2 max-w-2xl">
          {rows.map((row) => {
            const isExpanded = expandedId === row.id;
            return (
              <div
                key={row.id}
                style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}` }}
                className="rounded-lg p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <span style={{ color: SEVERITY_COLOR[row.severity] || colors.text }} className="text-xs font-semibold uppercase tracking-wide">
                    {row.severity}
                  </span>
                  <span style={{ color: colors.faint }} className="text-xs shrink-0">
                    {new Date(row.created_at).toLocaleString()}
                  </span>
                </div>
                <p style={{ color: colors.text }} className="text-sm mt-1">{row.message}</p>
                <p style={{ color: colors.faint }} className="text-xs mt-1">
                  {row.source}
                  {row.route && <span> · {row.route}</span>}
                  {row.http_method && <span> · {row.http_method}</span>}
                </p>
                {row.detail && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : row.id)}
                    style={{ color: colors.gold }}
                    className="text-xs mt-2"
                  >
                    {isExpanded ? 'Hide details' : 'Show details'}
                  </button>
                )}
                {isExpanded && row.detail && (
                  <pre
                    style={{ backgroundColor: colors.bg, color: colors.faint, border: `1px solid ${colors.border}` }}
                    className="text-xs mt-2 p-3 rounded-md overflow-x-auto whitespace-pre-wrap break-words"
                  >
                    {row.detail}
                  </pre>
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
