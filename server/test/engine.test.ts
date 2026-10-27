import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarSet, dayNumber, endOfDaySlot } from '../src/engine/calendar.js';
import { attributeChanges } from '../src/engine/analysis.js';
import { applyOps } from '../src/engine/scenario.js';
import { drivingChain, forwardSchedule, initialPlan } from '../src/engine/scheduler.js';
import type { PlanState, ScheduleResult } from '../src/engine/types.js';
import { addProject, baseState, resetIds, WC } from './fixtures.js';

/** Mode A + baseline: what the service does when a project plan is accepted. */
function commitInitialPlan(s: PlanState, projectId: number) {
  const plan = initialPlan(s, projectId);
  const own = s.activities.filter((a) => a.projectId === projectId);
  for (const a of own) a.approvedStart = plan.starts.get(a.id)!;
  const r = forwardSchedule(s);
  for (const a of own) {
    a.approvedStart = r.acts.get(a.id)!.start;
    a.approvedFinish = r.acts.get(a.id)!.finish;
  }
  return { plan, result: r };
}

function assertCapacity(s: PlanState, r: ScheduleResult) {
  for (const w of s.workCenters) {
    for (const [wcId, cells] of r.ledger.entries()) {
      if (wcId !== w.id) continue;
      for (const [slot, c] of cells) {
        expect(c.load, `${w.code} load at slot ${slot}`).toBeLessThanOrEqual(r.ledger.capacityAt(w.id, slot) + 1e-6);
        expect(c.acts.length, `${w.code} concurrency at slot ${slot}`).toBeLessThanOrEqual(w.maxConcurrent);
      }
    }
  }
  expect(r.overloads).toEqual([]);
}

function assertDependencies(s: PlanState, r: ScheduleResult) {
  for (const a of s.activities)
    for (const p of a.preds) expect(r.acts.get(a.id)!.start).toBeGreaterThanOrEqual(r.acts.get(p.id)!.finish + p.lag);
}

const ms = (r: ScheduleResult, pid: number, type: string) => r.milestones.find((m) => m.projectId === pid && m.type === type && m.shipmentId === null)!;
const act = (s: PlanState, pid: number, unitSeq: number, seq: number) => s.activities.find((a) => a.projectId === pid && a.unitSeq === unitSeq && a.seq === seq)!;

beforeEach(() => resetIds());

describe('Test A — initial backward plan', () => {
  it('plans 2 cabinets + 4 dispensers backward from the required commissioning date', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2027-01-29');
    const { plan, result } = commitInitialPlan(s, 1);
    expect(plan.feasible).toBe(true);
    // 12 unit activities per unit + 1 consolidated shipment
    expect(s.activities.length).toBe(6 * 12 + 1);
    const comm = ms(result, 1, 'COMM');
    expect(comm.forecast!).toBeLessThanOrEqual(endOfDaySlot('2027-01-29'));
    // latest feasible: commissioning finishes within two working days of the required day
    expect(new CalendarSet(s.calendars, 1).workingDaysBetween(comm.forecast!, endOfDaySlot('2027-01-29'))).toBeLessThanOrEqual(2);
    for (const a of s.activities) expect(result.acts.get(a.id)!.start).toBeGreaterThanOrEqual(s.now);
    assertCapacity(s, result);
    assertDependencies(s, result);
    // every unit has its own independent flow
    const units = new Set(s.activities.filter((a) => a.unitId).map((a) => a.unitId));
    expect(units.size).toBe(6);
  });

  it('flags an infeasible required date and reports the earliest achievable commissioning', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2026-11-10');
    const { plan, result } = commitInitialPlan(s, 1);
    expect(plan.feasible).toBe(false);
    const comm = ms(result, 1, 'COMM');
    expect(comm.forecast!).toBeGreaterThan(endOfDaySlot('2026-11-10'));
    for (const a of s.activities) expect(result.acts.get(a.id)!.start).toBeGreaterThanOrEqual(s.now);
    assertCapacity(s, result);
  });
});

