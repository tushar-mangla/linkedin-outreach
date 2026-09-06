import { describe, expect, it } from 'vitest';
import { PersistentIcpPipeline } from './persistent-pipeline.js';

describe('PersistentIcpPipeline duplicate safety', () => {
  it('preserves an existing READY_FOR_CAMPAIGN prospect during discovery ingestion', async () => {
    const existing = {
      id: 'prospect-1',
      tenantId: 'tenant-1',
      linkedinUrl: 'https://linkedin.com/in/alice-founder',
      normalizedLinkedinUrl: 'https://linkedin.com/in/alice-founder',
      customAttributes: { name: 'Alice Founder' },
      currentStage: 'READY_FOR_CAMPAIGN',
    };
    const updates: unknown[] = [];
    const adapter = {
      insertImportBatch: async () => ({ id: 'batch-1' }),
      findProspectByTenantAndUrl: async () => existing,
      insertProspect: async () => { throw new Error('duplicate must not be inserted'); },
      updateProspect: async (...args: unknown[]) => { updates.push(args); return existing; },
      findIcpDefinitionById: async () => ({
        id: 'icp-1',
        criteria: { titles: ['Founder'], industry: [], geography: [], qualificationThreshold: 80, reviewThreshold: 50 },
      }),
      updateImportBatch: async () => undefined,
      updateProspectStage: async () => undefined,
      insertIcpEvaluation: async () => { throw new Error('duplicate must not be evaluated'); },
      insertAuditEvent: async () => ({ id: 'audit-1' }),
    };
    const evaluator = { evaluate: async () => { throw new Error('duplicate must not be evaluated'); } };
    const pipeline = new PersistentIcpPipeline(adapter as never, evaluator as never);

    await pipeline.run('tenant-1', 'icp-1', [{
      name: 'Alice Founder',
      title: 'Founder',
      company: 'Alpha Search',
      location: 'London',
      linkedinUrl: existing.linkedinUrl,
    }], 'google-xray-discovery.csv');

    expect(existing.currentStage).toBe('READY_FOR_CAMPAIGN');
    expect(updates).toEqual([]);
  });
});
