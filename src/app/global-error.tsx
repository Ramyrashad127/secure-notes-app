"use client";

import { useEffect } from "react";

/**
 * Global error boundary for the ROOT layout.
 *
 * When an error is thrown inside the root layout (or template) itself, the
 * regular error.tsx boundary cannot help because the surrounding shell is
 * what failed. Next.js swaps in this component instead, and it must render
 * its OWN <html>/<body> document (the root layout is replaced while active).
 *
 * Per the Next.js docs, global-error does not receive the app's global
 * styles, so the UI is styled with inline CSS that mirrors the app theme.
 * `reset()` clears the error state and re-renders the root layout children
 * without a full network re-fetch.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GLOBAL_ERROR]", error);
  }, [error]);

  return (
    <html lang="en" data-error-page="true">
      <body>
        <style>{`
          html[data-error-page] {
            min-height: 100%;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background: #121212;
              color: #fbfbfb;
            }
          }
        `}</style>
        <main
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            minHeight: "100vh",
            padding: "2rem 1rem",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
            color: "var(--foreground, #1a1a1a)",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ maxWidth: "32rem", fontSize: "0.95rem", margin: 0 }}>
            The application hit an unexpected error. Your data is safe —
            please try again.
          </p>
          {error.digest ? (
            <p style={{ fontSize: "0.75rem", fontFamily: "monospace" }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: "0.6rem 1.5rem",
              fontSize: "0.95rem",
              fontWeight: 600,
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
              backgroundColor: "var(--primary, #1a1a1a)",
              color: "var(--primary-foreground, #ffffff)",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}