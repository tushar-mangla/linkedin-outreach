import React, { useState, useEffect } from 'react';

interface UploadPanelProps {
  roleName: string;
  criteriaJson: string;
  setStatusMessage: (msg: string) => void;
  refreshProspects: (cId?: string) => Promise<void>;
  refreshCampaigns: () => Promise<void>;
  setSelectedCampaignId: (id: string) => void;
  setActiveTab: (tab: 'roles' | 'upload' | 'pipeline' | 'export' | 'engagement') => void;
}

export function UploadPanel({
  roleName,
  criteriaJson,
  setStatusMessage,
  refreshProspects,
  refreshCampaigns,
  setSelectedCampaignId,
  setActiveTab,
}: UploadPanelProps) {
  const [csvText, setCsvText] = useState('');
  const [csvPreview, setCsvPreview] = useState<{ rowCount: number, format: string } | null>(null);

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
        // Server offline or unavailable seam
      }
    }
    refreshDiscoveryState();
  }, []);

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
      let format = 'Unknown Format';
      if (headers.some(h => h.includes('First Name') || h.includes('Skill 1'))) format = 'Enriched Leads';
      else if (headers.some(h => h.includes('Full Name'))) format = 'Sales Navigator';
      else if (headers.some(h => h.includes('name') && h.includes('title'))) format = 'Simple CSV';
      
      setCsvPreview({ rowCount, format });
      setStatusMessage(`Ready to import ${rowCount} prospects.`);
    };
    reader.readAsText(file);
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
      setDiscoveryResult({
        status: 'failed',
        discovered: 0,
        uniqueIngested: 0,
        duplicatesSkipped: 0,
        qualified: 0,
        reviewRequired: 0,
        disqualified: 0,
      });
      setDiscoveryError(`Discovery failed: ${e.message}`);
      setStatusMessage(`Discovery failed: ${e.message}`);
    } finally {
      setDiscovering(false);
    }
  };

  return (
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
        {!discovering && discoveryResult && discoveryResult.status === 'completed' && (
          <div className="empty" style={{ marginTop: '0.5rem', textAlign: 'left', padding: '12px 16px', background: '#e5f0c8', borderRadius: '6px', color: '#3d5220' }}>
            <strong>Discovery Complete (Page {discoveryResult.page ?? searchPage})</strong>: {discoveryResult.discovered} found · {discoveryResult.uniqueIngested} ingested & enrolled ·{' '}
            {discoveryResult.duplicatesSkipped} duplicates skipped · {discoveryResult.disqualified} disqualified.
            <div style={{ marginTop: '4px', fontSize: '12px', fontWeight: '600', color: '#2c5147' }}>
              ➔ Auto-advanced to Page {discoveryResult.nextPage ?? (searchPage + 1)} for next run.
            </div>
          </div>
        )}
        {!discovering && discoveryError && (
          <div className="empty" style={{ marginTop: '0.5rem', color: '#d32f2f' }}>
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
          Drop a prospect CSV file below. Automatically detects Enriched Leads, Sales Navigator exports, and Simple CSV formats.
        </p>
        
        <div 
          className="upload-dropzone" 
          style={{ 
            border: '2px dashed #b9c9bd', 
            borderRadius: '8px', 
            padding: '2rem', 
            textAlign: 'center', 
            background: '#fcfdfc',
            cursor: 'pointer',
            marginBottom: '1rem'
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleFileUpload}
          onClick={() => document.getElementById('csv-upload-input')?.click()}
        >
          <input 
            id="csv-upload-input" 
            type="file" 
            accept=".csv" 
            style={{ display: 'none' }} 
            onChange={handleFileUpload} 
          />
          <div style={{ fontSize: '24px', marginBottom: '0.5rem' }}>📄</div>
          <h4 style={{ margin: '0 0 0.5rem', color: '#18342e' }}>Click to Browse or Drag & Drop</h4>
          <p style={{ margin: 0, fontSize: '13px', color: '#55655d' }}>Supports .csv files</p>
        </div>

        {csvPreview && (
          <div style={{ padding: '1rem', background: '#f0f5fa', border: '1px solid #cce0ff', borderRadius: '8px', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h4 style={{ margin: '0 0 0.25rem', color: '#004085' }}>File Ready</h4>
              <p style={{ margin: 0, fontSize: '13px', color: '#004085' }}>{csvPreview.rowCount} rows detected</p>
            </div>
            <span className="chip" style={{ background: '#004085', color: 'white' }}>{csvPreview.format}</span>
          </div>
        )}

        <details style={{ marginBottom: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '13px', color: '#55655d', padding: '0.5rem 0' }}>Advanced: Paste Raw CSV</summary>
          <textarea
            className="criteria"
            style={{ height: 160, marginTop: '0.5rem' }}
            placeholder="Paste CSV contents here (name, title, company, location, linkedinUrl, skills)..."
            value={csvText}
            onChange={e => {
              setCsvText(e.target.value);
              setCsvPreview(null);
            }}
          />
        </details>

        <button className="primary" onClick={handleUploadCsv} disabled={!csvText.trim()}>
          Process Prospect Batch ➔
        </button>
      </div>
    </div>
  );
}
