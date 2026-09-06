import React, { useState, useEffect } from 'react';
import { EngagementReview } from './components/EngagementReview';

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

  const [csvText, setCsvText] = useState('');
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
  const [newProspectName, setNewProspectName] = useState('');
  const [newProspectTitle, setNewProspectTitle] = useState('');
  const [newProspectCompany, setNewProspectCompany] = useState('');
  const [newProspectLinkedinUrl, setNewProspectLinkedinUrl] = useState('');
  const [newProspectLocation, setNewProspectLocation] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [selectedCountries, setSelectedCountries] = useState<string[]>(['US']);
  const [selectedPositions, setSelectedPositions] = useState<string[]>(['Director']);
  const [searchKeyword, setSearchKeyword] = useState<string>('recruitment');
  const [searchPage, setSearchPage] = useState<number>(1);
  const [discoveryResult, setDiscoveryResult] = useState<{
    status: 'completed' | 'rate_limited' | 'failed';
    page?: number;
    nextPage?: number;
    discovered: number;
    uniqueIngested: number;
    duplicatesSkipped: number;
    qualified: number;
    reviewRequired: number;
    disqualified: number;
    retryAfter?: number;
    campaign?: { id: string; name: string };
  } | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
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
    if (activeTab === 'engagement') {
      refreshEngagement();
      refreshProspects();
    }
    if (activeTab === 'pipeline') {
      refreshProspects();
    }
  }, [activeTab]);

  async function refreshDiscoveryState() {
    try {
      const res = await fetch('/api/prospects/discovery-state');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.nextPage === 'number') setSearchPage(data.nextPage);
        if (Array.isArray(data.countries) && data.countries.length > 0) setSelectedCountries(data.countries);
        if (Array.isArray(data.positions) && data.positions.length > 0) setSelectedPositions(data.positions);
        if (typeof data.keyword === 'string' && data.keyword.trim()) setSearchKeyword(data.keyword);
      }
    } catch {
      // Server offline or unavailable seam
    }
  }

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
    refreshDiscoveryState();
  }, []);

  const handleCreateRole = async () => {
    try {
      const parsedCriteria = JSON.parse(criteriaJson);
      const res = await fetch('/api/icps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roleName, criteria: parsedCriteria }),
      });
      if (res.ok) {
        const saved = await res.json();
        setStatusMessage(`Role "${saved.name ?? roleName}" saved on the server.`);
      } else {
        setStatusMessage(`Role save refused (${res.status}): ${await res.text()}`);
      }
    } catch (e: any) {
      alert(`Invalid JSON format in criteria: ${e.message}`);
    }
  };

  const handleUploadCsv = async () => {
    if (!csvText.trim()) {
      alert('Please paste or drag a CSV file first.');
      return;
    }
    try {
      setStatusMessage('Resolving target role for import…');
      let icps: any[] = [];
      const icpRes = await fetch('/api/icps');
      if (icpRes.ok) {
        const body = await icpRes.json();
        if (Array.isArray(body)) icps = body;
      }
      let icpDefinitionId = icps[0]?.id;
      if (!icpDefinitionId) {
        const created = await fetch('/api/icps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: roleName || 'Imported Role', criteria: JSON.parse(criteriaJson) }),
        });
        if (!created.ok) {
          setStatusMessage(`Import refused: could not resolve a role (${created.status}): ${await created.text()}`);
          return;
        }
        icpDefinitionId = (await created.json()).id;
      }
      setStatusMessage('Uploading CSV batch to the server…');
      const upload = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, icpDefinitionId, filename: 'prospects.csv' }),
      });
      if (!upload.ok) {
        setStatusMessage(`Import refused (${upload.status}): ${await upload.text()}`);
        return;
      }
      const { batch } = await upload.json();
      setStatusMessage(`Processing import batch ${batch.id}…`);
      const processed = await fetch(`/api/imports/${batch.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      if (!processed.ok) {
        setStatusMessage(`Import processing refused (${processed.status}): ${await processed.text()}`);
        return;
      }
      const result = await processed.json();
      setStatusMessage(`Imported batch ${result.id ?? batch.id}: ${result.processedRows ?? 'unknown'} rows processed.`);
      await refreshProspects();
      setActiveTab('pipeline');
    } catch (e: any) {
      setStatusMessage(`Import failed: ${e.message}`);
    }
  };

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

  const qualifiedCount = prospects.filter(
    c => c.currentStage === 'EVALUATED' || c.currentStage === 'READY_FOR_CAMPAIGN'
  ).length;
  const rejectedCount = prospects.filter(
    c => c.currentStage === 'REJECTED' || c.currentStage === 'FILTERED_OUT'
  ).length;
  const readyProspects = prospects.filter(c => c.currentStage === 'READY_FOR_CAMPAIGN');

  const escapeCsvField = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const handleAddProspect = async () => {
    const name = newProspectName.trim();
    const title = newProspectTitle.trim();
    const company = newProspectCompany.trim();
    const linkedinUrl = newProspectLinkedinUrl.trim();
    const location = newProspectLocation.trim();
    if (!name || !title || !company || !linkedinUrl) {
      alert('Please fill in Full Name, Headline / Title, Company, and LinkedIn Profile URL.');
      return;
    }
    try {
      new URL(linkedinUrl);
    } catch {
      alert('LinkedIn Profile URL must be a valid URL (e.g. https://www.linkedin.com/in/someone).');
      return;
    }
    try {
      setStatusMessage('Resolving target role for import…');
      let icps: any[] = [];
      const icpRes = await fetch('/api/icps');
      if (icpRes.ok) {
        const body = await icpRes.json();
        if (Array.isArray(body)) icps = body;
      }
      let icpDefinitionId = icps[0]?.id;
      if (!icpDefinitionId) {
        const created = await fetch('/api/icps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: roleName || 'Imported Role', criteria: JSON.parse(criteriaJson) }),
        });
        if (!created.ok) {
          setStatusMessage(`Add prospect refused: could not resolve a role (${created.status}): ${await created.text()}`);
          return;
        }
        icpDefinitionId = (await created.json()).id;
      }
      const header = 'name,title,company,location,linkedinUrl';
      const row = [name, title, company, location, linkedinUrl].map(escapeCsvField).join(',');
      const csv = `${header}\n${row}\n`;
      setStatusMessage('Adding prospect to the server…');
      const upload = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, icpDefinitionId, filename: 'prospect-manual-add.csv' }),
      });
      if (!upload.ok) {
        setStatusMessage(`Add prospect refused (${upload.status}): ${await upload.text()}`);
        return;
      }
      const { batch } = await upload.json();
      const processed = await fetch(`/api/imports/${batch.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      if (!processed.ok) {
        setStatusMessage(`Add prospect processing refused (${processed.status}): ${await processed.text()}`);
        return;
      }
      setNewProspectName('');
      setNewProspectTitle('');
      setNewProspectCompany('');
      setNewProspectLinkedinUrl('');
      setNewProspectLocation('');
      setStatusMessage(`Prospect "${name}" added. Refreshing list…`);
      await refreshProspects();
    } catch (e: any) {
      setStatusMessage(`Add prospect failed: ${e.message}`);
    }
  };
  const handleDiscoverProspects = async () => {
    if (discovering) return;
    setDiscovering(true);
    setDiscoveryError('');
    setDiscoveryResult(null);
    setStatusMessage('Discovering prospects through OpenCLI LinkedIn...');
    try {
      const res = await fetch('/api/prospects/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countries: selectedCountries,
          positions: selectedPositions,
          keyword: searchKeyword,
          page: searchPage,
        }),
      });
      const report = await res.json();
      if (!res.ok || report.status !== 'completed') {
        const retryMessage = report.status === 'rate_limited'
          ? ` Google limited discovery${report.retryAfter ? `; retry in ${Math.ceil(report.retryAfter / 1000)} seconds` : ''}.`
          : '';
        setDiscoveryResult({
          status: report.status === 'rate_limited' ? 'rate_limited' : 'failed',
          discovered: report.discovered ?? 0,
          uniqueIngested: report.uniqueIngested ?? 0,
          duplicatesSkipped: report.duplicatesSkipped ?? 0,
          qualified: report.qualified ?? 0,
          reviewRequired: report.reviewRequired ?? 0,
          disqualified: report.disqualified ?? 0,
          retryAfter: report.retryAfter,
        });
        setDiscoveryError(`Discovery ${report.status === 'rate_limited' ? 'rate limited' : 'failed'}.${retryMessage}`);
        setStatusMessage(`Discovery did not run. Prior prospect state is preserved.${retryMessage}`);
        return;
      }
      const completedPage = report.page ?? searchPage;
      const nextPage = report.nextPage ?? (completedPage + 1);
      const createdCampaign = report.campaign as { id: string; name: string } | null | undefined;
      setDiscoveryResult({
        status: 'completed',
        page: completedPage,
        nextPage,
        discovered: report.discovered ?? 0,
        uniqueIngested: report.uniqueIngested ?? 0,
        duplicatesSkipped: report.duplicatesSkipped ?? 0,
        qualified: report.qualified ?? 0,
        reviewRequired: report.reviewRequired ?? 0,
        disqualified: report.disqualified ?? 0,
        campaign: createdCampaign ?? undefined,
      });
      setSearchPage(nextPage);
      setStatusMessage(
        `Discovery complete for Page ${completedPage}: ${report.discovered ?? 0} found, ${report.uniqueIngested ?? 0} ingested. Auto-advanced to Page ${nextPage} for next run.`
      );
      // Auto-navigate to the created campaign in Pipeline tab
      if (createdCampaign?.id) {
        await refreshCampaigns();
        setSelectedCampaignId(createdCampaign.id);
        setActiveTab('pipeline');
        await refreshProspects(createdCampaign.id);
      } else {
        await refreshProspects();
      }
    } catch (e: any) {
      setDiscoveryError(`Discovery failed: ${e.message}`);
      setStatusMessage(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
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
  // 60s gap is required to avoid LinkedIn rate-limiting (12s was too aggressive).
  const handleDrainQueue = async (gapMs = 60_000) => {
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

  const handleKillSwitch = async (accountId: string, actionType: string, active: boolean) => {
    try {
      const response = await fetch('/api/execution/kill-switches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, actionType, active }),
      });
      if (!response.ok) {
        setStatusMessage(`Kill-switch refused (${response.status}): ${await response.text()}`);
        return;
      }
      setStatusMessage(`Kill-switch ${active ? 'activated' : 'cleared'} for ${actionType}.`);
      await refreshEngagement();
    } catch (e: any) {
      setStatusMessage(`Kill-switch failed: ${e.message}`);
    }
  };

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
          <div className="content-grid">
            <div className="panel intro-panel">
              <span className="chip">STEP 1</span>
              <h2>Define Hiring Criteria & Criteria Rules</h2>
              <p>
                Set target job titles, required skills, target seniority levels, and hard exclusions
                (e.g., agency recruiters or non-target locations).
              </p>
            </div>
            <div className="panel">
              <div className="panel-heading">
                <h3>Recruitment Role Definition</h3>
                <span className="chip">JSON SCHEMA</span>
              </div>
              <label>
                Role Name
                <input
                  type="text"
                  value={roleName}
                  onChange={e => setRoleName(e.target.value)}
                />
              </label>
              <br />
              <label>
                Hiring Criteria JSON
                <textarea
                  className="criteria"
                  value={criteriaJson}
                  onChange={e => setCriteriaJson(e.target.value)}
                />
              </label>
              <button className="primary" onClick={handleCreateRole}>
                Save Recruitment Role Criteria ➔
              </button>
            </div>
          </div>
        )}

        {/* TAB CONTENT: UPLOAD */}
        {activeTab === 'upload' && (
          <div className="panel upload-panel single-column">
            <div className="panel-heading">
              <div>
                <span className="chip">STEP 2</span>
                <h3>Import & Discover Prospects</h3>
              </div>
            </div>
            
            <div className="panel" style={{ marginBottom: '2rem', border: '2px solid #1976d2' }}>
              <div className="panel-heading">
                <h3>Automated Prospect Discovery</h3>
                <span className="chip">OPENCLI LINKEDIN</span>
              </div>
              <p>
                Automated prospect discovery via OpenCLI LinkedIn search for boutique recruitment agency founders.
                New matches are qualified through the server pipeline automatically.
              </p>

              {/* DISCOVERY PARAMETERS FORM */}
              <div style={{ margin: '1rem 0', padding: '1rem', background: '#f7faf5', border: '1px solid #d9e2d9', borderRadius: '8px' }}>
                <h4 style={{ margin: '0 0 0.8rem', fontSize: '14px', color: '#18342e' }}>Discovery Filters & Search Parameters</h4>
                
                {/* Countries (Multi-select) */}
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.4rem', display: 'block', color: '#45534d' }}>
                    Target Countries (Multi-select — Default: US)
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {[
                      { id: 'US', label: '🇺🇸 United States' },
                      { id: 'UK', label: '🇬🇧 United Kingdom' },
                      { id: 'CA', label: '🇨🇦 Canada' },
                      { id: 'AU', label: '🇦🇺 Australia' },
                      { id: 'IN', label: '🇮🇳 India' },
                      { id: 'DE', label: '🇩🇪 Germany' },
                      { id: 'FR', label: '🇫🇷 France' },
                    ].map((country) => {
                      const checked = selectedCountries.includes(country.id);
                      return (
                        <button
                          key={country.id}
                          type="button"
                          onClick={() => {
                            if (checked) {
                              if (selectedCountries.length > 1) {
                                setSelectedCountries(selectedCountries.filter((c) => c !== country.id));
                              }
                            } else {
                              setSelectedCountries([...selectedCountries, country.id]);
                            }
                          }}
                          style={{
                            background: checked ? '#18342e' : '#fff',
                            color: checked ? '#fff' : '#18342e',
                            border: `1px solid ${checked ? '#18342e' : '#b9c9bd'}`,
                            padding: '6px 12px',
                            borderRadius: '16px',
                            fontSize: '12px',
                            fontWeight: '600',
                            cursor: 'pointer'
                          }}
                        >
                          {country.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '1rem' }}>
                  {/* Job Positions (Multi-select) */}
                  <div style={{ flex: 2 }}>
                    <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.3rem', display: 'block', color: '#45534d' }}>
                      Target Roles
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {['Founder', 'Owner', 'Partner', 'Director', 'CEO'].map((pos) => {
                        const checked = selectedPositions.includes(pos);
                        return (
                          <button
                            key={pos}
                            type="button"
                            onClick={() => {
                              if (checked) {
                                if (selectedPositions.length > 1) {
                                  setSelectedPositions(selectedPositions.filter((p) => p !== pos));
                                }
                              } else {
                                setSelectedPositions([...selectedPositions, pos]);
                              }
                            }}
                            style={{
                              background: checked ? '#e5f0c8' : '#fff',
                              color: checked ? '#18342e' : '#55655d',
                              border: `1px solid ${checked ? '#a5c07b' : '#d9e2d9'}`,
                              padding: '4px 10px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: '600',
                              cursor: 'pointer'
                            }}
                          >
                            {pos}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Industry Keyword */}
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.3rem', display: 'block', color: '#45534d' }}>
                      Industry Keyword
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. recruitment"
                      value={searchKeyword}
                      onChange={(e) => setSearchKeyword(e.target.value)}
                      style={{ width: '100%', padding: '8px 12px' }}
                    />
                  </div>

                  {/* Page Override */}
                  <div style={{ width: '80px' }}>
                    <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.3rem', display: 'block', color: '#45534d' }}>
                      Page Number
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={searchPage}
                      onChange={(e) => setSearchPage(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      style={{ width: '100%', padding: '8px 12px' }}
                    />
                  </div>
                </div>
              </div>

              <button className="primary" onClick={handleDiscoverProspects} disabled={discovering}>
                {discovering ? 'Discovering…' : 'Discover ICP Prospects ➔'}
              </button>
              {discovering && (
                <div className="empty" style={{ marginTop: '0.5rem' }}>
                  Discovering prospects through OpenCLI LinkedIn...
                </div>
              )}
              {!discovering && discoveryResult && (
                <div className="empty" style={{ marginTop: '0.5rem', textAlign: 'left', padding: '12px 16px', background: '#e5f0c8', borderRadius: '6px', color: '#3d5220' }}>
                  <strong>Discovery Complete (Page {discoveryResult.page ?? searchPage})</strong>: {discoveryResult.discovered} found · {discoveryResult.uniqueIngested} ingested & enrolled ·{' '}
                  {discoveryResult.duplicatesSkipped} duplicates skipped · {discoveryResult.disqualified} disqualified.
                  <div style={{ marginTop: '4px', fontSize: '12px', fontWeight: '600', color: '#2c5147' }}>
                    ➔ Auto-advanced to Page {discoveryResult.nextPage ?? (searchPage + 1)} for next run.
                  </div>
                </div>
              )}
              {!discovering && discoveryError && (
                <div className="empty" style={{ marginTop: '0.5rem' }}>
                  {discoveryError}
                </div>
              )}
            </div>

            <div className="panel" style={{ marginBottom: '2rem' }}>
              <div className="panel-heading">
                <h3>Add Prospect Manually</h3>
                <span className="chip">MANUAL ADD</span>
              </div>
              <p>
                New here? Add your first real LinkedIn prospect below — no CSV needed.
                Fill in the profile details and it is imported through the server automatically.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <label>
                  Full Name
                  <input
                    type="text"
                    placeholder="e.g. Ada Lovelace"
                    value={newProspectName}
                    onChange={e => setNewProspectName(e.target.value)}
                  />
                </label>
                <label>
                  Headline / Title
                  <input
                    type="text"
                    placeholder="e.g. Staff Backend Engineer"
                    value={newProspectTitle}
                    onChange={e => setNewProspectTitle(e.target.value)}
                  />
                </label>
                <label>
                  Company
                  <input
                    type="text"
                    placeholder="e.g. Acme Corp"
                    value={newProspectCompany}
                    onChange={e => setNewProspectCompany(e.target.value)}
                  />
                </label>
                <label>
                  Location (optional)
                  <input
                    type="text"
                    placeholder="e.g. San Francisco"
                    value={newProspectLocation}
                    onChange={e => setNewProspectLocation(e.target.value)}
                  />
                </label>
              </div>
              <label style={{ marginTop: '0.5rem' }}>
                LinkedIn Profile URL
                <input
                  type="url"
                  placeholder="https://www.linkedin.com/in/someone"
                  value={newProspectLinkedinUrl}
                  onChange={e => setNewProspectLinkedinUrl(e.target.value)}
                />
              </label>
              <button className="primary" onClick={handleAddProspect} style={{ marginTop: '0.75rem' }}>
                Add Prospect ➔
              </button>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <h3>Import Prospect CSV</h3>
                <span className="chip">CSV UPLOAD</span>
              </div>
              <p>
                Paste or drop prospect CSV exports. Rows are validated, LinkedIn URLs normalized, and bad
                rows isolated automatically.
              </p>
              <textarea
                className="criteria"
                style={{ height: 160 }}
                placeholder="Paste CSV contents here (name, title, company, location, linkedinUrl, skills)..."
                value={csvText}
                onChange={e => setCsvText(e.target.value)}
              />
              <button className="primary" onClick={handleUploadCsv}>
                Process Prospect Batch ➔
              </button>
            </div>
          </div>
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
            actionMode={actionMode}
            isCampaignRunning={isCampaignRunning}
            onSelectCampaign={setSelectedCampaignId}
            onRefreshProspects={(cId) => refreshProspects(cId || undefined)}
            onScanProspect={handleScanProspect}
            onDeleteProspect={handleDeleteProspect}
            onRunCampaign={handleRunCampaign}
            onRetryFailed={handleRetryFailed}
            onSkipCommentWithLike={handleSkipCommentWithLike}
          />
        )}



        {/* TAB CONTENT: EXPORT */}
        {activeTab === 'export' && (
          <div className="panel single-column">
            <div className="panel-heading">
              <h3>Outreach & Export</h3>
              <span className="chip">CAMPAIGN READY</span>
            </div>
            <p>Download CSV export of ready prospects or schedule touchpoints.</p>
            <a
              href="/api/exports/approved.csv"
              download="approved-prospects.csv"
              className="primary link-button"
            >
              📥 Download Campaign-Ready Prospects CSV
            </a>
          </div>
        )}

        {/* TAB CONTENT: ENGAGEMENT */}
        {activeTab === 'engagement' && (() => {
          return (
          <div className="panel single-column">
            <div className="panel-heading">
              <h3>Engagement Queue</h3>
              <span className="chip">{queueActions.length} QUEUED ACTIONS</span>
            </div>
            <p>
              Execute queued LinkedIn actions. Comment review happens inside each Campaign's prospect list.
            </p>

            {/* Execution settings */}
            <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#f7faf5', border: '1px solid #d9e2d9', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <h4 style={{ margin: '0 0 0.25rem', fontSize: '13px', color: '#18342e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Execution Settings</h4>
              <label style={{ fontSize: '13px' }}>
                Account ID
                <input type="text" value={actionAccountId} onChange={e => setActionAccountId(e.target.value)} style={{ marginTop: '4px' }} />
              </label>
              <label style={{ fontSize: '13px' }}>
                Mode
                <select value={actionMode} onChange={e => setActionMode(e.target.value as 'BROWSER' | 'SIMULATE' | 'MANUAL')} style={{ marginTop: '4px' }}>
                  <option value="BROWSER">BROWSER (Live Playwright Chrome)</option>
                  <option value="SIMULATE">SIMULATE</option>
                  <option value="MANUAL">MANUAL</option>
                </select>
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                <button className="primary" onClick={handleProcessQueue}>
                  ⚡ Process Pending Queue ({actionMode})
                </button>
                <button style={{ border: '1px solid #b9c9bd', background: '#fff', color: '#18342e', padding: '6px 14px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' }} onClick={refreshEngagement}>
                  ↺ Refresh
                </button>
              </div>
            </div>

            {/* Queue actions — only shown when there are items */}
            {queueActions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
                <h4 style={{ margin: '0 0 0.5rem', fontSize: '13px', color: '#18342e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Queued Actions</h4>
                {queueActions.map((action: any) => (
                  <div key={action.id} style={{ padding: '0.6rem 0.9rem', border: '1px solid #d9e2d9', borderRadius: '6px', background: '#fff', fontSize: '13px', color: '#33453e' }}>
                    <strong>{action.actionType}</strong> · {action.status} · {action.outcomeLabel ?? 'pending'}
                    {action.errorCode ? <span style={{ color: '#c0392b', marginLeft: '8px' }}>{action.errorCode}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">No actions in queue right now.</div>
            )}

            {/* Kill switches */}
            {controls.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 0.75rem', fontSize: '13px', color: '#18342e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Kill Switches</h4>
                {controls.map((control: any) => (
                  <div key={control.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.9rem', border: '1px solid #d9e2d9', borderRadius: '6px', background: '#fff', marginBottom: '0.5rem' }}>
                    <small style={{ color: '#45534d' }}>{control.actionType} · enabled={String(control.enabled)} · kill={String(control.killSwitchActive)}</small>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button onClick={() => handleKillSwitch(control.accountId, control.actionType, true)} style={{ background: '#c0392b', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}>Stop</button>
                      <button onClick={() => handleKillSwitch(control.accountId, control.actionType, false)} style={{ background: '#27ae60', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}>Clear</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          );
        })()} 
      </div>
    </div>
  );
}
