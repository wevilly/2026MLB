import { pool } from "@workspace/db";

export type AuditEventInput = {
  actor?: string | null;
  requestId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordAuditEvent(input: AuditEventInput) {
  await pool.query(
    `INSERT INTO audit_events (actor, request_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.actor ?? "SYSTEM",
      input.requestId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function queryAuditEvents(limit = 100) {
  const result = await pool.query<{
    audit_event_id: string; occurred_at: string; actor: string; request_id: string | null;
    action: string; resource_type: string; resource_id: string | null; metadata: Record<string, unknown>;
  }>(
    `SELECT audit_event_id, occurred_at::text, actor, request_id, action, resource_type, resource_id, metadata
     FROM audit_events ORDER BY occurred_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows.map((row) => ({
    auditEventId: row.audit_event_id,
    occurredAt: row.occurred_at,
    actor: row.actor,
    requestId: row.request_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
  }));
}