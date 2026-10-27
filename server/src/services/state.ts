import type { Db } from '../db/pool.js';
import { dayNumber, endOfDaySlot } from '../engine/calendar.js';
import type { ActivityDef, PlanState } from '../engine/types.js';
import { currentSlot, getSetting } from './common.js';

/** Load the persisted plan into the engine's pure state model. */
export async function loadPlanState(db: Db, opts: { now?: number } = {}): Promise<PlanState> {
  const now = opts.now ?? (await currentSlot(db));
  // Sequential on purpose: `db` may be a single transaction client.
  const qs = [
    'SELECT id, working_weekdays FROM calendars',
    'SELECT calendar_id, date FROM calendar_holidays',
    'SELECT * FROM work_centers ORDER BY route_order, id',
    'SELECT * FROM weekend_authorizations WHERE active',
    'SELECT * FROM routes',
    `SELECT id, code, priority, required_commissioning_date FROM projects WHERE status = 'ACTIVE'`,
    `SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE'`,
    `SELECT d.* FROM dependencies d JOIN activities a ON a.id = d.succ_id JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE'`,
  ];
  const out = [];
  for (const q of qs) out.push(await db.query(q));
  const [cals, hols, wcs, auths, routes, projects, acts, deps] = out;
  const holidays = new Map<number, number[]>();
  for (const h of hols.rows) {
    const l = holidays.get(h.calendar_id) ?? [];
    l.push(dayNumber(h.date));
    holidays.set(h.calendar_id, l);
  }
  const preds = new Map<number, { id: number; lag: number }[]>();
  for (const d of deps.rows) {
    const l = preds.get(d.succ_id) ?? [];
    l.push({ id: d.pred_id, lag: d.lag_slots });
    preds.set(d.succ_id, l);
  }
  const defaultCalendarId = await getSetting<number>(db, 'default_calendar_id', cals.rows[0]?.id ?? 1);
  return {
    now,
    calendars: cals.rows.map((c) => ({ id: c.id, workingWeekdays: c.working_weekdays, holidays: holidays.get(c.id) ?? [] })),
    defaultCalendarId,
    workCenters: wcs.rows.map((w) => ({
      id: w.id, code: w.code, name: w.name, capacity: Number(w.capacity), maxConcurrent: w.max_concurrent,
      minRate: Number(w.min_rate), calendarId: w.calendar_id,
    })),
    weekendAuths: auths.rows.map((a) => ({ id: a.id, workCenterId: a.work_center_id, activityId: a.activity_id, day: dayNumber(a.date), capacity: a.capacity === null ? null : Number(a.capacity) })),
    routes: routes.rows.map((r) => ({ id: r.id, operatesSaturday: r.operates_saturday, operatesSunday: r.operates_sunday, holidayCalendarIds: r.holiday_calendar_ids })),
    projects: projects.rows.map((p) => ({ id: p.id, code: p.code, priority: p.priority, requiredFinish: endOfDaySlot(p.required_commissioning_date) })),
    activities: acts.rows.map((a): ActivityDef => ({
      id: a.id, projectId: a.project_id, unitId: a.unit_id, shipmentId: a.shipment_id, workCenterId: a.work_center_id,
      calendarId: a.calendar_id, routeId: a.route_id, kind: a.kind, name: a.name, seq: a.seq, unitSeq: a.unit_seq,
      milestoneTag: a.milestone_tag, durationSlots: a.duration_slots, maxRate: Number(a.max_rate), pctComplete: a.pct_complete,
      status: a.status, actualStart: a.actual_start, actualFinish: a.actual_finish, approvedStart: a.approved_start,
      approvedFinish: a.approved_finish, expectedFinish: a.expected_finish, locked: a.locked, preds: preds.get(a.id) ?? [],
    })),
    pullIn: [],
    pinned: [],
  };
}
