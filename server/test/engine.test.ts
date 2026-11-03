import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarSet, dayNumber, endOfDaySlot } from '../src/engine/calendar.js';
import { attributeChanges } from '../src/engine/analysis.js';
import { applyOps } from '../src/engine/scenario.js';
import { drivingChain, forwardSchedule, initialPlan } from '../src/engine/scheduler.js';
import type { ActivityDef, PlanState, ScheduleResult } from '../src/engine/types.js';
import { addProject, baseState, EOL_PHASED, resetIds, WC } from './fixtures.js';

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
  for (const [wcId, cells] of r.ledger.entries()) {
    if (wcId < 0) continue;
    for (const [slot, c] of cells) expect(c.load, `resource ${wcId} at slot ${slot}`).toBeLessThanOrEqual(r.ledger.capacityAt(wcId, slot) + 1e-6);
  }
  expect(r.overloads).toEqual([]);
}

function assertDependencies(s: PlanState, r: ScheduleResult) {
  for (const a of s.activities)
    for (const p of a.preds) expect(r.acts.get(a.id)!.start).toBeGreaterThanOrEqual(r.acts.get(p.id)!.finish + p.lag);
}

const ms = (r: ScheduleResult, pid: number, type: string) => r.milestones.find((m) => m.projectId === pid && m.type === type && m.shipmentId === null && !m.visitId)!;
const act = (s: PlanState, pid: number, unitSeq: number, seq: number) => s.activities.find((a) => a.projectId === pid && a.unitSeq === unitSeq && a.seq === seq)!;
const sysAct = (s: PlanState, pid: number, sys: number, code: string) => s.activities.find((a) => a.projectId === pid && a.systemId === pid * 100 + sys && a.code === code && a.scope === 'SYSTEM')!;
const slotsOn = (r: ScheduleResult, wc: number) => [...r.ledger.entries()].find(([w]) => w === wc)?.[1] ?? new Map();

beforeEach(() => resetIds());

describe('Test A — initial backward plan', () => {
  it('plans 2 cabinets + 4 dispensers (2 systems) backward from the required commissioning date', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2027-01-29');
    const { plan, result } = commitInitialPlan(s, 1);
    expect(plan.feasible).toBe(true);
    // 9 unit activities × 6 units, 4 system operations × 2 systems (not duplicated per unit),
    // 2 shipment activities, 1 installation + 1 commissioning per system
    expect(s.activities.length).toBe(6 * 9 + 2 * 4 + 2 + 1 + 2);
    const comm = ms(result, 1, 'COMM');
    expect(comm.forecast!).toBeLessThanOrEqual(endOfDaySlot('2027-01-29'));
    expect(new CalendarSet(s.calendars, 1).workingDaysBetween(comm.forecast!, endOfDaySlot('2027-01-29'))).toBeLessThanOrEqual(3);
    for (const a of s.activities) expect(result.acts.get(a.id)!.start).toBeGreaterThanOrEqual(s.now);
    assertCapacity(s, result);
    assertDependencies(s, result);
    expect(new Set(s.activities.filter((a) => a.unitId).map((a) => a.unitId)).size).toBe(6);
    // one validation per system, linked to all its units
    const vals = s.activities.filter((a) => a.code === 'VAL');
    expect(vals).toHaveLength(2);
    const setup = sysAct(s, 1, 1, 'VAL_SETUP');
    expect(setup.preds).toHaveLength(3);
    expect(comm.total).toBe(2);
    expect(comm.confidence).toBe('FIRM');
  });

  it('flags an infeasible required date and reports the earliest achievable commissioning', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2026-11-10');
    const { plan, result } = commitInitialPlan(s, 1);
    expect(plan.feasible).toBe(false);
    expect(ms(result, 1, 'COMM').forecast!).toBeGreaterThan(endOfDaySlot('2026-11-10'));
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
      pcbaTest.expectedFinish = cal.addWorkingSlots(before.acts.get(pcbaTest.id)!.finish, 4);
      const after = forwardSchedule(s);
      const prev = new Map([...before.acts].map(([id, r]) => [id, { start: r.start, finish: r.finish }]));
      const changes = attributeChanges(s, after, prev);
      expect(after.acts.get(pcbaTest.id)!.finish).toBe(pcbaTest.expectedFinish);
      expect(changes.find((c) => c.activityId === pcbaTest.id)!.kind).toBe('root');
      expect(after.acts.get(act(s, 1, u, 4).id)!.start).toBeGreaterThanOrEqual(pcbaTest.expectedFinish);
      for (const ch of changes.filter((c) => c.kind === 'propagated')) expect(ch.originActivityId).toBe(pcbaTest.id);
      for (let o = 1; o <= 6; o++) for (let seq = 1; seq <= 3; seq++) {
        if (o === u) continue;
        expect(after.acts.get(act(s, 1, o, seq).id)!.start).toBe(before.acts.get(act(s, 1, o, seq).id)!.start);
      }
      for (const type of ['EOL', 'EXW', 'COMM']) {
        if (ms(after, 1, type).forecast === ms(before, 1, type).forecast) continue;
        milestoneMoved++;
        const chain = drivingChain(s, after.acts, ms(after, 1, type).drivingActivityId!);
        expect(chain.some((c) => c.activityId === pcbaTest.id) || chain.some((c) => c.driver.type === 'capacity')).toBe(true);
      }
      assertCapacity(s, after);
      assertDependencies(s, after);
    }
    expect(milestoneMoved).toBeGreaterThan(0);
  });

  it('leaves project milestones unchanged when the delay is absorbed by slack', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2026-11-10'); // infeasible → ASAP plan: early units wait for the consolidated shipment
    const { result: before } = commitInitialPlan(s, 1);
    const ship = s.activities.find((a) => a.code === 'OUT_PREP')!;
    const packs = s.activities.filter((a) => a.code === 'PACK').sort((a, b) => before.acts.get(a.id)!.finish - before.acts.get(b.id)!.finish);
    const pack = packs[0];
    const slack = before.acts.get(ship.id)!.start - before.acts.get(pack.id)!.finish;
    expect(slack).toBeGreaterThan(2);
    pack.expectedFinish = new CalendarSet(s.calendars, 1).addWorkingSlots(before.acts.get(pack.id)!.finish, 1);
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
    expect(after.acts.get(act(s, 1, 1, 2).id)!.start).toBe(before.acts.get(act(s, 1, 1, 2).id)!.start);
  });

  it('propagates secondary delays across projects through shared capacity', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null, 1);
    addProject(s, 2, 3, null, 2);
    s.pullIn = [1, 2];
    const before = forwardSchedule(s);
    const v = act(s, 1, 1, 8);
    v.expectedFinish = before.acts.get(v.id)!.finish + 6;
    const after = forwardSchedule(s);
    const prev = new Map([...before.acts].map(([id, r]) => [id, { start: r.start, finish: r.finish }]));
    const changes = attributeChanges(s, after, prev);
    for (const c of changes.filter((c) => c.projectId === 2 && c.newFinish > (c.prevFinish ?? 0))) expect(['capacity', 'propagated']).toContain(c.kind);
    assertCapacity(s, after);
  });
});

