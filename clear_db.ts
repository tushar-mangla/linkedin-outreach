import { db } from './src/services/db/index.ts';
import { engagementDrafts, engagementPosts } from './src/services/db/schema.ts';

async function main() {
  await db.delete(engagementDrafts);
  await db.delete(engagementPosts);
  console.log('Fake drafts and posts deleted.');
}
main().catch(console.error);
