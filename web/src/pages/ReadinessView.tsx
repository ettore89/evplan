import { useMemo, useState } from 'react';
import { ActionList, DIM_LABEL, GateTable } from '../components/v4';
import { useLive } from '../store';

/** Readiness & handovers across all projects: what must be true before work can start or finish, who owns it, and since when it is confirmed. */
export function ReadinessView() {
  const { data, reload } = useLive<any>('/readiness');
  const actions = useLive<any[]>('/actions');
  const [dim, setDim] = useState('ALL');
  const [status, setStatus] = useState('OPEN');
  const [project, setProject] = useState('ALL');
  const [q, setQ] = useState('');
  const gates = useMemo(() => (data?.gates ?? []).filter((g: any) =>
    (dim === 'ALL' || g.dimension === dim) && (project === 'ALL' || g.project === project)
    && (status === 'ALL' || (status === 'OPEN' ? g.status !== 'READY' && !g.awaiting_plan : g.status === status))
    && (!q || `${g.title} ${g.owner_name ?? ''} ${g.owner_role ?? ''} ${g.unit ?? ''} ${g.notes ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [data, dim, status, project, q]);
  if (!data) return <div className="muted pad">Loading readiness…</div>;
  const all = data.gates as any[];
  const count = (s: string) => all.filter((g) => g.status === s && !g.awaiting_plan).length;
  const projects = [...new Set(all.map((g) => g.project))].filter(Boolean).sort();
  const openActions = (actions.data ?? []).filter((a: any) => a.status === 'OPEN');
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Readiness & handovers</h2>
        <span className="muted">Configuration · material · software · resource · quality · external inputs per operation</span>
      </div>
      <div className="statgrid">
        <div className="stat"><b className="late">{count('BLOCKED')}</b><span>blocked</span></div>
        <div className="stat"><b>{count('UNKNOWN')}</b><span>unknown (never treated as ready)</span></div>
        <div className="stat"><b>{count('PENDING')}</b><span>pending with forecast</span></div>
        <div className="stat"><b>{all.filter((g) => g.awaiting_plan).length}</b><span>resolved by planned work</span></div>
        <div className="stat"><b>{all.filter((g) => g.conditional_release && !g.conditional_release.revokedAt).length}</b><span>conditional releases</span></div>
        <div className="stat"><b>{openActions.length}</b><span>open actions</span></div>
      </div>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="OPEN">Open (not ready)</option><option value="ALL">All</option><option value="BLOCKED">Blocked</option><option value="UNKNOWN">Unknown</option><option value="PENDING">Pending</option><option value="READY">Ready</option>
        </select>
        <select value={dim} onChange={(e) => setDim(e.target.value)}><option value="ALL">All types</option>{Object.entries(DIM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={project} onChange={(e) => setProject(e.target.value)}><option value="ALL">All projects</option>{projects.map((p) => <option key={p}>{p}</option>)}</select>
        <input className="search" placeholder="Search item / owner / unit…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{gates.length} shown</span>
      </div>
      <GateTable gates={gates.slice(0, 400)} onChanged={reload} />
      <h3>Open actions</h3>
      <p className="hint">BOM corrections, Logistics acknowledgments of configuration changes, explanations for missed starts, reconciliation differences and imported tracker topics.</p>
      <ActionList actions={openActions} onChanged={actions.reload} />
    </div>
  );
}
