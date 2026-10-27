import { CalendarSet, dayOf, type Slot } from './calendar.js';
import type { ActResult, ActivityDef, PlanState, ScheduleResult, WorkCenterDef } from './types.js';

export type ChangeKind = 'root' | 'propagated' | 'capacity' | 'improvement';

export interface ActivityChange {
  activityId: number;
  projectId: number;
  prevStart: Slot | null;
  prevFinish: Slot | null;
  newStart: Slot;
  newFinish: Slot;
  kind: ChangeKind;
  /** Activity whose delay originated this change (itself for root changes). */
  originActivityId: number;
  /** Projects whose activities displaced this one (capacity contention). */
  displacedBy: number[];
}

/**
 * Compare a new schedule with previously persisted forecasts and attribute each change
 * to its originating cause by following the driving constraint of every activity.
 */
export function attributeChanges(
  state: PlanState,
  result: ScheduleResult,
  prev: Map<number, { start: Slot | null; finish: Slot | null }>,
): ActivityChange[] {
  const byId = new Map(state.activities.map((a) => [a.id, a]));
  const changed = new Map<number, ActivityChange>();
  const order = [...result.acts.values()].sort((a, b) => a.start - b.start || a.finish - b.finish);
  const delayed = (id: number) => {
    const r = result.acts.get(id);
    const p = prev.get(id);
    return !!(r && p && p.finish !== null && r.finish > p.finish);
  };
  const memo = new Map<number, number>();
  const originOf = (id: number, guard = 0): number => {
    if (memo.has(id)) return memo.get(id)!;
    const r = result.acts.get(id);
    const a = byId.get(id);
    if (!r || !a || guard > 500) return id;
    let o = id;
    if (r.driver.type === 'predecessor' && delayed(r.driver.ref)) o = originOf(r.driver.ref, guard + 1);
    else if (r.driver.type === 'capacity') {
      const latePred = a.preds.find((pp) => delayed(pp.id));
      const lateBlocker = r.driver.blockers.find((b) => b !== id && delayed(b));
      if (latePred) o = originOf(latePred.id, guard + 1);
      else if (lateBlocker !== undefined) o = originOf(lateBlocker, guard + 1);
    }
    memo.set(id, o);
    return o;
  };
  for (const r of order) {
    const p = prev.get(r.id);
    const a = byId.get(r.id);
    if (!a || !p || p.finish === null) continue;
    if (p.start === r.start && p.finish === r.finish) continue;
    const later = r.finish > p.finish;
    let kind: ChangeKind = later ? 'root' : 'improvement';
    let origin = r.id;
    let displacedBy: number[] = [];
    if (later) {
      if (r.driver.type === 'predecessor' && delayed(r.driver.ref)) {
        kind = 'propagated';
        origin = originOf(r.driver.ref);
      } else if (r.driver.type === 'capacity') {
        kind = 'capacity';
        const blockers = r.driver.blockers.map((b) => byId.get(b)).filter((x): x is ActivityDef => !!x);
        displacedBy = [...new Set(blockers.map((b) => b.projectId))];
        origin = originOf(r.id);
        // A delayed technical predecessor is the more direct cause when present.
        if (a.preds.some((pp) => delayed(pp.id))) kind = 'propagated';
      }
    }
    changed.set(r.id, {
      activityId: r.id, projectId: a.projectId, prevStart: p.start, prevFinish: p.finish,
      newStart: r.start, newFinish: r.finish, kind, originActivityId: origin, displacedBy,
    });
  }
  return [...changed.values()];
}

export interface UtilizationRow {
  workCenterId: number;
  day: number;
  load: number; // capacity-unit half-days booked
  capacity: number; // capacity-unit half-days available
  peak: number;
  overloaded: boolean;
}

export function dailyUtilization(state: PlanState, result: ScheduleResult, fromDay: number, toDay: number): UtilizationRow[] {
  const rows: UtilizationRow[] = [];
  const cal = new CalendarSet(state.calendars, state.defaultCalendarId);
  for (const w of state.workCenters) {
    for (let d = fromDay; d <= toDay; d++) {
      let load = 0;
      let cap = 0;
      let peak = 0;
      let overloaded = false;
      const baseWorking = cal.isWorkingDay(w.calendarId ?? state.defaultCalendarId, d);
      for (let s = d * 2; s < d * 2 + 2; s++) {
        const c = result.ledger.cell(w.id, s);
        const l = c?.load ?? 0;
        load += l;
        peak = Math.max(peak, l);
        const slotCap = result.ledger.capacityAt(w.id, s);
        if (baseWorking || l > 0) cap += slotCap;
        if (l > slotCap + 1e-6 || (c?.acts.length ?? 0) > w.maxConcurrent) overloaded = true;
      }
      rows.push({ workCenterId: w.id, day: d, load: round2(load), capacity: round2(cap), peak: round2(peak), overloaded });
    }
  }
  return rows;
}

