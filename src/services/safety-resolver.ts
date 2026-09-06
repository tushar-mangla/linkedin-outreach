import { createHash } from 'node:crypto';
import type { SafetyActionInput } from './engagement/execution-contracts.js';

export const WORKING_HOURS_START = 9;
export const WORKING_HOURS_END = 18;

export function isWithinWorkingHours(date = new Date(), timeZone = 'UTC'): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(date),
    );
    return hour >= WORKING_HOURS_START && hour < WORKING_HOURS_END;
  } catch {
    const hour = date.getUTCHours();
    return hour >= WORKING_HOURS_START && hour < WORKING_HOURS_END;
  }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function redactForAudit<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/[A-Za-z0-9-_]{20,}/g, '[redacted-token]')
      .replace(/\/[^/\s]*profile[^/\s]*/gi, '/[redacted-profile]')
      .replace(/(cookie|authorization|token|secret|session)[=:][^\s,}]+/gi, '$1=[redacted]') as T;
  }
  if (Array.isArray(value)) return value.map(redactForAudit) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/cookie|token|secret|authorization|session|profileDir/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactForAudit(entry);
      }
    }
    return out as T;
  }
  return value;
}

/** Fail-closed typed policy evaluation shared by creation-time and dispatch-time checks. */
export function buildSafetyInput(args: Omit<SafetyActionInput, 'policy'> & { policy: SafetyActionInput['policy'] }): SafetyActionInput {
  return args;
}
