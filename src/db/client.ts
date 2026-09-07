import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
const { Pool } = pg;
import * as dotenv from 'dotenv';
import * as schema from './schema.js';

dotenv.config();

const connectionString = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/([?&])sslmode=require\b/g, '$1sslmode=verify-full')
    : undefined;

const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Handle idle client connection drops (e.g. Neon serverless resets) gracefully without crashing process
pool.on('error', (err) => {
    console.warn('[Postgres Pool] Idle client connection drop recovered:', err.message);
});

export const db = drizzle(pool, { schema });
export type DbClient = typeof db;

export async function withTenantTransaction<T>(
    tenantId: string,
    callback: (transaction: any) => Promise<T>,
): Promise<T> {
    return db.transaction(async (transaction) => {
        await transaction.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
        return callback(transaction);
    });
}
