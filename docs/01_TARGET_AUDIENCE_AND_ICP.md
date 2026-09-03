# Feature 1: Target Audience & Ideal Customer Profile (ICP)

This document details the production-hardened pipeline for ingesting, validating, scoring, and staging potential outreach targets. The primary goal is to ensure that only high-quality, relevant prospects enter the outreach sequence through a deterministic and auditable process.

## 1. Architecture: The Profile Acquisition Pipeline

The ICP pipeline is a linear, multi-stage process that transforms raw LinkedIn profile URLs into scored, validated, and deduplicated `Prospect` records, ready for enrollment into campaigns.

```mermaid
graph TD
    A[Raw URL Ingestion] --> B(URL Normalization);
    B --> C(Profile Data Acquisition);
    C --> D{Schema Validation (Zod)};
    D --> E(Deterministic Filters);
    E --> F(AI Scoring & Validation);
    F --> G{Confidence Gate};
    G -- High --> H[Staged for Campaign];
    G -- Medium --> I[Human Review Queue];
    G -- Low --> J[Rejected];
```

### Pipeline Stages Explained:

1.  **URL Normalization**: Raw URLs are cleaned to a canonical format (e.g., `https://www.linkedin.com/in/username/`) to serve as the primary key for deduplication.
2.  **Profile Data Acquisition**: The system scrapes the profile data. The raw JSON output is stored with metadata (source, timestamp, content hash) for auditing and to avoid redundant scrapes.
3.  **Schema Validation**: The raw JSON is parsed and validated against a strict Zod schema to ensure data integrity before further processing.
4.  **Deterministic Filters**: The validated profile is passed through a series of hard-coded, deterministic filters (e.g., Geography, Title Keywords, Company Size, Exclusion Lists). A failure here immediately rejects the prospect. This step ensures that the more expensive AI scoring is only used on pre-qualified candidates.
5.  **AI Scoring**: Profiles that pass deterministic filters are sent to the local Ollama model for ICP scoring. The model's JSON output is **strictly validated** by a `IcpScoreSchema` using Zod. Failures trigger retries or are sent to a manual review queue.
6.  **Confidence Gate**: The validated AI score is used to route the prospect:
    *   **High Confidence**: Automatically staged for campaign enrollment.
    *   **Medium Confidence**: Flagged for mandatory human review.
    *   **Low Confidence**: Automatically rejected.

## 2. Correct Deduplication Strategy

The system employs a two-table strategy to manage prospects and their campaign participation, ensuring correct deduplication without improperly blocking future outreach.

*   **`prospects` Table**: This is the canonical record for an individual, uniquely identified by their `normalizedLinkedInUrl`. It stores their profile data, ICP score, and global contact policy status. A person exists here only once.
*   **`campaign_members` Table**: This is a join table representing a specific prospect's participation in a specific campaign. The unique key is `(campaignId, prospectId)`.

**Core Logic**:
*   When ingesting a new list, the system checks if a prospect with the given normalized URL already exists in the `prospects` table.
*   **If the prospect exists**: The system does **not** reject them globally. Instead, it checks business logic and contact policies (e.g., "Has this person been contacted in the last 90 days?"). If policies permit, the existing prospect can be added to a *new* campaign by creating a new `campaign_members` entry.
*   **If the prospect does not exist**: A new record is created in the `prospects` table after passing through the full acquisition pipeline.

This approach correctly separates the identity of a person from their participation in a campaign, allowing for re-engagement over time in different contexts while preventing duplicate entries for the same person.

## 3. Data Models & Validation

### Drizzle Schema (`src/db/schema.ts`)

The `prospects` table is the source of truth for all acquired profile data.

```typescript
import { pgTable, serial, text, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const prospects = pgTable('prospects', {
  id: serial('id').primaryKey(),
  normalizedLinkedInUrl: varchar('normalized_linkedin_url', { length: 256 }).notNull().unique(),
  fullName: varchar('full_name', { length: 128 }),
  title: varchar('title', { length: 256 }),
  company: varchar('company', { length: 256 }),
  location: varchar('location', { length: 128 }),
  // Raw data storage
  rawProfileData: jsonb('raw_profile_data'),
  rawProfileDataHash: varchar('raw_profile_data_hash', { length: 64 }),
  // Scoring and validation
  icpScore: jsonb('icp_score'),
  icpConfidence: varchar('icp_confidence', { length: 50 }), // 'HIGH', 'MEDIUM', 'LOW'
  icpRationale: text('icp_rationale'),
  // Timestamps
  lastAcquiredAt: timestamp('last_acquired_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    urlIndex: index('url_idx').on(table.normalizedLinkedInUrl),
  };
});
```

### Zod Schema for AI Output (`src/schemas/ai.ts`)

All output from the Ollama model for ICP scoring is rigorously validated against this schema.

```typescript
import { z } from 'zod';

export const IcpScoreSchema = z.object({
  isIcpFit: z.boolean(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  score: z.object({
    roleSeniority: z.number().min(0).max(5),
    industryMatch: z.number().min(0).max(5),
    companySize: z.number().min(0).max(5),
    keywordsMatch: z.number().min(0).max(5),
  }),
  rationale: z.string().min(20),
});

export type IcpScore = z.infer<typeof IcpScoreSchema>;
```
