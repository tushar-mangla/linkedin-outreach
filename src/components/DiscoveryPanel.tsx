import React, { useState, useEffect } from 'react';
import { BD_QUERY_PRESETS, CANDIDATE_QUERY_PRESETS, getContentSearchQueryPresets, type DatePostedWindow } from '../services/discovery/content-search-queries.js';
import type { EngagerTarget } from '../types.js';
import type { PostEngagerRunResult } from '../services/discovery/post-engager-channel.js';

type Archetype = 'AGENCY_LEADERSHIP' | 'HIRING_LEADER';
type DiscoveryResult = {
  postsFound: number;
  signalsDetected: number;
  qualified: number;
  rejected: number;
  provider?: string;
  prospects: Array<{ prospectId: string; name: string; linkedinUrl: string; signalCategory: string; evidenceQuote: string | null; postUrl: string }>;
};

const presets = [...getContentSearchQueryPresets()];

interface DiscoveryPanelProps {
  roleName?: string;
  criteriaJson?: string;
  setStatusMessage?: (msg: string) => void;
  refreshProspects?: (cId?: string) => Promise<void>;
  refreshCampaigns?: () => Promise<void>;
  setSelectedCampaignId?: (id: string) => void;
  setActiveTab?: (tab: 'roles' | 'discovery' | 'pipeline' | 'export' | 'engagement') => void;
  queueActions?: any[];
  drafts?: any[];
  prospects?: any[];
}

