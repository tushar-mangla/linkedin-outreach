import React from 'react';

export function ExportPanel() {
  return (
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
  );
}
