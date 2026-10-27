import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { dayToIso } from '../engine/calendar.js';
import { freezeStatus, generateActivities, type RoutingStepDef } from '../engine/generate.js';
import { initialPlan } from '../engine/scheduler.js';
import { audit, getSetting, HttpError, requirePermission, todayDay, type AuthUser } from './common.js';
import { recalculate } from './recalc.js';
import { loadPlanState } from './state.js';

export const createProjectSchema = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2),
  customerId: z.number().int(),
  siteLocation: z.string().min(1),
  country: z.string().length(2),
  calendarId: z.number().int().nullable().optional(),
  routeId: z.number().int(),
  requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  lines: z.array(z.object({ productTypeId: z.number().int(), quantity: z.number().int().min(1).max(200) })).min(1),
});

export async function routingFor(db: Db, productTypeId: number): Promise<(RoutingStepDef & { id: number })[]> {
  const r = await db.query('SELECT * FROM routing_steps WHERE product_type_id = $1 ORDER BY seq', [productTypeId]);
  if (!r.rows.length) throw new HttpError(400, `Product type ${productTypeId} has no routing configured`);
  return r.rows.map((s) => ({
    id: s.id, seq: s.seq, code: s.code, name: s.name, function: s.function, workCenterId: s.work_center_id,
    durationSlots: s.duration_slots, scope: s.scope, kind: s.kind, predecessorSeqs: s.predecessor_seqs,
    milestoneTag: s.milestone_tag, useDestinationCalendar: s.use_destination_calendar,
  }));
}

/**
 * Create a customer project, expand it into per-unit activity flows and generate its initial
 * plan backward from the required commissioning date (Mode A). The accepted plan becomes the
 * committed baseline.
 */
export async function createProject(c: pg.PoolClient, user: AuthUser, input: z.infer<typeof createProjectSchema>) {
  await requirePermission(c, user, 'project.create');
  const route = (await c.query('SELECT * FROM routes WHERE id = $1', [input.routeId])).rows[0];
  if (!route) throw new HttpError(400, 'Unknown route');
  const prio = (await c.query(`SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM projects WHERE status = 'ACTIVE'`)).rows[0].p;
  const calendarId = input.calendarId ?? (await c.query('SELECT id FROM calendars WHERE country = $1 ORDER BY id LIMIT 1', [input.country])).rows[0]?.id ?? null;
  const p = (await c.query(
    `INSERT INTO projects (code, name, customer_id, site_location, country, calendar_id, route_id, required_commissioning_date, priority, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [input.code, input.name, input.customerId, input.siteLocation, input.country, calendarId, input.routeId, input.requiredDate, prio, input.notes ?? null, user.id],
  )).rows[0];
  const sh = (await c.query('INSERT INTO shipments (project_id, code, route_id) VALUES ($1,$2,$3) RETURNING id', [p.id, `${input.code}-SH1`, input.routeId])).rows[0];

  const units: { key: string; seq: number; shipmentKey: string; steps: RoutingStepDef[]; dbId: number }[] = [];
  const stepIds = new Map<string, number>();
  let seq = 0;
  for (const [i, line] of input.lines.entries()) {
    const pt = (await c.query('SELECT * FROM product_types WHERE id = $1', [line.productTypeId])).rows[0];
    if (!pt) throw new HttpError(400, `Unknown product type ${line.productTypeId}`);
    const steps = await routingFor(c, line.productTypeId);
    const ol = (await c.query('INSERT INTO order_lines (project_id, line_no, product_type_id, quantity) VALUES ($1,$2,$3,$4) RETURNING id',
      [p.id, i + 1, line.productTypeId, line.quantity])).rows[0];
    for (let q = 1; q <= line.quantity; q++) {
      seq++;
      const serial = `${pt.code}-${String(q).padStart(3, '0')}`;
      const u = (await c.query('INSERT INTO units (project_id, order_line_id, shipment_id, serial, seq) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [p.id, ol.id, sh.id, serial, seq])).rows[0];
      units.push({ key: String(u.id), seq, shipmentKey: String(sh.id), steps, dbId: u.id });
      for (const st of steps) stepIds.set(`${u.id}:${st.seq}`, st.id);
    }
  }
  const { acts, deps } = generateActivities(
    units,
    [{ key: String(sh.id), routeId: route.id, transportSlots: route.lead_time_days * 2, releaseLagSlots: route.release_lag_slots }],
    calendarId,
  );
  const idOf = new Map<string, number>();
  for (const g of acts) {
    const routingStepId = g.unitKey ? stepIds.get(`${g.unitKey}:${g.step.seq}`) : [...stepIds.entries()].find(([k]) => k.endsWith(`:${g.step.seq}`))?.[1];
    const r = await c.query(
      `INSERT INTO activities (project_id, unit_id, shipment_id, routing_step_id, seq, unit_seq, code, name, function, work_center_id,
         calendar_id, route_id, kind, milestone_tag, duration_slots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [p.id, g.unitKey ? Number(g.unitKey) : null, sh.id, routingStepId ?? null, g.step.seq, g.unitSeq, g.step.code,
        g.step.name, g.step.function, g.step.workCenterId, g.calendarId, g.routeId, g.step.kind,
        g.step.milestoneTag, g.durationSlots],
    );
    idOf.set(g.key, r.rows[0].id);
  }
  for (const d of deps) {
    await c.query('INSERT INTO dependencies (pred_id, succ_id, lag_slots) VALUES ($1,$2,$3)', [idOf.get(d.predKey), idOf.get(d.succKey), d.lag]);
  }

  const plan = await planInitial(c, user, p.id, 'Initial backward plan');
  await audit(c, {
    userId: user.id, action: 'project.create', changeClass: 'COMMERCIAL', entityType: 'project', entityId: p.id, projectId: p.id,
    planVersion: plan.version, after: { ...input, priority: prio, feasible: plan.feasible },
  });
  return { projectId: p.id, ...plan };
}

/** Mode A for an existing, not-yet-started project; commits the result as baseline. */
export async function planInitial(c: pg.PoolClient, user: AuthUser, projectId: number, summary: string) {
  const state = await loadPlanState(c);
  const plan = initialPlan(state, projectId);
  const own = state.activities.filter((a) => a.projectId === projectId);
  for (const a of own) a.approvedStart = plan.starts.get(a.id) ?? null;
  await c.query(`UPDATE activities a SET approved_start = v.s FROM (SELECT unnest($1::int[]) id, unnest($2::int[]) s) v WHERE a.id = v.id`,
    [own.map((a) => a.id), own.map((a) => a.approvedStart)]);
  const comm = plan.result.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null);
  await c.query('UPDATE projects SET plan_status = $2, earliest_commissioning_slot = $3 WHERE id = $1',
    [projectId, plan.feasible ? 'FEASIBLE' : 'INFEASIBLE', comm?.forecast ?? null]);
  const out = await recalculate(c, {
    userId: user.id, kind: 'INITIAL_PLAN', summary: `${summary} (${plan.feasible ? 'feasible' : 'infeasible'})`, state,
    approve: { activityIds: new Set(own.map((a) => a.id)), projectIds: new Set([projectId]), kind: 'BASELINE', reason: summary },
  });
  return { feasible: plan.feasible, earliestCommissioning: comm?.forecast ?? null, version: out.version };
}

