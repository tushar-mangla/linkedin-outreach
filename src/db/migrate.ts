import pg from 'pg';
const { Client } = pg;
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const runMigrate = async () => {
  const connStr = (process.env.DATABASE_URL || '').replace('-pooler', '');
  const client = new Client({
    connectionString: connStr,
  });

  try {
    await client.connect();
    console.log("Connected to database for migrations.");

    const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
    if (!fs.existsSync(migrationsFolder)) {
      console.log(`No migrations folder found at ${migrationsFolder}`);
      await client.end();
      return;
    }

    const files = fs
      .readdirSync(migrationsFolder)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    console.log(`Found ${files.length} migration file(s): ${files.join(', ')}`);

    for (const file of files) {
      const filePath = path.join(migrationsFolder, file);
      console.log(`\nApplying migration: ${file}`);
      const content = fs.readFileSync(filePath, 'utf-8');

      let statements: string[];
      if (content.includes('--> statement-breakpoint')) {
        statements = content.split('--> statement-breakpoint');
      } else {
        statements = content.split(';');
      }

      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;

        try {
          await client.query(trimmed);
          const snippet = trimmed.slice(0, 80).replace(/\s+/g, ' ');
          console.log(`  ✓ Executed: ${snippet}...`);
        } catch (err: any) {
          const isAlreadyExists =
            err.code === '42P07' || // duplicate_table
            err.code === '42710' || // duplicate_object
            err.code === '42701' || // duplicate_column
            (typeof err.message === 'string' && err.message.toLowerCase().includes('already exists'));

          if (isAlreadyExists) {
            console.log(`  - Skipped (already exists): ${err.message}`);
          } else {
            console.error(`  ✗ Error executing statement:\n${trimmed}`);
            throw err;
          }
        }
      }
    }

    await client.end();
    console.log('\n✓ All migrations applied successfully!');
    process.exit(0);
  } catch (err) {
    try {
      await client.end();
    } catch {
      // ignore
    }
    throw err;
  }
};

runMigrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