describe('Test C — EOL testing resource profile', () => {
  it('conservative provisional profile: the shared power tester prevents any overlap', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 3; p++) addProject(s, p, 1, null, p);
    s.pullIn = [1, 2, 3];
    const r = forwardSchedule(s);
    assertCapacity(s, r);
    for (const c of slotsOn(r, WC.EOL_HV).values()) expect(c.load).toBeLessThanOrEqual(1);
    for (const c of slotsOn(r, WC.EOL_POS).values()) expect(c.acts.length).toBe(1);
  });

  it('Testing-defined phases allow partial overlap of two systems, never during the exclusive phase', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 4; p++) addProject(s, p, 1, null, p, { eol: EOL_PHASED });
    s.pullIn = [1, 2, 3, 4];
    const r = forwardSchedule(s);
    assertCapacity(s, r);
    let overlap = false;
    for (const c of slotsOn(r, WC.EOL_POS).values()) if (c.acts.length === 2) overlap = true;
    for (const c of slotsOn(r, WC.EOL_HV).values()) expect(c.acts.length).toBe(1);
    expect(overlap).toBe(true);
    // finishes earlier than the conservative no-overlap profile
    resetIds();
    const c = baseState('2026-11-02');
    for (let p = 1; p <= 4; p++) addProject(c, p, 1, null, p);
    c.pullIn = [1, 2, 3, 4];
    const rc = forwardSchedule(c);
    const lastEol = (st: PlanState, res: ScheduleResult) => Math.max(...st.activities.filter((a) => a.code === 'EOL').map((a) => res.acts.get(a.id)!.finish));
    expect(lastEol(s, r)).toBeLessThan(lastEol(c, rc));
  });

  it('rejects a manual placement that would overbook EOL testing', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 3; p++) addProject(s, p, 1, null, p, { eol: EOL_PHASED });
    const slot = dayNumber('2026-11-20') * 2;
    const eol = (p: number) => act(s, p, 1, 8).id;
    const ok = forwardSchedule(applyOps(s, [{ type: 'move_activity', activityId: eol(1), start: slot }, { type: 'move_activity', activityId: eol(2), start: slot + 1 }]));
    expect(ok.violations.filter((v) => v.type === 'capacity')).toHaveLength(0);
    const same = forwardSchedule(applyOps(s, [{ type: 'move_activity', activityId: eol(1), start: slot }, { type: 'move_activity', activityId: eol(2), start: slot }]));
    expect(same.violations.some((v) => v.type === 'capacity' && v.activityId === eol(2))).toBe(true);
    const third = forwardSchedule(applyOps(s, [
      { type: 'move_activity', activityId: eol(1), start: slot }, { type: 'move_activity', activityId: eol(2), start: slot + 1 }, { type: 'move_activity', activityId: eol(3), start: slot + 1 },
    ]));
    expect(third.violations.some((v) => v.type === 'capacity' && v.activityId === eol(3))).toBe(true);
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
    assertCapacity(s, forwardSchedule(s));
  });
});

