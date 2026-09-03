import { z } from 'zod';

export const IcpCriteriaSchema = z.object({
  geography: z.array(z.string()).default([]),
  industry: z.array(z.string()).default([]),
  companySize: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  titles: z.array(z.string()).default([]),
  seniority: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  preferredSkills: z.array(z.string()).default([]),
  positiveKeywords: z.array(z.string()).default([]),
  negativeKeywords: z.array(z.string()).default([]),
  hardExclusions: z.array(z.string()).default([]),
  excludedTitles: z.array(z.string()).default([]),
  excludedCompanies: z.array(z.string()).default([]),
  minYearsExperience: z.number().optional(),
  maxYearsExperience: z.number().optional(),
  qualificationThreshold: z.number().min(0).max(100).default(80),
  reviewThreshold: z.number().min(0).max(100).default(50),
  minimumConfidence: z.number().min(0).max(1).default(0.7),
  minimumEvidence: z.number().int().min(0).default(1),
});

export const RecruitmentCriteriaSchema = IcpCriteriaSchema;

export const ProspectInputSchema = z.object({
  name: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  linkedinUrl: z.string().url(),
  skills: z.array(z.string()).optional(),
  yearsExperience: z.number().optional(),
  rawData: z.record(z.string(), z.any()),
});

export const CandidateInputSchema = ProspectInputSchema;

export const IcpScoreSchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(z.string()),
  fitBreakdown: z.object({
    roleFit: z.number().min(0).max(100),
    companyFit: z.number().min(0).max(100),
    industryFit: z.number().min(0).max(100),
    skillsFit: z.number().min(0).max(100).optional(),
    seniorityFit: z.number().min(0).max(100).optional(),
  }),
  isQualified: z.boolean(),
});

export const QualificationResultSchema = ProspectInputSchema.extend({
  status: z.enum(['QUALIFIED', 'REJECTED', 'REQUIRES_REVIEW', 'FILTERED_OUT']),
  score: IcpScoreSchema.optional(),
  audit: z.object({
    timestamp: z.string().datetime(),
    decisionMaker: z.string(), // 'deterministic-filter', 'gemini-evaluator', 'fake-ai', 'manual-override'
    details: z.record(z.string(), z.any()),
    dataHash: z.string(),
  }),
});

export type IcpCriteria = z.infer<typeof IcpCriteriaSchema>;
export type RecruitmentCriteria = IcpCriteria;
export type ProspectInput = z.infer<typeof ProspectInputSchema>;
export type CandidateInput = ProspectInput;
export type IcpScore = z.infer<typeof IcpScoreSchema>;
export type QualificationResult = z.infer<typeof QualificationResultSchema>;

