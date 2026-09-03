# Business Traceability

| Business capability | Owning release | Primary records | Verification |
| --- | --- | --- | --- |
| Define an ICP | Feature 1 | ICP definition | Schema, persistence, API/UI tests |
| Import matching prospects | Feature 1 | Import batch, prospect, source provenance | CSV, deduplication, resumability tests |
| Qualify and approve prospects | Feature 1 | Evaluation, review, readiness, audit event | Deterministic/AI/manual tests |
| Find relevant posts | Feature 2 | Post, engagement eligibility, recommendation | Fixture filtering tests |
| Recommend or execute engagement | Features 2 and 5 | Recommendation, approval, scheduled action, result | Fake/Manual then supervised tests |
| Generate evidence-based messages | Feature 3 | Evidence, message package, versions, approval | Provider and quality tests |
| Run conditional sequences | Feature 4 | Campaign, sequence version, enrollment, scheduled action | State-machine and worker tests |
| Stop on reply or opt-out | Feature 4 | Reply event, enrollment state, cancelled actions | Transactional concurrency tests |
| Enforce safety and operational limits | Features 0 and 5 | Lease, budget, account health, kill switch | PostgreSQL and supervised tests |
| Track funnel outcomes | Feature 6 | Raw events, rollups, opportunities, meetings | Reconciliation and export tests |

## Gate Dependency

Feature 0 must pass before persistent Feature 1 work is released. Feature 1 must pass before engagement, messaging, or sequencing release work. Feature 4 must pass before live execution. Feature 5 must pass before analytics relies on live synchronization.