export interface FreezeInfo {
  frozen: boolean;
  freezeStartDate: string | null;
  exworksDate: string | null;
}

/** Freeze evaluation always uses the persisted forecast ExWorks, never a simulated one. */
export async function freezeInfo(db: Db, projectIds?: number[]): Promise<Map<number, FreezeInfo>> {
  const freezeDays = await getSetting<number>(db, 'freeze_days', 21);
  const today = await todayDay(db);
  const r = await db.query(
    `SELECT p.id, m.shipment_id, m.forecast_slot, m.actual_slot FROM projects p
     LEFT JOIN milestones m ON m.project_id = p.id AND m.type = 'EXW'
     WHERE p.status = 'ACTIVE' ${projectIds ? 'AND p.id = ANY($1)' : ''}`,
    projectIds ? [projectIds] : [],
  );
  const out = new Map<number, FreezeInfo>();
  const byProject = new Map<number, typeof r.rows>();
  for (const row of r.rows) byProject.set(row.id, [...(byProject.get(row.id) ?? []), row]);
  for (const [pid, rows] of byProject) {
    // Relevant ExWorks: the earliest not-yet-shipped delivery (shipment level), else project level.
    const ship = rows.filter((x) => x.shipment_id !== null && x.actual_slot === null && x.forecast_slot !== null);
    const proj = rows.find((x) => x.shipment_id === null);
    const rel = ship.length ? ship.reduce((a, b) => (a.forecast_slot <= b.forecast_slot ? a : b)) : proj;
    const st = freezeStatus(rel?.forecast_slot ?? null, rel?.actual_slot ?? null, today, freezeDays);
    out.set(pid, {
      frozen: st.frozen,
      freezeStartDate: st.freezeStartDay !== null ? dayToIso(st.freezeStartDay) : null,
      exworksDate: st.exworksDay !== null ? dayToIso(st.exworksDay) : null,
    });
  }
  return out;
}