describe('Test E / I — milestones', () => {
  it('derives EOL, ExWorks and Commissioned; ExWorks completes only when all units are packed', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2027-01-29');
    const { result } = commitInitialPlan(s, 1);
    const tagMax = (code: string) => Math.max(...s.activities.filter((a) => a.code === code).map((a) => result.acts.get(a.id)!.finish));
    expect(ms(result, 1, 'EOL').forecast).toBe(tagMax('EOL'));
    expect(ms(result, 1, 'EXW').forecast).toBe(tagMax('PACK'));
    expect(ms(result, 1, 'COMM').forecast).toBe(tagMax('COMM'));
    const ship = s.activities.find((a) => a.code === 'OUT_PREP')!;
    expect(result.acts.get(ship.id)!.start).toBeGreaterThanOrEqual(ms(result, 1, 'EXW').forecast!);
    const packs = s.activities.filter((a) => a.code === 'PACK');
    const lastPack = Math.max(...packs.map((x) => result.acts.get(x.id)!.finish));
    const before = (a: ActivityDef) => a.scope === 'UNIT' || a.scope === 'SYSTEM';
    for (const a of s.activities.filter((x) => before(x) && x.code !== 'PACK')) {
      a.status = 'COMPLETED'; a.actualStart = result.acts.get(a.id)!.start; a.actualFinish = result.acts.get(a.id)!.finish;
    }
    for (const [i, p] of packs.entries()) {
      p.status = 'COMPLETED'; p.actualStart = result.acts.get(p.id)!.start; p.actualFinish = result.acts.get(p.id)!.finish;
      const r = forwardSchedule({ ...s, now: lastPack });
      expect(ms(r, 1, 'EXW').complete).toBe(i === packs.length - 1);
      expect(ms(r, 1, 'EXW').done).toBe(i + 1);
    }
  });

  it('identifies the driving chain back to the root activity', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, '2027-01-29');
    commitInitialPlan(s, 1);
    const pcba = act(s, 1, 2, 3);
    pcba.expectedFinish = (pcba.approvedFinish ?? 0) + 20;
    const r = forwardSchedule(s);
    const chain = drivingChain(s, r.acts, ms(r, 1, 'EXW').drivingActivityId!);
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
    const fa = s.activities.filter((a) => a.code === 'FA');
    expect(fa.length).toBe(3);
    for (const a of fa) expect(r.acts.get(a.id)!.bookings.reduce((x, [, , l]) => x + l, 0)).toBe(1);
    const totalFaLoad = [...slotsOn(r, WC.FA).values()].reduce((x, c) => x + c.load, 0);
    expect(totalFaLoad).toBe(3);
  });
});

describe('Priority changes affect the production plan', () => {
  it('a project moved to the top claims contended capacity earlier and displaces the others', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 6, '2027-01-29', 1);
    commitInitialPlan(s, 1);
    addProject(s, 2, 6, '2027-01-29', 2);
    commitInitialPlan(s, 2);
    const before = forwardSchedule(s);
    const after = forwardSchedule(applyOps(s, [{ type: 'move_priority', projectId: 2, toRank: 1 }]));
    expect(ms(after, 2, 'EXW').forecast!).toBeLessThan(ms(before, 2, 'EXW').forecast!);
    assertCapacity(s, after);
  });

  it('tentative demand never displaces committed work, whatever its rank', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null, 2, {}, 0);
    addProject(s, 2, 3, null, 1, {}, 2); // tentative, ranked first
    s.pullIn = [1, 2];
    const r = forwardSchedule(s);
    const firstEol = (pid: number) => Math.min(...s.activities.filter((a) => a.projectId === pid && a.code === 'EOL').map((a) => r.acts.get(a.id)!.start));
    expect(firstEol(1)).toBeLessThan(firstEol(2));
  });
});

