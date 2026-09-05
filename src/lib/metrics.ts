import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import * as client from "@prometheus-io/client";

declare global {
  var __secureNotesMetrics: SecureNotesMetrics | undefined;
  var __secureNotesRegistry: client.Registry | undefined;
}

export interface SecureNotesMetrics {
  httpRequestDuration: client.Histogram<"method" | "route" | "status">;
  httpRequestsTotal: client.Counter<"method" | "route" | "status_class">;
  httpErrorsTotal: client.Counter<"method" | "route" | "status_class">;
  authEvents: client.Counter<"type" | "status" | "reason">;
  noteOperations: client.Counter<"operation">;
  cacheOperations: client.Counter<"result">;
  dbQueryDuration: client.Histogram<"statement" | "status">;
  dbQueriesTotal: client.Counter<"statement" | "status">;
  dbQueriesInFlight: client.Gauge<"statement">;
  dbActiveConnections: client.Gauge;
}

function createMetrics(): SecureNotesMetrics {
  client.collectDefaultMetrics();

  const httpRequestDuration = new client.Histogram<"method" | "route" | "status">({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2.5, 5, 10],
  });

  const httpRequestsTotal = new client.Counter<"method" | "route" | "status_class">({
    name: "http_requests_total",
    help: "Total HTTP requests by method, route, and status class",
    labelNames: ["method", "route", "status_class"],
  });

  const httpErrorsTotal = new client.Counter<"method" | "route" | "status_class">({
    name: "http_errors_total",
    help: "Total HTTP requests that produced a 4xx or 5xx response",
    labelNames: ["method", "route", "status_class"],
  });

  const authEvents = new client.Counter<"type" | "status" | "reason">({
    name: "auth_events_total",
    help: "Total authentication events (logins and 2FA)",
    labelNames: ["type", "status", "reason"],
  });

  const noteOperations = new client.Counter<"operation">({
    name: "note_operations_total",
    help: "Total note operations (creates, updates, autosaves)",
    labelNames: ["operation"],
  });

  const cacheOperations = new client.Counter<"result">({
    name: "cache_operations_total",
    help: "Total Valkey cache operations by result",
    labelNames: ["result"],
  });

  const dbQueryDuration = new client.Histogram<"statement" | "status">({
    name: "db_query_duration_seconds",
    help: "Duration of PostgreSQL queries in seconds",
    labelNames: ["statement", "status"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  });

  const dbQueriesTotal = new client.Counter<"statement" | "status">({
    name: "db_queries_total",
    help: "Total PostgreSQL queries by statement type and status",
    labelNames: ["statement", "status"],
  });

  const dbQueriesInFlight = new client.Gauge<"statement">({
    name: "db_queries_in_flight",
    help: "Number of PostgreSQL queries currently in flight",
    labelNames: ["statement"],
  });

  const dbActiveConnections = new client.Gauge({
    name: "db_active_connections",
    help: "Number of active PostgreSQL connections (from pg_stat_activity)",
    collect: async function collectActiveConnections(this: client.Gauge) {
      try {
        const { db } = await import("@/db");
        const rows = await db.execute(sql`
          select count(*)::int as active
          from pg_stat_activity
          where state = 'active'
        `);
        this.set(Number((rows[0] as { active?: number })?.active ?? 0));
      } catch (err) {
        console.error("[METRICS_ERROR]", err);
      }
    },
  });

  return {
    httpRequestDuration,
    httpRequestsTotal,
    httpErrorsTotal,
    authEvents,
    noteOperations,
    cacheOperations,
    dbQueryDuration,
    dbQueriesTotal,
    dbQueriesInFlight,
    dbActiveConnections,
  };
}

const metrics = (globalThis.__secureNotesMetrics ??= createMetrics());

export const registry = (globalThis.__secureNotesRegistry ??= client.register);

export const {
  httpRequestDuration,
  httpRequestsTotal,
  httpErrorsTotal,
  authEvents,
  noteOperations,
  cacheOperations,
  dbQueryDuration,
  dbQueriesTotal,
  dbQueriesInFlight,
  dbActiveConnections,
} = metrics;

export type AuthFailureReason =
  | "invalid_credentials"
  | "invalid_code"
  | "invalid_recovery_code"
  | "invalid_password";

export type AuthEventLabels = {
  type: "login" | "2fa";
  status: "success" | "failure";
  reason: AuthFailureReason | "";
};

export type NoteOperationLabel =
  | "create"
  | "delete"
  | "update"
  | "autosave"
  | "autosave_skipped"
  | "autosave_failure";

export type DbStatement = "select" | "insert" | "update" | "delete" | "other";

export type HttpRequestLabels = {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
};

/** Run a metric write that must never break the request flow; logs on failure. */
export function safeRecord(record: () => void): void {
  try {
    record();
  } catch (err) {
    console.error("[METRICS_ERROR]", err);
  }
}

export function recordAuthEvent(labels: AuthEventLabels): void {
  safeRecord(() => authEvents.inc(labels));
}

export function recordNoteOperation(operation: NoteOperationLabel): void {
  safeRecord(() => noteOperations.inc({ operation }));
}

export function recordCacheOperation(result: "hit" | "miss"): void {
  safeRecord(() => cacheOperations.inc({ result }));
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

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

export function classifyStatus(status: number): string {
  return statusClass(status);
}

/** Replace dynamic segments (UUIDs, numeric ids) with :id for cardinality safety. */
export function normalizeHttpRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const normalized = pathname
    .split("/")
    .map((segment) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment);
      const isNumeric = /^\d+$/.test(segment);
      return isUuid || isNumeric ? ":id" : segment;
    })
    .join("/");
  return normalized === "" ? "/" : normalized;
}

export function recordHttpRequest(labels: HttpRequestLabels): void {
  const statusClass = classifyStatus(labels.status);
  safeRecord(() => {
    httpRequestDuration.observe(
      { method: labels.method, route: labels.route, status: String(labels.status) },
      labels.durationSeconds,
    );
    httpRequestsTotal.inc({
      method: labels.method,
      route: labels.route,
      status_class: statusClass,
    });
    if (labels.status >= 400) {
      httpErrorsTotal.inc({
        method: labels.method,
        route: labels.route,
        status_class: statusClass,
      });
    }
  });
}

export function recordHttpError(method: string, route: string, status: number): void {
  const statusClass = classifyStatus(status);
  safeRecord(() => {
    httpErrorsTotal.inc({ method, route, status_class: statusClass });
  });
}

export function recordDbQuery(
  statement: DbStatement,
  status: "success" | "error",
  durationSeconds: number,
): void {
  safeRecord(() => {
    dbQueryDuration.observe({ statement, status }, durationSeconds);
    dbQueriesTotal.inc({ statement, status });
  });
}

export function incDbQueriesInFlight(statement: DbStatement): void {
  safeRecord(() => dbQueriesInFlight.inc({ statement }));
}

export function decDbQueriesInFlight(statement: DbStatement): void {
  safeRecord(() => dbQueriesInFlight.dec({ statement }));
}