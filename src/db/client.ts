import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
const { Pool } = pg;
import * as dotenv from 'dotenv';
import * as schema from './schema.js';

dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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
