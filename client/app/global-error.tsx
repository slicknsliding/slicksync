'use client';

// The last resort: an error thrown in the root layout itself, where even
// the app's stylesheet and theme are gone. Deliberately self-contained -
// plain markup and inline colours, no imports beyond React.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#050308', color: '#e8e6ef', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>SlickSync could not start this page</h2>
            <p style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>
              Trying again usually clears it. If it keeps happening, the server log will say why.
            </p>
            {error?.message && (
              <p style={{ fontSize: 12, opacity: 0.55, marginTop: 12, wordBreak: 'break-word' }}>{error.message}</p>
            )}
            <button
              onClick={reset}
              style={{ marginTop: 20, padding: '8px 16px', borderRadius: 8, border: 0, background: '#7c5cff', color: '#fff', fontSize: 14, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
