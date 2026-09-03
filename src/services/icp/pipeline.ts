import { IcpCriteria, ProspectInput, QualificationResult } from '../../schemas/icp.js';
import { importProspectsFromCsv } from './csv-importer.js';
import { deterministicFilter } from './deterministic-filter.js';
import { GeminiEvaluator } from './gemini-evaluator.js';
import { createHash } from 'crypto';

export class IcpPipeline {
  private geminiEvaluator: GeminiEvaluator;

  constructor(geminiApiKeyOrEvaluator?: string | GeminiEvaluator) {
    if (typeof geminiApiKeyOrEvaluator === 'string' || geminiApiKeyOrEvaluator === undefined) {
      this.geminiEvaluator = new GeminiEvaluator({ apiKey: geminiApiKeyOrEvaluator });
    } else {
      this.geminiEvaluator = geminiApiKeyOrEvaluator;
    }
  }

  async run(csvData: string, criteria: IcpCriteria): Promise<QualificationResult[]> {
    const prospects = await importProspectsFromCsv(csvData);
    const results: QualificationResult[] = [];

    for (const prospect of prospects) {
      const dataHash = createHash('sha256').update(JSON.stringify(prospect.rawData)).digest('hex');

      const filterResult = deterministicFilter(prospect, criteria);
      if (!filterResult.passed) {
        results.push({
          ...prospect,
          status: 'REJECTED',
          audit: {
            timestamp: new Date().toISOString(),
            decisionMaker: 'deterministic-filter',
            details: { reason: filterResult.reason },
            dataHash,
          },
        });
        continue;
      }

      const score = await this.geminiEvaluator.evaluate(prospect, criteria);
      
      let status: 'QUALIFIED' | 'REQUIRES_REVIEW' | 'REJECTED';
      if (score.score >= 80) {
        status = 'QUALIFIED';
      } else if (score.score >= 50) {
        status = 'REQUIRES_REVIEW';
      } else {
        status = 'REJECTED';
      }

      results.push({
        ...prospect,
        status,
        score,
        audit: {
          timestamp: new Date().toISOString(),
          decisionMaker: 'gemini-evaluator',
          details: { score: score.score },
          dataHash,
        },
      });
    }
    return results;
  }
}
