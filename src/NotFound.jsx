import React from 'react';
import { Link } from 'react-router-dom';

// Catch-all for any unmatched path. Before this existed, a typo'd or
// bookmarked link, or a stale link from an old email/message, rendered a
// completely blank page -- no header, no message, nothing to click. This
// at least tells the person what happened and gives them a way out.
export default function NotFound() {
  return (
    <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
      className="flex items-center justify-center px-6 font-sans">
      <div className="w-full max-w-sm text-center">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
          <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPE</span>
        </div>
        <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-3">
          Page Not Found
        </h1>
        <p style={{ color: '#C4C4C4' }} className="text-sm mb-8">
          That link doesn't lead anywhere. Double-check the address, or head back to somewhere that does.
        </p>
        <Link
          to="/"
          style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
          className="w-full font-semibold py-3 rounded-md text-sm block text-center"
        >
          Go home
        </Link>
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>
    </div>
  );
}
