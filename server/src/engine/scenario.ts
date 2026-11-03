import { dayNumber, type Slot } from './calendar.js';
import { forwardSchedule, planBackward } from './scheduler.js';
import type { MilestoneType, PlanState, ScheduleResult } from './types.js';

/** Operations evaluated purely on the plan state. */
export type PureOp =
  | { type: 'set_priority'; order: number[] }
  | { type: 'move_priority'; projectId: number; toRank: number }
  | { type: 'move_activity'; activityId: number; start: Slot; pullInSuccessors?: boolean }
  | { type: 'set_capacity'; workCenterId: number; capacity: number; maxConcurrent?: number; fromDate?: string | null }
  | { type: 'include_capacity_change'; changeId: number; workCenterId: number; capacity: number; fromDate: string }
  | { type: 'weekend_work'; workCenterId?: number | null; activityId?: number | null; date: string; capacity?: number | null }
  | { type: 'set_duration'; activityId: number; durationSlots: number }
  | { type: 'apply_test_plan'; testPlanId: number; activityIds: number[]; durationSlots?: number }
  | { type: 'add_reservation'; workCenterId: number; start: Slot; finish: Slot; units: number; kind: string; reason?: string }
  | { type: 'pull_in'; projectId: number }
  | { type: 'replan_backward'; projectId: number };

/**
 * Structural operations change the plan graph (units, systems, shipments, activities). They are
 * applied to the database inside a savepoint before simulation, so the simulated and committed
 * plans are produced by exactly the same code.
 */
export type StructuralOp =
  | { type: 'reassign_unit'; unitId: number; toProjectId: number; replacesUnitId?: number | null; reason?: string }
  | { type: 'add_rework'; reworkId: number }
  | { type: 'apply_configuration'; configurationId: number }
  | { type: 'regroup_units'; unitIds: number[]; toShipmentId?: number | null; newShipment?: { code: string; serviceProfileId?: number | null } | null }
  | { type: 'add_update_operation'; releaseId: number; unitIds: number[]; beforeCode?: string; durationSlots?: number; retest?: boolean }
  | { type: 'commit_demand'; projectId: number }
  | { type: 'split_visit'; systemIds: number[]; visitCode?: string };

export type ScenarioOp = PureOp | StructuralOp;

export const STRUCTURAL_OPS = new Set<ScenarioOp['type']>(['reassign_unit', 'add_rework', 'apply_configuration', 'regroup_units', 'add_update_operation', 'commit_demand', 'split_visit']);

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
        if (!w) throw new Error(`Unknown resource ${op.workCenterId}`);
        if (!(op.capacity > 0)) throw new Error('Capacity must be positive');
        if (op.fromDate) {
          s.capacityChanges = [...(s.capacityChanges ?? []), { resourceId: w.id, fromDay: dayNumber(op.fromDate), capacity: op.capacity }];
        } else {
          w.capacity = op.capacity;
          // An immediate change replaces any effective-dated values.
          s.capacityChanges = (s.capacityChanges ?? []).filter((c) => c.resourceId !== w.id);
        }
        break;
      }
      case 'include_capacity_change':
        s.capacityChanges = [...(s.capacityChanges ?? []), { resourceId: op.workCenterId, fromDay: dayNumber(op.fromDate), capacity: op.capacity }];
        break;
      case 'add_reservation':
        if (!(op.finish > op.start)) throw new Error('Reservation must end after it starts');
        s.reservations = [...(s.reservations ?? []), { id: 900000 + (s.reservations?.length ?? 0), resourceId: op.workCenterId, start: op.start, finish: op.finish, units: op.units, kind: op.kind }];
        break;
      case 'apply_test_plan':
        for (const id of op.activityIds) setDuration(act(id), op.durationSlots ?? act(id).durationSlots);
        break;
      case 'weekend_work':
        s.weekendAuths.push({ workCenterId: op.workCenterId ?? null, activityId: op.activityId ?? null, day: dayNumber(op.date), capacity: op.capacity ?? null });
        break;
      case 'set_duration': {
        const a = act(op.activityId);
        if (!(op.durationSlots >= 0)) throw new Error('Duration must be ≥ 0');
        setDuration(a, op.durationSlots);
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
      default:
        // Structural operations were applied to the persisted graph before simulation.
        break;
    }
  }
  return s;
}

