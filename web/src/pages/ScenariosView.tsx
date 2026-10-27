import { useEffect, useState } from 'react';
import { api } from '../api';
import { ImpactView, Modal } from '../components/ui';
import { useApp, useLive } from '../store';
import { fmtTs, slotLabel } from '../time';

const OP_LABEL: Record<string, string> = {
  set_priority: 'Set ranking', move_priority: 'Move project in ranking', move_activity: 'Move activity', set_capacity: 'Capacity', weekend_work: 'Weekend work',
  set_duration: 'Duration', pull_in: 'Pull-in (allow earlier starts)', replan_backward: 'Backward re-plan',
};

export function ScenariosView() {
  const { can, meta, toast, user } = useApp();
  const { data: list, reload } = useLive<any[]>('/scenarios');
  const { data: pf } = useLive<any>('/portfolio');
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [just, setJust] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [builder, setBuilder] = useState(false);
  const [ops, setOps] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<any>({ type: 'move_priority' });
  useEffect(() => { if (sel) api(`/scenarios/${sel}`).then(setDetail); else setDetail(null); setErr(null); setJust(''); }, [sel, list]);
  const pcode = (id: number) => pf?.projects.find((p: any) => p.id === id)?.code ?? `#${id}`;
  const wcName = (id: number) => meta?.workCenters.find((w: any) => w.id === id)?.name ?? `#${id}`;
  const describe = (o: any) => {
    switch (o.type) {
      case 'set_priority': return o.order.map(pcode).join(' > ');
      case 'move_priority': return `${pcode(o.projectId)} → rank ${o.toRank}`;
      case 'move_activity': return `activity ${o.activityId} → ${slotLabel(o.start)}`;
      case 'set_capacity': return `${wcName(o.workCenterId)} = ${o.capacity}`;
      case 'weekend_work': return `${o.workCenterId ? wcName(o.workCenterId) : `activity ${o.activityId}`} on ${o.date}`;
      case 'set_duration': return `activity ${o.activityId} = ${o.durationSlots / 2} d`;
      default: return pcode(o.projectId);
    }
  };
  const act = async (path: string, body?: any) => {
    setErr(null);
    try {
      const r = await api(`/scenarios/${sel}/${path}`, { body: body ?? {} });
      if (r?.status === 'PENDING_APPROVAL') toast('Submitted for Management / Program approval', 'info');
      else if (path === 'commit') toast(`Committed — plan version ${r.version}`, 'ok');
      reload();
    } catch (e: any) {
      if (e.code === 'STALE_SIMULATION') { setDetail({ ...detail, result: e.details.result }); setErr('Plan changed since simulation — impact refreshed. Review and commit again.'); }
      else setErr(e.message + (e.details?.violations ? ': ' + e.details.violations.map((v: any) => v.message).join('; ') : ''));
    }
  };
  const create = async () => {
    try {
      const r = await api('/scenarios', { body: { name: name || 'Scenario', ops } });
      setBuilder(false); setOps([]); setName(''); setSel(r.id); reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const addOp = () => {
    const d = { ...draft };
    for (const k of ['projectId', 'toRank', 'workCenterId', 'capacity', 'maxConcurrent', 'activityId', 'durationSlots']) if (d[k] !== undefined && d[k] !== '') d[k] = Number(d[k]);
    setOps([...ops, d]);
  };
  const editable = detail && ['DRAFT', 'PENDING_APPROVAL'].includes(detail.status);
  return (
    <div className="page split">
      <div className="list-pane">
        <div className="toolbar"><h2>Scenarios</h2><div className="spacer" />{can('scenario.create') && <button onClick={() => setBuilder(true)}>+ New</button>}</div>
        {list?.map((s) => (
          <div key={s.id} className={`list-item ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
            <div><span className={`sc-status sc-${s.status}`}>{s.status.replace('_', ' ')}</span> <b>{s.name}</b></div>
            <div className="small muted">{s.created_by_name} · {fmtTs(s.created_at)} {s.source !== 'USER' && `· ${s.source}`}</div>
            <div className="small">{s.summary}</div>
            {s.requires_management && <div className="small frozen">❄ affects frozen projects</div>}
          </div>
        ))}
      </div>
      <div className="detail-pane">
        {!detail ? <div className="empty">Select a scenario, or create one to simulate priorities, capacities and schedule moves before committing.</div> : (
          <>
            <div className="toolbar"><h3>{detail.name}</h3><span className={`sc-status sc-${detail.status}`}>{detail.status}</span>
              <span className="muted small">by {detail.created_by_name}{detail.approved_by_name ? ` · ${detail.status === 'REJECTED' ? 'rejected' : 'approved'} by ${detail.approved_by_name} ${fmtTs(detail.approved_at)}` : ''}</span></div>
            {detail.description && <p>{detail.description}</p>}
            <ul className="ops">{detail.ops.map((o: any, i: number) => <li key={i}><b>{OP_LABEL[o.type]}</b>: {describe(o)}</li>)}</ul>
            {detail.justification && <p className="small"><b>Justification:</b> {detail.justification}</p>}
            <p className="small muted">Simulated {fmtTs(detail.simulated_at)} on plan version {detail.base_version}. Freeze checks use persisted forecasts and are repeated at commit.</p>
            <ImpactView result={detail.result} />
            {err && <div className="alert err">{err}</div>}
            {editable && (
              <>
                <label className="field">Justification {detail.result?.requiresReason && <span className="req">required</span>}<textarea rows={2} value={just} onChange={(e) => setJust(e.target.value)} /></label>
                <div className="actions">
                  <button className="secondary" onClick={() => act('simulate')}>Re-simulate</button>
                  {(detail.created_by === user?.id || can('freeze.override')) && <button className="secondary" onClick={() => act('reject', { reason: just })}>Reject / withdraw</button>}
                  {detail.status === 'DRAFT' && <button className="secondary" onClick={() => act('submit', { note: just })}>Submit for approval</button>}
                  {can('scenario.commit') && <button onClick={() => act('commit', { justification: just || undefined })} disabled={detail.result?.violations?.length > 0}>
                    {detail.requires_management ? (can('freeze.override') ? 'Approve override & commit' : 'Request Management approval') : 'Commit'}</button>}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {builder && (
        <Modal wide title="New scenario" onClose={() => setBuilder(false)}>
          <label className="field">Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="row">
            <select value={draft.type} onChange={(e) => setDraft({ type: e.target.value })}>
              {Object.entries(OP_LABEL).filter(([k]) => k !== 'set_priority' && k !== 'move_activity').filter(([k]) => can(['set_capacity', 'weekend_work'].includes(k) ? 'scenario.op.capacity' : k === 'move_priority' ? 'scenario.op.priority' : 'scenario.op.schedule')).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {['move_priority', 'pull_in', 'replan_backward'].includes(draft.type) && <select value={draft.projectId ?? ''} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}><option value="">Project…</option>{pf?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.priority}. {p.code} {p.name}</option>)}</select>}
            {draft.type === 'move_priority' && <input type="number" min={1} placeholder="rank" style={{ width: 70 }} value={draft.toRank ?? ''} onChange={(e) => setDraft({ ...draft, toRank: e.target.value })} />}
            {['set_capacity', 'weekend_work'].includes(draft.type) && <select value={draft.workCenterId ?? ''} onChange={(e) => setDraft({ ...draft, workCenterId: e.target.value })}><option value="">Work center…</option>{meta?.workCenters.map((w: any) => <option key={w.id} value={w.id}>{w.name} ({w.capacity})</option>)}</select>}
            {draft.type === 'set_capacity' && <input type="number" step="0.5" placeholder="capacity" style={{ width: 90 }} value={draft.capacity ?? ''} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} />}
            {draft.type === 'weekend_work' && <input type="date" value={draft.date ?? ''} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />}
            {draft.type === 'set_duration' && <><input type="number" placeholder="activity id" style={{ width: 100 }} onChange={(e) => setDraft({ ...draft, activityId: e.target.value })} /><input type="number" placeholder="half-days" style={{ width: 90 }} onChange={(e) => setDraft({ ...draft, durationSlots: e.target.value })} /></>}
            <button className="secondary small" onClick={addOp}>Add</button>
          </div>
          <ul className="ops">{ops.map((o, i) => <li key={i}><b>{OP_LABEL[o.type]}</b>: {describe(o)} <button className="icon" onClick={() => setOps(ops.filter((_, j) => j !== i))}>✕</button></li>)}</ul>
          <p className="hint">Priority rankings can also be dragged in the Priority View; activity moves are made in the Gantt or the daily call.</p>
          <div className="actions"><button disabled={!ops.length} onClick={create}>Create & simulate</button></div>
        </Modal>
      )}
    </div>
  );
}
