/** Shared V4 UI: readiness gates, confidence, demand, change basket helpers. */
import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { finishLabel, fmtTs, slotLabel } from '../time';
import { Modal, SlotInput } from './ui';

export const DIM_LABEL: Record<string, string> = {
  CONFIGURATION: 'Configuration', MATERIAL: 'Material', SOFTWARE: 'Software', RESOURCE: 'Resource', QUALITY: 'Quality', EXTERNAL: 'External / site',
};
export const DEMAND_LABEL: Record<string, string> = { COMMITTED: 'Committed', APPROVED: 'Approved', TENTATIVE: 'Tentative' };
export const LIFECYCLE_LABEL: Record<string, string> = { EXECUTION: 'In execution', COMMITTED: 'Committed', APPROVED_AWAITING_SCHEDULE: 'Approved — awaiting commitment', TENTATIVE: 'Tentative' };

export function ConfBadge({ c }: { c?: string | null }) {
  if (!c) return null;
  const tip = c === 'FIRM' ? 'All readiness inputs confirmed' : c === 'CONDITIONAL' ? 'Depends on forecast (not yet confirmed) readiness dates' : 'Depends on a readiness input without a date — open-ended uncertainty';
  return <span className={`conf conf-${c}`} title={tip}>{c === 'FIRM' ? 'firm' : c === 'CONDITIONAL' ? 'conditional' : 'open'}</span>;
}
export function GateStatus({ s }: { s: string }) {
  return <span className={`gs gs-${s}`}>{s.toLowerCase()}</span>;
}
export function DemandBadge({ d }: { d: string }) {
  if (d === 'COMMITTED') return <span className="pill">committed</span>;
  return <span className={`demand d-${d}`} title="Uncommitted demand: indicative plan, never displaces committed work">{DEMAND_LABEL[d]?.toLowerCase()}</span>;
}

const EDITABLE_SOURCES = new Set(['MANUAL', 'IMPORT']);

