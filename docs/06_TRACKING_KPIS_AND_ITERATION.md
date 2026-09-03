# Feature 6: Tracking, KPIs, and Iteration

This document covers the systems for data logging, performance tracking, and reliable integration with external systems like CRMs.

## 1. Architecture: Decoupled Analytics and Transactional Outbox

The tracking architecture is designed for high performance and reliability by separating real-time safety counters from slower analytical tables and using a transactional outbox pattern for external communication.

```mermaid
graph TD
    subgraph Core Transaction
        A[Agent Action] --> B(Write to Audit Ledger);
        A --> C(Write to Webhook Outbox);
    end

    B --> D{Periodic Aggregation};
    D --> E[Daily Funnel Analytics Table];
    E --> F[Next.js/React UI];

    C --> G{Outbox Processor (Separate Worker)};
    G -- POST --> H[External CRM/System];
    H -- 200 OK --> I(Mark as Sent);
    H -- Error --> J(Schedule Retry with Backoff);
```

### Key Principles:

1.  **Separation of Concerns**:
    *   **`daily_action_counters`** (see `05_SAFETY_LIMITS_AND_OPERATIONS.md`): This table is for **real-time safety enforcement**. It is updated with atomic queries and is optimized for write-heavy, low-latency operations. It is *not* used for analytics.
    *   **`daily_funnel_stats`**: This table is for **analytical reporting**. It is populated by a background job that aggregates data from the `audit_ledger`. This separation ensures that slow-running analytical queries do not impact the performance or reliability of the core safety mechanisms.

2.  **Transactional Outbox Pattern**: To ensure that webhook notifications to external systems are delivered reliably and "at-least-once", we do not send them directly from the main application logic. Instead, we use the transactional outbox pattern.

## 2. Append-Only Audit Ledger

Every significant action taken by the agent is recorded in an immutable `audit_ledger` table. This provides a granular, chronological history of all operations, which is invaluable for debugging, compliance, and is the source of truth for all analytics.

**Drizzle Schema (`src/db/schema.ts`)**

```typescript
import { pgTable, bigserial, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const auditLedger = pgTable('audit_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  actionType: varchar('action_type', { length: 100 }).notNull(), // e.g., 'MESSAGE_SENT', 'REPLY_RECEIVED'
  campaignMemberId: integer('campaign_member_id'),
  details: jsonb('details'), // Contextual data
});
```

## 3. Transactional Webhook Outbox

This pattern guarantees that an event (like a prospect replying) will eventually be delivered to an external system, even if that system is temporarily down or there is a network failure.

### 3.1. How It Works:

1.  **Atomic Write**: When an event occurs (e.g., a message is received), the application logic inserts a record into the `webhook_outbox` table **within the same database transaction** as the primary state change (e.g., updating the `CampaignMember` to `RESPONDED`). This guarantees that the notification is never lost if the transaction succeeds.
2.  **Separate Dispatcher**: A completely separate worker process polls the `webhook_outbox` table for `PENDING` records.
3.  **Guaranteed Delivery**: The dispatcher sends the webhook.
    *   If it receives a `2xx` success response, it marks the outbox record as `SENT`.
    *   If it fails, it marks the record as `FAILED` and schedules a retry using an **exponential backoff** strategy (e.g., retry in 1 min, then 5 mins, then 15 mins).
4.  **Idempotency**: The dispatcher includes a unique event ID in the webhook headers, allowing the receiving system to handle potential duplicate deliveries gracefully (which can happen in at-least-once delivery systems).

### 3.2. Drizzle Schema (`src/db/schema.ts`)

```typescript
import { pgTable, bigserial, jsonb, varchar, timestamp, integer } from 'drizzle-orm/pg-core';

export const webhookOutbox = pgTable('webhook_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  payload: jsonb('payload').notNull(),
  status: varchar('status', { length: 50 }).default('PENDING').notNull(), // PENDING, PROCESSING, SENT, FAILED
  retryCount: integer('retry_count').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at').defaultNow().notNull(),
  // For auditing delivery
  lastAttemptAt: timestamp('last_attempt_at'),
  lastResponseCode: integer('last_response_code'),
});
```
This robust pattern ensures that integrations with external systems are resilient to failure and that critical business events are not lost.
