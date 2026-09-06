import React, { useState, useEffect } from 'react';

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
  const [activeTab, setActiveTab] = useState<'roles' | 'upload' | 'pipeline' | 'review' | 'export' | 'engagement'>('roles');
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
        qualificationThreshold: 80,
        reviewThreshold: 50,
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
  const [actionAccountId, setActionAccountId] = useState('00000000-0000-0000-0000-000000000002');
  const [actionMode, setActionMode] = useState<'BROWSER' | 'SIMULATE' | 'MANUAL'>('BROWSER');
  const [selectedProspectId, setSelectedProspectId] = useState<string>('');
  const [newProspectName, setNewProspectName] = useState('');
  const [newProspectTitle, setNewProspectTitle] = useState('');
  const [newProspectCompany, setNewProspectCompany] = useState('');
  const [newProspectLinkedinUrl, setNewProspectLinkedinUrl] = useState('');
  const [newProspectLocation, setNewProspectLocation] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState<{
    status: 'completed' | 'rate_limited' | 'failed';
    discovered: number;
    uniqueIngested: number;
    duplicatesSkipped: number;
    qualified: number;
    reviewRequired: number;
    disqualified: number;
    retryAfter?: number;
  } | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');

  async function refreshProspects() {
    setProspectsState('loading');
    try {
      const res = await fetch('/api/prospects');
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
    if (activeTab === 'pipeline' || activeTab === 'review') {
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

  const handleReviewDecision = async (prospectId: string, decision: 'APPROVED' | 'REJECTED') => {
    try {
      const response = await fetch(`/api/prospects/${prospectId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!response.ok) {
        setStatusMessage(`Review refused: ${await response.text()}`);
        return;
      }
      const updated = await response.json();
      setProspects(prev => prev.map(c => c.id === prospectId ? { ...c, currentStage: updated.currentStage } : c));
      setStatusMessage(`Review ${decision.toLowerCase()} on the server.`);
    } catch (error: any) {
      setStatusMessage(`Review failed: ${error.message}`);
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
  const reviewCount = prospects.filter(c => c.currentStage === 'REQUIRES_REVIEW').length;
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
        body: JSON.stringify({}),
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
      setDiscoveryResult({
        status: 'completed',
        discovered: report.discovered ?? 0,
        uniqueIngested: report.uniqueIngested ?? 0,
        duplicatesSkipped: report.duplicatesSkipped ?? 0,
        qualified: report.qualified ?? 0,
        reviewRequired: report.reviewRequired ?? 0,
        disqualified: report.disqualified ?? 0,
      });
      setStatusMessage(
        `Discovery complete: ${report.discovered ?? 0} found, ${report.uniqueIngested ?? 0} ingested, ${report.duplicatesSkipped ?? 0} duplicates skipped. Refreshing pipeline…`
      );
      await refreshProspects();
    } catch (e: any) {
      setDiscoveryError(`Discovery failed: ${e.message}`);
      setStatusMessage(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
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

  const handleProcessQueue = async () => {
    try {
      setStatusMessage(`Processing queued action (${actionMode})…`);
      const response = await fetch('/api/queue/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: actionAccountId, mode: actionMode }),
      });
      const data = await response.json();
      if (!response.ok || !data.processed) {
        setStatusMessage(`Queue processing note: ${data.reason || data.code || response.statusText}`);
      } else {
        setStatusMessage(`Action executed: ${data.result?.outcomeLabel || data.action?.status || 'DONE'} (status: ${data.action?.status})`);
      }
      await refreshEngagement();
    } catch (e: any) {
      setStatusMessage(`Queue processing failed: ${e.message}`);
    }
  };

  const handleRequestAction = async (draftId: string, actionType: 'LIKE' | 'COMMENT') => {
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

      // Automatically dispatch queue execution
      await handleProcessQueue();
    } catch (e: any) {
      setStatusMessage(`Action request failed: ${e.message}`);
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
            className={`nav-item ${activeTab === 'review' ? 'active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            👤 Review Queue ({reviewCount})
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
            <span>REQUIRES REVIEW</span>
            <strong>{reviewCount}</strong>
            <small>Recruiter Borderline Queue</small>
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
                <h3>Import Prospect CSV</h3>
              </div>
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
        )}

        {/* TAB CONTENT: PIPELINE */}
        {activeTab === 'pipeline' && (
          <div className="panel table-panel single-column">
            <div className="panel-heading">
              <h3>Prospect Qualification Pipeline</h3>
              <span className="chip">{prospects.length} PROSPECTS · {prospectsState}</span>
            </div>
            <div className="panel" style={{ marginBottom: '1rem', border: '2px solid #1976d2' }}>
              <div className="panel-heading">
                <h3>Automated Prospect Discovery</h3>
                <span className="chip">OPENCLI LINKEDIN</span>
              </div>
              <p>
                Automated prospect discovery via OpenCLI LinkedIn search for boutique recruitment agency founders.
                New matches are qualified through the server pipeline automatically.
              </p>
              <button className="primary" onClick={handleDiscoverProspects} disabled={discovering}>
                {discovering ? 'Discovering…' : 'Discover ICP Prospects ➔'}
              </button>
              {discovering && (
                <div className="empty" style={{ marginTop: '0.5rem' }}>
                  Discovering prospects through OpenCLI LinkedIn...
                </div>
              )}
              {!discovering && discoveryResult && (
                <div className="empty" style={{ marginTop: '0.5rem' }}>
                  Discovery complete: {discoveryResult.discovered} found · {discoveryResult.uniqueIngested} ingested ·{' '}
                  {discoveryResult.duplicatesSkipped} duplicates skipped · {discoveryResult.qualified} qualified ·{' '}
                  {discoveryResult.reviewRequired} for review · {discoveryResult.disqualified} disqualified.
                </div>
              )}
              {!discovering && discoveryError && (
                <div className="empty" style={{ marginTop: '0.5rem' }}>
                  {discoveryError}
                </div>
              )}
            </div>
            <div className="panel" style={{ marginBottom: '1rem' }}>
              <div className="panel-heading">
                <h3>Add Prospect</h3>
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
            {prospectsState === 'loading' && <div className="empty">Loading prospects from the server…</div>}
            {prospectsState === 'error' && <div className="empty">Prospects unavailable. Prior server state is preserved; no local fallback is shown.</div>}
            {prospectsState === 'empty' && <div className="empty">No prospects on the server yet. Use “Add Prospect” above or import a CSV on the Import Prospects tab to get started.</div>}
            {prospectsState === 'ready' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>PROSPECT</th>
                    <th>ROLE & COMPANY</th>
                    <th>LOCATION</th>
                    <th>STAGE</th>
                    <th>REASONING / SCORE</th>
                    <th>ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map(c => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">View LinkedIn Profile ↗</a>
                      </td>
                      <td>
                        <strong>{c.title}</strong>
                        <small>{c.company}</small>
                      </td>
                      <td>{c.location}</td>
                      <td>
                        <span className={`stage ${c.currentStage.toLowerCase()}`}>
                          {c.currentStage}
                        </span>
                      </td>
                      <td>{c.customAttributes?.reasoning || 'Evaluated against job spec'}</td>
                      <td><button className="reject" onClick={() => handleDeleteProspect(c)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        )}

        {/* TAB CONTENT: REVIEW */}
        {activeTab === 'review' && (
          <div className="panel single-column">
            <div className="panel-heading">
              <h3>Borderline Prospect Review Queue</h3>
              <span className="chip">{reviewCount} PENDING</span>
            </div>
            {reviewCount === 0 ? (
              <div className="empty">No prospects currently require manual review.</div>
            ) : (
              <div className="review-list">
                {prospects
                  .filter(c => c.currentStage === 'REQUIRES_REVIEW')
                  .map(c => (
                    <div key={c.id} className="review-card">
                      <div>
                        <span className="chip">SCORE: {c.customAttributes?.score ?? 72}</span>
                        <h3>
                          <a href={c.linkedinUrl} target="_blank" rel="noreferrer">
                            {c.customAttributes?.name ?? c.linkedinUrl}
                          </a>
                        </h3>
                        <p>
                          <strong>{c.customAttributes?.title ?? '—'}</strong>
                          {c.customAttributes?.company ? ` at ${c.customAttributes.company}` : ''}
                          {c.customAttributes?.location ? ` (${c.customAttributes.location})` : ''}
                        </p>
                        <small>{c.customAttributes?.reasoning}</small>
                      </div>
                      <div className="review-actions">
                        <button
                          className="approve"
                          onClick={() => handleReviewDecision(c.id, 'APPROVED')}
                        >
                          ✓ Approve for Campaign
                        </button>
                        <button
                          className="reject"
                          onClick={() => handleReviewDecision(c.id, 'REJECTED')}
                        >
                          ✕ Disqualify
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
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
          const selectedProspect = prospects.find(p => p.id === selectedProspectId);
          const filteredDrafts = selectedProspectId
            ? drafts.filter(draft => draft.prospectId === selectedProspectId || draft.post?.prospectId === selectedProspectId)
            : drafts;
          const filteredQueueActions = selectedProspectId
            ? queueActions.filter(action => action.prospectId === selectedProspectId)
            : queueActions;

          return (
          <div className="content-grid">
            <div className="panel intro-panel">
              <span className="chip">ENGAGEMENT</span>
              <h2>Social Selling & Engagement</h2>
              <p>
                Scan your approved prospects for recent LinkedIn activity. Review evidence-grounded drafts,
                approve an exact revision, then request SIMULATE or MANUAL execution. Browser execution stays
                disabled unless the server enables it. Every result below is server truth: pending, simulated,
                manual-confirmed, browser-executed, verified, uncertain, refused, or failed.
              </p>
              <div style={{ marginTop: '1rem', padding: '0.75rem', border: '2px solid #1976d2', borderRadius: '8px', background: '#f3f8ff' }}>
                <h3 style={{ margin: '0 0 0.5rem' }}>Prospect Selector</h3>
                {prospectsState === 'loading' && <div className="empty">Loading prospects…</div>}
                {prospectsState === 'error' && <div className="empty">Prospects unavailable. Prior server state is preserved.</div>}
                {prospects.length === 0 && prospectsState !== 'loading' ? (
                  <div className="empty">
                    No prospects yet. Go to the Prospect Pipeline tab and use “Add Prospect” to add your first LinkedIn profile, then return here to select and scan.
                  </div>
                ) : (
                  <>
                    <label>
                      Choose a prospect to scan
                      <select
                        value={selectedProspectId}
                        onChange={e => setSelectedProspectId(e.target.value)}
                        style={{ marginTop: '0.25rem', width: '100%' }}
                      >
                        <option value="">— Select a prospect —</option>
                        {prospects.map(p => (
                          <option key={p.id} value={p.id}>
                           {p.customAttributes?.name ?? p.linkedinUrl} — {p.customAttributes?.company ?? ''} — {p.customAttributes?.title ?? ''} [{p.currentStage}]
                          </option>
                        ))}
                     </select>
                     {selectedProspectId && selectedProspect && (
                        <div className="prospect-details">
                          <strong>{selectedProspect.customAttributes?.name ?? selectedProspect.linkedinUrl}</strong>
                          <span>{selectedProspect.customAttributes?.company ?? ''}{selectedProspect.customAttributes?.title ? ` · ${selectedProspect.customAttributes.title}` : ''}</span>
                          <a href={selectedProspect.linkedinUrl} target="_blank" rel="noopener noreferrer">View LinkedIn Profile ↗</a>
                        </div>
                     )}
                    </label>
                    {readyProspects.length === 0 && (
                      <div className="empty" style={{ marginTop: '0.5rem' }}>
                        No prospects are READY_FOR_CAMPAIGN yet. Approve one from the Review Queue, then select it here.
                      </div>
                    )}
                  </>
                )}
              </div>
              <button
                className="primary"
                onClick={handleScanProspects}
                disabled={!selectedProspectId && readyProspects.length === 0}
                title={!selectedProspectId && readyProspects.length === 0 ? 'Select a prospect first' : 'Scan the selected prospect'}
                style={{ marginTop: '1rem' }}
              >
                Scan for Posts
              </button>
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label>
                  Execution account ID
                  <input type="text" value={actionAccountId} onChange={e => setActionAccountId(e.target.value)} />
                </label>
                <label>
                  Execution mode
                  <select value={actionMode} onChange={e => setActionMode(e.target.value as 'BROWSER' | 'SIMULATE' | 'MANUAL')}>
                    <option value="BROWSER">BROWSER (Live Playwright Chrome)</option>
                    <option value="SIMULATE">SIMULATE</option>
                    <option value="MANUAL">MANUAL</option>
                  </select>
                </label>
                <button className="primary" onClick={refreshEngagement}>
                  Refresh server state
                </button>
              </div>
              <div style={{ marginTop: '1rem' }}>
                <h3>Controls & kill switches (server truth)</h3>
                {controls.length === 0 ? (
                  <div className="empty">No controls configured. Like/Comment stay disabled until the server enables them.</div>
                ) : (
                  controls.map((control: any) => (
                    <div key={control.id} style={{ marginBottom: '0.5rem' }}>
                      <small>{control.actionType} · enabled={String(control.enabled)} · kill={String(control.killSwitchActive)}</small>
                      <div>
                        <button onClick={() => handleKillSwitch(control.accountId, control.actionType, true)}>Activate stop</button>
                        <button onClick={() => handleKillSwitch(control.accountId, control.actionType, false)}>Clear stop</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="panel">
              <div className="panel-heading">
                <h3>Draft Review Queue</h3>
                <span className="chip">
                  {filteredDrafts.length} DRAFTS {selectedProspect ? `FOR ${selectedProspect.customAttributes?.name?.toUpperCase() ?? 'SELECTED PROSPECT'}` : '(ALL PROSPECTS)'}
                </span>
              </div>
              {filteredDrafts.length === 0 ? (
                <div className="empty">
                  {selectedProspect
                    ? `No engagement drafts for ${selectedProspect.customAttributes?.name ?? 'selected prospect'} yet. Click "Scan for Posts" above.`
                    : 'No engagement drafts yet. Select a prospect and click "Scan for Posts".'}
                </div>
              ) : (
                <div className="review-list">
                  {filteredDrafts.map(draft => (
                    <div key={draft.id} className="review-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <div style={{ padding: '0.5rem', background: 'rgba(0,0,0,0.02)', borderRadius: '4px', borderLeft: '3px solid #ccc' }}>
                        <small style={{ color: '#666', display: 'block', marginBottom: '0.25rem' }}>
                          Post by {draft.post?.authorName} (via {draft.post?.sourceType})
                        </small>
                        <em>"{draft.post?.postText}"</em>
                      </div>
                      <div style={{ padding: '0.5rem', background: '#e3f2fd', borderRadius: '4px', borderLeft: '3px solid #1976d2' }}>
                        <small style={{ color: '#1976d2', display: 'block', marginBottom: '0.25rem' }}>
                          Draft ({draft.actionType}) · status: <strong>{draft.status}</strong>
                        </small>
                        <strong>{draft.commentText}</strong>
                      </div>
                      <div className="review-actions" style={{ justifyContent: 'flex-start', marginTop: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <button className="approve" onClick={() => handleDraftDecision(draft.id, 'APPROVED')}>
                          ✓ Approve Draft
                        </button>
                        <button className="primary" onClick={() => handleRequestAction(draft.id, draft.actionType as 'LIKE' | 'COMMENT')}>
                          🚀 Execute {draft.actionType} ({actionMode})
                        </button>
                        <button className="reject" onClick={() => handleDraftDecision(draft.id, 'SKIPPED')}>
                          ✕ Skip
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ marginTop: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <h3 style={{ margin: 0 }}>
                    Queue {selectedProspect ? `(${selectedProspect.customAttributes?.name ?? 'Selected Prospect'})` : '(All)'}
                  </h3>
                  <button className="primary" style={{ padding: '0.25rem 0.75rem', fontSize: '0.85rem' }} onClick={handleProcessQueue}>
                    ⚡ Process Pending Queue ({actionMode})
                  </button>
                </div>
                {filteredQueueActions.length === 0 ? (
                  <div className="empty">No queued actions for this prospect.</div>
                ) : (
                  filteredQueueActions.map((action: any) => (
                    <div key={action.id}>
                      <small>{action.actionType} · {action.status} · {action.outcomeLabel ?? 'pending'} · {action.errorCode ?? 'no-error'}</small>
                    </div>
                  ))
                )}
                <h3>Audit (server truth, redacted)</h3>
                {auditEvents.length === 0 ? (
                  <div className="empty">No audit events.</div>
                ) : (
                  auditEvents.slice(0, 10).map((event: any) => (
                    <div key={event.id}>
                      <small>{event.eventType} · {event.entityType}</small>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          );
        })()}
      </div>
    </div>
  );
}
