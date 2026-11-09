/**
 * Transport-booking trigger: when a delivery's ExWorks date (packaging complete) comes within N days
 * (default 5) and its transport is not booked, Logistics receives a booking request for that shipment.
 * The request is closed by recording the booking on the shipment (reference required), never by
 * ticking it off; if ExWorks moves, the request follows the new date instead of disappearing.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { CalendarSet, dayOf, dayToIso } from '../engine/calendar.js';
import type { PlanState } from '../engine/types.js';
import { audit, getSetting } from './common.js';

export interface BookingTriggerPolicy { days: number; dayType: 'CALENDAR' | 'WORKING'; enabled: boolean }
export const DEFAULT_BOOKING_TRIGGER: BookingTriggerPolicy = { days: 5, dayType: 'CALENDAR', enabled: true };

export async function bookingTriggerPolicy(db: Db): Promise<BookingTriggerPolicy> {
  return { ...DEFAULT_BOOKING_TRIGGER, ...(await getSetting<Partial<BookingTriggerPolicy>>(db, 'logistics_booking_trigger', {})) };
}

/** Day on which the booking request is raised for a delivery reaching ExWorks on `exwDay`. */
export function triggerDayFor(exwDay: number, policy: BookingTriggerPolicy, isWorking: (d: number) => boolean) {
  if (policy.dayType === 'CALENDAR') return exwDay - policy.days;
  let d = exwDay;
  for (let n = 0; n < policy.days; ) { d--; if (isWorking(d)) n++; }
  return d;
}

export interface TriggeredBooking { actionId: number; shipmentId: number; code: string; project: string; exwDate: string; dueDate: string }

/** Create, update or close booking requests for every active delivery. Called by each recalculation. */
export async function syncBookingTriggers(c: pg.PoolClient, state: PlanState): Promise<TriggeredBooking[]> {
  const policy = await bookingTriggerPolicy(c);
  const cal = new CalendarSet(state.calendars, state.defaultCalendarId);
  const today = dayOf(state.now);
  const rows = (await c.query(`
    SELECT s.id, s.code, s.project_id, s.transport_booked, s.booking_ref, p.code project, p.status project_status, p.demand_status,
      m.forecast_slot, m.actual_slot, sp.name service, sp.booking_lead_days,
      (SELECT count(*) FROM units u WHERE u.shipment_id = s.id AND u.status = 'ACTIVE')::int units,
      (SELECT count(DISTINCT u.system_id) FROM units u WHERE u.shipment_id = s.id AND u.status = 'ACTIVE')::int systems,
      (SELECT a.status FROM activities a WHERE a.shipment_id = s.id AND a.code = 'TRANSIT' AND a.status <> 'CANCELLED' LIMIT 1) transit_status,
      (SELECT row_to_json(x) FROM action_items x WHERE x.kind = 'TRANSPORT_BOOKING' AND x.status = 'OPEN' AND x.related->>'shipmentId' = s.id::text LIMIT 1) open_action
    FROM shipments s JOIN projects p ON p.id = s.project_id
    LEFT JOIN milestones m ON m.shipment_id = s.id AND m.type = 'EXW' AND m.visit_id IS NULL
    LEFT JOIN service_profiles sp ON sp.id = s.service_profile_id`)).rows;
  const created: TriggeredBooking[] = [];
  for (const s of rows) {
    const open = s.open_action;
    const departed = s.transit_status === 'IN_PROGRESS' || s.transit_status === 'COMPLETED';
    if (open && (s.transport_booked || departed || s.project_status !== 'ACTIVE')) {
      const note = s.transport_booked ? `Transport booked${s.booking_ref ? ` (${s.booking_ref})` : ''}` : departed ? 'Shipment already dispatched' : 'Project no longer active';
      await c.query(`UPDATE action_items SET status = $2, closed_at = now(), details = COALESCE(details, '') || $3 WHERE id = $1`,
        [open.id, s.transport_booked || departed ? 'DONE' : 'CANCELLED', `\n${note}`]);
      continue;
    }
    if (!policy.enabled || s.transport_booked || departed || s.project_status !== 'ACTIVE') continue;
    const exwSlot = s.actual_slot ?? s.forecast_slot;
    if (exwSlot === null || exwSlot === undefined) continue;
    const exwDay = dayOf(exwSlot - 1);
    const trigger = triggerDayFor(exwDay, policy, (d) => cal.isWorkingDay(state.defaultCalendarId, d));
    if (today < trigger && !open) continue;
    const scope = `${s.systems ? `${s.systems} system${s.systems > 1 ? 's' : ''}, ` : ''}${s.units} unit${s.units === 1 ? '' : 's'}`;
    const title = `Book transport for ${s.code} (${scope}) — ExWorks ${dayToIso(exwDay)}`;
    const details = `Booking request raised ${policy.days} ${policy.dayType === 'WORKING' ? 'working' : 'calendar'} days before ExWorks. Service: ${s.service ?? 'default'}`
      + `${s.booking_lead_days ? ` (booking lead ${s.booking_lead_days} days)` : ''}.${s.demand_status !== 'COMMITTED' ? ' Demand is not committed yet — confirm before booking.' : ''}`
      + ' Close it by recording the booking reference on the shipment.';
    const related = { shipmentId: s.id, exwDate: dayToIso(exwDay), triggerDate: dayToIso(trigger), policy };
    if (!open) {
      const a = (await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, status, due_date, related, source)
        VALUES ('TRANSPORT_BOOKING',$1,$2,$3,'LOGISTICS','OPEN',$4,$5,'SYSTEM') RETURNING id`, [title, details, s.project_id, dayToIso(trigger), JSON.stringify(related)])).rows[0];
      await audit(c, { userId: null, action: 'logistics.booking_trigger', changeClass: 'LOGISTICS', entityType: 'shipment', entityId: s.id, projectId: s.project_id, after: related,
        reason: `ExWorks within ${policy.days} days and transport not booked` });
      created.push({ actionId: a.id, shipmentId: s.id, code: s.code, project: s.project, exwDate: dayToIso(exwDay), dueDate: dayToIso(trigger) });
    } else if (open.related?.exwDate !== related.exwDate) {
      // ExWorks moved: the request stays open and follows the new date (Logistics may already be working on it).
      await c.query(`UPDATE action_items SET title = $2, due_date = $3, related = $4, details = COALESCE(details, '') || $5 WHERE id = $1`,
        [open.id, title, dayToIso(trigger), JSON.stringify(related), `\nExWorks moved ${open.related?.exwDate ?? '?'} → ${related.exwDate}`]);
    }
  }
  return created;
}

/** Upcoming trigger date per shipment, for the outbound review. */
export async function bookingTriggerInfo(db: Db, state: PlanState) {
  const policy = await bookingTriggerPolicy(db);
  const cal = new CalendarSet(state.calendars, state.defaultCalendarId);
  return { policy, triggerFor: (exwSlot: number | null) => (exwSlot === null ? null : dayToIso(triggerDayFor(dayOf(exwSlot - 1), policy, (d) => cal.isWorkingDay(state.defaultCalendarId, d)))) };
}
