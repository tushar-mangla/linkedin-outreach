import { parse } from 'csv-parse/sync';
import { ProspectInput, ProspectInputSchema } from '../../schemas/icp.js';
import { normalizeLinkedinUrl } from './url-normalizer.js';

export interface IngestionError {
  row: number;
  reason: string;
  raw: any;
}

export interface IngestionResult {
  validProspects: ProspectInput[];
  errors: IngestionError[];
  totalRows: number;
}

export interface ProspectSourceAdapter {
  validate(input: any): Promise<IngestionResult>;
  ingest(input: any): Promise<ProspectInput[]>;
}

export class CsvProspectSourceAdapter implements ProspectSourceAdapter {
  async validate(csvContent: string): Promise<IngestionResult> {
    let records: any[];
    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err: any) {
      return {
        validProspects: [],
        errors: [{ row: 0, reason: `CSV parse failure: ${err.message}`, raw: null }],
        totalRows: 0,
      };
    }

    const validProspects: ProspectInput[] = [];
    const errors: IngestionError[] = [];
    const seenUrls = new Set<string>();

    for (let index = 0; index < records.length; index++) {
      const row = records[index];
      const rowNumber = index + 1;

      // Check required fields
      const rawUrl = row.linkedinUrl || row.linkedin_url || row.url || row.LinkedIn || '';
      if (!rawUrl) {
        errors.push({ row: rowNumber, reason: 'Missing LinkedIn URL', raw: row });
        continue;
      }

      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeLinkedinUrl(rawUrl);
      } catch (err: any) {
        errors.push({ row: rowNumber, reason: `Invalid LinkedIn URL (${err.message})`, raw: row });
        continue;
      }

      if (seenUrls.has(normalizedUrl)) {
        errors.push({ row: rowNumber, reason: `Duplicate URL in batch: ${normalizedUrl}`, raw: row });
        continue;
      }

      const name = row.name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Anonymous Candidate';
      const title = row.title || row.job_title || row.headline || 'Unknown Title';
      const company = row.company || row.current_company || row.organization || 'Unknown Company';
      const location = row.location || row.country || row.city || 'Remote / Unknown';

      // Parse skills if provided in CSV (comma-separated)
      let skills: string[] | undefined;
      if (row.skills) {
        skills = String(row.skills).split(',').map(s => s.trim()).filter(Boolean);
      }

      const candidateData = {
        name,
        title,
        company,
        location,
        linkedinUrl: normalizedUrl,
        skills,
        yearsExperience: row.years_experience ? Number(row.years_experience) : undefined,
        rawData: row,
      };

      const parsed = ProspectInputSchema.safeParse(candidateData);
      if (!parsed.success) {
        errors.push({
          row: rowNumber,
          reason: `Schema validation failed: ${parsed.error.issues.map(i => i.message).join(', ')}`,
          raw: row,
        });
        continue;
      }

      seenUrls.add(normalizedUrl);
      validProspects.push(parsed.data);
    }

    return {
      validProspects,
      errors,
      totalRows: records.length,
    };
  }

  async ingest(csvContent: string): Promise<ProspectInput[]> {
    const result = await this.validate(csvContent);
    return result.validProspects;
  }
}

export class FixtureProspectSourceAdapter implements ProspectSourceAdapter {
  private fixtures: any[];

  constructor(fixtures: any[]) {
    this.fixtures = fixtures;
  }

  async validate(): Promise<IngestionResult> {
    const validProspects: ProspectInput[] = [];
    const errors: IngestionError[] = [];

    this.fixtures.forEach((f, index) => {
      try {
        const normalizedUrl = normalizeLinkedinUrl(f.linkedinUrl);
        const parsed = ProspectInputSchema.parse({
          ...f,
          linkedinUrl: normalizedUrl,
          rawData: f.rawData || f,
        });
        validProspects.push(parsed);
      } catch (err: any) {
        errors.push({ row: index + 1, reason: err.message, raw: f });
      }
    });

    return {
      validProspects,
      errors,
      totalRows: this.fixtures.length,
    };
  }

  async ingest(): Promise<ProspectInput[]> {
    const result = await this.validate();
    return result.validProspects;
  }
}

export const CandidateSourceAdapter = CsvProspectSourceAdapter;
