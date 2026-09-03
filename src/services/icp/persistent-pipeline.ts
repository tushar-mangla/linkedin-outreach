
import { normalizeLinkedinUrl } from './url-normalizer.js';
import { createHash } from 'crypto';
import { IcpCriteria, ProspectInput } from '../../schemas/icp.js';
import { deterministicFilter } from './deterministic-filter.js';
import { ICPModelProvider } from './ai-provider.js';
import { DBAdapter } from '../../db/db-adapter.js';
import { ProspectStage } from '../../types.js';
import { exportProspectsToCsv } from './exporter.js';

export class PersistentIcpPipeline {

    private db: DBAdapter;
    private evaluator: ICPModelProvider;

    constructor(db: DBAdapter, evaluator: ICPModelProvider) {
        this.db = db;
        this.evaluator = evaluator;
    }
    
    public async run(tenantId: string, icpDefinitionId: string, prospectsData: any[], filename: string) {
        // 1. Create import batch record
        const batch = await this.db.insertImportBatch({
            tenantId,
            icpDefinitionId,
            filename,
            totalRows: prospectsData.length,
        });
        const batchId = batch.id;

        // 2. URL Canonicalization
        const prospectsWithNormalizedUrls = prospectsData.map(p => ({
            ...p,
            normalizedLinkedinUrl: normalizeLinkedinUrl(p.linkedinUrl)
        }));

        // 3. Upsert all prospects to get their IDs
        const allProspectsForBatch = await Promise.all(prospectsWithNormalizedUrls.map(async (p) => {
            const { linkedinUrl, normalizedLinkedinUrl, ...customAttributes } = p;
            
            const existingProspect = await this.db.findProspectByTenantAndUrl(tenantId, normalizedLinkedinUrl);
            if (existingProspect) {
                return await this.db.updateProspect(existingProspect.id, {
                    linkedinUrl,
                    customAttributes,
                    currentStage: 'INGESTED',
                });
            }
            
            return await this.db.insertProspect({
                tenantId,
                linkedinUrl,
                normalizedLinkedinUrl,
                customAttributes,
            });
        }));

        const icpDef = await this.db.findIcpDefinitionById(icpDefinitionId);
        if (!icpDef) throw new Error('ICP Definition not found');
        const criteria = icpDef.criteria as IcpCriteria;

        let processedCount = 0;
        let qualifiedCount = 0;
        let rejectedCount = 0;
        let reviewCount = 0;

        for (const prospect of allProspectsForBatch) {
            if (!prospect) continue;
            const customAttrs = prospect.customAttributes as Record<string, any>;
            const skills = Array.isArray(customAttrs.skills)
                ? customAttrs.skills
                : (typeof customAttrs.skills === 'string'
                    ? customAttrs.skills.split(',').map((s: string) => s.trim()).filter(Boolean)
                    : undefined);

            const prospectInput: ProspectInput = {
                linkedinUrl: prospect.linkedinUrl,
                name: customAttrs.name || 'Candidate',
                title: customAttrs.title || '',
                company: customAttrs.company || '',
                location: customAttrs.location || '',
                skills,
                yearsExperience: customAttrs.yearsExperience ? Number(customAttrs.yearsExperience) : undefined,
                rawData: customAttrs,
            };

            // 4. Deterministic Filtering
            const filterResult = deterministicFilter(prospectInput, criteria);
            if (!filterResult.passed) {
                await this.db.insertIcpEvaluation({
                    tenantId,
                    prospectId: prospect.id,
                    icpDefinitionId,
                    importBatchId: batchId,
                    score: 0,
                    confidence: 1,
                    fitBreakdown: null,
                    evidence: filterResult.reason ?? 'Deterministic rule rejected prospect',
                    reasoning: filterResult.reason ?? null,
                    status: 'FILTERED_OUT',
                    evaluatedBy: 'deterministic-filter',
                });
                await this.db.updateProspectStage(prospect.id, 'FILTERED_OUT');
                await this.db.insertAuditEvent({
                    tenantId,
                    eventType: 'prospect.deterministically_rejected',
                    entityType: 'prospect',
                    entityId: prospect.id,
                    payload: { reason: filterResult.reason ?? null, importBatchId: batchId },
                });
                rejectedCount++;
                processedCount++;
                continue;
            }

            // 5. Gemini Evaluation
            const evaluationResult = await this.evaluator.evaluate(prospectInput, criteria);
            
            await this.db.insertIcpEvaluation({
                tenantId,
                prospectId: prospect.id,
                icpDefinitionId,
                importBatchId: batchId,
                score: evaluationResult.score,
                confidence: evaluationResult.confidence,
                fitBreakdown: evaluationResult.fitBreakdown,
                evidence: evaluationResult.evidence.join('\n'),
                reasoning: evaluationResult.reasoning,
                status: 'EVALUATED',
                evaluatedBy: 'gemini',
            });

            await this.db.insertAuditEvent({
                tenantId,
                eventType: 'prospect.ai_evaluated',
                entityType: 'prospect',
                entityId: prospect.id,
                payload: {
                    importBatchId: batchId,
                    score: evaluationResult.score,
                    confidence: evaluationResult.confidence,
                },
            });

            // 6. Prospect Stage Updating
            let newStage: ProspectStage;
            const qualThreshold = criteria.qualificationThreshold ?? 80;
            const revThreshold = criteria.reviewThreshold ?? 50;

            if (evaluationResult.score >= qualThreshold) {
                newStage = 'EVALUATED';
                qualifiedCount++;
            } else if (evaluationResult.score >= revThreshold) {
                newStage = 'REQUIRES_REVIEW';
                reviewCount++;
            } else {
                newStage = 'REJECTED';
                rejectedCount++;
            }
            await this.db.updateProspectStage(prospect.id, newStage);
            processedCount++;
        }


        // 7. Update batch record
        await this.db.updateImportBatch(batchId, {
            processedRows: processedCount,
            qualifiedCount,
            rejectedCount,
            reviewCount,
            status: 'COMPLETED',
        });

        await this.db.insertAuditEvent({
            tenantId,
            eventType: 'prospect.import_completed',
            entityType: 'import_batch',
            entityId: batchId,
            payload: { processedCount, qualifiedCount, rejectedCount, reviewCount },
        });
        
        // 8. Persistent audit logging (simplified)
        const auditLog = {
            batchId,
            tenantId,
            icpDefinitionId,
            filename,
            totalRows: prospectsData.length,
            processedRows: processedCount,
            qualifiedCount,
            rejectedCount,
            reviewCount,
            status: 'COMPLETED',
            timestamp: new Date().toISOString(),
        };
        const auditHash = createHash('sha256').update(JSON.stringify(auditLog)).digest('hex');
        console.log(`AUDIT LOG: ${JSON.stringify(auditLog)} HASH: ${auditHash}`);
    }

