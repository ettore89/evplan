import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { ActivityPanel } from '../components/ActivityPanel';
import { MilestoneChain } from '../components/MilestoneChain';
import { ChangeFlow, FnTag, Modal, RiskBadge, StatusBadge, Variance } from '../components/ui';
import { useApp, useLive } from '../store';
import { finishLabel, fmtIso, fmtTs, slotLabel } from '../time';

export function ProjectDetails() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const { data, error } = useLive<any>(`/projects/${id}`, [id]);
  const [tab, setTab] = useState<'activities' | 'delays' | 'comments' | 'commitments' | 'history'>('activities');
  const [panel, setPanel] = useState<{ id: number; unit: string } | null>(null);
  const [chain, setChain] = useState<string | null>(null);
  const [editReq, setEditReq] = useState(false);
  const [req, setReq] = useState({ requiredDate: '', reason: '' });
  const [replan, setReplan] = useState(false);
  const [unitFilter, setUnitFilter] = useState<number | 'all'>('all');
  if (error) return <div className="alert err pad">{error}</div>;
  if (!data) return <div className="muted pad">Loading…</div>;
  const p = data.project;
  const s = data.summary;
  const serial = new Map<number, string>(data.units.map((u: any) => [u.id, u.serial]));
  const acts = data.activities.filter((a: any) => unitFilter === 'all' || a.unitId === unitFilter || (unitFilter === 0 && !a.unitId));
  const notStarted = data.activities.every((a: any) => ['NOT_STARTED', 'READY'].includes(a.status));
  const saveReq = async () => {
    try {
      await api(`/projects/${p.id}/commercial`, { method: 'PATCH', body: { requiredDate: req.requiredDate, reason: req.reason } });
      toast('Customer required date updated (risk re-evaluated; plan unchanged until a re-plan is approved)', 'ok');
      setEditReq(false);
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const acceptForecast = async () => {
    const reason = prompt('Accept the current forecast as the new committed plan for this project. Reason:');
    if (!reason) return;
    try { await api(`/projects/${p.id}/accept-forecast`, { body: { reason } }); toast('Forecast accepted as new commitment (original commitment preserved)', 'ok'); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <div className="page">
      <div className="toolbar">
        <h2>{p.code} · {p.name}</h2>
        <RiskBadge risk={s?.risk ?? 'GREEN'} />
        {s?.freeze.frozen && <span className="frozen">❄ Frozen since {fmtIso(s.freeze.freezeStartDate)} (ExWorks {fmtIso(s.freeze.exworksDate)})</span>}
        {p.planStatus === 'INFEASIBLE' && <span className="tag-red">Required date infeasible — earliest commissioning {p.earliestCommissioning}</span>}
        <div className="spacer" />
        {can('project.commercial.edit') && <button className="secondary" onClick={() => { setReq({ requiredDate: p.requiredDate, reason: '' }); setEditReq(true); }}>Change required date</button>}
        {can('scenario.op.schedule') && notStarted && <button className="secondary" onClick={() => setReplan(true)}>Re-plan backward…</button>}
        {can('plan.accept_forecast') && <button className="secondary" onClick={acceptForecast}>Accept forecast as commitment</button>}
      </div>
      <div className="cards">
        <div className="card">
          <h4>Commercial</h4>
          <div className="kv"><span>Customer</span>{p.customer}</div>
          <div className="kv"><span>Site</span>{p.siteLocation} ({p.country})</div>
          <div className="kv"><span>Priority</span>#{p.priority}</div>
          <div className="kv"><span>Required commissioning</span><b>{fmtIso(p.requiredDate)}</b></div>
          <div className="kv"><span>Transport</span>{p.route} · {p.transport}</div>
          <div className="kv"><span>Progress</span>{s?.progressPct}%</div>
          {p.notes && <div className="kv"><span>Notes</span>{p.notes}</div>}
        </div>
        <div className="card">
          <h4>Order configuration</h4>
          {s?.lines.map((l: any) => <div key={l.productCode} className="kv"><span>{l.productName} <span className="code">{l.productCode}</span></span>{l.quantity} units</div>)}
          <div className="unit-chips">{data.units.map((u: any) => <span key={u.id} className="chip">{u.serial}</span>)}</div>
          <p className="hint">Each physical unit has its own flow; batch planning is not implemented (batch id reserved).</p>
        </div>
        <div className="card wide">
          <h4>Primary milestones</h4>
          <table className="grid tight">
            <thead><tr><th>Milestone</th><th>Original committed</th><th>Latest approved</th><th>Forecast</th><th>Actual</th><th>Variance</th><th>Risk</th><th>Delay explanation</th></tr></thead>
            <tbody>{s?.milestones.map((m: any) => (
              <tr key={m.type} className="clickable" onClick={() => setChain(m.type)}>
                <td><b>{m.label}</b></td><td>{m.originalCommittedLabel}</td><td>{m.latestApprovedLabel}</td><td><b>{m.forecastLabel}</b></td><td>{m.actualLabel || '—'}</td>
                <td><Variance days={m.varianceDays} /> {m.varianceVsOriginalDays !== m.varianceDays && <span className="muted small">orig {m.varianceVsOriginalDays > 0 ? '+' : ''}{m.varianceVsOriginalDays}</span>}{m.missed && <span className="tag-red small"> missed</span>}</td>
                <td><RiskBadge risk={m.risk} /></td>
                <td className="small">{m.delay ? <>{m.delay.reason} <span className="muted">({m.delay.project} {m.delay.unit} {m.delay.activity}{m.delay.user ? ` · ${m.delay.user}` : ''})</span></> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="hint">Click a milestone to trace the driving chain back to the originating activity.</p>
        </div>
      </div>
      <div className="tabs">
        {(['activities', 'delays', 'comments', 'commitments', 'history'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      {tab === 'activities' && (
        <>
          <div className="row">Unit: <select value={unitFilter} onChange={(e) => setUnitFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All</option>{data.units.map((u: any) => <option key={u.id} value={u.id}>{u.serial}</option>)}<option value={0}>Shipment</option></select></div>
          <table className="grid tight acts">
            <thead><tr><th>Unit</th><th>Activity</th><th>Function</th><th>Status</th><th>Approved</th><th>Forecast</th><th>Actual</th><th>Δ</th><th>Blocker / reason</th><th>Updated</th></tr></thead>
            <tbody>{acts.map((a: any) => (
              <tr key={a.id} className={`clickable ${a.isCritical ? 'crit-row' : ''}`} onClick={() => setPanel({ id: a.id, unit: a.unitId ? serial.get(a.unitId)! : 'Shipment' })}>
                <td>{a.unitId ? serial.get(a.unitId) : 'Shipment'}</td><td>{a.name}{a.locked && ' 🔒'}{a.weekendWork && ' ★'}</td><td><FnTag fn={a.function} /></td><td><StatusBadge status={a.status} /></td>
                <td className="nowrap small">{slotLabel(a.approvedStart)} → {finishLabel(a.approvedFinish)}</td>
                <td className="nowrap small"><b>{slotLabel(a.forecastStart)} → {finishLabel(a.forecastFinish)}</b></td>
                <td className="nowrap small">{a.actualStart ? `${slotLabel(a.actualStart)} → ${a.actualFinish ? finishLabel(a.actualFinish) : '…'}` : ''}</td>
                <td>{a.delayed ? <span className="var var-late">+{a.delaySlots / 2}</span> : ''}</td>
                <td className="small">{a.blocker ? <span className="tag-red">{a.blocker}</span> : a.delayed ? a.lastEvent?.reason ?? '' : ''}</td>
                <td className="small muted">{a.updatedByName ?? ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
      {tab === 'delays' && (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Type</th><th>Activity</th><th>Finish</th><th>Reason</th><th>Origin</th><th>Impacted milestones</th><th>By</th></tr></thead>
          <tbody>{data.delayEvents.map((e: any) => (
            <tr key={e.id} className={`ev-${e.kind}`}>
              <td className="small">{fmtTs(e.created_at)}</td><td><span className={`evk evk-${e.kind}`}>{e.kind.replace('_', ' ')}</span>{e.category ? <span className="muted small"> {e.category}</span> : null}</td>
              <td>{e.serial ?? ''} {e.activity}</td><td className="small nowrap">{e.prevFinishLabel} → {e.newFinishLabel}</td><td>{e.reason}</td>
              <td className="small">{e.origin_activity && e.origin_activity_id !== e.activity_id ? `${e.origin_project} ${e.origin_unit ?? ''} ${e.origin_activity}` : ''}{e.related_projects?.length ? <div className="muted">affects {e.related_projects.length} project(s)</div> : null}</td>
              <td className="small">{(e.impacted_milestones ?? []).map((m: any, i: number) => <div key={i}>{m.type}: {m.prevLabel} → {m.nextLabel}</div>)}</td>
              <td className="small">{e.user_name ?? 'system'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'comments' && (
        <div className="history">{data.comments.map((c: any) => (
          <div key={c.id} className={`hist kind-${c.kind}`}><span className="muted">{fmtTs(c.created_at)}</span> <b>{c.user_name}</b> <span className="muted">({c.role})</span> {c.serial ? `· ${c.serial} ` : ''}{c.activity ? `· ${c.activity}` : ''}: {c.kind !== 'COMMENT' && <b>[{c.kind}] </b>}{c.text}</div>
        ))}{!data.comments.length && <div className="muted">No comments.</div>}</div>
      )}
      {tab === 'commitments' && (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Milestone</th><th>Kind</th><th>Previous</th><th>Committed</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>{data.commitments.map((c: any) => (
            <tr key={c.id}><td className="small">{fmtTs(c.created_at)}</td><td>{c.type}</td><td><span className={`evk evk-${c.kind}`}>{c.kind}</span></td><td>{c.previousLabel || '—'}</td><td><b>{c.committedLabel}</b></td><td>{c.reason}</td><td>{c.user_name ?? 'system'}</td></tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'history' && (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Class</th><th>Action</th><th>By</th><th>Reason</th><th>Change</th></tr></thead>
          <tbody>{data.history.map((h: any) => (
            <tr key={h.id}><td className="small">{fmtTs(h.ts)}</td><td><span className={`evk cls-${h.change_class}`}>{h.change_class}</span></td><td>{h.action}</td><td>{h.user_name ?? 'system'}</td><td>{h.reason}</td>
              <td className="small mono">{h.after ? JSON.stringify(h.after).slice(0, 140) : ''}</td></tr>
          ))}</tbody>
        </table>
      )}
      {panel && <ActivityPanel id={panel.id} unitLabel={panel.unit} onClose={() => setPanel(null)} />}
      {chain && <MilestoneChain projectId={p.id} type={chain} onClose={() => setChain(null)} onActivity={(aid) => { setChain(null); const a = data.activities.find((x: any) => x.id === aid); setPanel({ id: aid, unit: a?.unitId ? serial.get(a.unitId)! : 'Shipment' }); }} />}
      {editReq && (
        <Modal title="Customer required commissioning date" onClose={() => setEditReq(false)}>
          <label className="field">Required date <input type="date" value={req.requiredDate} onChange={(e) => setReq({ ...req, requiredDate: e.target.value })} /></label>
          <label className="field">Reason <span className="req">required</span><textarea value={req.reason} onChange={(e) => setReq({ ...req, reason: e.target.value })} /></label>
          <p className="hint">Changing the customer date re-evaluates risk. Re-planning the schedule requires an approved scenario.</p>
          <div className="actions"><button onClick={saveReq} disabled={req.reason.length < 3}>Save</button></div>
        </Modal>
      )}
      {replan && (
        <Modal wide title="Re-plan backward from the required commissioning date" onClose={() => setReplan(false)}>
          <ChangeFlow name={`Backward re-plan ${p.code}`} ops={[{ type: 'replan_backward', projectId: p.id }]} onDone={() => setReplan(false)} />
        </Modal>
      )}
    </div>
  );
}
