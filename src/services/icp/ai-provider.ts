import { IcpCriteria, IcpScore, ProspectInput } from '../../schemas/icp.js';

export interface ICPModelProvider {
  evaluate(prospect: ProspectInput, criteria: IcpCriteria): Promise<IcpScore>;
}

export class FakeAIProvider implements ICPModelProvider {
  async evaluate(prospect: ProspectInput, criteria: IcpCriteria): Promise<IcpScore> {
    const title = prospect.title.toLowerCase();
    const company = prospect.company.toLowerCase();
    const industry = String(prospect.rawData?.industry ?? '').toLowerCase();

    const titleMatch = criteria.titles?.some(value => title.includes(value.toLowerCase())) ?? false;
    const seniorityMatch = criteria.seniority?.some(val => title.includes(val.toLowerCase())) ?? false;
    const industryMatch = criteria.industry?.some(value => industry.includes(value.toLowerCase())) ?? false;
    const keywordMatch = criteria.positiveKeywords?.some(value => `${title} ${company}`.includes(value.toLowerCase())) ?? false;

    const prospectSkills = (prospect.skills || []).map(s => s.toLowerCase());
    const skillsMatch = criteria.skills?.some(s =>
      prospectSkills.includes(s.toLowerCase()) || `${title} ${company}`.includes(s.toLowerCase())
    ) ?? false;

    const score = Math.min(
      100,
      40 +
        (titleMatch ? 20 : 0) +
        (seniorityMatch ? 15 : 0) +
        (skillsMatch ? 15 : 0) +
        (industryMatch ? 10 : 0) +
        (keywordMatch ? 10 : 0)
    );

    const qualificationThreshold = criteria.qualificationThreshold ?? 80;

    return {
      score,
      confidence: 0.9,
      reasoning: 'Deterministic fake provider recruitment evaluation for offline verification.',
      evidence: [
        titleMatch ? `Title matches target: ${prospect.title}` : `Title reviewed: ${prospect.title}`,
        skillsMatch ? `Skills match criteria: ${prospectSkills.join(', ')}` : `Skills reviewed`,
        industryMatch ? `Industry matches: ${prospect.rawData?.industry}` : `Industry reviewed`,
      ],
      fitBreakdown: {
        roleFit: titleMatch ? 90 : 50,
        companyFit: keywordMatch ? 85 : 50,
        industryFit: industryMatch ? 90 : 50,
        skillsFit: skillsMatch ? 90 : 50,
        seniorityFit: seniorityMatch ? 90 : 50,
      },
      isQualified: score >= qualificationThreshold,
    };
  }
}