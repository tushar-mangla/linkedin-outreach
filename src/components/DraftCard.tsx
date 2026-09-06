import React from 'react';

interface DraftCardProps {
  draft: any;
  draftsForProspect: any[];
  actionMode: string;
  actionStatus: 'executing' | 'executed' | 'failed' | undefined;
  onSkip: (draft: any, draftsForProspect: any[]) => void;
}

export function DraftCard({
  draft,
  draftsForProspect,
  actionMode,
  actionStatus,
  onSkip,
}: DraftCardProps) {
  const isExecuting = actionStatus === 'executing';
  const isExecuted = actionStatus === 'executed';
  const isFailed = actionStatus === 'failed';

  // Determine border/background from status
  const borderColor = isExecuted ? '#c8e6c9' : isFailed ? '#ef9a9a' : isExecuting ? '#90caf9' : '#e0ead0';
  const bgColor = isExecuted ? '#f9fdf9' : isFailed ? '#fdecea' : isExecuting ? '#e3f2fd' : '#fff';

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        background: bgColor,
        borderRadius: '8px',
        overflow: 'hidden',
        transition: 'border-color 0.2s, background 0.2s',
      }}
    >
      {/* Post context */}
      {draft.post && (
        <div
          style={{
            padding: '0.6rem 0.9rem',
            background: '#f3f7f0',
            borderBottom: '1px solid #e0ead0',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '4px',
              flexWrap: 'wrap',
              gap: '6px',
            }}
          >
            <small style={{ color: '#6b7e73', fontWeight: '600', fontSize: '11px' }}>
              POST BY {(draft.post.authorName ?? 'Unknown').toUpperCase()} ·{' '}
              {draft.post.sourceType ?? ''}
            </small>
            {draft.post.postUrl && (
              <a
                href={draft.post.postUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '11px',
                  color: '#1976d2',
                  textDecoration: 'none',
                  fontWeight: '700',
                }}
              >
                🔗 View Post on LinkedIn ↗
              </a>
            )}
          </div>
          <em
            style={{
              fontSize: '13px',
              color: '#33453e',
              lineHeight: '1.5',
              display: 'block',
            }}
          >
            "{draft.post.postText}"
          </em>
        </div>
      )}

      {/* Draft comment body */}
      <div style={{ padding: '0.6rem 0.9rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '6px',
            flexWrap: 'wrap',
            gap: '6px',
          }}
        >
          {/* Status badge */}
          <div>
            {isExecuted ? (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  color: '#2e7d32',
                  background: '#e8f5e9',
                  border: '1px solid #a5d6a7',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
              >
                🚀 PUBLISHED TO LINKEDIN
              </span>
            ) : isExecuting ? (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  color: '#1565c0',
                  background: '#e3f2fd',
                  border: '1px solid #90caf9',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
              >
                ⏳ EXECUTING ON LINKEDIN…
              </span>
            ) : isFailed ? (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '800',
                  color: '#c62828',
                  background: '#fdecea',
                  border: '1px solid #ef9a9a',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
              >
                ✕ FAILED — click "↻ Retry Failed" above
              </span>
            ) : (
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '700',
                  color: '#5c6bc0',
                  background: '#ede7f6',
                  border: '1px solid #b39ddb',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
              >
                💬 QUEUED — runs when you click "▶ Run Campaign"
              </span>
            )}
          </div>
          <span
            style={{
              fontSize: '11px',
              color: '#2e7d32',
              fontWeight: '600',
              background: '#e8f5e9',
              padding: '2px 6px',
              borderRadius: '4px',
            }}
          >
            👍 Like included automatically
          </span>
        </div>

        <p
          style={{
            margin: '0 0 0.75rem',
            fontSize: '14px',
            color: '#18342e',
            lineHeight: '1.6',
            fontWeight: '500',
          }}
        >
          {draft.commentText}
        </p>

        {/* Actions row — only Skip is available */}
        {!isExecuted && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              className="reject"
              disabled={isExecuting}
              onClick={() => onSkip(draft, draftsForProspect)}
              style={{ fontSize: '12px' }}
            >
              ✕ Skip this comment
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
