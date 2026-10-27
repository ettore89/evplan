/**
 * Deterministic finite-capacity scheduling engine.
 *
 *  - forwardSchedule(): Mode B — execution-driven forward propagation through the
 *    dependency network, honouring actuals, locked commitments, approved start floors,
 *    work-center capacity and project priority.
 *  - planBackward(): Mode A — initial backward plan from the customer-required
 *    commissioning completion, against the capacity already reserved by other projects.
 *
 * Everything here is pure: no database, no clock, no I/O.
 */
import { CalendarSet, dayOf, weekday, type Slot } from './calendar.js';
import type {
  ActResult, ActivityDef, Driver, LedgerView, MilestoneResult, MilestoneType, Overload,
  PlanState, ScheduleResult, Violation, WorkCenterDef,
} from './types.js';

const EPS = 1e-6;
const SEARCH_HORIZON = 2400; // slots (~3.3 years) searched for a capacity window
const MAX_ATTEMPT_SPAN = 600; // slots an individual contiguous allocation may span

const round2 = (x: number) => Math.round(x * 100) / 100;

export class Ledger implements LedgerView {
  private m = new Map<number, Map<Slot, { load: number; acts: number[] }>>();
  constructor(private ctx: Context) {}

  cell(wc: number, slot: Slot) {
    return this.m.get(wc)?.get(slot);
  }
  capacityAt(wc: number, slot: Slot) {
    return this.ctx.capacityAt(wc, slot);
  }
  entries() {
    return this.m.entries();
  }
  book(wc: number, actId: number, bookings: [Slot, number][]) {
    let byWc = this.m.get(wc);
    if (!byWc) this.m.set(wc, (byWc = new Map()));
    for (const [s, load] of bookings) {
      let c = byWc.get(s);
      if (!c) byWc.set(s, (c = { load: 0, acts: [] }));
      c.load = round2(c.load + load);
      c.acts.push(actId);
    }
  }
  unbook(wc: number, actId: number, bookings: [Slot, number][]) {
    const byWc = this.m.get(wc);
    if (!byWc) return;
    for (const [s, load] of bookings) {
      const c = byWc.get(s);
      if (!c) continue;
      c.load = round2(c.load - load);
      c.acts = c.acts.filter((a) => a !== actId);
      if (c.acts.length === 0) byWc.delete(s);
    }
  }
}

export class Context {
  readonly cal: CalendarSet;
  readonly wc = new Map<number, WorkCenterDef>();
  readonly routes = new Map<number, PlanState['routes'][number]>();
  private wcAuth = new Map<string, number | null>(); // `${wc}:${day}` -> capacity override
  private actAuth = new Set<string>(); // `${act}:${day}`

  constructor(readonly state: PlanState) {
    this.cal = new CalendarSet(state.calendars, state.defaultCalendarId);
    for (const w of state.workCenters) this.wc.set(w.id, w);
    for (const r of state.routes) this.routes.set(r.id, r);
    for (const a of state.weekendAuths) {
      if (a.activityId) this.actAuth.add(`${a.activityId}:${a.day}`);
      else if (a.workCenterId) this.wcAuth.set(`${a.workCenterId}:${a.day}`, a.capacity);
    }
  }

  wcBaseWorking(wcId: number, day: number) {
    const w = this.wc.get(wcId);
    return this.cal.isWorkingDay(w?.calendarId ?? this.state.defaultCalendarId, day);
  }

  capacityAt(wcId: number, slot: Slot): number {
    const w = this.wc.get(wcId);
    if (!w) return Infinity;
    const day = dayOf(slot);
    const key = `${wcId}:${day}`;
    if (!this.wcBaseWorking(wcId, day) && this.wcAuth.has(key)) return this.wcAuth.get(key) ?? w.capacity;
    return w.capacity;
  }