    public async applyOverride(tenantId: string, prospectId: string, newStage: ProspectStage) {
        await this.db.applyOverride(tenantId, prospectId, newStage);
        const decision = newStage === 'READY_FOR_CAMPAIGN' ? 'APPROVED' : 'REJECTED';
        await this.db.insertReviewDecision({
            tenantId,
            prospectId,
            decision,
            reason: 'Manual review decision',
            operatorId: 'local-operator',
        });
        await this.db.insertAuditEvent({
            tenantId,
            eventType: decision === 'APPROVED' ? 'prospect.ready_for_campaign' : 'prospect.reviewed',
            entityType: 'prospect',
            entityId: prospectId,
            payload: { decision, newStage },
        });
    }

    public async exportReadyProspects(tenantId: string): Promise<any[]> {
        const readyProspects = await this.db.exportReadyProspects(tenantId);
        return readyProspects;
    }

    public async exportReadyProspectsCsv(tenantId: string): Promise<string> {
        const readyProspects = await this.exportReadyProspects(tenantId);
        const rows = readyProspects.map(p => {
            const attrs = (p.customAttributes as Record<string, any>) || {};
            return {
                name: attrs.name || 'Candidate',
                title: attrs.title || '',
                company: attrs.company || '',
                location: attrs.location || '',
                linkedinUrl: p.normalizedLinkedinUrl || p.linkedinUrl,
                status: p.currentStage,
                score: attrs.score,
                confidence: attrs.confidence,
                reasoning: attrs.reasoning || '',
            };
        });
        return exportProspectsToCsv(rows as any);
    }
}


