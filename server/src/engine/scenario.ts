import { dayNumber, type Slot } from './calendar.js';
import { forwardSchedule, planBackward } from './scheduler.js';
import type { MilestoneType, PlanState, ScheduleResult } from './types.js';

export type ScenarioOp =
  | { type: 'set_priority'; order: number[] }
  | { type: 'move_priority'; projectId: number; toRank: number }
  | { type: 'move_activity'; activityId: number; start: Slot; pullInSuccessors?: boolean }
  | { type: 'set_capacity'; workCenterId: number; capacity: number; maxConcurrent?: number }
  | { type: 'weekend_work'; workCenterId?: number | null; activityId?: number | null; date: string; capacity?: number | null }
  | { type: 'set_duration'; activityId: number; durationSlots: number }
  | { type: 'pull_in'; projectId: number }
  | { type: 'replan_backward'; projectId: number };

export function cloneState(s: PlanState): PlanState {
  return structuredClone(s);
}

export function priorityOrder(state: PlanState): number[] {
  return [...state.projects].sort((a, b) => a.priority - b.priority || a.id - b.id).map((p) => p.id);
}

/** Apply scenario operations to a copy of the plan state. Pure. */
export function applyOps(base: PlanState, ops: ScenarioOp[]): PlanState {
  const s = cloneState(base);
  const act = (id: number) => {
    const a = s.activities.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown activity ${id}`);
    return a;
  };
  const setOrder = (order: number[]) => {
    const rest = priorityOrder(s).filter((id) => !order.includes(id));
    [...order, ...rest].forEach((id, i) => {
      const p = s.projects.find((x) => x.id === id);
      if (!p) return;
      // A project moved up in the ranking may claim scarce capacity earlier: its approved-start
      // floors are released so the re-prioritization changes the plan, not just the row order.
      if (i + 1 < p.priority && !s.pullIn.includes(p.id)) s.pullIn.push(p.id);
      p.priority = i + 1;
    });
  };
  for (const op of ops) {
    switch (op.type) {
      case 'set_priority':
        setOrder(op.order);
        break;
      case 'move_priority': {
        const order = priorityOrder(s).filter((id) => id !== op.projectId);
        order.splice(Math.max(0, Math.min(order.length, op.toRank - 1)), 0, op.projectId);
        setOrder(order);
        break;
      }
      case 'move_activity': {
        const a = act(op.activityId);
        if (a.status === 'COMPLETED' || a.status === 'IN_PROGRESS') throw new Error('Started or completed activities cannot be moved; record actuals instead');
        a.approvedStart = op.start;
        a.locked = true;
        if (!s.pinned.includes(a.id)) s.pinned.push(a.id);
        if (op.pullInSuccessors) {
          // Successor floors are relaxed so the chain follows the moved activity.
          const succ = downstreamOf(s, a.id);
          for (const sid of succ) {
            const x = act(sid);
            if (x.status === 'NOT_STARTED' || x.status === 'READY') x.approvedStart = null;
          }
        }
        break;
      }
      case 'set_capacity': {
        const w = s.workCenters.find((x) => x.id === op.workCenterId);
        if (!w) throw new Error(`Unknown work center ${op.workCenterId}`);
        if (!(op.capacity > 0)) throw new Error('Capacity must be positive');
        w.capacity = op.capacity;
        if (op.maxConcurrent !== undefined) w.maxConcurrent = op.maxConcurrent;
        else w.maxConcurrent = Math.max(w.maxConcurrent, Math.ceil(op.capacity - 1e-9));
        break;
      }
      case 'weekend_work':
        s.weekendAuths.push({ workCenterId: op.workCenterId ?? null, activityId: op.activityId ?? null, day: dayNumber(op.date), capacity: op.capacity ?? null });
        break;
      case 'set_duration': {
        const a = act(op.activityId);
        if (!(op.durationSlots >= 0)) throw new Error('Duration must be ≥ 0');
        a.durationSlots = op.durationSlots;
        break;
      }
      case 'pull_in':
        if (!s.pullIn.includes(op.projectId)) s.pullIn.push(op.projectId);
        break;
      case 'replan_backward': {
        const own = s.activities.filter((a) => a.projectId === op.projectId);
        if (own.some((a) => a.status === 'COMPLETED' || a.status === 'IN_PROGRESS')) throw new Error('Backward re-planning is only possible before execution starts');
        for (const a of own) {
          a.approvedStart = null;
          a.locked = false;
        }
        const plan = planBackward(s, op.projectId);
        if (plan.feasible) for (const a of own) a.approvedStart = plan.starts.get(a.id) ?? null;
        else if (!s.pullIn.includes(op.projectId)) s.pullIn.push(op.projectId);
        break;
      }
    }
  }
  return s;
}

export function downstreamOf(s: PlanState, id: number): Set<number> {
  const succ = new Map<number, number[]>();
  for (const a of s.activities) for (const p of a.preds) {
    let l = succ.get(p.id);
    if (!l) succ.set(p.id, (l = []));
    l.push(a.id);
  }
  const out = new Set<number>();
  const stack = [...(succ.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (out.has(x)) continue;
    out.add(x);
    stack.push(...(succ.get(x) ?? []));
  }
  return out;
}

export interface MilestoneDelta {
  projectId: number;
  type: MilestoneType;
  before: Slot | null;
  after: Slot | null;
  deltaSlots: number;
}

export interface ScenarioComparison {
  changedActivities: { activityId: number; projectId: number; beforeStart: Slot; afterStart: Slot; beforeFinish: Slot; afterFinish: Slot }[];
  milestoneDeltas: MilestoneDelta[];
  impactedProjects: number[];
  delayedProjects: number[];
  improvedProjects: number[];
  capacityShifts: { workCenterId: number; projectId: number; beforeSlots: number; afterSlots: number }[];
  displaced: { activityId: number; projectId: number; byProjects: number[]; delaySlots: number }[];
  priorityChanges: { projectId: number; before: number; after: number }[];
}

export function compareSchedules(beforeState: PlanState, before: ScheduleResult, afterState: PlanState, after: ScheduleResult): ScenarioComparison {
  const byId = new Map(afterState.activities.map((a) => [a.id, a]));
  const changedActivities: ScenarioComparison['changedActivities'] = [];
  const displaced: ScenarioComparison['displaced'] = [];
  const impacted = new Set<number>();
  for (const [id, a] of after.acts) {
    const b = before.acts.get(id);
    if (!b) continue;
    if (a.start !== b.start || a.finish !== b.finish) {
      const pid = byId.get(id)!.projectId;
      changedActivities.push({ activityId: id, projectId: pid, beforeStart: b.start, afterStart: a.start, beforeFinish: b.finish, afterFinish: a.finish });
      impacted.add(pid);
      if (a.finish > b.finish && a.driver.type === 'capacity') {
        const by = [...new Set(a.driver.blockers.map((x) => byId.get(x)?.projectId).filter((x): x is number => x !== undefined && x !== pid))];
        displaced.push({ activityId: id, projectId: pid, byProjects: by, delaySlots: a.finish - b.finish });
      }
    }
  }
  const key = (m: { projectId: number; type: string; shipmentId: number | null }) => `${m.projectId}:${m.type}:${m.shipmentId ?? ''}`;
  const bm = new Map(before.milestones.map((m) => [key(m), m]));
  const milestoneDeltas: MilestoneDelta[] = [];
  const delayed = new Set<number>();
  const improved = new Set<number>();
  for (const m of after.milestones) {
    if (m.shipmentId !== null) continue;
    const b = bm.get(key(m));
    const d = (m.forecast ?? 0) - (b?.forecast ?? 0);
    if (d !== 0) {
      milestoneDeltas.push({ projectId: m.projectId, type: m.type, before: b?.forecast ?? null, after: m.forecast, deltaSlots: d });
      (d > 0 ? delayed : improved).add(m.projectId);
    }
  }
  const prioBefore = new Map(beforeState.projects.map((p) => [p.id, p.priority]));
  const priorityChanges = afterState.projects
    .filter((p) => prioBefore.get(p.id) !== p.priority)
    .map((p) => ({ projectId: p.id, before: prioBefore.get(p.id)!, after: p.priority }));
  for (const pc of priorityChanges) impacted.add(pc.projectId);

  const usage = (st: PlanState, r: ScheduleResult) => {
    const m = new Map<string, number>();
    const ids = new Map(st.activities.map((a) => [a.id, a]));
    for (const x of r.acts.values()) {
      const a = ids.get(x.id);
      if (!a?.workCenterId) continue;
      const k = `${a.workCenterId}:${a.projectId}`;
      m.set(k, (m.get(k) ?? 0) + x.bookings.filter(([s]) => s >= st.now && s < st.now + 40).length);
    }
    return m;
  };
  const ub = usage(beforeState, before);
  const ua = usage(afterState, after);
  const capacityShifts: ScenarioComparison['capacityShifts'] = [];
  for (const k of new Set([...ub.keys(), ...ua.keys()])) {
    const b = ub.get(k) ?? 0;
    const a = ua.get(k) ?? 0;
    if (a !== b) {
      const [wc, pid] = k.split(':').map(Number);
      capacityShifts.push({ workCenterId: wc, projectId: pid, beforeSlots: b, afterSlots: a });
    }
  }
  return {
    changedActivities, milestoneDeltas, impactedProjects: [...impacted], delayedProjects: [...delayed],
    improvedProjects: [...improved], capacityShifts, displaced, priorityChanges,
  };
}

export function simulate(base: PlanState, ops: ScenarioOp[]) {
  const before = forwardSchedule(base);
  const afterState = applyOps(base, ops);
  const after = forwardSchedule(afterState);
  return { before, afterState, after, comparison: compareSchedules(base, before, afterState, after) };
}
