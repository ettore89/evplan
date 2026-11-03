import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './ui';

const C: Record<string, string> = { predecessor: 'predecessor', capacity: 'capacity', approved: 'approved start', now: 'not started', reported: 'reported delay', blocked: 'blocked', overdue: 'overdue', locked: 'locked', actual: 'in execution', completed: 'completed', gate: 'readiness gate', hold: 'resource held' };

export function MilestoneChain({ projectId, type, onClose, onActivity }: { projectId: number; type: string; onClose: () => void; onActivity?: (id: number) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api(`/milestones/${projectId}/${type}/chain`).then(setD).catch((e) => setErr(e.message)); }, [projectId, type]);
  return (
    <Modal wide title={d ? `${d.label} — driving chain` : 'Driving chain'} onClose={onClose}>
      {err && <div className="alert err">{err}</div>}
      {d && (
        <>
          <p>Forecast <b>{d.forecastLabel}</b> <span className={`conf conf-${d.confidence}`}>{String(d.confidence).toLowerCase()}</span>. Read from the milestone back to where the constraint originates{d.originActivityId ? '' : ' (no delay against commitment on this chain)'}.</p>
          {(d.originIssue || d.responsibleOwner) && (
            <div className="alert info"><b>Originating issue:</b> {d.originIssue ?? '—'} {d.responsibleOwner && <> · <b>owner:</b> {d.responsibleOwner}</>}
              {d.affectedProjects?.length > 0 && <> · <b>also affects:</b> {d.affectedProjects.join(', ')}</>}</div>
          )}
          <ol className="chain">
            {d.nodes.map((n: any) => (
              <li key={n.activityId} className={`${n.activityId === d.originActivityId ? 'origin' : ''} ${n.delayed ? 'late' : ''}`} onClick={() => onActivity?.(n.activityId)}>
                <div><b>{n.name}</b> <span className="muted">{n.unit} · {n.workCenter ?? 'transport / external'} · {n.owner}</span> {n.confidence !== 'FIRM' && <span className={`conf conf-${n.confidence}`}>{n.confidence.toLowerCase()}</span>}</div>
                <div className="small">{n.startLabel} → {n.finishLabel} · constrained by <i>{C[n.driver.type] ?? n.driver.type}</i>
                  {n.competingProjects?.length > 0 && <span className="muted"> (competing: {n.competingProjects.join(', ')})</span>}
                  {n.delayed && <span className="var var-late"> +{n.delaySlots / 2} wd vs approved</span>}
                  {n.activityId === d.originActivityId && <span className="origin-tag"> ◀ origin</span>}
                </div>
                {n.gate && <div className="small cause">Readiness: {n.gate.title} — {n.gate.status.toLowerCase()}{n.gate.forecastLabel ? `, forecast ${n.gate.forecastLabel}` : ', no date'} · owner {n.gate.owner ?? 'unassigned'}{n.gate.notes ? ` · ${n.gate.notes}` : ''}</div>}
                {n.lastEvent?.reason && <div className="small cause">Cause: {n.lastEvent.reason}{n.lastEvent.user ? ` — ${n.lastEvent.user}` : ''}</div>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}
