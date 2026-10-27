import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ActivityPanel } from '../components/ActivityPanel';
import { ChangeFlow, FnTag, Modal, RiskBadge, StatusBadge, Variance } from '../components/ui';
import { useApp, useLive } from '../store';
import { fmtTs } from '../time';

export function DailyControl() {
  const { can, toast, user, presence, events } = useApp();
  const { data, reload } = useLive<any>('/daily');
  const [panel, setPanel] = useState<{ id: number; unit: string } | null>(null);
  const [prio, setPrio] = useState<{ projectId: number; toRank: number; code: string } | null>(null);
  const [decision, setDecision] = useState({ text: '', projectId: '' as any, owner: '' });
  const [busy, setBusy] = useState(false);
  if (!data) return <div className="muted pad">Loading daily program control…</div>;
  const ch = data.changesSincePreviousCall;
  const isMgmt = can('snapshot.create');
  const startCall = async () => {
    const label = prompt('Daily call label', `Daily call ${new Date().toISOString().slice(0, 10)}`);
    if (!label) return;
    await api('/snapshots', { body: { label } });
    toast('Call started: plan snapshot saved. Changes from now on are highlighted at the next call.', 'ok');
    reload();
  };
  const recalc = async () => {
    setBusy(true);
    try { const r = await api('/recalculate', { body: {} }); toast(`Recalculated: ${r.changedActivities} activities re-forecast`, 'ok'); } catch (e: any) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const quick = async (a: any, status: string) => {
    const body: any = { status };
    const doIt = async (extra: any = {}) => api(`/activities/${a.id}/execution`, { method: 'PATCH', body: { ...body, ...extra } });
    try {
      await doIt();
      toast(`${a.name} → ${status}`, 'ok');
    } catch (e: any) {
      if (e.code === 'DELAY_REASON_REQUIRED') {
        const reason = prompt(`${e.message}. Enter the delay explanation:`);
        if (reason) { try { await doIt({ delayReason: reason }); toast('Saved with delay explanation', 'ok'); } catch (e2: any) { toast(e2.message, 'err'); } }
      } else toast(e.message, 'err');
    }
  };
  const addDecision = async () => {
    try {
      await api('/decisions', { body: { text: decision.text, projectId: decision.projectId ? Number(decision.projectId) : null, owner: decision.owner || undefined } });
      setDecision({ text: '', projectId: '', owner: '' });
      reload();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const closeDecision = async (id: number) => { await api(`/decisions/${id}`, { method: 'PATCH', body: { status: 'DONE' } }); reload(); };
  const ActTable = ({ rows, empty, actions }: { rows: any[]; empty: string; actions?: boolean }) => (
    <table className="grid tight compact">
      <tbody>
        {rows.slice(0, 40).map((a) => (
          <tr key={a.id} className={`clickable ${a.isCritical ? 'crit-row' : ''}`} onClick={() => setPanel({ id: a.id, unit: a.unit })}>
            <td><b>{a.project}</b></td><td>{a.unit}</td><td>{a.name}</td><td><FnTag fn={a.function} /></td><td><StatusBadge status={a.status} /></td>
            <td className="small nowrap">{a.forecastStartLabel} → {a.forecastFinishLabel}</td>
            <td>{a.delaySlots > 0 && <span className="var var-late">+{a.delaySlots / 2}</span>}</td>
            <td className="small">{a.blocker ?? a.lastEvent?.reason ?? ''}</td>
            {actions && <td className="nowrap" onClick={(e) => e.stopPropagation()}>
              {['NOT_STARTED', 'READY'].includes(a.status) && <button className="small secondary" onClick={() => quick(a, 'IN_PROGRESS')}>Start</button>}
              {['IN_PROGRESS', 'BLOCKED'].includes(a.status) && <button className="small secondary" onClick={() => quick(a, 'COMPLETED')}>Done</button>}
            </td>}
          </tr>
        ))}
        {!rows.length && <tr><td className="muted">{empty}</td></tr>}
      </tbody>
    </table>
  );
  return (
    <div className="page daily">
      <div className="toolbar">
        <h2>Daily Program Control</h2>
        <span className="muted">{data.nowLabel} · plan v{data.version}</span>
        <span className="presence">{presence.map((p) => <span key={p.id} className="avatar" title={`${p.name} (${p.role})`}>{p.name.split(' ').map((x) => x[0]).join('')}</span>)} <span className="small muted">{presence.length} online</span></span>
        <div className="spacer" />
        {isMgmt && <button className="secondary" disabled={busy} onClick={recalc}>Recalculate now</button>}
        {isMgmt && <button onClick={startCall}>Start daily call (snapshot)</button>}
      </div>
      <div className="daily-grid">
        <section className="d-projects">
          <h3>Projects by priority</h3>
          <table className="grid tight compact">
            <thead><tr><th>#</th><th>Project</th><th>Next</th><th>EOL</th><th>ExWorks</th><th>Commissioned</th><th></th></tr></thead>
            <tbody>{data.projects.map((p: any, i: number) => (
              <tr key={p.id}>
                <td className="nowrap"><b>{p.priority}</b>{can('scenario.op.priority') && <span className="rank-btns">
                  <button className="icon" disabled={i === 0} onClick={() => setPrio({ projectId: p.id, toRank: p.priority - 1, code: p.code })}>▲</button>
                  <button className="icon" disabled={i === data.projects.length - 1} onClick={() => setPrio({ projectId: p.id, toRank: p.priority + 1, code: p.code })}>▼</button></span>}</td>
                <td><Link to={`/projects/${p.id}`}><b>{p.code}</b></Link> <span className="small muted">{p.name}</span>{p.freeze.frozen && <span className="frozen"> ❄</span>}{p.openBlockers > 0 && <span className="tag-red small"> {p.openBlockers}⛔</span>}</td>
                <td className="small">{p.nextMilestone?.label ?? 'done'}</td>
                {['EOL', 'EXW', 'COMM'].map((t) => { const m = p.milestones.find((x: any) => x.type === t); return <td key={t} className="small nowrap" title={m?.delay?.reason ?? ''}>{m?.complete ? '✓' : m?.forecastLabel.replace(/^\w{3} /, '').replace(/^\d{4}-/, '')} {m && !m.complete && <Variance days={m.varianceDays} />}</td>; })}
                <td><RiskBadge risk={p.risk} /></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
        <section>
          <h3>Decisions requiring Management <span className="count">{data.managementDecisions.length}</span></h3>
          <ul className="plain mgmt">{data.managementDecisions.map((d: any, i: number) => (
            <li key={i} className={`md-${d.kind}`}><b>{d.title}</b><div className="small muted">{d.detail}</div>
              {d.scenarioId && <Link className="small" to="/scenarios">Review scenario →</Link>}{d.projectId && <Link className="small" to={`/projects/${d.projectId}`}> Open project →</Link>}</li>
          ))}{!data.managementDecisions.length && <li className="muted">Nothing pending.</li>}</ul>
        </section>
        <section>
          <h3>Changes since previous call {ch && <span className="muted small">({ch.snapshot.label}, {fmtTs(ch.snapshot.createdAt)})</span>}</h3>
          {!ch ? <div className="muted">No previous call snapshot.</div> : (
            <div className="small">
              <div>{ch.priorityChanges.length} priority · {ch.milestoneChanges.length} milestone · {ch.statusChanges.length} status changes · {ch.newBlockers.length} new blockers · {ch.rescheduledActivities} re-forecast activities</div>
              {ch.priorityChanges.map((c: any) => <div key={c.projectId}>⇅ <b>{c.project}</b> rank {c.from} → {c.to}</div>)}
              {ch.milestoneChanges.map((c: any, i: number) => <div key={i} className={c.deltaDays > 0 ? 'late' : ''}>◆ <b>{c.project}</b> {c.label}: {c.fromLabel} → {c.toLabel} {c.deltaDays ? <Variance days={c.deltaDays} /> : null}{c.completed ? ' ✓ completed' : ''}{c.approvedChanged ? ' (commitment changed)' : ''}</div>)}
              {ch.newBlockers.map((b: any) => <div key={b.activityId} className="late">⛔ <b>{b.project}</b> {b.name}: {b.blocker}</div>)}
              <details><summary>{ch.events.length} logged updates</summary>{ch.events.map((e: any) => <div key={e.id}>{fmtTs(e.ts)} <b>{e.user_name ?? 'system'}</b> {e.action} {e.project ?? ''} {e.reason ? `— ${e.reason}` : ''}</div>)}</details>
            </div>
          )}
        </section>
        <section className="wide2">
          <h3>Today's planned activities <span className="count">{data.todays.length}</span></h3>
          <ActTable rows={data.todays} empty="Nothing planned today." actions />
        </section>
        <section>
          <h3>Open blockers <span className="count red">{data.blockers.length}</span></h3>
          <ActTable rows={data.blockers} empty="No open blockers." />
        </section>
        <section>
          <h3>Overdue vs commitment <span className="count">{data.overdue.length}</span></h3>
          <ActTable rows={data.overdue} empty="Nothing overdue." actions />
        </section>
        <section>
          <h3>Awaiting owner updates <span className="count">{data.awaitingUpdates.length}</span></h3>
          <ActTable rows={data.awaitingUpdates} empty="All owners up to date." actions />
        </section>
        <section>
          <h3>Work-center capacity conflicts</h3>
          {data.capacityConflicts.overloads.length > 0 && <div className="alert err small">{data.capacityConflicts.overloads.length} overloaded half-days</div>}
          <table className="grid tight compact"><tbody>{data.capacityConflicts.queueing.map((c: any, i: number) => (
            <tr key={i}><td><b>{c.project}</b></td><td>{c.workCenterId && (data.projects && '')}{c.waitDays} wd queue</td><td className="small muted">{c.activities} acts · held by {c.blockingProjects.join(', ') || 'own units'}</td></tr>
          ))}{!data.capacityConflicts.queueing.length && <tr><td className="muted">No queueing in the next 2 weeks.</td></tr>}</tbody></table>
          <Link className="small" to="/capacity">Capacity view →</Link>
        </section>
        <section>
          <h3>Decisions & actions log</h3>
          {isMgmt && (
            <div className="row">
              <input placeholder="Decision / action" value={decision.text} onChange={(e) => setDecision({ ...decision, text: e.target.value })} style={{ flex: 1 }} />
              <select value={decision.projectId} onChange={(e) => setDecision({ ...decision, projectId: e.target.value })}><option value="">—</option>{data.projects.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}</select>
              <input placeholder="Owner" value={decision.owner} onChange={(e) => setDecision({ ...decision, owner: e.target.value })} style={{ width: 110 }} />
              <button className="small" disabled={decision.text.length < 2} onClick={addDecision}>Log</button>
            </div>
          )}
          <ul className="plain">{data.decisions.map((d: any) => (
            <li key={d.id} className={d.status === 'DONE' ? 'dim' : ''}><span className="small muted">{fmtTs(d.created_at)}</span> {d.project && <b>{d.project}</b>} {d.text} {d.owner && <span className="muted">→ {d.owner}</span>}
              {d.status === 'OPEN' && isMgmt && <button className="icon" title="Mark done" onClick={() => closeDecision(d.id)}>✓</button>}</li>
          ))}</ul>
        </section>
        <section>
          <h3>Live updates</h3>
          <ul className="plain small">{events.filter((e) => e.kind !== 'TIME_TICK').map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} — {e.summary}{e.userId === user?.id ? ' (you)' : ''}</li>)}{!events.length && <li className="muted">Changes from all users appear here in real time.</li>}</ul>
        </section>
      </div>
      {panel && <ActivityPanel id={panel.id} unitLabel={panel.unit} onClose={() => setPanel(null)} />}
      {prio && (
        <Modal wide title={`Move ${prio.code} to rank ${prio.toRank}`} onClose={() => setPrio(null)}>
          <ChangeFlow name={`Daily call: ${prio.code} to rank ${prio.toRank}`} source="DAILY_CALL" ops={[{ type: 'move_priority', projectId: prio.projectId, toRank: prio.toRank }]} onDone={() => setPrio(null)} />
        </Modal>
      )}
    </div>
  );
}
