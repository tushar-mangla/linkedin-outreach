import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

async function reconcileLedger() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const client = await pool.connect();
  try {
    console.log('=== Starting Migration Ledger Reconciliation ===');
    await client.query('BEGIN');

    // 1. Target check
    const idRes = await client.query('SELECT current_database(), current_schema(), current_user;');
    console.log('Connected to:', idRes.rows[0]);

    // 2. Preflight confirmation: 0004 and 0005 objects exist
    const checkObj = await client.query(`
      SELECT to_regclass('public.recommendation_revisions') AS rec_rev,
             to_regclass('public.recommendation_approvals') AS rec_app,
             to_regclass('public.manual_tasks') AS man_tasks,
             to_regclass('public.engagement_controls') AS eng_ctrl,
             to_regclass('public.browser_accounts') AS brow_acc,
             to_regclass('public.execution_evidence') AS exec_ev;
    `);
    const row = checkObj.rows[0];
    const allPresent = Object.values(row).every(v => v !== null);
    if (!allPresent) {
      throw new Error(`Cannot baseline: missing 0004 objects: ${JSON.stringify(row)}`);
    }
    console.log('0004 tables confirmed present.');

    const schedCol = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scheduled_actions' AND column_name = 'claim_token';
    `);
    if (schedCol.rows.length === 0) {
      throw new Error('Cannot baseline: missing 0005 claim_token column on scheduled_actions');
    }
    console.log('0005 claim_token column confirmed present.');

    // 3. Check existing entries in drizzle.__drizzle_migrations
    const existingDrizzle = await client.query(`
      SELECT id, hash, created_at
      FROM "drizzle"."__drizzle_migrations"
      ORDER BY id ASC;
    `);
    console.log('Current drizzle.__drizzle_migrations count:', existingDrizzle.rows.length);

    const m0004 = {
      hash: '32e710ed8de55f80332c55977db670e7a57b6c4bbd856437c38ecd174690726d',
      created_at: '1788524358112',
      tag: '0004_supervised_execution',
    };

    const m0005 = {
      hash: '49088250aed632926c1a69514f808fa3691d02f5fa38dc800a5c1b85bbf36992',
      created_at: '1788600000000',
      tag: '0005_supervised_hardening',
    };

    const has0004 = existingDrizzle.rows.some(r => r.created_at === m0004.created_at);
    if (!has0004) {
      console.log(`Inserting baseline ledger entry for ${m0004.tag}...`);
      await client.query(`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES ($1, $2);
      `, [m0004.hash, m0004.created_at]);
    } else {
      console.log(`Ledger entry for ${m0004.tag} already present.`);
    }

    const has0005 = existingDrizzle.rows.some(r => r.created_at === m0005.created_at);
    if (!has0005) {
      console.log(`Inserting baseline ledger entry for ${m0005.tag}...`);
      await client.query(`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES ($1, $2);
      `, [m0005.hash, m0005.created_at]);
    } else {
      console.log(`Ledger entry for ${m0005.tag} already present.`);
    }

    // Also sync public.__drizzle_migrations if it exists
    const publicTableCheck = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '__drizzle_migrations';
    `);
    if (publicTableCheck.rows.length > 0) {
      console.log('Syncing public.__drizzle_migrations to mirror drizzle.__drizzle_migrations...');
      const publicRows = await client.query(`SELECT id, hash, created_at FROM public.__drizzle_migrations;`);
      if (publicRows.rows.length === 0) {
        // Copy all from drizzle.__drizzle_migrations
        await client.query(`
          INSERT INTO public.__drizzle_migrations (id, hash, created_at)
          SELECT id, hash, created_at FROM drizzle.__drizzle_migrations
          ON CONFLICT (id) DO NOTHING;
        `);
      }
    }

    await client.query('COMMIT');
    console.log('Reconciliation transaction COMMITTED successfully.');

    // Print final ledger
    const finalRes = await client.query(`
      SELECT id, hash, created_at
      FROM "drizzle"."__drizzle_migrations"
      ORDER BY id ASC;
    `);
    console.log('\nFinal drizzle.__drizzle_migrations entries:');
    for (const r of finalRes.rows) {
      console.log(`  id=${r.id}, created_at=${r.created_at}, hash=${r.hash}`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reconciliation rolled back due to error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

reconcileLedger().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
