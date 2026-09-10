import React from 'react';

interface RolesPanelProps {
  roleName: string;
  setRoleName: (val: string) => void;
  criteriaJson: string;
  setCriteriaJson: (val: string) => void;
  setStatusMessage: (msg: string) => void;
}

export function RolesPanel({
  roleName,
  setRoleName,
  criteriaJson,
  setCriteriaJson,
  setStatusMessage,
}: RolesPanelProps) {
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

  return (
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
  );
}
