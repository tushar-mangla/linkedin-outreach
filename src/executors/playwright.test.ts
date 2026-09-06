import { describe, expect, it, vi } from 'vitest';
import { PlaywrightExecutor } from './playwright.js';

function fixturePage(url: string) {
  const locator = { isVisible: vi.fn(async () => true), getAttribute: vi.fn(async () => 'Like'), click: vi.fn(async () => undefined), first: vi.fn(function (this: any) { return this; }) };
  return {
    url: vi.fn(() => url),
    goto: vi.fn(),
    close: vi.fn(async () => undefined),
    locator: vi.fn(() => locator),
  } as any;
}

function fixtureContext(page: any) {
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) } as any;
}

describe('PlaywrightExecutor controlled fixtures', () => {
  it('cleans up and returns uncertainty when a write cannot be verified', async () => {
    const page = fixturePage('https://fixture.test/posts/1');
    const context = fixtureContext(page);
    const executor = new PlaywrightExecutor({ profileDirectory: '/tmp/fixture-profile', enabled: true, launch: vi.fn(async () => context), targetIdentity: '/posts/1' });
    const result = await executor.likePost({ scheduledActionId: 'action-1', postUrl: 'https://fixture.test/posts/1' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('EXECUTION_UNCERTAIN');
    expect(page.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('rejects a wrong fixture target before writing', async () => {
    const page = fixturePage('https://fixture.test/posts/wrong');
    const context = fixtureContext(page);
    const executor = new PlaywrightExecutor({ profileDirectory: '/tmp/fixture-profile', enabled: true, launch: vi.fn(async () => context), targetIdentity: '/posts/expected' });
    const result = await executor.likePost({ scheduledActionId: 'action-2', postUrl: 'https://fixture.test/posts/expected' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('WRONG_TARGET');
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('maps an already-liked fixture to duplicate refusal', async () => {
    const page = fixturePage('https://fixture.test/posts/1');
    const locator = { isVisible: vi.fn(async () => true), getAttribute: vi.fn(async () => 'Unlike'), click: vi.fn(), first: vi.fn(function (this: any) { return this; }) };
    page.locator = vi.fn(() => locator) as any;
    const context = fixtureContext(page);
    const executor = new PlaywrightExecutor({ profileDirectory: '/tmp/fixture-profile', enabled: true, launch: vi.fn(async () => context), targetIdentity: '/posts/1' });
    const result = await executor.likePost({ scheduledActionId: 'action-3', postUrl: 'https://fixture.test/posts/1' });
    expect(result.errorCode).toBe('ACTION_DUPLICATE');
  });
});
