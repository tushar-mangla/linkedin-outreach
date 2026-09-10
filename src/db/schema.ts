
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
  revisionId: uuid('revision_id'),
  postHash: varchar('post_hash', { length: 64 }),
  mode: varchar('mode', { length: 20 }),
  outcomeLabel: varchar('outcome_label', { length: 30 }),
  errorCode: varchar('error_code', { length: 80 }),
  claimToken: text('claim_token'),
    claimedBy: varchar('claimed_by', { length: 255 }),
    claimedAt: timestamp('claimed_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantIdempotencyIdx: uniqueIndex('tenant_idempotency_key_idx').on(table.tenantId, table.idempotencyKey),
}));

// ─── Feature 2: Engagement tables ────────────────────────────────────────────

export const postSourceTypeEnum = pgEnum('post_source_type', ['PLAYWRIGHT', 'FIXTURE', 'MANUAL']);
export const draftStatusEnum = pgEnum('draft_status', ['PENDING', 'APPROVED', 'EDITED', 'SKIPPED', 'REJECTED']);
export const engagementActionTypeEnum = pgEnum('engagement_action_type', ['LIKE', 'COMMENT']);

export const engagementPosts = pgTable('engagement_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
  postUrl: text('post_url').notNull(),
  canonicalPostIdentifier: text('canonical_post_identifier').notNull(),
  postText: text('post_text').notNull(),
  authorName: varchar('author_name', { length: 255 }).notNull().default(''),
  publishedAt: timestamp('published_at'),
  sourceType: postSourceTypeEnum('source_type').notNull().default('FIXTURE'),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tenantCanonicalPostIdx: uniqueIndex('tenant_canonical_post_idx').on(table.tenantId, table.canonicalPostIdentifier),
}));

export const engagementDrafts = pgTable('engagement_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  postId: uuid('post_id').notNull().references(() => engagementPosts.id),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
  actionType: engagementActionTypeEnum('action_type').notNull().default('COMMENT'),
  commentText: text('comment_text').notNull(),
  editedText: text('edited_text'),
  status: draftStatusEnum('status').notNull().default('PENDING'),
  provider: varchar('provider', { length: 50 }).notNull().default('fake'),
  providerMetadata: json('provider_metadata'),
  validationReport: json('validation_report'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const recommendationRevisions = pgTable('recommendation_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  draftId: uuid('draft_id').notNull().references(() => engagementDrafts.id),
  revision: integer('revision').notNull(),
  actionType: engagementActionTypeEnum('action_type').notNull(),
  postHash: varchar('post_hash', { length: 64 }).notNull(),
  commentText: text('comment_text').notNull(),
  evidence: json('evidence').notNull(),
  validationReport: json('validation_report').notNull(),
  state: varchar('state', { length: 30 }).notNull().default('PENDING'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tenantDraftRevisionIdx: uniqueIndex('tenant_draft_revision_idx').on(table.tenantId, table.draftId, table.revision),
}));

export const recommendationApprovals = pgTable('recommendation_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  revisionId: uuid('revision_id').notNull().references(() => recommendationRevisions.id),
  actionType: engagementActionTypeEnum('action_type').notNull(),
  operatorId: varchar('operator_id', { length: 255 }).notNull(),
  state: varchar('state', { length: 30 }).notNull().default('APPROVED'),
  reason: text('reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at'),
});

export const manualTasks = pgTable('manual_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  scheduledActionId: uuid('scheduled_action_id').references(() => scheduledActions.id),
  actionType: engagementActionTypeEnum('action_type').notNull(),
  status: varchar('status', { length: 30 }).notNull().default('PENDING_CONFIRMATION'),
  outcomeLabel: varchar('outcome_label', { length: 30 }),
  confirmationActor: varchar('confirmation_actor', { length: 255 }),
  confirmationMetadata: json('confirmation_metadata'),
  errorCode: varchar('error_code', { length: 80 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const engagementControls = pgTable('engagement_controls', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  actionType: engagementActionTypeEnum('action_type').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  killSwitchActive: boolean('kill_switch_active').notNull().default(false),
  cooldownUntil: timestamp('cooldown_until'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  tenantAccountActionIdx: uniqueIndex('tenant_account_action_control_idx').on(table.tenantId, table.accountId, table.actionType),
}));

export const browserAccounts = pgTable('browser_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  label: varchar('label', { length: 255 }).notNull(),
  keyVersion: varchar('key_version', { length: 50 }),
  health: varchar('health', { length: 30 }).notNull().default('PAUSED'),
  sessionExpiresAt: timestamp('session_expires_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const executionEvidence = pgTable('execution_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  scheduledActionId: uuid('scheduled_action_id').notNull().references(() => scheduledActions.id),
  executorMode: varchar('executor_mode', { length: 20 }).notNull(),
  outcomeLabel: varchar('outcome_label', { length: 30 }).notNull(),
  evidenceHash: varchar('evidence_hash', { length: 64 }),
  selectorVersion: varchar('selector_version', { length: 50 }),
  redactedReference: text('redacted_reference'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const engagementHistory = pgTable('engagement_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
  postId: uuid('post_id').notNull().references(() => engagementPosts.id),
  actionType: engagementActionTypeEnum('action_type').notNull(),
  interactedAt: timestamp('interacted_at').defaultNow().notNull(),
  operatorId: varchar('operator_id', { length: 255 }).notNull(),
  scheduledActionId: uuid('scheduled_action_id').references(() => scheduledActions.id),
}, (table) => ({
  scheduledActionUniqueIdx: uniqueIndex('engagement_history_scheduled_action_id_idx').on(table.scheduledActionId),
}));

// ─── Feature: Account-level post comment mapping ──────────────────────────────
// Strict 1-to-1 mapping of (tenant, account, post) → comment status.
// This is the single source of truth for whether we have commented on a post.
// Status lifecycle: PENDING → COMPLETED | FAILED
// - PENDING: comment is queued and has not run yet
// - COMPLETED: comment was successfully posted on LinkedIn
// - FAILED: the comment attempt failed (re-queuing is allowed)
export const accountPostComments = pgTable('account_post_comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  accountId: uuid('account_id').notNull(),
  postHash: varchar('post_hash', { length: 64 }).notNull(),
  canonicalPostIdentifier: text('canonical_post_identifier').notNull(),
  postUrl: text('post_url').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('PENDING'), // PENDING | COMPLETED | FAILED | UNCERTAIN
  scheduledActionId: uuid('scheduled_action_id'), // link back to the action that owns this slot
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  // Guarantees at most one row per account+post — the core deduplication constraint
  accountCanonicalPostUniqueIdx: uniqueIndex('account_canonical_post_unique_idx').on(table.tenantId, table.accountId, table.canonicalPostIdentifier),
}));
