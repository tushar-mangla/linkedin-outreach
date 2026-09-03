import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  jsonb,
  integer,
  boolean,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Core Tables

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const linkedInAccounts = pgTable("linkedin_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  username: varchar("username", { length: 255 }).notNull(),
  // Encrypted password - not stored in plaintext
  encryptedPassword: text("encrypted_password").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const browserSessions = pgTable("browser_sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    linkedInAccountId: uuid("linkedin_account_id").references(() => linkedInAccounts.id).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    // Cookies, local storage, etc.
    sessionData: jsonb("session_data").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


// Prospect & Campaign Tables

export const prospects = pgTable("prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  linkedInUrl: varchar("linkedin_url", { length: 512 }).unique().notNull(),
  profileData: jsonb("profile_data"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  sequenceDefinitionId: uuid("sequence_definition_id").references(() => sequenceDefinitions.id).notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const sequenceDefinitions = pgTable("sequence_definitions", {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const sequenceSteps = pgTable("sequence_steps", {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceDefinitionId: uuid("sequence_definition_id").references(() => sequenceDefinitions.id).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    stepNumber: integer("step_number").notNull(),
    actionType: varchar("action_type", { length: 50 }).notNull(), // e.g., 'CONNECTION_REQUEST', 'MESSAGE', 'LIKE'
    actionParams: jsonb("action_params"),
    delayInDays: integer("delay_in_days").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
});

export const campaignEnrollments = pgTable("campaign_enrollments", {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id).notNull(),
    prospectId: uuid("prospect_id").references(() => prospects.id).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    status: varchar("status", { length: 50 }).notNull().default('active'), // e.g., 'active', 'paused', 'completed', 'failed'
    currentStep: integer("current_step").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});


// Execution & Safety Tables

export const scheduledActions = pgTable("scheduled_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  enrollmentId: uuid("enrollment_id").references(() => campaignEnrollments.id).notNull(),
  sequenceStepId: uuid("sequence_step_id").references(() => sequenceSteps.id).notNull(),
  linkedInAccountId: uuid("linkedin_account_id").references(() => linkedInAccounts.id).notNull(),
  scheduledTime: timestamp("scheduled_time").notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"), // 'pending', 'completed', 'failed', 'skipped'
  executedAt: timestamp("executed_at"),
  executionResult: jsonb("execution_result"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const accountLeases = pgTable("account_leases", {
    id: uuid("id").primaryKey().defaultRandom(),
    linkedInAccountId: uuid("linkedin_account_id").references(() => linkedInAccounts.id).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    leaseHolderId: varchar("lease_holder_id", { length: 255 }).notNull(), // e.g., worker ID
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const approvals = pgTable("approvals", {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id).notNull(),
    resourceId: uuid("resource_id").notNull(), // e.g., scheduledActionId
    resourceType: varchar("resource_type", { length: 50 }).notNull(), // e.g., 'ScheduledAction'
    status: varchar("status", { length: 50 }).notNull().default("pending"), // 'pending', 'approved', 'rejected'
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  userId: uuid("user_id").references(() => users.id),
  event_type: varchar("event_type", { length: 255 }).notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// Relations

export const usersRelations = relations(users, ({ one }) => ({
    tenant: one(tenants, {
        fields: [users.tenantId],
        references: [tenants.id],
    }),
}));

export const linkedInAccountsRelations = relations(linkedInAccounts, ({ one }) => ({
    tenant: one(tenants, {
        fields: [linkedInAccounts.tenantId],
        references: [tenants.id],
    }),
}));

export const campaignsRelations = relations(campaigns, ({ one }) => ({
    tenant: one(tenants, {
        fields: [campaigns.tenantId],
        references: [tenants.id],
    }),
    sequenceDefinition: one(sequenceDefinitions, {
        fields: [campaigns.sequenceDefinitionId],
        references: [sequenceDefinitions.id],
    }),
}));

export const sequenceDefinitionsRelations = relations(sequenceDefinitions, ({ many }) => ({
    steps: many(sequenceSteps),
}));

export const sequenceStepsRelations = relations(sequenceSteps, ({ one }) => ({
    sequenceDefinition: one(sequenceDefinitions, {
        fields: [sequenceSteps.sequenceDefinitionId],
        references: [sequenceDefinitions.id],
    }),
}));

export const campaignEnrollmentsRelations = relations(campaignEnrollments, ({ one }) => ({
    campaign: one(campaigns, {
        fields: [campaignEnrollments.campaignId],
        references: [campaigns.id],
    }),
    prospect: one(prospects, {
        fields: [campaignEnrollments.prospectId],
        references: [prospects.id],
    }),
}));

export const scheduledActionsRelations = relations(scheduledActions, ({ one }) => ({
    enrollment: one(campaignEnrollments, {
        fields: [scheduledActions.enrollmentId],
        references: [campaignEnrollments.id],
    }),
    step: one(sequenceSteps, {
        fields: [scheduledActions.sequenceStepId],
        references: [sequenceSteps.id],
    }),
    account: one(linkedInAccounts, {
        fields: [scheduledActions.linkedInAccountId],
        references: [linkedInAccounts.id],
    }),
}));
