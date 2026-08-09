import React from 'react';

// Catches rendering errors anywhere below it in the component tree and
// shows a recovery screen instead of a blank white page. Logs the error
// for us; the person just sees a friendly reload prompt.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Unhandled error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ backgroundColor: '#0A0A0A', color: '#EDEAE3', minHeight: '100vh' }}
          className="flex items-center justify-center px-6 font-sans">
          <div className="w-full max-w-sm text-center">
            <div className="flex items-center gap-2 mb-8 justify-center">
              <div style={{ backgroundColor: '#C9A227' }} className="w-2 h-2 rounded-full" />
              <span style={{ fontFamily: 'Oswald, sans-serif' }} className="text-xl font-bold tracking-[0.15em]">SCOPE</span>
            </div>
            <h1 style={{ fontFamily: 'Oswald, sans-serif', color: '#FFFFFF' }} className="text-2xl font-bold mb-3">
              Something Went Wrong
            </h1>
            <p style={{ color: '#C4C4C4' }} className="text-sm mb-8">
              This page hit an unexpected error. Reloading usually fixes it.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{ backgroundColor: '#C9A227', color: '#0A0A0A' }}
              className="w-full font-semibold py-3 rounded-md text-sm"
            >
              Reload page
            </button>
          </div>
          <style>{`
            @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Inter:wght@400;500;600&display=swap');
            .font-sans { font-family: 'Inter', sans-serif; }
          `}</style>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
