import 'dotenv/config';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

async function runDiagnostic() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set in environment.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const client = await pool.connect();
    try {
      console.log('--- 1. Target Database Identity ---');
      const identityRes = await client.query(`
        SELECT current_database(), current_schema(), current_user, version();
      `);
      console.log('Target database:', identityRes.rows[0].current_database);
      console.log('Current schema:', identityRes.rows[0].current_schema);
      console.log('Current user:', identityRes.rows[0].current_user);
      console.log('Postgres version:', identityRes.rows[0].version.split(' ')[0], identityRes.rows[0].version.split(' ')[1]);

      console.log('\n--- 2. Migration Ledger Tables ---');
      const ledgersRes = await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name = '__drizzle_migrations';
      `);
      console.log('Found __drizzle_migrations tables in schemas:', ledgersRes.rows.map(r => r.table_schema));

      for (const row of ledgersRes.rows) {
        const schema = row.table_schema;
        console.log(`\nEntries in ${schema}.__drizzle_migrations:`);
        const entriesRes = await client.query(`
          SELECT id, hash, created_at
          FROM "${schema}"."__drizzle_migrations"
          ORDER BY id ASC;
        `);
        for (const entry of entriesRes.rows) {
          console.log(`  id=${entry.id}, hash=${entry.hash}, created_at=${entry.created_at} (${new Date(Number(entry.created_at)).toISOString()})`);
        }
      }

      console.log('\n--- 3. Key Tables in Public Schema ---');
      const tablesToCheck = [
        'recommendation_revisions',
        'recommendation_approvals',
        'manual_tasks',
        'engagement_controls',
        'browser_accounts',
        'execution_evidence',
        'scheduled_actions',
        'engagement_posts',
        'account_post_comments',
        'engagement_drafts'
      ];

      const tablesRes = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
        ORDER BY table_name;
      `, [tablesToCheck]);
      const existingTables = new Set(tablesRes.rows.map(r => r.table_name));

      for (const t of tablesToCheck) {
        console.log(`  Table "${t}": ${existingTables.has(t) ? 'EXISTS' : 'DOES NOT EXIST'}`);
      }

      console.log('\n--- 4. Columns of scheduled_actions ---');
      if (existingTables.has('scheduled_actions')) {
        const schedCols = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'scheduled_actions'
          ORDER BY ordinal_position;
        `);
        console.log('scheduled_actions columns:', schedCols.rows.map(r => r.column_name).join(', '));
      }

      console.log('\n--- 5. Columns of engagement_posts ---');
      if (existingTables.has('engagement_posts')) {
        const postCols = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'engagement_posts'
          ORDER BY ordinal_position;
        `);
        console.log('engagement_posts columns:', postCols.rows.map(r => r.column_name).join(', '));
      }

      console.log('\n--- 6. Columns of recommendation_revisions (if exists) ---');
      if (existingTables.has('recommendation_revisions')) {
        const revCols = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'recommendation_revisions'
          ORDER BY ordinal_position;
        `);
        console.log('recommendation_revisions columns:', revCols.rows.map(r => r.column_name).join(', '));
      }

      console.log('\n--- 7. Constraints on recommendation_revisions ---');
      if (existingTables.has('recommendation_revisions')) {
        const constrRes = await client.query(`
          SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
          WHERE conrelid = 'public.recommendation_revisions'::regclass;
        `);
        for (const c of constrRes.rows) {
          console.log(`  ${c.conname}: ${c.def}`);
        }
      }

      console.log('\n--- 8. Local Migration Files & Expected Hashes ---');
      const journalPath = path.resolve('drizzle/meta/_journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      for (const entry of journal.entries) {
        const sqlPath = path.resolve(`drizzle/${entry.tag}.sql`);
        if (fs.existsSync(sqlPath)) {
          const content = fs.readFileSync(sqlPath, 'utf8');
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          console.log(`  Entry ${entry.idx} [${entry.tag}]: when=${entry.when} hash=${hash}`);
        } else {
          console.log(`  Entry ${entry.idx} [${entry.tag}]: FILE MISSING`);
        }
      }

      // Also check 0006 if not in journal yet
      const sql0006 = path.resolve('drizzle/0006_comment_slot_claims.sql');
      if (fs.existsSync(sql0006)) {
        const content = fs.readFileSync(sql0006, 'utf8');
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        console.log(`  Unregistered file [0006_comment_slot_claims.sql]: hash=${hash}`);
      }

    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

runDiagnostic().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
