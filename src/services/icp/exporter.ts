import { QualificationResult } from '../../schemas/icp.js';
import { stringify } from 'csv-stringify/sync';

export function exportProspectsToCsv(prospects: QualificationResult[]): string {
  const columns = [
    'name',
    'title',
    'company',
    'location',
    'linkedinUrl',
    'status',
    'score',
    'confidence',
    'reasoning',
  ];

  const data = prospects.map(p => ({
    name: p.name,
    title: p.title,
    company: p.company,
    location: p.location,
    linkedinUrl: p.linkedinUrl,
    status: p.status,
    score: p.score?.score,
    confidence: p.score?.confidence,
    reasoning: p.score?.reasoning,
  }));

  return stringify([columns, ...data.map(Object.values)]);
}