  /** Whether the activity may consume this slot (working calendar or authorized exception). */
  working(a: ActivityDef, slot: Slot): boolean {
    const day = dayOf(slot);
    if (a.kind === 'transport') {
      const r = a.routeId ? this.routes.get(a.routeId) : undefined;
      if (!r) return true;
      const wd = weekday(day);
      if (wd === 6 && !r.operatesSaturday) return false;
      if (wd === 0 && !r.operatesSunday) return false;
      return !r.holidayCalendarIds.some((c) => this.cal.isHoliday(c, day));
    }
    const w = a.workCenterId ? this.wc.get(a.workCenterId) : undefined;
    const calId = a.calendarId ?? w?.calendarId ?? this.state.defaultCalendarId;
    if (this.cal.isWorkingDay(calId, day)) return true;
    if (this.actAuth.has(`${a.id}:${day}`)) return true;
    if (w && this.wcAuth.has(`${w.id}:${day}`)) return true;
    return false;
  }

  /** Slot is an exception day (weekend/holiday work) for this activity. */
  isException(a: ActivityDef, slot: Slot): boolean {
    if (a.kind === 'transport') return false;
    const w = a.workCenterId ? this.wc.get(a.workCenterId) : undefined;
    const calId = a.calendarId ?? w?.calendarId ?? this.state.defaultCalendarId;
    return !this.cal.isWorkingDay(calId, dayOf(slot));
  }
}

type Attempt =
  | { ok: true; bookings: [Slot, number][]; start: Slot; finish: Slot; sharers: number[] }
  | { ok: false; blockers: number[] };

function work(a: ActivityDef) {
  return a.durationSlots; // one system-slot of work per duration slot at full rate
}

function tryAllocate(ctx: Context, ledger: Ledger, a: ActivityDef, from: Slot, dir: 1 | -1, force = false): Attempt {
  const w = a.workCenterId ? ctx.wc.get(a.workCenterId) : undefined;
  let remaining = work(a);
  const bookings: [Slot, number][] = [];
  let t = dir === 1 ? from : from - 1;
  let steps = 0;
  const sharers = new Set<number>();
  if (remaining <= EPS) return { ok: true, bookings: [], start: from, finish: from, sharers: [] };
  while (remaining > EPS) {
    if (steps++ > MAX_ATTEMPT_SPAN) return { ok: false, blockers: [] };
    if (!ctx.working(a, t)) {
      if (bookings.length === 0) return { ok: false, blockers: [] };
      t += dir;
      continue;
    }
    if (!w || a.kind === 'transport') {
      const r = Math.min(1, remaining);
      bookings.push([t, r]);
      remaining = round2(remaining - r);
      t += dir;
      continue;
    }
    const cell = ledger.cell(w.id, t);
    const load = cell?.load ?? 0;
    const conc = cell?.acts.length ?? 0;
    const avail = round2(ctx.capacityAt(w.id, t) - load);
    const maxRate = Math.min(a.maxRate || 1, 1);
    let rate = round2(Math.min(maxRate, remaining, Math.max(avail, 0)));
    const need = Math.min(w.minRate, remaining);
    if (!force && (conc >= w.maxConcurrent || rate < need - EPS)) {
      return { ok: false, blockers: cell?.acts ?? [] };
    }
    if (rate < Math.min(maxRate, remaining) - EPS) for (const x of cell?.acts ?? []) sharers.add(x);
    if (force && rate < need - EPS) rate = round2(Math.min(maxRate, remaining, Math.max(need, rate)));
    bookings.push([t, rate]);
    remaining = round2(remaining - rate);
    t += dir;
  }
  if (dir === 1) return { ok: true, bookings, start: bookings[0][0], finish: t, sharers: [...sharers] };
  bookings.reverse();
  return { ok: true, bookings, start: bookings[0][0], finish: bookings[bookings.length - 1][0] + 1, sharers: [...sharers] };
}

interface Placement {
  start: Slot;
  finish: Slot;
  bookings: [Slot, number][];
  blockers: number[];
  forced: boolean;
  sharers?: number[];
}

