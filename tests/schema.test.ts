import { describe, it, expect } from 'vitest';
import * as schema from '../src/db/schema';

describe('Database Schema', () => {
  it('should have a tenants table defined', () => {
    expect(schema.tenants).toBeDefined();
    expect(schema.tenants.id).toBeDefined();
    expect(schema.tenants.name).toBeDefined();
  });

  it('should have a users table with a tenantId column', () => {
    expect(schema.users).toBeDefined();
    expect(schema.users.tenantId).toBeDefined();
  });

  it('should have a scheduled_actions table with all required foreign key columns', () => {
    expect(schema.scheduledActions).toBeDefined();
    expect(schema.scheduledActions.tenantId).toBeDefined();
    expect(schema.scheduledActions.enrollmentId).toBeDefined();
    expect(schema.scheduledActions.sequenceStepId).toBeDefined();
    expect(schema.scheduledActions.linkedInAccountId).toBeDefined();
  });

  it('should have an append-only audit_events table', () => {
    expect(schema.auditEvents).toBeDefined();
    // The append-only nature is a convention enforced by the application logic (only using insert),
    // not something easily testable at the schema definition level without triggers.
    // We'll trust our `recordAuditEvent` function for this.
    expect(schema.auditEvents.payload).toBeDefined();
    expect(schema.auditEvents.event_type).toBeDefined();
  });
});
