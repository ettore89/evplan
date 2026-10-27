import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { dayOf, dayToIso, finishLabel, fmtTs, isoToDay, slotLabel } from '../time';

export const FN_COLORS: Record<string, string> = {
  MANUFACTURING: '#2f6fdd', TESTING: '#8b5cf6', RND: '#0e9f9c', LOGISTICS: '#d98a06', SERVICE: '#16a34a',
};
export const FN_LABEL: Record<string, string> = { MANUFACTURING: 'Manufacturing', TESTING: 'Testing', RND: 'R&D', LOGISTICS: 'Logistics', SERVICE: 'Service' };
export const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started', READY: 'Ready', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked', COMPLETED: 'Completed', CANCELLED: 'N/A',
};
export const ROLE_LABEL: Record<string, string> = {
  MANUFACTURING: 'Manufacturing', TESTING: 'Testing', RND: 'R&D', LOGISTICS: 'Logistics', COMMERCIAL: 'Commercial', SERVICE: 'Service', MANAGEMENT: 'Management / Program',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge st-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}
export function RiskBadge({ risk }: { risk: string }) {
  return <span className={`risk risk-${risk}`} title={`Risk: ${risk}`}>{risk === 'COMPLETE' ? 'Done' : risk[0] + risk.slice(1).toLowerCase()}</span>;
}
export function FnTag({ fn }: { fn: string }) {
  return <span className="fn" style={{ borderColor: FN_COLORS[fn], color: FN_COLORS[fn] }}>{FN_LABEL[fn] ?? fn}</span>;
}
export function Variance({ days, title }: { days: number; title?: string }) {
  if (!days) return <span className="var var-0" title={title}>±0</span>;
  return <span className={`var ${days > 0 ? 'var-late' : 'var-early'}`} title={title}>{days > 0 ? '+' : ''}{days}wd</span>;
}

export function MilestoneCell({ m, onClick }: { m: any; onClick?: () => void }) {
  if (!m) return <span className="muted">—</span>;
  const tip = [
    `${m.label}`,
    `Original committed: ${m.originalCommittedLabel || '—'}`,
    `Latest approved: ${m.latestApprovedLabel || '—'}`,
    `Forecast: ${m.forecastLabel || '—'}`,
    `Actual: ${m.actualLabel || '—'}`,
    `Variance vs approved: ${m.varianceDays} wd · vs original: ${m.varianceVsOriginalDays} wd`,
    m.delay ? `Cause: ${m.delay.reason} (${m.delay.project ?? ''} ${m.delay.unit ?? ''} ${m.delay.activity ?? ''})` : '',
  ].filter(Boolean).join('\n');
  return (
    <div className={`ms-cell ${onClick ? 'clickable' : ''}`} title={tip} onClick={onClick}>
      <div className="ms-date">
        {m.complete ? <span className="ms-done">✓ {short(m.actualLabel)}</span> : short(m.forecastLabel)}
      </div>
      <div className="ms-sub">
        <RiskBadge risk={m.risk} /> <Variance days={m.varianceDays} />
        {m.varianceVsOriginalDays !== m.varianceDays && m.varianceVsOriginalDays > 0 && <span className="muted small" title="vs original commitment"> orig +{m.varianceVsOriginalDays}</span>}
      </div>
      {m.delay && m.varianceDays > 0 && <div className="ms-cause" title={m.delay.reason}>{m.delay.reason}</div>}
    </div>
  );
}
const short = (l: string) => (l ? l.replace(/^(\w{3}) /, '') : '—');

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><button className="icon" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Date + AM/PM picker producing a half-day slot. `finish` mode: the picked half-day is the last one occupied. */
export function SlotInput({ value, onChange, finish, allowEmpty }: { value: number | null; onChange: (v: number | null) => void; finish?: boolean; allowEmpty?: boolean }) {
  const s = value === null ? null : finish ? value - 1 : value;
  const date = s === null ? '' : dayToIso(dayOf(s));
  const half = s === null ? 0 : s % 2;
  const emit = (d: string, h: number) => {
    if (!d) return onChange(allowEmpty ? null : value);
    const slot = isoToDay(d) * 2 + h;
    onChange(finish ? slot + 1 : slot);
  };
  return (
    <span className="slot-input">
      <input type="date" value={date} onChange={(e) => emit(e.target.value, half)} />
      <select value={half} onChange={(e) => emit(date, Number(e.target.value))}>
        <option value={0}>AM</option>
        <option value={1}>PM</option>
      </select>
    </span>
  );
}