function findForward(ctx: Context, ledger: Ledger, a: ActivityDef, es: Slot): Placement {
  let firstBlockers: number[] | null = null;
  for (let s = es; s < es + SEARCH_HORIZON; s++) {
    if (!ctx.working(a, s)) continue;
    const r = tryAllocate(ctx, ledger, a, s, 1);
    if (r.ok) return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: firstBlockers ?? [], forced: false, sharers: r.sharers };
    if (firstBlockers === null) firstBlockers = r.blockers;
  }
  let s0 = es;
  while (!ctx.working(a, s0) && s0 < es + 400) s0++;
  const r = tryAllocate(ctx, ledger, a, s0, 1, true);
  if (!r.ok) return { start: es, finish: es + a.durationSlots, bookings: [], blockers: firstBlockers ?? [], forced: true };
  return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: firstBlockers ?? [], forced: true };
}

function findBackward(ctx: Context, ledger: Ledger, a: ActivityDef, lf: Slot): Placement {
  for (let f = lf; f > lf - SEARCH_HORIZON; f--) {
    if (!ctx.working(a, f - 1)) continue;
    const r = tryAllocate(ctx, ledger, a, f, -1);
    if (r.ok) return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: false };
  }
  let f0 = lf;
  while (!ctx.working(a, f0 - 1) && f0 > lf - 400) f0--;
  const r = tryAllocate(ctx, ledger, a, f0, -1, true);
  if (!r.ok) return { start: lf - a.durationSlots, finish: lf, bookings: [], blockers: [], forced: true };
  return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: true };
}

function topoBuckets(state: PlanState) {
  const byProject = new Map<number, ActivityDef[]>();
  for (const a of state.activities) {
    let l = byProject.get(a.projectId);
    if (!l) byProject.set(a.projectId, (l = []));
    l.push(a);
  }
  const succ = new Map<number, number[]>();
  for (const a of state.activities)
    for (const p of a.preds) {
      let l = succ.get(p.id);
      if (!l) succ.set(p.id, (l = []));
      l.push(a.id);
    }
  return { byProject, succ };
}

function isDone(a: ActivityDef) {
  return a.status === 'COMPLETED';
}

/**
 * Mode B — forward schedule of the whole program.
 */