export interface BottleneckRow {
  workCenterId: number;
  code: string;
  name: string;
  capacity: number;
  avgDurationDays: number;
  throughputPerDay: number; // systems / working day at nominal capacity
  downstreamCode: string | null;
  downstreamThroughput: number | null;
  requiredCapacityToFeedDownstream: number | null;
  additionalCapacityNeeded: number;
  isProgramBottleneck: boolean;
  starvesDownstream: boolean;
  capacityWaitDays: number; // total queueing caused in the current plan
  delayedActivities: number;
  utilizationNext20d: number;
}

/**
 * Nominal throughput per work center from the routing mix in the plan, comparison of each
 * work center with the one that immediately follows it in the routing, and capacity queueing
 * observed in the actual schedule.
 */
export function bottleneckAnalysis(state: PlanState, result: ScheduleResult, routeOrder: number[]): BottleneckRow[] {
  const byWc = new Map<number, ActivityDef[]>();
  for (const a of state.activities) {
    if (!a.workCenterId || a.kind !== 'work' || a.status === 'CANCELLED') continue;
    let l = byWc.get(a.workCenterId);
    if (!l) byWc.set(a.workCenterId, (l = []));
    l.push(a);
  }
  const wcs = routeOrder.map((id) => state.workCenters.find((w) => w.id === id)).filter((w): w is WorkCenterDef => !!w);
  const tp = (w: WorkCenterDef) => {
    const list = byWc.get(w.id) ?? [];
    const avgSlots = list.length ? list.reduce((s, a) => s + a.durationSlots, 0) / list.length : 1;
    return { avgDays: avgSlots / 2, throughput: (w.capacity * 2) / avgSlots };
  };
  const stats = wcs.map((w) => ({ w, ...tp(w) }));
  const minTp = Math.min(...stats.map((s) => s.throughput));
  const now = state.now;
  return stats.map((s, i) => {
    const next = stats[i + 1];
    const list = byWc.get(s.w.id) ?? [];
    let wait = 0;
    let delayedActs = 0;
    for (const a of list) {
      const r = result.acts.get(a.id);
      if (r && r.capacityWaitSlots > 0) {
        wait += r.capacityWaitSlots;
        delayedActs++;
      }
    }
    let booked = 0;
    let avail = 0;
    for (let sl = now; sl < now + 40; sl++) {
      booked += result.ledger.cell(s.w.id, sl)?.load ?? 0;
      avail += result.ledger.capacityAt(s.w.id, sl);
    }
    const required = next ? round2((next.throughput * s.avgDays)) : null;
    const starves = !!next && s.throughput + 1e-6 < next.throughput;
    return {
      workCenterId: s.w.id,
      code: s.w.code,
      name: s.w.name,
      capacity: s.w.capacity,
      avgDurationDays: round2(s.avgDays),
      throughputPerDay: round2(s.throughput),
      downstreamCode: next?.w.code ?? null,
      downstreamThroughput: next ? round2(next.throughput) : null,
      requiredCapacityToFeedDownstream: required,
      additionalCapacityNeeded: required !== null ? Math.max(0, round2(required - s.w.capacity)) : 0,
      isProgramBottleneck: Math.abs(s.throughput - minTp) < 1e-6,
      starvesDownstream: starves,
      capacityWaitDays: wait / 2,
      delayedActivities: delayedActs,
      utilizationNext20d: avail ? round2(booked / (avail / 2) / 2) : 0,
    };
  });
}

/** Activities whose bookings overlap a given set of work-center slots (for conflict listings). */
export function conflictsByProject(state: PlanState, result: ScheduleResult) {
  const byId = new Map(state.activities.map((a) => [a.id, a]));
  const out: { activityId: number; projectId: number; workCenterId: number; waitDays: number; blockingProjects: number[] }[] = [];
  for (const r of result.acts.values()) {
    if (r.driver.type !== 'capacity' || r.start < state.now) continue;
    const a = byId.get(r.id)!;
    const blockingProjects = [...new Set(r.driver.blockers.map((b) => byId.get(b)?.projectId).filter((x): x is number => x !== undefined && x !== a.projectId))];
    out.push({ activityId: r.id, projectId: a.projectId, workCenterId: r.driver.workCenterId, waitDays: r.capacityWaitSlots / 2, blockingProjects });
  }
  return out;
}

export function round2(x: number) {
  return Math.round(x * 100) / 100;
}

export function resultFor(result: ScheduleResult, id: number): ActResult | undefined {
  return result.acts.get(id);
}

export { dayOf };
