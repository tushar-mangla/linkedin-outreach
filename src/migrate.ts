
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { config } from 'dotenv';
import { createPool } from './db/client.js';

config();

const runMigrations = async () => {
  const pool = createPool({ max: 2 });

  const db = drizzle(pool);

  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log('Migrations completed.');

  await pool.end();
};

runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});

