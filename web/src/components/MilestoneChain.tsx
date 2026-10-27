import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './ui';

const C: Record<string, string> = { predecessor: 'predecessor', capacity: 'capacity', approved: 'approved start', now: 'not started', reported: 'reported delay', blocked: 'blocked', overdue: 'overdue', locked: 'locked', actual: 'in execution', completed: 'completed' };

export function MilestoneChain({ projectId, type, onClose, onActivity }: { projectId: number; type: string; onClose: () => void; onActivity?: (id: number) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/milestones/${projectId}/${type}/chain`).then(setD).catch((e) => setErr(e.message)); }, [projectId, type]);
  return (
    <Modal wide title={d ? `${d.label} — driving chain` : 'Driving chain'} onClose={onClose}>
      {err && <div className="alert err">{err}</div>}
      {d && (
        <>
          <p>Forecast <b>{d.forecastLabel}</b>. The chain below is read from the milestone back to the activity where the constraint originates{d.originActivityId ? '' : ' (no delay against commitment on this chain)'}.</p>
          <ol className="chain">
            {d.nodes.map((n: any) => (
              <li key={n.activityId} className={`${n.activityId === d.originActivityId ? 'origin' : ''} ${n.delayed ? 'late' : ''}`} onClick={() => onActivity?.(n.activityId)}>
                <div><b>{n.name}</b> <span className="muted">{n.unit} · {n.workCenter ?? 'transport'}</span></div>
                <div className="small">{n.startLabel} → {n.finishLabel} · constrained by <i>{C[n.driver.type] ?? n.driver.type}</i>
                  {n.delayed && <span className="var var-late"> +{n.delaySlots / 2} wd vs approved</span>}
                  {n.activityId === d.originActivityId && <span className="origin-tag"> ◀ originating activity</span>}
                </div>
                {n.lastEvent?.reason && <div className="small cause">Cause: {n.lastEvent.reason}{n.lastEvent.user ? ` — ${n.lastEvent.user}` : ''}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}
