import { parse } from 'csv-parse/sync';
import { ProspectInput, ProspectInputSchema } from '../../schemas/icp.js';
import { normalizeLinkedinUrl } from './url-normalizer.js';

function normalizeRow(record: Record<string, any>): Record<string, any> {
  // Strip BOM from keys if present
  const cleanRecord: Record<string, any> = {};
  for (const [k, v] of Object.entries(record)) {
    const cleanKey = k.replace(/^\uFEFF/, '');
    cleanRecord[cleanKey] = v;
  }

  const getField = (...keys: string[]) => {
    for (const key of keys) {
      if (cleanRecord[key] !== undefined && cleanRecord[key] !== null && String(cleanRecord[key]).trim() !== '') {
        return String(cleanRecord[key]).trim();
      }
    }
    return '';
  };

  const name = getField('name', 'Full Name', 'Name') || 
               [getField('First Name'), getField('Last Name')].filter(Boolean).join(' ');

  const title = getField('title', 'Title', 'Job Title', 'Current Title', 'Headline');
  
  const company = getField('company', 'Company', 'Company Name', 'Current Company');

  const location = getField('location', 'Location', 'Job Location 1', 'Company City', 'Company Country', 'City');

  const linkedinUrl = getField('linkedinUrl', 'LinkedIn', 'LinkedIn URL', 'linkedin_url', 'LinkedIn Profile URL');

  const skills: string[] = [];
  if (record['skills']) {
    skills.push(...String(record['skills']).split(',').map(s => s.trim()).filter(Boolean));
  } else {
    for (let i = 1; i <= 10; i++) {
      const skill = getField(`Skill ${i}`);
      if (skill) skills.push(skill);
    }
  }

  const yearsExperienceRaw = getField('yearsExperience', 'Min Experience (Yrs)', 'Years of Experience');
  let yearsExperience: number | undefined;
  if (yearsExperienceRaw) {
    const parsed = parseInt(yearsExperienceRaw, 10);
    if (!isNaN(parsed)) yearsExperience = parsed;
  }

  return {
    ...record,
    name: name || 'Unknown',
    title: title || 'Unknown',
    company: company || 'Unknown',
    location: location || 'Unknown',
    linkedinUrl: linkedinUrl || undefined,
    skills: skills.length > 0 ? skills : undefined,
    yearsExperience,
  };
}

export async function importProspectsFromCsv(csvData: string): Promise<ProspectInput[]> {
  const records = parse(csvData, {
    columns: true,
    skip_empty_lines: true,
  });

  const prospects: Record<string, ProspectInput> = {};
  for (const record of records) {
    const normalizedRecord = normalizeRow(record);
    const prospect = ProspectInputSchema.parse({
      ...normalizedRecord,
      rawData: record,
    });
    
    // Validate the URL slightly more gently - if it's 'https://www.linkedin.com/in/unknown', it might get past or be dropped
    // but url-normalizer might throw if it's completely invalid.
    let normalizedUrl = prospect.linkedinUrl;
    try {
      normalizedUrl = normalizeLinkedinUrl(prospect.linkedinUrl);
    } catch (e) {
      continue; // Skip invalid URLs silently if normalizer fails
    }

    if (!prospects[normalizedUrl] && normalizedUrl !== 'https://www.linkedin.com/in/unknown') {
      prospects[normalizedUrl] = {
        ...prospect,
        linkedinUrl: normalizedUrl,
      };
    }
  }

  return Object.values(prospects);
}
