
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
const { Pool } = pg;
import * as schema from './schema.js';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

const db = drizzle(pool, { schema });

async function main() {
  const tableNames = [
    'prospects',
    'dailyActionBudgets',
    'icpDefinitions',
    'importBatches',
    'icpEvaluations',
    'accountLeases',
    'drizzle_migrations',
  ];
  for (const tableName of tableNames) {
    console.log(`Dropping table: ${tableName}`);
    await pool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`);
  }
  console.log('All tables dropped.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