export function ImpactView({ result, compact }: { result: any; compact?: boolean }) {
  if (!result) return null;
  const changed = result.projects.filter((p: any) => p.impacted || p.priorityBefore !== p.priorityAfter);
  return (
    <div className="impact">
      <div className="impact-summary">
        <strong>{result.summary}</strong>
        {result.overloadsAfter !== result.overloadsBefore && <span> · overloads {result.overloadsBefore} → {result.overloadsAfter}</span>}
      </div>
      {result.reasons.length > 0 && <ul className="reasons">{result.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>}
      {result.violations.length > 0 && (
        <div className="alert err"><strong>Invalid schedule — cannot be committed</strong>
          <ul>{result.violations.map((v: any, i: number) => <li key={i}>{v.message}</li>)}</ul></div>
      )}
      <table className="grid tight">
        <thead><tr><th>#</th><th>Project</th><th>Freeze</th><th>EOL</th><th>ExWorks</th><th>Commissioned</th><th>Acts</th></tr></thead>
        <tbody>
          {(compact ? changed : result.projects).map((p: any) => (
            <tr key={p.id} className={p.impacted ? (p.delayed ? 'row-late' : p.improved ? 'row-early' : '') : 'dim'}>
              <td>{p.priorityBefore !== p.priorityAfter ? <b>{p.priorityBefore}→{p.priorityAfter}</b> : p.priorityAfter}</td>
              <td><b>{p.code}</b> <span className="muted">{p.name}</span></td>
              <td>{p.frozen ? <span className="frozen" title={`Frozen since ${p.freezeStartDate}`}>❄ frozen</span> : ''}</td>
              {['EOL', 'EXW', 'COMM'].map((t) => {
                const m = p.milestones[t];
                return <td key={t}>{m.deltaDays ? <span>{short(m.beforeLabel)} → <b>{short(m.afterLabel)}</b> <Variance days={m.deltaDays} /></span> : <span className="muted">{short(m.afterLabel)}</span>}
                  {t === 'COMM' && p.lateVsRequired && <span className="late-flag" title={`Customer date ${p.requiredDate}`}> ⚠ late</span>}</td>;
              })}
              <td>{p.changedActivities || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!compact && result.displaced.length > 0 && (
        <details open><summary>Displaced by capacity reallocation ({result.displaced.length})</summary>
          <table className="grid tight"><tbody>{result.displaced.slice(0, 40).map((d: any) => (
            <tr key={d.activityId}><td>{result.projects.find((p: any) => p.id === d.projectId)?.code}</td><td>{d.name}</td><td>+{d.delayDays} d</td>
              <td className="muted">by {d.byProjects.map((x: number) => result.projects.find((p: any) => p.id === x)?.code).join(', ')}</td></tr>
          ))}</tbody></table></details>
      )}
      {!compact && result.changedActivities.length > 0 && (
        <details><summary>Rescheduled activities ({result.changedActivities.length})</summary>
          <table className="grid tight"><thead><tr><th>Project</th><th>Unit</th><th>Activity</th><th>Start</th><th>Finish</th><th>Δ</th></tr></thead>
            <tbody>{result.changedActivities.slice(0, 200).map((c: any) => (
              <tr key={c.activityId}><td>{result.projects.find((p: any) => p.id === c.projectId)?.code}</td><td>{c.unit ?? 'Shipment'}</td><td>{c.name}</td>
                <td>{slotLabel(c.beforeStart)} → {slotLabel(c.afterStart)}</td><td>{finishLabel(c.beforeFinish)} → {finishLabel(c.afterFinish)}</td><td><Variance days={c.deltaDays} /></td></tr>
            ))}</tbody></table></details>
      )}
      {!compact && result.capacityShifts.length > 0 && (
        <details><summary>Capacity shifts, next 20 working days ({result.capacityShifts.length})</summary>
          <table className="grid tight"><tbody>{result.capacityShifts.map((s: any, i: number) => (
            <tr key={i}><td>{s.workCenter}</td><td>{result.projects.find((p: any) => p.id === s.projectId)?.code}</td><td>{s.beforeSlots / 2} → {s.afterSlots / 2} days booked</td></tr>
          ))}</tbody></table></details>
      )}
    </div>
  );
}

/** Simulate → review → commit flow for a set of scenario operations. */
export function ChangeFlow({ ops, name, source, onDone, defaultReason }: { ops: any[]; name: string; source?: string; onDone: () => void; defaultReason?: string }) {
  const { toast, can } = useApp();
  const [result, setResult] = useState<any>(null);
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [just, setJust] = useState(defaultReason ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api('/scenarios', { body: { name, ops, source } })
      .then((r) => { if (alive) { setResult(r.result); setScenarioId(r.id); } })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);
  const commit = async (confirmLatest = false) => {
    if (!scenarioId) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api(`/scenarios/${scenarioId}/commit`, { body: { justification: just || undefined, confirmLatest } });
      if (r.status === 'PENDING_APPROVAL') toast('Submitted for Management / Program approval (frozen projects affected)', 'info');
      else toast(`Committed — plan version ${r.version}`, 'ok');
      onDone();
    } catch (e: any) {
      if (e.code === 'STALE_SIMULATION') { setResult(e.details.result); setErr('The plan changed meanwhile — impact updated below. Review and commit again.'); }
      else setErr(e.message);
    } finally { setBusy(false); }
  };
  if (err && !result) return <div className="alert err">{err}</div>;
  if (!result) return <div className="muted">Simulating with the scheduling engine…</div>;
  const needsMgmt = result.requiresManagement;
  const canOverride = can('freeze.override');
  return (
    <div>
      <ImpactView result={result} />
      {err && <div className="alert err">{err}</div>}
      <label className="field">Justification / reason {result.requiresReason && <span className="req">required</span>}
        <textarea value={just} onChange={(e) => setJust(e.target.value)} rows={2} placeholder="Why is this change needed? (recorded in the audit trail)" />
      </label>
      <div className="actions">
        <button className="secondary" onClick={onDone}>Discard (keep as draft)</button>
        <button disabled={busy || result.violations.length > 0} onClick={() => commit()}>
          {needsMgmt && !canOverride ? 'Submit for Management approval' : needsMgmt ? 'Approve freeze override & commit' : 'Commit change'}
        </button>
      </div>
    </div>
  );
}

export function useMeta() {
  return useApp().meta;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export { fmtTs };
