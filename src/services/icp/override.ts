import { QualificationResult } from '../../schemas/icp.js';

interface OverrideInput {
  prospect: QualificationResult;
  decision: 'QUALIFIED' | 'REJECTED';
  reason: string;
  operatorId: string;
}

export function applyOverride({ prospect, decision, reason, operatorId }: OverrideInput): QualificationResult {
  return {
    ...prospect,
    status: decision,
    audit: {
      ...prospect.audit,
      decisionMaker: 'manual-override',
      details: {
        ...prospect.audit.details,
        overrideReason: reason,
        operatorId,
        originalStatus: prospect.status,
      },
      timestamp: new Date().toISOString(),
    },
  };
}
