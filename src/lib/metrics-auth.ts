import { timingSafeEqual } from "node:crypto";

/**
 * Node-only helpers for guarding the metrics scrape endpoint.
 *
 * This module deliberately lives apart from `@/lib/metrics` (which is also
 * reachable from the Edge Runtime via `src/instrumentation.ts`) so `node:crypto`
 * is never pulled into an Edge bundle. Only the Node runtime route handler
 * (`src/app/api/metrics/route.ts`) imports this file.
 */

/** Static bearer token required to scrape /api/metrics (env overridable). */
export function metricsAccessToken(): string {
  return process.env.METRICS_TOKEN ?? process.env.METRICS_BEARER_TOKEN ?? "";
}

/** Constant-time compare to avoid timing attacks on the metrics token. */
export function safeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}