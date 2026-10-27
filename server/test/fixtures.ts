import { dayNumber, endOfDaySlot } from '../src/engine/calendar.js';
import { generateActivities, type RoutingStepDef } from '../src/engine/generate.js';
import type { ActivityDef, PlanState, WorkCenterDef } from '../src/engine/types.js';

export const WC = {
  PCBA_MFG: 1, PCBA_PROG: 2, PCBA_TEST: 3, SUB_MFG: 4, SUB_TEST: 5, SUB_PROG: 6,
  FA: 7, EOL: 8, VAL: 9, PRECOMM: 10, PACK: 11, COMM: 12,
} as const;

export function workCenters(): WorkCenterDef[] {
  const d = (id: number, code: string, capacity: number, maxConcurrent = Math.ceil(capacity), minRate = 1): WorkCenterDef =>
    ({ id, code, name: code, capacity, maxConcurrent, minRate, calendarId: 1 });
  return [
    d(1, 'PCBA_MFG', 4), d(2, 'PCBA_PROG', 4), d(3, 'PCBA_TEST', 4), d(4, 'SUB_MFG', 4),
    d(5, 'SUB_TEST', 3), d(6, 'SUB_PROG', 3), d(7, 'FA', 3), d(8, 'EOL', 1.5, 2, 0.5),
    d(9, 'VAL', 2), d(10, 'PRECOMM', 2), d(11, 'PACK', 3), d(12, 'COMM', 2),
  ];
}

export function routing(): RoutingStepDef[] {
  const s = (seq: number, code: string, fn: string, wc: number | null, days: number, extra: Partial<RoutingStepDef> = {}): RoutingStepDef => ({
    seq, code, name: code, function: fn, workCenterId: wc, durationSlots: days * 2, scope: 'unit', kind: 'work',
    predecessorSeqs: null, milestoneTag: null, useDestinationCalendar: false, ...extra,
  });
  return [
    s(1, 'PCBA_MFG', 'MANUFACTURING', 1, 1), s(2, 'PCBA_PROG', 'TESTING', 2, 0.5), s(3, 'PCBA_TEST', 'TESTING', 3, 0.5),
    s(4, 'SUB_MFG', 'MANUFACTURING', 4, 1), s(5, 'SUB_TEST', 'TESTING', 5, 0.5), s(6, 'SUB_PROG', 'TESTING', 6, 0.5),
    s(7, 'FA', 'MANUFACTURING', 7, 0.5), s(8, 'EOL', 'TESTING', 8, 1, { milestoneTag: 'EOL' }), s(9, 'VAL', 'RND', 9, 2),
    s(10, 'PRECOMM', 'RND', 10, 0.5), s(11, 'PACK', 'MANUFACTURING', 11, 1, { milestoneTag: 'PACK' }),
    s(12, 'SHIP', 'LOGISTICS', null, 3, { scope: 'shipment', kind: 'transport' }),
    s(13, 'COMM', 'SERVICE', 12, 2, { milestoneTag: 'COMM', useDestinationCalendar: true }),
  ];
}

let nextId = 1;
export function resetIds() {
  nextId = 1;
}

/** Build activities for one project using the standard routing. */
export function projectActivities(projectId: number, unitCount: number, opts: { transportDays?: number } = {}): ActivityDef[] {
  const steps = routing();
  const units = Array.from({ length: unitCount }, (_, i) => ({ key: `${projectId}-${i + 1}`, seq: i + 1, shipmentKey: `${projectId}`, steps }));
  const { acts, deps } = generateActivities(units, [{ key: `${projectId}`, routeId: 1, transportSlots: (opts.transportDays ?? 3) * 2, releaseLagSlots: 0 }], null);
  const ids = new Map<string, number>();
  for (const g of acts) ids.set(g.key, nextId++);
  const unitIds = new Map(units.map((u, i) => [u.key, projectId * 1000 + i + 1]));
  return acts.map((g) => ({
    id: ids.get(g.key)!, projectId, unitId: g.unitKey ? unitIds.get(g.unitKey)! : null, shipmentId: projectId,
    workCenterId: g.step.workCenterId, calendarId: g.calendarId, routeId: g.routeId, kind: g.step.kind,
    name: `${g.step.code}${g.unitKey ? ' #' + g.unitSeq : ''}`, seq: g.step.seq, unitSeq: g.unitSeq,
    milestoneTag: g.step.milestoneTag, durationSlots: g.durationSlots, maxRate: 1, pctComplete: 0, status: 'NOT_STARTED',
    actualStart: null, actualFinish: null, approvedStart: null, approvedFinish: null, expectedFinish: null, locked: false,
    preds: deps.filter((d) => d.succKey === g.key).map((d) => ({ id: ids.get(d.predKey)!, lag: d.lag })),
  }));
}

export function baseState(now: string): PlanState {
  return {
    now: dayNumber(now) * 2,
    calendars: [{ id: 1, workingWeekdays: [1, 2, 3, 4, 5], holidays: [dayNumber('2026-12-08'), dayNumber('2026-12-25')] }],
    defaultCalendarId: 1,
    workCenters: workCenters(),
    weekendAuths: [],
    routes: [{ id: 1, operatesSaturday: true, operatesSunday: false, holidayCalendarIds: [] }],
    projects: [],
    activities: [],
    pullIn: [],
    pinned: [],
  };
}

export function addProject(s: PlanState, id: number, units: number, required: string | null, priority = id) {
  s.projects.push({ id, code: `P${id}`, priority, requiredFinish: required ? endOfDaySlot(required) : null });
  s.activities.push(...projectActivities(id, units));
}
