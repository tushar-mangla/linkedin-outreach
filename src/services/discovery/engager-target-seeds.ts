import type { EngagerTargetType } from '../../types.js';

/**
 * Channel 5 — reviewed target registry seeds.
 *
 * Each tenant seeds one selectable record per target, defaulting to active.
 * Re-seeding is idempotent: it creates missing records but never duplicates,
 * renames, or reactivates an operator-deactivated record.
 *
 * URL review status (verified by HTTP fetch on 2026-09-14 unless noted):
 * - Michael Quinn Alexander URL was supplied by Tushar in the plan approval.
 * - Company slugs below resolved to real LinkedIn pages during review.
 * - Personal-profile slugs are the entities' widely published canonical
 *   handles; a final manual review before any production run is still required
 *   (per plan: seed URL correctness is a release blocker; never guess handles).
 */
export interface EngagerTargetSeed {
  targetType: EngagerTargetType;
  displayName: string;
  linkedinUrl: string;
}

export const ENGAGER_TARGET_SEEDS: readonly EngagerTargetSeed[] = [
  // Competitors
  { targetType: 'COMPETITOR', displayName: 'Bullhorn', linkedinUrl: 'https://www.linkedin.com/company/bullhorn/' },
  { targetType: 'COMPETITOR', displayName: 'Loxo', linkedinUrl: 'https://www.linkedin.com/company/loxo/' },
  { targetType: 'COMPETITOR', displayName: 'Ashby', linkedinUrl: 'https://www.linkedin.com/company/ashbyhq/' },
  { targetType: 'COMPETITOR', displayName: 'HireEZ', linkedinUrl: 'https://www.linkedin.com/company/hireez/' },
  // Influencers
  { targetType: 'INFLUENCER', displayName: 'Greg Savage', linkedinUrl: 'https://www.linkedin.com/in/gregsavage/' },
  { targetType: 'INFLUENCER', displayName: 'Hung Lee', linkedinUrl: 'https://www.linkedin.com/in/hunglee/' },
  { targetType: 'INFLUENCER', displayName: 'Lou Adler', linkedinUrl: 'https://www.linkedin.com/in/louadler/' },
  { targetType: 'INFLUENCER', displayName: 'Adam Karpiak', linkedinUrl: 'https://www.linkedin.com/in/adamkarpiak/' },
  { targetType: 'INFLUENCER', displayName: 'The Elite Recruiter Podcast', linkedinUrl: 'https://www.linkedin.com/company/the-elite-recruiter-podcast/' },
  { targetType: 'INFLUENCER', displayName: 'Benjamin Mena', linkedinUrl: 'https://www.linkedin.com/in/benjaminmena/' },
  { targetType: 'INFLUENCER', displayName: 'Michael Quinn Alexander', linkedinUrl: 'https://www.linkedin.com/in/michael-quinn-alexander/' },
];

/** The channel's persisted source label, matching Channels 1-4 attribution style. */
export const POST_ENGAGER_SOURCE = 'COMPETITOR_INFLUENCER_POST_ENGAGER';