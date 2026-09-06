import { db } from './src/db/client.js';
import { scheduledActions, prospects } from './src/db/schema.js';
import { eq, desc } from 'drizzle-orm';

async function check() {
  const pending = await db.select().from(scheduledActions).where(eq(scheduledActions.status, 'PENDING'));
  console.log(`Currently PENDING in queue: ${pending.length}`);

  const completed = await db.select({
      action: scheduledActions,
      prospect: prospects
    })
    .from(scheduledActions)
    .leftJoin(prospects, eq(scheduledActions.prospectId, prospects.id))
    .where(eq(scheduledActions.status, 'COMPLETED'))
    .orderBy(desc(scheduledActions.completedAt))
    .limit(5);
    
  console.log(`\nLast 5 COMPLETED actions:`);
  completed.forEach(c => {
    const pName = (c.prospect?.customAttributes as any)?.name || 'Unknown';
    console.log(`- ${c.action.actionType.toUpperCase()} for ${pName} at ${c.action.completedAt}`);
  });
  
  process.exit(0);
}

check().catch(console.error);
