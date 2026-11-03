import { dayNumber, endOfDaySlot } from '../src/engine/calendar.js';
import { generateActivities, type StepTemplate } from '../src/engine/generate.js';
import type { ActivityDef, PhaseDef, PlanState, WorkCenterDef } from '../src/engine/types.js';

export const WC = {
  PCBA_MFG: 1, PCBA_PROG: 2, PCBA_TEST: 3, SUB_MFG: 4, SUB_TEST: 5, SUB_PROG: 6,
  FA: 7, EOL_POS: 8, EOL_HV: 9, SKID: 10, SKID_SUPPLY: 11, RND_TECH: 12, CREW: 13,
  PRECOMM: 14, PACK: 15, LOG: 16, COMM: 17,
} as const;

export function workCenters(): WorkCenterDef[] {
  const d = (id: number, code: string, capacity: number): WorkCenterDef => ({ id, code, name: code, capacity, calendarId: 1 });
  return [
    d(1, 'PCBA_MFG', 4), d(2, 'PCBA_PROG', 4), d(3, 'PCBA_TEST', 4), d(4, 'SUB_MFG', 4), d(5, 'SUB_TEST', 3), d(6, 'SUB_PROG', 3),
    d(7, 'FA', 3), d(8, 'EOL_POS', 2), d(9, 'EOL_HV', 1), d(10, 'SKID', 2), d(11, 'SKID_SUPPLY', 2), d(12, 'RND_TECH', 3),
    d(13, 'CREW', 1), d(14, 'PRECOMM', 2), d(15, 'PACK', 3), d(16, 'LOG', 2), d(17, 'COMM', 2),
  ];
}

const R = (resourceId: number, units = 1) => ({ resourceId, units });

/** Conservative provisional EOL profile: position + shared power tester for the whole test (no overlap). */
export const EOL_CONSERVATIVE: PhaseDef[] = [{ name: 'EOL test', slots: 2, resources: [R(WC.EOL_POS), R(WC.EOL_HV)] }];
/** A Testing-defined profile: preparation on the position only, power test needs the shared tester. */
export const EOL_PHASED: PhaseDef[] = [
  { name: 'Preparation & insulation checks', slots: 1, resources: [R(WC.EOL_POS)] },
  { name: 'Power / functional test', slots: 1, resources: [R(WC.EOL_POS), R(WC.EOL_HV)] },
];

export function steps(opts: { eol?: PhaseDef[]; valSlots?: number } = {}): StepTemplate[] {
  const s = (seq: number, code: string, fn: string, wc: number | null, slots: number, extra: Partial<StepTemplate> = {}): StepTemplate => ({
    seq, code, name: code, function: fn, scope: 'UNIT', stage: 'PRE', kind: 'work', workCenterId: wc, durationSlots: slots,
    phases: null, predecessorSeqs: null, milestoneTag: null, useDestinationCalendar: false, ...extra,
  });
  return [
    s(1, 'PCBA_MFG', 'MANUFACTURING', WC.PCBA_MFG, 2), s(2, 'PCBA_PROG', 'TESTING', WC.PCBA_PROG, 1), s(3, 'PCBA_TEST', 'TESTING', WC.PCBA_TEST, 1),
    s(4, 'SUB_MFG', 'MANUFACTURING', WC.SUB_MFG, 2), s(5, 'SUB_TEST', 'TESTING', WC.SUB_TEST, 1), s(6, 'SUB_PROG', 'TESTING', WC.SUB_PROG, 1),
    s(7, 'FA', 'MANUFACTURING', WC.FA, 1), s(8, 'EOL', 'TESTING', WC.EOL_POS, 2, { milestoneTag: 'EOL', phases: opts.eol ?? EOL_CONSERVATIVE }),
    s(101, 'VAL_SETUP', 'RND', WC.SKID, 1, { scope: 'SYSTEM', phases: [{ name: 'Setup & connection', slots: 1, resources: [R(WC.SKID), R(WC.RND_TECH)] }] }),
    s(102, 'VAL', 'RND', WC.SKID, opts.valSlots ?? 4, {
      scope: 'SYSTEM', phases: [{ name: 'System validation', slots: opts.valSlots ?? 4, resources: [R(WC.SKID), R(WC.SKID_SUPPLY)] }],
      holdFrom: { seq: 101, resourceId: WC.SKID, units: 1 },
    }),
    s(103, 'VAL_REMOVE', 'RND', WC.SKID, 1, {
      scope: 'SYSTEM', phases: [{ name: 'Disconnection & removal', slots: 1, resources: [R(WC.SKID), R(WC.CREW)] }],
      holdFrom: { seq: 102, resourceId: WC.SKID, units: 1 },
    }),
    s(104, 'PRECOMM', 'RND', WC.PRECOMM, 1, { scope: 'SYSTEM' }),
    s(201, 'PACK', 'MANUFACTURING', WC.PACK, 2, { stage: 'POST', milestoneTag: 'PACK' }),
    s(301, 'OUT_PREP', 'LOGISTICS', WC.LOG, 1, { scope: 'SHIPMENT' }),
    s(302, 'TRANSIT', 'LOGISTICS', null, 6, { scope: 'SHIPMENT', kind: 'transport' }),
    s(401, 'INSTALL', 'SERVICE', null, 4, { scope: 'SITE', kind: 'external' }),
    s(402, 'COMM', 'SERVICE', WC.COMM, 4, { scope: 'SITE_SYSTEM', milestoneTag: 'COMM' }),
  ];
}

