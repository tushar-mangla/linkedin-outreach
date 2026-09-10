#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema.js';
import { MemoryStorage } from '../src/db/memory-storage.js';
import { DrizzleAdapter } from '../src/db/drizzle-adapter.js';
import { LeaseService } from '../src/services/lease-service.js';
import { BudgetService } from '../src/services/budget-service.js';
import { ActionQueueService } from '../src/services/action-queue-service.js';
import { FakeExecutor } from '../src/executors/fake.js';
import { EngagementService } from '../src/services/engagement/engagement-service.js';
import { TransientDbError } from '../src/db/retry.js';
import type { DBAdapter } from '../src/db/db-adapter.js';
import type { ScheduledAction } from '../src/types.js';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

class FaultInjectionStorage implements DBAdapter {
  public safetyFault = false;
  public faultError: Error = new TransientDbError('Connection terminated due to connection timeout');

  constructor(public readonly storage: MemoryStorage) {}

  // Delegate all DBAdapter methods
  async insertProspect(prospect: any) { return this.storage.insertProspect(prospect); }
  async updateProspectStage(id: string, stage: any) { return this.storage.updateProspectStage(id, stage); }
  async insertIcpEvaluation(evalData: any) { return this.storage.insertIcpEvaluation(evalData); }
  async insertImportBatch(batch: any) { return this.storage.insertImportBatch(batch); }
  async updateImportBatch(id: string, updates: any) { return this.storage.updateImportBatch(id, updates); }
  async findIcpDefinitionById(id: string) { return this.storage.findIcpDefinitionById(id); }
  async findProspectByTenantAndUrl(t: string, u: string) { return this.storage.findProspectByTenantAndUrl(t, u); }
  async updateProspect(id: string, p: any) { return this.storage.updateProspect(id, p); }
  async applyOverride(t: string, id: string, s: any) { return this.storage.applyOverride(t, id, s); }
  async exportReadyProspects(t: string) { return this.storage.exportReadyProspects(t); }
  async insertReviewDecision(d: any) { return this.storage.insertReviewDecision(d); }
  async insertAuditEvent(e: any) { return this.storage.insertAuditEvent(e); }
  async insertScheduledAction(a: any) { return this.storage.insertScheduledAction(a); }
  async claimNextScheduledAction(t: string, acc: string, w: string, tok?: string) {
    return this.storage.claimNextScheduledAction(t, acc, w, tok);
  }
  async updateScheduledActionStatus(id: string, s: any) { return this.storage.updateScheduledActionStatus(id, s); }
  async createManualTask(task: any) { return this.storage.createManualTask(task); }
  async completeManualTask(t: string, tid: string, o: any, act: string, m?: any) { return this.storage.completeManualTask(t, tid, o, act, m); }
  async updateScheduledActionResult(t: string, id: string, res: any) {
    return this.storage.updateScheduledActionResult(t, id, res);
  }
  async finalizeCommentAction(t: string, id: string, res: any, op?: string) {
    return this.storage.finalizeCommentAction(t, id, res, op);
  }
  async isCommentSlotOwner(t: string, acc: string, id: string, c?: string) {
    return this.storage.isCommentSlotOwner(t, acc, id, c);
  }
  async recoverStaleClaims(ttlMs?: number, t?: string, a?: string) {
    return this.storage.recoverStaleClaims(ttlMs, t, a);
  }
  async checkEngagementCooldown(t: string, pid: string, act: any, now?: Date) {
    return this.storage.checkEngagementCooldown(t, pid, act, now);
  }
}

