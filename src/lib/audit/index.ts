import { db } from "@/db";
import { auditEvents } from "@/db/schema";

export interface AuditEventInput {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType ?? "",
      entityId: input.entityId ?? null,
      metadata: input.metadata,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  } catch (error) {
    console.error("Failed to record audit event", error);
  }
}

export function audit(input: AuditEventInput): void {
  void recordAuditEvent(input);
}