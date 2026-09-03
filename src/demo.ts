
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {
    sqliteTable,
    text,
    integer,
  } from "drizzle-orm/sqlite-core";
import { SafetyGate } from '@/core/safety-gate.js';
import { FakeActionExecutor } from '@/core/executor.js';
import { recordAuditEvent } from '@/core/audit.js';
import chalk from 'chalk';
import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// --- In-Memory DB Schema ---
export const tenants = sqliteTable("tenants", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").unique().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const linkedInAccounts = sqliteTable("linkedin_accounts", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    username: text("username").notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const prospects = sqliteTable("prospects", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    linkedInUrl: text("linkedin_url").unique().notNull(),
    profileData: text("profile_data"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const sequenceDefinitions = sqliteTable("sequence_definitions", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const sequenceSteps = sqliteTable("sequence_steps", {
    id: text("id").primaryKey(),
    sequenceDefinitionId: text("sequence_definition_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    stepNumber: integer("step_number").notNull(),
    actionType: text("action_type").notNull(),
    actionParams: text("action_params"),
    delayInDays: integer("delay_in_days").notNull().default(0),
    createdAt: text("created_at").notNull(),
});
export const campaigns = sqliteTable("campaigns", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    sequenceDefinitionId: text("sequence_definition_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const campaignEnrollments = sqliteTable("campaign_enrollments", {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    prospectId: text("prospect_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    status: text("status").notNull().default('active'),
    currentStep: integer("current_step").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
export const scheduledActions = sqliteTable("scheduled_actions", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    enrollmentId: text("enrollment_id").notNull(),
    sequenceStepId: text("sequence_step_id").notNull(),
    linkedInAccountId: text("linkedin_account_id").notNull(),
    scheduledTime: text("scheduled_time").notNull(),
    status: text("status").notNull().default("pending"),
    executedAt: text("executed_at"),
    executionResult: text("execution_result"),
    createdAt: text("created_at").notNull(),
});
export const approvals = sqliteTable("approvals", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceType: text("resource_type").notNull(),
    status: text("status").notNull().default("pending"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    createdAt: text("created_at").notNull(),
});
export const auditEvents = sqliteTable("audit_events", {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id"),
    event_type: text("event_type").notNull(),
    payload: text("payload"),
    createdAt: text("created_at").notNull(),
});

const schema = {
    tenants, users, linkedInAccounts, prospects, sequenceDefinitions, sequenceSteps, campaigns, campaignEnrollments, scheduledActions, approvals, auditEvents
};

// --- In-Memory DB Setup ---
const sqlite = new Database(':memory:');
const db = drizzle(sqlite, { schema });

async function createSchema() {
    console.log(chalk.blue('Creating in-memory schema...'));
    sqlite.exec(`
        CREATE TABLE tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE linkedin_accounts (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            username TEXT NOT NULL,
            encrypted_password TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE prospects (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            linkedin_url TEXT NOT NULL UNIQUE,
            profile_data TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE sequence_definitions (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE sequence_steps (
            id TEXT PRIMARY KEY,
            sequence_definition_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            step_number INTEGER NOT NULL,
            action_type TEXT NOT NULL,
            action_params TEXT,
            delay_in_days INTEGER DEFAULT 0 NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE campaigns (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            sequence_definition_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE campaign_enrollments (
            id TEXT PRIMARY KEY,
            campaign_id TEXT NOT NULL,
            prospect_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            status TEXT DEFAULT 'active' NOT NULL,
            current_step INTEGER DEFAULT 1 NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE scheduled_actions (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            enrollment_id TEXT NOT NULL,
            sequence_step_id TEXT NOT NULL,
            linkedin_account_id TEXT NOT NULL,
            scheduled_time TEXT NOT NULL,
            status TEXT DEFAULT 'pending' NOT NULL,
            executed_at TEXT,
            execution_result TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE approvals (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            status TEXT DEFAULT 'pending' NOT NULL,
            approved_by TEXT,
            approved_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE audit_events (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            user_id TEXT,
            event_type TEXT NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL
        );
    `);
    console.log(chalk.green('In-memory schema created.'));
}


// --- Mock Data ---
const tenantId = randomUUID();
const userId = randomUUID();
const linkedInAccountId = randomUUID();
const prospectId = randomUUID();
const campaignId = randomUUID();
const sequenceDefinitionId = randomUUID();
const sequenceStepId = randomUUID();
const enrollmentId = randomUUID();
const unapprovedActionId = randomUUID();
const approvedActionId = randomUUID();

async function setupMockData() {
  console.log(chalk.blue('Setting up in-memory mock data...'));
  const now = new Date().toISOString();

  await db.insert(tenants).values({ id: tenantId, name: 'Demo Tenant', createdAt: now, updatedAt: now });
  await db.insert(users).values({ id: userId, tenantId, email: 'demo@user.com', createdAt: now, updatedAt: now });
  await db.insert(linkedInAccounts).values({ id: linkedInAccountId, tenantId, username: 'demo-linkedin', encryptedPassword: '...', createdAt: now, updatedAt: now });
  await db.insert(prospects).values({ id: prospectId, tenantId, linkedInUrl: 'https://linkedin.com/in/prospect', createdAt: now, updatedAt: now });
  await db.insert(sequenceDefinitions).values({ id: sequenceDefinitionId, tenantId, name: 'Demo Sequence', createdAt: now, updatedAt: now });
  await db.insert(sequenceSteps).values({ id: sequenceStepId, sequenceDefinitionId, tenantId, stepNumber: 1, actionType: 'MESSAGE', delayInDays: 1, createdAt: now });
  await db.insert(campaigns).values({ id: campaignId, tenantId, name: 'Demo Campaign', sequenceDefinitionId, createdAt: now, updatedAt: now });
  await db.insert(campaignEnrollments).values({ id: enrollmentId, campaignId, prospectId, tenantId, createdAt: now, updatedAt: now });

  // Unapproved Action
  await db.insert(scheduledActions).values({
    id: unapprovedActionId,
    tenantId,
    enrollmentId,
    sequenceStepId,
    linkedInAccountId,
    scheduledTime: now,
    createdAt: now,
  });
  await db.insert(approvals).values({
    id: randomUUID(),
    tenantId,
    resourceId: unapprovedActionId,
    resourceType: 'ScheduledAction',
    status: 'pending',
    createdAt: now,
  });

  // Approved Action
  await db.insert(scheduledActions).values({
    id: approvedActionId,
    tenantId,
    enrollmentId,
    sequenceStepId,
    linkedInAccountId,
    scheduledTime: now,
    createdAt: now,
  });
  await db.insert(approvals).values({
    id: randomUUID(),
    tenantId,
    resourceId: approvedActionId,
    resourceType: 'ScheduledAction',
    status: 'approved',
    approvedBy: userId,
    approvedAt: now,
    createdAt: now,
  });

  console.log(chalk.green('Mock data setup complete.'));
}

// --- Demo Logic ---
async function runDemo() {
  console.log(chalk.yellow.bold('\n--- LinkedIn Outreach Demo ---'));

  await createSchema();
  await setupMockData();

  // --- 1. SafetyGate Demonstration ---
  console.log(chalk.cyan.bold('\n\n--- 1. SafetyGate Demonstration ---'));

  // Test Case: Unapproved Action (should fail)
  console.log(chalk.magenta('\nTesting SafetyGate with an unapproved action...'));
  const unapprovedGate = new SafetyGate({ tenantId, scheduledActionId: unapprovedActionId, isDryRun: false, db: db as any });
  try {
    await unapprovedGate.check();
    console.log(chalk.green('SafetyGate check passed (unexpected).'));
  } catch (error) {
    console.log(chalk.red(`SafetyGate check failed as expected: ${(error as Error).message}`));
  }

  // Test Case: Approved Action (should pass)
  console.log(chalk.magenta('\nTesting SafetyGate with an approved action...'));
  const approvedGate = new SafetyGate({ tenantId, scheduledActionId: approvedActionId, isDryRun: false, db: db as any });
  try {
    await approvedGate.check();
    console.log(chalk.green('SafetyGate check passed successfully.'));
  } catch (error) {
    console.log(chalk.red(`SafetyGate check failed unexpectedly: ${(error as Error).message}`));
  }

  // --- 2. FakeActionExecutor Demonstration ---
  console.log(chalk.cyan.bold('\n\n--- 2. FakeActionExecutor Demonstration ---'));
  const executor = new FakeActionExecutor(tenantId, db as any);
  const actionToExecute = (await db.select().from(scheduledActions).where(eq(scheduledActions.id, approvedActionId)))[0];
  
  const actionWithDateObjects = {
    ...actionToExecute,
    createdAt: new Date(actionToExecute.createdAt),
    scheduledTime: new Date(actionToExecute.scheduledTime),
    executedAt: actionToExecute.executedAt ? new Date(actionToExecute.executedAt) : null,
  };

  const executionResult = await executor.execute(actionWithDateObjects);
  console.log(chalk.blue('Execution Result:'), executionResult);


  // --- 3. AuditLogger Demonstration ---
  console.log(chalk.cyan.bold('\n\n--- 3. AuditLogger Demonstration ---'));
  const auditPayload = {
    action: 'demo.run',
    timestamp: new Date().toISOString(),
    details: 'This is a demonstration audit event.',
  };

  const payloadHash = createHash('sha256').update(JSON.stringify(auditPayload)).digest('hex');

  await recordAuditEvent({
    id: randomUUID(),
    tenantId,
    userId,
    event_type: 'demo.run',
    payload: auditPayload,
  }, db as any);
  
  console.log(chalk.blue('Audit event recorded.'));
  console.log(chalk.blue(`Payload SHA-256 Hash: ${payloadHash}`));

  const allAuditEvents = await db.select().from(auditEvents);
  console.log(chalk.yellow('\n--- All Audit Events in DB ---'));
  console.table(allAuditEvents);


  console.log(chalk.yellow.bold('\n--- Demo Complete ---'));
}

runDemo().catch(console.error);
