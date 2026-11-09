import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { dayToIso } from '../engine/calendar.js';
import { freezeStatus, type FreezePolicy } from '../engine/generate.js';
import { initialPlan } from '../engine/scheduler.js';
import { audit, getSetting, HttpError, requirePermission, todayDay, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';
import { createUnit, syncProjectGraph } from './graph.js';
import { bomRequirementsForUnit } from './materials.js';
import { recalculate } from './recalc.js';
import { loadPlanState } from './state.js';

const composition = z.array(z.object({ productTypeId: z.number().int(), quantity: z.number().int().min(0).max(200) }));
export const createProjectSchema = z.object({
  code: z.string().min(2).max(40),
  name: z.string().min(2),
  customerId: z.number().int(),
  siteLocation: z.string().min(1),
  country: z.string().length(2),
  calendarId: z.number().int().nullable().optional(),
  routeId: z.number().int(),
  serviceProfileId: z.number().int().nullable().optional(),
  requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  demandStatus: z.enum(['TENTATIVE', 'APPROVED', 'COMMITTED']).optional(),
  notes: z.string().optional(),
  lines: composition.optional(),
  systems: z.array(z.object({ code: z.string().optional(), composition })).optional(),
  loose: composition.optional(),
  deliveries: z.array(z.object({ systems: z.array(z.number().int()), serviceProfileId: z.number().int().nullable().optional() })).optional(),
  priority: z.number().int().optional(),
  meta: z.record(z.string(), z.any()).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/** Default system composition from order lines: one system per cabinet, outlets distributed evenly. */
export async function systemsFromLines(db: Db, lines: { productTypeId: number; quantity: number }[]) {
  const pts = new Map((await db.query('SELECT id, family FROM product_types')).rows.map((p) => [p.id, p.family]));
  const cabinets = lines.filter((l) => pts.get(l.productTypeId) === 'POWER_CABINET');
  const outlets = lines.filter((l) => pts.get(l.productTypeId) !== 'POWER_CABINET');
  const nCab = cabinets.reduce((s, l) => s + l.quantity, 0);
  if (!nCab) return { systems: [] as { code: string; composition: { productTypeId: number; quantity: number }[] }[], loose: lines };
  const systems: { code: string; composition: { productTypeId: number; quantity: number }[] }[] = [];
  const cabList = cabinets.flatMap((l) => Array(l.quantity).fill(l.productTypeId));
  for (let i = 0; i < nCab; i++) systems.push({ code: `SYS-${i + 1}`, composition: [{ productTypeId: cabList[i], quantity: 1 }] });
  for (const l of outlets) {
    for (let k = 0; k < l.quantity; k++) {
      const s = systems[k % nCab];
      const e = s.composition.find((x) => x.productTypeId === l.productTypeId);
      if (e) e.quantity++; else s.composition.push({ productTypeId: l.productTypeId, quantity: 1 });
    }
  }
  return { systems, loose: [] as { productTypeId: number; quantity: number }[] };
}

const DEFAULT_DOCS = ['Commercial invoice', 'Packing list', 'Delivery note'];

/**
 * Create a customer project: versioned configuration, complete systems, individually identified
 * units, shipment manifest(s) and commissioning visit(s); then plan it (Mode A for committed demand,
 * indicative forward plan for tentative/approved demand that must not displace committed work).
 */
export async function createProject(c: pg.PoolClient, user: AuthUser, input: CreateProjectInput, opts: { skipPlan?: boolean; source?: string } = {}) {
  await requirePermission(c, user, 'project.create');
  const route = (await c.query('SELECT * FROM routes WHERE id = $1', [input.routeId])).rows[0];
  if (!route) throw new HttpError(400, 'Unknown route');
  const demand = input.demandStatus ?? 'COMMITTED';
  if (demand === 'COMMITTED' && !input.requiredDate) throw new HttpError(422, 'Committed demand needs a required commissioning date');
  const prio = input.priority ?? (await c.query(`SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM projects WHERE status = 'ACTIVE'`)).rows[0].p;
  const calendarId = input.calendarId ?? (await c.query('SELECT id FROM calendars WHERE country = $1 ORDER BY id LIMIT 1', [input.country])).rows[0]?.id ?? null;
  const profile = input.serviceProfileId ?? (await c.query('SELECT id FROM service_profiles WHERE route_id = $1 ORDER BY service_level = \'STANDARD\' DESC, id LIMIT 1', [route.id])).rows[0]?.id ?? null;
  const meta = input.meta ?? {};
  const p = (await c.query(
    `INSERT INTO projects (code, name, customer_id, site_location, country, calendar_id, route_id, service_profile_id, required_commissioning_date, priority, demand_status, notes, created_by,
       required_commissioning_text, required_exw_text, wave, series, sap_order_ref, o2c_owner, spoc, rationale, customer_situation, mitigations, source, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING *`,
    [input.code, input.name, input.customerId, input.siteLocation, input.country, calendarId, input.routeId, profile, input.requiredDate ?? null, prio, demand, input.notes ?? null, user.id,
      meta.requiredCommissioningText ?? null, meta.requiredExwText ?? null, meta.wave ?? null, meta.series ?? null, meta.sapOrderRef ?? null, meta.o2cOwner ?? null, meta.spoc ?? null,
      meta.rationale ?? null, meta.customerSituation ?? null, meta.mitigations ?? null, opts.source ?? 'MANUAL', meta.sourceRef ?? null],
  )).rows[0];

  let systems = input.systems?.map((s, i) => ({ code: s.code ?? `SYS-${i + 1}`, composition: s.composition.filter((x) => x.quantity > 0) }));
  let loose = input.loose ?? [];
  if (!systems) ({ systems, loose } = await systemsFromLines(c, input.lines ?? []));
  const deliveries = input.deliveries?.length ? input.deliveries : [{ systems: systems.map((_, i) => i), serviceProfileId: null }];

  await c.query(`INSERT INTO project_configurations (project_id, version, status, source, systems, loose, scope_text, created_by, approved_by, approved_at, applied_at)
    VALUES ($1, 1, 'APPLIED', $2, $3, $4, $5, $6, $6, now(), now())`, [p.id, opts.source ?? 'MANUAL', JSON.stringify(systems), JSON.stringify(loose), meta.scopeText ?? null, user.id]);
  const totals = new Map<number, number>();
  for (const s of systems) for (const x of s.composition) totals.set(x.productTypeId, (totals.get(x.productTypeId) ?? 0) + x.quantity);
  for (const x of loose) totals.set(x.productTypeId, (totals.get(x.productTypeId) ?? 0) + x.quantity);
  const lineOf = new Map<number, number>();
  let ln = 0;
  for (const [pt, q] of totals) lineOf.set(pt, (await c.query('INSERT INTO order_lines (project_id, line_no, product_type_id, quantity) VALUES ($1,$2,$3,$4) RETURNING id', [p.id, ++ln, pt, q])).rows[0].id);

  const team = (await c.query(`SELECT w.id FROM work_centers w WHERE w.code = (SELECT CASE WHEN rg.code = 'NA' THEN 'COMM_NA' ELSE 'COMM_EU' END FROM routes r LEFT JOIN regions rg ON rg.id = r.region_id WHERE r.id = $1)`, [route.id])).rows[0]?.id ?? null;
  const shipIds: number[] = []; const visitIds: number[] = [];
  for (const [i, d] of deliveries.entries()) {
    const sp = d.serviceProfileId ?? profile;
    const customs = sp ? (await c.query('SELECT customs_days FROM service_profiles WHERE id = $1', [sp])).rows[0]?.customs_days : 0;
    const sh = (await c.query(`INSERT INTO shipments (project_id, code, seq, route_id, service_profile_id, destination) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.id, `${input.code}-SH${i + 1}`, i + 1, route.id, sp, input.siteLocation])).rows[0].id;
    for (const doc of [...DEFAULT_DOCS, ...(customs > 0 ? ['Customs declaration'] : [])]) await c.query('INSERT INTO shipment_documents (shipment_id, doc_type) VALUES ($1,$2)', [sh, doc]);
    shipIds.push(sh);
    visitIds.push((await c.query(`INSERT INTO commissioning_visits (project_id, code, site, installation_responsibility, team_resource_id) VALUES ($1,$2,$3,'Customer / installation partner',$4) RETURNING id`,
      [p.id, `${input.code}-V${i + 1}`, input.siteLocation, team])).rows[0].id);
  }
  let seq = 0;
  const unitIds: number[] = [];
  const pt = new Map((await c.query('SELECT id, code FROM product_types')).rows.map((x) => [x.id, x.code]));
  for (const [si, s] of systems.entries()) {
    const di = Math.max(0, deliveries.findIndex((d) => d.systems.includes(si)));
    const comp = s.composition.map((x) => `${x.quantity}× ${pt.get(x.productTypeId)}`).join(' + ');
    const sys = (await c.query('INSERT INTO systems (project_id, code, name, composition, visit_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [p.id, s.code, `${input.code} ${s.code}`, comp, visitIds[di]])).rows[0].id;
    for (const x of s.composition) for (let k = 0; k < x.quantity; k++) {
      const u = await createUnit(c, { projectId: p.id, productTypeId: x.productTypeId, systemId: sys, shipmentId: shipIds[di], orderLineId: lineOf.get(x.productTypeId), seq: ++seq, userId: user.id, source: opts.source ?? 'PLAN' });
      unitIds.push(u.id);
    }
  }
  for (const x of loose) for (let k = 0; k < x.quantity; k++) {
    const u = await createUnit(c, { projectId: p.id, productTypeId: x.productTypeId, shipmentId: shipIds[0], orderLineId: lineOf.get(x.productTypeId), seq: ++seq, userId: user.id, source: opts.source ?? 'PLAN' });
    unitIds.push(u.id);
  }
  await syncProjectGraph(c, p.id, 'Project created');
  for (const id of unitIds) await bomRequirementsForUnit(c, id);
  await syncDerivedGates(c, [p.id]);
  if (opts.skipPlan) return { projectId: p.id, feasible: null, earliestCommissioning: null, version: null, confidence: null };
  const plan = demand === 'COMMITTED' ? await planInitial(c, user, p.id, 'Initial backward plan') : await planIndicative(c, user, p.id);
  await audit(c, { userId: user.id, action: 'project.create', changeClass: 'COMMERCIAL', entityType: 'project', entityId: p.id, projectId: p.id,
    planVersion: plan.version, after: { ...input, priority: prio, feasible: plan.feasible, confidence: plan.confidence } });
  return { projectId: p.id, ...plan };
}

/** Mode A for an existing, not-yet-started committed project; commits the result as baseline. */
export async function planInitial(c: pg.PoolClient, user: AuthUser, projectId: number, summary: string) {
  const state = await loadPlanState(c);
  const plan = initialPlan(state, projectId);
  const own = state.activities.filter((a) => a.projectId === projectId && a.status !== 'COMPLETED');
  for (const a of own) a.approvedStart = plan.starts.get(a.id) ?? null;
  await c.query(`UPDATE activities a SET approved_start = v.s FROM (SELECT unnest($1::int[]) id, unnest($2::int[]) s) v WHERE a.id = v.id`,
    [own.map((a) => a.id), own.map((a) => a.approvedStart)]);
  const comm = plan.result.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null && !m.visitId);
  await c.query('UPDATE projects SET plan_status = $2, earliest_commissioning_slot = $3, plan_confidence = $4 WHERE id = $1',
    [projectId, plan.feasible ? 'FEASIBLE' : 'INFEASIBLE', comm?.forecast ?? null, plan.confidence]);
  const out = await recalculate(c, {
    userId: user.id, kind: 'INITIAL_PLAN', summary: `${summary} (${plan.feasible ? 'feasible' : 'infeasible'}${plan.confidence !== 'FIRM' ? ', conditional' : ''})`, state,
    approve: { activityIds: new Set(own.map((a) => a.id)), projectIds: new Set([projectId]), kind: 'BASELINE', reason: plan.confidence === 'FIRM' ? summary : `${summary} — conditional on unconfirmed readiness` },
  });
  return { feasible: plan.feasible, earliestCommissioning: comm?.forecast ?? null, version: out.version, confidence: plan.confidence };
}

/** Tentative / approved demand: indicative dates only, scheduled after committed work, no commitments. */
export async function planIndicative(c: pg.PoolClient, user: AuthUser, projectId: number) {
  await c.query(`UPDATE projects SET plan_status = 'INDICATIVE' WHERE id = $1`, [projectId]);
  const out = await recalculate(c, { userId: user.id, kind: 'INDICATIVE_PLAN', summary: 'Indicative plan for uncommitted demand' });
  const m = out.result.milestones.find((x) => x.projectId === projectId && x.type === 'COMM' && x.shipmentId === null && !x.visitId);
  await c.query('UPDATE projects SET earliest_commissioning_slot = $2, plan_confidence = $3 WHERE id = $1', [projectId, m?.forecast ?? null, m?.confidence ?? 'FIRM']);
  return { feasible: null, earliestCommissioning: m?.forecast ?? null, version: out.version, confidence: m?.confidence ?? 'FIRM' };
}

export interface ShipmentFreeze { shipmentId: number; code: string; frozen: boolean; freezeStartDate: string | null; exworksDate: string | null; frozenSince: string | null }
export interface FreezeInfo {
  frozen: boolean;
  freezeStartDate: string | null;
  exworksDate: string | null;
  shipments: ShipmentFreeze[];
  policy: FreezePolicy;
}

export async function freezePolicy(db: Db): Promise<FreezePolicy> {
  const legacy = await getSetting<number>(db, 'freeze_days', 21);
  const p = await getSetting<Partial<FreezePolicy>>(db, 'freeze_policy', {});
  return { days: p.days ?? legacy, inclusive: p.inclusive ?? true, persistent: p.persistent ?? true, scope: p.scope ?? 'SHIPMENT' };
}

/** Freeze evaluation always uses the persisted forecast ExWorks of each delivery, never a simulated one. */
export async function freezeInfo(db: Db, projectIds?: number[]): Promise<Map<number, FreezeInfo>> {
  const policy = await freezePolicy(db);
  const today = await todayDay(db);
  const r = await db.query(
    `SELECT p.id pid, s.id sid, s.code, s.frozen_since, m.forecast_slot, m.actual_slot FROM projects p
     LEFT JOIN shipments s ON s.project_id = p.id
     LEFT JOIN milestones m ON m.project_id = p.id AND m.type = 'EXW' AND m.shipment_id = s.id
     WHERE p.status = 'ACTIVE' ${projectIds ? 'AND p.id = ANY($1)' : ''} ORDER BY p.id, s.seq`, projectIds ? [projectIds] : []);
  const out = new Map<number, FreezeInfo>();
  for (const row of r.rows) {
    const fi = out.get(row.pid) ?? { frozen: false, freezeStartDate: null, exworksDate: null, shipments: [], policy };
    out.set(row.pid, fi);
    if (!row.sid) continue;
    const st = freezeStatus(row.forecast_slot ?? null, row.actual_slot ?? null, today, policy.days, policy.inclusive);
    const frozen = row.actual_slot === null && row.forecast_slot !== null && (st.frozen || (policy.persistent && row.frozen_since !== null));
    fi.shipments.push({ shipmentId: row.sid, code: row.code, frozen, freezeStartDate: st.freezeStartDay !== null ? dayToIso(st.freezeStartDay) : null,
      exworksDate: st.exworksDay !== null ? dayToIso(st.exworksDay) : null, frozenSince: row.frozen_since });
  }
  for (const fi of out.values()) {
    const open = fi.shipments.filter((s) => s.exworksDate);
    const first = open.reduce<ShipmentFreeze | null>((m, s) => (!m || (s.exworksDate! < m.exworksDate!) ? s : m), null);
    fi.frozen = fi.shipments.some((s) => s.frozen);
    fi.freezeStartDate = first?.freezeStartDate ?? null;
    fi.exworksDate = first?.exworksDate ?? null;
    if (policy.scope === 'PROJECT' && fi.frozen) for (const s of fi.shipments) s.frozen = s.exworksDate !== null;
  }
  return out;
}

/** Persist the moment a delivery first enters the freeze (persistent freezing). */
export async function persistFreeze(c: pg.PoolClient) {
  const info = await freezeInfo(c);
  for (const fi of info.values()) for (const s of fi.shipments) {
    if (s.frozen && !s.frozenSince) await c.query('UPDATE shipments SET frozen_since = CURRENT_DATE WHERE id = $1 AND frozen_since IS NULL', [s.shipmentId]);
  }
}

/**
 * Cancel a customer project: it leaves every view and the plan (its capacity is released at the next
 * recalculation), but nothing is erased — physical units, history, commitments and the audit trail stay,
 * and the project can be reactivated. A project with a frozen delivery needs the freeze-override authority.
 */
export async function cancelProject(c: pg.PoolClient, user: AuthUser, projectId: number, reason: string) {
  await requirePermission(c, user, 'project.cancel', 'Cancelling a project requires Commercial or Management / Program');
  if (!reason || reason.trim().length < 5) throw new HttpError(422, 'A reason is required to cancel a project', 'REASON_REQUIRED');
  const p = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  if (p.status !== 'ACTIVE') throw new HttpError(409, `Project is already ${p.status.toLowerCase()}`);
  const fz = (await freezeInfo(c, [projectId])).get(projectId);
  if (fz?.frozen) await requirePermission(c, user, 'freeze.override', 'This project has a delivery inside the freeze: only Management / Program can cancel it');
  const executed = Number((await c.query(`SELECT count(*) n FROM activities WHERE project_id = $1 AND status IN ('COMPLETED','IN_PROGRESS')`, [projectId])).rows[0].n);
  await c.query(`UPDATE projects SET status = 'CANCELLED', notes = COALESCE(notes || E'\\n', '') || $2 WHERE id = $1`,
    [projectId, `Cancelled ${new Date().toISOString().slice(0, 10)} by ${user.name}: ${reason.trim()}`]);
  await c.query(`UPDATE action_items SET status = 'CANCELLED', closed_by = $2, closed_at = now(), details = COALESCE(details, '') || E'\\nProject cancelled' WHERE project_id = $1 AND status = 'OPEN'`, [projectId, user.id]);
  await audit(c, { userId: user.id, action: 'project.cancel', changeClass: fz?.frozen ? 'OVERRIDE' : 'COMMERCIAL', entityType: 'project', entityId: projectId, projectId,
    before: { status: 'ACTIVE', priority: p.priority, frozen: !!fz?.frozen }, after: { status: 'CANCELLED', executedActivities: executed }, reason: reason.trim() });
  const out = await recalculate(c, { userId: user.id, kind: 'PROJECT_CANCEL', summary: `${p.code} cancelled by ${user.name}` });
  return { projectId, status: 'CANCELLED', version: out.version, frozen: !!fz?.frozen, executedActivities: executed };
}

/** Bring a cancelled project back into the plan (placed at the bottom of the ranking unless its old rank is free). */
export async function reactivateProject(c: pg.PoolClient, user: AuthUser, projectId: number, reason: string) {
  await requirePermission(c, user, 'project.cancel', 'Reactivating a project requires Commercial or Management / Program');
  if (!reason || reason.trim().length < 5) throw new HttpError(422, 'A reason is required to reactivate a project', 'REASON_REQUIRED');
  const p = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  if (p.status === 'ACTIVE') throw new HttpError(409, 'Project is already active');
  const prio = (await c.query(`SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM projects WHERE status = 'ACTIVE'`)).rows[0].p;
  await c.query(`UPDATE projects SET status = 'ACTIVE', priority = $2, notes = COALESCE(notes || E'\\n', '') || $3 WHERE id = $1`,
    [projectId, prio, `Reactivated ${new Date().toISOString().slice(0, 10)} by ${user.name}: ${reason.trim()}`]);
  await audit(c, { userId: user.id, action: 'project.reactivate', changeClass: 'COMMERCIAL', entityType: 'project', entityId: projectId, projectId,
    before: { status: p.status }, after: { status: 'ACTIVE', priority: prio }, reason: reason.trim() });
  const out = await recalculate(c, { userId: user.id, kind: 'PROJECT_REACTIVATE', summary: `${p.code} reactivated by ${user.name}` });
  return { projectId, status: 'ACTIVE', priority: prio, version: out.version };
}

export async function inactiveProjects(db: Db) {
  return (await db.query(`SELECT p.id, p.code, p.name, p.status, p.source, c.name customer,
      (SELECT a.ts FROM audit_events a WHERE a.project_id = p.id AND a.action = 'project.cancel' ORDER BY a.ts DESC LIMIT 1) cancelled_at,
      (SELECT a.reason FROM audit_events a WHERE a.project_id = p.id AND a.action = 'project.cancel' ORDER BY a.ts DESC LIMIT 1) reason,
      (SELECT u.name FROM audit_events a JOIN users u ON u.id = a.user_id WHERE a.project_id = p.id AND a.action = 'project.cancel' ORDER BY a.ts DESC LIMIT 1) cancelled_by
    FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.status <> 'ACTIVE' ORDER BY p.code`)).rows;
}
