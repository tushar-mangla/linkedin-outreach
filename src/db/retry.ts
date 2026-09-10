export class TransientDbError extends Error {
  public readonly code: string = 'DB_TRANSIENT';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TransientDbError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TransientDbError);
    }
  }
}

const TRANSIENT_PG_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '08007', // transaction_resolution_unknown
  '08P01', // protocol_violation
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /connection terminated unexpectedly/i,
  /connection terminated due to connection timeout/i,
  /connection timeout/i,
  /terminating connection due to administrator command/i,
  /timeout expired/i,
  /client has encountered a connection error/i,
  /read econnreset/i,
  /write epipe/i,
  /connection refused/i,
  /no response to ping/i,
  /remaining connection slots are reserved/i,
  /server closed the connection unexpectedly/i,
  /connection closed/i,
  /could not connect to server/i,
  /the database system is starting up/i,
  /the database system is shutting down/i,
  /socket hang up/i,
  /pool is closed/i,
  /timeout exceeded when trying to connect/i,
];

export function isTransientDbError(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;

  if (err instanceof TransientDbError) {
    return true;
  }

  const anyErr = err as Record<string, unknown>;

  if (anyErr.code === 'DB_TRANSIENT') {
    return true;
  }

  if (typeof anyErr.code === 'string') {
    const code = anyErr.code.toUpperCase();
    if (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NODE_CODES.has(code)) {
      return true;
    }
    if (code.startsWith('08')) {
      return true;
    }
  }

  const message = typeof anyErr.message === 'string' ? anyErr.message : '';
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  // Inspect cause recursively if present (e.g. Drizzle wraps pg error in cause)
  if (anyErr.cause) {
    if (isTransientDbError(anyErr.cause, depth + 1)) {
      return true;
    }
  }

  if (anyErr.originalError) {
    if (isTransientDbError(anyErr.originalError, depth + 1)) {
      return true;
    }
  }

  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxRetries ?? options?.attempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 250;
  const maxDelayMs = options?.maxDelayMs ?? 2500;
  const useJitter = options?.jitter ?? true;
  const isRetryable = options?.retryable ?? isTransientDbError;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }

      let delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      if (useJitter) {
        // Jitter between 75% and 125% of delay
        delay = Math.round(delay * (0.75 + Math.random() * 0.5));
      }

      if (options?.onRetry) {
        options.onRetry(err, attempt, delay);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
