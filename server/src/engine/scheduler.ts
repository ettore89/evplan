/**
 * Deterministic finite-capacity scheduling engine (V4).
 *
 *  - forwardSchedule(): Mode B — execution-driven forward propagation through the dependency
 *    network, honouring actuals, physical resource holds, readiness gates, locked commitments,
 *    approved start floors, multi-resource capacity and project priority.
 *  - planBackward() / initialPlan(): Mode A — initial backward plan from the customer-required
 *    commissioning completion, against the capacity already reserved by other projects.
 *
 * Resources are booked per half-day slot. An activity consists of contiguous phases, each of which
 * needs a set of resources (e.g. EOL position + shared power tester); all must be free at once.
 * A resource can be *held* from the end of one activity until a later one starts (a validation
 * skid stays occupied until the system is disconnected and removed).
 *
 * Everything here is pure: no database, no clock, no I/O.
 */
import { CalendarSet, dayOf, weekday, type Slot } from './calendar.js';
import {
  type ActResult, type ActivityDef, type Booking, type Confidence, type Driver, type GateDef, type LedgerView,
  type MilestoneResult, type MilestoneType, type Overload, type PhaseDef, type PlanState, type ScheduleResult,
  type Violation, type WorkCenterDef, worstConfidence,
} from './types.js';

const EPS = 1e-6;
const SEARCH_HORIZON = 2400; // slots (~3.3 years) searched for a capacity window
const MAX_ATTEMPT_SPAN = 600; // slots an individual contiguous allocation may span
const MAX_HOLD_GAP = 240; // slots a resource may be held waiting for the follow-up activity

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
  book(actId: number, bookings: Booking[]) {
    for (const [s, wc, units] of bookings) {
      let byWc = this.m.get(wc);
      if (!byWc) this.m.set(wc, (byWc = new Map()));
      let c = byWc.get(s);
      if (!c) byWc.set(s, (c = { load: 0, acts: [] }));
      c.load = round2(c.load + units);
      if (!c.acts.includes(actId)) c.acts.push(actId);
    }
  }
  unbook(actId: number, bookings: Booking[]) {
    for (const [s, wc, units] of bookings) {
      const c = this.m.get(wc)?.get(s);
      if (!c) continue;
      c.load = round2(c.load - units);
      c.acts = c.acts.filter((a) => a !== actId);
      if (c.acts.length === 0) this.m.get(wc)!.delete(s);
    }
  }
  free(wc: number, slot: Slot, units: number) {
    return (this.cell(wc, slot)?.load ?? 0) + units <= this.capacityAt(wc, slot) + EPS;
  }
}

export class Context {
  readonly cal: CalendarSet;
  readonly wc = new Map<number, WorkCenterDef>();
  readonly routes = new Map<number, PlanState['routes'][number]>();
  private wcAuth = new Map<string, number | null>(); // `${wc}:${day}` -> capacity override
  private actAuth = new Set<string>(); // `${act}:${day}`
  private changes = new Map<number, { fromDay: number; capacity: number }[]>();

  constructor(readonly state: PlanState) {
    this.cal = new CalendarSet(state.calendars, state.defaultCalendarId);
    for (const w of state.workCenters) this.wc.set(w.id, w);
    for (const r of state.routes) this.routes.set(r.id, r);
    for (const a of state.weekendAuths) {
      if (a.activityId) this.actAuth.add(`${a.activityId}:${a.day}`);
      else if (a.workCenterId) this.wcAuth.set(`${a.workCenterId}:${a.day}`, a.capacity);
    }
    for (const c of state.capacityChanges ?? []) {
      const l = this.changes.get(c.resourceId) ?? [];
      l.push({ fromDay: c.fromDay, capacity: c.capacity });
      this.changes.set(c.resourceId, l);
    }
    for (const l of this.changes.values()) l.sort((a, b) => a.fromDay - b.fromDay);
  }

  baseCapacity(wcId: number, day: number) {
    const w = this.wc.get(wcId);
    if (!w) return Infinity;
    let cap = w.capacity;
    for (const c of this.changes.get(wcId) ?? []) if (c.fromDay <= day) cap = c.capacity;
    return cap;
  }

  wcBaseWorking(wcId: number, day: number) {
    const w = this.wc.get(wcId);
    return this.cal.isWorkingDay(w?.calendarId ?? this.state.defaultCalendarId, day);
  }