export function forwardSchedule(state: PlanState): ScheduleResult {
  const ctx = new Context(state);
  const ledger = new Ledger(ctx);
  const now = state.now;
  const acts = new Map<number, ActResult>();
  const byId = new Map(state.activities.map((a) => [a.id, a]));
  const violations: Violation[] = [];
  const pullIn = new Set(state.pullIn);
  const pinned = new Set(state.pinned);
  const { byProject } = topoBuckets(state);

  const record = (a: ActivityDef, p: Omit<ActResult, 'id' | 'weekend' | 'flags'> & { flags?: string[] }) => {
    const weekend = p.bookings.some(([s]) => ctx.isException(a, s));
    const res: ActResult = { id: a.id, weekend, flags: p.flags ?? [], ...p };
    if (weekend) res.flags.push('weekend_work');
    acts.set(a.id, res);
    return res;
  };

  // 1. Completed and in-progress work is fixed first — actuals are never moved.
  for (const a of state.activities) {
    if (a.status === 'COMPLETED') {
      const st = a.actualStart ?? a.actualFinish ?? now;
      record(a, { start: st, finish: a.actualFinish ?? st, es: st, bookings: [], driver: { type: 'completed' }, capacityWaitSlots: 0 });
    }
  }
  for (const a of state.activities) {
    if ((a.status === 'IN_PROGRESS' || a.status === 'BLOCKED') && a.actualStart !== null) {
      const calId = a.calendarId ?? (a.workCenterId ? ctx.wc.get(a.workCenterId)?.calendarId : null) ?? state.defaultCalendarId;
      const planEnd = a.kind === 'transport'
        ? advanceOn(ctx, a, a.actualStart, a.durationSlots)
        : ctx.cal.addWorkingSlots(a.actualStart, a.durationSlots, calId);
      let finish = planEnd;
      let driver: Driver = { type: 'actual' };
      const flags: string[] = [];
      if (a.expectedFinish !== null && a.expectedFinish > finish) {
        finish = a.expectedFinish;
        driver = { type: 'reported' };
      }
      if (a.status === 'BLOCKED') {
        const remaining = Math.max(1, Math.ceil(a.durationSlots * (1 - a.pctComplete / 100)));
        const minFinish = advanceOn(ctx, a, now + 1, remaining);
        if (minFinish > finish) {
          finish = minFinish;
          driver = { type: 'blocked' };
        }
      }
      if (finish <= now) {
        finish = nextWorkingEnd(ctx, a, now);
        driver = { type: 'overdue' };
        flags.push('overdue');
      }
      const bookings: [Slot, number][] = [];
      if (a.workCenterId) {
        const w = ctx.wc.get(a.workCenterId)!;
        for (let s = Math.max(now, a.actualStart); s < finish; s++) {
          if (!ctx.working(a, s)) continue;
          const c = ledger.cell(w.id, s);
          const avail = round2(ctx.capacityAt(w.id, s) - (c?.load ?? 0));
          bookings.push([s, round2(Math.min(a.maxRate || 1, Math.max(w.minRate, avail)))]);
        }
        ledger.book(w.id, a.id, bookings);
      }
      record(a, { start: a.actualStart, finish, es: a.actualStart, bookings, driver, capacityWaitSlots: 0, flags });
    }
  }

  // 2. Locked commitments reserve their capacity before priority allocation.
  const reserved = new Map<number, Placement>();
  for (const a of state.activities) {
    if (acts.has(a.id) || !a.locked || a.approvedStart === null || a.status === 'CANCELLED') continue;
    let start = pinned.has(a.id) ? a.approvedStart : Math.max(a.approvedStart, now);
    if (!pinned.has(a.id)) while (!ctx.working(a, start) && start < now + 400) start++;
    else if (!ctx.working(a, start)) {
      violations.push({ activityId: a.id, type: 'capacity', message: `"${a.name}" cannot start on a non-working half-day without a weekend/holiday work authorization` });
      continue;
    }
    let r = tryAllocate(ctx, ledger, a, start, 1);
    if (!r.ok || r.start !== start) {
      violations.push({
        activityId: a.id,
        type: pinned.has(a.id) ? 'capacity' : 'overload',
        message: `Requested placement of "${a.name}" exceeds the capacity of the work center${
          r.ok ? '' : ` (occupied by ${r.blockers.length} activities)`}`,
      });
      r = tryAllocate(ctx, ledger, a, start, 1, true);
    }
    if (r.ok) {
      if (a.workCenterId) ledger.book(a.workCenterId, a.id, r.bookings);
      reserved.set(a.id, { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: false });
    }
  }

  // 3. Remaining work: projects in approved priority order, list scheduling inside each project.
  const projects = [...state.projects].sort((x, y) => x.priority - y.priority || x.id - y.id);
  const seen = new Set(projects.map((p) => p.id));
  for (const pid of byProject.keys()) if (!seen.has(pid)) projects.push({ id: pid, code: '', priority: 1e9, requiredFinish: null });

  for (const p of projects) {
    const list = (byProject.get(p.id) ?? []).filter((a) => !acts.has(a.id));
    const pending = new Set(list.map((a) => a.id));
    while (pending.size) {
      let best: { a: ActivityDef; es: Slot; drv: Driver } | null = null;
      for (const id of pending) {
        const a = byId.get(id)!;
        if (!a.preds.every((pr) => acts.has(pr.id) || !byId.has(pr.id))) continue;
        const { es, drv } = earliestStart(a, acts, now, pullIn, pinned);
        if (!best || es < best.es || (es === best.es && (a.unitSeq - best.a.unitSeq || a.seq - best.a.seq || a.id - best.a.id) < 0)) {
          best = { a, es, drv };
        }
      }
      if (!best) {
        // Dependency cycle or missing predecessor: schedule remaining in id order from now.
        for (const id of pending) {
          const a = byId.get(id)!;
          violations.push({ activityId: id, type: 'dependency', message: `Unresolvable dependency for "${a.name}"` });
          const pl = findForward(ctx, ledger, a, now);
          if (a.workCenterId) ledger.book(a.workCenterId, a.id, pl.bookings);
          record(a, { start: pl.start, finish: pl.finish, es: now, bookings: pl.bookings, driver: { type: 'none' }, capacityWaitSlots: 0 });
        }
        break;
      }
      const { a } = best;
      let { es, drv } = best;
      pending.delete(a.id);

      if (a.status === 'CANCELLED') {
        record(a, { start: es, finish: es, es, bookings: [], driver: { type: 'cancelled' }, capacityWaitSlots: 0 });
        continue;
      }

      const res = reserved.get(a.id);
      if (res) {
        if (es <= res.start) {
          record(a, { start: res.start, finish: res.finish, es: res.start, bookings: res.bookings, driver: { type: 'locked' }, capacityWaitSlots: 0, flags: ['locked'] });
          continue;
        }
        if (a.workCenterId) ledger.unbook(a.workCenterId, a.id, res.bookings);
        violations.push({
          activityId: a.id,
          type: pinned.has(a.id) ? 'dependency' : 'lock_broken',
          message: `"${a.name}" cannot start at its locked date: predecessors finish later`,
        });
      }

      if (a.status === 'BLOCKED' && es <= now) {
        es = now + 1;
        drv = { type: 'blocked' };
      }

      let pl = placeForward(ctx, ledger, a, es);
      if (a.expectedFinish !== null && pl.finish < a.expectedFinish) {
        let shifted = es;
        for (let i = 0; i < 40 && pl.finish < a.expectedFinish; i++) {
          shifted += a.expectedFinish - pl.finish;
          pl = placeForward(ctx, ledger, a, shifted);
        }
        drv = { type: 'reported' };
        es = shifted;
      }
      if (a.workCenterId && a.kind === 'work') ledger.book(a.workCenterId, a.id, pl.bookings);

      let firstWorking = es;
      while (!ctx.working(a, firstWorking) && firstWorking < es + 400) firstWorking++;
      let capWait = 0;
      if (pl.start > firstWorking) {
        for (let s = firstWorking; s < pl.start; s++) if (ctx.working(a, s)) capWait++;
      }
      const sharers = (pl.sharers ?? []).filter((b) => b !== a.id);
      const driver: Driver = capWait > 0 && a.workCenterId
        ? { type: 'capacity', workCenterId: a.workCenterId, blockers: pl.blockers.filter((b) => b !== a.id) }
        : sharers.length && a.workCenterId
          ? { type: 'capacity', workCenterId: a.workCenterId, blockers: sharers }
          : drv;
      const flags: string[] = [];
      if (sharers.length) flags.push('shared_capacity');
      if (pl.forced) flags.push('overload');
      if (res) flags.push('lock_broken');
      record(a, { start: pl.start, finish: pl.finish, es, bookings: pl.bookings, driver, capacityWaitSlots: capWait, flags });
    }
  }

  return finalize(state, ctx, ledger, acts, violations);
}

