import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { finishLabel, fmtTs, slotLabel } from '../time';
import { ChangeFlow, FnTag, Modal, SlotInput, StatusBadge, STATUS_LABEL } from './ui';

const DRIVER_LABEL: Record<string, string> = {
  predecessor: 'Waiting for predecessor', approved: 'Approved planned start', now: 'Not started yet (start passed)', reported: 'Reported delay',
  blocked: 'Blocked', overdue: 'Overdue — awaiting owner update', locked: 'Locked commitment', capacity: 'Work-center capacity',
  actual: 'In execution', completed: 'Completed', cancelled: 'Not applicable', none: '—',
};

export function ActivityPanel({ id, onClose, unitLabel }: { id: number; onClose: () => void; unitLabel?: string }) {
  const { version, toast, can, meta } = useApp();
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [move, setMove] = useState<number | null>(null);
  const [moveFlow, setMoveFlow] = useState(false);
  const [pullIn, setPullIn] = useState(false);

  useEffect(() => {
    api(`/activities/${id}`).then((d) => {
      setData(d);
      setForm({ status: d.activity.status, pctComplete: d.activity.pctComplete, expectedFinish: d.activity.expectedFinish, blocker: d.activity.blocker ?? '' });
    });
  }, [id, version]);
  if (!data) return <Modal title="Activity" onClose={onClose}><div className="muted">Loading…</div></Modal>;
  const a = data.activity;
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const delayTriggered =
    (form.status === 'BLOCKED' && a.status !== 'BLOCKED') ||
    (form.expectedFinish != null && form.expectedFinish !== a.expectedFinish && form.expectedFinish > (a.forecastFinish ?? 0)) ||
    (form.actualFinish != null && a.approvedFinish != null && form.actualFinish > a.approvedFinish) || form.reportDelay;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: any = { status: form.status !== a.status ? form.status : undefined, pctComplete: form.pctComplete };
      if (form.expectedFinish !== a.expectedFinish) body.expectedFinish = form.expectedFinish;
      if (form.actualStart !== undefined) body.actualStart = form.actualStart;
      if (form.actualFinish !== undefined) body.actualFinish = form.actualFinish;
      if ((form.blocker ?? '') !== (a.blocker ?? '')) body.blocker = form.blocker || null;
      if (form.comment) body.comment = form.comment;
      if (form.delayReason) { body.delayReason = form.delayReason; body.delayCategory = form.delayCategory ?? 'OTHER'; }
      if (form.reportDelay) body.reportDelay = true;
      const r = await api(`/activities/${id}/execution`, { method: 'PATCH', body });
      const msg = r.milestoneChanges.length ? ` — ${r.milestoneChanges.length} milestone forecast(s) changed` : '';
      toast(`Saved. ${r.changedActivities} activities re-forecast${msg}`, 'ok');
      setForm((f: any) => ({ ...f, comment: '', delayReason: '', reportDelay: false, actualStart: undefined, actualFinish: undefined }));
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  };
  const lock = async () => {
    const reason = prompt(`${a.locked ? 'Unlock' : 'Lock'} "${a.name}" — reason:`);
    if (!reason) return;
    try { await api(`/activities/${id}/lock`, { body: { locked: !a.locked, reason } }); toast('Updated', 'ok'); } catch (e: any) { toast(e.message, 'err'); }
  };
  const dates: [string, number | null, number | null][] = [
    ['Baseline', a.baselineStart, a.baselineFinish], ['Approved', a.approvedStart, a.approvedFinish],
    ['Forecast', a.forecastStart, a.forecastFinish], ['Actual', a.actualStart, a.actualFinish],
  ];
  const canSchedule = can('scenario.op.schedule') && !['COMPLETED', 'IN_PROGRESS', 'CANCELLED'].includes(a.status);
  return (
    <Modal wide title={<>{unitLabel ? <span className="muted">{unitLabel} · </span> : null}{a.name} <StatusBadge status={a.status} /> {a.isCritical && <span className="crit-tag">driving path</span>} {a.locked && <span className="lock-tag">🔒 locked</span>}</>} onClose={onClose}>
      <div className="panel-grid">
        <div>
          <div className="kv"><span>Function</span><FnTag fn={a.function} /></div>
          <div className="kv"><span>Work center</span>{a.workCenter ?? 'Transport (route calendar)'}</div>
          <div className="kv"><span>Duration</span>{a.durationSlots / 2} {a.kind === 'transport' ? 'transport days' : 'working days'}</div>
          <div className="kv"><span>Constrained by</span>{DRIVER_LABEL[a.driver?.type] ?? '—'}{a.capacityWaitSlots ? ` (${a.capacityWaitSlots / 2} wd queue)` : ''}</div>
          {a.weekendWork && <div className="kv"><span>Weekend work</span>authorized exception used</div>}
          <table className="grid tight dates">
            <thead><tr><th></th><th>Start</th><th>Finish</th></tr></thead>
            <tbody>{dates.map(([l, s, f]) => <tr key={l}><td>{l}</td><td>{slotLabel(s)}</td><td>{finishLabel(f)}</td></tr>)}</tbody>
          </table>
          {a.delayed && <div className="alert warn">Forecast finish is {a.delaySlots / 2} working days later than approved.{a.lastEvent?.reason ? <> Cause: <b>{a.lastEvent.reason}</b>{a.lastEvent.activity && a.lastEvent.activityId !== a.id ? <> (origin: {a.lastEvent.project} {a.lastEvent.unit} · {a.lastEvent.activity})</> : null}</> : null}</div>}
          {a.rescheduled && <div className="alert info">Approved schedule differs from baseline (approved rescheduling).</div>}
          <h4>Predecessors</h4>
          <ul className="plain">{data.predecessors.map((p: any) => <li key={p.id}>{p.name} — <StatusBadge status={p.status} /> {finishLabel(p.forecast_finish)}</li>)}{!data.predecessors.length && <li className="muted">none</li>}</ul>
          {can('activity.lock') && <button className="secondary small" onClick={lock}>{a.locked ? 'Unlock commitment' : 'Lock commitment'}</button>}
        </div>
        <div>
          {data.canEdit ? (
            <div className="form">
              <h4>Execution update</h4>
              <label className="field">Status
                <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {(form.status === 'IN_PROGRESS' || form.status === 'BLOCKED') && (
                <label className="field">% complete <input type="number" min={0} max={100} value={form.pctComplete} onChange={(e) => set('pctComplete', Number(e.target.value))} /></label>
              )}
              {['IN_PROGRESS', 'COMPLETED', 'BLOCKED'].includes(form.status) && (
                <label className="field">Actual start <SlotInput value={form.actualStart ?? a.actualStart ?? a.forecastStart} onChange={(v) => set('actualStart', v)} /></label>
              )}
              {form.status === 'COMPLETED' && (
                <label className="field">Actual finish (last half-day) <SlotInput finish value={form.actualFinish ?? a.actualFinish ?? Math.min(a.forecastFinish, meta?.now + 1)} onChange={(v) => set('actualFinish', v)} /></label>
              )}
              {form.status !== 'COMPLETED' && form.status !== 'CANCELLED' && (
                <label className="field">Expected completion {a.expectedFinish ? '(reported)' : ''}
                  <SlotInput finish allowEmpty value={form.expectedFinish ?? null} onChange={(v) => set('expectedFinish', v)} />
                  <span className="hint">Current forecast: {finishLabel(a.forecastFinish)} · approved: {finishLabel(a.approvedFinish)}</span>
                </label>
              )}
              {form.status === 'BLOCKED' && <label className="field">Blocker <span className="req">required</span><input value={form.blocker} onChange={(e) => set('blocker', e.target.value)} /></label>}
              <label className="check"><input type="checkbox" checked={!!form.reportDelay} onChange={(e) => set('reportDelay', e.target.checked)} /> Report this task as delayed</label>
              {delayTriggered && (
                <div className="delay-box">
                  <label className="field">Delay explanation <span className="req">mandatory</span>
                    <textarea rows={2} value={form.delayReason ?? ''} onChange={(e) => set('delayReason', e.target.value)} placeholder="Root cause of the delay" />
                  </label>
                  <label className="field">Category
                    <select value={form.delayCategory ?? 'OTHER'} onChange={(e) => set('delayCategory', e.target.value)}>
                      {meta?.delayCategories?.filter((c: any) => c.code !== 'SYSTEM').map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <label className="field">Comment <textarea rows={2} value={form.comment ?? ''} onChange={(e) => set('comment', e.target.value)} /></label>
              {err && <div className="alert err">{err}</div>}
              <div className="actions"><button disabled={busy} onClick={save}>Save update</button></div>
              <p className="hint">Execution updates are always allowed, also inside the ExWorks freeze. Successor forecasts are recalculated immediately.</p>
            </div>
          ) : <div className="alert info">Read-only: {a.function} activities are updated by the responsible function or Management.</div>}
          {canSchedule && (
            <div className="form">
              <h4>Reschedule (Program)</h4>
              <label className="field">New start <SlotInput value={move ?? a.forecastStart} onChange={setMove} /></label>
              <label className="check"><input type="checkbox" checked={pullIn} onChange={(e) => setPullIn(e.target.checked)} /> Let successors follow an earlier move</label>
              <div className="actions"><button className="secondary" disabled={move === null || move === a.forecastStart} onClick={() => setMoveFlow(true)}>Simulate move…</button></div>
            </div>
          )}
        </div>
      </div>
      <h4>History</h4>
      <div className="history">
        {data.events.map((e: any) => (
          <div key={`e${e.id}`} className={`hist ev-${e.kind}`}>
            <span className="muted">{fmtTs(e.created_at)}</span> <b>{e.kind.replace('_', ' ').toLowerCase()}</b> {finishLabel(e.prev_finish)} → {finishLabel(e.new_finish)}
            {e.reason && <> — {e.reason}</>}{e.origin_activity && e.kind === 'PROPAGATED' && <span className="muted"> (from {e.origin_activity})</span>} {e.user_name && <span className="muted">· {e.user_name}</span>}
          </div>
        ))}
        {data.comments.map((c: any) => <div key={`c${c.id}`} className="hist"><span className="muted">{fmtTs(c.created_at)}</span> 💬 <b>{c.user_name}</b>: {c.text}</div>)}
        {!data.events.length && !data.comments.length && <div className="muted">No history yet.</div>}
      </div>
      {moveFlow && move !== null && (
        <Modal wide title={`Move "${a.name}" to ${slotLabel(move)}`} onClose={() => setMoveFlow(false)}>
          <ChangeFlow name={`Move ${a.name} (${unitLabel ?? ''}) to ${slotLabel(move)}`} source="GANTT" ops={[{ type: 'move_activity', activityId: a.id, start: move, pullInSuccessors: pullIn }]}
            onDone={() => { setMoveFlow(false); setMove(null); }} />
        </Modal>
      )}
    </Modal>
  );
}
