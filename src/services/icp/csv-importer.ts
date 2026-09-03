import { parse } from 'csv-parse/sync';
import { ProspectInput, ProspectInputSchema } from '../../schemas/icp.js';
import { normalizeLinkedinUrl } from './url-normalizer.js';

export async function importProspectsFromCsv(csvData: string): Promise<ProspectInput[]> {
  const records = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
  });

  const prospects: Record<string, ProspectInput> = {};
  for (const record of records) {
    const prospect = ProspectInputSchema.parse({
      ...record,
      rawData: record,
    });
    const normalizedUrl = normalizeLinkedinUrl(prospect.linkedinUrl);
    if (!prospects[normalizedUrl]) {
      prospects[normalizedUrl] = {
        ...prospect,
        linkedinUrl: normalizedUrl,
      };
    }
  }

  return Object.values(prospects);
}
