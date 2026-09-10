#!/usr/bin/env tsx
/**
 * Live Neon Resilience E2E Verification Script
 * 
 * NOTE: Operator-gated script to test connection pooling and resilience against real Neon Postgres.
 * To run: ALLOW_LIVE_NEON_TEST=1 npx tsx scripts/e2e-neon-resilience.ts
 * Optional: NEON_SUSPEND_TEST=1 (pauses for Neon idle suspend testing)
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import { createPool, withDbRetry } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { DrizzleAdapter } from '../src/db/drizzle-adapter.js';
import { LeaseService } from '../src/services/lease-service.js';
import { BudgetService } from '../src/services/budget-service.js';
import { ActionQueueService } from '../src/services/action-queue-service.js';
import { FakeExecutor } from '../src/executors/fake.js';
import type { ScheduledAction } from '../src/types.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

async function runLiveNeonVerification() {
  console.log('================================================================');
  console.log('🌐 LIVE NEON DATABASE RESILIENCE VERIFICATION');
  console.log('================================================================\n');

  if (process.env.ALLOW_LIVE_NEON_TEST !== '1') {
    console.log('⚠️  OPERATOR GATE: Live Neon testing is operator-gated.');
    console.log('To run against real Neon DATABASE_URL:');
    console.log('  ALLOW_LIVE_NEON_TEST=1 npx tsx scripts/e2e-neon-resilience.ts\n');
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const pool = createPool();
  const db = drizzle(pool, { schema });
  const adapter = new DrizzleAdapter(db);
  const leaseService = new LeaseService(adapter);
  const budgetService = new BudgetService(adapter);
  const executor = new FakeExecutor();

  const tenantId = '00000000-0000-0000-0000-000000000099';
  const accountId = '00000000-0000-0000-0000-000000000088';
  const workerId = `neon-worker-${randomUUID().slice(0, 8)}`;

  try {
    console.log('📡 1. Testing Neon Connectivity via withDbRetry...');
    const nowResult = await withDbRetry(async () => {
      const res = await pool.query('SELECT now() as now, current_database() as db');
      return res.rows[0];
    });
    assert(!!nowResult.now, `Connected to Neon database: ${nowResult.db} at ${nowResult.now}`);

    console.log('\n🧹 2. Setting up isolated disposable test environment...');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await withDbRetry(async () => {
      await db.insert(schema.browserAccounts).values({
        id: accountId,
        tenantId,
        label: 'Neon Test Account',
        health: 'HEALTHY',
        sessionExpiresAt: new Date(Date.now() + 3600 * 1000),
      }).onConflictDoNothing();

      await db.insert(schema.dailyActionBudgets).values({
        id: randomUUID(),
        tenantId,
        accountId,
        actionType: 'like',
        budgetDate: today,
        limit: 10,
        reservedCount: 0,
        completedCount: 0,
      }).onConflictDoNothing();

      await db.insert(schema.dailyActionBudgets).values({
        id: randomUUID(),
        tenantId,
        accountId,
        actionType: 'comment',
        budgetDate: today,
        limit: 10,
        reservedCount: 0,
        completedCount: 0,
      }).onConflictDoNothing();
    });
    assert(true, 'Test account and budgets initialized on Neon');

    const prospect = await withDbRetry(async () => {
      const [p] = await db.insert(schema.prospects).values({
        id: randomUUID(),
        tenantId,
        linkedinUrl: `https://linkedin.com/in/neon-prospect-${randomUUID().slice(0, 8)}`,
        normalizedLinkedinUrl: `https://linkedin.com/in/neon-prospect-${randomUUID().slice(0, 8)}`,
        currentStage: 'READY_FOR_CAMPAIGN',
      }).returning();
      return p;
    });
    assert(!!prospect.id, 'Test prospect inserted');

    const lease = await leaseService.acquireLeaseWithToken(tenantId, accountId, workerId, 300);
    assert(lease.acquired && !!lease.leaseToken, 'Acquired worker lease on Neon');

    console.log('\n📋 3. Scheduling test actions on Neon...');
    const queueService = new ActionQueueService({
      db: adapter,
      leaseService,
      budgetService,
      executor,
      resolveSafety: async (scheduled: ScheduledAction) => ({
        tenantId,
        prospectReady: true,
        postEligible: true,
        approvalCurrent: true,
        actionType: scheduled.actionType.toUpperCase() as 'LIKE' | 'COMMENT',
        mode: 'SIMULATE',
        revisionId: scheduled.revisionId,
        postHash: scheduled.postHash,
        policy: {
          likeEnabled: true,
          commentEnabled: true,
          feature05BrowserEnabled: false,
          pilotActionsRemaining: 5,
          killSwitchActive: false,
          accountPaused: false,
          sessionHealthy: true,
          cooldownActive: false,
          budgetAvailable: true,
          leaseValid: true,
          workingHours: true,
        },
      }),
    });

    const likeAction = await queueService.scheduleAction({
      tenantId,
      accountId,
      prospectId: prospect.id,
      actionType: 'like',
      payload: { postUrl: 'https://linkedin.com/posts/neon-test-post' },
      scheduledFor: new Date(Date.now() - 5000),
      idempotencyKey: `neon-test-like-${prospect.id}`,
      revisionId: randomUUID(),
      postHash: 'e'.repeat(64),
      mode: 'SIMULATE',
    });
    assert(likeAction.status === 'PENDING', 'Action scheduled in PENDING on Neon');

    if (process.env.NEON_SUSPEND_TEST === '1') {
      const pauseSec = Number(process.env.SUSPEND_PAUSE_SECONDS ?? 45);
      console.log(`\n⏳ 4. Pausing for ${pauseSec}s to test Neon cold-start / compute wake-up...`);
      await new Promise((resolve) => setTimeout(resolve, pauseSec * 1000));
      console.log('Waking up and resuming execution...');
    }

    console.log('\n⚡ 5. Processing action through ActionQueueService on Neon...');
    const result = await queueService.processNextAction(tenantId, accountId, workerId, lease.leaseToken);
    assert(result.processed === true, `Action processed successfully on Neon (outcome: ${result.result?.outcomeLabel})`);

    const verifiedAction = await withDbRetry(() =>
      db.query.scheduledActions.findFirst({
        where: and(
          eq(schema.scheduledActions.tenantId, tenantId),
          eq(schema.scheduledActions.id, likeAction.id),
        ),
      })
    );
    assert(verifiedAction?.status === 'COMPLETED', 'Action status is COMPLETED in Neon Postgres');

    console.log('\n🧹 6. Cleaning up disposable test rows on Neon...');
    await withDbRetry(async () => {
      await db.delete(schema.scheduledActions).where(eq(schema.scheduledActions.tenantId, tenantId));
      await db.delete(schema.prospects).where(eq(schema.prospects.tenantId, tenantId));
      await db.delete(schema.dailyActionBudgets).where(eq(schema.dailyActionBudgets.tenantId, tenantId));
      await db.delete(schema.browserAccounts).where(eq(schema.browserAccounts.tenantId, tenantId));
      await leaseService.releaseLease(tenantId, accountId, workerId, lease.leaseToken!);
    });
    assert(true, 'Test cleanup completed');

    console.log('\n================================================================');
    console.log('🎉 LIVE NEON RESILIENCE VERIFICATION PASSED (EXIT 0)');
    console.log('================================================================');
  } finally {
    await pool.end();
  }
}

runLiveNeonVerification().catch((err) => {
  console.error('Fatal error during live Neon verification:', err);
  process.exit(1);
});