/** Table of readiness gates with owner updates and conditional release. */
export function GateTable({ gates, showProject = true, onChanged }: { gates: any[]; showProject?: boolean; onChanged?: () => void }) {
  const { can, toast } = useApp();
  const [edit, setEdit] = useState<any>(null);
  const [cond, setCond] = useState<any>(null);
  if (!gates.length) return <div className="muted">No readiness gates.</div>;
  return (
    <>
      <table className="grid tight">
        <thead><tr>{showProject && <th>Project</th>}<th>Status</th><th>Readiness item</th><th>Type</th><th>Needed by</th><th>Unit / system</th><th>Forecast</th><th>Owner</th><th>Evidence / last confirmed</th><th /></tr></thead>
        <tbody>{gates.map((g) => {
          const cr = g.conditional_release && !g.conditional_release.revokedAt ? g.conditional_release : null;
          return (
            <tr key={g.id} className={g.status === 'BLOCKED' ? 'row-late' : ''}>
              {showProject && <td><b>{g.project}</b></td>}
              <td><GateStatus s={g.status} />{g.awaiting_plan && <div className="small muted" title="Resolved by work already in the plan (e.g. the planned test and its release)">via plan</div>}</td>
              <td className="wrap">{g.title}<div className="small muted">{g.notes}</div>
                {cr && <div className="small"><span className="pill" title={`Conditions: ${cr.conditions}`}>conditional release: {cr.scope}</span> by {cr.approverName}{cr.expirySlot ? ` until ${finishLabel(cr.expirySlot)}` : ''}</div>}</td>
              <td className="small">{DIM_LABEL[g.dimension] ?? g.dimension}<div className="muted">{g.blocks === 'COMPLETE' ? 'before completion' : 'before start'}</div></td>
              <td className="small nowrap">{g.activity}<div className="muted">{g.neededFromLabel ?? slotLabel(g.forecast_start)}</div></td>
              <td className="small">{g.unit ?? g.system_code ?? g.shipment_code ?? g.visit_code ?? ''}</td>
              <td className="small nowrap">{g.forecastLabel || (g.status === 'READY' ? '' : <span className="muted">undated</span>)}</td>
              <td className="small">{g.owner_name ?? g.owner_role ?? <span className="muted">unassigned</span>}</td>
              <td className="small">{g.evidence_ref}{g.last_confirmed_at && <div className="muted">{fmtTs(g.last_confirmed_at)}{g.confirmed_by_name ? ` · ${g.confirmed_by_name}` : ''}</div>}</td>
              <td className="nowrap">
                {EDITABLE_SOURCES.has(g.source_type) ? <button className="small secondary" onClick={() => setEdit({ ...g, _status: g.status, _forecast: g.forecast_slot, _evidence: g.evidence_ref ?? '', _notes: '' })}>Update</button>
                  : <span className="small muted" title="Derived from its source records (materials, releases, test results, documents, site data)">derived</span>}
                {can('gate.conditional_release') && g.status !== 'READY' && <button className="small secondary" onClick={() => setCond({ ...g, _scope: cr?.scope ?? '', _conditions: cr?.conditions ?? '', _expiry: cr?.expirySlot ?? null })}>{cr ? 'Release…' : 'Cond. release'}</button>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {edit && (
        <Modal title={`Readiness: ${edit.title}`} onClose={() => setEdit(null)}>
          <label className="field">Status <select value={edit._status} onChange={(e) => setEdit({ ...edit, _status: e.target.value })}>
            {['UNKNOWN', 'PENDING', 'READY', 'BLOCKED'].map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="field">Forecast (when it will be ready) <SlotInput finish allowEmpty value={edit._forecast} onChange={(v) => setEdit({ ...edit, _forecast: v })} /></label>
          <label className="field">Evidence / reference {edit._status === 'READY' && <span className="req">required</span>}<input value={edit._evidence} onChange={(e) => setEdit({ ...edit, _evidence: e.target.value })} placeholder="Document, e-mail, record id…" /></label>
          <label className="field">Note<textarea rows={2} value={edit._notes} onChange={(e) => setEdit({ ...edit, _notes: e.target.value })} /></label>
          <p className="hint">Unknown is never treated as ready. A forecast date makes dependent dates conditional; no date keeps them open.</p>
          <div className="actions">
            <button className="secondary" onClick={async () => { try { await api(`/gates/${edit.id}`, { method: 'PATCH', body: { confirm: true } }); toast('Confirmed unchanged', 'ok'); setEdit(null); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); } }}>Confirm unchanged</button>
            <button onClick={async () => {
              try {
                await api(`/gates/${edit.id}`, { method: 'PATCH', body: { status: edit._status, forecastSlot: edit._forecast, evidenceRef: edit._evidence || undefined, notes: edit._notes || undefined } });
                toast('Readiness updated — plan recalculated', 'ok'); setEdit(null); onChanged?.();
              } catch (e: any) { toast(e.message, 'err'); }
            }}>Save</button>
          </div>
        </Modal>
      )}
      {cond && (
        <Modal title={`Conditional release: ${cond.title}`} onClose={() => setCond(null)}>
          <p className="hint">Work may proceed despite this open item, only within the scope and conditions recorded here, until the expiry.</p>
          <label className="field">Scope <span className="req">required</span><input value={cond._scope} onChange={(e) => setCond({ ...cond, _scope: e.target.value })} placeholder="e.g. FA may start; EOL completion still requires the part" /></label>
          <label className="field">Conditions <span className="req">required</span><textarea rows={2} value={cond._conditions} onChange={(e) => setCond({ ...cond, _conditions: e.target.value })} /></label>
          <label className="field">Expires <SlotInput finish allowEmpty value={cond._expiry} onChange={(v) => setCond({ ...cond, _expiry: v })} /></label>
          <div className="actions">
            {cond.conditional_release && !cond.conditional_release.revokedAt && <button className="secondary" onClick={async () => { try { await api(`/gates/${cond.id}/conditional-release`, { body: { revoke: true } }); setCond(null); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); } }}>Revoke</button>}
            <button disabled={cond._scope.length < 3 || cond._conditions.length < 3} onClick={async () => {
              try { await api(`/gates/${cond.id}/conditional-release`, { body: { scope: cond._scope, conditions: cond._conditions, expirySlot: cond._expiry } }); toast('Conditional release recorded', 'ok'); setCond(null); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); }
            }}>Approve conditional release</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Action items (BOM corrections, Logistics acknowledgments, explanations, reconciliation, tracker topics). */
export function ActionList({ actions, onChanged }: { actions: any[]; onChanged?: () => void }) {
  const { toast } = useApp();
  if (!actions.length) return <div className="muted">No open actions.</div>;
  const { can } = useApp();
  const book = async (a: any) => {
    const ref = prompt(`${a.title}\n\nBooking reference (carrier booking number):`);
    if (!ref) return;
    try { await api(`/shipments/${a.related.shipmentId}`, { method: 'PATCH', body: { transportBooked: true, bookingRef: ref } }); toast('Transport booked — request closed', 'ok'); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); }
  };
  const set = async (a: any, status: string) => {
    const note = status === 'DONE' || status === 'CANCELLED' ? prompt('Note (optional)') ?? undefined : undefined;
    try { await api(`/actions/${a.id}`, { method: 'PATCH', body: { status, note } }); onChanged?.(); } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <table className="grid tight">
      <tbody>{actions.map((a) => (
        <tr key={a.id} className={a.status !== 'OPEN' ? 'dim' : ''}>
          <td className="small nowrap"><span className="pill">{a.kind.replace(/_/g, ' ').toLowerCase()}</span></td>
          <td>{a.project && <b>{a.project} </b>}{a.title}<div className="small muted wrap">{a.details}</div></td>
          <td className="small">{a.owner_name ?? a.owner_role ?? ''}{a.due_date && <div className={a.status === 'OPEN' && String(a.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) ? 'late' : 'muted'}>due {String(a.due_date).slice(0, 10)}</div>}</td>
          <td className="small muted">{fmtTs(a.created_at)}{a.source === 'IMPORT' ? ' · tracker' : ''}</td>
          <td className="nowrap">{a.status === 'OPEN' ? <>
            {a.kind === 'LOGISTICS_ACK' && <button className="small secondary" onClick={() => set(a, 'ACKNOWLEDGED')}>Acknowledge</button>}
            {a.kind === 'TRANSPORT_BOOKING' ? <>{can('logistics.manage') && <button className="small" onClick={() => book(a)}>Book…</button>}
              {can('freeze.override') && <button className="small secondary" onClick={() => set(a, 'CANCELLED')}>Cancel</button>}</>
              : <button className="small secondary" onClick={() => set(a, 'DONE')}>Done</button>}</> : <span className="small muted">{a.status.toLowerCase()}</span>}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
