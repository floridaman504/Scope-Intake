import React from 'react';
import { useAuth } from './AuthContext.jsx';

export default function Dashboard() {
  const { employee, signOut } = useAuth();

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
      <p style={{ color: '#9A9A9A' }} className="text-sm mb-1">
        Name: {employee?.full_name || '—'}
      </p>
      <p style={{ color: '#9A9A9A' }} className="text-sm mb-6">
        Role: <span style={{ color: '#C9A227' }}>{employee?.role || '—'}</span>
      </p>

      <button
        onClick={signOut}
        style={{ border: '1px solid #2A2A2A', color: '#C8C8C8' }}
        className="text-sm px-4 py-2 rounded-md"
      >
        Sign Out
      </button>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
