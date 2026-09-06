import React from 'react';
import { DraftCard } from './DraftCard';

interface ProspectCardProps {
  prospect: any;
  campaignDrafts: any[];
  actionStatusByDraft: Record<string, 'executing' | 'executed' | 'failed'>;
  actionMode: string;
  selectedCampaignId: string;
  onScanProspect: (id: string) => void;
  onDeleteProspect: (prospect: any) => void;
  onSkipCommentWithLike: (draft: any, draftsForProspect: any[]) => void;
}

export function ProspectCard({
  prospect,
  campaignDrafts,
  actionStatusByDraft,
  actionMode,
  selectedCampaignId,
  onScanProspect,
  onDeleteProspect,
  onSkipCommentWithLike,
}: ProspectCardProps) {
  const draftsForProspect = campaignDrafts ?? [];
  const commentDrafts = draftsForProspect.filter(
    (d) => d.actionType === 'COMMENT' && d.status !== 'SKIPPED' && d.status !== 'REJECTED'
  );
  const executedCount = commentDrafts.filter((d) => actionStatusByDraft[d.id] === 'executed').length;
  const failedCount = commentDrafts.filter((d) => actionStatusByDraft[d.id] === 'failed').length;
  const executingCount = commentDrafts.filter((d) => actionStatusByDraft[d.id] === 'executing').length;
  const pendingCount = commentDrafts.length - executedCount - failedCount - executingCount;

  return (
    <div
      style={{
        border: '1px solid #d9e2d9',
        borderRadius: '10px',
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      {/* Prospect Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          padding: '1rem 1.25rem',
          borderBottom: commentDrafts.length > 0 ? '1px solid #e8f0e8' : 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '15px', color: '#18342e' }}>{prospect.name}</strong>
            <span className={`stage ${prospect.currentStage.toLowerCase()}`}>
              {prospect.currentStage}
            </span>
            {executingCount > 0 && (
              <span
                style={{
                  background: '#e3f2fd',
                  color: '#1565c0',
                  border: '1px solid #90caf9',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '700',
                  padding: '2px 8px',
                }}
              >
                ⏳ {executingCount} executing
              </span>
            )}
            {pendingCount > 0 && executingCount === 0 && (
              <span
                style={{
                  background: '#fff3cd',
                  color: '#856404',
                  border: '1px solid #ffc107',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '700',
                  padding: '2px 8px',
                }}
              >
                💬 {pendingCount} comment{pendingCount > 1 ? 's' : ''} queued
              </span>
            )}
            {executedCount > 0 && (
              <span
                style={{
                  background: '#e8f5e9',
                  color: '#2e7d32',
                  border: '1px solid #a5d6a7',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '700',
                  padding: '2px 8px',
                }}
              >
                ✓ {executedCount} published
              </span>
            )}
            {failedCount > 0 && (
              <span
                style={{
                  background: '#fdecea',
                  color: '#c62828',
                  border: '1px solid #ef9a9a',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: '700',
                  padding: '2px 8px',
                }}
              >
                ✕ {failedCount} failed
              </span>
            )}
          </div>
          <span style={{ fontSize: '13px', color: '#45534d' }}>
            {prospect.title}
            {prospect.company ? ` · ${prospect.company}` : ''}
            {prospect.location ? ` · ${prospect.location}` : ''}
          </span>
          <a
            href={prospect.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '12px', color: '#1976d2' }}
          >
            View LinkedIn ↗
          </a>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
          {selectedCampaignId && draftsForProspect.length === 0 && (
            <button
              style={{
                border: '1px solid #b9c9bd',
                background: '#f7faf5',
                color: '#18342e',
                padding: '5px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
              onClick={() => onScanProspect(prospect.id)}
            >
              🔍 Scan Posts
            </button>
          )}
          <button className="reject" onClick={() => onDeleteProspect(prospect)}>
            Delete
          </button>
        </div>
      </div>

      {/* Draft Comments */}
      {commentDrafts.length > 0 && (
        <div
          style={{
            padding: '0.75rem 1.25rem',
            background: '#fafcf8',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          {commentDrafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              draftsForProspect={draftsForProspect}
              actionMode={actionMode}
              actionStatus={actionStatusByDraft[draft.id]}
              onSkip={onSkipCommentWithLike}
            />
          ))}
        </div>
      )}
    </div>
  );
}
