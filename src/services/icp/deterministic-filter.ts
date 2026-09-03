import { IcpCriteria, ProspectInput } from '../../schemas/icp.js';

interface FilterResult {
  passed: boolean;
  reason?: string;
}

export function deterministicFilter(prospect: ProspectInput, criteria: IcpCriteria): FilterResult {
  // 1. Geography filter
  if (criteria.geography && criteria.geography.length > 0) {
    const matchedGeo = criteria.geography.some(loc =>
      prospect.location.toLowerCase().includes(loc.toLowerCase())
    );
    if (!matchedGeo) {
      return { passed: false, reason: 'Location does not match criteria' };
    }
  }

  // 2. Negative keywords in title
  if (criteria.negativeKeywords && criteria.negativeKeywords.length > 0) {
    const hasNegative = criteria.negativeKeywords.some(keyword =>
      prospect.title.toLowerCase().includes(keyword.toLowerCase())
    );
    if (hasNegative) {
      return { passed: false, reason: 'Prospect title contains a negative keyword' };
    }
  }

  // 3. Excluded titles (e.g. Agency Recruiter, HR Intern)
  if (criteria.excludedTitles && criteria.excludedTitles.length > 0) {
    const hasExcludedTitle = criteria.excludedTitles.some(title =>
      prospect.title.toLowerCase().includes(title.toLowerCase())
    );
    if (hasExcludedTitle) {
      return { passed: false, reason: 'Prospect title is an excluded title' };
    }
  }

  // 4. Excluded companies
  if (criteria.excludedCompanies && criteria.excludedCompanies.length > 0) {
    const hasExcludedCompany = criteria.excludedCompanies.some(comp =>
      prospect.company.toLowerCase().includes(comp.toLowerCase())
    );
    if (hasExcludedCompany) {
      return { passed: false, reason: 'Candidate current company is excluded' };
    }
  }

  // 5. Hard exclusions (across title, company, location)
  if (criteria.hardExclusions && criteria.hardExclusions.length > 0) {
    const haystack = `${prospect.title} ${prospect.company} ${prospect.location}`.toLowerCase();
    for (const exclusion of criteria.hardExclusions) {
      if (haystack.includes(exclusion.toLowerCase())) {
        return { passed: false, reason: `Matches hard exclusion rule: ${exclusion}` };
      }
    }
  }

  // 6. Company size bounds
  if (criteria.companySize) {
    const companySize = prospect.rawData?.companySize;
    if (companySize !== undefined && companySize !== null) {
      if (criteria.companySize.min !== undefined && companySize < criteria.companySize.min) {
        return { passed: false, reason: 'Company size is out of bounds' };
      }
      if (criteria.companySize.max !== undefined && companySize > criteria.companySize.max) {
        return { passed: false, reason: 'Company size is out of bounds' };
      }
    }
  }

  return { passed: true };
}

