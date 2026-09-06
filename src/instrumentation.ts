import { type Instrumentation } from "next";

export function register() {
  // No-op: the metrics registry is initialized lazily by the app entry
  // (src/lib/metrics). Nothing here touches Node-only modules so the Edge
  // bundle of this file compiles cleanly.
}

/**
 * Connection-level failures that indicate the *client* went away mid-request
 * (timeout, cancel, dropped connection) rather than an application fault.
 * The Next.js dev server surfaces these as `Error: aborted` / "destination
 * stream closed early". Counting them as 5xx pollutes the HTTP error-rate
 * Golden Signal, so we filter them out before recording.
 */
const CLIENT_ABORT_PATTERNS: RegExp[] = [
  /\baborted\b/i,
  /destination stream closed early/i,
  /stream closed early/i,
  /connection (?:closed|reset|aborted)/i,
  /\bECONNRESET\b/i,
  /\bclient (?:closed|disconnected|cancelled)/i,
  /operation cancelled/i,
];

export function isClientAbortError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  return CLIENT_ABORT_PATTERNS.some((pattern) => pattern.test(message));
}

export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  void context;

  // `src/lib/metrics` registers prom-client collectors and reads process
  // internals, so it must only be loaded in the Node.js runtime. The dynamic
  // import keeps it out of the Edge bundle entirely (Edge just no-ops).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // A client that disconnected is not a server fault; skip so we don't
  // inflate the HTTP error rate during load / flaky-network conditions.
  if (isClientAbortError(err)) return;

  try {
    const { normalizeHttpRoute, recordHttpError } = await import("@/lib/metrics");
    recordHttpError(
      request.method.toUpperCase(),
      normalizeHttpRoute(request.path.split("?")[0] ?? "/"),
      500,
    );
  } catch {
    // Instrumentation must never break request handling.
  }
};