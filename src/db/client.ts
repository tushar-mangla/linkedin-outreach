import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
const { Pool } = pg;
import * as dotenv from 'dotenv';
import * as schema from './schema.js';
import { isTransientDbError, withDbRetry, TransientDbError } from './retry.js';

dotenv.config();

export function normalizeConnectionString(raw?: string): string | undefined {
  return raw
    ? raw.replace(/([?&])sslmode=require\b/g, '$1sslmode=verify-full')
    : undefined;
}

export function createPool(overrides?: pg.PoolConfig): pg.Pool {
  const connectionString = normalizeConnectionString(process.env.DATABASE_URL);

  const pool = new Pool({
    connectionString,
    max: 10,
    // Discard idle connections proactively before Neon's 5m suspend
    idleTimeoutMillis: 30000,
    // Allow up to 30s for Neon compute to wake up from cold start (scale to 0)
    connectionTimeoutMillis: 30000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: 'recruitmentos',
    ...overrides,
  });

  // Handle idle client connection drops (e.g. Neon serverless resets) gracefully without crashing process
  pool.on('error', (err) => {
    // Suppress unhandled error crashes from idle socket drops by Neon compute suspend
    console.warn('[Postgres Pool] Idle client connection drop recovered:', err.message);
  });

  return pool;
}

const pool = createPool();

export const db = drizzle(pool, { schema });
export type DbClient = typeof db;

export { isTransientDbError, withDbRetry, TransientDbError };

export async function withTenantTransaction<T>(
    tenantId: string,
    callback: (transaction: any) => Promise<T>,
): Promise<T> {
    return db.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
        return callback(transaction);
    });
}

