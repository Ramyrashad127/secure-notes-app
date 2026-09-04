import { db } from "@/db";
import { auditEvents } from "@/db/schema";

const SENSITIVE_KEYS = new Set([
  "password",
  "content",
  "secret",
  "recoveryCode",
  "totpCode",
  "twoFactorSecret",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** Recursively remove sensitive keys from an object at any nesting level. */
export function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) continue;
      result[key] = sanitizePayload(val);
    }
    return result;
  }
  return value;
}

export interface AuditServiceDeps {
  insert: (input: {
    userId: string | null;
    eventType: string;
    payload: string;
  }) => Promise<unknown>;
}

/** Injected audit sink for services; matches logAuditEvent minus the deps arg. */
export type AuditLogger = (
  userId: string | null,
  eventType: string,
  payload?: Record<string, unknown>,
) => void;

const defaultDeps: AuditServiceDeps = {
  async insert(input) {
    await db.insert(auditEvents).values({
      userId: input.userId ?? null,
      action: input.eventType,
      entityType: "system",
      entityId: null,
      metadata: JSON.parse(input.payload),
      ipAddress: null,
      userAgent: null,
    });
  },
};

/**
 * Record an audit event. Sensitive keys are stripped from the payload at any
 * nesting level before it is stringified and inserted. The database call is
 * wrapped in a try/catch so a failure never crashes the primary request.
 */
export async function logAuditEvent(
  userId: string | null,
  eventType: string,
  payload: Record<string, unknown> = {},
  deps: AuditServiceDeps = defaultDeps,
): Promise<void> {
  const sanitized = sanitizePayload(payload);
  try {
    await deps.insert({
      userId,
      eventType,
      payload: JSON.stringify(sanitized),
    });
  } catch (error) {
    console.error("Failed to record audit event", error);
  }
}