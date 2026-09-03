# Feature 5: Safety Limits and Operations

This document describes the multi-layered safety and operational integrity systems, with a focus on the core database models and concurrency patterns that ensure the agent operates reliably and within safe limits.

## 1. Core Database Models (Drizzle Schemas)

The entire system's state is managed in a normalized PostgreSQL database. The following are the core Drizzle models.

```typescript
// src/db/schema.ts

import { pgTable, serial, varchar, jsonb, timestamp, integer, pgEnum, boolean, uniqueIndex, date, primaryKey, text, bigserial } from 'drizzle-orm/pg-core';

// --------------- CORE ENTITIES ---------------

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  // ... credentials, settings, IANA timezone
});

export const prospects = pgTable('prospects', {
  id: serial('id').primaryKey(),
  normalizedLinkedInUrl: varchar('normalized_linkedin_url', { length: 256 }).notNull().unique(),
  // ... profile data, ICP score, etc.
});

export const campaigns = pgTable('campaigns', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 256 }).notNull(),
  // ... sequence steps, delays, etc.
});

// --------------- STATE MANAGEMENT ---------------

export const campaignMemberStatusEnum = pgEnum('campaign_member_status', ['DRAFT', 'ACTIVE', 'AWAITING_CONNECTION', 'CONNECTED', 'IN_SEQUENCE', 'RESPONDED', 'COMPLETED', 'PAUSED', 'BLOCKED', 'FAILED']);
export const campaignMembers = pgTable('campaign_members', {
  id: serial('id').primaryKey(),
  campaignId: integer('campaign_id').references(() => campaigns.id),
  prospectId: integer('prospect_id').references(() => prospects.id),
  status: campaignMemberStatusEnum('status').default('DRAFT').notNull(),
  // ...
}, (t) => ({
  unq: uniqueIndex('campaign_prospect_unq_idx').on(t.campaignId, t.prospectId),
}));

export const outreachActionStatusEnum = pgEnum('outreach_action_status', ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CLAIMED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export const outreachActions = pgTable('outreach_actions', {
  id: serial('id').primaryKey(),
  campaignMemberId: integer('campaign_member_id').references(() => campaignMembers.id),
  actionType: varchar('action_type', { length: 50 }).notNull(), // 'CONNECT', 'MESSAGE'
  status: outreachActionStatusEnum('status').default('DRAFT').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 256 }).notNull().unique(), // campaignMemberId:sequenceStep:actionType
  dueAt: timestamp('due_at'),
  leaseExpiresAt: timestamp('lease_expires_at'),
  retryCount: integer('retry_count').default(0),
  // ... content, metadata
});

export const inboundMessages = pgTable('inbound_messages', {
  id: serial('id').primaryKey(),
  campaignMemberId: integer('campaign_member_id').references(() => campaignMembers.id),
  messageContent: text('message_content'),
  // ... metadata
});

// --------------- SAFETY & OPERATIONS ---------------

export const leases = pgTable('leases', {
  id: serial('id').primaryKey(),
  resource: varchar('resource', { length: 256 }).notNull().unique(), // e.g., 'playwright_session_account_1'
  ownerId: varchar('owner_id', { length: 256 }),
  expiresAt: timestamp('expires_at'),
});

export const dailyActionCounters = pgTable('daily_action_counters', {
  accountId: integer('account_id').references(() => accounts.id),
  actionType: varchar('action_type', { length: 50 }),
  day: date('day'),
  count: integer('count').default(0).notNull(),
}, (t) => ({
  pk: primaryKey(t.accountId, t.actionType, t.day),
}));

// --------------- AUDITING & REPORTING ---------------

export const auditLedger = pgTable('audit_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  actionType: varchar('action_type', { length: 100 }).notNull(),
  details: jsonb('details'),
});

export const dailyFunnelStats = pgTable('daily_funnel_stats', {
  // ... aggregated reporting data, separate from real-time counters
});

export const webhookOutbox = pgTable('webhook_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  payload: jsonb('payload').notNull(),
  status: varchar('status', { length: 50 }).default('PENDING'), // PENDING, PROCESSING, SENT, FAILED
  // ... retry logic, delivery history
});
```

## 2. Atomic Budget Enforcement

To ensure daily limits are never exceeded, even with multiple concurrent workers, we use an atomic "UPSERT" pattern to reserve a slot in the budget. This is the **only** way a worker is allowed to increment an action counter.

**Atomic Budget Reservation Query**

```sql
INSERT INTO daily_action_counters (account_id, action_type, day, count)
VALUES ($1, $2, CURRENT_DATE, 1)
ON CONFLICT (account_id, action_type, day)
DO UPDATE SET count = daily_action_counters.count + 1
-- The WHERE clause is critical for atomicity
WHERE daily_action_counters.count < $3 -- $3 is the daily limit for this action_type
RETURNING count;
```

A worker attempts to run this query. If it returns a new count, the worker has successfully reserved its slot. If it returns nothing (because the `WHERE` clause failed), the budget is full, and the worker must postpone the action.

## 3. Atomic Action Claim with Lease Recovery

The worker queue uses a robust query to claim actions. This query not only claims pending actions but can also recover actions from crashed workers whose leases have expired.

**Atomic Action Claim Query**

```sql
-- This CTE finds the oldest, due, and available action,
-- locks it, and returns it to the worker.
WITH next_action AS (
  SELECT id
  FROM outreach_actions
  WHERE
    status = 'APPROVED'
    AND due_at <= NOW()
    AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
  ORDER BY due_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE outreach_actions
SET
  status = 'CLAIMED',
  lease_expires_at = NOW() + INTERVAL '5 minutes' -- Set a renewable lease
WHERE id = (SELECT id FROM next_action)
RETURNING *; -- Returns the claimed action to the application
```
This ensures that a worker can safely claim a task that was previously claimed by another worker that has since crashed and failed to renew its lease.

## 4. Idempotency & Timezones

*   **Idempotency Keys**: Every record in `outreach_actions` has a unique `idempotencyKey` formatted as `campaignMemberId:sequenceStep:actionType` (e.g., `123:2:MESSAGE`). This prevents the system from ever creating a duplicate action, even if the creation logic is triggered multiple times.
*   **IANA Timezones**: All "working hours" and daily budget calculations are performed relative to the IANA timezone (e.g., `America/New_York`) stored in the `accounts` table. This ensures that a 9 AM to 5 PM window is correctly observed for the user, regardless of where the server is located. All timestamps are stored in UTC.
