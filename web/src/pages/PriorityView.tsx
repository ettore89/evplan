import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MilestoneChain } from '../components/MilestoneChain';
import { ChangeFlow, Empty, MilestoneCell, Modal, RiskBadge } from '../components/ui';
import { ConfBadge, DemandBadge, LIFECYCLE_LABEL } from '../components/v4';
import { useApp, useLive } from '../store';
import { fmtIso, fmtTs } from '../time';
import { NewProject } from './NewProject';

export function PriorityView() {
  const { can } = useApp();
  const nav = useNavigate();
  const { data } = useLive<any>('/portfolio');
  const [order, setOrder] = useState<number[] | null>(null);
  const [flow, setFlow] = useState(false);
  const [chain, setChain] = useState<{ projectId: number; type: string } | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [demand, setDemand] = useState('ALL');
  useEffect(() => { if (!flow) setOrder(null); }, [data?.version]);
  const projects = useMemo(() => {
    if (!data) return [];
    const list = order ? order.map((id) => data.projects.find((p: any) => p.id === id)) : data.projects;
    return list.filter(Boolean);
  }, [data, order]);
  if (!data) return <div className="muted pad">Loading portfolio…</div>;
  const canPrio = can('scenario.op.priority');
  const moveTo = (id: number, idx: number) => {
    const cur = (order ?? data.projects.map((p: any) => p.id)).filter((x: number) => x !== id);
    cur.splice(idx, 0, id);
    setOrder(cur);
  };
  const dirty = order && order.some((id, i) => data.projects[i]?.id !== id);
  const visible = projects.filter((p: any) => (!filter || `${p.code} ${p.name} ${p.customer} ${p.siteLocation}`.toLowerCase().includes(filter.toLowerCase())) && (demand === 'ALL' || p.demandStatus === demand));
  const demandCount = (d: string) => data.projects.filter((p: any) => p.demandStatus === d).length;
  const risk = { RED: 0, AMBER: 0 } as any;
  for (const p of data.projects) if (p.risk in risk) risk[p.risk]++;
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Priority View</h2>
        <span className="muted">Shared ranking · same sequence as the Gantt · today {data.nowLabel}</span>
        <span className="kpi red">{risk.RED} red</span><span className="kpi amber">{risk.AMBER} amber</span>
        <span className="kpi">{data.projects.filter((p: any) => p.freeze.frozen).length} frozen</span>
        <span className="kpi" title="Demand status">{demandCount('COMMITTED')} committed · {demandCount('APPROVED')} approved · {demandCount('TENTATIVE')} tentative</span>
        <select value={demand} onChange={(e) => setDemand(e.target.value)}><option value="ALL">All demand</option><option value="COMMITTED">Committed</option><option value="APPROVED">Approved</option><option value="TENTATIVE">Tentative</option></select>
        <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="spacer" />
        {dirty && <><button className="secondary" onClick={() => setOrder(null)}>Reset</button><button onClick={() => setFlow(true)}>Simulate new ranking…</button></>}
        {can('project.create') && <button className="secondary" onClick={() => setNewProject(true)}>+ New project</button>}
      </div>
      {canPrio && <p className="hint">Drag rows (or use ▲▼) to propose a new priority ranking. Changes are simulated against capacity and the 21-day freeze before they can be committed.</p>}
      {!visible.length ? <Empty>No projects.</Empty> : (
        <table className="grid priority">
          <thead>
            <tr><th>#</th><th>Project</th><th>Customer / site</th><th>Configuration</th><th>Required</th><th>EOL testing</th><th>ExWorks</th><th>Commissioned</th><th>Readiness · next blocker</th><th>Confidence</th><th>Progress</th><th>Status</th></tr>
          </thead>
          <tbody>
            {visible.map((p: any, i: number) => (
              <tr key={p.id} draggable={canPrio} onDragStart={() => setDrag(p.id)} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (drag !== null && drag !== p.id) moveTo(drag, i); setDrag(null); }}
                className={`${order && data.projects.findIndex((x: any) => x.id === p.id) !== i ? 'moved' : ''}`}>
                <td className="rank">
                  <b>{i + 1}</b>
                  {canPrio && <span className="rank-btns"><button className="icon" disabled={i === 0} onClick={() => moveTo(p.id, i - 1)}>▲</button><button className="icon" disabled={i === visible.length - 1} onClick={() => moveTo(p.id, i + 1)}>▼</button></span>}
                </td>
                <td className="clickable" onClick={() => nav(`/projects/${p.id}`)}><b>{p.code}</b> <DemandBadge d={p.demandStatus} /><div className="small">{p.name}</div>
                  <div className="small muted">{LIFECYCLE_LABEL[p.lifecycle] ?? p.lifecycle}</div>
                  {p.planStatus === 'INFEASIBLE' && <div className="tag-red small" title={`Earliest commissioning ${p.earliestCommissioning}`}>infeasible — earliest {p.earliestCommissioning}</div>}</td>
                <td>{p.customer}<div className="small muted">{p.siteLocation} · {p.country} · {p.region}</div></td>
                <td>{p.lines.map((l: any) => <div key={l.productCode} className="small">{l.quantity}× {l.productName} <span className="code">{l.productCode}</span></div>)}
                  <div className="small muted">{p.systems} systems · {p.units} units{p.heldUnits > 0 && <span className="tag-red"> {p.heldUnits} on hold</span>}</div></td>
                <td className="nowrap">{p.requiredDate ? fmtIso(p.requiredDate) : <span className="muted" title={p.requiredText ?? ''}>{p.requiredText ? p.requiredText.split('\n').pop() : 'not set'}</span>}</td>
                {['EOL', 'EXW', 'COMM'].map((t) => <td key={t}><MilestoneCell m={p.milestones.find((m: any) => m.type === t)} onClick={() => setChain({ projectId: p.id, type: t })} /></td>)}
                <td className="small wrap" style={{ maxWidth: 220 }}>
                  <div>{p.readiness.BLOCKED > 0 && <span className="gs gs-BLOCKED">{p.readiness.BLOCKED} blocked</span>} {p.readiness.UNKNOWN > 0 && <span className="gs gs-UNKNOWN">{p.readiness.UNKNOWN} unknown</span>} {p.readiness.PENDING > 0 && <span className="gs gs-PENDING">{p.readiness.PENDING} pending</span>}
                    {p.readiness.conditional > 0 && <span className="pill">{p.readiness.conditional} cond. release</span>}{!p.readiness.BLOCKED && !p.readiness.UNKNOWN && !p.readiness.PENDING && <span className="gs gs-READY">ready</span>}</div>
                  {p.readiness.nextBlocker && <div title={`${p.readiness.nextBlocker.activity} · ${p.readiness.nextBlocker.unit ?? ''}`}>▸ {p.readiness.nextBlocker.title} <span className="muted">({p.readiness.nextBlocker.owner ?? 'no owner'}{p.readiness.nextBlocker.forecastLabel ? `, ${p.readiness.nextBlocker.forecastLabel}` : ''})</span></div>}
                </td>
                <td><ConfBadge c={p.confidence} /><div className="small muted" title="Last confirmed update">{p.lastUpdate ? fmtTs(p.lastUpdate) : 'no update'}</div></td>
                <td><div className="progress"><div style={{ width: `${p.progressPct}%` }} /></div><span className="small">{p.progressPct}%</span> <RiskBadge risk={p.risk} />
                  {p.milestoneParts?.filter((m: any) => m.type === 'EXW').length > 1 && <div className="small muted">{p.milestoneParts.filter((m: any) => m.type === 'EXW' && m.complete).length}/{p.milestoneParts.filter((m: any) => m.type === 'EXW').length} deliveries at ExWorks</div>}</td>
                <td className="small">
                  {p.freeze.frozen ? <div className="frozen" title={`ExWorks ${p.freeze.exworksDate}; freeze since ${p.freeze.freezeStartDate}`}>❄ Frozen</div> : p.freeze.freezeStartDate && <div className="muted">freeze {fmtIso(p.freeze.freezeStartDate)}</div>}
                  {p.openBlockers > 0 && <div className="tag-red">{p.openBlockers} blocked</div>}
                  {p.lateActivities > 0 && <div className="muted">{p.lateActivities} late acts</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {flow && order && (
        <Modal wide title="Priority change — impact simulation" onClose={() => setFlow(false)}>
          <ChangeFlow name={`Reprioritization: ${order.map((id) => data.projects.find((p: any) => p.id === id)?.code).join(' > ')}`} ops={[{ type: 'set_priority', order }]}
            onDone={() => { setFlow(false); setOrder(null); }} />
        </Modal>
      )}
      {chain && <MilestoneChain {...chain} onClose={() => setChain(null)} />}
      {newProject && <NewProject onClose={() => setNewProject(false)} />}
    </div>
  );
}