  capacityAt(wcId: number, slot: Slot): number {
    const day = dayOf(slot);
    const cap = this.baseCapacity(wcId, day);
    const key = `${wcId}:${day}`;
    if (!this.wcBaseWorking(wcId, day) && this.wcAuth.has(key)) return this.wcAuth.get(key) ?? cap;
    return cap;
  }

  /** Whether the activity may progress during this slot (its calendar or an authorized exception). */
  working(a: ActivityDef, slot: Slot): boolean {
    const day = dayOf(slot);
    if (a.kind === 'calendar') return true;
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
    if (a.kind === 'external') return false;
    if (this.actAuth.has(`${a.id}:${day}`)) return true;
    if (w && this.wcAuth.has(`${w.id}:${day}`)) return true;
    return false;
  }

  /** Slot is an exception day (weekend/holiday work) for this activity. */
  isException(a: ActivityDef, slot: Slot): boolean {
    if (a.kind !== 'work') return false;
    const w = a.workCenterId ? this.wc.get(a.workCenterId) : undefined;
    const calId = a.calendarId ?? w?.calendarId ?? this.state.defaultCalendarId;
    return !this.cal.isWorkingDay(calId, dayOf(slot));
  }
}

/** The resource profile of an activity. */
export function phasesOf(a: ActivityDef): PhaseDef[] {
  if (a.phases && a.phases.length) return a.phases;
  const resources = a.kind === 'work' && a.workCenterId ? [{ resourceId: a.workCenterId, units: 1 }] : [];
  return [{ name: a.name, slots: a.durationSlots, resources }];
}

export function totalSlots(a: ActivityDef) {
  return phasesOf(a).reduce((s, p) => s + p.slots, 0);
}

type Attempt =
  | { ok: true; bookings: Booking[]; start: Slot; finish: Slot }
  | { ok: false; blockers: number[]; failAt: Slot };

interface HoldGap {
  from: Slot;
  resources: { resourceId: number; units: number }[];
}

/**
 * Try to place the activity starting at `from` (dir 1) or finishing at `from` (dir -1),
 * consuming every phase contiguously on working slots. A hold gap books held resources
 * between the end of the earlier activity and this start.
 */
function tryPlace(ctx: Context, ledger: Ledger, a: ActivityDef, from: Slot, dir: 1 | -1, force = false, gap?: HoldGap): Attempt {
  const phases = dir === 1 ? phasesOf(a) : [...phasesOf(a)].reverse();
  const total = phases.reduce((s, p) => s + p.slots, 0);
  const bookings: Booking[] = [];
  const blockers = new Set<number>();
  if (dir === 1 && gap && from > gap.from) {
    if (from - gap.from > MAX_HOLD_GAP && !force) return { ok: false, blockers: [], failAt: from };
    for (let s = gap.from; s < from; s++)
      for (const r of gap.resources) {
        if (!force && !ledger.free(r.resourceId, s, r.units)) {
          return { ok: false, blockers: ledger.cell(r.resourceId, s)?.acts ?? [], failAt: s };
        }
        bookings.push([s, r.resourceId, r.units]);
      }
  }
  if (total <= 0) return { ok: true, bookings, start: from, finish: from };
  let t = dir === 1 ? from : from - 1;
  if (!ctx.working(a, t)) return { ok: false, blockers: [], failAt: t };
  let steps = 0;
  let first: Slot | null = null;
  let last: Slot = t;
  for (const ph of phases) {
    let left = ph.slots;
    while (left > 0) {
      if (steps++ > MAX_ATTEMPT_SPAN) return { ok: false, blockers: [...blockers], failAt: t };
      if (!ctx.working(a, t)) { t += dir; continue; }
      for (const r of ph.resources) {
        if (!force && !ledger.free(r.resourceId, t, r.units)) {
          return { ok: false, blockers: ledger.cell(r.resourceId, t)?.acts ?? [], failAt: t };
        }
      }
      for (const r of ph.resources) bookings.push([t, r.resourceId, r.units]);
      if (first === null) first = t;
      last = t;
      left--;
      t += dir;
    }
  }
  if (dir === 1) return { ok: true, bookings, start: first ?? from, finish: last + 1 };
  return { ok: true, bookings, start: last, finish: (first ?? from - 1) + 1 };
}

interface Placement {
  start: Slot;
  finish: Slot;
  bookings: Booking[];
  blockers: number[];
  forced: boolean;
}