function placeForward(ctx: Context, ledger: Ledger, a: ActivityDef, es: Slot): Placement {
  if (a.kind === 'transport') {
    let s = es;
    while (!ctx.working(a, s) && s < es + 400) s++;
    const finish = advanceOn(ctx, a, s, a.durationSlots);
    return { start: s, finish, bookings: [], blockers: [], forced: false };
  }
  return findForward(ctx, ledger, a, es);
}

function placeBackward(ctx: Context, ledger: Ledger, a: ActivityDef, lf: Slot): Placement {
  if (a.kind === 'transport') {
    let f = lf;
    while (!ctx.working(a, f - 1) && f > lf - 400) f--;
    let left = a.durationSlots;
    let t = f;
    while (left > 0 && t > f - 2000) {
      t--;
      if (ctx.working(a, t)) left--;
    }
    return { start: t, finish: f, bookings: [], blockers: [], forced: false };
  }
  return findBackward(ctx, ledger, a, lf);
}

/** Advance `slots` slots on which the activity may run. */
function advanceOn(ctx: Context, a: ActivityDef, start: Slot, slots: number): Slot {
  let t = start;
  let left = slots;
  let guard = 0;
  while (left > 0 && guard++ < 4000) {
    if (ctx.working(a, t)) left--;
    t++;
  }
  return t;
}

