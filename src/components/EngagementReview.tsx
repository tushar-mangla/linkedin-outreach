import React from 'react';
import { ProspectCard } from './ProspectCard';

interface EngagementReviewProps {
  prospects: any[];
  campaignsList: any[];
  selectedCampaignId: string;
  campaignDrafts: Record<string, any[]>;
  prospectsState: 'loading' | 'ready' | 'empty' | 'error';
  actionStatusByDraft: Record<string, 'executing' | 'executed' | 'failed'>;
  actionMode: string;
  isCampaignRunning: boolean;
  onSelectCampaign: (campaignId: string) => void;
  onRefreshProspects: (campaignId: string) => void;
  onScanProspect: (id: string) => void;
  onDeleteProspect: (prospect: any) => void;
  onRunCampaign: () => void;
  onRetryFailed: () => void;
  onSkipCommentWithLike: (draft: any, draftsForProspect: any[]) => void;
}

export function EngagementReview({
  prospects,
  campaignsList,
  selectedCampaignId,
  campaignDrafts,
  prospectsState,
  actionStatusByDraft,
  actionMode,
  isCampaignRunning,
  onSelectCampaign,
  onRefreshProspects,
  onScanProspect,
  onDeleteProspect,
  onRunCampaign,
  onRetryFailed,
  onSkipCommentWithLike,
}: EngagementReviewProps) {
  // Check if any drafts across all prospects have failed status
  const hasFailedDrafts = prospects.some((p) =>
    (campaignDrafts[p.id] ?? []).some(
      (d: any) => d.actionType === 'COMMENT' && actionStatusByDraft[d.id] === 'failed'
    )
  );

  // Count pending comment drafts across all prospects
  const pendingCount = prospects.reduce((acc, p) => {
    return acc + (campaignDrafts[p.id] ?? []).filter(
      (d: any) =>
        d.actionType === 'COMMENT' &&
        d.status !== 'SKIPPED' &&
        d.status !== 'REJECTED' &&
        actionStatusByDraft[d.id] !== 'executed'
    ).length;
  }, 0);

  return (
    <div className="panel table-panel single-column">
      <div className="panel-heading">
        <h3>Prospect Qualification Pipeline</h3>
        <span className="chip">
          {selectedCampaignId
            ? `${prospects.length} PROSPECTS`
            : `${campaignsList.length} CAMPAIGNS`}
        </span>
      </div>

      {!selectedCampaignId ? (
        <div style={{ marginBottom: '2rem' }}>
          <h4 style={{ margin: '0 0 1rem', color: '#18342e' }}>Select a Campaign</h4>
          <div style={{ display: 'grid', gap: '1rem' }}>
            {campaignsList.length === 0 ? (
              <div className="empty">
                No campaigns available. Go to 'Import Prospects' to discover leads.
              </div>
            ) : (
              campaignsList.map((c) => (
                <div
                  key={c.id}
                  style={{
                    padding: '1rem',
                    border: '1px solid #d9e2d9',
                    borderRadius: '8px',
                    background: '#fff',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <h4 style={{ margin: '0 0 0.5rem', color: '#18342e' }}>{c.name}</h4>
                    <span className="chip">{c.enrolledCount} Leads</span>
                  </div>
                  <button
                    className="primary"
                    onClick={() => {
                      onSelectCampaign(c.id);
                      onRefreshProspects(c.id);
                    }}
                  >
                    View Prospects ➔
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div>
          {/* Campaign header bar */}
          <div
            style={{
              marginBottom: '1.2rem',
              padding: '12px 16px',
              background: '#eef1ec',
              border: '1px solid #d9e2d9',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: '800',
                color: '#18342e',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              🎯 Active Campaign:{' '}
              {campaignsList.find((c) => c.id === selectedCampaignId)?.name || 'Unknown Campaign'}
            </span>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Retry failed button — only shown when there are failures */}
              {hasFailedDrafts && !isCampaignRunning && (
                <button
                  type="button"
                  onClick={onRetryFailed}
                  style={{
                    border: '0',
                    background: '#c0392b',
                    color: '#fff',
                    padding: '6px 12px',
                    borderRadius: '6px',
                    fontSize: '11px',
                    fontWeight: '700',
                    cursor: 'pointer',
                  }}
                >
                  ↻ Retry Failed
                </button>
              )}

              {/* Run Campaign button */}
              <button
                type="button"
                onClick={onRunCampaign}
                disabled={isCampaignRunning || pendingCount === 0}
                style={{
                  border: '0',
                  background: isCampaignRunning || pendingCount === 0 ? '#8aad9a' : '#18342e',
                  color: '#fff',
                  padding: '6px 16px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: isCampaignRunning || pendingCount === 0 ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s',
                }}
              >
                {isCampaignRunning
                  ? '⏳ Running… (do not close tab)'
                  : pendingCount === 0
                  ? '✓ All Done'
                  : `▶ Run Campaign (${pendingCount} draft${pendingCount > 1 ? 's' : ''})`}
              </button>

              <button
                type="button"
                onClick={() => {
                  onSelectCampaign('');
                  onRefreshProspects('');
                }}
                style={{
                  border: '0',
                  background: '#6b7e73',
                  color: '#fff',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: '700',
                  cursor: 'pointer',
                }}
              >
                ← Back
              </button>
            </div>
          </div>

          {prospectsState === 'loading' && (
            <div className="empty">Loading prospects from the server…</div>
          )}
          {prospectsState === 'error' && (
            <div className="empty">
              Prospects unavailable. Prior server state is preserved; no local fallback is
              shown.
            </div>
          )}
          {prospectsState === 'empty' && !selectedCampaignId && (
            <div className="empty">
              No prospects on the server yet. Use "Add Prospect" above or import a CSV on the
              Import Prospects tab to get started.
            </div>
          )}
          {prospectsState === 'empty' && selectedCampaignId && (
            <div className="empty">No prospects found in this campaign.</div>
          )}
          {prospectsState === 'ready' && (
            <div style={{ display: 'grid', gap: '1rem' }}>
              {prospects.map((c) => (
                <ProspectCard
                  key={c.id}
                  prospect={c}
                  campaignDrafts={campaignDrafts[c.id]}
                  actionStatusByDraft={actionStatusByDraft}
                  actionMode={actionMode}
                  selectedCampaignId={selectedCampaignId}
                  onScanProspect={onScanProspect}
                  onDeleteProspect={onDeleteProspect}
                  onSkipCommentWithLike={onSkipCommentWithLike}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
