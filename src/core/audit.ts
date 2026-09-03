import { db as defaultDb } from '../db/index.js';
import { auditEvents } from '../db/schema.js';
import { InferInsertModel } from 'drizzle-orm';

export type AuditEventPayload = Record<string, any>;

export type NewAuditEvent = InferInsertModel<typeof auditEvents>;

/**
 * Records an audit event. This is an append-only operation.
 * @param event - The audit event to record.
 */
export async function recordAuditEvent(event: Omit<NewAuditEvent, 'createdAt'>, db: typeof defaultDb = defaultDb): Promise<void> {
  const eventToInsert: NewAuditEvent = {
    ...event,
    createdAt: new Date(),
  };
  await db.insert(auditEvents).values(eventToInsert);
}

// Example Usage:
// recordAuditEvent({
//   id: '...',
//   tenantId: '...',
//   userId: '...', // optional
//   eventType: 'user.login.success',
//   payload: { ipAddress: '127.0.0.1' },
// });
