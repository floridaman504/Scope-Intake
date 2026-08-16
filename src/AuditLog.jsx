import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { colors, fontHead } from './theme.js';

// Owner-only audit log viewer (Tier 2 #9.5, docs/scope-operational-playbook.md:
// "for every action that modifies permissions, billing, email, password, or
// deletes data, log who/when/from what IP/what changed"). This page is just
// the read side -- every row here was written by a database trigger or a
// narrow SECURITY DEFINER RPC (see docs/migrations/2026-08-16-audit-trail.sql),
// never by this app's client code directly, so nothing rendered here can be
// forged or edited after the fact by anyone, owner included. RLS
// (audit_log_select_owner_company) independently restricts the select below
// to the caller's own company regardless of what this component asks for.
const ACTION_LABELS = {
  employee_role_assigned: 'Role assigned',
  employee_role_changed: 'Role changed',
  employee_deactivated: 'Employee deactivated',
  employee_reactivated: 'Employee reactivated',
  job_deleted: 'Job deleted',
  password_reset: 'Password reset',
};

const ACTION_COLOR = {
  employee_deactivated: colors.danger,
  job_deleted: colors.danger,
  employee_role_changed: colors.gold,
  employee_role_assigned: colors.gold,
  employee_reactivated: colors.success,
  password_reset: colors.info,
};

function describeDetails(row) {
  const d = row.details;
  if (!d) return null;
  if (row.action === 'employee_role_assigned') return `Assigned role: ${d.role}`;
  if (row.action === 'employee_role_changed') return `${d.old_role} → ${d.new_role}`;
  if (row.action === 'job_deleted') return d.customer_name ? `Customer: ${d.customer_name}` : null;
  return null;
}

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // Most-recent-first, capped at 200 -- this is a review/investigation
    // tool, not a full export. If a real compliance need for older history
    // or CSV export comes up, that's a follow-on, not a reason to hold this
    // back today.
    const { data, error: loadErr } = await supabase
      .from('audit_log')
      .select('id, action, actor_label, target_table, target_label, details, ip_address, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (loadErr) {
      setError('Could not load the audit log: ' + loadErr.message);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  }, []);

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

      <h1 style={{ ...fontHead, color: colors.textBright }} className="text-2xl font-bold mb-1">Audit Log</h1>
      <p style={{ color: colors.muted }} className="text-sm mb-5">
        Every deactivation, role change, password reset, and job deletion in your company, with who did it and when. Written automatically by the database itself -- nobody, owner included, can edit or delete an entry here.
      </p>

      {error && <p style={{ color: colors.danger }} className="text-sm mb-4">{error}</p>}

      {loading ? (
        <p style={{ color: colors.muted }} className="text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: colors.muted }} className="text-sm">No sensitive actions recorded yet.</p>
      ) : (
        <div className="space-y-2 max-w-2xl">
          {rows.map((row) => {
            const detail = describeDetails(row);
            return (
              <div
                key={row.id}
                style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}` }}
                className="rounded-lg p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <span style={{ color: ACTION_COLOR[row.action] || colors.text }} className="text-sm font-semibold">
                    {ACTION_LABELS[row.action] || row.action}
                  </span>
                  <span style={{ color: colors.faint }} className="text-xs shrink-0">
                    {new Date(row.created_at).toLocaleString()}
                  </span>
                </div>
                <p style={{ color: colors.text }} className="text-sm mt-1">
                  {row.actor_label || 'Unknown actor'}
                  {row.target_label && <span style={{ color: colors.faint }}> · {row.target_label}</span>}
                </p>
                {detail && (
                  <p style={{ color: colors.faint }} className="text-xs mt-1">{detail}</p>
                )}
                {row.ip_address && (
                  <p style={{ color: colors.faint }} className="text-xs mt-1">IP: {row.ip_address}</p>
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