export function DiscoveryPanel({
  roleName = '',
  criteriaJson = '{}',
  setStatusMessage = () => {},
  refreshProspects = async () => {},
  refreshCampaigns = async () => {},
  setSelectedCampaignId = () => {},
  setActiveTab = () => {},
  queueActions = [],
  drafts = [],
  prospects = [],
}: DiscoveryPanelProps) {
  const [activeChannel, setActiveChannel] = useState<'people' | 'csv' | 'signals' | 'engagers'>('people');

  // ─── Channel 1 State (People Search) ────────────────────────────────────────
  const [discovering, setDiscovering] = useState(false);
  const [selectedCountries, setSelectedCountries] = useState<string[]>(['US']);
  const [selectedPositions, setSelectedPositions] = useState<string[]>(['Director']);
  const [searchKeyword, setSearchKeyword] = useState<string>('recruitment');
  const [searchPage, setSearchPage] = useState<number>(1);
  const [peopleDiscoveryResult, setPeopleDiscoveryResult] = useState<{
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
  const [peopleDiscoveryError, setPeopleDiscoveryError] = useState('');

  // ─── Channel 2 State (CSV / Manual) ─────────────────────────────────────────
  const [csvText, setCsvText] = useState('');
  const [csvPreview, setCsvPreview] = useState<{ rowCount: number; format: string } | null>(null);
  const [newProspectName, setNewProspectName] = useState('');
  const [newProspectTitle, setNewProspectTitle] = useState('');
  const [newProspectCompany, setNewProspectCompany] = useState('');
  const [newProspectLinkedinUrl, setNewProspectLinkedinUrl] = useState('');
  const [newProspectLocation, setNewProspectLocation] = useState('');

  // ─── Channel 4 State (Buying Signals) ───────────────────────────────────────
  const [query, setQuery] = useState(presets[0]);
  const [customQuery, setCustomQuery] = useState('');
  const [recency, setRecency] = useState<DatePostedWindow>('past-24h');
  const [archetype, setArchetype] = useState<Archetype>('AGENCY_LEADERSHIP');
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [promoted, setPromoted] = useState<Record<string, boolean>>({});

  // ─── Channel 5 State (Competitor Engagers) ──────────────────────────────────
  const [targets, setTargets] = useState<EngagerTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [togglingTargetId, setTogglingTargetId] = useState<string | null>(null);
  const [c5Recency, setC5Recency] = useState<'past-24h' | 'past-week' | 'past-month'>('past-week');
  const [maxPostsPerTarget, setMaxPostsPerTarget] = useState(3);
  const [maxEngagersPerPost, setMaxEngagersPerPost] = useState(20);
  const [c5Running, setC5Running] = useState(false);
  const [c5Error, setC5Error] = useState('');
  const [c5Result, setC5Result] = useState<PostEngagerRunResult | null>(null);

  // Load Channel 1 Discovery State
  useEffect(() => {
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
        // Fallback gracefully
      }
    }
    refreshDiscoveryState();
  }, []);

  // Fetch Channel 5 Targets
  const fetchTargets = async () => {
    setLoadingTargets(true);
    try {
      const response = await fetch('/api/discovery/engager-targets');
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.code ?? 'Failed to load targets');
      const list: EngagerTarget[] = data.targets ?? [];
      setTargets(list);
      setSelectedTargetIds(list.filter((t) => t.isActive).map((t) => t.id));
    } catch (err) {
      setC5Error(err instanceof Error ? err.message : 'Failed to load targets');
    } finally {
      setLoadingTargets(false);
    }
  };

  useEffect(() => {
    if (activeChannel === 'engagers' && targets.length === 0 && !loadingTargets) {
      void fetchTargets();
    }
  }, [activeChannel]);

  // ─── Channel 1 Handlers ─────────────────────────────────────────────────────
  const handleDiscoverProspects = async () => {
    if (discovering) return;
    setDiscovering(true);
    setPeopleDiscoveryError('');
    setPeopleDiscoveryResult(null);
    setStatusMessage('Discovering prospects through OpenCLI LinkedIn & X-Ray...');
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
        const retryMessage =
          report.status === 'rate_limited'
            ? ` Google limited discovery${report.retryAfter ? `; retry in ${Math.ceil(report.retryAfter / 1000)} seconds` : ''}.`
            : '';
        setPeopleDiscoveryResult({
          status: report.status === 'rate_limited' ? 'rate_limited' : 'failed',
          discovered: report.discovered ?? 0,
          uniqueIngested: report.uniqueIngested ?? 0,
          duplicatesSkipped: report.duplicatesSkipped ?? 0,
          qualified: report.qualified ?? 0,
          reviewRequired: report.reviewRequired ?? 0,
          disqualified: report.disqualified ?? 0,
          retryAfter: report.retryAfter,
        });
        setPeopleDiscoveryError(`Discovery ${report.status === 'rate_limited' ? 'rate limited' : 'failed'}.${retryMessage}`);
        setStatusMessage(`Discovery did not run. Prior prospect state is preserved.${retryMessage}`);
        return;
      }
      const completedPage = report.page ?? searchPage;
      const nextPage = report.nextPage ?? completedPage + 1;
      const createdCampaign = report.campaign as { id: string; name: string } | null | undefined;
      setPeopleDiscoveryResult({
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
        `✓ Discovery complete for Page ${completedPage}: ${report.discovered ?? 0} found, ${report.uniqueIngested ?? 0} ingested.`
      );
      if (createdCampaign?.id) {
        await refreshCampaigns();
        setSelectedCampaignId(createdCampaign.id);
        await refreshProspects(createdCampaign.id);
      } else {
        await refreshProspects();
      }
    } catch (e: any) {
      setPeopleDiscoveryResult({
        status: 'failed',
        discovered: 0,
        uniqueIngested: 0,
        duplicatesSkipped: 0,
        qualified: 0,
        reviewRequired: 0,
        disqualified: 0,
      });
      setPeopleDiscoveryError(`Discovery failed: ${e.message}`);
      setStatusMessage(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
    }
  };

  // ─── Channel 2 Handlers ─────────────────────────────────────────────────────
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement> | React.DragEvent<HTMLDivElement>) => {
    let file: File | undefined;
    if ('dataTransfer' in e) {
      e.preventDefault();
      file = e.dataTransfer.files?.[0];
    } else {
      file = e.target.files?.[0];
    }
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      setCsvText(text);
      const lines = text.split('\n');
      const headers = lines[0]?.split(',') || [];
      const rowCount = Math.max(0, lines.length - 2);
      let format = 'Simple CSV';
      if (headers.some((h) => h.includes('First Name') || h.includes('Skill 1'))) format = 'Enriched Leads';
      else if (headers.some((h) => h.includes('Full Name'))) format = 'Sales Navigator';
      setCsvPreview({ rowCount, format });
      setStatusMessage(`Ready to import ${rowCount} prospects.`);
    };
    reader.readAsText(file);
  };

  const handleUploadCsv = async () => {
    if (!csvText.trim()) return;
    try {
      setStatusMessage('Uploading CSV batch...');
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
          body: JSON.stringify({ name: roleName || 'Imported Role', criteria: JSON.parse(criteriaJson || '{}') }),
        });
        if (created.ok) icpDefinitionId = (await created.json()).id;
      }
      const upload = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, icpDefinitionId, filename: 'prospects.csv' }),
      });
      if (!upload.ok) throw new Error(await upload.text());
      const { batch } = await upload.json();
      const processed = await fetch(`/api/imports/${batch.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText }),
      });
      if (!processed.ok) throw new Error(await processed.text());
      const resData = await processed.json();
      setStatusMessage(`✓ Imported batch: ${resData.processedRows ?? 'all'} rows qualified.`);
      await refreshProspects();
      setActiveTab('pipeline');
    } catch (e: any) {
      setStatusMessage(`Import failed: ${e.message}`);
    }
  };

  const handleAddProspect = async () => {
    const name = newProspectName.trim();
    const linkedinUrl = newProspectLinkedinUrl.trim();
    if (!name || !linkedinUrl) {
      alert('Please provide at least a Name and LinkedIn URL.');
      return;
    }
    const escapeCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [
      'Full Name,Job Title,Company,Location,LinkedIn Profile URL',
      `${escapeCsv(name)},${escapeCsv(newProspectTitle)},${escapeCsv(newProspectCompany)},${escapeCsv(newProspectLocation)},${escapeCsv(linkedinUrl)}`,
    ].join('\n');
    try {
      setStatusMessage(`Adding prospect "${name}"...`);
      let icps: any[] = [];
      const icpRes = await fetch('/api/icps');
      if (icpRes.ok) icps = await icpRes.json();
      const icpDefinitionId = icps[0]?.id;
      const upload = await fetch('/api/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, icpDefinitionId, filename: 'single-prospect.csv' }),
      });
      const { batch } = await upload.json();
      await fetch(`/api/imports/${batch.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      setNewProspectName('');
      setNewProspectTitle('');
      setNewProspectCompany('');
      setNewProspectLinkedinUrl('');
      setNewProspectLocation('');
      setStatusMessage(`✓ Prospect "${name}" added to pipeline.`);
      await refreshProspects();
    } catch (e: any) {
      setStatusMessage(`Add failed: ${e.message}`);
    }
  };

  // ─── Channel 4 Handlers ─────────────────────────────────────────────────────
  const runSearch = async () => {
    const searchQuery = query === '__custom__' ? customQuery.trim() : query;
    if (!searchQuery) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/discovery/content-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: [searchQuery], recency, archetype, maxPostsPerQuery: 10 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.code ?? 'Search failed');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setRunning(false);
    }
  };

  const promote = async (prospectId: string) => {
    try {
      const response = await fetch(`/api/discovery/prospects/${prospectId}/promote`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.code ?? 'Promotion failed');
      setPromoted((prev) => ({ ...prev, [prospectId]: true }));
      await refreshProspects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed');
    }
  };

  // ─── Channel 5 Handlers ─────────────────────────────────────────────────────
  const seedTargets = async () => {
    setSeeding(true);
    setC5Error('');
    try {
      const response = await fetch('/api/discovery/engager-targets/seed', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.code ?? 'Failed to seed targets');
      const list: EngagerTarget[] = data.targets ?? [];
      setTargets(list);
      setSelectedTargetIds(list.filter((t) => t.isActive).map((t) => t.id));
    } catch (err) {
      setC5Error(err instanceof Error ? err.message : 'Failed to seed targets');
    } finally {
      setSeeding(false);
    }
  };

  const toggleTargetActive = async (target: EngagerTarget) => {
    setTogglingTargetId(target.id);
    setC5Error('');
    try {
      const nextActive = !target.isActive;
      const response = await fetch(`/api/discovery/engager-targets/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.code ?? 'Failed to update target');
      const updated: EngagerTarget = data.target;
      setTargets((current) => current.map((t) => (t.id === updated.id ? updated : t)));
      if (!nextActive) {
        setSelectedTargetIds((current) => current.filter((id) => id !== updated.id));
      } else {
        setSelectedTargetIds((current) => [...new Set([...current, updated.id])]);
      }
    } catch (err) {
      setC5Error(err instanceof Error ? err.message : 'Failed to update target');
    } finally {
      setTogglingTargetId(null);
    }
  };

  const toggleTargetSelection = (id: string) => {
    setSelectedTargetIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const selectAllActive = () => setSelectedTargetIds(targets.filter((t) => t.isActive).map((t) => t.id));
  const deselectAll = () => setSelectedTargetIds([]);

  const runC5Sourcing = async () => {
    if (selectedTargetIds.length === 0) {
      setC5Error('Select at least one competitor/influencer target.');
      return;
    }
    setC5Running(true);
    setC5Error('');
    setC5Result(null);
    try {
      const response = await fetch('/api/discovery/post-engagers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetIds: selectedTargetIds,
          recency: c5Recency,
          maxPostsPerTarget,
          maxEngagersPerPost,
        }),
      });
      const text = await response.text();
      let data: any = null;
      try {
        if (text) data = JSON.parse(text);
      } catch {
        // Fallback for non-JSON
      }
      if (!response.ok) {
        throw new Error(data?.message ?? data?.code ?? `Server returned error (${response.status})`);
      }
      if (!data) {
        throw new Error('Received empty response from server');
      }
      setC5Result(data);
      await refreshProspects();
    } catch (err) {
      setC5Error(err instanceof Error ? err.message : 'Failed to run engager sourcing');
    } finally {
      setC5Running(false);
    }
  };

  const competitors = targets.filter((t) => t.targetType === 'COMPETITOR');
  const influencers = targets.filter((t) => t.targetType === 'INFLUENCER');
  const activeCount = targets.filter((t) => t.isActive).length;

  // Live Queue & Funnel Status Calculation
  const pendingQueueCount = queueActions.filter((a) => a.status === 'PENDING').length;
  const readyDraftsCount = drafts.filter((d) => d.status === 'PENDING' || d.status === 'APPROVED').length;
  const readyProspectsCount = prospects.filter((p) => p.currentStage === 'READY_FOR_CAMPAIGN' || p.currentStage === 'APPROVED_FOR_OUTREACH').length;

  return (
    <div className="panel discovery-panel">
      {/* ─── LIVE QUEUE & FUNNEL STATUS BANNER ─── */}
      <div
        style={{
          background: pendingQueueCount > 0 ? '#18342e' : '#f0f5ee',
          color: pendingQueueCount > 0 ? '#fff' : '#273b32',
          border: '1px solid #d0dfd4',
          borderRadius: '8px',
          padding: '14px 18px',
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{
              display: 'inline-block',
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              background: pendingQueueCount > 0 ? '#7ea73e' : '#9bb0a5',
            }}
          />
          <div>
            <strong style={{ fontSize: '13px', display: 'block' }}>
              {pendingQueueCount > 0
                ? `Queue Running: ${pendingQueueCount} Action(s) Scheduled (Auto-drains every 5 min)`
                : 'Execution Queue is Idle (0 actions pending)'}
            </strong>
            <small style={{ opacity: 0.85, fontSize: '11px' }}>
              {readyDraftsCount} drafts waiting in pool · {readyProspectsCount} qualified prospects in campaign pipeline
            </small>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            className="text-button"
            style={{
              color: pendingQueueCount > 0 ? '#d9f26a' : '#18342e',
              background: pendingQueueCount > 0 ? 'rgba(255,255,255,0.1)' : '#fff',
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: '4px',
              padding: '6px 12px',
              fontWeight: 700,
            }}
            onClick={() => setActiveTab('engagement')}
          >
            Open Queue ({pendingQueueCount}) ➜
          </button>
          <button
            type="button"
            className="text-button"
            style={{
              color: pendingQueueCount > 0 ? '#fff' : '#18342e',
              background: 'transparent',
              border: '1px solid rgba(120,120,120,0.3)',
              borderRadius: '4px',
              padding: '6px 12px',
            }}
            onClick={() => setActiveTab('pipeline')}
          >
            View Pipeline ({readyProspectsCount}) ➜
          </button>
        </div>
      </div>

      {/* ─── UNIFIED DISCOVERY CHANNELS SUB-NAVIGATION ─── */}
      <div className="discovery-subnav" role="tablist" aria-label="Lead Discovery Channels">
        <button
          className={`discovery-subnav-btn ${activeChannel === 'people' ? 'active' : ''}`}
          onClick={() => setActiveChannel('people')}
          role="tab"
          aria-selected={activeChannel === 'people'}
        >
          👥 People Search (Ch. 1)
        </button>
        <button
          className={`discovery-subnav-btn ${activeChannel === 'csv' ? 'active' : ''}`}
          onClick={() => setActiveChannel('csv')}
          role="tab"
          aria-selected={activeChannel === 'csv'}
        >
          📁 CSV / List Import (Ch. 2)
        </button>
        <button
          className={`discovery-subnav-btn ${activeChannel === 'signals' ? 'active' : ''}`}
          onClick={() => setActiveChannel('signals')}
          role="tab"
          aria-selected={activeChannel === 'signals'}
        >
          🎯 Buying Signals (Ch. 3)
        </button>
        <button
          className={`discovery-subnav-btn ${activeChannel === 'engagers' ? 'active' : ''}`}
          onClick={() => setActiveChannel('engagers')}
          role="tab"
          aria-selected={activeChannel === 'engagers'}
        >
          🔥 Competitor Engagers (Ch. 4)
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          CHANNEL 1: PEOPLE SEARCH (AUTOMATED LINKEDIN & X-RAY)
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeChannel === 'people' && (
        <>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">CHANNEL 1</div>
              <h3>Automated People Search</h3>
            </div>
            <span className="chip">LINKEDIN & GOOGLE X-RAY</span>
          </div>
          <p>
            Automated prospect discovery via OpenCLI LinkedIn and Google X-Ray search. Matches are qualified through your ICP criteria and automatically loaded into the campaign.
          </p>

          <div style={{ margin: '1rem 0', padding: '1.2rem', background: '#f7faf5', border: '1px solid #d9e2d9', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 0.8rem', fontSize: '13px', color: '#18342e', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Target Geography & Job Titles
            </h4>

            {/* Countries */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.4rem', display: 'block', color: '#45534d' }}>
                Target Countries (Multi-select)
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
                        setSelectedCountries((prev) =>
                          checked ? (prev.length > 1 ? prev.filter((c) => c !== country.id) : prev) : [...prev, country.id]
                        );
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: checked ? '2px solid #2e7d32' : '1px solid #ccc',
                        background: checked ? '#e8f5e9' : '#fff',
                        fontWeight: checked ? 700 : 500,
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      {country.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Positions */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '12px', fontWeight: '700', marginBottom: '0.4rem', display: 'block', color: '#45534d' }}>
                Target Roles / Seniority (Multi-select)
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {['Founder', 'Co-Founder', 'Owner', 'Managing Director', 'Director', 'Partner', 'Principal', 'CEO', 'President'].map((pos) => {
                  const checked = selectedPositions.includes(pos);
                  return (
                    <button
                      key={pos}
                      type="button"
                      onClick={() => {
                        setSelectedPositions((prev) =>
                          checked ? (prev.length > 1 ? prev.filter((p) => p !== pos) : prev) : [...prev, pos]
                        );
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: checked ? '2px solid #2e7d32' : '1px solid #ccc',
                        background: checked ? '#e8f5e9' : '#fff',
                        fontWeight: checked ? 700 : 500,
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      {pos}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Keyword & Page */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '14px' }}>
              <label style={{ margin: 0 }}>
                Niche / Industry Keyword
                <input
                  type="text"
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  placeholder="e.g. recruitment, executive search"
                />
              </label>
              <label style={{ margin: 0 }}>
                Page Number
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={searchPage}
                  onChange={(e) => setSearchPage(Math.max(1, parseInt(e.target.value) || 1))}
                />
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '1rem' }}>
            <button className="primary" onClick={handleDiscoverProspects} disabled={discovering} style={{ margin: 0 }}>
              {discovering ? 'Searching LinkedIn & Qualifying...' : `Discover Prospects (Page ${searchPage})`}
              {discovering && <span className="spinner" aria-label="Loading" />}
            </button>
            {peopleDiscoveryResult?.status === 'completed' && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSearchPage((p) => p + 1);
                  setTimeout(handleDiscoverProspects, 50);
                }}
                disabled={discovering}
                style={{ fontWeight: 700, textDecoration: 'underline' }}
              >
                Auto-Advance to Page {searchPage + 1} ➜
              </button>
            )}
          </div>

          {peopleDiscoveryError && <div className="notice discovery-error">{peopleDiscoveryError}</div>}

          {peopleDiscoveryResult && (
            <div className="discovery-summary" style={{ marginTop: '14px' }}>
              <strong>Found: {peopleDiscoveryResult.discovered}</strong>
              <span>Ingested: {peopleDiscoveryResult.uniqueIngested}</span>
              <span>Qualified: {peopleDiscoveryResult.qualified}</span>
              <span>Disqualified: {peopleDiscoveryResult.disqualified}</span>
              {peopleDiscoveryResult.campaign && (
                <span>
                  Enrolled in: <b>{peopleDiscoveryResult.campaign.name}</b>
                </span>
              )}
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          CHANNEL 2: CSV & LIST IMPORT
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeChannel === 'csv' && (
        <>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">CHANNEL 2</div>
              <h3>CSV File & Direct List Import</h3>
            </div>
            <span className="chip">BATCH INGESTION</span>
          </div>
          <p>
            Drop a spreadsheet of LinkedIn profile URLs or paste raw CSV text. The pipeline will automatically extract identities, evaluate them against your ICP, and enroll them for outreach.
          </p>

          <div className="file-drop" onDragOver={(e) => e.preventDefault()} onDrop={handleFileUpload} style={{ marginBottom: '20px' }}>
            <div className="upload-icon">📄</div>
            <strong>Drag & Drop your Prospect CSV here</strong>
            <small>Supports Sales Navigator exports, Apollo, or simple name/URL lists</small>
            <label className="primary" style={{ marginTop: '10px', display: 'inline-block', cursor: 'pointer' }}>
              Browse Files
              <input type="file" accept=".csv" onChange={handleFileUpload} />
            </label>
          </div>

          {csvPreview && (
            <div className="discovery-summary">
              <strong>{csvPreview.rowCount} rows detected</strong>
              <span>Format: {csvPreview.format}</span>
              <button className="primary" onClick={handleUploadCsv} style={{ marginLeft: 'auto', margin: 0, padding: '8px 14px' }}>
                Process & Enroll {csvPreview.rowCount} Leads ➜
              </button>
            </div>
          )}

          <div style={{ marginTop: '24px', padding: '16px', background: '#fcfdfa', border: '1px solid #d9e2d9', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 12px', fontSize: '13px', color: '#18342e' }}>Or Manually Add a Single Prospect:</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
              <input
                placeholder="Full Name *"
                value={newProspectName}
                onChange={(e) => setNewProspectName(e.target.value)}
              />
              <input
                placeholder="LinkedIn Profile URL *"
                value={newProspectLinkedinUrl}
                onChange={(e) => setNewProspectLinkedinUrl(e.target.value)}
              />
              <input
                placeholder="Job Title"
                value={newProspectTitle}
                onChange={(e) => setNewProspectTitle(e.target.value)}
              />
              <input
                placeholder="Company Name"
                value={newProspectCompany}
                onChange={(e) => setNewProspectCompany(e.target.value)}
              />
            </div>
            <button className="primary" onClick={handleAddProspect} style={{ margin: 0, padding: '10px 16px' }}>
              Add & Qualify Prospect
            </button>
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          CHANNEL 3: BUYING SIGNALS (CONTENT SEARCH)
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeChannel === 'signals' && (
        <>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">CHANNEL 3</div>
              <h3>Content Discovery & Buying Signals</h3>
            </div>
            <span className="chip">HIGH INTENT</span>
          </div>
          <p>
            Search recent LinkedIn content for grounded buying signals (hiring announcements, agency challenges) and promote post authors directly into your campaign.
          </p>

          <div className="discovery-controls">
            <label>
              Preset Query
              <select value={query} onChange={(e) => setQuery(e.target.value)}>
                {BD_QUERY_PRESETS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
                <optgroup label="Hiring leader">
                  {CANDIDATE_QUERY_PRESETS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </optgroup>
                <option value="__custom__">Custom query...</option>
              </select>
            </label>
            {query === '__custom__' && (
              <label>
                Custom Query
                <input
                  value={customQuery}
                  onChange={(e) => setCustomQuery(e.target.value)}
                  placeholder="e.g. scaling engineering team"
                />
              </label>
            )}
            <label>
              Recency
              <select value={recency} onChange={(e) => setRecency(e.target.value as DatePostedWindow)}>
                <option value="past-24h">Past 24 hours</option>
                <option value="past-week">Past week</option>
                <option value="past-month">Past month</option>
              </select>
            </label>
            <label>
              Archetype
              <select value={archetype} onChange={(e) => setArchetype(e.target.value as Archetype)}>
                <option value="AGENCY_LEADERSHIP">Agency leadership</option>
                <option value="HIRING_LEADER">Hiring leader</option>
              </select>
            </label>
          </div>

          <button className="primary" onClick={runSearch} disabled={running}>
            {running ? 'Scanning LinkedIn Posts...' : 'Run Content Search'}
            {running && <span className="spinner" aria-label="Loading" />}
          </button>

          {error && <div className="notice discovery-error">{error}</div>}

          {result && (
            <>
              <div className="discovery-summary">
                <strong>{result.postsFound} posts</strong>
                <span>{result.signalsDetected} signals</span>
                <span>{result.qualified} qualified</span>
                <span>{result.rejected} rejected</span>
                <b>{(result.provider ?? 'unknown').toUpperCase()}</b>
              </div>

              <div className="discovery-results">
                {result.prospects.length === 0 ? (
                  <div className="empty">No qualified prospects found for this query.</div>
                ) : (
                  result.prospects.map((prospect) => (
                    <article className="discovery-result" key={prospect.prospectId}>
                      <div>
                        <h4>{prospect.name}</h4>
                        <a href={prospect.linkedinUrl} target="_blank" rel="noopener noreferrer">
                          View LinkedIn Profile
                        </a>
                        <div className="chip discovery-category">{prospect.signalCategory}</div>
                        <blockquote>
                          {prospect.evidenceQuote ? `“${prospect.evidenceQuote}”` : 'No evidence quote.'}
                        </blockquote>
                      </div>
                      <button
                        className={promoted[prospect.prospectId] ? 'promoted' : 'approve'}
                        onClick={() => promote(prospect.prospectId)}
                        disabled={promoted[prospect.prospectId]}
                      >
                        {promoted[prospect.prospectId] ? '✓ Enrolled in Campaign' : 'Promote to Campaign'}
                      </button>
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          CHANNEL 4: COMPETITOR & INFLUENCER ENGAGERS
      ═══════════════════════════════════════════════════════════════════════ */}
      {activeChannel === 'engagers' && (
        <>
          <div className="panel-heading">
            <div>
              <div className="eyebrow">CHANNEL 4</div>
              <h3>Competitor & Influencer Engagers</h3>
            </div>
            <span className="chip">POST ENGAGERS</span>
          </div>
          <p>
            Extract active commenters and likers from competitor and influencer posts, qualify their profiles, and automatically queue warm-up recommendations.
          </p>

          <div className="engager-targets-section">
            <div className="targets-header">
              <h4>
                Target Registry ({targets.length} targets · {activeCount} active)
              </h4>
              <div className="targets-header-actions">
                {targets.length > 0 && (
                  <>
                    <button type="button" className="text-button" onClick={selectAllActive}>
                      Select All Active
                    </button>
                    <span style={{ color: '#cbd8ce' }}>|</span>
                    <button type="button" className="text-button" onClick={deselectAll}>
                      Deselect All
                    </button>
                    <span style={{ color: '#cbd8ce' }}>|</span>
                  </>
                )}
                <button type="button" className="text-button" onClick={seedTargets} disabled={seeding}>
                  {seeding ? 'Seeding...' : targets.length === 0 ? 'Seed Default Targets' : 'Re-seed Targets'}
                </button>
              </div>
            </div>

            {loadingTargets && (
              <div style={{ color: '#718079', fontSize: 13, padding: '12px 0' }}>Loading targets...</div>
            )}

            {!loadingTargets && targets.length === 0 && (
              <div style={{ color: '#718079', fontSize: 13, padding: '12px 0' }}>
                No engager targets configured. Click <strong>Seed Default Targets</strong> to load Bullhorn, Ashby, Loxo, HireEZ, and top recruitment influencers.
              </div>
            )}

            {!loadingTargets && targets.length > 0 && (
              <>
                <div className="targets-group-title">Competitors ({competitors.length})</div>
                <div className="targets-grid">
                  {competitors.map((target) => (
                    <div key={target.id} className={`target-card ${target.isActive ? '' : 'inactive'}`}>
                      <div className="target-info">
                        <input
                          type="checkbox"
                          checked={selectedTargetIds.includes(target.id)}
                          onChange={() => toggleTargetSelection(target.id)}
                          disabled={!target.isActive}
                        />
                        <span className="target-name">{target.displayName}</span>
                        <a href={target.linkedinUrl} target="_blank" rel="noopener noreferrer">
                          ↗
                        </a>
                      </div>
                      <button
                        type="button"
                        className={`target-toggle ${target.isActive ? 'active' : ''}`}
                        onClick={() => toggleTargetActive(target)}
                        disabled={togglingTargetId === target.id}
                      >
                        {target.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </button>
                    </div>
                  ))}
                </div>

                <div className="targets-group-title">Industry Influencers ({influencers.length})</div>
                <div className="targets-grid">
                  {influencers.map((target) => (
                    <div key={target.id} className={`target-card ${target.isActive ? '' : 'inactive'}`}>
                      <div className="target-info">
                        <input
                          type="checkbox"
                          checked={selectedTargetIds.includes(target.id)}
                          onChange={() => toggleTargetSelection(target.id)}
                          disabled={!target.isActive}
                        />
                        <span className="target-name">{target.displayName}</span>
                        <a href={target.linkedinUrl} target="_blank" rel="noopener noreferrer">
                          ↗
                        </a>
                      </div>
                      <button
                        type="button"
                        className={`target-toggle ${target.isActive ? 'active' : ''}`}
                        onClick={() => toggleTargetActive(target)}
                        disabled={togglingTargetId === target.id}
                      >
                        {target.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="discovery-controls" style={{ marginBottom: '14px' }}>
            <label>
              Recency Window
              <select
                value={c5Recency}
                onChange={(e) => setC5Recency(e.target.value as 'past-24h' | 'past-week' | 'past-month')}
              >
                <option value="past-24h">Past 24 hours</option>
                <option value="past-week">Past week</option>
                <option value="past-month">Past month</option>
              </select>
            </label>
            <label>
              Max Posts per Target
              <input
                type="number"
                min={1}
                max={10}
                value={maxPostsPerTarget}
                onChange={(e) => setMaxPostsPerTarget(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </label>
            <label>
              Max Engagers per Post
              <input
                type="number"
                min={1}
                max={50}
                value={maxEngagersPerPost}
                onChange={(e) => setMaxEngagersPerPost(Math.max(1, parseInt(e.target.value) || 1))}
              />
            </label>
          </div>

          <button className="primary" onClick={runC5Sourcing} disabled={c5Running || selectedTargetIds.length === 0}>
            {c5Running
              ? 'Extracting & Qualifying Engagers...'
              : `Run Engager Sourcing (${selectedTargetIds.length} targets selected)`}
            {c5Running && <span className="spinner" aria-label="Loading" />}
          </button>

          {c5Error && <div className="notice discovery-error">{c5Error}</div>}

          {c5Result && (
            <>
              <div className="discovery-summary">
                <strong>{c5Result.counts.targets} targets</strong>
                <span>{c5Result.counts.posts} posts</span>
                <span>{c5Result.counts.engagers} engagers found</span>
                <span>{c5Result.counts.qualified} qualified</span>
                <span>{c5Result.counts.draftCreated} drafts queued</span>
              </div>

              <div className="discovery-results">
                {c5Result.prospects.length === 0 ? (
                  <div className="empty">No engagers discovered for this run.</div>
                ) : (
                  c5Result.prospects.map((engager, idx) => (
                    <article className="discovery-result" key={`${engager.prospectId}-${idx}`}>
                      <div>
                        <h4>{engager.name || 'Anonymous Engager'}</h4>
                        <div className="prospect-links">
                          <a href={engager.linkedinUrl} target="_blank" rel="noopener noreferrer">
                            Profile ↗
                          </a>
                          <a href={engager.sourcePostUrl} target="_blank" rel="noopener noreferrer">
                            Source Post ↗
                          </a>
                        </div>
                        <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <span className="engager-interaction-chip">{engager.interaction}</span>
                          <span style={{ fontSize: '11px', color: '#65746e' }}>Target: {engager.targetName}</span>
                        </div>
                        <span className={`engager-outcome-badge ${engager.outcome.toLowerCase().replace(/_/g, '-')}`}>
                          {engager.outcome}
                        </span>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