async function runE2EPipeline() {
  console.log('================================================================');
  console.log('🧪 E2E Prospect Lifecycle & Database Resilience Verification');
  console.log('================================================================\n');

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const accountId = '00000000-0000-0000-0000-000000000002';
  const workerId = 'resilience-worker-1';

  const rawStorage = new MemoryStorage();
  const faultStorage = new FaultInjectionStorage(rawStorage);
  const leaseService = new LeaseService(rawStorage);
  const budgetService = new BudgetService(rawStorage);

  // Setup Daily Budget (limit = 10)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  rawStorage.getTable('dailyActionBudgets').push(
    { id: 'b-like', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 10, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today },
    { id: 'b-comment', tenantId, accountId, actionType: 'comment', budgetDate: today, limit: 10, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today },
  );

  // 1. Configure prospect
  console.log('--- Step 1: Configure Prospect ---');
  const prospect = await rawStorage.insertProspect({
    tenantId,
    name: 'Sarah Connor',
    title: 'Senior Systems Engineer',
    company: 'Cyberdyne Resistance',
    location: 'Los Angeles, CA',
    linkedinUrl: 'https://www.linkedin.com/in/sarah-connor-resilience',
    normalizedLinkedinUrl: 'https://www.linkedin.com/in/sarah-connor-resilience',
    skills: ['Distributed Systems', 'Fault Tolerance'],
  });
  await rawStorage.updateProspectStage(prospect.id, 'READY_FOR_CAMPAIGN');
  assert(prospect.id !== undefined, 'Prospect inserted and stage set to READY_FOR_CAMPAIGN');

  // Acquire lease for account
  const leaseResult = await leaseService.acquireLeaseWithToken(tenantId, accountId, workerId, 300);
  assert(leaseResult.acquired && !!leaseResult.leaseToken, 'Acquired worker lease for account');

  // 2. Ingest/scan & generate actions
  console.log('\n--- Step 2: Ingest / Scan Prospect ---');
  const postHash = 'c'.repeat(64);
  const postUrl = 'https://linkedin.com/posts/sarah-connor-resilient-post';

  // Seed scheduled actions for Like & Comment
  const queueService = new ActionQueueService({
    db: faultStorage,
    leaseService,
    budgetService,
    executor: new FakeExecutor(),
    resolveSafety: async (scheduled: ScheduledAction) => {
      // simulate safety check with potential transient error
      if (faultStorage.safetyFault) {
        faultStorage.safetyFault = false;
        throw faultStorage.faultError;
      }
      return {
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
      };
    },
  });

  const likeAction = await queueService.scheduleAction({
    tenantId,
    accountId,
    prospectId: prospect.id,
    actionType: 'like',
    payload: { postUrl },
    scheduledFor: new Date(Date.now() - 5000),
    idempotencyKey: `auto-like-${prospect.id}`,
    revisionId: 'rev-like-1',
    postHash,
    mode: 'SIMULATE',
  });

  const commentAction = await queueService.scheduleAction({
    tenantId,
    accountId,
    prospectId: prospect.id,
    actionType: 'comment',
    payload: { postUrl, comment: 'Exceptional resilience under partition.' },
    scheduledFor: new Date(Date.now() - 4000),
    idempotencyKey: `auto-comment-${prospect.id}`,
    revisionId: 'rev-comment-1',
    postHash,
    mode: 'SIMULATE',
  });

  rawStorage.getTable('accountPostComments').push({
    tenantId,
    accountId,
    canonicalPostIdentifier: 'linkedin:activity:sarah-connor-resilient-post',
    scheduledActionId: commentAction.id,
    status: 'PENDING',
  });

  assert(likeAction.status === 'PENDING' && commentAction.status === 'PENDING', '2 ScheduledActions created in PENDING status');

  // 4. Simulate Neon suspend / connection drop
  console.log('\n--- Step 3: Simulate Neon Connection Timeout During Pre-Dispatch ---');
  // Inject 1 transient DB fault during resolveSafety
  faultStorage.safetyFault = true;
  const dropResult = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);

  assert(dropResult.processed === false, 'Action was not marked processed during DB failure');
  assert(dropResult.reason === 'DB_RETRYABLE', 'Action returned failureReason DB_RETRYABLE');

  const actionAfterDrop = rawStorage.getTable('scheduledActions').find((a) => a.id === likeAction.id);
  assert(actionAfterDrop?.status === 'PENDING', 'Zero Data Loss: Action reverted cleanly to PENDING (never stuck in CLAIMED)');
  assert(actionAfterDrop?.errorCode === 'DB_TRANSIENT', 'Action tagged with errorCode DB_TRANSIENT for recovery observability');

  // Verify no engagement history was prematurely recorded
  const historyCount = rawStorage.getTable('engagementHistory').length;
  assert(historyCount === 0, 'No engagement history was recorded during failed pre-dispatch');

  // 5. Resume and drain
  console.log('\n--- Step 4: Resume DB and Drain Queue ---');
  // Faults exhausted (0 remaining), DB has resumed
  const likeExecResult = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);
  assert(likeExecResult.processed === true, 'Like action successfully processed after DB recovery');
  assert(likeExecResult.result?.outcomeLabel === 'simulated', 'Like executed with outcome simulated');

  const commentExecResult = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);
  assert(commentExecResult.processed === true, 'Comment action successfully processed');
  assert(commentExecResult.result?.outcomeLabel === 'simulated', 'Comment executed with outcome simulated');

  // 6. Verify exactly-once execution
  console.log('\n--- Step 5: Verify Exactly-Once Execution ---');
  const finalLike = rawStorage.getTable('scheduledActions').find((a) => a.id === likeAction.id);
  const finalComment = rawStorage.getTable('scheduledActions').find((a) => a.id === commentAction.id);
  assert(finalLike?.status === 'COMPLETED' && finalComment?.status === 'COMPLETED', 'Both scheduled actions are COMPLETED');

  const emptyQueueResult = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);
  assert(emptyQueueResult.processed === false && emptyQueueResult.reason === 'NO_PENDING_ACTIONS', 'Queue empty: NO_PENDING_ACTIONS returned');

  // Idempotency: re-scheduling with same key does not duplicate
  const dupLike = await queueService.scheduleAction({
    tenantId,
    accountId,
    prospectId: prospect.id,
    actionType: 'like',
    payload: { postUrl },
    scheduledFor: new Date(),
    idempotencyKey: `auto-like-${prospect.id}`,
    mode: 'SIMULATE',
  });
  assert(dupLike.id === likeAction.id, 'Idempotent re-scheduling returned existing action without creating duplicate');

  // 7. Stale claim recovery verification
  console.log('\n--- Step 6: Verify Stale Claim Recovery ---');
  const strandedActionId = 'stranded-action-1';
  const oldDate = new Date(Date.now() - 25 * 60 * 1000); // 25 min ago
  rawStorage.getTable('scheduledActions').push({
    id: strandedActionId,
    tenantId,
    accountId: 'abandoned-account-id',
    prospectId: prospect.id,
    actionType: 'like',
    status: 'CLAIMED',
    scheduledFor: oldDate,
    idempotencyKey: 'stranded-claim-key',
    claimedBy: 'crashed-worker',
    claimedAt: oldDate,
    createdAt: oldDate,
    updatedAt: oldDate,
  });

  const strandedActionId2 = 'stranded-action-2-no-claimed-at';
  rawStorage.getTable('scheduledActions').push({
    id: strandedActionId2,
    tenantId,
    accountId: 'abandoned-account-id',
    prospectId: prospect.id,
    actionType: 'comment',
    status: 'CLAIMED',
    scheduledFor: oldDate,
    idempotencyKey: 'stranded-claim-key-2',
    claimedBy: 'crashed-worker-2',
    claimedAt: undefined,
    createdAt: oldDate,
    updatedAt: oldDate,
  });

  const recoveredCount = await rawStorage.recoverStaleClaims(15 * 60 * 1000);
  assert(recoveredCount >= 2, `recoverStaleClaims successfully recovered ${recoveredCount} stranded action(s)`);
  const recoveredRow = rawStorage.getTable('scheduledActions').find((a) => a.id === strandedActionId);
  assert(recoveredRow?.status === 'PENDING' && recoveredRow?.errorCode === 'DB_TRANSIENT', 'Stranded action safely reverted from CLAIMED to PENDING');
  const recoveredRow2 = rawStorage.getTable('scheduledActions').find((a) => a.id === strandedActionId2);
  assert(recoveredRow2?.status === 'PENDING' && recoveredRow2?.errorCode === 'DB_TRANSIENT', 'Stranded action without claimedAt reverted from CLAIMED to PENDING via updatedAt');

  // 8. Scan-Timeout Catchup Scenario (The Today Bug)
  console.log('\n--- Step 7: Scan-Timeout Catchup Scenario (The Root-Cause Bug) ---');
  const client = new PGlite();
  await client.waitReady;
  const files = fs
    .readdirSync(path.join(process.cwd(), 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(fs.readFileSync(path.join(process.cwd(), 'drizzle', file), 'utf8'));
  }
  const testDb = drizzle(client, { schema });

  const [prospectB] = await testDb
    .insert(schema.prospects)
    .values({
      id: randomUUID(),
      tenantId,
      name: 'John Connor',
      title: 'Lead Architect',
      company: 'Resistance Core',
      location: 'Denver, CO',
      linkedinUrl: 'https://www.linkedin.com/in/john-connor-catchup',
      normalizedLinkedinUrl: 'https://www.linkedin.com/in/john-connor-catchup',
      skills: ['Architecture', 'Kubernetes'],
      currentStage: 'READY_FOR_CAMPAIGN',
    })
    .returning();

  // Simulate post source & flaky AI provider that fails during scan
  const postUrlB = 'https://linkedin.com/posts/john-connor-post-catchup';
  let aiShouldFail = true;

  const mockAiProvider = {
    providerName: 'fake' as const,
    generateComment: async () => {
      if (aiShouldFail) {
        throw new TransientDbError('Connection terminated due to connection timeout');
      }
      return {
        commentText: 'Resilient catchup insight for John Connor.',
        groundingEvidence: 'Architecture and Kubernetes',
      };
    },
  };

  const mockPostSource = {
    sourceType: 'FIXTURE' as const,
    findRecentPosts: async () => [
      {
        postUrl: postUrlB,
        postText: 'Building resilient platforms requires end-to-end self healing mechanisms.',
        authorName: 'John Connor',
        publishedAtDate: new Date(),
      },
    ],
  };

  const engagementService = new EngagementService({
    postSource: mockPostSource,
    aiProvider: mockAiProvider,
    db: testDb as any,
  });

  // First scan: mid-scan failure produces LIKE-only + errors
  const firstScanRes = await engagementService.scanProspect(tenantId, prospectB.id);
  assert(firstScanRes.draftsCreated === 1, 'Scan created 1 draft (LIKE draft preserved as checkpoint)');
  assert(firstScanRes.errors.length > 0, 'Scan recorded the comment failure in errors array');

  // Verify state before catchup: LIKE exists, COMMENT absent
  const draftsBefore = await engagementService.listAllDrafts(tenantId);
  const prospectBDraftsBefore = draftsBefore.filter((d) => d.prospectId === prospectB.id);
  assert(prospectBDraftsBefore.length === 1 && prospectBDraftsBefore[0].actionType === 'LIKE', 'Prospect B has LIKE draft but NO comment draft');

  // Resume: faults cleared, run reconcileMissingDrafts
  aiShouldFail = false;
  const catchupRes = await engagementService.reconcileMissingDrafts(tenantId, prospectB.id);
  assert(catchupRes.backfilledComments === 1, 'reconcileMissingDrafts backfilled exactly 1 missing COMMENT draft');
  assert(catchupRes.backfilledLikes === 0, 'No duplicate LIKE drafts were created');

  const draftsAfter = await engagementService.listAllDrafts(tenantId);
  const prospectBDraftsAfter = draftsAfter.filter((d) => d.prospectId === prospectB.id);
  assert(prospectBDraftsAfter.length === 2, 'Prospect B now has both LIKE and COMMENT drafts');
  assert(prospectBDraftsAfter.map((d) => d.actionType).sort().join(',') === 'COMMENT,LIKE', 'Both draft types exist cleanly');

  // Second reconcile pass is idempotent
  const secondCatchup = await engagementService.reconcileMissingDrafts(tenantId, prospectB.id);
  assert(secondCatchup.backfilledComments === 0 && secondCatchup.backfilledLikes === 0, 'Subsequent reconcile pass created 0 drafts (strictly idempotent)');

  // Now approve and queue both drafts
  for (const draft of prospectBDraftsAfter) {
    await engagementService.applyReviewDecision({
      draftId: draft.id,
      tenantId,
      decision: 'APPROVED',
      operatorId: 'auto-test',
    });
    const scheduled = await queueService.scheduleAction({
      tenantId,
      accountId,
      prospectId: prospectB.id,
      actionType: draft.actionType.toLowerCase() as 'like' | 'comment',
      payload: { postUrl: postUrlB, comment: 'Catchup comment for John Connor.' },
      scheduledFor: new Date(Date.now() - 1000),
      idempotencyKey: `auto-${draft.actionType.toLowerCase()}-${draft.id}`,
      revisionId: `rev-${draft.id}`,
      postHash: 'd'.repeat(64),
      mode: 'SIMULATE',
    });

    if (draft.actionType === 'COMMENT') {
      rawStorage.getTable('accountPostComments').push({
        tenantId,
        accountId,
        canonicalPostIdentifier: 'linkedin:activity:john-connor-post-catchup',
        scheduledActionId: scheduled.id,
        status: 'PENDING',
      });
    }
  }

  // Drain both actions
  const drainLike = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);
  const drainComment = await queueService.processNextAction(tenantId, accountId, workerId, leaseResult.leaseToken);
  assert(drainLike.processed === true && drainLike.result?.outcomeLabel === 'simulated', 'Catchup LIKE action completed');
  assert(drainComment.processed === true && drainComment.result?.outcomeLabel === 'simulated', 'Catchup COMMENT action completed');

  // 9. DrizzleAdapter SQL Parity & scanCampaignResume Permutations
  console.log('\n--- Step 8: Verify DrizzleAdapter SQL Stale Claims & Campaign Resume Permutations ---');
  const drizzleAdapter = new DrizzleAdapter(testDb as any);
  const strandedSqlActionId = randomUUID();
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000);
  await testDb.insert(schema.scheduledActions).values({
    id: strandedSqlActionId,
    tenantId,
    accountId,
    prospectId: prospectB.id,
    actionType: 'comment',
    status: 'CLAIMED',
    scheduledFor: twentyMinsAgo,
    idempotencyKey: `sql-stale-${strandedSqlActionId}`,
    claimedBy: 'sql-dead-worker',
    claimedAt: null, // Test NULL claimed_at fallback to updated_at via COALESCE
    createdAt: twentyMinsAgo,
    updatedAt: twentyMinsAgo,
  });

  const sqlRecovered = await drizzleAdapter.recoverStaleClaims(15 * 60 * 1000, tenantId, accountId);
  assert(sqlRecovered === 1, `DrizzleAdapter.recoverStaleClaims recovered ${sqlRecovered} action with NULL claimed_at via COALESCE`);
  const sqlRecoveredRow = await testDb.query.scheduledActions.findFirst({
    where: (actions, { eq }) => eq(actions.id, strandedSqlActionId),
  });
  assert(sqlRecoveredRow?.status === 'PENDING' && sqlRecoveredRow?.errorCode === 'DB_TRANSIENT', 'SQL stranded action safely reverted to PENDING with DB_TRANSIENT');

  // Verify scanCampaignResume without campaignId (Finding H1)
  const [prospectC] = await testDb
    .insert(schema.prospects)
    .values({
      id: randomUUID(),
      tenantId,
      name: 'Kyle Reese',
      title: 'Field Commander',
      company: 'Tech-Com',
      location: 'Los Angeles, CA',
      linkedinUrl: `https://www.linkedin.com/in/kyle-reese-${randomUUID()}`,
      normalizedLinkedinUrl: `https://www.linkedin.com/in/kyle-reese-${randomUUID()}`,
      skills: ['Recon', 'Tactics'],
      currentStage: 'READY_FOR_CAMPAIGN',
    })
    .returning();

  const resumeRes = await engagementService.scanCampaignResume(tenantId, undefined);
  assert(resumeRes.status === 'completed', 'scanCampaignResume with undefined campaignId returned status completed');
  assert(resumeRes.prospectsScanned >= 1, `scanCampaignResume(tenantId, undefined) scanned ${resumeRes.prospectsScanned} prospects (> 0)`);

  console.log('\n================================================================');
  console.log('🎉 ALL OFFLINE RESILIENCE E2E TESTS PASSED (EXIT 0)');
  console.log('================================================================');
}

runE2EPipeline().catch((err) => {
  console.error('Fatal error in E2E resilience test:', err);
  process.exit(1);
});
