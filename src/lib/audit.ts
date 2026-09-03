import crypto from 'crypto';
import { DBAdapter } from '../db/db-adapter.js';
import { DEFAULT_OPERATOR_ID } from '../types.js';

export interface AuditRecordInput {
  action: string;
  actor: string;
  details: any;
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
}

export interface AuditEventRecord {
  action: string;
  actor: string;
  timestamp: string;
  details: any;
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  payloadHash?: string;
}

export class AuditLogger {
  private events: Map<string, AuditEventRecord> = new Map();
  private db?: DBAdapter;

  constructor(db?: DBAdapter) {
    this.db = db;
  }

  public setDb(db: DBAdapter) {
    this.db = db;
  }

  async record(event: AuditRecordInput): Promise<{ eventId: string; payloadHash: string }> {
    const timestamp = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const tenantId = event.tenantId || DEFAULT_OPERATOR_ID;
    const entityType = event.entityType || 'action';
    const entityId = event.entityId || eventId;
    const correlationId = event.correlationId || eventId;

    const fullEvent: AuditEventRecord = {
      ...event,
      timestamp,
      tenantId,
      entityType,
      entityId,
      correlationId,
    };
    const payloadString = JSON.stringify(fullEvent);
    const payloadHash = crypto.createHash('sha256').update(payloadString).digest('hex');
    fullEvent.payloadHash = payloadHash;

    this.events.set(eventId, fullEvent);

    if (this.db) {
      try {
        await this.db.insertAuditEvent({
          tenantId,
          eventType: event.action,
          entityType,
          entityId,
          payload: {
            ...fullEvent,
            eventId,
            payloadHash,
          },
        });
      } catch (err) {
        console.error('[AuditLogger] Failed to write audit event to DB:', err);
      }
    }

    return { eventId, payloadHash };
  }

  getEvent(eventId: string): AuditEventRecord | undefined {
    return this.events.get(eventId);
  }

  getAllEvents(): AuditEventRecord[] {
    return Array.from(this.events.values());
  }

  clear(): void {
    this.events.clear();
  }
}

export const auditLogger = new AuditLogger();

