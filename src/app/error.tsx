"use client";

import { useEffect } from "react";

/**
 * Root-level error boundary for route segments.
 *
 * Next.js wraps every page (and nested layout/loading/not-found) in a React
 * Error Boundary backed by this component. When an unhandled runtime error
 * is thrown while rendering a server component, this fallback UI is shown
 * instead of an empty/broken page shell.
 *
 * - `error.message` is deliberately generic in production; use `error.digest`
 *   to correlate with server-side logs.
 * - `reset()` clears the error state and re-renders the boundary's children
 *   without re-fetching; `retry()` re-fetches. The ticket asks for `reset()`.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[PAGE_ERROR]", error);
  }, [error]);

  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
    >
      <h2 className="text-xl font-semibold text-foreground">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error occurred while rendering this page. Your data is
        safe — please try again. If the problem persists, reload the page.
      </p>
      {error.digest ? (
        <p className="text-xs font-mono text-muted-foreground">
          Reference: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}