describe('Physical handovers and shared resources', () => {
  it('a completed validation keeps its skid until disconnection and removal; packaging waits for removal', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null, 1, { valSlots: 2 });
    s.pullIn = [1];
    const val = sysAct(s, 1, 1, 'VAL');
    const setup = sysAct(s, 1, 1, 'VAL_SETUP');
    const removal = sysAct(s, 1, 1, 'VAL_REMOVE');
    const plan = forwardSchedule(s);
    // validation done in the past; removal crew unavailable for the next two days
    for (const a of s.activities.filter((a) => a.scope === 'UNIT' && a.code !== 'PACK')) {
      a.status = 'COMPLETED'; a.actualStart = plan.acts.get(a.id)!.start - 40; a.actualFinish = plan.acts.get(a.id)!.finish - 40;
    }
    for (const a of [setup, val]) { a.status = 'COMPLETED'; a.actualStart = s.now - 4; a.actualFinish = s.now - 2 + (a === val ? 2 : 0); }
    setup.actualFinish = s.now - 3; val.actualStart = s.now - 3; val.actualFinish = s.now;
    s.reservations = [{ id: 1, resourceId: WC.CREW, start: s.now, finish: s.now + 4, units: 1, kind: 'MAINTENANCE' }];
    const r = forwardSchedule(s);
    const rr = r.acts.get(removal.id)!;
    expect(rr.start).toBe(s.now + 4);
    for (let t = s.now; t < rr.finish; t++) expect(r.ledger.cell(WC.SKID, t)?.acts).toContain(removal.id);
    const pack = s.activities.find((a) => a.code === 'PACK' && a.systemId === 101)!;
    expect(r.acts.get(pack.id)!.start).toBeGreaterThanOrEqual(rr.finish);
    expect(rr.flags).toContain('resource_held');
  });

  it('two skids that share a constrained supply cannot validate simultaneously', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null, 1, { valSlots: 16 });
    addProject(s, 2, 3, null, 2, { valSlots: 16 });
    s.pullIn = [1, 2];
    const free = forwardSchedule(s);
    const valOf = (r: ScheduleResult, p: number) => r.acts.get(sysAct(s, p, 1, 'VAL').id)!;
    const overlaps = (r: ScheduleResult) => valOf(r, 1).start < valOf(r, 2).finish && valOf(r, 2).start < valOf(r, 1).finish;
    expect(overlaps(free)).toBe(true);
    // the shared supply is reduced to one skid's worth (e.g. used for R&D troubleshooting)
    s.reservations = [{ id: 7, resourceId: WC.SKID_SUPPLY, start: s.now, finish: s.now + 200, units: 1, kind: 'TROUBLESHOOTING' }];
    const constrained = forwardSchedule(s);
    expect(overlaps(constrained)).toBe(false);
    assertCapacity(s, constrained);
  });
});

