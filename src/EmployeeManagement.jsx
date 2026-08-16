import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from './supabaseClient.js';
import { useAuth } from './AuthContext.jsx';
import { colors, fontHead } from './theme.js';

// Owner-only employee list + deactivate/reactivate. Priority 1b (database
// audit): there was no employee-removal flow at all before this, and no
// ON DELETE behavior defined on the FKs that reference employees
// (employees_company_id_fkey, invite_codes_created_by_fkey/used_by_fkey,
// jobs_claimed_by_fkey) -- a hard delete would just fail against existing
// history. Deactivation (employees.deactivated_at, added in
// docs/migrations/2026-08-12-employee-deactivation-and-email-constraint.sql)
// sidesteps that entirely: history stays intact and correctly attributed,
// the employee just loses access. Enforcement is server-side
// (get_my_company_id()/get_my_role() return NULL for a deactivated
// employee, so every RLS-gated table denies them regardless of this UI) --
// this page is the control surface, not the actual gate.
export default function EmployeeManagement() {
  const { employee: me } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    const { data, error: loadErr } = await supabase
      .from('employees')
      .select('id, full_name, email, role, deactivated_at')
      .order('full_name', { ascending: true });
    if (loadErr) {
      setError('Could not load employees: ' + loadErr.message);
    } else {
      setEmployees(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (emp) => {
    const activating = Boolean(emp.deactivated_at);
    const label = emp.full_name || emp.email;
    const confirmed = window.confirm(
      activating
        ? `Reactivate ${label}? They'll be able to log in again immediately.`
        : `Deactivate ${label}? They won't be able to log in, but their job history, notes, and invite codes stay exactly as they are -- this isn't a punitive record, just an access change.`
    );
    if (!confirmed) return;

    setBusyId(emp.id);
    setError('');
    const { error: updateErr } = await supabase
      .from('employees')
      .update({ deactivated_at: activating ? null : new Date().toISOString() })
      .eq('id', emp.id);
    setBusyId(null);
    if (updateErr) {
      setError('Could not update employee: ' + updateErr.message);
      return;
    }
    await load();
  };

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, minHeight: '100vh' }}
      className="font-sans p-4 sm:p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: colors.gold }} className="w-2 h-2 rounded-full" />
          <span style={{ ...fontHead }} className="text-lg font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <div className="flex items-center gap-4">
          <Link to="/audit-log" style={{ color: colors.muted }} className="text-sm py-2">Audit log</Link>
          <Link to="/dashboard" style={{ color: colors.muted }} className="text-sm py-2">Back to dashboard</Link>
        </div>
      </div>

      <h1 style={{ ...fontHead, color: colors.textBright }} className="text-2xl font-bold mb-1">Team</h1>
      <p style={{ color: colors.muted }} className="text-sm mb-5">
        Deactivating someone removes their access -- it doesn't delete their history.
      </p>

      {error && <p style={{ color: colors.danger }} className="text-sm mb-4">{error}</p>}

      {loading ? (
        <p style={{ color: colors.muted }} className="text-sm">Loading…</p>
      ) : employees.length === 0 ? (
        <p style={{ color: colors.muted }} className="text-sm">No employees found.</p>
      ) : (
        <div className="space-y-2 max-w-xl">
          {employees.map((emp) => {
            const isDeactivated = Boolean(emp.deactivated_at);
            return (
              <div
                key={emp.id}
                style={{ backgroundColor: colors.panel, border: `1px solid ${colors.border}` }}
                className="rounded-lg p-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <p style={{ color: colors.text }} className="text-sm font-semibold truncate">
                    {emp.full_name || emp.email}
                    {emp.id === me?.id && <span style={{ color: colors.faint }}> (you)</span>}
                  </p>
                  <p style={{ color: colors.faint }} className="text-xs mt-0.5">
                    {emp.email} · {emp.role}
                    {isDeactivated && (
                      <span style={{ color: colors.danger }}> · Deactivated {new Date(emp.deactivated_at).toLocaleDateString()}</span>
                    )}
                  </p>
                </div>
                {emp.id !== me?.id && (
                  <button
                    onClick={() => toggleActive(emp)}
                    disabled={busyId === emp.id}
                    style={{
                      border: `1px solid ${isDeactivated ? colors.borderLight : colors.dangerBorder}`,
                      color: isDeactivated ? colors.gold : colors.danger,
                    }}
                    className="shrink-0 text-sm font-semibold px-3 py-2 rounded-md"
                  >
                    {busyId === emp.id ? 'Working…' : isDeactivated ? 'Reactivate' : 'Deactivate'}
                  </button>
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
