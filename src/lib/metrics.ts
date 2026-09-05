import * as client from "@prometheus-io/client";

declare global {
  var __secureNotesMetrics: SecureNotesMetrics | undefined;
}

export interface SecureNotesMetrics {
  httpRequestDuration: client.Histogram<"method" | "route" | "status">;
  authEvents: client.Counter<"type" | "status">;
  noteOperations: client.Counter<"operation">;
  cacheOperations: client.Counter<"result">;
}

function createMetrics(): SecureNotesMetrics {
  client.collectDefaultMetrics();

  const httpRequestDuration = new client.Histogram<"method" | "route" | "status">({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2.5, 5, 10],
  });

  const authEvents = new client.Counter<"type" | "status">({
    name: "auth_events_total",
    help: "Total authentication events (logins and 2FA)",
    labelNames: ["type", "status"],
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

  return { httpRequestDuration, authEvents, noteOperations, cacheOperations };
}

const metrics = (globalThis.__secureNotesMetrics ??= createMetrics());

export const { httpRequestDuration, authEvents, noteOperations, cacheOperations } = metrics;

export type AuthEventLabels = {
  type: "login" | "2fa";
  status: "success" | "failure";
};

export type NoteOperationLabel =
  | "create"
  | "delete"
  | "update"
  | "autosave"
  | "autosave_skipped";

export function recordAuthEvent(labels: AuthEventLabels): void {
  try {
    authEvents.inc(labels);
  } catch {
    // no-op: instrumentation must never break the request flow
  }
}

export function recordNoteOperation(operation: NoteOperationLabel): void {
  try {
    noteOperations.inc({ operation });
  } catch {
    // no-op: instrumentation must never break the request flow
  }
}

export function recordCacheOperation(result: "hit" | "miss"): void {
  try {
    cacheOperations.inc({ result });
  } catch {
    // no-op: instrumentation must never break the request flow
  }
}