function findForward(ctx: Context, ledger: Ledger, a: ActivityDef, es: Slot, gap?: HoldGap): Placement {
  let firstBlockers: number[] | null = null;
  for (let s = es; s < es + SEARCH_HORIZON; s++) {
    if (!ctx.working(a, s)) continue;
    const r = tryPlace(ctx, ledger, a, s, 1, false, gap);
    if (r.ok) return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: firstBlockers ?? [], forced: false };
    if (firstBlockers === null && r.blockers.length) firstBlockers = r.blockers;
  }
  let s0 = es;
  while (!ctx.working(a, s0) && s0 < es + 400) s0++;
  const r = tryPlace(ctx, ledger, a, s0, 1, true, gap);
  if (!r.ok) return { start: es, finish: es + totalSlots(a), bookings: [], blockers: firstBlockers ?? [], forced: true };
  return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: firstBlockers ?? [], forced: true };
}

function findBackward(ctx: Context, ledger: Ledger, a: ActivityDef, lf: Slot): Placement {
  for (let f = lf; f > lf - SEARCH_HORIZON; f--) {
    if (!ctx.working(a, f - 1)) continue;
    const r = tryPlace(ctx, ledger, a, f, -1);
    if (r.ok) return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: false };
  }
  let f0 = lf;
  while (!ctx.working(a, f0 - 1) && f0 > lf - 400) f0--;
  const r = tryPlace(ctx, ledger, a, f0, -1, true);
  if (!r.ok) return { start: lf - totalSlots(a), finish: lf, bookings: [], blockers: [], forced: true };
  return { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: true };
}

/** Advance `slots` slots on which the activity may progress. */
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

interface GateEffect {
  startFloor: Slot;
  finishFloor: Slot;
  confidence: Confidence;
  gates: number[];
  startDriver: GateDef | null;
  finishDriver: GateDef | null;
  open: boolean;
}

/** How readiness gates constrain and qualify an activity's dates. Unknown readiness is never firm. */
export function gateEffect(a: ActivityDef, phase: 'START' | 'COMPLETE' | 'BOTH' = 'BOTH'): GateEffect {
  const eff: GateEffect = { startFloor: -Infinity, finishFloor: -Infinity, confidence: 'FIRM', gates: [], startDriver: null, finishDriver: null, open: false };
  for (const g of a.gates ?? []) {
    if (phase !== 'BOTH' && g.blocks !== phase) continue;
    if (g.status === 'READY') continue;
    eff.gates.push(g.id);
    if (g.conditional) {
      eff.confidence = worstConfidence(eff.confidence, 'CONDITIONAL');
      continue;
    }
    if (g.forecast !== null) {
      eff.confidence = worstConfidence(eff.confidence, 'CONDITIONAL');
      if (g.blocks === 'START' && g.forecast > eff.startFloor) { eff.startFloor = g.forecast; eff.startDriver = g; }
      if (g.blocks === 'COMPLETE' && g.forecast > eff.finishFloor) { eff.finishFloor = g.forecast; eff.finishDriver = g; }
    } else if (g.status === 'BLOCKED') {
      eff.confidence = 'OPEN';
      eff.open = true;
      if (g.blocks === 'START') eff.startDriver = eff.startDriver ?? g;
      else eff.finishDriver = eff.finishDriver ?? g;
    } else {
      eff.confidence = worstConfidence(eff.confidence, 'CONDITIONAL');
    }
  }
  return eff;
}

