import { describe, expect, it, vi } from 'vitest';
import { PlaywrightExecutor, LINKEDIN_SELECTOR_VERSION } from './playwright.js';

function fixturePage(url: string, verify: boolean) {
  const locator = { isVisible: vi.fn(async () => true), getAttribute: vi.fn(async () => 'Like'), click: vi.fn(async () => undefined), first: vi.fn(function (this: unknown) { return this; }) };
  return {
    url: vi.fn(() => url),
    goto: vi.fn(),
    close: vi.fn(async () => undefined),
    locator: vi.fn(() => locator),
  } as unknown as Parameters<NonNullable<ConstructorParameters<typeof PlaywrightExecutor>[0]['verifyPostState']>>[0] & { url: () => string; goto: (...args: unknown[]) => Promise<void>; close: () => Promise<void>; locator: (...args: unknown[]) => unknown };
}

describe('PlaywrightExecutor verification mapping', () => {
  it('labels independently verified writes as verified, not browser-executed', async () => {
    const page = fixturePage('https://fixture.test/posts/1', true) as never;
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as never;
    const executor = new PlaywrightExecutor({
      profileDirectory: '/tmp/fixture-profile', enabled: true, launch: vi.fn(async () => context) as never,
      targetIdentity: '/posts/1', selectorVersion: LINKEDIN_SELECTOR_VERSION,
      verifyPostState: async () => true,
    });
    const result = await executor.likePost({ scheduledActionId: 'a1', postUrl: 'https://fixture.test/posts/1' });
    expect(result.success).toBe(true);
    expect(result.outcomeLabel).toBe('verified');
  });

  it('keeps unverified writes uncertain without automatic retry', async () => {
    const page = fixturePage('https://fixture.test/posts/1', false) as never;
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as never;
    const executor = new PlaywrightExecutor({
      profileDirectory: '/tmp/fixture-profile', enabled: true, launch: vi.fn(async () => context) as never,
      targetIdentity: '/posts/1', verifyPostState: async () => false,
    });
    const result = await executor.likePost({ scheduledActionId: 'a2', postUrl: 'https://fixture.test/posts/1' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EXECUTION_UNCERTAIN');
  });

  it('refuses when the browser capability is disabled and honors stop', async () => {
    const disabled = new PlaywrightExecutor({ profileDirectory: '/tmp/x', enabled: false });
    await expect(disabled.likePost({ scheduledActionId: 'a3', postUrl: 'https://fixture.test/posts/1' }).then(result => {
      if (result.success) throw new Error('should not succeed');
      if (result.errorCode !== 'FEATURE_05_BROWSER_DISABLED') throw new Error(`unexpected code ${result.errorCode}`);
    })).resolves.toBeUndefined();
    const page = fixturePage('https://fixture.test/posts/1', true) as never;
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as never;
    const stopped = new PlaywrightExecutor({ profileDirectory: '/tmp/x', enabled: true, launch: vi.fn(async () => context) as never });
    stopped.stop();
    const result = await stopped.likePost({ scheduledActionId: 'a4', postUrl: 'https://fixture.test/posts/1' });
    expect(result.errorCode).toBe('EXECUTION_STOPPED');
  });
});
