import { MemoryStorage } from '../src/db/memory-storage.js';
import { LeaseService } from '../src/services/lease-service.js';
import { BudgetService } from '../src/services/budget-service.js';
import { ActionQueueService } from '../src/services/action-queue-service.js';
import { FakeExecutor } from '../src/executors/fake.js';
import { AuditLogger } from '../src/lib/audit.js';
import { CsvProspectSourceAdapter } from '../src/services/icp/source-adapter.js';
import { FakeAIProvider } from '../src/services/icp/ai-provider.js';
import { PersistentIcpPipeline } from '../src/services/icp/persistent-pipeline.js';
import { DEFAULT_OPERATOR_ID } from '../src/types.js';

async function main() {
  console.log('====================================================');
  console.log('🚀 RECRUITMENT PIPELINE & OUTREACH DEMONSTRATION');
  console.log('====================================================\n');

  const storage = new MemoryStorage();
  const leaseService = new LeaseService(storage);
  const budgetService = new BudgetService(storage);
  const auditLogger = new AuditLogger(storage);
  const executor = new FakeExecutor();
  const queueService = new ActionQueueService({
    db: storage,
    leaseService,
    budgetService,
    executor,
    logger: auditLogger,
  });

  const tenantId = DEFAULT_OPERATOR_ID;
  const accountId = 'recruiter-linkedin-account';
  const workerId = 'recruiter-worker-1';

  // 1. Define Recruitment Role (ICP)
  console.log('📋 1. Defining Recruitment Role: Staff Backend Engineer...');
  const roleDef = {
    id: 'role-staff-backend',
    tenantId,
    name: 'Staff Backend Engineer - Q3 Hiring',
    criteria: {
      titles: ['Staff Backend Engineer', 'Senior Backend Engineer'],
      seniority: ['Staff', 'Senior', 'Lead'],
      skills: ['PostgreSQL', 'Go', 'Distributed Systems'],
      geography: ['San Francisco', 'Remote'],
      excludedTitles: ['Agency Recruiter', 'HR Intern'],
      hardExclusions: ['Staffing Agency'],
      qualificationThreshold: 80,
      reviewThreshold: 50,
    },
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  storage.getTable('icpDefinitions').push(roleDef);

  // 2. Ingest CSV Candidates
  console.log('📥 2. Ingesting Candidate CSV Source...');
  const rawCsv = `name,title,company,location,linkedinUrl,skills
Elena Rostova,Staff Backend Engineer,Acme Infrastructure,San Francisco CA,https://www.linkedin.com/in/elena-rostova,"PostgreSQL, Go, Distributed Systems"
Mark Recruiter,Agency Recruiter,Global Staffing,San Francisco CA,https://www.linkedin.com/in/mark-recruiter,"Sourcing"
David Chen,Senior Backend Developer,CloudScale,Remote,https://www.linkedin.com/in/david-chen,"Go, Kubernetes"
Junior Intern,Software Intern,Small Startup,San Francisco CA,https://www.linkedin.com/in/junior-intern,"HTML"`;

  const adapter = new CsvProspectSourceAdapter();
  const ingestionResult = await adapter.validate(rawCsv);
  console.log(`   - Ingested: ${ingestionResult.validProspects.length} valid candidates, ${ingestionResult.errors.length} errors/disqualifications.`);

  // 3. Run Pipeline Qualification
  console.log('\n🤖 3. Running AI Candidate Qualification Pipeline...');
  const fakeAi = new FakeAIProvider();
  const pipeline = new PersistentIcpPipeline(storage, fakeAi);

  const rawCandidates = ingestionResult.validProspects.map(p => ({
    name: p.name,
    title: p.title,
    company: p.company,
    location: p.location,
    linkedinUrl: p.linkedinUrl,
    skills: p.skills,
  }));

  await pipeline.run(tenantId, roleDef.id, rawCandidates, 'backend-candidates.csv');

  const candidatesInDb = storage.getTable('prospects').filter(p => p.tenantId === tenantId);
  console.log('\n📊 Candidate Stage Distribution:');
  candidatesInDb.forEach(c => {
    console.log(`   - ${c.customAttributes.name} (${c.customAttributes.title}): Stage -> ${c.currentStage}`);
  });

  // 4. Recruiter Manual Review & Approval
  console.log('\n👤 4. Recruiter Override / Approval...');
  const qualifiedCandidate = candidatesInDb.find(c => c.currentStage === 'EVALUATED');
  if (qualifiedCandidate) {
    await pipeline.applyOverride(tenantId, qualifiedCandidate.id, 'READY_FOR_CAMPAIGN');
    console.log(`   - Approved Candidate: ${qualifiedCandidate.customAttributes.name} -> READY_FOR_CAMPAIGN`);
  }

  // 5. Account Safety & Scheduled Outreach
  console.log('\n🛡️ 5. Setting up Account Lease & Daily Action Quotas...');
  const lease = await leaseService.acquireLeaseWithToken(tenantId, accountId, workerId, 60);
  console.log(`   - Lease Acquired: ${lease.acquired} (Token: ${lease.leaseToken?.substring(0, 8)}...)`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  storage.getTable('dailyActionBudgets').push({
    id: 'budget-1',
    tenantId,
    accountId,
    actionType: 'visit',
    budgetDate: today,
    limit: 50,
    reservedCount: 0,
    completedCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('   - Daily Budget Quota set: Max 50 Profile Visits/day.');

  // 6. Execute Scheduled Action
  console.log('\n⚡ 6. Executing Scheduled Profile Visit Action...');
  const scheduled = await queueService.scheduleAction({
    tenantId,
    accountId,
    prospectId: qualifiedCandidate?.id || 'cand-1',
    actionType: 'visit',
    payload: { profileUrl: qualifiedCandidate?.linkedinUrl || 'https://linkedin.com/in/elena-rostova' },
    scheduledFor: new Date(Date.now() - 1000),
    idempotencyKey: `idem-visit-${Date.now()}`,
  });

  const processResult = await queueService.processNextAction(tenantId, accountId, workerId, lease.leaseToken);
  console.log(`   - Action Execution Result: ${processResult.processed ? 'SUCCESS' : 'FAILED'}`);

  // 7. Verify Audit Trail
  console.log('\n🔒 7. Verifying Persistent SHA-256 Audit Trail...');
  const audits = storage.getTable('auditEvents');
  console.log(`   - Recorded Audit Events Count: ${audits.length}`);
  const lastAudit = audits[audits.length - 1];
  console.log(`   - Last Audit Event: ${lastAudit.eventType} | Payload Hash: ${lastAudit.payload?.payloadHash}`);

  // 8. Export Approved Candidates CSV
  console.log('\n📤 8. Exporting Approved Candidates CSV...');
  const csvOutput = await pipeline.exportReadyProspectsCsv(tenantId);
  console.log('\n' + csvOutput);

  console.log('====================================================');
  console.log('✅ DEMONSTRATION COMPLETED SUCCESSFULLY!');
  console.log('====================================================');
}

main().catch(err => {
  console.error('Error running recruitment pipeline demo:', err);
  process.exit(1);
});