function topoByProject(state: PlanState) {
  const byProject = new Map<number, ActivityDef[]>();
  for (const a of state.activities) {
    let l = byProject.get(a.projectId);
    if (!l) byProject.set(a.projectId, (l = []));
    l.push(a);
  }
  return byProject;
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
  const byProject = topoByProject(state);

  const inherit = (a: ActivityDef) => {
    let conf: Confidence = 'FIRM';
    const gates = new Set<number>();
    const refs = [...a.preds.map((p) => p.id), ...(a.holds ?? []).map((h) => h.fromActivityId)];
    for (const id of refs) {
      const r = acts.get(id);
      if (!r) continue;
      conf = worstConfidence(conf, r.confidence);
      for (const g of r.confidenceGates) gates.add(g);
    }
    return { conf, gates };
  };

  const record = (a: ActivityDef, p: Omit<ActResult, 'id' | 'weekend' | 'flags' | 'confidence' | 'confidenceGates'> & { flags?: string[]; confidence?: Confidence; confidenceGates?: number[] }) => {
    const weekend = p.bookings.some(([s, wc]) => wc === a.workCenterId && ctx.isException(a, s));
    const res: ActResult = { id: a.id, weekend, flags: p.flags ?? [], confidence: p.confidence ?? 'FIRM', confidenceGates: p.confidenceGates ?? [], ...p } as ActResult;
    if (weekend) res.flags.push('weekend_work');
    if (res.confidence !== 'FIRM') res.flags.push(res.confidence === 'OPEN' ? 'open_date' : 'conditional');
    acts.set(a.id, res);
    return res;
  };

  // 0. Non-production occupancy (troubleshooting, regression testing, maintenance…) is fixed.
  for (const r of state.reservations ?? []) {
    const b: Booking[] = [];
    for (let s = Math.max(r.start, now); s < r.finish; s++) b.push([s, r.resourceId, r.units]);
    ledger.book(-r.id, b);
  }

  // 1. Completed and in-progress work is fixed first — actuals are never moved.
  for (const a of state.activities) {
    if (a.status === 'COMPLETED') {
      const st = a.actualStart ?? a.actualFinish ?? now;
      record(a, { start: st, finish: a.actualFinish ?? st, es: st, bookings: [], driver: { type: 'completed' }, capacityWaitSlots: 0 });
    }
  }
  for (const a of state.activities) {
    if (!((a.status === 'IN_PROGRESS' || a.status === 'BLOCKED') && a.actualStart !== null)) continue;
    const dur = totalSlots(a);
    let finish: Slot;
    if (a.progressSlot != null && a.pctComplete > 0) {
      const remaining = Math.max(0, Math.ceil(dur * (1 - a.pctComplete / 100)));
      finish = remaining > 0 ? advanceOn(ctx, a, Math.max(a.progressSlot, a.actualStart), remaining) : Math.max(a.progressSlot, now) + 1;
    } else finish = advanceOn(ctx, a, a.actualStart, dur);
    let driver: Driver = { type: 'actual' };
    const flags: string[] = [];
    if (a.expectedFinish !== null && a.expectedFinish > finish) {
      finish = a.expectedFinish;
      driver = { type: 'reported' };
    }
    if (a.status === 'BLOCKED') {
      const remaining = Math.max(1, Math.ceil(dur * (1 - a.pctComplete / 100)));
      const minFinish = advanceOn(ctx, a, now + 1, remaining);
      if (minFinish > finish) { finish = minFinish; driver = { type: 'blocked' }; }
    }
    const ge = gateEffect(a, 'COMPLETE');
    if (ge.finishFloor > finish) { finish = ge.finishFloor; driver = { type: 'gate', gateId: ge.finishDriver!.id, dimension: ge.finishDriver!.dimension, open: false }; }
    else if (ge.open && ge.finishDriver) driver = { type: 'gate', gateId: ge.finishDriver.id, dimension: ge.finishDriver.dimension, open: true };
    if (finish <= now) {
      finish = nextWorkingEnd(ctx, a, now);
      if (driver.type !== 'gate') { driver = { type: 'overdue' }; flags.push('overdue'); }
    }
    // Book the remaining phases (and keep the last phase's resources if the work overruns).
    const phases = phasesOf(a);
    const bookings: Booking[] = [];
    let elapsed = 0;
    for (let s = a.actualStart; s < finish; s++) {
      if (!ctx.working(a, s)) continue;
      let acc = 0;
      let ph = phases[phases.length - 1];
      for (const p of phases) { acc += p.slots; if (elapsed < acc) { ph = p; break; } }
      elapsed++;
      if (s < now) continue;
      for (const r of ph.resources) bookings.push([s, r.resourceId, r.units]);
    }
    ledger.book(a.id, bookings);
    record(a, { start: a.actualStart, finish, es: a.actualStart, bookings, driver, capacityWaitSlots: 0, flags, confidence: ge.confidence, confidenceGates: ge.gates });
  }

  const reserved = new Map<number, Placement>();

  /** Earliest start from predecessors, approved floor and now. */
  const earliestStart = (a: ActivityDef) => {
    let es = now;
    let drv: Driver = { type: 'now' };
    let predMax = -Infinity;
    let predRef = -1;
    for (const p of a.preds) {
      const r = acts.get(p.id);
      if (!r) continue;
      const f = r.finish + p.lag;
      if (f > predMax) { predMax = f; predRef = p.id; }
    }
    const floor = a.approvedStart !== null && (!pullIn.has(a.projectId) || pinned.has(a.id)) ? a.approvedStart : -Infinity;
    if (predMax >= es && predMax >= floor) { es = predMax; drv = { type: 'predecessor', ref: predRef }; }
    else if (floor > es) { es = floor; drv = { type: 'approved' }; }
    return { es, drv };
  };

  const holdGap = (a: ActivityDef): HoldGap | undefined => {
    if (!a.holds?.length) return undefined;
    let from = -Infinity;
    const resources: HoldGap['resources'] = [];
    for (const h of a.holds) {
      const src = acts.get(h.fromActivityId);
      if (!src) continue;
      from = Math.max(from, src.finish, now);
      resources.push({ resourceId: h.resourceId, units: h.units });
    }
    return Number.isFinite(from) && resources.length ? { from, resources } : undefined;
  };

  const place = (a: ActivityDef, es0: Slot, drv0: Driver) => {
    let es = es0;
    let drv = drv0;
    const inh = inherit(a);
    if (a.status === 'CANCELLED') {
      record(a, { start: es, finish: es, es, bookings: [], driver: { type: 'cancelled' }, capacityWaitSlots: 0 });
      return;
    }
    const ge = gateEffect(a);
    const confidence = worstConfidence(ge.confidence, inh.conf);
    const confidenceGates = [...new Set([...ge.gates, ...inh.gates])];
    const gap = holdGap(a);

    const res = reserved.get(a.id);
    if (res) {
      if (es <= res.start && ge.startFloor <= res.start) {
        const extra: Booking[] = [];
        if (gap) for (let s = gap.from; s < res.start; s++) for (const r of gap.resources) extra.push([s, r.resourceId, r.units]);
        ledger.book(a.id, extra);
        record(a, { start: res.start, finish: Math.max(res.finish, ge.finishFloor), es: res.start, bookings: [...extra, ...res.bookings], driver: { type: 'locked' }, capacityWaitSlots: 0, flags: ['locked'], confidence, confidenceGates });
        return;
      }
      ledger.unbook(a.id, res.bookings);
      if (ge.startFloor > res.start && es <= res.start) {
        violations.push({ activityId: a.id, type: 'readiness', message: `"${a.name}" cannot start at its locked date: readiness gate "${ge.startDriver?.title}" is not resolved before then` });
      } else {
        violations.push({
          activityId: a.id,
          type: pinned.has(a.id) ? 'dependency' : 'lock_broken',
          message: `"${a.name}" cannot start at its locked date: predecessors finish later`,
        });
      }
    }

    if (a.status === 'BLOCKED' && es <= now) { es = now + 1; drv = { type: 'blocked' }; }
    if (ge.startFloor > es) {
      es = ge.startFloor;
      drv = { type: 'gate', gateId: ge.startDriver!.id, dimension: ge.startDriver!.dimension, open: false };
    } else if (ge.open && ge.startDriver) {
      drv = { type: 'gate', gateId: ge.startDriver.id, dimension: ge.startDriver.dimension, open: true };
    }

    let pl = findForward(ctx, ledger, a, es, gap);
    if (a.expectedFinish !== null && pl.finish < a.expectedFinish) {
      let shifted = es;
      for (let i = 0; i < 40 && pl.finish < a.expectedFinish; i++) {
        shifted += a.expectedFinish - pl.finish;
        pl = findForward(ctx, ledger, a, shifted, gap);
      }
      drv = { type: 'reported' };
      es = shifted;
    }
    ledger.book(a.id, pl.bookings);
    let finish = pl.finish;
    if (ge.finishFloor > finish) {
      finish = ge.finishFloor;
      drv = { type: 'gate', gateId: ge.finishDriver!.id, dimension: ge.finishDriver!.dimension, open: false };
    }

    let firstWorking = es;
    while (!ctx.working(a, firstWorking) && firstWorking < es + 400) firstWorking++;
    let capWait = 0;
    if (pl.start > firstWorking) for (let s = firstWorking; s < pl.start; s++) if (ctx.working(a, s)) capWait++;
    const blockers = pl.blockers.filter((b) => b !== a.id);
    const capRes = capWait > 0 ? blockingResource(a, pl, ledger) : null;
    const driver: Driver = capWait > 0 && capRes !== null ? { type: 'capacity', workCenterId: capRes, blockers } : drv;
    const flags: string[] = [];
    if (pl.forced) flags.push('overload');
    if (res) flags.push('lock_broken');
    if (gap && pl.start > gap.from) flags.push('resource_held');
    record(a, { start: pl.start, finish, es, bookings: pl.bookings, driver, capacityWaitSlots: capWait, flags, confidence, confidenceGates });
  };

  // 1b. Physical-release continuations of fixed work (e.g. skid removal after a completed
  //     validation) are placed before anything else can take the held resource.
  for (let guard = 0; guard < 50; guard++) {
    const next = state.activities.filter((a) => !acts.has(a.id) && a.holds?.length && a.holds.every((h) => acts.has(h.fromActivityId))
      && a.preds.every((p) => acts.has(p.id) || !byId.has(p.id)));
    if (!next.length) break;
    for (const a of next) {
      const { es, drv } = earliestStart(a);
      place(a, es, drv);
    }
  }

  // 2. Locked commitments reserve their capacity before priority allocation.
  for (const a of state.activities) {
    if (acts.has(a.id) || !a.locked || a.approvedStart === null || a.status === 'CANCELLED') continue;
    let start = pinned.has(a.id) ? a.approvedStart : Math.max(a.approvedStart, now);
    if (!pinned.has(a.id)) while (!ctx.working(a, start) && start < now + 400) start++;
    else if (!ctx.working(a, start)) {
      violations.push({ activityId: a.id, type: 'capacity', message: `"${a.name}" cannot start on a non-working half-day without a weekend/holiday work authorization` });
      continue;
    }
    if (pinned.has(a.id)) {
      const ge = gateEffect(a, 'START');
      const unresolved = (a.gates ?? []).find((g) => g.blocks === 'START' && g.status !== 'READY' && !g.conditional && (g.forecast === null ? g.status === 'BLOCKED' : g.forecast > start));
      if (unresolved) {
        violations.push({ activityId: a.id, type: 'readiness', message: `"${a.name}" cannot be placed before readiness gate "${unresolved.title}" (${unresolved.dimension}) is resolved${ge.startFloor > -Infinity ? '' : ' — no reliable resolution date'}` });
      }
    }
    let r = tryPlace(ctx, ledger, a, start, 1);
    if (!r.ok || r.start !== start) {
      violations.push({
        activityId: a.id,
        type: pinned.has(a.id) ? 'capacity' : 'overload',
        message: `Requested placement of "${a.name}" exceeds the available resources${r.ok ? '' : ` (occupied by ${r.blockers.length} activities)`}`,
      });
      r = tryPlace(ctx, ledger, a, start, 1, true);
    }
    if (r.ok) {
      ledger.book(a.id, r.bookings);
      reserved.set(a.id, { start: r.start, finish: r.finish, bookings: r.bookings, blockers: [], forced: false });
    }
  }

  // 3. Remaining work: committed demand before approved before tentative, then approved priority.
  const projects = [...state.projects].sort((x, y) => (x.demandRank ?? 0) - (y.demandRank ?? 0) || x.priority - y.priority || x.id - y.id);
  const seen = new Set(projects.map((p) => p.id));
  for (const pid of byProject.keys()) if (!seen.has(pid)) projects.push({ id: pid, code: '', priority: 1e9, requiredFinish: null });

  for (const p of projects) {
    const list = (byProject.get(p.id) ?? []).filter((a) => !acts.has(a.id));
    const pending = new Set(list.map((a) => a.id));
    while (pending.size) {
      let best: { a: ActivityDef; es: Slot; drv: Driver; urgent: boolean } | null = null;
      for (const id of pending) {
        const a = byId.get(id)!;
        if (!a.preds.every((pr) => acts.has(pr.id) || !byId.has(pr.id))) continue;
        if (a.holds?.some((h) => !acts.has(h.fromActivityId))) continue;
        const { es, drv } = earliestStart(a);
        const urgent = !!a.holds?.length; // physical continuation: place before anything can take the held resource
        if (!best || (urgent && !best.urgent) || (urgent === best.urgent && (es < best.es || (es === best.es && (a.unitSeq - best.a.unitSeq || a.seq - best.a.seq || a.id - best.a.id) < 0)))) {
          best = { a, es, drv, urgent };
        }
      }
      if (!best) {
        for (const id of pending) {
          const a = byId.get(id)!;
          violations.push({ activityId: id, type: 'dependency', message: `Unresolvable dependency for "${a.name}"` });
          const pl = findForward(ctx, ledger, a, now);
          ledger.book(a.id, pl.bookings);
          record(a, { start: pl.start, finish: pl.finish, es: now, bookings: pl.bookings, driver: { type: 'none' }, capacityWaitSlots: 0 });
        }
        break;
      }
      pending.delete(best.a.id);
      place(best.a, best.es, best.drv);
    }
  }

  return finalize(state, ctx, ledger, acts, violations);
}