/** Change an activity's duration; for multi-phase profiles the longest phase absorbs the change. */
export function setDuration(a: PlanState['activities'][number], slots: number) {
  if (a.phases && a.phases.length) {
    const total = a.phases.reduce((t, p) => t + p.slots, 0);
    const main = a.phases.reduce((m, p) => (p.slots > m.slots ? p : m), a.phases[0]);
    const delta = slots - total;
    if (main.slots + delta < 0) throw new Error('Duration shorter than the fixed phases of this activity');
    a.phases = a.phases.map((p) => (p === main ? { ...p, slots: p.slots + delta } : p));
  }
  a.durationSlots = slots;
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
  addedActivities: { activityId: number; projectId: number; start: Slot; finish: Slot }[];
  removedActivities: { activityId: number; projectId: number }[];
  confidenceChanges: { projectId: number; type: MilestoneType; before: string; after: string }[];
}

export function compareSchedules(beforeState: PlanState, before: ScheduleResult, afterState: PlanState, after: ScheduleResult): ScenarioComparison {
  const byId = new Map(afterState.activities.map((a) => [a.id, a]));
  const changedActivities: ScenarioComparison['changedActivities'] = [];
  const displaced: ScenarioComparison['displaced'] = [];
  const impacted = new Set<number>();
  const addedActivities: ScenarioComparison['addedActivities'] = [];
  const removedActivities: ScenarioComparison['removedActivities'] = [];
  const beforeById = new Map(beforeState.activities.map((a) => [a.id, a]));
  for (const [id, a] of after.acts) {
    const b = before.acts.get(id);
    if (!b) {
      const pid = byId.get(id)!.projectId;
      addedActivities.push({ activityId: id, projectId: pid, start: a.start, finish: a.finish });
      impacted.add(pid);
      continue;
    }
    const wasCancelled = beforeById.get(id)?.status === 'CANCELLED';
    const nowCancelled = byId.get(id)?.status === 'CANCELLED';
    if (wasCancelled !== nowCancelled) {
      const pid = byId.get(id)!.projectId;
      removedActivities.push({ activityId: id, projectId: pid });
      impacted.add(pid);
    }
    if (byId.get(id)!.projectId !== beforeById.get(id)?.projectId) {
      impacted.add(byId.get(id)!.projectId);
      impacted.add(beforeById.get(id)!.projectId);
    }
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
  for (const [id] of before.acts) if (!after.acts.has(id)) {
    const pid = beforeById.get(id)!.projectId;
    removedActivities.push({ activityId: id, projectId: pid });
    impacted.add(pid);
  }
  const key = (m: { projectId: number; type: string; shipmentId: number | null; visitId?: number | null }) => `${m.projectId}:${m.type}:${m.shipmentId ?? ''}:${m.visitId ?? ''}`;
  const confidenceChanges: ScenarioComparison['confidenceChanges'] = [];
  const bm = new Map(before.milestones.map((m) => [key(m), m]));
  const milestoneDeltas: MilestoneDelta[] = [];
  const delayed = new Set<number>();
  const improved = new Set<number>();
  for (const m of after.milestones) {
    if (m.shipmentId !== null || m.visitId) continue;
    const b = bm.get(key(m));
    if (b && b.confidence !== m.confidence) confidenceChanges.push({ projectId: m.projectId, type: m.type, before: b.confidence, after: m.confidence });
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
      if (!a) continue;
      for (const [s, wc, units] of x.bookings) {
        if (s < st.now || s >= st.now + 40) continue;
        const k = `${wc}:${a.projectId}`;
        m.set(k, (m.get(k) ?? 0) + units);
      }
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
    improvedProjects: [...improved], capacityShifts, displaced, priorityChanges, addedActivities, removedActivities, confidenceChanges,
  };
}

/**
 * Compare the current plan with the plan after the scenario. `structuralBase` is the plan state
 * loaded after structural operations were applied (inside a savepoint); pure operations are then
 * applied on top of it.
 */
export function simulate(base: PlanState, ops: ScenarioOp[], structuralBase?: PlanState) {
  const before = forwardSchedule(base);
  const afterState = applyOps(structuralBase ?? base, ops.filter((o) => !STRUCTURAL_OPS.has(o.type)));
  const after = forwardSchedule(afterState);
  return { before, afterState, after, comparison: compareSchedules(base, before, afterState, after) };
}
