import { useState } from 'react';
import { api } from '../api';
import { ChangeFlow, ImpactView, Modal } from '../components/ui';
import { useApp, useLive } from '../store';
import { fmtDay, isoToDay } from '../time';

export function CapacityView() {
  const { can, toast } = useApp();
  const { data, reload } = useLive<any>('/capacity');
  const [proposal, setProposal] = useState<any>(null);
  const [whatIf, setWhatIf] = useState<{ workCenterId: number; capacity: number } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [recovery, setRecovery] = useState<any>(null);
  const [commit, setCommit] = useState(false);
  const [custom, setCustom] = useState<{ wc: number; cap: string }>({ wc: 0, cap: '' });
  if (!data) return <div className="muted pad">Loading capacity…</div>;
  const days: string[] = [...new Set<string>(data.utilization.map((u: any) => u.date))];
  const cell = new Map(data.utilization.map((u: any) => [`${u.workCenterId}:${u.date}`, u]));
  const runWhatIf = async (workCenterId: number, capacity: number) => {
    setWhatIf({ workCenterId, capacity });
    setPreview(null);
    setRecovery(null);
    const ops = [{ type: 'set_capacity', workCenterId, capacity }];
    setPreview(await api('/simulate', { body: { ops } }));
    setRecovery(await api('/simulate', { body: { ops, recovery: true } }));
  };
  const wcName = (id: number) => data.workCenters.find((w: any) => w.id === id)?.name;
  return (
    <div className="page">
      <div className="toolbar"><h2>Program & Capacity</h2>
        <span className="kpi red">{data.riskSummary.RED} red milestones</span><span className="kpi amber">{data.riskSummary.AMBER} amber</span><span className="kpi">{data.riskSummary.GREEN} green</span><span className="kpi">{data.riskSummary.COMPLETE} complete</span>
        <span className={`kpi ${data.overloads.length ? 'red' : ''}`}>{data.overloads.length} overloaded slots</span>
      </div>
      <h3>Work centers & bottlenecks</h3>
      <table className="grid tight">
        <thead><tr><th>Resource</th><th>Capacity</th><th>Type</th><th>Avg duration</th><th>Throughput (systems/day)</th><th>Must feed</th><th>Capacity needed to feed it</th><th>Queueing in plan</th><th>Load next 20 wd</th><th></th></tr></thead>
        <tbody>{data.bottlenecks.map((b: any) => {
          const w = data.workCenters.find((x: any) => x.id === b.workCenterId);
          return (
            <tr key={b.workCenterId} className={b.isProgramBottleneck ? 'row-late' : b.starvesDownstream ? 'row-warn' : ''}>
              <td><b>{b.name}</b>{b.isProgramBottleneck && <span className="tag-red small"> program bottleneck</span>}{b.starvesDownstream && <span className="tag-amber small"> starves {b.downstreamCode}</span>}</td>
              <td>{b.capacity}{w.provisional && <span className="tag-amber small" title={w.notes}> provisional</span>}</td>
              <td className="small" title={w.notes}>{(w.type ?? '').toLowerCase()} ⓘ</td>
              <td>{b.avgDurationDays} d</td><td><b>{b.throughputPerDay}</b></td>
              <td className="small">{b.downstreamCode ? `${b.downstreamCode} (${b.downstreamThroughput}/d)` : '—'}</td>
              <td>{b.requiredCapacityToFeedDownstream ?? '—'}{b.additionalCapacityNeeded > 0 && <span className="var var-late"> +{b.additionalCapacityNeeded}</span>}</td>
              <td>{b.capacityWaitDays ? `${b.capacityWaitDays} wd (${b.delayedActivities} acts)` : '—'}</td>
              <td><div className="progress"><div style={{ width: `${Math.min(100, b.utilizationNext20d * 100)}%`, background: b.utilizationNext20d > 0.95 ? '#d64545' : undefined }} /></div>{Math.round(b.utilizationNext20d * 100)}%</td>
              <td><button className="secondary small" onClick={() => runWhatIf(b.workCenterId, b.capacity + 1)}>What if +1?</button></td>
            </tr>
          );
        })}</tbody>
      </table>
      <p className="hint">Upstream capacity is not unlimited: each work center is compared with the work center it must feed (its configured sizing target, e.g. subassembly test → Final Assembly, otherwise the slowest downstream work center). Capacity is never increased automatically — changes require an authorized scenario.</p>

      {data.assumptions?.eol && (
        <div className="alert warn small"><b>EOL resource profile: {String(data.assumptions.eol.status).toLowerCase()}</b> — {data.assumptions.eol.note}</div>
      )}
      {data.assumptions?.validation?.status === 'TO_CONFIRM' && <div className="alert info small"><b>Open assumption:</b> {data.assumptions.validation.note}</div>}
      {data.assumptions?.precommissioning?.status === 'TO_CONFIRM' && <div className="alert info small"><b>Open assumption:</b> {data.assumptions.precommissioning.note}</div>}
      <div className="cards">
        <div className="card wide">
          <h4>Capacity timeline (effective-dated)</h4>
          <p className="hint">Proposed → approved → implemented → verified. Only implemented (or verified) capacity feeds the executable plan; proposed and approved improvements are simulated as scenarios.</p>
          <table className="grid tight"><thead><tr><th>Resource</th><th>From</th><th>Capacity</th><th>Status</th><th>Reason</th><th>By</th><th /></tr></thead>
            <tbody>{data.capacityChanges.map((c: any) => (
              <tr key={c.id} className={c.status === 'REJECTED' ? 'dim' : ''}><td>{c.work_center}</td><td>{String(c.effective_from).slice(0, 10)}</td><td>{c.capacity}</td><td><span className={`gs gs-${c.status === 'VERIFIED' || c.status === 'IMPLEMENTED' ? 'READY' : c.status === 'REJECTED' ? 'BLOCKED' : 'PENDING'}`}>{c.status.toLowerCase()}</span></td>
                <td className="small wrap">{c.reason}</td><td className="small">{c.created_by_name}</td>
                <td className="nowrap">{can('scenario.op.capacity') && ({ PROPOSED: 'APPROVED', APPROVED: 'IMPLEMENTED', IMPLEMENTED: 'VERIFIED' } as any)[c.status] && (
                  <button className="small secondary" onClick={async () => {
                    const next = ({ PROPOSED: 'APPROVED', APPROVED: 'IMPLEMENTED', IMPLEMENTED: 'VERIFIED' } as any)[c.status];
                    const note = prompt(`Mark as ${next.toLowerCase()} — note / evidence:`);
                    if (!note) return;
                    try { await api(`/capacity-changes/${c.id}`, { method: 'PATCH', body: { status: next, note } }); toast(`Capacity change ${next.toLowerCase()}`, 'ok'); reload(); } catch (e: any) { toast(e.message, 'err'); }
                  }}>→ {({ PROPOSED: 'approve', APPROVED: 'implemented', IMPLEMENTED: 'verified' } as any)[c.status]}</button>)}</td></tr>
            ))}{!data.capacityChanges.length && <tr><td colSpan={7} className="muted">No dated capacity changes.</td></tr>}</tbody></table>
          {can('scenario.op.capacity') && <button className="secondary small" onClick={() => setProposal({ workCenterId: data.workCenters[0]?.id, effectiveFrom: '', capacity: '', reason: '' })}>+ Propose a dated capacity change</button>}
        </div>
        <div className="card">
          <h4>Non-production occupancy</h4>
          <p className="hint">Troubleshooting, regression, test development, setup and removal reserve real resources (skids, shared supply, crews).</p>
          {data.reservations.map((r: any) => <div key={r.id} className="small"><b>{r.work_center}</b> {r.kind.toLowerCase()} · {r.startLabel} → {r.finishLabel} · {Number(r.units)} unit(s)<div className="muted">{r.reason}</div></div>)}
          {!data.reservations.length && <div className="muted small">None.</div>}
        </div>
      </div>

      <h3>Utilization heat map (next 6 weeks)</h3>
      <div className="heat-wrap">
        <table className="heat">
          <thead><tr><th></th>{days.map((d) => <th key={d} className={[0, 6].includes(new Date(d).getUTCDay()) ? 'nw' : ''}>{fmtDay(isoToDay(d)).split(' ').slice(1).join(' ')}</th>)}</tr></thead>
          <tbody>{data.workCenters.map((w: any) => (
            <tr key={w.id}><th>{w.name}</th>{days.map((d) => {
              const u: any = cell.get(`${w.id}:${d}`);
              const r = u && u.capacity ? u.load / u.capacity : u?.load ? 2 : 0;
              return <td key={d} className={u?.overloaded ? 'over' : ''} style={{ background: r ? `rgba(${r > 0.95 ? '214,69,69' : r > 0.75 ? '230,140,30' : '47,111,221'},${Math.min(0.9, 0.15 + r * 0.6)})` : undefined }}
                title={`${w.name} ${d}: ${u?.load ?? 0} / ${u?.capacity ?? 0} capacity-half-days${u?.overloaded ? ' — OVERLOAD' : ''}`}>{r ? Math.round(r * 100) : ''}</td>;
            })}</tr>
          ))}</tbody>
        </table>
      </div>

      <div className="cards">
        <div className="card wide">
          <h4>Project conflicts (capacity queueing)</h4>
          <table className="grid tight"><thead><tr><th>Project</th><th>Work center</th><th>Waiting</th><th>Activities</th><th>Capacity held by</th></tr></thead>
            <tbody>{data.conflicts.slice(0, 20).map((c: any, i: number) => (
              <tr key={i}><td><b>{c.project}</b></td><td>{wcName(c.workCenterId)}</td><td>{c.waitDays} wd</td><td>{c.activities}</td><td className="small">{c.blockingProjects.join(', ') || 'own units'}</td></tr>
            ))}{!data.conflicts.length && <tr><td colSpan={5} className="muted">No capacity queueing.</td></tr>}</tbody></table>
        </div>
        <div className="card">
          <h4>Proposed capacity improvements</h4>
          {data.proposals.map((p: any) => (
            <div key={p.workCenterId} className="proposal">
              <b>{p.workCenter}</b>: {p.from} → {p.to}<div className="small muted">{p.rationale}</div>
              <button className="secondary small" onClick={() => runWhatIf(p.workCenterId, p.to)}>Simulate impact</button>
            </div>
          ))}
          <h4>Custom what-if</h4>
          <div className="row">
            <select value={custom.wc} onChange={(e) => setCustom({ ...custom, wc: Number(e.target.value) })}><option value={0}>Work center…</option>{data.workCenters.map((w: any) => <option key={w.id} value={w.id}>{w.name} ({w.capacity})</option>)}</select>
            <input type="number" step="0.5" min="0.5" placeholder="capacity" value={custom.cap} onChange={(e) => setCustom({ ...custom, cap: e.target.value })} style={{ width: 80 }} />
            <button className="small" disabled={!custom.wc || !custom.cap} onClick={() => runWhatIf(custom.wc, Number(custom.cap))}>Simulate</button>
          </div>
        </div>
      </div>
      {data.overloads.length > 0 && (
        <><h3>Overloads (never hidden)</h3>
          <table className="grid tight"><tbody>{data.overloads.slice(0, 40).map((o: any, i: number) => <tr key={i} className="row-late"><td>{wcName(o.workCenterId)}</td><td>{o.slotLabel}</td><td>{o.load} / {o.capacity}</td><td>{o.activities.length} activities</td></tr>)}</tbody></table></>
      )}
      {proposal && (
        <Modal title="Propose a dated capacity change" onClose={() => setProposal(null)}>
          <label className="field">Resource <select value={proposal.workCenterId} onChange={(e) => setProposal({ ...proposal, workCenterId: Number(e.target.value) })}>{data.workCenters.map((w: any) => <option key={w.id} value={w.id}>{w.name} ({w.capacity})</option>)}</select></label>
          <label className="field">Effective from <input type="date" value={proposal.effectiveFrom} onChange={(e) => setProposal({ ...proposal, effectiveFrom: e.target.value })} /></label>
          <label className="field">New capacity <input type="number" step="0.5" value={proposal.capacity} onChange={(e) => setProposal({ ...proposal, capacity: e.target.value })} /></label>
          <label className="field">Reason <span className="req">required</span><textarea rows={2} value={proposal.reason} onChange={(e) => setProposal({ ...proposal, reason: e.target.value })} /></label>
          <div className="actions"><button disabled={!proposal.effectiveFrom || !proposal.capacity || proposal.reason.length < 3} onClick={async () => {
            try { await api('/capacity-changes', { body: { workCenterId: proposal.workCenterId, effectiveFrom: proposal.effectiveFrom, capacity: Number(proposal.capacity), reason: proposal.reason } }); toast('Proposed — it affects the executable plan only once implemented', 'ok'); setProposal(null); reload(); } catch (e: any) { toast(e.message, 'err'); }
          }}>Propose</button></div>
        </Modal>
      )}
      {whatIf && (
        <Modal wide title={`What if ${wcName(whatIf.workCenterId)} capacity = ${whatIf.capacity}?`} onClose={() => { setWhatIf(null); setCommit(false); }}>
          {commit ? <ChangeFlow name={`Capacity ${wcName(whatIf.workCenterId)} → ${whatIf.capacity}`} ops={[{ type: 'set_capacity', workCenterId: whatIf.workCenterId, capacity: whatIf.capacity }]} onDone={() => { setWhatIf(null); setCommit(false); }} />
            : preview ? <>
              <h4>Impact on the committed plan</h4>
              <p className="hint">Approved dates are never pulled earlier automatically; only work currently delayed by this capacity benefits.</p>
              <ImpactView result={preview} compact />
              <h4>Recovery potential</h4>
              <p className="hint">Same change, if affected projects may start earlier than approved (explicit recovery / pull-in decision).</p>
              {recovery ? <ImpactView result={recovery} compact /> : <div className="muted">Simulating…</div>}
              <div className="actions">{can('scenario.op.capacity') ? <button onClick={() => setCommit(true)}>Create scenario to commit…</button> : <span className="muted">Capacity changes are decided by Management / Program.</span>}</div>
            </> : <div className="muted">Simulating…</div>}
        </Modal>
      )}
    </div>
  );
}
