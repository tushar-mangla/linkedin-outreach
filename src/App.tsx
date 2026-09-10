import React, { useState, useEffect } from 'react';
import { EngagementReview } from './components/EngagementReview';
import { RolesPanel } from './components/RolesPanel';
import { UploadPanel } from './components/UploadPanel';
import { EngagementPanel } from './components/EngagementPanel';
import { ExportPanel } from './components/ExportPanel';

export interface RoleDef {
  id?: string;
  name: string;
  criteria: any;
}

export interface ProspectRow {
  id: string;
  name: string;
  title: string;
  company: string;
  location: string;
  linkedinUrl: string;
  currentStage: string;
  customAttributes?: any;
}

export function App() {
  const [activeTab, setActiveTab] = useState<'roles' | 'upload' | 'pipeline' | 'export' | 'engagement'>('pipeline');
  const [roleName, setRoleName] = useState('Staff Backend Engineer');
  const [criteriaJson, setCriteriaJson] = useState(
    JSON.stringify(
      {
        titles: ['Staff Backend Engineer', 'Senior Backend Engineer'],
        seniority: ['Staff', 'Senior', 'Lead'],
        skills: ['PostgreSQL', 'Go', 'Distributed Systems'],
        geography: ['San Francisco', 'Remote'],
        excludedTitles: ['Agency Recruiter', 'HR Intern'],
        hardExclusions: ['Staffing Agency'],
      },
      null,
      2
    )
  );

  const [prospects, setProspects] = useState<ProspectRow[]>([]);
  const [prospectsState, setProspectsState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  const [statusMessage, setStatusMessage] = useState('Loading server state…');
  const [drafts, setDrafts] = useState<any[]>([]);
  const [queueActions, setQueueActions] = useState<any[]>([]);
  const [controls, setControls] = useState<any[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [actionStatusByDraft, setActionStatusByDraft] = useState<Record<string, 'executing' | 'executed' | 'failed'>>({});
  const [isCampaignRunning, setIsCampaignRunning] = useState(false);
  const [actionAccountId, setActionAccountId] = useState('00000000-0000-0000-0000-000000000002');
  const [actionMode, setActionMode] = useState<'BROWSER' | 'SIMULATE' | 'MANUAL'>('BROWSER');
  const [selectedProspectId, setSelectedProspectId] = useState<string>('');
  const [campaignsList, setCampaignsList] = useState<Array<{ id: string; name: string; enrolledCount: number }>>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('');
  const [campaignDrafts, setCampaignDrafts] = useState<Record<string, any[]>>({});

  async function refreshCampaigns() {
    try {
      const res = await fetch('/api/campaigns');
      if (res.ok) {
        const data = await res.json();
        setCampaignsList(Array.isArray(data) ? data : []);
      }
    } catch {
      // Offline fallback seam
    }
  }

  async function refreshProspects(cId?: string) {
    setProspectsState('loading');
    try {
      const filterId = cId !== undefined ? cId : selectedCampaignId;
      const url = filterId ? `/api/prospects?campaignId=${encodeURIComponent(filterId)}` : '/api/prospects';
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        setProspectsState('error');
        setStatusMessage(`Prospects refused (${res.status}): ${body}`);
        return;
      }
      const data = await res.json();
      const list: ProspectRow[] = Array.isArray(data) ? data : [];
      setProspects(list);
      setProspectsState(list.length === 0 ? 'empty' : 'ready');
      setSelectedProspectId(prev => {
        if (prev && list.some(p => p.id === prev)) return prev;
        const ready = list.find(p => p.currentStage === 'READY_FOR_CAMPAIGN');
        return ready ? ready.id : '';
      });
      refreshCampaigns();
      // If viewing a specific campaign, also fetch all drafts and map by prospectId
      if (filterId && list.length > 0) {
        try {
          const draftRes = await fetch('/api/engagement/drafts?status=ALL');
          if (draftRes.ok) {
            const allDrafts: any[] = await draftRes.json();
            const byProspect: Record<string, any[]> = {};
            for (const d of allDrafts) {
              const pid = d.prospectId || d.post?.prospectId;
              if (!pid) continue;
              if (!byProspect[pid]) byProspect[pid] = [];
              byProspect[pid].push(d);
            }
            setCampaignDrafts(byProspect);

            const missingDrafts = list.filter(p => !byProspect[p.id] || byProspect[p.id].length === 0);
            if (missingDrafts.length > 0) {
              Promise.all(missingDrafts.map(p => fetch('/api/engagement/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prospectId: p.id }),
              }))).then(async () => {
                const reRes = await fetch('/api/engagement/drafts?status=ALL');
                if (reRes.ok) {
                  const updatedDrafts: any[] = await reRes.json();
                  const updatedByProspect: Record<string, any[]> = {};
                  for (const d of updatedDrafts) {
                    const pid = d.prospectId || d.post?.prospectId;
                    if (!pid) continue;
                    if (!updatedByProspect[pid]) updatedByProspect[pid] = [];
                    updatedByProspect[pid].push(d);
                  }
                  setCampaignDrafts(updatedByProspect);
                }
              }).catch(() => {});
            }
          }
        } catch {
          // drafts fetch is best-effort
        }
      } else if (!filterId) {
        setCampaignDrafts({});
      }
    } catch (e: any) {
      setProspectsState('error');
      setStatusMessage(`Prospects unavailable: ${e.message}`);
    }
  }

  async function refreshEngagement() {
    try {
      const [draftRes, queueRes, controlsRes, auditRes] = await Promise.all([
        fetch('/api/engagement/drafts?status=ALL'),
        fetch('/api/queue/actions'),
        fetch('/api/engagement/controls'),
        fetch('/api/execution/audit'),
      ]);
      if (draftRes.ok) setDrafts(await draftRes.json());
      else setStatusMessage(`Drafts refused (${draftRes.status}): ${await draftRes.text()}`);
      if (queueRes.ok) setQueueActions(await queueRes.json());
      if (controlsRes.ok) setControls(await controlsRes.json());
      if (auditRes.ok) setAuditEvents(await auditRes.json());
    } catch (e: any) {
      setStatusMessage(`Engagement refresh failed: ${e.message}`);
    }
  }

  useEffect(() => {
    refreshProspects();
  }, []);

  useEffect(() => {
    if (activeTab === 'engagement' || activeTab === 'pipeline') {
      refreshEngagement();
      refreshProspects();
    }
  }, [activeTab]);



  useEffect(() => {
    fetch('/health')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'ok') setStatusMessage('Connected to RecruitmentOS API Server');
        else setStatusMessage('API unavailable: unexpected health response');
      })
      .catch(() => {
        setStatusMessage('API unavailable: cannot reach server. No local fallback data is shown.');
      });
  }, []);



  const handleDeleteProspect = async (prospect: ProspectRow) => {
    if (!window.confirm(`Delete ${prospect.name} and all associated engagement data?`)) return;
    try {
      const response = await fetch(`/api/prospects/${prospect.id}`, { method: 'DELETE' });
      if (!response.ok) {
        setStatusMessage(`Delete refused (${response.status}): ${await response.text()}`);
        return;
      }
      setStatusMessage(`${prospect.name} was deleted.`);
      await refreshProspects();
    } catch (error: any) {
      setStatusMessage(`Delete failed: ${error.message}`);
    }
  };

  const handleScanProspect = async (prospectId: string) => {
    const target = prospects.find(p => p.id === prospectId);
    setStatusMessage(`Scanning ${target?.name ?? prospectId} for recent posts...`);
    try {
      const res = await fetch('/api/engagement/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId })
      });
      if (!res.ok) {
        setStatusMessage(`Scan refused (${res.status}): ${await res.text()}`);
        return;
      }
      const data = await res.json();
      setStatusMessage(`Scan complete: ${data.postsFound} posts found, ${data.draftsCreated} drafts created.`);
      // Re-fetch drafts for this campaign
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setStatusMessage(`Scan failed: ${e.message}`);
    }
  };

  const handleScanProspects = async () => {    const targetId = selectedProspectId || readyProspects[0]?.id;
    if (!targetId) {
      setStatusMessage('No prospect selected to scan. Add a prospect first, then pick one from the Prospect Selector.');
      return;
    }
    const target = prospects.find(p => p.id === targetId);
    setStatusMessage(`Scanning prospect ${target?.name ?? targetId} for recent posts...`);
    try {
      const res = await fetch('/api/engagement/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId: targetId })
      });
      if (!res.ok) {
        setStatusMessage(`Scan refused (${res.status}): ${await res.text()}`);
        return;
      }
      const data = await res.json();
      setStatusMessage(`Scan complete: ${data.postsFound} posts found, ${data.draftsCreated} drafts created.`);
      await refreshEngagement();
    } catch (e: any) {
      setStatusMessage(`Scan failed: ${e.message}`);
    }
  };

  const handleDraftDecision = async (draftId: string, decision: 'APPROVED' | 'SKIPPED') => {
    try {
      const response = await fetch(`/api/engagement/drafts/${draftId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      if (!response.ok) {
        setStatusMessage(`Draft decision refused: ${await response.text()}`);
        return;
      }
      await refreshEngagement();
      setStatusMessage(`Draft ${decision.toLowerCase()} recorded on the server.`);
    } catch (e: any) {
      setStatusMessage(`Error: ${e.message}`);
    }
  };

  // Processes ONE action from the queue and returns whether there was something to process.
  const processSingleQueueItem = async (): Promise<boolean> => {
    const response = await fetch('/api/queue/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: actionAccountId, mode: actionMode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || response.statusText);
    return !!data.processed;
  };

  // Drains the entire queue one action at a time with a gap between each.
  // 180s gap is required to avoid LinkedIn rate-limiting.
  const handleDrainQueue = async (gapMs = 180_000) => {
    let processed = 0;
    try {
      while (true) {
        setStatusMessage(`Executing action ${processed + 1} from queue (${actionMode})…`);
        const didProcess = await processSingleQueueItem();
        if (!didProcess) break;
        processed++;
        await refreshEngagement();
        setStatusMessage(`✓ Action ${processed} done. Waiting ${gapMs / 1000}s before next…`);
        await new Promise(r => setTimeout(r, gapMs));
      }
      if (processed === 0) {
        setStatusMessage('Queue is empty — nothing to process.');
      } else {
        setStatusMessage(`🚀 Done! Executed ${processed} action(s) from queue.`);
      }
      await refreshEngagement();
    } catch (e: any) {
      setStatusMessage(`Queue execution failed after ${processed} action(s): ${e.message}`);
    }
  };

  // Legacy single-shot handler kept for the manual "Process Queue" button.
  const handleProcessQueue = async () => {
    await handleDrainQueue();
  };

  const handleRequestAction = async (draftId: string, actionType: 'LIKE' | 'COMMENT', autoProcess = true) => {
    try {
      setStatusMessage(`Requesting & executing ${actionType} (${actionMode})…`);
      const response = await fetch(`/api/engagement/recommendations/${draftId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType, mode: actionMode, accountId: actionAccountId, idempotencyKey: `${draftId}:${actionType}:${actionMode}:${Date.now()}` }),
      });
      const body = await response.text();
      if (!response.ok) {
        setStatusMessage(`Action refused (${response.status}): ${body}`);
        return;
      }
      setStatusMessage(`Action queued. Now dispatching executor (${actionMode})…`);
      await refreshEngagement();

      if (autoProcess) {
        await handleProcessQueue();
      }
    } catch (e: any) {
      setStatusMessage(`Action request failed: ${e.message}`);
    }
  };

  const handleApproveCommentWithLike = async (commentDraft: any, draftsForProspect: any[]) => {
    if (commentDraft.status === 'APPROVED') return;
    try {
      setStatusMessage('Approving comment & like...');
      const matchingLike = draftsForProspect.find(d => d.actionType === 'LIKE' && (d.postId === commentDraft.postId || d.post?.id === commentDraft.post?.id));
      await handleDraftDecision(commentDraft.id, 'APPROVED');
      if (matchingLike) {
        await handleDraftDecision(matchingLike.id, 'APPROVED');
      }
      setStatusMessage(`✓ Approved! The comment & like are ready to execute.`);
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setStatusMessage(`Approval failed: ${e.message}`);
    }
  };

  const handleExecuteCommentWithLike = async (commentDraft: any, draftsForProspect: any[]) => {
    if (actionStatusByDraft[commentDraft.id] === 'executing' || actionStatusByDraft[commentDraft.id] === 'executed') {
      return;
    }
    setActionStatusByDraft(prev => ({ ...prev, [commentDraft.id]: 'executing' }));
    setStatusMessage(`Queueing like and comment for ${commentDraft.post?.authorName ?? 'prospect'}…`);
    try {
      // Step 1: Queue both actions (LIKE first, then COMMENT) — do NOT auto-process yet.
      const matchingLike = draftsForProspect.find(d => d.actionType === 'LIKE' && (d.postId === commentDraft.postId || d.post?.id === commentDraft.post?.id));
      if (matchingLike) {
        await handleDraftDecision(matchingLike.id, 'APPROVED');
        await handleRequestAction(matchingLike.id, 'LIKE', false);
      }
      await handleDraftDecision(commentDraft.id, 'APPROVED');
      await handleRequestAction(commentDraft.id, 'COMMENT', false);

      // Step 2: Drain the full queue with gaps so LIKE and COMMENT both execute.
      await handleDrainQueue(12_000);

      setActionStatusByDraft(prev => ({ ...prev, [commentDraft.id]: 'executed' }));
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setActionStatusByDraft(prev => ({ ...prev, [commentDraft.id]: 'failed' }));
      setStatusMessage(`Execution failed: ${e.message}`);
    }
  };

  const handleSkipCommentWithLike = async (commentDraft: any, draftsForProspect: any[]) => {
    const matchingLike = draftsForProspect.find(d => d.actionType === 'LIKE' && (d.postId === commentDraft.postId || d.post?.id === commentDraft.post?.id));
    await handleDraftDecision(commentDraft.id, 'SKIPPED');
    if (matchingLike) {
      await handleDraftDecision(matchingLike.id, 'SKIPPED');
    }
    await refreshProspects(selectedCampaignId || undefined);
  };

  // ─── Campaign-level automation ──────────────────────────────────────────────

  // Runs the entire campaign: auto-approves all pending drafts, queues all
  // LIKE + COMMENT pairs, then drains the full queue with 60s gaps.
  const handleRunCampaign = async () => {
    if (isCampaignRunning) return;
    setIsCampaignRunning(true);
    setStatusMessage('Starting campaign run… collecting all drafts.');
    try {
      // Gather all comment drafts across all prospects that are not yet done
      const allCommentDrafts: { draft: any; allDrafts: any[] }[] = [];
      for (const prospect of prospects) {
        const draftsForProspect = campaignDrafts[prospect.id] ?? [];
        const commentDrafts = draftsForProspect.filter(
          (d: any) =>
            d.actionType === 'COMMENT' &&
            d.status !== 'SKIPPED' &&
            d.status !== 'REJECTED' &&
            actionStatusByDraft[d.id] !== 'executed'
        );
        for (const draft of commentDrafts) {
          allCommentDrafts.push({ draft, allDrafts: draftsForProspect });
        }
      }
      if (allCommentDrafts.length === 0) {
        setStatusMessage('No pending drafts to run in this campaign.');
        return;
      }
      setStatusMessage(`Approving & queueing ${allCommentDrafts.length} comment(s) + matching likes…`);

      // Step 1: Approve + queue all pairs (no auto-process yet)
      for (const { draft, allDrafts } of allCommentDrafts) {
        const matchingLike = allDrafts.find(
          (d: any) => d.actionType === 'LIKE' && (d.postId === draft.postId || d.post?.id === draft.post?.id)
        );
        if (matchingLike) {
          await handleDraftDecision(matchingLike.id, 'APPROVED');
          await handleRequestAction(matchingLike.id, 'LIKE', false);
        }
        await handleDraftDecision(draft.id, 'APPROVED');
        await handleRequestAction(draft.id, 'COMMENT', false);
        setActionStatusByDraft(prev => ({ ...prev, [draft.id]: 'executing' }));
      }

      setStatusMessage(`All ${allCommentDrafts.length * 2} actions queued. Executing with 60s gaps…`);

      // Step 2: Drain the entire queue
      await handleDrainQueue(60_000);

      // Mark all as executed in UI
      setActionStatusByDraft(prev => {
        const next = { ...prev };
        for (const { draft } of allCommentDrafts) next[draft.id] = 'executed';
        return next;
      });
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setStatusMessage(`Campaign run failed: ${e.message}`);
    } finally {
      setIsCampaignRunning(false);
    }
  };

  // Calls the server-side retry-failed endpoint then re-runs the drain.
  const handleRetryFailed = async () => {
    if (isCampaignRunning) return;
    setIsCampaignRunning(true);
    setStatusMessage('Resetting failed comment actions for retry…');
    try {
      const res = await fetch('/api/queue/retry-failed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowHours: 24 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.code || res.statusText);
      setStatusMessage(`Reset ${data.reset} failed action(s). Re-running…`);
      await handleDrainQueue(60_000);
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setStatusMessage(`Retry failed: ${e.message}`);
    } finally {
      setIsCampaignRunning(false);
    }
  };

  const handleStopCampaign = async () => {
    setStatusMessage('Stopping campaign and clearing queue…');
    try {
      const res = await fetch('/api/queue/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.code || res.statusText);
      setStatusMessage(`Stopped. Cleared ${data.cleared} pending action(s).`);
      setIsCampaignRunning(false);
      
      // Clear local executing state so UI reverts to Queued
      setActionStatusByDraft(prev => {
        const next = { ...prev };
        for (const [id, status] of Object.entries(next)) {
           if (status === 'executing') delete next[id];
        }
        return next;
      });
      await refreshProspects(selectedCampaignId || undefined);
    } catch (e: any) {
      setStatusMessage(`Stop failed: ${e.message}`);
    }
  };

  const qualifiedCount = prospects.filter(
    c => c.currentStage === 'EVALUATED' || c.currentStage === 'READY_FOR_CAMPAIGN'
  ).length;
  const rejectedCount = prospects.filter(
    c => c.currentStage === 'REJECTED' || c.currentStage === 'FILTERED_OUT'
  ).length;
  const readyProspects = prospects.filter(c => c.currentStage === 'READY_FOR_CAMPAIGN');

  return (
    <div className="app-shell">
      <div className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          RecruitmentOS
        </div>
        <div className="eyebrow">NAVIGATION</div>
        <nav>
          <button
            className={`nav-item ${activeTab === 'roles' ? 'active' : ''}`}
            onClick={() => setActiveTab('roles')}
          >
            📋 Job Roles & Criteria
          </button>
          <button
            className={`nav-item ${activeTab === 'upload' ? 'active' : ''}`}
            onClick={() => setActiveTab('upload')}
          >
            📥 Import Prospects
          </button>
          <button
            className={`nav-item ${activeTab === 'pipeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipeline')}
          >
            📊 Prospect Pipeline
          </button>
          <button
            className={`nav-item ${activeTab === 'export' ? 'active' : ''}`}
            onClick={() => setActiveTab('export')}
          >
            📤 Outreach & Export
          </button>
          <button
            className={`nav-item ${activeTab === 'engagement' ? 'active' : ''}`}
            onClick={() => setActiveTab('engagement')}
          >
            💬 Engagement Queue
          </button>
        </nav>
        <div className="sidebar-note">
          <span>STATUS</span>
          {statusMessage}
        </div>
      </div>

      <div className="main">
        <header>
          <div>
            <div className="eyebrow">SINGLE-USER WORKSPACE</div>
            <h1>Recruitment Outreach Workspace</h1>
          </div>
          <div className="status-pill">
            <span className="status-dot"></span> Single Operator Active
          </div>
        </header>

        {/* METRICS ROW */}
        <div className="metric-grid">
          <div className="metric">
            <span>TOTAL INGESTED</span>
            <strong>{prospects.length}</strong>
            <small>Prospects Processed</small>
          </div>
          <div className="metric">
            <span>QUALIFIED / READY</span>
            <strong>{qualifiedCount}</strong>
            <small>Approved for Outreach</small>
          </div>
          <div className="metric">
            <span>CAMPAIGNS</span>
            <strong>{campaignsList.length}</strong>
            <small>Discovery Runs</small>
          </div>
          <div className="metric">
            <span>DISQUALIFIED</span>
            <strong>{rejectedCount}</strong>
            <small>Filtered & Excluded</small>
          </div>
        </div>

        {/* TAB CONTENT: ROLES */}
        {activeTab === 'roles' && (
          <RolesPanel
            roleName={roleName}
            setRoleName={setRoleName}
            criteriaJson={criteriaJson}
            setCriteriaJson={setCriteriaJson}
            setStatusMessage={setStatusMessage}
          />
        )}

        {/* TAB CONTENT: UPLOAD */}
        {activeTab === 'upload' && (
          <UploadPanel
            roleName={roleName}
            criteriaJson={criteriaJson}
            setStatusMessage={setStatusMessage}
            refreshProspects={refreshProspects}
            refreshCampaigns={refreshCampaigns}
            setSelectedCampaignId={setSelectedCampaignId}
            setActiveTab={setActiveTab}
          />
        )}


        {/* TAB CONTENT: PIPELINE */}
        {activeTab === 'pipeline' && (
          <EngagementReview
            prospects={prospects}
            campaignsList={campaignsList}
            selectedCampaignId={selectedCampaignId}
            campaignDrafts={campaignDrafts}
            prospectsState={prospectsState}
            actionStatusByDraft={actionStatusByDraft}
            queueActions={queueActions}
            actionMode={actionMode}
            isCampaignRunning={isCampaignRunning}
            onSelectCampaign={setSelectedCampaignId}
            onRefreshProspects={(cId) => refreshProspects(cId || undefined)}
            onScanProspect={handleScanProspect}
            onDeleteProspect={handleDeleteProspect}
            onRunCampaign={handleRunCampaign}
            onStopCampaign={handleStopCampaign}
            onRetryFailed={handleRetryFailed}
            onSkipCommentWithLike={handleSkipCommentWithLike}
          />
        )}



        {/* TAB CONTENT: EXPORT */}
        {activeTab === 'export' && <ExportPanel />}

        {/* TAB CONTENT: ENGAGEMENT */}
        {activeTab === 'engagement' && (
          <EngagementPanel
            queueActions={queueActions}
            controls={controls}
            refreshEngagement={refreshEngagement}
            setStatusMessage={setStatusMessage}
          />
        )}
      </div>
    </div>
  );
}
