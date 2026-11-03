import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { ActivityPanel } from '../components/ActivityPanel';
import { MilestoneChain } from '../components/MilestoneChain';
import { ChangeFlow, FnTag, Modal, RiskBadge, StatusBadge, Variance } from '../components/ui';
import { ActionList, ConfBadge, DemandBadge, GateStatus, GateTable, LIFECYCLE_LABEL } from '../components/v4';
import { useApp, useLive } from '../store';
import { finishLabel, fmtIso, fmtTs, slotLabel } from '../time';

type Tab = 'activities' | 'units' | 'structure' | 'readiness' | 'materials' | 'quality' | 'configuration' | 'actions' | 'delays' | 'commitments' | 'history';
const TABS: [Tab, string][] = [['activities', 'Activities'], ['units', 'Units'], ['structure', 'Shipments & site'], ['readiness', 'Readiness'], ['materials', 'Materials'],
  ['quality', 'Tests & quality'], ['configuration', 'Configuration'], ['actions', 'Actions'], ['delays', 'Delays'], ['commitments', 'Commitments'], ['history', 'History']];

export function ProjectDetails() {
  const { id } = useParams();
  const { can, toast } = useApp();
  const { data, error, reload } = useLive<any>(`/projects/${id}`, [id]);
  const [tab, setTab] = useState<Tab>('activities');
  const [panel, setPanel] = useState<{ id: number; unit: string } | null>(null);
  const [chain, setChain] = useState<string | null>(null);
  const [editReq, setEditReq] = useState(false);
  const [req, setReq] = useState({ requiredDate: '', reason: '' });
  const [flow, setFlow] = useState<{ name: string; ops: any[] } | null>(null);
  const [scope, setScope] = useState<string>('all');
  const [unit, setUnit] = useState<number | null>(null);
  if (error) return <div className="alert err pad">{error}</div>;
  if (!data) return <div className="muted pad">Loading…</div>;
  const p = data.project;
  const s = data.summary;
  const label = (a: any) => a.unitLabel ?? a.systemCode ?? (a.scope === 'SHIPMENT' ? data.shipments.find((x: any) => x.id === a.shipmentId)?.code ?? 'Shipment' : a.scope === 'SITE' ? data.visits.find((x: any) => x.id === a.visitId)?.code ?? 'Site' : '');
  const acts = data.activities.filter((a: any) => scope === 'all' || (scope === 'UNIT' ? a.scope === 'UNIT' : a.scope === scope));
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
        <DemandBadge d={p.demandStatus} /> <span className="muted small">{LIFECYCLE_LABEL[s?.lifecycle] ?? ''}</span>
        <RiskBadge risk={s?.risk ?? 'GREEN'} /> <ConfBadge c={s?.confidence} />
        {s?.freeze.frozen && <span className="frozen">❄ Frozen delivery: {s.freeze.shipments.filter((x: any) => x.frozen).map((x: any) => x.code).join(', ')}</span>}
        {p.planStatus === 'INFEASIBLE' && <span className="tag-red">Required date infeasible — earliest commissioning {p.earliestCommissioning}</span>}
        {p.planStatus === 'INDICATIVE' && <span className="pill" title="Uncommitted demand is planned after committed work and creates no commitments">indicative plan</span>}
        <div className="spacer" />
        {can('project.commercial.edit') && <button className="secondary" onClick={() => { setReq({ requiredDate: p.requiredDate ?? '', reason: '' }); setEditReq(true); }}>Change required date</button>}
        {can('scenario.op.configuration') && p.demandStatus !== 'COMMITTED' && <button className="secondary" onClick={() => setFlow({ name: `Commit demand ${p.code}`, ops: [{ type: 'commit_demand', projectId: p.id }] })}>Commit demand…</button>}
        {can('scenario.op.schedule') && notStarted && <button className="secondary" onClick={() => setFlow({ name: `Backward re-plan ${p.code}`, ops: [{ type: 'replan_backward', projectId: p.id }] })}>Re-plan backward…</button>}
        {can('plan.accept_forecast') && <button className="secondary" onClick={acceptForecast}>Accept forecast as commitment</button>}
      </div>
      <div className="cards">
        <div className="card">
          <h4>Commercial</h4>
          <div className="kv"><span>Customer</span>{p.customer}</div>
          <div className="kv"><span>Site</span>{p.siteLocation} ({p.country})</div>
          <div className="kv"><span>Priority</span>#{p.priority}{p.wave ? ` · ${p.wave}` : ''}{p.series ? ` · series ${p.series}` : ''}</div>
          <div className="kv"><span>Required commissioning</span><b>{p.requiredDate ? fmtIso(p.requiredDate) : 'not set'}</b>{p.requiredText && <div className="small muted wrap">{p.requiredText}</div>}</div>
          {p.requiredExwText && <div className="kv"><span>Required ExWorks (customer)</span><span className="small wrap">{p.requiredExwText}</span></div>}
          <div className="kv"><span>Logistics</span>{p.route} · {p.serviceProfile ?? 'default profile'}{p.serviceConfirmation === 'ASSUMPTION' && <span className="tag-red small"> assumption</span>}</div>
          {p.sapOrderRef && <div className="kv"><span>Sales order</span>{p.sapOrderRef}</div>}
          {(p.o2cOwner || p.spoc) && <div className="kv"><span>O2C / SPOC</span>{[p.o2cOwner, p.spoc].filter(Boolean).join(' · ')}</div>}
          {p.customerSituation && <div className="kv"><span>Customer situation</span><span className="small wrap">{p.customerSituation}</span></div>}
          {p.mitigations && <div className="kv"><span>Mitigations</span><span className="small wrap">{p.mitigations}</span></div>}
          {p.notes && <div className="kv"><span>Notes</span><span className="small wrap" style={{ whiteSpace: 'pre-line' }}>{p.notes}</span></div>}
          {p.source === 'IMPORT' && <div className="small muted">Imported from the ramp-up tracker</div>}
        </div>
        <div className="card">
          <h4>Systems ({data.systems.filter((x: any) => x.status === 'ACTIVE').length}) · units ({data.units.filter((u: any) => u.status === 'ACTIVE').length})</h4>
          {data.systems.filter((x: any) => x.status === 'ACTIVE').map((sy: any) => (
            <div key={sy.id} className="kv"><span><b>{sy.code}</b> <span className="muted small">{sy.visit_code}</span></span>
              <span className="small">{data.units.filter((u: any) => u.systemId === sy.id && u.status === 'ACTIVE').map((u: any) => <span key={u.id} className="pill clickable" onClick={() => setUnit(u.id)}>{u.name}</span>)}</span></div>
          ))}
          {data.units.filter((u: any) => !u.systemId && u.status === 'ACTIVE').length > 0 && <div className="kv"><span>Loose</span><span>{data.units.filter((u: any) => !u.systemId && u.status === 'ACTIVE').map((u: any) => <span key={u.id} className="pill clickable" onClick={() => setUnit(u.id)}>{u.name}</span>)}</span></div>}
          {!data.reconciliation.inSync && <div className="alert warn small">Configuration and unit flows differ — see Configuration.</div>}
        </div>
        <div className="card wide">
          <h4>Milestones</h4>
          <table className="grid tight">
            <thead><tr><th>Milestone</th><th>Scope</th><th>Original committed</th><th>Latest approved</th><th>Forecast</th><th>Actual</th><th>Progress</th><th>Variance</th><th>Confidence</th><th>Delay explanation</th></tr></thead>
            <tbody>{[...(s?.milestones ?? []), ...(s?.milestoneParts ?? [])].map((m: any) => (
              <tr key={m.id ?? m.type} className="clickable" onClick={() => !m.scopeCode && setChain(m.type)}>
                <td><b>{m.label}</b></td><td className="small">{m.scopeCode ?? 'project'}</td><td>{m.originalCommittedLabel}</td><td>{m.latestApprovedLabel}</td><td><b>{m.forecastLabel}</b></td><td>{m.actualLabel || '—'}</td>
                <td className="small">{m.progressLabel}</td>
                <td><Variance days={m.varianceDays} /> <RiskBadge risk={m.risk} /></td><td><ConfBadge c={m.confidence} /></td>
                <td className="small">{m.delay ? <>{m.delay.reason} <span className="muted">({m.delay.project} {m.delay.unit} {m.delay.activity}{m.delay.user ? ` · ${m.delay.user}` : ''})</span></> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="hint">ExWorks = packaging complete for the delivery. Each delivery and site visit has its own milestones; click a project milestone for its driving chain.</p>
        </div>
      </div>
      <div className="tabs">{TABS.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l}{t === 'actions' && data.actions.filter((a: any) => a.status === 'OPEN').length ? ` (${data.actions.filter((a: any) => a.status === 'OPEN').length})` : ''}</button>)}</div>
      {tab === 'activities' && (
        <>
          <div className="row">Scope: <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All</option><option value="UNIT">Units</option><option value="SYSTEM">Systems (validation)</option><option value="SHIPMENT">Shipments</option><option value="SITE">Site</option></select></div>
          <table className="grid tight acts">
            <thead><tr><th>Unit / system</th><th>Activity</th><th>Function</th><th>Status</th><th>Approved</th><th>Forecast</th><th>Actual</th><th>Δ</th><th>Readiness</th><th>Blocker / reason</th><th>Updated</th></tr></thead>
            <tbody>{acts.map((a: any) => (
              <tr key={a.id} className={`clickable ${a.isCritical ? 'crit-row' : ''}`} onClick={() => setPanel({ id: a.id, unit: label(a) })}>
                <td>{label(a)}</td><td>{a.name}{a.locked && ' 🔒'}{a.weekendWork && ' ★'}{a.flags?.includes('IMPORTED_ASSUMED_ACTUAL') && <span className="pill" title="Actual taken from a planned tracker date">assumed</span>}</td>
                <td><FnTag fn={a.function} /></td><td><StatusBadge status={a.status} /></td>
                <td className="nowrap small">{slotLabel(a.approvedStart)} → {finishLabel(a.approvedFinish)}</td>
                <td className="nowrap small"><b>{slotLabel(a.forecastStart)} → {finishLabel(a.forecastFinish)}</b> {a.confidence !== 'FIRM' && <ConfBadge c={a.confidence} />}</td>
                <td className="nowrap small">{a.actualStart ? `${slotLabel(a.actualStart)} → ${a.actualFinish ? finishLabel(a.actualFinish) : '…'}` : ''}</td>
                <td>{a.delayed ? <span className="var var-late">+{a.delaySlots / 2}</span> : ''}</td>
                <td className="small">{a.gates.filter((g: any) => g.status !== 'READY' && !g.awaitingPlan).map((g: any) => <div key={g.id} title={g.notes ?? ''}><GateStatus s={g.status} /> {g.title}</div>)}</td>
                <td className="small">{a.blocker ? <span className="tag-red">{a.blocker}</span> : a.delayed ? a.lastEvent?.reason ?? '' : ''}</td>
                <td className="small muted">{a.updatedByName ?? ''}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
      {tab === 'units' && (
        <table className="grid tight">
          <thead><tr><th>Internal id</th><th>Name</th><th>Serial</th><th>Product / item</th><th>HW rev.</th><th>System</th><th>Delivery</th><th>Location</th><th>Software</th><th>Disposition</th><th>Status</th></tr></thead>
          <tbody>{data.units.map((u: any) => (
            <tr key={u.id} className={`clickable ${u.status !== 'ACTIVE' ? 'dim' : ''}`} onClick={() => setUnit(u.id)}>
              <td className="mono small">{u.internalId}</td><td><b>{u.name}</b>{u.evaluation && <span className="pill">evaluation</span>}</td><td className="small">{u.serial ?? <span className="muted">pending</span>}</td>
              <td className="small">{u.productCode}{u.itemCode && <div className="muted">{u.itemCode}</div>}</td><td className="small">{u.hwRevision}</td><td>{u.systemCode ?? '—'}</td><td className="small">{u.shipmentCode ?? '—'}</td>
              <td className="small">{u.location}</td><td className="small">{u.software.map((x: any, i: number) => <div key={i}>{x.component} {x.version}{x.checks ? ' ✓' : ''}</div>)}</td>
              <td>{u.disposition === 'RELEASABLE' ? <span className="small muted">releasable</span> : <span className="tag-red">{u.disposition.toLowerCase().replace('_', ' ')}</span>}</td><td className="small">{u.status.toLowerCase()}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'structure' && <Structure data={data} onChanged={reload} onFlow={setFlow} />}
      {tab === 'readiness' && <ProjectReadiness id={p.id} />}
      {tab === 'materials' && (
        <table className="grid tight">
          <thead><tr><th>Part</th><th>Unit</th><th>Qty</th><th>First operation needing it</th><th>Source</th><th>Readiness</th><th>BOM correction</th></tr></thead>
          <tbody>{data.materials.map((m: any) => (
            <tr key={m.id}><td><b>{m.part_number}</b> <span className="muted small">{m.description}</span></td><td>{m.unit_label}</td><td>{Number(m.qty)}</td><td>{m.needed_at}</td>
              <td>{m.source === 'MANUAL' ? <span className="tag-red">outside BOM</span> : m.source.toLowerCase()}</td>
              <td>{m.gate_status && <GateStatus s={m.gate_status} />} <span className="small muted">{m.gate_notes}{m.forecastLabel ? ` · ${m.forecastLabel}` : ''}</span></td>
              <td className="small">{m.bom_action ? `${m.bom_action} (${m.bom_action_status?.toLowerCase()})` : ''}</td></tr>
          ))}{!data.materials.length && <tr><td className="muted" colSpan={7}>No open critical-component requirements.</td></tr>}</tbody>
        </table>
      )}
      {tab === 'quality' && <ProjectQuality id={p.id} />}
      {tab === 'configuration' && <Configuration data={data} onFlow={setFlow} onChanged={reload} />}
      {tab === 'actions' && <ActionList actions={data.actions} onChanged={reload} />}
      {tab === 'delays' && (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Type</th><th>Activity</th><th>Finish</th><th>Reason</th><th>Origin</th><th>Impacted milestones</th><th>By</th></tr></thead>
          <tbody>{data.delayEvents.map((e: any) => (
            <tr key={e.id} className={`ev-${e.kind}`}>
              <td className="small">{fmtTs(e.created_at)}</td><td><span className={`evk evk-${e.kind}`}>{e.kind.replace('_', ' ')}</span>{e.category ? <span className="muted small"> {e.category}</span> : null}</td>
              <td>{e.unit_label ?? ''} {e.activity}</td><td className="small nowrap">{e.prevFinishLabel} → {e.newFinishLabel}</td><td>{e.reason}</td>
              <td className="small">{e.origin_activity && e.origin_activity_id !== e.activity_id ? `${e.origin_project} ${e.origin_unit ?? ''} ${e.origin_activity}` : ''}{e.related_projects?.length ? <div className="muted">affects {e.related_projects.length} project(s)</div> : null}</td>
              <td className="small">{(e.impacted_milestones ?? []).map((m: any, i: number) => <div key={i}>{m.type}: {m.prevLabel} → {m.nextLabel}</div>)}</td>
              <td className="small">{e.user_name ?? 'system'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'commitments' && (
        <table className="grid tight">
          <thead><tr><th>When</th><th>Milestone</th><th>Scope</th><th>Kind</th><th>Previous</th><th>Committed</th><th>Confidence</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>{data.commitments.map((c: any) => (
            <tr key={c.id}><td className="small">{fmtTs(c.created_at)}</td><td>{c.type}</td><td className="small">{c.shipment_id ? data.shipments.find((x: any) => x.id === c.shipment_id)?.code : c.visit_id ? data.visits.find((x: any) => x.id === c.visit_id)?.code : 'project'}</td>
              <td><span className={`evk evk-${c.kind}`}>{c.kind}</span></td><td>{c.previousLabel || '—'}</td><td><b>{c.committedLabel}</b></td><td><ConfBadge c={c.confidence} /></td><td>{c.reason}</td><td>{c.user_name ?? 'system'}</td></tr>
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
      {unit && <UnitModal id={unit} onClose={() => setUnit(null)} onFlow={(f) => { setUnit(null); setFlow(f); }} />}
      {chain && <MilestoneChain projectId={p.id} type={chain} onClose={() => setChain(null)} onActivity={(aid) => { setChain(null); const a = data.activities.find((x: any) => x.id === aid); setPanel({ id: aid, unit: a ? label(a) : '' }); }} />}
      {editReq && (
        <Modal title="Customer required commissioning date" onClose={() => setEditReq(false)}>
          <label className="field">Required date <input type="date" value={req.requiredDate} onChange={(e) => setReq({ ...req, requiredDate: e.target.value })} /></label>
          <label className="field">Reason <span className="req">required</span><textarea value={req.reason} onChange={(e) => setReq({ ...req, reason: e.target.value })} /></label>
          <p className="hint">Changing the customer date re-evaluates risk. Re-planning the schedule requires an approved scenario.</p>
          <div className="actions"><button onClick={saveReq} disabled={req.reason.length < 3}>Save</button></div>
        </Modal>
      )}
      {flow && (
        <Modal wide title={flow.name} onClose={() => setFlow(null)}>
          <ChangeFlow name={flow.name} ops={flow.ops} onDone={() => { setFlow(null); reload(); }} />
        </Modal>
      )}
    </div>
  );
}

function ProjectReadiness({ id }: { id: number }) {
  const { data, reload } = useLive<any>(`/readiness?projectId=${id}`, [id]);
  if (!data) return <div className="muted">Loading…</div>;
  return <GateTable gates={data.gates} showProject={false} onChanged={reload} />;
}

function ProjectQuality({ id }: { id: number }) {
  const { data } = useLive<any>(`/quality?projectId=${id}`, [id]);
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <>
      <h4>Test records</h4>
      <table className="grid tight"><thead><tr><th>Unit / system</th><th>Test</th><th>Outcome</th><th>Released</th><th>Status</th><th>Evidence</th><th>Executed</th></tr></thead>
        <tbody>{data.tests.map((t: any) => (
          <tr key={t.id} className={t.status === 'SUPERSEDED' ? 'dim' : ''}><td>{t.unit_name ?? t.internal_id ?? t.system_code}</td><td className="small">{t.activity ?? t.plan_code}</td>
            <td><span className={`gs gs-${t.outcome === 'PASS' ? 'READY' : t.outcome === 'FAIL' ? 'BLOCKED' : 'PENDING'}`}>{t.outcome.toLowerCase()}</span></td>
            <td className="small">{t.released_at ? fmtTs(t.released_at) : <span className="muted">not released</span>}</td>
            <td className="small">{t.status === 'REVIEW_REQUIRED' ? <span className="tag-red" title={t.review_reason}>review required</span> : t.status.toLowerCase()}</td>
            <td className="small wrap">{t.evidence_ref}</td><td className="small">{fmtTs(t.executed_at)}</td></tr>
        ))}{!data.tests.length && <tr><td className="muted" colSpan={7}>No test records yet.</td></tr>}</tbody></table>
      <h4>Holds, issues and rework</h4>
      <table className="grid tight"><tbody>
        {data.holds.map((h: any) => <tr key={`h${h.id}`} className={h.status !== 'OPEN' ? 'dim' : ''}><td><span className="tag-red">{h.disposition.toLowerCase().replace('_', ' ')}</span></td><td>{h.unit_name ?? h.internal_id}</td><td className="wrap">{h.reason}</td><td className="small">{h.status.toLowerCase()}</td></tr>)}
        {data.issues.map((i: any) => <tr key={`i${i.id}`}><td><span className="pill">{i.external_ref ?? `issue #${i.id}`}</span></td><td>{(i.units ?? []).map((u: any) => u.name ?? u.internalId).join(', ')}</td><td className="wrap">{i.title}</td><td className="small">{i.status.toLowerCase()}</td></tr>)}
        {data.rework.map((r: any) => <tr key={`r${r.id}`}><td><span className="pill">rework #{r.id}</span></td><td>{r.unit_name ?? r.internal_id}</td><td className="wrap">{r.scope}</td><td className="small">{r.status.toLowerCase()}</td></tr>)}
        {!data.holds.length && !data.issues.length && !data.rework.length && <tr><td className="muted">No holds, issues or rework.</td></tr>}
      </tbody></table>
    </>
  );
}

function Structure({ data, onChanged, onFlow }: { data: any; onChanged: () => void; onFlow: (f: { name: string; ops: any[] }) => void }) {
  const { can, toast } = useApp();
  const [visit, setVisit] = useState<any>(null);
  const saveVisit = async () => {
    try {
      await api(`/visits/${visit.id}`, { method: 'PATCH', body: {
        site: visit.site || undefined, installationResponsibility: visit.installation_responsibility || undefined, executionLeadName: visit.execution_lead_name || null,
        siteWorkResponsible: visit.site_work_responsible || null, siteWorkResponsibleConfirmed: visit.site_work_responsible_confirmed, personnelConfirmed: visit.personnel_confirmed,
        siteAccessConfirmed: visit.site_access_confirmed, rdLed: visit.rd_led, approveDelegation: visit._approveDelegation || undefined, personnelEvidence: visit._evidence || undefined,
      } });
      toast('Site readiness updated', 'ok'); setVisit(null); onChanged();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <>
      <h4>Deliveries (shipment manifests)</h4>
      <table className="grid tight"><thead><tr><th>Shipment</th><th>Service profile</th><th>Units</th><th>Booking</th><th>Collection</th><th>Documents</th></tr></thead>
        <tbody>{data.shipments.map((s: any) => (
          <tr key={s.id}><td><b>{s.code}</b><div className="small muted">{s.destination}</div></td>
            <td className="small">{s.service ?? '—'} {s.mode && <span className="muted">({s.mode.toLowerCase()})</span>}{s.confirmation_status === 'ASSUMPTION' && <div className="tag-red small">assumption — Logistics to confirm</div>}</td>
            <td className="small">{s.manifest_count} · {data.units.filter((u: any) => u.shipmentId === s.id && u.status === 'ACTIVE').map((u: any) => u.name).join(', ')}
              {can('scenario.op.schedule') && (() => {
                const sys = [...new Set(data.units.filter((u: any) => u.shipmentId === s.id && u.status === 'ACTIVE' && u.systemId).map((u: any) => u.systemId))];
                return sys.length > 1 ? <div>{sys.map((sid: any) => {
                  const code = data.systems.find((x: any) => x.id === sid)?.code;
                  const unitIds = data.units.filter((u: any) => u.systemId === sid && u.status === 'ACTIVE').map((u: any) => u.id);
                  return <button key={sid} className="small secondary" onClick={() => onFlow({ name: `Deliver ${code} separately (${data.project.code})`, ops: [{ type: 'regroup_units', unitIds, newShipment: { code: `${data.project.code}-SH${data.shipments.length + 1}` } }] })}>Deliver {code} separately…</button>;
                })}</div> : null;
              })()}</td>
            <td className="small">{s.transport_booked ? `booked ${s.booking_ref}` : s.booking_deadline ? `book by ${fmtTs(s.booking_deadline)}` : '—'}</td>
            <td className="small">{s.collection_at ? fmtTs(s.collection_at) : '—'}</td>
            <td className="small">{(s.documents ?? []).map((d: any) => <span key={d.id} className={`pill ${d.status === 'READY' || d.status === 'NOT_REQUIRED' ? '' : 'late'}`}>{d.status === 'READY' ? '✓' : '✗'} {d.doc_type}</span>)}</td></tr>
        ))}</tbody></table>
      <h4>Site interventions</h4>
      <table className="grid tight"><thead><tr><th>Visit</th><th>Systems</th><th>Installation</th><th>Commissioning lead</th><th>Site work-responsible</th><th>Site access</th><th>Roles (tracker)</th><th /></tr></thead>
        <tbody>{data.visits.map((v: any) => (
          <tr key={v.id}><td><b>{v.code}</b><div className="small muted">{v.site}</div></td>
            <td className="small">{data.systems.filter((x: any) => x.visit_id === v.id && x.status === 'ACTIVE').map((x: any) => x.code).join(', ')}</td>
            <td className="small">{v.installation_responsibility} · {v.installation_days} d</td>
            <td className="small">{v.execution_lead_name ?? <span className="muted">not assigned</span>} {v.personnel_confirmed ? '✓' : <span className="muted">(unconfirmed)</span>}{v.rd_led && <div className="pill">R&D-led{v.delegation_approved_by ? ' · delegation approved' : ' · delegation pending'}</div>}</td>
            <td className="small">{v.site_work_responsible ?? <span className="muted">not named</span>} {v.site_work_responsible_confirmed ? '✓' : ''}</td>
            <td className="small">{v.site_access_confirmed ? '✓ confirmed' : <span className="muted">unconfirmed</span>}</td>
            <td className="small wrap">{(v.roles ?? []).slice(0, 6).map((r: any, i: number) => <div key={i}>{r.role}: {r.person}</div>)}</td>
            <td>{can('site.manage') && <button className="small secondary" onClick={() => setVisit({ ...v, _evidence: '', _approveDelegation: false })}>Edit</button>}</td></tr>
        ))}</tbody></table>
      {visit && (
        <Modal title={`Site intervention ${visit.code}`} onClose={() => setVisit(null)}>
          <label className="field">Site <input value={visit.site ?? ''} onChange={(e) => setVisit({ ...visit, site: e.target.value })} /></label>
          <label className="field">Installation responsibility <input value={visit.installation_responsibility ?? ''} onChange={(e) => setVisit({ ...visit, installation_responsibility: e.target.value })} /></label>
          <label className="field">Commissioning execution lead <input value={visit.execution_lead_name ?? ''} onChange={(e) => setVisit({ ...visit, execution_lead_name: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={visit.personnel_confirmed} onChange={(e) => setVisit({ ...visit, personnel_confirmed: e.target.checked })} /> Qualification / authorization confirmed</label>
          <label className="field">Site work-responsible person <input value={visit.site_work_responsible ?? ''} onChange={(e) => setVisit({ ...visit, site_work_responsible: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={visit.site_work_responsible_confirmed} onChange={(e) => setVisit({ ...visit, site_work_responsible_confirmed: e.target.checked })} /> Designation confirmed (never inferred from a job title)</label>
          {(visit.personnel_confirmed || visit.site_work_responsible_confirmed) && <label className="field">Evidence <span className="req">required</span><input value={visit._evidence} onChange={(e) => setVisit({ ...visit, _evidence: e.target.value })} placeholder="Qualification record, authorization letter…" /></label>}
          <label className="check"><input type="checkbox" checked={visit.site_access_confirmed} onChange={(e) => setVisit({ ...visit, site_access_confirmed: e.target.checked })} /> Site access, foundation & utilities confirmed</label>
          <label className="check"><input type="checkbox" checked={visit.rd_led} onChange={(e) => setVisit({ ...visit, rd_led: e.target.checked })} /> R&D-led intervention (project-specific delegation)</label>
          {visit.rd_led && can('freeze.override') && <label className="check"><input type="checkbox" checked={visit._approveDelegation} onChange={(e) => setVisit({ ...visit, _approveDelegation: e.target.checked })} /> Approve the delegation (Management)</label>}
          <div className="actions"><button onClick={saveVisit}>Save</button></div>
        </Modal>
      )}
    </>
  );
}

function Configuration({ data, onFlow, onChanged }: { data: any; onFlow: (f: { name: string; ops: any[] }) => void; onChanged: () => void }) {
  const { can, toast } = useApp();
  const rec = data.reconciliation;
  const decide = async (id: number, decision: string) => {
    const note = prompt(`${decision === 'APPROVED' ? 'Approval' : 'Rejection'} note`);
    if (!note) return;
    try { await api(`/configurations/${id}/decision`, { body: { decision, note } }); toast(`Configuration ${decision.toLowerCase()}`, 'ok'); onChanged(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <>
      <p className="hint">What must be delivered (versioned configuration) is reconciled against the physical units and their flows. A change is approved first, then applied through a scenario so its impact and the freeze are checked; Logistics acknowledges it.</p>
      {!rec.inSync && rec.issues.length > 0 && <div className="alert warn"><b>Differences</b><ul>{rec.issues.map((i: any, k: number) => <li key={k}>{i.message}</li>)}</ul></div>}
      <table className="grid tight"><thead><tr><th>Version</th><th>Status</th><th>Source</th><th>Systems</th><th>Scope</th><th>By</th><th /></tr></thead>
        <tbody>{rec.configurations.slice().reverse().map((c: any) => {
          const draft = rec.drafts.find((d: any) => d.id === c.id);
          return (
            <tr key={c.id}><td>v{c.version}</td><td>{c.status.toLowerCase()}</td><td className="small">{c.source}{c.source_ref ? ` · ${c.source_ref}` : ''}</td>
              <td className="small">{c.systems.map((s: any) => <div key={s.code}>{s.code}: {s.label}</div>)}</td>
              <td className="small wrap">{c.scope_text}{draft?.differences.length > 0 && <ul>{draft.differences.map((d: any, i: number) => <li key={i}>{d.message}</li>)}</ul>}</td>
              <td className="small">{c.created_by_name}{c.approved_by_name ? ` / ${c.approved_by_name}` : ''}</td>
              <td className="nowrap">{c.status === 'DRAFT' && can('configuration.approve') && <><button className="small secondary" onClick={() => decide(c.id, 'APPROVED')}>Approve</button><button className="small secondary" onClick={() => decide(c.id, 'REJECTED')}>Reject</button></>}
                {c.status === 'APPROVED' && can('scenario.op.configuration') && <button className="small" onClick={() => onFlow({ name: `Apply configuration v${c.version} (${data.project.code})`, ops: [{ type: 'apply_configuration', configurationId: c.id }] })}>Simulate & apply…</button>}</td></tr>
          );
        })}</tbody></table>
      {rec.spareUnits.length > 0 && <><h4>Units released from this project (spare)</h4><div>{rec.spareUnits.map((u: any) => <span key={u.id} className="pill">{u.name ?? u.internalId} · {u.product} · {u.disposition.toLowerCase()}</span>)}</div></>}
    </>
  );
}

function UnitModal({ id, onClose, onFlow }: { id: number; onClose: () => void; onFlow: (f: { name: string; ops: any[] }) => void }) {
  const { can, toast } = useApp();
  const { data, reload } = useLive<any>(`/units/${id}`, [id]);
  const [edit, setEdit] = useState<any>(null);
  const [rw, setRw] = useState<any>(null);
  if (!data) return <Modal title="Unit" onClose={onClose}><div className="muted">Loading…</div></Modal>;
  const u = data.unit;
  return (
    <Modal wide title={`${u.name ?? u.internal_id} — ${u.product_name}`} onClose={onClose}>
      <div className="cards">
        <div className="card">
          <div className="kv"><span>Internal id</span><span className="mono">{u.internal_id}</span></div>
          <div className="kv"><span>Serial</span>{u.serial ?? <span className="muted">not yet assigned</span>}</div>
          <div className="kv"><span>Item code / HW revision</span>{u.item_code ?? '—'} · {u.hw_revision}</div>
          <div className="kv"><span>Project / system / delivery</span>{u.project ?? 'none (spare / R&D)'} · {u.system_code ?? '—'} · {u.shipment_code ?? '—'}</div>
          <div className="kv"><span>Location</span>{u.location}</div>
          <div className="kv"><span>Disposition</span>{u.disposition.toLowerCase().replace('_', ' ')} · {u.status.toLowerCase()}{u.evaluation_unit ? ' · evaluation unit' : ''}</div>
          {u.notes && <div className="kv"><span>Notes</span><span className="small wrap">{u.notes}</span></div>}
          {can('activity.execute.MANUFACTURING') && <button className="small secondary" onClick={() => setEdit({ serial: u.serial ?? '', location: u.location ?? '', hwRevision: u.hw_revision ?? '' })}>Edit identity</button>}
          {can('scenario.op.rework') && u.project && <button className="small secondary" onClick={() => setRw({ scope: '', prepSlots: 1, handsOnSlots: 2, retest: 'EOL', instructionRef: '', issueId: data.issues[0]?.id ?? null })}>Plan rework…</button>}
        </div>
        <div className="card">
          <h4>Installed software</h4>
          {data.software.map((s: any) => <div key={s.id} className={`small ${s.superseded ? 'dim' : ''}`}>{s.component} {s.version} · {s.approval_scope?.toLowerCase()} · {s.checks_passed_at ? 'checks passed' : 'checks pending'} · {fmtTs(s.installed_at)}</div>)}
          {!data.software.length && <div className="muted small">None recorded.</div>}
          <h4>Test records</h4>
          {data.tests.map((t: any) => <div key={t.id} className={`small ${t.status === 'SUPERSEDED' ? 'dim' : ''}`}>{t.activity ?? t.plan_code}: {t.outcome.toLowerCase()}{t.released_at ? ' · released' : ' · not released'}{t.status === 'REVIEW_REQUIRED' ? ` · review required (${t.review_reason})` : ''}</div>)}
          {!data.tests.length && <div className="muted small">None.</div>}
        </div>
      </div>
      <h4>History (identity, allocation, swaps, software)</h4>
      <table className="grid tight"><tbody>{data.history.map((h: any) => (
        <tr key={h.id}><td className="small">{fmtTs(h.created_at)}</td><td>{h.event}</td><td className="small mono">{h.to_value ? JSON.stringify(h.to_value).slice(0, 120) : ''}</td><td className="small">{h.reason}</td><td className="small">{h.user_name}</td></tr>
      ))}</tbody></table>
      {data.holds.filter((h: any) => h.status === 'OPEN').map((h: any) => <div key={h.id} className="alert err small">Quality hold ({h.disposition.toLowerCase().replace('_', ' ')}): {h.reason}</div>)}
      {rw && (
        <Modal title="Rework as a scheduled work package" onClose={() => setRw(null)}>
          <label className="field">Scope <span className="req">required</span><input value={rw.scope} onChange={(e) => setRw({ ...rw, scope: e.target.value })} placeholder="e.g. replace cable cooler pump" /></label>
          <div className="form two">
            <label className="field">Preparation (half-days) <input type="number" min={0} value={rw.prepSlots} onChange={(e) => setRw({ ...rw, prepSlots: Number(e.target.value) })} /></label>
            <label className="field">Hands-on (half-days) <input type="number" min={1} value={rw.handsOnSlots} onChange={(e) => setRw({ ...rw, handsOnSlots: Number(e.target.value) })} /></label>
          </div>
          <label className="field">Retest <select value={rw.retest} onChange={(e) => setRw({ ...rw, retest: e.target.value })}><option value="EOL">EOL retest</option><option value="VALIDATION">System re-validation (flags results for review)</option><option value="NONE">None</option></select></label>
          <label className="field">Rework instruction reference <input value={rw.instructionRef} onChange={(e) => setRw({ ...rw, instructionRef: e.target.value })} placeholder="Approval by Quality / ME needed before preparation can start" /></label>
          <div className="actions"><button disabled={rw.scope.length < 3} onClick={async () => {
            try {
              const r = await api('/rework', { body: { unitId: id, scope: rw.scope, prepSlots: rw.prepSlots, handsOnSlots: rw.handsOnSlots, retest: rw.retest, instructionRef: rw.instructionRef || null, issueId: rw.issueId } });
              onFlow({ name: `Rework #${r.id}: ${u.name ?? u.internal_id} — ${rw.scope}`, ops: [{ type: 'add_rework', reworkId: r.id }] });
            } catch (e: any) { toast(e.message, 'err'); }
          }}>Simulate schedule impact…</button></div>
        </Modal>
      )}
      {edit && (
        <Modal title="Unit identity" onClose={() => setEdit(null)}>
          <label className="field">Serial <input value={edit.serial} onChange={(e) => setEdit({ ...edit, serial: e.target.value })} /></label>
          <label className="field">Location <input value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} /></label>
          <label className="field">Hardware revision <input value={edit.hwRevision} onChange={(e) => setEdit({ ...edit, hwRevision: e.target.value })} /></label>
          <div className="actions"><button onClick={async () => { try { await api(`/units/${id}`, { method: 'PATCH', body: { serial: edit.serial || null, location: edit.location || null, hwRevision: edit.hwRevision || null } }); toast('Unit updated', 'ok'); setEdit(null); reload(); } catch (e: any) { toast(e.message, 'err'); } }}>Save</button></div>
        </Modal>
      )}
    </Modal>
  );
}
