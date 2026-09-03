
import { PersistentIcpPipeline } from './persistent-pipeline.js';
import { db } from '../../db/index.js';
import { DrizzleAdapter } from '../../db/drizzle-adapter.js';
import { FakeAIProvider } from './ai-provider.js';

// This file would contain the high-level API for the ICP service.
// For now, it just re-exports the persistent pipeline.

const dbAdapter = new DrizzleAdapter(db);
export const icpPipeline = new PersistentIcpPipeline(dbAdapter, new FakeAIProvider());
