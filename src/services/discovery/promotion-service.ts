import type { DBAdapter } from '../../db/db-adapter.js';

/**
 * Explicit operator promotion gate (plan F1). Sets a prospect to
 * READY_FOR_CAMPAIGN, records a review decision + audit event, and attributes
 * the promotion to the originating content-search query via the prospect's
 * stored sourceQuery custom attribute.
 *
 * This is the operator promotion gate for manual/discovery channels (Channels 1-4).
 * Note: Channel 5 (competitor & influencer post engagers) autonomously transitions
 * newly qualified engagers to READY_FOR_CAMPAIGN via its explicit system actor
 * (system-channel-5), representing the sole automated readying exception.
 */
export async function promoteProspect(
  db: DBAdapter,
  tenantId: string,
  prospectId: string,
  operatorId: string,
  reason?: string,
): Promise<{ prospectId: string; currentStage: 'READY_FOR_CAMPAIGN' }> {
  const prospect = await db.findProspectById(tenantId, prospectId);
  if (!prospect) throw new Error('PROSPECT_NOT_FOUND');

  await db.applyOverride(tenantId, prospectId, 'READY_FOR_CAMPAIGN');
  await db.insertReviewDecision({
    tenantId,
    prospectId,
    decision: 'APPROVED',
    reason: reason ?? 'Operator promotion to campaign',
    operatorId,
  });
  await db.insertAuditEvent({
    tenantId,
    eventType: 'prospect.ready_for_campaign',
    entityType: 'prospect',
    entityId: prospectId,
    payload: { decision: 'APPROVED', newStage: 'READY_FOR_CAMPAIGN', operatorId, reason: reason ?? null },
  });

  const sourceQuery = (prospect.customAttributes as Record<string, unknown> | null)?.sourceQuery;
  if (typeof sourceQuery === 'string' && sourceQuery.trim()) {
    await db.incrementQueryStatPromoted(tenantId, sourceQuery);
  }

  return { prospectId, currentStage: 'READY_FOR_CAMPAIGN' };
}