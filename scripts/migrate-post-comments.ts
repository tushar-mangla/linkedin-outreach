/**
 * migrate-post-comments.ts
 *
 * One-off migration: reads every 'comment' action in scheduled_actions,
 * builds the strict account_post_comments mapping, and cancels redundant
 * PENDING actions in scheduled_actions so the queue is clean.
 *
 * Logic (per account+postHash group):
 *   - If any action is COMPLETED  -> mark mapping COMPLETED, cancel all other PENDING ones
 *   - If any action is PENDING/CLAIMED -> mark mapping PENDING, cancel all but the oldest PENDING
 *   - Otherwise (all FAILED)  -> mark mapping FAILED (eligible for re-queue)
 */

import { db } from '../src/db/client.ts';
import { scheduledActions, accountPostComments, engagementPosts } from '../src/db/schema.ts';
import { eq, inArray } from 'drizzle-orm';

async function main() {
  console.log('=== Account Post Comment Migration ===\n');

  const allComments = await db.select().from(scheduledActions).where(eq(scheduledActions.actionType, 'comment'));
  console.log(`Found ${allComments.length} total comment actions in scheduled_actions.`);

  const posts = await db.select().from(engagementPosts);
  const postUrlByHash = new Map<string, string>();
  for (const p of posts) {
    if (p.contentHash) postUrlByHash.set(p.contentHash, p.postUrl);
  }

  const groups = new Map<string, typeof allComments>();
  for (const row of allComments) {
    if (!row.postHash) continue;
    const key = `${row.tenantId}::${row.accountId}::${row.postHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  console.log(`Found ${groups.size} unique (account, post) groups.\n`);

  let insertedCount = 0;
  let updatedCount = 0;
  let cancelledCount = 0;

  for (const [key, rows] of groups.entries()) {
    const [tenantId, accountId, postHash] = key.split('::');
    const postUrl = postUrlByHash.get(postHash) ?? (rows[0]?.payload as any)?.postUrl ?? '';

    rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const completed = rows.find(r => r.status === 'COMPLETED' || r.errorCode === 'ACTION_DUPLICATE' || r.errorCode === 'POST_ALREADY_COMMENTED');
    const pending = rows.filter(r => r.status === 'PENDING' || r.status === 'CLAIMED');

    let mappingStatus: string;
    let canonicalActionId: string | null = null;
    const toCancel: string[] = [];

    if (completed) {
      mappingStatus = 'COMPLETED';
      canonicalActionId = completed.id;
      for (const p of pending) toCancel.push(p.id);
    } else if (pending.length > 0) {
      mappingStatus = 'PENDING';
      canonicalActionId = pending[0].id;
      for (const p of pending.slice(1)) toCancel.push(p.id);
    } else {
      mappingStatus = 'FAILED';
      canonicalActionId = rows[rows.length - 1]?.id ?? null;
    }

    const existing = await db.query.accountPostComments.findFirst({
      where: (t: any, { and, eq: eqOp }: any) => and(
        eqOp(t.tenantId, tenantId),
        eqOp(t.accountId, accountId),
        eqOp(t.postHash, postHash),
      ),
    });

    if (existing) {
      await db.update(accountPostComments)
        .set({ status: mappingStatus, scheduledActionId: canonicalActionId, updatedAt: new Date() })
        .where(eq(accountPostComments.id, existing.id));
      updatedCount++;
    } else {
      await db.insert(accountPostComments).values({
        tenantId,
        accountId,
        postHash,
        postUrl,
        status: mappingStatus,
        scheduledActionId: canonicalActionId ?? undefined,
      }).onConflictDoNothing();
      insertedCount++;
    }

    if (toCancel.length > 0) {
      await db.update(scheduledActions)
        .set({ status: 'FAILED', errorCode: 'POST_ALREADY_COMMENTED' })
        .where(inArray(scheduledActions.id, toCancel));
      cancelledCount += toCancel.length;
    }
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`  Mapping rows inserted: ${insertedCount}`);
  console.log(`  Mapping rows updated:  ${updatedCount}`);
  console.log(`  Duplicate PENDING actions cancelled: ${cancelledCount}`);

  const mappingRows = await db.select().from(accountPostComments);
  const byStatus: Record<string, number> = {};
  for (const r of mappingRows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  }
  console.log(`\nFinal account_post_comments state:`);
  console.table(byStatus);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