/** The resource that kept the activity from starting at its earliest start. */
function blockingResource(a: ActivityDef, pl: Placement, ledger: Ledger): number | null {
  const phases = phasesOf(a);
  for (const ph of phases) for (const r of ph.resources) {
    if (pl.blockers.some((b) => ledger.cell(r.resourceId, pl.start - 1)?.acts.includes(b))) return r.resourceId;
  }
  return a.workCenterId ?? phases.flatMap((p) => p.resources)[0]?.resourceId ?? null;
}

function finalize(state: PlanState, ctx: Context, ledger: Ledger, acts: Map<number, ActResult>, violations: Violation[]): ScheduleResult {
  const overloads: Overload[] = [];
  for (const [wcId, cells] of ledger.entries()) {
    if (!ctx.wc.has(wcId)) continue;
    for (const [slot, c] of cells) {
      if (slot < state.now) continue;
      const cap = ctx.capacityAt(wcId, slot);
      if (c.load > cap + EPS) overloads.push({ workCenterId: wcId, slot, load: c.load, capacity: cap, activities: [...c.acts] });
    }
  }
  overloads.sort((a, b) => a.slot - b.slot || a.workCenterId - b.workCenterId);
  const milestones = computeMilestones(state, acts);
  const critical = new Set<number>();
  for (const m of milestones) {
    if (m.drivingActivityId === null || m.shipmentId !== null || m.visitId) continue;
    for (const n of drivingChain(state, acts, m.drivingActivityId)) critical.add(n.activityId);
  }
  return { acts, overloads, violations, milestones, critical, ledger };
}