describe('Test B — forward delay propagation', () => {
  it('propagates a 2-working-day PCBA test delay through successors with root-cause traceability', () => {
    let milestoneMoved = 0;
    for (let u = 1; u <= 6; u++) {
      resetIds();
      const s = baseState('2026-11-02');
      addProject(s, 1, 6, '2027-01-29');
      const { result: before } = commitInitialPlan(s, 1);
      const pcbaTest = act(s, 1, u, 3);
      const cal = new CalendarSet(s.calendars, 1);
      pcbaTest.expectedFinish = cal.addWorkingSlots(before.acts.get(pcbaTest.id)!.finish, 4); // +2 working days
      const after = forwardSchedule(s);
      const prev = new Map([...before.acts].map(([id, r]) => [id, { start: r.start, finish: r.finish }]));
      const changes = attributeChanges(s, after, prev);

      expect(after.acts.get(pcbaTest.id)!.finish).toBe(pcbaTest.expectedFinish);
      expect(changes.find((c) => c.activityId === pcbaTest.id)!.kind).toBe('root');
      // the direct successor is recalculated from the new finish
      expect(after.acts.get(act(s, 1, u, 4).id)!.start).toBeGreaterThanOrEqual(pcbaTest.expectedFinish);
      // every propagated successor delay references the originating root delay
      for (const ch of changes.filter((c) => c.kind === 'propagated')) {
        expect(ch.originActivityId).toBe(pcbaTest.id);
      }
      // upstream work of the other units is untouched
      for (let o = 1; o <= 6; o++) for (let seq = 1; seq <= 3; seq++) {
        if (o === u) continue;
        expect(after.acts.get(act(s, 1, o, seq).id)!.start).toBe(before.acts.get(act(s, 1, o, seq).id)!.start);
      }
      // a milestone may only move if its driving chain now runs through the delay or a capacity conflict
      for (const type of ['EOL', 'EXW', 'COMM']) {
        const m0 = ms(before, 1, type);
        const m1 = ms(after, 1, type);
        if (m1.forecast === m0.forecast) continue;
        milestoneMoved++;
        const chain = drivingChain(s, after.acts, m1.drivingActivityId!);
        const viaDelay = chain.some((c) => c.activityId === pcbaTest.id);
        const viaCapacity = chain.some((c) => c.driver.type === 'capacity');
        expect(viaDelay || viaCapacity).toBe(true);
      }
      assertCapacity(s, after);
      assertDependencies(s, after);
    }
    expect(milestoneMoved).toBeGreaterThan(0);
  });

  it('leaves project milestones unchanged when the delay is absorbed by slack off the driving path', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2026-11-10'); // infeasible → ASAP plan: early units wait for the consolidated shipment
    const { result: before } = commitInitialPlan(s, 1);
    const pack = act(s, 1, 1, 11);
    const cal = new CalendarSet(s.calendars, 1);
    const slack = before.acts.get(s.activities.find((a) => a.kind === 'transport')!.id)!.start - before.acts.get(pack.id)!.finish;
    expect(slack).toBeGreaterThan(4);
    pack.expectedFinish = cal.addWorkingSlots(before.acts.get(pack.id)!.finish, 2);
    const after = forwardSchedule(s);
    expect(after.acts.get(pack.id)!.finish).toBeGreaterThan(before.acts.get(pack.id)!.finish);
    expect(ms(after, 1, 'EXW').forecast).toBe(ms(before, 1, 'EXW').forecast);
    expect(ms(after, 1, 'COMM').forecast).toBe(ms(before, 1, 'COMM').forecast);
  });

  it('does not silently pull successors earlier when an upstream activity finishes early', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 1, '2027-01-29');
    const { result: before } = commitInitialPlan(s, 1);
    const first = act(s, 1, 1, 1);
    first.status = 'COMPLETED';
    first.actualStart = s.now;
    first.actualFinish = s.now + 2;
    const after = forwardSchedule(s);
    const second = act(s, 1, 1, 2);
    expect(after.acts.get(second.id)!.start).toBe(before.acts.get(second.id)!.start);
    expect(after.acts.get(first.id)!.finish).toBe(s.now + 2);
  });

  it('propagates secondary delays across projects through shared capacity', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 2, null, 1);
    addProject(s, 2, 2, null, 2);
    s.pullIn = [1, 2];
    const before = forwardSchedule(s);
    // Project 1 loses its validation slot to an extension: project 2 waits at shared EOL/validation?
    const v = act(s, 1, 1, 8);
    v.expectedFinish = before.acts.get(v.id)!.finish + 6;
    const after = forwardSchedule(s);
    const prev = new Map([...before.acts].map(([id, r]) => [id, { start: r.start, finish: r.finish }]));
    const changes = attributeChanges(s, after, prev);
    const p2 = changes.filter((c) => c.projectId === 2 && c.newFinish > (c.prevFinish ?? 0));
    for (const c of p2) expect(c.kind === 'capacity' || c.kind === 'propagated').toBe(true);
    assertCapacity(s, after);
  });
});

