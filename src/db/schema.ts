
import { pgTable, text, timestamp, uuid, varchar, json, boolean, integer, pgEnum, uniqueIndex, real } from 'drizzle-orm/pg-core';

export const prospectStageEnum = pgEnum('prospect_stage', [
  'INGESTED',
  'FILTERED_OUT',
  'EVALUATED',
  'REQUIRES_REVIEW',
  'READY_FOR_CAMPAIGN',
  'APPROVED_FOR_OUTREACH',
  'REJECTED',
]);

export const prospects = pgTable('prospects', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  linkedinUrl: varchar('linkedin_url', { length: 255 }).notNull(),
  normalizedLinkedinUrl: text('normalized_linkedin_url').notNull(),
  currentStage: prospectStageEnum('current_stage').notNull().default('INGESTED'),
  customAttributes: json('custom_attributes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    tenantIdNormalizedUrlIndex: uniqueIndex('tenant_id_normalized_url_idx').on(table.tenantId, table.normalizedLinkedinUrl),
  };
});

export const candidates = prospects;

export const dailyActionBudgets = pgTable('daily_action_budgets', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    accountId: uuid('account_id').notNull(),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    budgetDate: timestamp('budget_date').notNull(),
    limit: integer('limit').notNull(),
    reservedCount: integer('reserved_count').default(0).notNull(),
    completedCount: integer('completed_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
    return {
        tenantIdAccountIdActionTypeBudgetDateIndex: uniqueIndex('tenant_id_account_id_action_type_budget_date_idx').on(table.tenantId, table.accountId, table.actionType, table.budgetDate),
    };
});

export const budgetReservations = pgTable('budget_reservations', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    accountId: uuid('account_id').notNull(),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    budgetDate: timestamp('budget_date').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('RESERVED'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const icpDefinitions = pgTable('icp_definitions', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    criteria: json('criteria').notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const recruitmentRoles = icpDefinitions;

export const importBatches = pgTable('import_batches', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    icpDefinitionId: uuid('icp_definition_id').references(() => icpDefinitions.id),
    filename: varchar('filename', { length: 255 }).notNull(),
    totalRows: integer('total_rows').notNull(),
    processedRows: integer('processed_rows').default(0).notNull(),
    qualifiedCount: integer('qualified_count').default(0).notNull(),
    rejectedCount: integer('rejected_count').default(0).notNull(),
    reviewCount: integer('review_count').default(0).notNull(),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const icpEvaluations = pgTable('icp_evaluations', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    prospectId: uuid('prospect_id').references(() => prospects.id),
    icpDefinitionId: uuid('icp_definition_id').references(() => icpDefinitions.id),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    score: integer('score'),
    confidence: real('confidence'),
    fitBreakdown: json('fit_breakdown'),
    evidence: text('evidence'),
    reasoning: text('reasoning'),
    status: varchar('status', { length: 50 }).notNull(),
    evaluatedBy: varchar('evaluated_by', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const candidateEvaluations = icpEvaluations;

export const reviewDecisions = pgTable('review_decisions', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
    decision: varchar('decision', { length: 20 }).notNull(),
    reason: text('reason').notNull(),
    operatorId: varchar('operator_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditEvents = pgTable('audit_events', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    payload: json('payload').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accountLeases = pgTable('account_leases', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    accountId: uuid('account_id').notNull(),
    workerId: varchar('worker_id', { length: 255 }).notNull(),
    leaseToken: text('lease_token').default('').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    heartbeatAt: timestamp('heartbeat_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
    return {
        tenantIdAccountIdIndex: uniqueIndex('tenant_id_account_id_idx').on(table.tenantId, table.accountId),
    };
});

export const campaigns = pgTable('campaigns', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    roleId: uuid('role_id').references(() => icpDefinitions.id),
    status: varchar('status', { length: 50 }).notNull().default('ACTIVE'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sequenceDefinitions = pgTable('sequence_definitions', {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
    stepOrder: integer('step_order').notNull(),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    delayDays: integer('delay_days').default(0).notNull(),
    template: text('template'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const campaignEnrollments = pgTable('campaign_enrollments', {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
    prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
    currentStep: integer('current_step').default(0).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('ENROLLED'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const scheduledActions = pgTable('scheduled_actions', {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    campaignEnrollmentId: uuid('campaign_enrollment_id').references(() => campaignEnrollments.id),
    prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
    accountId: uuid('account_id').notNull(),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    payload: json('payload'),
    scheduledFor: timestamp('scheduled_for').notNull(),
    status: varchar('status', { length: 50 }).notNull().default('PENDING'),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
    claimedBy: varchar('claimed_by', { length: 255 }),
    claimedAt: timestamp('claimed_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

