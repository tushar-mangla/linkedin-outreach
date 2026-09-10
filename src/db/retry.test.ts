import { describe, it, expect, vi } from 'vitest';
import {
  isTransientDbError,
  TransientDbError,
  withDbRetry,
} from './retry.js';

describe('isTransientDbError', () => {
  it('identifies TransientDbError instances and objects with code DB_TRANSIENT', () => {
    expect(isTransientDbError(new TransientDbError('fail'))).toBe(true);
    expect(isTransientDbError({ code: 'DB_TRANSIENT', message: 'transient' })).toBe(true);
  });

  it('identifies Node network errors', () => {
    expect(isTransientDbError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientDbError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientDbError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientDbError({ code: 'EPIPE' })).toBe(true);
    expect(isTransientDbError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('identifies Postgres transient error codes', () => {
    expect(isTransientDbError({ code: '57P01' })).toBe(true); // admin_shutdown
    expect(isTransientDbError({ code: '57P02' })).toBe(true); // crash_shutdown
    expect(isTransientDbError({ code: '57P03' })).toBe(true); // cannot_connect_now
    expect(isTransientDbError({ code: '53300' })).toBe(true); // too_many_connections
    expect(isTransientDbError({ code: '40001' })).toBe(true); // serialization_failure
    expect(isTransientDbError({ code: '40P01' })).toBe(true); // deadlock_detected
    expect(isTransientDbError({ code: '08006' })).toBe(true); // connection_failure
    expect(isTransientDbError({ code: '08P01' })).toBe(true); // protocol_violation
  });

  it('identifies Neon and Postgres connection drop and timeout error messages', () => {
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(isTransientDbError(new Error('connection timeout'))).toBe(true);
    expect(isTransientDbError(new Error('timeout expired'))).toBe(true);
    expect(isTransientDbError(new Error('terminating connection due to administrator command'))).toBe(true);
    expect(isTransientDbError(new Error('Client has encountered a connection error and is not queryable'))).toBe(true);
    expect(isTransientDbError(new Error('server closed the connection unexpectedly'))).toBe(true);
    expect(isTransientDbError(new Error('socket hang up'))).toBe(true);
    expect(isTransientDbError(new Error('the database system is starting up'))).toBe(true);
  });

  it('inspects cause recursively (e.g. Drizzle wrapping pg error)', () => {
    const wrappedError = new Error('DrizzleQueryError: Failed query');
    (wrappedError as any).cause = new Error('Connection terminated due to connection timeout');
    expect(isTransientDbError(wrappedError)).toBe(true);

    const deeplyWrapped = {
      message: 'Outer failure',
      cause: {
        message: 'Mid failure',
        cause: {
          code: '57P01',
          message: 'admin shutdown',
        },
      },
    };
    expect(isTransientDbError(deeplyWrapped)).toBe(true);
  });

  it('returns false for domain errors and normal exceptions', () => {
    expect(isTransientDbError(new Error('POST_NOT_ELIGIBLE'))).toBe(false);
    expect(isTransientDbError(new Error('ACTION_DUPLICATE'))).toBe(false);
    expect(isTransientDbError(new Error('BUDGET_EXCEEDED'))).toBe(false);
    expect(isTransientDbError(new Error('TERMINAL_STATE_IMMUTABLE'))).toBe(false);
    expect(isTransientDbError(new Error('Invalid input arguments'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('returns result on first attempt if no error', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withDbRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds on subsequent attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce('recovered');

    const result = await withDbRetry(fn, { baseDelayMs: 10, maxDelayMs: 50 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails immediately without retry on non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('POST_NOT_ELIGIBLE'));

    await expect(withDbRetry(fn, { baseDelayMs: 10 })).rejects.toThrow('POST_NOT_ELIGIBLE');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws the last error if transient error persists', async () => {
    const error = new Error('Connection terminated unexpectedly');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      withDbRetry(fn, { maxRetries: 3, baseDelayMs: 5, maxDelayMs: 20 }),
    ).rejects.toThrow('Connection terminated unexpectedly');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback on each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce('ok');

    const result = await withDbRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 5,
      maxDelayMs: 20,
      onRetry,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, expect.any(Number));
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, expect.any(Number));
  });
});