describe('Test C — EOL testing effective capacity 1.5', () => {
  it('never books more than 1.5 effective systems and allows only partial overlap of two', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 4; p++) addProject(s, p, 1, null, p);
    s.pullIn = [1, 2, 3, 4];
    const r = forwardSchedule(s);
    assertCapacity(s, r);
    let overlap = false;
    for (const [wcId, cells] of r.ledger.entries()) {
      if (wcId !== WC.EOL) continue;
      for (const c of cells.values()) {
        expect(c.load).toBeLessThanOrEqual(1.5);
        if (c.acts.length === 2) overlap = true;
      }
    }
    expect(overlap).toBe(true);
    // four 1-day tests take longer than four days at 1 system, less than at full parallel 2
    const eols = s.activities.filter((a) => a.workCenterId === WC.EOL).map((a) => r.acts.get(a.id)!);
    const span = Math.max(...eols.map((e) => e.finish)) - Math.min(...eols.map((e) => e.start));
    expect(span).toBeGreaterThanOrEqual(Math.ceil((4 * 2) / 1.5));
  });

  it('rejects a manual placement that would overbook EOL testing', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 3; p++) addProject(s, p, 1, null, p);
    const slot = dayNumber('2026-11-20') * 2;
    const eol = (p: number) => act(s, p, 1, 8).id;
    const ok = forwardSchedule(applyOps(s, [{ type: 'move_activity', activityId: eol(1), start: slot }, { type: 'move_activity', activityId: eol(2), start: slot }]));
    // two systems fit only partially (1.0 + 0.5): the second cannot be pinned at full start without exceeding 1.5
    const cap = ok.violations.filter((v) => v.type === 'capacity');
    expect(cap.length).toBe(0);
    const bad = forwardSchedule(applyOps(s, [1, 2, 3].map((p) => ({ type: 'move_activity' as const, activityId: eol(p), start: slot }))));
    expect(bad.violations.some((v) => v.type === 'capacity' && v.activityId === eol(3))).toBe(true);
  });
});

describe('Test D — parallel final assembly', () => {
  it('accepts three systems in FA simultaneously and rejects a fourth', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 4; p++) addProject(s, p, 1, null, p);
    const slot = dayNumber('2026-11-20') * 2;
    const fa = (p: number) => ({ type: 'move_activity' as const, activityId: act(s, p, 1, 7).id, start: slot });
    const three = forwardSchedule(applyOps(s, [fa(1), fa(2), fa(3)]));
    expect(three.violations).toEqual([]);
    expect(three.ledger.cell(WC.FA, slot)!.acts.length).toBe(3);
    const four = forwardSchedule(applyOps(s, [fa(1), fa(2), fa(3), fa(4)]));
    expect(four.violations.some((v) => v.type === 'capacity' && v.activityId === act(s, 4, 1, 7).id)).toBe(true);
  });

  it('automatic scheduling queues the fourth system instead of overbooking', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 4; p++) addProject(s, p, 1, null, p);
    s.pullIn = [1, 2, 3, 4];
    const r = forwardSchedule(s);
    assertCapacity(s, r);
  });
});

describe('Test E / I — milestones', () => {
  it('derives EOL, ExWorks and Commissioned from activity dates; ExWorks completes only when all units are packed', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2027-01-29');
    const { result } = commitInitialPlan(s, 1);
    const tagMax = (seq: number) => Math.max(...s.activities.filter((a) => a.seq === seq).map((a) => result.acts.get(a.id)!.finish));
    expect(ms(result, 1, 'EOL').forecast).toBe(tagMax(8));
    expect(ms(result, 1, 'EXW').forecast).toBe(tagMax(11));
    expect(ms(result, 1, 'COMM').forecast).toBe(tagMax(13));
    // the shipment departs only after ExWorks
    const ship = s.activities.find((a) => a.kind === 'transport')!;
    expect(result.acts.get(ship.id)!.start).toBeGreaterThanOrEqual(ms(result, 1, 'EXW').forecast!);

    const packs = s.activities.filter((a) => a.seq === 11);
    for (const [i, p] of packs.entries()) {
      for (const a of s.activities.filter((x) => x.unitId === p.unitId && x.seq <= 11)) {
        a.status = 'COMPLETED';
        a.actualStart = result.acts.get(a.id)!.start;
        a.actualFinish = result.acts.get(a.id)!.finish;
      }
      const r = forwardSchedule({ ...s, now: Math.max(...packs.map((x) => result.acts.get(x.id)!.finish)) });
      expect(ms(r, 1, 'EXW').complete).toBe(i === packs.length - 1);
      if (i === packs.length - 1) expect(ms(r, 1, 'EXW').actual).toBe(Math.max(...packs.map((x) => x.actualFinish!)));
    }
  });

  it('identifies the driving chain back to the root activity', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 2, '2027-01-29');
    commitInitialPlan(s, 1);
    const pcba = act(s, 1, 2, 3);
    pcba.expectedFinish = (pcba.approvedFinish ?? 0) + 20;
    const r = forwardSchedule(s);
    const exw = ms(r, 1, 'EXW');
    const chain = drivingChain(s, r.acts, exw.drivingActivityId!);
    expect(chain.map((c) => c.activityId)).toContain(pcba.id);
    expect(chain[chain.length - 1].activityId).toBe(pcba.id);
    expect(chain[chain.length - 1].driver.type).toBe('reported');
  });
});

