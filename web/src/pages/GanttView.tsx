import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityPanel } from '../components/ActivityPanel';
import { MilestoneChain } from '../components/MilestoneChain';
import { ChangeFlow, FN_COLORS, FN_LABEL, Modal, RiskBadge, STATUS_LABEL } from '../components/ui';
import { useApp, useLive } from '../store';
import { dayOf, finishLabel, fmtDay, isoToDay, monthLabel, slotLabel, weekNo } from '../time';

type Row =
  | { kind: 'project'; key: string; p: any; h: number }
  | { kind: 'unit'; key: string; p: any; u: any; acts: any[]; h: number }
  | { kind: 'ship'; key: string; p: any; acts: any[]; h: number }
  | { kind: 'act'; key: string; p: any; a: any; unitLabel: string; h: number };

const H = { project: 36, unit: 26, ship: 26, act: 22 };
const MS_ICON: Record<string, string> = { EOL: 'E', EXW: 'X', COMM: 'C' };

export function GanttView() {
  const { can, version } = useApp();
  const { data } = useLive<any>('/gantt');
  const [zoom, setZoom] = useState(12);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fnFilter, setFnFilter] = useState<Set<string>>(new Set());
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [delaysOnly, setDelaysOnly] = useState(false);
  const [showBaseline, setShowBaseline] = useState(true);
  const [panel, setPanel] = useState<{ id: number; unit: string } | null>(null);
  const [chain, setChain] = useState<{ projectId: number; type: string } | null>(null);
  const [drag, setDrag] = useState<{ a: any; startX: number; dx: number } | null>(null);
  const [move, setMove] = useState<{ a: any; start: number; unit: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const canMove = can('scenario.op.schedule');
  const scrolled = useRef(false);
  useEffect(() => {
    if (!data || scrolled.current || !scroller.current) return;
    scrolled.current = true;
    const from = data.range.from - 8 - (data.range.from % 2);
    scroller.current.scrollLeft = Math.max(0, (data.now - from) * zoom - 420);
  }, [data]);

  const model = useMemo(() => {
    if (!data) return null;
    const byProject = new Map<number, any[]>();
    for (const a of data.activities) byProject.set(a.projectId, [...(byProject.get(a.projectId) ?? []), a]);
    const overloaded = new Set<number>();
    for (const o of data.overloads) for (const id of o.activities) overloaded.add(id);
    return { byProject, overloaded, nonWorking: new Set<number>(data.nonWorkingDays) };
  }, [data]);

  if (!data || !model) return <div className="muted pad">Loading Gantt…</div>;
  const W = zoom;
  const from = data.range.from - 8 - (data.range.from % 2);
  const to = data.range.to + 16;
  const width = (to - from) * W;
  const x = (s: number) => (s - from) * W;
  const toggle = (k: string) => setExpanded((e) => { const n = new Set(e); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const visibleAct = (a: any) => (!fnFilter.size || fnFilter.has(a.function)) && (!criticalOnly || a.isCritical) && (!delaysOnly || a.delayed || a.status === 'BLOCKED');

  const rows: Row[] = [];
  for (const p of data.projects) {
    rows.push({ kind: 'project', key: `p${p.id}`, p, h: H.project });
    if (!expanded.has(`p${p.id}`)) continue;
    const acts = model.byProject.get(p.id) ?? [];
    for (const u of data.units.filter((u: any) => u.projectId === p.id)) {
      const ua = acts.filter((a: any) => a.unitId === u.id);
      rows.push({ kind: 'unit', key: `u${u.id}`, p, u, acts: ua, h: H.unit });
      if (expanded.has(`u${u.id}`)) for (const a of acts.filter((a: any) => a.unitId === u.id)) if (visibleAct(a)) rows.push({ kind: 'act', key: `a${a.id}`, p, a, unitLabel: u.serial, h: H.act });
    }
    rows.push({ kind: 'ship', key: `s${p.id}`, p, acts: acts.filter((a: any) => a.kind === 'transport'), h: H.ship });
  }
  const top = new Map<string, number>();
  let y = 0;
  for (const r of rows) { top.set(r.key, y); y += r.h; }
  const totalH = y;

  // header cells
  const days: number[] = [];
  for (let d = dayOf(from); d < dayOf(to); d++) days.push(d);
  const months: { d: number; n: number }[] = [];
  for (const d of days) {
    const m = monthLabel(d);
    if (!months.length || monthLabel(months[months.length - 1].d) !== m) months.push({ d, n: 1 });
    else months[months.length - 1].n++;
  }

  const barStyle = (s: number | null, f: number | null) => (s === null || f === null ? { display: 'none' } : { left: x(s), width: Math.max(2, (f - s) * W - 1) });

  const actBar = (a: any, compact: boolean, unitLabel: string) => {
    if (!visibleAct(a)) return <div key={a.id} className="bar ghost" style={barStyle(a.forecastStart, a.forecastFinish)} />;
    const isDrag = drag?.a.id === a.id;
    const dx = isDrag ? drag!.dx : 0;
    const cls = [
      'bar', `st-${a.status}`, a.isCritical ? 'critical' : '', a.delayed ? 'delayed' : '', a.rescheduled ? 'rescheduled' : '',
      model.overloaded.has(a.id) ? 'overload' : '', a.locked ? 'locked' : '', compact ? 'compact' : '', isDrag ? 'dragging' : '',
    ].join(' ');
    const title = [
      `${unitLabel} · ${a.name} (${STATUS_LABEL[a.status]})`,
      `Forecast ${slotLabel(a.forecastStart)} → ${finishLabel(a.forecastFinish)}`,
      `Approved ${slotLabel(a.approvedStart)} → ${finishLabel(a.approvedFinish)}`,
      a.baselineStart !== a.approvedStart ? `Baseline ${slotLabel(a.baselineStart)} → ${finishLabel(a.baselineFinish)}` : '',
      a.actualStart ? `Actual ${slotLabel(a.actualStart)} → ${a.actualFinish ? finishLabel(a.actualFinish) : '…'}` : '',
      a.delayed ? `Delay +${a.delaySlots / 2} wd: ${a.lastEvent?.reason ?? a.delayReason ?? 'propagated'}` : '',
      a.rescheduled ? 'Approved rescheduling (differs from baseline)' : '',
      a.blocker ? `Blocker: ${a.blocker}` : '', a.weekendWork ? 'Weekend work authorized' : '',
      model.overloaded.has(a.id) ? 'CAPACITY CONFLICT' : '', a.isCritical ? 'On driving path' : '',
    ].filter(Boolean).join('\n');
    const movable = canMove && !compact && ['NOT_STARTED', 'READY', 'BLOCKED'].includes(a.status) && a.kind === 'work';
    const actualW = a.actualStart !== null ? ((a.actualFinish ?? Math.min(data.now + 1, a.forecastFinish)) - a.actualStart) * W : 0;
    const delayLeft = a.delayed ? x(Math.max(a.approvedFinish, a.forecastStart)) : 0;
    return (
      <div key={a.id}>
        {showBaseline && !compact && a.baselineStart !== null && <div className="baseline" style={barStyle(a.baselineStart, a.baselineFinish)} />}
        {!compact && a.approvedStart !== null && (a.approvedStart !== a.forecastStart || a.approvedFinish !== a.forecastFinish) && <div className="approved-box" style={barStyle(a.approvedStart, a.approvedFinish)} />}
        <div className={cls} title={title}
          style={{ ...barStyle(a.forecastStart, a.forecastFinish), transform: dx ? `translateX(${dx}px)` : undefined, background: FN_COLORS[a.function] }}
          onMouseDown={(e) => { if (!movable) return; e.preventDefault(); setDrag({ a, startX: e.clientX, dx: 0 }); }}
          onClick={(e) => { if (drag) return; e.stopPropagation(); setPanel({ id: a.id, unit: unitLabel }); }}>
          {actualW > 0 && <div className="actual" style={{ width: Math.max(2, actualW - 1), marginLeft: (a.actualStart - a.forecastStart) * W }} />}
          {!compact && zoom >= 10 && <span className="bar-label">{a.code}{a.status === 'BLOCKED' ? ' ⛔' : ''}{a.weekendWork ? ' ★' : ''}{a.locked ? ' 🔒' : ''}</span>}
        </div>
        {a.delayed && <div className="delay-ext" title={title} style={{ left: delayLeft, width: Math.max(2, x(a.forecastFinish) - delayLeft - 1) }} />}
      </div>
    );
  };

  const msMarkers = (p: any) => p.milestones.map((m: any) => {
    const f = m.actual ?? m.forecast;
    if (f === null) return null;
    return (
      <div key={m.type}>
        {m.latestApproved !== null && m.latestApproved !== f && <div className="ms-diamond approved" style={{ left: x(m.latestApproved) - 6 }} title={`${m.label} committed ${m.latestApprovedLabel}`} />}
        <div className={`ms-diamond risk-${m.risk}`} style={{ left: x(f) - 7 }} onClick={(e) => { e.stopPropagation(); setChain({ projectId: p.id, type: m.type }); }}
          title={`${m.label}\nForecast ${m.forecastLabel}${m.actualLabel ? `\nActual ${m.actualLabel}` : ''}\nCommitted ${m.latestApprovedLabel} (orig ${m.originalCommittedLabel})\nVariance ${m.varianceDays} wd${m.delay ? `\nCause: ${m.delay.reason}` : ''}\nClick: show driving chain`}>
          <span>{MS_ICON[m.type]}</span>
        </div>
      </div>
    );
  });

  // dependency arrows between visible activity rows
  const actRowTop = new Map<number, number>();
  for (const r of rows) if (r.kind === 'act') actRowTop.set(r.a.id, top.get(r.key)!);
  const arrows: React.JSX.Element[] = [];
  for (const d of data.dependencies) {
    const y1 = actRowTop.get(d.pred);
    const y2 = actRowTop.get(d.succ);
    if (y1 === undefined || y2 === undefined) continue;
    const pa = data.activities.find((a: any) => a.id === d.pred);
    const sa = data.activities.find((a: any) => a.id === d.succ);
    const x1 = x(pa.forecastFinish);
    const x2 = x(sa.forecastStart);
    const yy1 = y1 + H.act / 2;
    const yy2 = y2 + H.act / 2;
    const mid = Math.max(x1 + 4, x2 - 6);
    const crit = pa.isCritical && sa.isCritical;
    arrows.push(<path key={`${d.pred}-${d.succ}`} className={crit ? 'dep crit' : 'dep'} d={`M${x1},${yy1} H${mid} V${yy2} H${x2 - 1}`} markerEnd={crit ? 'url(#arrC)' : 'url(#arr)'} />);
  }

  const onMouseMove = (e: React.MouseEvent) => { if (drag) setDrag({ ...drag, dx: e.clientX - drag.startX }); };
  const onMouseUp = () => {
    if (!drag) return;
    const delta = Math.round(drag.dx / W);
    const a = drag.a;
    setTimeout(() => setDrag(null), 0);
    if (delta !== 0) {
      const unit = data.units.find((u: any) => u.id === a.unitId)?.serial ?? 'Shipment';
      setMove({ a, start: a.forecastStart + delta, unit });
    }
  };
  const fnToggle = (f: string) => setFnFilter((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });
  const scrollToday = () => scroller.current?.scrollTo({ left: x(data.now) - 300, behavior: 'smooth' });

  return (
    <div className="page gantt-page">
      <div className="toolbar">
        <h2>Gantt</h2>
        <button className="secondary small" onClick={() => setExpanded(new Set(data.projects.map((p: any) => `p${p.id}`)))}>Expand projects</button>
        <button className="secondary small" onClick={() => setExpanded(new Set([...data.projects.map((p: any) => `p${p.id}`), ...data.units.map((u: any) => `u${u.id}`)]))}>Expand all</button>
        <button className="secondary small" onClick={() => setExpanded(new Set())}>Collapse</button>
        <span className="sep" />
        {Object.keys(FN_COLORS).map((f) => (
          <button key={f} className={`chip ${fnFilter.has(f) ? 'on' : ''}`} style={{ borderColor: FN_COLORS[f] }} onClick={() => fnToggle(f)}>
            <span className="dot" style={{ background: FN_COLORS[f] }} />{FN_LABEL[f]}
          </button>
        ))}
        <label className="check"><input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} /> Driving path</label>
        <label className="check"><input type="checkbox" checked={delaysOnly} onChange={(e) => setDelaysOnly(e.target.checked)} /> Delays/blocked</label>
        <label className="check"><input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Baseline</label>
        <div className="spacer" />
        <button className="secondary small" onClick={scrollToday}>Today</button>
        <span className="muted small">Zoom</span>
        <input type="range" min={5} max={32} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        <span className="muted small">v{version || data.version}</span>
      </div>
      <div className="legend small">
        <span><i className="lg forecast" /> forecast</span><span><i className="lg actual" /> actual</span><span><i className="lg approved" /> approved (when different)</span>
        <span><i className="lg baseline" /> baseline</span><span><i className="lg delay" /> delay vs approved</span><span><i className="lg resched" /> approved rescheduling</span>
        <span><i className="lg crit" /> driving path</span><span><i className="lg over" /> capacity conflict</span><span>◆ E/X/C milestones (click = cause chain)</span>
        <span>★ weekend work</span>{canMove && <span>Drag bars to reschedule (simulated before commit)</span>}
      </div>
      <div className="gantt" ref={scroller} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <div className="g-inner" style={{ width: width + 300 }}>
          <div className="g-head">
            <div className="g-label head-label">Project / unit / activity</div>
            <div className="g-time" style={{ width }}>
              <div className="g-months">{months.map((m) => <div key={m.d} style={{ left: x(m.d * 2), width: m.n * 2 * W }}>{monthLabel(m.d)}</div>)}</div>
              <div className="g-days">{days.map((d) => (
                <div key={d} className={`${model.nonWorking.has(d) ? 'nw' : ''} ${d === dayOf(data.now) ? 'today' : ''}`} style={{ left: x(d * 2), width: 2 * W }} title={fmtDay(d, true)}>
                  {W * 2 >= 18 ? new Date(d * 86400000).getUTCDate() : (new Date(d * 86400000).getUTCDay() === 1 ? `W${weekNo(d)}` : '')}
                </div>
              ))}</div>
            </div>
          </div>
          <div className="g-body" style={{ height: totalH }}>
            <div className="g-bg" style={{ left: 300, width, height: totalH }}>
              {days.filter((d) => model.nonWorking.has(d)).map((d) => <div key={d} className="nw-col" style={{ left: x(d * 2), width: 2 * W }} />)}
              {data.weekendAuthorizations.map((w: any) => <div key={w.id} className="wk-col" title={`Weekend work authorized: ${w.workCenter ?? w.activity} — ${w.reason}`} style={{ left: x(isoToDay(w.date) * 2), width: 2 * W }} />)}
              <div className="today-line" style={{ left: x(data.now) }} title={`Now: ${slotLabel(data.now)}`} />
            </div>
            <svg className="g-deps" style={{ left: 300, width, height: totalH }}>
              <defs>
                <marker id="arr" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#7b8794" /></marker>
                <marker id="arrC" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#e8590c" /></marker>
              </defs>
              {arrows}
            </svg>
            {rows.map((r) => (
              <div key={r.key} className={`g-row ${r.kind}`} style={{ height: r.h }}>
                <div className="g-label" onClick={() => (r.kind === 'project' ? toggle(r.key) : r.kind === 'unit' ? toggle(r.key) : r.kind === 'act' ? setPanel({ id: r.a.id, unit: r.unitLabel }) : null)}>
                  {r.kind === 'project' && <>
                    <span className="caret">{expanded.has(r.key) ? '▾' : '▸'}</span><b className="prio">{r.p.priority}</b><b>{r.p.code}</b>
                    <span className="lbl-name">{r.p.name}</span>
                    <RiskBadge risk={r.p.risk} />{r.p.freeze.frozen && <span className="frozen" title={`Frozen since ${r.p.freeze.freezeStartDate}`}>❄</span>}
                  </>}
                  {r.kind === 'unit' && <><span className="caret ind1">{expanded.has(r.key) ? '▾' : '▸'}</span><span>{r.u.serial}</span><span className="muted small">{r.u.productName}</span>
                    {r.acts.some((a: any) => a.status === 'BLOCKED') && <span className="tag-red small">blocked</span>}</>}
                  {r.kind === 'ship' && <span className="ind1 muted">🚚 Consolidated shipment</span>}
                  {r.kind === 'act' && <span className={`ind2 ${!visibleAct(r.a) ? 'dim' : ''}`}><i className="dot" style={{ background: FN_COLORS[r.a.function] }} />{r.a.name}{r.a.status === 'BLOCKED' ? ' ⛔' : ''}</span>}
                </div>
                <div className="g-track" style={{ width }}>
                  {r.kind === 'project' && (() => {
                    const acts = model.byProject.get(r.p.id) ?? [];
                    const s = Math.min(...acts.map((a: any) => a.actualStart ?? a.forecastStart));
                    const f = Math.max(...acts.map((a: any) => a.forecastFinish));
                    const exw = r.p.milestones.find((m: any) => m.type === 'EXW');
                    const fz = r.p.freeze.freezeStartDate ? isoToDay(r.p.freeze.freezeStartDate) * 2 : null;
                    return <>
                      {fz !== null && exw?.forecast && <div className="freeze-band" style={{ left: x(fz), width: Math.max(0, x(exw.forecast) - x(fz)) }} title={`21-day freeze window ${r.p.freeze.freezeStartDate} → ExWorks ${r.p.freeze.exworksDate}`} />}
                      <div className="proj-bar" style={barStyle(s, f)} />
                      {r.p.requiredDate && <div className="req-line" style={{ left: x((isoToDay(r.p.requiredDate) + 1) * 2) }} title={`Customer required commissioning ${r.p.requiredDate}`} />}
                      {msMarkers(r.p)}
                    </>;
                  })()}
                  {r.kind === 'unit' && r.acts.map((a: any) => actBar(a, true, r.u.serial))}
                  {r.kind === 'ship' && r.acts.map((a: any) => actBar(a, true, data.units.find((u: any) => u.id === a.unitId)?.serial ?? 'Shipment'))}
                  {r.kind === 'act' && actBar(r.a, false, r.unitLabel)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {panel && <ActivityPanel id={panel.id} unitLabel={panel.unit} onClose={() => setPanel(null)} />}
      {chain && <MilestoneChain {...chain} onClose={() => setChain(null)} onActivity={(id) => { setChain(null); setPanel({ id, unit: data.units.find((u: any) => u.id === data.activities.find((a: any) => a.id === id)?.unitId)?.serial ?? '' }); }} />}
      {move && (
        <Modal wide title={`Reschedule ${move.unit} · ${move.a.name}: ${slotLabel(move.a.forecastStart)} → ${slotLabel(move.start)}`} onClose={() => setMove(null)}>
          <ChangeFlow name={`Gantt move: ${move.unit} ${move.a.name} → ${slotLabel(move.start)}`} source="GANTT" ops={[{ type: 'move_activity', activityId: move.a.id, start: move.start }]} onDone={() => setMove(null)} />
        </Modal>
      )}
    </div>
  );
}