function nextWorkingEnd(ctx: Context, a: ActivityDef, now: Slot): Slot {
  let t = now;
  let guard = 0;
  while (!ctx.working(a, t) && guard++ < 400) t++;
  return t + 1;
}

function earliestStart(a: ActivityDef, acts: Map<number, ActResult>, now: Slot, pullIn: Set<number>, pinned: Set<number>) {
  let es = now;
  let drv: Driver = { type: 'now' };
  let predMax = -Infinity;
  let predRef = -1;
  for (const p of a.preds) {
    const r = acts.get(p.id);
    if (!r) continue;
    const f = r.finish + p.lag;
    if (f > predMax) {
      predMax = f;
      predRef = p.id;
    }
  }
  const floor = a.approvedStart !== null && (!pullIn.has(a.projectId) || pinned.has(a.id)) ? a.approvedStart : -Infinity;
  if (predMax >= es && predMax >= floor) {
    es = predMax;
    drv = { type: 'predecessor', ref: predRef };
  } else if (floor > es) {
    es = floor;
    drv = { type: 'approved' };
  }
  return { es, drv };
}

function finalize(state: PlanState, ctx: Context, ledger: Ledger, acts: Map<number, ActResult>, violations: Violation[]): ScheduleResult {
  const overloads: Overload[] = [];
  for (const [wcId, cells] of ledger.entries()) {
    const w = ctx.wc.get(wcId);
    if (!w) continue;
    for (const [slot, c] of cells) {
      if (slot < state.now) continue;
      const cap = ctx.capacityAt(wcId, slot);
      if (c.load > cap + EPS || c.acts.length > w.maxConcurrent) {
        overloads.push({ workCenterId: wcId, slot, load: c.load, capacity: cap, activities: [...c.acts] });
      }
    }
  }
  overloads.sort((a, b) => a.slot - b.slot || a.workCenterId - b.workCenterId);
  const milestones = computeMilestones(state, acts);
  const critical = new Set<number>();
  for (const m of milestones) {
    if (m.drivingActivityId === null || m.shipmentId !== null) continue;
    for (const n of drivingChain(state, acts, m.drivingActivityId)) critical.add(n.activityId);
  }
  return { acts, overloads, violations, milestones, critical, ledger };
}

const TAG_FOR: Record<MilestoneType, ActivityDef['milestoneTag']> = { EOL: 'EOL', EXW: 'PACK', COMM: 'COMM' };

export function computeMilestones(state: PlanState, acts: Map<number, { finish: Slot }>): MilestoneResult[] {
  const out: MilestoneResult[] = [];
  const byProject = new Map<number, ActivityDef[]>();
  for (const a of state.activities) {
    let l = byProject.get(a.projectId);
    if (!l) byProject.set(a.projectId, (l = []));
    l.push(a);
  }
  const calc = (projectId: number, shipmentId: number | null, type: MilestoneType, list: ActivityDef[]) => {
    const rel = list.filter((a) => a.milestoneTag === TAG_FOR[type] && a.status !== 'CANCELLED');
    if (!rel.length) return;
    let forecast = -Infinity;
    let driving: number | null = null;
    for (const a of rel) {
      const r = acts.get(a.id);
      if (r && r.finish > forecast) {
        forecast = r.finish;
        driving = a.id;
      }
    }
    const complete = rel.every((a) => a.status === 'COMPLETED');
    const actual = complete ? Math.max(...rel.map((a) => a.actualFinish ?? -Infinity)) : null;
    out.push({
      projectId, shipmentId, type,
      forecast: Number.isFinite(forecast) ? forecast : null,
      actual: actual !== null && Number.isFinite(actual) ? actual : null,
      drivingActivityId: driving, complete,
    });
  };
  for (const [pid, list] of byProject) {
    calc(pid, null, 'EOL', list);
    calc(pid, null, 'EXW', list);
    calc(pid, null, 'COMM', list);
    const shipments = new Set(list.map((a) => a.shipmentId).filter((s): s is number => s !== null));
    for (const sid of shipments) {
      const unitIds = new Set(list.filter((a) => a.shipmentId === sid && a.unitId !== null).map((a) => a.unitId));
      calc(pid, sid, 'EXW', list.filter((a) => a.unitId !== null && unitIds.has(a.unitId)));
    }
  }
  return out;
}

