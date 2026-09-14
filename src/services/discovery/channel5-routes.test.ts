import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../db/memory-storage.js';
import { tenantContext } from '../../db/tenant-context.js';
import { requestContextMiddleware } from '../../server/request-context.js';
import { EngagerTargetRegistry } from './engager-target-registry.js';
import { PostEngagerChannel } from './post-engager-channel.js';
import type { PostEngagerRunner } from './opencli-post-engager-runner.js';

describe('Channel 5 Express API Routes', () => {
  let server: http.Server;
  let baseUrl: string;
  let storage: MemoryStorage;
  const TENANT_ID = '00000000-0000-0000-0000-000000000001';

  beforeAll(async () => {
    process.env.DEV_AUTH_ENABLED = '1';
    process.env.SINGLE_USER_TENANT_ID = TENANT_ID;
    storage = new MemoryStorage();

    const app = express();
    app.use(express.json());
    app.use('/api', requestContextMiddleware);

    function structuredRefusal(code: string, message: string, correlationId: string) {
      return { status: 'refused', code, message, correlationId };
    }

    const registry = new EngagerTargetRegistry(storage);
    const fakeRunner: PostEngagerRunner = {
      fetchRecentPosts: async () => [
        {
          postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/',
          authorName: '',
          postText: 'Great insights on talent acquisition and recruiting automation for high-growth teams.',
        },
      ],
      fetchEngagers: async () => [
        {
          name: 'Jane Recruiter',
          headline: 'VP Talent @ Acme',
          profileUrl: 'https://www.linkedin.com/in/jane-recruiter',
          interaction: 'LIKE',
        },
      ],
    };

    const channel = new PostEngagerChannel({
      runner: fakeRunner,
      db: storage,
      registry,
      engageProspect: async () => ({ draftsCreated: 1, postsFound: 1 }),
      now: () => new Date('2026-09-14T00:00:00.000Z'),
    });

    // Routes matching src/server.ts
    app.get('/api/discovery/engager-targets', async (req, res) => {
      try {
        const tenantId = req.requestContext!.tenantId;
        const activeOnly = req.query.active === '1' || req.query.active === 'true';
        const targets = await tenantContext.run({ tenantId }, () =>
          registry.list(tenantId, { activeOnly: activeOnly || undefined })
        );
        res.json({ targets, correlationId: req.requestContext!.correlationId });
      } catch (err) {
        res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', String(err), req.requestContext!.correlationId));
      }
    });

    app.post('/api/discovery/engager-targets/seed', async (req, res) => {
      try {
        const tenantId = req.requestContext!.tenantId;
        const result = await tenantContext.run({ tenantId }, () => registry.seed(tenantId));
        res.status(201).json({ ...result, correlationId: req.requestContext!.correlationId });
      } catch (err) {
        res.status(500).json(structuredRefusal('SEED_FAILED', String(err), req.requestContext!.correlationId));
      }
    });

    app.patch('/api/discovery/engager-targets/:id', async (req, res) => {
      try {
        const tenantId = req.requestContext!.tenantId;
        if (typeof req.body?.isActive !== 'boolean') {
          return res.status(400).json(structuredRefusal('TARGET_INVALID', 'isActive must be a boolean', req.requestContext!.correlationId));
        }
        const target = await tenantContext.run({ tenantId }, () =>
          registry.setActive(tenantId, req.params.id, req.body.isActive)
        );
        res.json({ target, correlationId: req.requestContext!.correlationId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'TARGET_NOT_FOUND') {
          return res.status(404).json(structuredRefusal('TARGET_NOT_FOUND', 'Target not found', req.requestContext!.correlationId));
        }
        res.status(500).json(structuredRefusal('TARGET_INVALID', msg, req.requestContext!.correlationId));
      }
    });

    app.post('/api/discovery/post-engagers', async (req, res) => {
      try {
        const tenantId = req.requestContext!.tenantId;
        const body = req.body ?? {};

        const targetIds = Array.isArray(body.targetIds)
          ? body.targetIds.filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
          : undefined;
        if (targetIds && targetIds.length > 11) {
          return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'targetIds must contain at most 11 entries', req.requestContext!.correlationId));
        }

        const maxPostsPerTarget = body.maxPostsPerTarget === undefined ? undefined : Number(body.maxPostsPerTarget);
        if (maxPostsPerTarget !== undefined && (!Number.isInteger(maxPostsPerTarget) || maxPostsPerTarget < 1 || maxPostsPerTarget > 10)) {
          return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'maxPostsPerTarget must be an integer between 1 and 10', req.requestContext!.correlationId));
        }

        const maxEngagersPerPost = body.maxEngagersPerPost === undefined ? undefined : Number(body.maxEngagersPerPost);
        if (maxEngagersPerPost !== undefined && (!Number.isInteger(maxEngagersPerPost) || maxEngagersPerPost < 1 || maxEngagersPerPost > 50)) {
          return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'maxEngagersPerPost must be an integer between 1 and 50', req.requestContext!.correlationId));
        }

        const recency = body.recency === undefined ? undefined : String(body.recency);
        if (recency !== undefined && !['past-24h', 'past-week', 'past-month'].includes(recency)) {
          return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'recency must be one of past-24h, past-week, past-month', req.requestContext!.correlationId));
        }

        const result = await tenantContext.run({ tenantId }, () => channel.run(tenantId, {
          targetIds,
          recency: (recency as any) ?? 'past-week',
          maxPostsPerTarget: maxPostsPerTarget ?? undefined,
          maxEngagersPerPost: maxEngagersPerPost ?? undefined,
        }));
        res.status(201).json({ recency: recency ?? 'past-week', ...result, correlationId: req.requestContext!.correlationId });
      } catch (err) {
        const code = err instanceof Error ? err.message : String(err);
        if (code === 'NO_ACTIVE_TARGETS' || code === 'TARGET_NOT_ACTIVE' || code === 'TARGET_NOT_FOUND') {
          return res.status(422).json(structuredRefusal(code, code === 'NO_ACTIVE_TARGETS' ? 'No active engager targets are configured' : 'One or more requested targets are inactive or unknown', req.requestContext!.correlationId));
        }
        res.status(500).json(structuredRefusal('DISCOVERY_FAILED', code, req.requestContext!.correlationId));
      }
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env.DEV_AUTH_ENABLED;
    delete process.env.SINGLE_USER_TENANT_ID;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/discovery/engager-targets returns empty targets initially', async () => {
    const res = await fetch(`${baseUrl}/api/discovery/engager-targets`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.targets).toEqual([]);
    expect(data.correlationId).toBeDefined();
  });

  it('POST /api/discovery/engager-targets/seed seeds 11 targets idempotently', async () => {
    const first = await fetch(`${baseUrl}/api/discovery/engager-targets/seed`, { method: 'POST' });
    expect(first.status).toBe(201);
    const data1 = await first.json();
    expect(data1.created).toBe(11);
    expect(data1.existing).toBe(0);
    expect(data1.targets).toHaveLength(11);

    const second = await fetch(`${baseUrl}/api/discovery/engager-targets/seed`, { method: 'POST' });
    expect(second.status).toBe(201);
    const data2 = await second.json();
    expect(data2.created).toBe(0);
    expect(data2.existing).toBe(11);
  });

  it('PATCH /api/discovery/engager-targets/:id toggles active state and validates input', async () => {
    const listRes = await fetch(`${baseUrl}/api/discovery/engager-targets`);
    const { targets } = await listRes.json();
    const target = targets[0];

    // Invalid body
    const badRes = await fetch(`${baseUrl}/api/discovery/engager-targets/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'not-a-bool' }),
    });
    expect(badRes.status).toBe(400);
    const badData = await badRes.json();
    expect(badData.code).toBe('TARGET_INVALID');

    // Unknown ID
    const notFoundRes = await fetch(`${baseUrl}/api/discovery/engager-targets/00000000-0000-0000-0000-999999999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(notFoundRes.status).toBe(404);
    const notFoundData = await notFoundRes.json();
    expect(notFoundData.code).toBe('TARGET_NOT_FOUND');

    // Valid deactivation
    const patchRes = await fetch(`${baseUrl}/api/discovery/engager-targets/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.target.isActive).toBe(false);

    // Filter active only
    const activeRes = await fetch(`${baseUrl}/api/discovery/engager-targets?active=true`);
    const activeData = await activeRes.json();
    expect(activeData.targets).toHaveLength(10);

    // Reactivate target
    await fetch(`${baseUrl}/api/discovery/engager-targets/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
  });

  it('POST /api/discovery/post-engagers validates input caps and recency', async () => {
    // Too many targetIds
    const tooMany = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetIds: Array.from({ length: 12 }, (_, i) => `id-${i}`) }),
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).code).toBe('DISCOVERY_INVALID');

    // Invalid maxPostsPerTarget
    const badPosts = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPostsPerTarget: 0 }),
    });
    expect(badPosts.status).toBe(400);

    // Invalid maxEngagersPerPost
    const badEngagers = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxEngagersPerPost: 100 }),
    });
    expect(badEngagers.status).toBe(400);

    // Invalid recency
    const badRecency = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recency: 'yesterday' }),
    });
    expect(badRecency.status).toBe(400);
  });

  it('POST /api/discovery/post-engagers runs successfully and returns 201 with structured result', async () => {
    const listRes = await fetch(`${baseUrl}/api/discovery/engager-targets`);
    const { targets } = await listRes.json();
    const gregSavage = targets.find((t: { displayName: string }) => t.displayName === 'Greg Savage');

    const res = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetIds: [gregSavage.id],
        recency: 'past-week',
        maxPostsPerTarget: 2,
        maxEngagersPerPost: 5,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.status).toBe('completed');
    expect(data.recency).toBe('past-week');
    expect(data.counts.qualified).toBe(1);
    expect(data.counts.draftCreated).toBe(1);
    expect(data.prospects).toHaveLength(1);
    expect(data.prospects[0].name).toBe('Jane Recruiter');
    expect(data.prospects[0].outcome).toBe('draft-created');
    expect(data.correlationId).toBeDefined();
  });

  it('POST /api/discovery/post-engagers returns 422 for inactive target', async () => {
    const listRes = await fetch(`${baseUrl}/api/discovery/engager-targets`);
    const { targets } = await listRes.json();
    const target = targets[0];

    // Deactivate
    await fetch(`${baseUrl}/api/discovery/engager-targets/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });

    const res = await fetch(`${baseUrl}/api/discovery/post-engagers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetIds: [target.id] }),
    });

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('TARGET_NOT_ACTIVE');
  });
});
