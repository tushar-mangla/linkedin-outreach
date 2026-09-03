import 'dotenv/config';
import express from 'express';
import { db } from './db/client.js';
import { and, desc, eq } from 'drizzle-orm';
import { icpDefinitions, importBatches, prospects } from './db/schema.js';
import { IcpCriteriaSchema } from './schemas/icp.js';
import { importProspectsFromCsv } from './services/icp/csv-importer.js';
import { icpPipeline } from './services/icp/index.js';
import { tenantContext } from './db/tenant-context.js';
import { stringify } from 'csv-stringify/sync';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const ownerId = process.env.SINGLE_USER_OWNER_ID ?? 'local-owner';
const tenantId = process.env.SINGLE_USER_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/csv', limit: '5mb' }));

function withOwner<T>(callback: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId }, callback);
}

function parseCriteria(input: unknown) {
  return IcpCriteriaSchema.parse(input ?? {});
}

function errorResponse(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected server error';
}

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', mode: 'single-user' });
});

app.post('/api/icps', async (request, response) => {
  try {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name) return response.status(400).json({ error: 'ICP name is required' });
    const criteria = parseCriteria(request.body.criteria);
    const result = await withOwner(() => db.insert(icpDefinitions).values({ tenantId, name, criteria }).returning());
    response.status(201).json(result[0]);
  } catch (error) {
    response.status(400).json({ error: errorResponse(error) });
  }
});

app.get('/api/icps', async (_request, response) => {
  const results = await withOwner(() => db.select().from(icpDefinitions).where(eq(icpDefinitions.tenantId, tenantId)).orderBy(desc(icpDefinitions.createdAt)));
  response.json(results);
});

app.post('/api/imports', async (request, response) => {
  try {
    const csv = typeof request.body?.csv === 'string' ? request.body.csv : typeof request.body === 'string' ? request.body : '';
    const icpDefinitionId = typeof request.body?.icpDefinitionId === 'string' ? request.body.icpDefinitionId : '';
    const filename = typeof request.body?.filename === 'string' ? request.body.filename : 'prospects.csv';
    if (!csv || !icpDefinitionId) return response.status(400).json({ error: 'CSV and icpDefinitionId are required' });
    const rows = await importProspectsFromCsv(csv);
    const batch = await withOwner(() => db.insert(importBatches).values({ tenantId, icpDefinitionId, filename, totalRows: rows.length, status: 'CREATED' }).returning());
    response.status(201).json({ batch: batch[0], rows: rows.length });
  } catch (error) {
    response.status(400).json({ error: errorResponse(error) });
  }
});

app.post('/api/imports/:id/process', async (request, response) => {
  try {
    const batch = await withOwner(() => db.query.importBatches.findFirst({ where: and(eq(importBatches.id, request.params.id), eq(importBatches.tenantId, tenantId)) }));
    if (!batch) return response.status(404).json({ error: 'Import batch not found' });
    const csv = typeof request.body?.csv === 'string' ? request.body.csv : '';
    const rows = await importProspectsFromCsv(csv);
    await withOwner(() => icpPipeline.run(tenantId, batch.icpDefinitionId!, rows, batch.filename));
    const updated = await withOwner(() => db.query.importBatches.findFirst({ where: eq(importBatches.id, batch.id) }));
    response.json(updated);
  } catch (error) {
    response.status(400).json({ error: errorResponse(error) });
  }
});

app.get('/api/prospects', async (_request, response) => {
  const results = await withOwner(() => db.select().from(prospects).where(eq(prospects.tenantId, tenantId)).orderBy(desc(prospects.updatedAt)));
  response.json(results);
});

app.post('/api/prospects/:id/review', async (request, response) => {
  try {
    const decision = request.body?.decision === 'APPROVED' ? 'READY_FOR_CAMPAIGN' : 'REJECTED';
    await withOwner(() => icpPipeline.applyOverride(tenantId, request.params.id, decision));
    const result = await withOwner(() => db.query.prospects.findFirst({ where: and(eq(prospects.id, request.params.id), eq(prospects.tenantId, tenantId)) }));
    if (!result) return response.status(404).json({ error: 'Prospect not found' });
    response.json(result);
  } catch (error) {
    response.status(400).json({ error: errorResponse(error) });
  }
});

app.get('/api/exports/approved.csv', async (_request, response) => {
  const rows = await withOwner(() => db.select().from(prospects).where(and(eq(prospects.tenantId, tenantId), eq(prospects.currentStage, 'READY_FOR_CAMPAIGN'))));
  const csv = stringify(rows.map(row => ({
    linkedinUrl: row.linkedinUrl,
    normalizedLinkedinUrl: row.normalizedLinkedinUrl,
    ...((row.customAttributes as Record<string, unknown>) ?? {}),
  })), { header: true });
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="approved-prospects.csv"').send(csv);
});

app.listen(port, () => console.log(`RecruitmentOS ICP server listening on http://localhost:${port}`));

export default app;