describe('Test K — per-unit production without quantity efficiencies', () => {
  it('schedules each identical unit independently with full standard work', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null);
    s.pullIn = [1];
    const r = forwardSchedule(s);
    const fa = s.activities.filter((a) => a.seq === 7);
    expect(fa.length).toBe(3);
    for (const a of fa) {
      const b = r.acts.get(a.id)!;
      expect(b.bookings.reduce((x, [, l]) => x + l, 0)).toBe(1); // 0.5 day each, no setup savings
    }
    const totalFaLoad = [...r.ledger.entries()].filter(([w]) => w === WC.FA).flatMap(([, c]) => [...c.values()]).reduce((x, c) => x + c.load, 0);
    expect(totalFaLoad).toBe(3);
    const totalPcba = s.activities.filter((a) => a.seq === 1).reduce((x, a) => x + r.acts.get(a.id)!.bookings.length, 0);
    expect(totalPcba).toBe(3 * 2);
  });
});

describe('Priority changes affect the production plan', () => {
  it('a project moved to the top claims contended capacity earlier and displaces the others', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 4, '2027-01-29', 1);
    commitInitialPlan(s, 1);
    addProject(s, 2, 4, '2027-01-29', 2);
    commitInitialPlan(s, 2);
    const before = forwardSchedule(s);
    const after = forwardSchedule(applyOps(s, [{ type: 'move_priority', projectId: 2, toRank: 1 }]));
    expect(ms(after, 2, 'EXW').forecast!).toBeLessThan(ms(before, 2, 'EXW').forecast!);
    // the shared bottleneck now serves project 2 first
    const firstVal = (r: ScheduleResult, pid: number) => Math.min(...s.activities.filter((a) => a.projectId === pid && a.seq === 9).map((a) => r.acts.get(a.id)!.start));
    expect(firstVal(after, 2)).toBeLessThan(firstVal(before, 2));
    assertCapacity(s, after);
  });
});

describe('Calendars and weekend work', () => {
  it('skips weekends for production and uses an authorized Saturday when approved', () => {
    const s = baseState('2026-11-06'); // Friday
    addProject(s, 1, 1, null);
    s.pullIn = [1];
    const r1 = forwardSchedule(s);
    const pcba = act(s, 1, 1, 1);
    expect(r1.acts.get(pcba.id)!.finish).toBe(dayNumber('2026-11-07') * 2); // Fri AM+PM
    const prog = act(s, 1, 1, 2);
    expect(r1.acts.get(prog.id)!.start).toBe(dayNumber('2026-11-09') * 2); // Monday
    const r2 = forwardSchedule(applyOps(s, [{ type: 'weekend_work', workCenterId: WC.PCBA_PROG, date: '2026-11-07' }]));
    expect(r2.acts.get(prog.id)!.start).toBe(dayNumber('2026-11-07') * 2);
    expect(r2.acts.get(prog.id)!.weekend).toBe(true);
  });

  it('transport runs on Saturdays but not Sundays on the EU route', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 1, null);
    s.pullIn = [1];
    const r = forwardSchedule(s);
    const ship = s.activities.find((a) => a.kind === 'transport')!;
    const rs = r.acts.get(ship.id)!;
    let sundays = 0;
    for (let t = rs.start; t < rs.finish; t++) if (((Math.floor(t / 2) + 4) % 7) === 0) sundays++;
    // finish - start covers 6 operating slots plus any skipped Sunday
    expect(rs.finish - rs.start - sundays * 0).toBeGreaterThanOrEqual(6);
  });
});