export interface ChainNode {
  activityId: number;
  driver: Driver;
  start: Slot;
  finish: Slot;
}

/** Walk back from an activity through the constraints that determined its dates. */
export function drivingChain(state: PlanState, acts: Map<number, ActResult>, fromId: number): ChainNode[] {
  const byId = new Map(state.activities.map((a) => [a.id, a]));
  const chain: ChainNode[] = [];
  const visited = new Set<number>();
  let cur: number | null = fromId;
  while (cur !== null && !visited.has(cur)) {
    visited.add(cur);
    const r = acts.get(cur);
    const a = byId.get(cur);
    if (!r || !a) break;
    chain.push({ activityId: cur, driver: r.driver, start: r.start, finish: r.finish });
    if (r.driver.type === 'predecessor') cur = r.driver.ref;
    else if (r.driver.type === 'capacity' || r.driver.type === 'locked') {
      // Continue along the technical predecessor that finished last.
      let best: number | null = null;
      let bf = -Infinity;
      for (const p of a.preds) {
        const pr = acts.get(p.id);
        if (pr && pr.finish > bf) {
          bf = pr.finish;
          best = p.id;
        }
      }
      cur = best;
    } else cur = null;
  }
  return chain;
}

export interface BackwardPlan {
  feasible: boolean;
  starts: Map<number, Slot>;
  earliestStart: Slot;
}

/**
 * Mode A — backward plan for one project from its required commissioning completion,
 * against capacity already reserved by every other project.
 */
export function planBackward(state: PlanState, projectId: number): BackwardPlan {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project || project.requiredFinish === null) throw new Error('Project has no required commissioning date');
  const own = state.activities.filter((a) => a.projectId === projectId);
  const others: PlanState = { ...state, activities: state.activities.filter((a) => a.projectId !== projectId) };
  const base = forwardSchedule(others);
  const ctx = new Context(state);
  const ledger = base.ledger as Ledger;

  const succ = new Map<number, { id: number; lag: number }[]>();
  for (const a of own) for (const p of a.preds) {
    let l = succ.get(p.id);
    if (!l) succ.set(p.id, (l = []));
    l.push({ id: a.id, lag: p.lag });
  }
  const starts = new Map<number, Slot>();
  const finishes = new Map<number, Slot>();
  const pending = new Set(own.map((a) => a.id));
  const byId = new Map(own.map((a) => [a.id, a]));
  while (pending.size) {
    let best: { a: ActivityDef; lf: Slot } | null = null;
    for (const id of pending) {
      const a = byId.get(id)!;
      const ss = succ.get(id) ?? [];
      if (!ss.every((s) => starts.has(s.id))) continue;
      let lf = project.requiredFinish;
      for (const s of ss) lf = Math.min(lf, starts.get(s.id)! - s.lag);
      if (!best || lf > best.lf || (lf === best.lf && (best.a.unitSeq - a.unitSeq || best.a.seq - a.seq) < 0)) best = { a, lf };
    }
    if (!best) break;
    const { a, lf } = best;
    pending.delete(a.id);
    if (a.status === 'CANCELLED') {
      starts.set(a.id, lf);
      finishes.set(a.id, lf);
      continue;
    }
    const pl = placeBackward(ctx, ledger, a, lf);
    if (a.workCenterId && a.kind === 'work') ledger.book(a.workCenterId, a.id, pl.bookings);
    starts.set(a.id, pl.start);
    finishes.set(a.id, pl.finish);
  }
  const earliestStart = Math.min(...starts.values());
  return { feasible: earliestStart >= state.now, starts, earliestStart };
}