let nextId = 1;
export function resetIds() {
  nextId = 1;
}

export interface ProjectShape {
  /** systems as lists of unit counts; default: one system per cabinet with 2 dispensers */
  systems?: number[];
  /** units without a system */
  loose?: number;
  /** split systems into shipments/visits: list of system indexes per delivery */
  deliveries?: number[][];
  eol?: PhaseDef[];
  valSlots?: number;
}

/** Build the activities of one project from the V4 templates. */
export function projectActivities(projectId: number, unitCount: number, shape: ProjectShape = {}): ActivityDef[] {
  const st = steps({ eol: shape.eol, valSlots: shape.valSlots });
  const unitSteps = st.filter((x) => x.scope === 'UNIT');
  const systemSizes = shape.systems ?? (unitCount >= 3 && unitCount % 3 === 0 ? Array(unitCount / 3).fill(3) : [unitCount]);
  const deliveries = shape.deliveries ?? [systemSizes.map((_, i) => i)];
  const units: { key: string; seq: number; systemKey: string | null; shipmentKey: string | null; steps: StepTemplate[] }[] = [];
  const systems: { key: string; seq: number; unitKeys: string[]; steps: StepTemplate[] }[] = [];
  let seq = 0;
  systemSizes.forEach((size, si) => {
    const keys: string[] = [];
    const ship = deliveries.findIndex((d) => d.includes(si));
    for (let i = 0; i < size; i++) {
      seq++;
      const key = `${projectId}-${seq}`;
      keys.push(key);
      units.push({ key, seq, systemKey: `${projectId}-S${si + 1}`, shipmentKey: `${projectId}-SH${ship + 1}`, steps: unitSteps });
    }
    systems.push({ key: `${projectId}-S${si + 1}`, seq: si + 1, unitKeys: keys, steps: st.filter((x) => x.scope === 'SYSTEM') });
  });
  for (let i = 0; i < (shape.loose ?? 0); i++) {
    seq++;
    units.push({ key: `${projectId}-${seq}`, seq, systemKey: null, shipmentKey: `${projectId}-SH1`, steps: unitSteps });
  }
  const shipments = deliveries.map((_, i) => ({ key: `${projectId}-SH${i + 1}`, routeId: 1, steps: st.filter((x) => x.scope === 'SHIPMENT') }));
  const visits = deliveries.map((sys, i) => ({
    key: `${projectId}-V${i + 1}`, systemKeys: sys.map((si) => `${projectId}-S${si + 1}`), shipmentKeys: [`${projectId}-SH${i + 1}`],
    steps: st.filter((x) => x.scope === 'SITE' || x.scope === 'SITE_SYSTEM'), calendarId: 1,
  }));
  const { acts, deps, holds } = generateActivities({ units, systems, shipments, visits, destinationCalendarId: 1 });
  const ids = new Map<string, number>();
  for (const g of acts) ids.set(g.key, nextId++);
  const num = (k: string | null, base: number) => (k ? base + Number(k.replace(/\D+/g, ' ').trim().split(' ').pop()) : null);
  return acts.map((g) => ({
    id: ids.get(g.key)!, projectId, unitId: num(g.unitKey, projectId * 1000), systemId: num(g.systemKey, projectId * 100),
    shipmentId: num(g.shipmentKey, projectId * 10), visitId: num(g.visitKey, projectId * 10 + 5), scope: g.scope,
    workCenterId: g.step.workCenterId, calendarId: g.calendarId, routeId: g.routeId, kind: g.step.kind, code: g.step.code,
    name: `${g.step.code}${g.unitKey ? ' #' + g.unitSeq : g.systemKey ? ' ' + g.systemKey : ''}`, seq: g.step.seq, unitSeq: g.unitSeq,
    milestoneTag: g.step.milestoneTag, durationSlots: g.durationSlots, phases: g.phases ?? undefined, pctComplete: 0, status: 'NOT_STARTED',
    actualStart: null, actualFinish: null, approvedStart: null, approvedFinish: null, expectedFinish: null, locked: false,
    preds: deps.filter((d) => d.succKey === g.key).map((d) => ({ id: ids.get(d.predKey)!, lag: d.lag })),
    holds: holds.filter((h) => h.succKey === g.key).map((h) => ({ fromActivityId: ids.get(h.fromKey)!, resourceId: h.resourceId, units: h.units })),
    gates: [],
  }));
}

export function baseState(now: string): PlanState {
  return {
    now: dayNumber(now) * 2,
    calendars: [{ id: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [dayNumber('2026-12-08'), dayNumber('2026-12-25')] }],
    defaultCalendarId: 1,
    workCenters: workCenters(),
    capacityChanges: [],
    reservations: [],
    weekendAuths: [],
    routes: [{ id: 1, operatesSaturday: true, operatesSunday: false, holidayCalendarIds: [] }],
    projects: [],
    activities: [],
    pullIn: [],
    pinned: [],
  };
}

export function addProject(s: PlanState, id: number, units: number, required: string | null, priority = id, shape: ProjectShape = {}, demandRank = 0) {
  s.projects.push({ id, code: `P${id}`, priority, requiredFinish: required ? endOfDaySlot(required) : null, demandRank });
  s.activities.push(...projectActivities(id, units, shape));
}