describe('Readiness gates and confidence', () => {
  it('pending material with a confirmed date constrains the first operation that needs it and makes the plan conditional', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null);
    s.pullIn = [1];
    const fa = act(s, 1, 1, 7);
    const firm = forwardSchedule(s);
    expect(ms(firm, 1, 'COMM').confidence).toBe('FIRM');
    const receipt = firm.acts.get(fa.id)!.start + 10;
    fa.gates = [{ id: 1, dimension: 'MATERIAL', title: 'DC contactor K1', status: 'PENDING', blocks: 'START', forecast: receipt, conditional: false }];
    const r = forwardSchedule(s);
    expect(r.acts.get(fa.id)!.start).toBeGreaterThanOrEqual(receipt);
    expect(r.acts.get(act(s, 1, 1, 6).id)!.start).toBe(firm.acts.get(act(s, 1, 1, 6).id)!.start); // unrelated PCBA/subassembly work unaffected
    expect(r.acts.get(fa.id)!.confidence).toBe('CONDITIONAL');
    expect(ms(r, 1, 'COMM').confidence).toBe('CONDITIONAL');
  });

  it('unknown readiness is never shown as firm; a blocker without a date makes the date open', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 3, null);
    s.pullIn = [1];
    const fa = act(s, 1, 2, 7);
    fa.gates = [{ id: 2, dimension: 'MATERIAL', title: 'Cooler', status: 'UNKNOWN', blocks: 'START', forecast: null, conditional: false }];
    expect(ms(forwardSchedule(s), 1, 'EXW').confidence).toBe('CONDITIONAL');
    fa.gates = [{ id: 2, dimension: 'QUALITY', title: 'Hold', status: 'BLOCKED', blocks: 'START', forecast: null, conditional: false }];
    const r = forwardSchedule(s);
    expect(r.acts.get(fa.id)!.confidence).toBe('OPEN');
    expect(ms(r, 1, 'COMM').confidence).toBe('OPEN');
    fa.gates = [{ id: 2, dimension: 'QUALITY', title: 'Hold', status: 'READY', blocks: 'START', forecast: null, conditional: false }];
    expect(ms(forwardSchedule(s), 1, 'COMM').confidence).toBe('FIRM');
  });

  it('an 80%-tested unit waiting for firmware keeps progressing but cannot complete before the release', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 1, null);
    s.pullIn = [1];
    const eol = act(s, 1, 1, 8);
    for (const a of s.activities.filter((a) => a.seq < 8 && a.scope === 'UNIT')) { a.status = 'COMPLETED'; a.actualStart = s.now - 20; a.actualFinish = s.now - 10; }
    eol.status = 'IN_PROGRESS'; eol.actualStart = s.now - 1; eol.pctComplete = 80; eol.progressSlot = s.now;
    eol.gates = [{ id: 3, dimension: 'SOFTWARE', title: 'FW 2.9.2.38 approved & available', status: 'PENDING', blocks: 'COMPLETE', forecast: null, conditional: false }];
    let r = forwardSchedule(s);
    expect(r.acts.get(eol.id)!.confidence).toBe('CONDITIONAL');
    eol.gates[0] = { ...eol.gates[0], forecast: s.now + 8 };
    r = forwardSchedule(s);
    expect(r.acts.get(eol.id)!.finish).toBeGreaterThanOrEqual(s.now + 8);
    expect(r.acts.get(eol.id)!.driver.type).toBe('gate');
    eol.gates[0] = { ...eol.gates[0], status: 'BLOCKED', forecast: null };
    expect(forwardSchedule(s).acts.get(eol.id)!.confidence).toBe('OPEN');
  });

  it('a manual move cannot place work before an unresolved readiness gate', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 1, null);
    const fa = act(s, 1, 1, 7);
    fa.gates = [{ id: 4, dimension: 'QUALITY', title: 'Unit blocked — rework required', status: 'BLOCKED', blocks: 'START', forecast: null, conditional: false }];
    const r = forwardSchedule(applyOps(s, [{ type: 'move_activity', activityId: fa.id, start: dayNumber('2026-11-10') * 2 }]));
    expect(r.violations.some((v) => v.type === 'readiness' && v.activityId === fa.id)).toBe(true);
  });
});

describe('Time-dependent capacity and partial deliveries', () => {
  it('a future capacity improvement only counts once it is in the executable capacity timeline', () => {
    const s = baseState('2026-11-02');
    for (let p = 1; p <= 3; p++) addProject(s, p, 1, null, p);
    s.pullIn = [1, 2, 3];
    const from = dayNumber('2026-11-16');
    const r = forwardSchedule(applyOps(s, [{ type: 'set_capacity', workCenterId: WC.EOL_HV, capacity: 2, fromDate: '2026-11-16' }]));
    for (const [slot, c] of slotsOn(r, WC.EOL_HV)) if (Math.floor(slot / 2) < from) expect(c.load).toBeLessThanOrEqual(1);
    expect(r.ledger.capacityAt(WC.EOL_HV, from * 2)).toBe(2);
    expect(r.ledger.capacityAt(WC.EOL_HV, from * 2 - 1)).toBe(1);
  });

  it('two systems delivered first are commissioned on their own visit; the project stays partially complete', () => {
    const s = baseState('2026-11-02');
    addProject(s, 1, 9, null, 1, { systems: [3, 3, 3], deliveries: [[0, 1], [2]] });
    s.pullIn = [1];
    const r = forwardSchedule(s);
    const visit1 = r.milestones.find((m) => m.type === 'COMM' && m.visitId === 16)!;
    const visit2 = r.milestones.find((m) => m.type === 'COMM' && m.visitId === 17)!;
    expect(visit1.total).toBe(2);
    expect(visit2.total).toBe(1);
    expect(visit1.forecast!).toBeLessThan(visit2.forecast!);
    const proj = ms(r, 1, 'COMM');
    expect(proj.total).toBe(3);
    expect(proj.forecast).toBe(visit2.forecast);
    const exw1 = r.milestones.find((m) => m.type === 'EXW' && m.shipmentId === 11)!;
    const exw2 = r.milestones.find((m) => m.type === 'EXW' && m.shipmentId === 12)!;
    expect(exw1.total).toBe(6);
    expect(exw2.total).toBe(3);
  });
});
