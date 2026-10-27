import { useState } from 'react';
import { useLive } from '../store';
import { fmtTs } from '../time';

const CLASSES = ['', 'EXECUTION', 'APPROVED_CHANGE', 'OVERRIDE', 'PRIORITY', 'CONFIG', 'COMMERCIAL', 'FORECAST', 'SYSTEM'];

export function AuditView() {
  const [cls, setCls] = useState('');
  const { data } = useLive<any[]>(`/audit${cls ? `?changeClass=${cls}` : ''}`, [cls]);
  const { data: delays } = useLive<any[]>('/delay-events');
  const [tab, setTab] = useState<'audit' | 'delays'>('audit');
  return (
    <div className="page">
      <div className="toolbar"><h2>Audit trail</h2>
        <div className="tabs inline"><button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Change log</button><button className={tab === 'delays' ? 'on' : ''} onClick={() => setTab('delays')}>Delay & forecast events</button></div>
        {tab === 'audit' && <select value={cls} onChange={(e) => setCls(e.target.value)}>{CLASSES.map((c) => <option key={c} value={c}>{c || 'All classes'}</option>)}</select>}
        <span className="muted small">Append-only: records cannot be modified or deleted.</span>
      </div>
      {tab === 'audit' ? (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Class</th><th>Action</th><th>Project</th><th>By</th><th>Reason</th><th>Before</th><th>After</th></tr></thead>
          <tbody>{data?.map((h) => (
            <tr key={h.id}><td className="small nowrap">{fmtTs(h.ts)}</td><td><span className={`evk cls-${h.change_class}`}>{h.change_class}</span></td><td>{h.action}</td><td>{h.project}</td>
              <td>{h.user_name ?? 'system'} <span className="muted small">{h.role}</span></td><td className="small">{h.reason}</td>
              <td className="small mono">{h.before ? JSON.stringify(h.before).slice(0, 100) : ''}</td><td className="small mono">{h.after ? JSON.stringify(h.after).slice(0, 140) : ''}</td></tr>
          ))}</tbody>
        </table>
      ) : (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Kind</th><th>Project</th><th>Activity</th><th>Reason</th><th>Root event</th><th>By</th></tr></thead>
          <tbody>{delays?.map((e) => (
            <tr key={e.id}><td className="small nowrap">{fmtTs(e.created_at)}</td><td><span className={`evk evk-${e.kind}`}>{e.kind}</span></td><td>{e.project}</td><td>{e.serial} {e.activity}</td>
              <td className="small">{e.reason}{e.origin_activity && e.kind === 'PROPAGATED' ? <span className="muted"> ← {e.origin_activity}</span> : ''}</td><td className="small">{e.root_event_id ? `#${e.root_event_id}` : ''}</td><td>{e.user_name ?? 'system'}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