export interface InitialPlan {
  feasible: boolean;
  /** Approved start per activity of the project (release floors for forward execution). */
  starts: Map<number, Slot>;
  result: ScheduleResult;
  iterations: number;
}

/**
 * Full Mode A initialization: backward plan, then a forward replay to confirm it against
 * the real forward rules (partial-rate work centers can allocate differently forward than
 * backward). If the replay misses the anchor, the backward anchor is tightened and the
 * plan is regenerated. If no backward plan fits after `now`, an ASAP forward plan gives the
 * earliest achievable commissioning.
 */
export function initialPlan(state: PlanState, projectId: number, maxIterations = 14): InitialPlan {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project || project.requiredFinish === null) throw new Error('Project has no required commissioning date');
  const target = project.requiredFinish;
  const own = state.activities.filter((a) => a.projectId === projectId);
  type Trial = { ok: boolean; backwardFeasible: boolean; finish: number; starts?: Map<number, Slot>; result?: ScheduleResult };
  const attempt = (anchor: number): Trial => {
    const trial: PlanState = { ...state, projects: state.projects.map((p) => (p.id === projectId ? { ...p, requiredFinish: anchor } : p)) };
    const plan = planBackward(trial, projectId);
    if (!plan.feasible) return { ok: false, backwardFeasible: false, finish: Infinity };
    const replay: PlanState = {
      ...state,
      pullIn: state.pullIn.filter((p) => p !== projectId),
      activities: state.activities.map((a) => (a.projectId === projectId ? { ...a, approvedStart: plan.starts.get(a.id) ?? null } : a)),
    };
    const result = forwardSchedule(replay);
    const comm = result.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null);
    const finish = comm?.forecast ?? -Infinity;
    return { ok: finish <= target, backwardFeasible: true, finish, starts: new Map(own.map((a) => [a.id, result.acts.get(a.id)!.start])), result };
  };
  let iterations = 0;
  let best: Trial | null = null;
  let bestAnchor = -Infinity;
  let failAnchor = Infinity;
  let anchor = target;
  // Phase 1: tighten the anchor by the observed shortfall until the forward replay meets the date.
  while (iterations < maxIterations) {
    iterations++;
    const t = attempt(anchor);
    if (!t.backwardFeasible) break;
    if (t.ok) { best = t; bestAnchor = anchor; break; }
    failAnchor = anchor;
    anchor -= Math.max(1, t.finish - target);
  }
  // Phase 2: binary search for the latest anchor that still meets the date (latest feasible starts).
  while (best && Number.isFinite(failAnchor) && failAnchor - bestAnchor > 1 && iterations < maxIterations) {
    iterations++;
    const mid = Math.floor((bestAnchor + failAnchor) / 2);
    const t = attempt(mid);
    if (t.ok) { best = t; bestAnchor = mid; } else failAnchor = mid;
  }
  if (best) return { feasible: true, starts: best.starts!, result: best.result!, iterations };
  const asap: PlanState = {
    ...state,
    pullIn: [...new Set([...state.pullIn, projectId])],
    activities: state.activities.map((a) => (a.projectId === projectId ? { ...a, approvedStart: null } : a)),
  };
  const result = forwardSchedule(asap);
  const starts = new Map(own.map((a) => [a.id, result.acts.get(a.id)!.start]));
  // Greedy latest-start placement can fail around other projects' reservations even when an
  // earlier (as-soon-as-possible) plan still protects the date: that plan is then accepted.
  const comm = result.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null);
  return { feasible: (comm?.forecast ?? Infinity) <= target, starts, result, iterations };
}
