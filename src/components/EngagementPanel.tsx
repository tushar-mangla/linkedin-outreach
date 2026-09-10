import React, { useState } from 'react';

interface EngagementPanelProps {
  queueActions: any[];
  controls: any[];
  refreshEngagement: () => Promise<void>;
  setStatusMessage: (msg: string) => void;
}

export function EngagementPanel({
  queueActions,
  controls,
  refreshEngagement,
  setStatusMessage,
}: EngagementPanelProps) {
  const [queueFilter, setQueueFilter] = useState<'ALL' | 'LIKE' | 'COMMENT'>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'COMPLETED' | 'FAILED'>('ALL');

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
    <div className="panel single-column">
      <div className="panel-heading">
        <h3>Engagement Queue</h3>
        <span className="chip">{queueActions.length} QUEUED ACTIONS</span>
      </div>
      <p>
        Execute queued LinkedIn actions. Comment review happens inside each Campaign's prospect list.
      </p>

      {/* Queue actions — only shown when there are items */}
      {queueActions.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <h4 style={{ margin: '0', fontSize: '13px', color: '#18342e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Queued Actions</h4>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div style={{ display: 'flex', border: '1px solid #b9c9bd', borderRadius: '4px', overflow: 'hidden' }}>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', background: queueFilter === 'ALL' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setQueueFilter('ALL')}
                  >All</button>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', borderLeft: '1px solid #b9c9bd', background: queueFilter === 'LIKE' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setQueueFilter('LIKE')}
                  >Likes</button>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', borderLeft: '1px solid #b9c9bd', background: queueFilter === 'COMMENT' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setQueueFilter('COMMENT')}
                  >Comments</button>
                </div>
                <button style={{ border: '1px solid #b9c9bd', background: '#fff', color: '#18342e', padding: '4px 10px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }} onClick={refreshEngagement}>
                  ↺ Refresh
                </button>
              </div>
              <div style={{ display: 'flex', border: '1px solid #b9c9bd', borderRadius: '4px', overflow: 'hidden' }}>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', background: statusFilter === 'ALL' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setStatusFilter('ALL')}
                  >Any Status</button>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', borderLeft: '1px solid #b9c9bd', background: statusFilter === 'PENDING' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setStatusFilter('PENDING')}
                  >Pending</button>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', borderLeft: '1px solid #b9c9bd', background: statusFilter === 'COMPLETED' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setStatusFilter('COMPLETED')}
                  >Completed</button>
                  <button 
                    style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', border: 'none', borderLeft: '1px solid #b9c9bd', background: statusFilter === 'FAILED' ? '#e2e8e4' : '#fff', color: '#18342e' }}
                    onClick={() => setStatusFilter('FAILED')}
                  >Failed</button>
              </div>
            </div>
          </div>
          {queueActions
            .filter(action => queueFilter === 'ALL' || (action.actionType || '').toUpperCase() === queueFilter)
            .filter(action => statusFilter === 'ALL' || (action.status || '').toUpperCase() === statusFilter)
            .map((action: any) => (
            <div key={action.id} style={{ padding: '0.6rem 0.9rem', border: '1px solid #d9e2d9', borderRadius: '6px', background: '#fff', fontSize: '13px', color: '#33453e' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span><strong>{action.actionType}</strong> · {action.status} · {action.outcomeLabel ?? 'pending'}</span>
                {action.errorCode ? <span style={{ color: '#c0392b', fontWeight: 'bold' }}>{action.errorCode}</span> : null}
              </div>
              <div style={{ fontSize: '11px', color: '#687771', display: 'flex', alignItems: 'center', gap: '4px' }}>
                👤{' '}
                {action.prospectUrl ? (
                  <a href={action.prospectUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2980b9', textDecoration: 'none', fontWeight: 'bold' }}>
                    {action.prospectName}
                  </a>
                ) : (
                  <span>{action.prospectName}</span>
                )}
                &nbsp;|&nbsp; 🎯 {action.campaignName}
              </div>
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
}
