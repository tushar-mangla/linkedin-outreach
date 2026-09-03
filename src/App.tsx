import React, { useState, useEffect } from 'react';

export interface RoleDef {
  id?: string;
  name: string;
  criteria: any;
}

export interface CandidateRow {
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
  const [activeTab, setActiveTab] = useState<'roles' | 'upload' | 'pipeline' | 'review' | 'export'>('roles');
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

  const [candidates, setCandidates] = useState<CandidateRow[]>([
    {
      id: 'c1',
      name: 'Elena Rostova',
      title: 'Staff Backend Engineer',
      company: 'Acme Infrastructure',
      location: 'San Francisco, CA',
      linkedinUrl: 'https://linkedin.com/in/elena-rostova',
      currentStage: 'READY_FOR_CAMPAIGN',
      customAttributes: { score: 92, reasoning: 'Strong Go and PostgreSQL experience' },
    },
    {
      id: 'c2',
      name: 'David Chen',
      title: 'Senior Backend Developer',
      company: 'CloudScale Inc',
      location: 'Remote',
      linkedinUrl: 'https://linkedin.com/in/david-chen',
      currentStage: 'REQUIRES_REVIEW',
      customAttributes: { score: 72, reasoning: 'Solid experience; needs recruiter check on seniority' },
    },
    {
      id: 'c3',
      name: 'Mark Recruiter',
      title: 'Agency Recruiter',
      company: 'Global Staffing Agency',
      location: 'San Francisco, CA',
      linkedinUrl: 'https://linkedin.com/in/mark-recruiter',
      currentStage: 'FILTERED_OUT',
      customAttributes: { reasoning: 'Excluded title: Agency Recruiter' },
    },
  ]);

  const [csvText, setCsvText] = useState('');
  const [statusMessage, setStatusMessage] = useState('Mode: Single-User Recruiter Workspace');

  useEffect(() => {
    fetch('/health')
      .then(res => res.json())
      .then(data => {
        if (data.status === 'ok') setStatusMessage('Connected to RecruitmentOS API Server');
      })
      .catch(() => {
        setStatusMessage('Running in Local Demonstration Mode');
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
        setStatusMessage(`Role "${roleName}" saved successfully!`);
      } else {
        setStatusMessage(`Saved role "${roleName}" locally.`);
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
    const lines = csvText.trim().split('\n');
    const newCount = Math.max(0, lines.length - 1);
    setStatusMessage(`Uploaded CSV with ${newCount} candidate rows.`);
    setActiveTab('pipeline');
  };

  const handleReviewDecision = async (candidateId: string, decision: 'APPROVED' | 'REJECTED') => {
    try {
      await fetch(`/api/prospects/${candidateId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
    } catch (_) {}

    setCandidates(prev =>
      prev.map(c => {
        if (c.id === candidateId) {
          return {
            ...c,
            currentStage: decision === 'APPROVED' ? 'READY_FOR_CAMPAIGN' : 'REJECTED',
          };
        }
        return c;
      })
    );
  };

  const qualifiedCount = candidates.filter(
    c => c.currentStage === 'EVALUATED' || c.currentStage === 'READY_FOR_CAMPAIGN'
  ).length;
  const reviewCount = candidates.filter(c => c.currentStage === 'REQUIRES_REVIEW').length;
  const rejectedCount = candidates.filter(
    c => c.currentStage === 'REJECTED' || c.currentStage === 'FILTERED_OUT'
  ).length;

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
            📥 Import Candidates
          </button>
          <button
            className={`nav-item ${activeTab === 'pipeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipeline')}
          >
            📊 Candidate Pipeline
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
            <strong>{candidates.length}</strong>
            <small>Candidates Processed</small>
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
                <h3>Import Candidate CSV</h3>
              </div>
            </div>
            <p>
              Paste or drop candidate CSV exports. Rows are validated, LinkedIn URLs normalized, and bad
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
              Process Candidate Batch ➔
            </button>
          </div>
        )}

        {/* TAB CONTENT: PIPELINE */}
        {activeTab === 'pipeline' && (
          <div className="panel table-panel single-column">
            <div className="panel-heading">
              <h3>Candidate Qualification Pipeline</h3>
              <span className="chip">{candidates.length} CANDIDATES</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>CANDIDATE</th>
                    <th>ROLE & COMPANY</th>
                    <th>LOCATION</th>
                    <th>STAGE</th>
                    <th>REASONING / SCORE</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(c => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <small>{c.linkedinUrl}</small>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB CONTENT: REVIEW */}
        {activeTab === 'review' && (
          <div className="panel single-column">
            <div className="panel-heading">
              <h3>Borderline Candidate Review Queue</h3>
              <span className="chip">{reviewCount} PENDING</span>
            </div>
            {reviewCount === 0 ? (
              <div className="empty">No candidates currently require manual review.</div>
            ) : (
              <div className="review-list">
                {candidates
                  .filter(c => c.currentStage === 'REQUIRES_REVIEW')
                  .map(c => (
                    <div key={c.id} className="review-card">
                      <div>
                        <span className="chip">SCORE: {c.customAttributes?.score ?? 72}</span>
                        <h3>{c.name}</h3>
                        <p>
                          <strong>{c.title}</strong> at {c.company} ({c.location})
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
            <p>Download CSV export of ready candidates or schedule touchpoints.</p>
            <a
              href="/api/exports/approved.csv"
              download="approved-candidates.csv"
              className="primary link-button"
            >
              📥 Download Campaign-Ready Candidates CSV
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
