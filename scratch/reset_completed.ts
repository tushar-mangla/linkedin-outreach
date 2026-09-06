import { db } from '../src/db/client';
import { scheduledActions } from '../src/db/schema';
import { eq, and, gte } from 'drizzle-orm';

async function run() {
  console.log('Resetting falsely completed scheduled actions (last 24h)...');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db.update(scheduledActions)
    .set({ status: 'FAILED', errorCode: 'RESET_FOR_RETRY', outcomeLabel: 'failed' })
    .where(
      and(
        eq(scheduledActions.status, 'COMPLETED'),
        eq(scheduledActions.actionType, 'comment'),
        gte(scheduledActions.createdAt, since)
      )
    )
    .returning({ id: scheduledActions.id });

  console.log(`✓ Reset ${result.length} scheduled action(s) to FAILED so they can be retried.`);
  if (result.length > 0) {
    console.log('Affected IDs:', result.map(r => r.id).join(', '));
  }
  process.exit(0);
}

run().catch(console.error);
