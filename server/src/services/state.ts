import type { Db } from '../db/pool.js';
import { dayNumber, endOfDaySlot } from '../engine/calendar.js';
import type { ActivityDef, GateDef, PlanState } from '../engine/types.js';
import { currentSlot, getSetting } from './common.js';

const DEMAND_RANK: Record<string, number> = { COMMITTED: 0, APPROVED: 1, TENTATIVE: 2 };

/** Whether an approved conditional release currently applies. */
export function conditionalActive(cr: any, now: number): boolean {
  if (!cr || !cr.approvedBy) return false;
  if (cr.revokedAt) return false;
  if (cr.expirySlot != null && cr.expirySlot <= now) return false;
  return true;
}

/** Load the persisted plan into the engine's pure state model. */
export async function loadPlanState(db: Db, opts: { now?: number } = {}): Promise<PlanState> {
  const now = opts.now ?? (await currentSlot(db));
  // Sequential on purpose: `db` may be a single transaction client.
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
  const cals = await q('SELECT id, working_weekdays FROM calendars');
  const hols = await q('SELECT calendar_id, date FROM calendar_holidays');
  const wcs = await q('SELECT * FROM work_centers ORDER BY route_order, id');
  const changes = await q(`SELECT * FROM resource_capacity_changes WHERE status IN ('IMPLEMENTED','VERIFIED') ORDER BY effective_from`);
  const resv = await q(`SELECT * FROM resource_reservations WHERE status IN ('PLANNED','ACTIVE')`);
  const auths = await q('SELECT * FROM weekend_authorizations WHERE active');
  const routes = await q('SELECT * FROM routes');
  const projects = await q(`SELECT id, code, priority, required_commissioning_date, demand_status FROM projects WHERE status = 'ACTIVE'`);
  const acts = await q(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE'`);
  const deps = await q(`SELECT d.* FROM dependencies d JOIN activities a ON a.id = d.succ_id JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE'`);
  const holds = await q(`SELECT h.* FROM activity_holds h JOIN activities a ON a.id = h.activity_id JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE'`);
  const gates = await q(`SELECT g.* FROM readiness_gates g JOIN activities a ON a.id = g.activity_id JOIN projects p ON p.id = a.project_id
    WHERE p.status = 'ACTIVE' AND NOT g.awaiting_plan`);

  const holidays = new Map<number, number[]>();
  for (const h of hols) holidays.set(h.calendar_id, [...(holidays.get(h.calendar_id) ?? []), dayNumber(h.date)]);
  const preds = new Map<number, { id: number; lag: number }[]>();
  for (const d of deps) preds.set(d.succ_id, [...(preds.get(d.succ_id) ?? []), { id: d.pred_id, lag: d.lag_slots }]);
  const holdsOf = new Map<number, { fromActivityId: number; resourceId: number; units: number }[]>();
  for (const h of holds) holdsOf.set(h.activity_id, [...(holdsOf.get(h.activity_id) ?? []), { fromActivityId: h.from_activity_id, resourceId: h.work_center_id, units: Number(h.units) }]);
  const gatesOf = new Map<number, GateDef[]>();
  for (const g of gates) {
    gatesOf.set(g.activity_id, [...(gatesOf.get(g.activity_id) ?? []), {
      id: g.id, dimension: g.dimension, title: g.title, status: g.status, blocks: g.blocks, forecast: g.forecast_slot,
      conditional: conditionalActive(g.conditional_release, now),
    }]);
  }
  const defaultCalendarId = await getSetting<number>(db, 'default_calendar_id', cals[0]?.id ?? 1);
  return {
    now,
    calendars: cals.map((c) => ({ id: c.id, workingWeekdays: c.working_weekdays, holidays: holidays.get(c.id) ?? [] })),
    defaultCalendarId,
    workCenters: wcs.map((w) => ({ id: w.id, code: w.code, name: w.name, capacity: Number(w.capacity), calendarId: w.calendar_id })),
    capacityChanges: changes.map((c) => ({ resourceId: c.work_center_id, fromDay: dayNumber(c.effective_from), capacity: Number(c.capacity) })),
    reservations: resv.map((r) => ({ id: r.id, resourceId: r.work_center_id, start: r.start_slot, finish: r.finish_slot, units: Number(r.units), kind: r.kind })),
    weekendAuths: auths.map((a) => ({ id: a.id, workCenterId: a.work_center_id, activityId: a.activity_id, day: dayNumber(a.date), capacity: a.capacity === null ? null : Number(a.capacity) })),
    routes: routes.map((r) => ({ id: r.id, operatesSaturday: r.operates_saturday, operatesSunday: r.operates_sunday, holidayCalendarIds: r.holiday_calendar_ids })),
    projects: projects.map((p) => ({
      id: p.id, code: p.code, priority: p.priority, requiredFinish: p.required_commissioning_date ? endOfDaySlot(p.required_commissioning_date) : null,
      demandRank: DEMAND_RANK[p.demand_status] ?? 0,
    })),
    activities: acts.map((a): ActivityDef => ({
      id: a.id, projectId: a.project_id, unitId: a.unit_id, systemId: a.system_id, shipmentId: a.shipment_id, visitId: a.visit_id, scope: a.scope,
      workCenterId: a.work_center_id, calendarId: a.calendar_id, routeId: a.route_id, kind: a.kind, name: a.name, code: a.code, seq: a.seq,
      unitSeq: a.unit_seq, milestoneTag: a.milestone_tag, durationSlots: a.duration_slots, phases: a.phases ?? undefined,
      pctComplete: a.pct_complete, progressSlot: a.progress_slot, status: a.status, actualStart: a.actual_start, actualFinish: a.actual_finish,
      approvedStart: a.approved_start, approvedFinish: a.approved_finish, expectedFinish: a.expected_finish, locked: a.locked,
      preds: preds.get(a.id) ?? [], holds: holdsOf.get(a.id) ?? [], gates: gatesOf.get(a.id) ?? [],
    })),
    pullIn: [],
    pinned: [],
  };
}