const TAG_FOR: Record<MilestoneType, ActivityDef['milestoneTag']> = { EOL: 'EOL', EXW: 'PACK', COMM: 'COMM' };

export function computeMilestones(state: PlanState, acts: Map<number, { finish: Slot; confidence?: Confidence }>): MilestoneResult[] {
  const out: MilestoneResult[] = [];
  const byProject = topoByProject(state);
  const calc = (projectId: number, shipmentId: number | null, visitId: number | null, type: MilestoneType, list: ActivityDef[]) => {
    const rel = list.filter((a) => a.milestoneTag === TAG_FOR[type] && a.status !== 'CANCELLED');
    if (!rel.length) return;
    let forecast = -Infinity;
    let driving: number | null = null;
    let confidence: Confidence = 'FIRM';
    for (const a of rel) {
      const r = acts.get(a.id);
      if (!r) continue;
      if (a.status !== 'COMPLETED') confidence = worstConfidence(confidence, r.confidence ?? 'FIRM');
      if (r.finish > forecast) { forecast = r.finish; driving = a.id; }
    }
    const done = rel.filter((a) => a.status === 'COMPLETED').length;
    const complete = done === rel.length;
    const actual = complete ? Math.max(...rel.map((a) => a.actualFinish ?? -Infinity)) : null;
    out.push({
      projectId, shipmentId, visitId, type,
      forecast: Number.isFinite(forecast) ? forecast : null,
      actual: actual !== null && Number.isFinite(actual) ? actual : null,
      drivingActivityId: driving, complete, confidence: complete ? 'FIRM' : confidence, done, total: rel.length,
    });
  };
  for (const [pid, list] of byProject) {
    calc(pid, null, null, 'EOL', list);
    calc(pid, null, null, 'EXW', list);
    calc(pid, null, null, 'COMM', list);
    // ExWorks per delivery: packaging of the units in each shipment manifest.
    const shipments = new Set(list.filter((a) => a.milestoneTag === 'PACK').map((a) => a.shipmentId).filter((s): s is number => s !== null && s !== undefined));
    for (const sid of shipments) calc(pid, sid, null, 'EXW', list.filter((a) => a.shipmentId === sid));
    // Commissioning per site intervention.
    const visits = new Set(list.map((a) => a.visitId).filter((v): v is number => v !== null && v !== undefined));
    for (const vid of visits) calc(pid, null, vid, 'COMM', list.filter((a) => a.visitId === vid));
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
      // Continue along the technical predecessor (or held-resource source) that finished last.
      let best: number | null = null;
      let bf = -Infinity;
      for (const id of [...a.preds.map((p) => p.id), ...(a.holds ?? []).map((h) => h.fromActivityId)]) {
        const pr = acts.get(id);
        if (pr && pr.finish > bf) { bf = pr.finish; best = id; }
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
  const holdsFrom = new Map<number, { succ: number; resourceId: number; units: number }[]>();
  for (const a of own) for (const h of a.holds ?? []) {
    const l = holdsFrom.get(h.fromActivityId) ?? [];
    l.push({ succ: a.id, resourceId: h.resourceId, units: h.units });
    holdsFrom.set(h.fromActivityId, l);
  }
  const starts = new Map<number, Slot>();
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
    if (a.status === 'CANCELLED') { starts.set(a.id, lf); continue; }
    const pl = findBackward(ctx, ledger, a, lf);
    ledger.book(a.id, pl.bookings);
    // Keep held resources occupied until the follow-up activity starts.
    for (const h of holdsFrom.get(a.id) ?? []) {
      const s2 = starts.get(h.succ);
      if (s2 === undefined) continue;
      const gapB: Booking[] = [];
      for (let s = pl.finish; s < s2; s++) if (ledger.free(h.resourceId, s, h.units)) gapB.push([s, h.resourceId, h.units]);
      ledger.book(a.id, gapB);
    }
    starts.set(a.id, pl.start);
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
  /** FIRM, or CONDITIONAL/OPEN when the plan depends on unconfirmed readiness. */
  confidence: Confidence;
}

/**
 * Full Mode A initialization: backward plan, then a forward replay to confirm it against the
 * real forward rules (gates, holds and multi-resource phases can allocate differently forward than
 * backward). If the replay misses the anchor, the backward anchor is tightened and the plan is
 * regenerated. If no backward plan fits after `now`, an ASAP forward plan gives the earliest
 * achievable commissioning. A plan that depends on unknown inputs is returned as conditional.
 */
export function initialPlan(state: PlanState, projectId: number, maxIterations = 14): InitialPlan {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project || project.requiredFinish === null) throw new Error('Project has no required commissioning date');
  const target = project.requiredFinish;
  const own = state.activities.filter((a) => a.projectId === projectId);
  const commOf = (r: ScheduleResult) => r.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null && !m.visitId);
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
    const finish = commOf(result)?.forecast ?? -Infinity;
    return { ok: finish <= target, backwardFeasible: true, finish, starts: new Map(own.map((a) => [a.id, result.acts.get(a.id)!.start])), result };
  };
  let iterations = 0;
  let best: Trial | null = null;
  let bestAnchor = -Infinity;
  let failAnchor = Infinity;
  let anchor = target;
  while (iterations < maxIterations) {
    iterations++;
    const t = attempt(anchor);
    if (!t.backwardFeasible) break;
    if (t.ok) { best = t; bestAnchor = anchor; break; }
    failAnchor = anchor;
    anchor -= Math.max(1, t.finish - target);
  }
  while (best && Number.isFinite(failAnchor) && failAnchor - bestAnchor > 1 && iterations < maxIterations) {
    iterations++;
    const mid = Math.floor((bestAnchor + failAnchor) / 2);
    const t = attempt(mid);
    if (t.ok) { best = t; bestAnchor = mid; } else failAnchor = mid;
  }
  if (best) return { feasible: true, starts: best.starts!, result: best.result!, iterations, confidence: commOf(best.result!)?.confidence ?? 'FIRM' };
  const asap: PlanState = {
    ...state,
    pullIn: [...new Set([...state.pullIn, projectId])],
    activities: state.activities.map((a) => (a.projectId === projectId ? { ...a, approvedStart: null } : a)),
  };
  const result = forwardSchedule(asap);
  const starts = new Map(own.map((a) => [a.id, result.acts.get(a.id)!.start]));
  const comm = commOf(result);
  return { feasible: (comm?.forecast ?? Infinity) <= target, starts, result, iterations, confidence: comm?.confidence ?? 'FIRM' };
}
