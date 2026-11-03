import type pg from 'pg';
import { z } from 'zod';
import { pool, type Db } from '../db/pool.js';
import { CalendarSet, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import { simulate, STRUCTURAL_OPS, type ScenarioOp, type StructuralOp } from '../engine/scenario.js';
import type { PlanState } from '../engine/types.js';
import { audit, bumpInputs, can, currentVersion, HttpError, requirePermission, type AuthUser } from './common.js';
import { freezeInfo } from './projects.js';
import { recalculate } from './recalc.js';
import { loadPlanState } from './state.js';
import { applyStructuralOp, type StructuralOutcome } from './structural.js';

const slot = z.number().int();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_priority'), order: z.array(z.number().int()).min(1) }),
  z.object({ type: z.literal('move_priority'), projectId: z.number().int(), toRank: z.number().int().min(1) }),
  z.object({ type: z.literal('move_activity'), activityId: z.number().int(), start: slot, pullInSuccessors: z.boolean().optional() }),
  z.object({ type: z.literal('set_capacity'), workCenterId: z.number().int(), capacity: z.number().positive().max(100), maxConcurrent: z.number().int().optional(), fromDate: date.nullable().optional() }),
  z.object({ type: z.literal('include_capacity_change'), changeId: z.number().int(), workCenterId: z.number().int().optional(), capacity: z.number().optional(), fromDate: date.optional() }),
  z.object({ type: z.literal('weekend_work'), workCenterId: z.number().int().nullable().optional(), activityId: z.number().int().nullable().optional(), date, capacity: z.number().positive().nullable().optional() }),
  z.object({ type: z.literal('set_duration'), activityId: z.number().int(), durationSlots: z.number().int().min(0).max(400) }),
  z.object({ type: z.literal('apply_test_plan'), testPlanId: z.number().int(), activityIds: z.array(z.number().int()).min(1), durationSlots: z.number().int().optional() }),
  z.object({ type: z.literal('add_reservation'), workCenterId: z.number().int(), start: slot, finish: slot, units: z.number().positive(), kind: z.enum(['TROUBLESHOOTING', 'REGRESSION', 'TEST_DEV', 'SETUP', 'REMOVAL', 'MAINTENANCE', 'OTHER']), reason: z.string().optional() }),
  z.object({ type: z.literal('pull_in'), projectId: z.number().int() }),
  z.object({ type: z.literal('replan_backward'), projectId: z.number().int() }),
  z.object({ type: z.literal('reassign_unit'), unitId: z.number().int(), toProjectId: z.number().int(), replacesUnitId: z.number().int().nullable().optional(), reason: z.string().optional() }),
  z.object({ type: z.literal('add_rework'), reworkId: z.number().int() }),
  z.object({ type: z.literal('apply_configuration'), configurationId: z.number().int() }),
  z.object({ type: z.literal('regroup_units'), unitIds: z.array(z.number().int()).min(1), toShipmentId: z.number().int().nullable().optional(), newShipment: z.object({ code: z.string(), serviceProfileId: z.number().int().nullable().optional() }).nullable().optional() }),
  z.object({ type: z.literal('add_update_operation'), releaseId: z.number().int(), unitIds: z.array(z.number().int()).min(1), beforeCode: z.string().optional(), durationSlots: z.number().int().optional(), retest: z.boolean().optional() }),
  z.object({ type: z.literal('commit_demand'), projectId: z.number().int() }),
  z.object({ type: z.literal('split_visit'), systemIds: z.array(z.number().int()).min(1), visitCode: z.string().optional() }),
]);
export const scenarioSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  ops: z.array(opSchema).min(1).max(100),
  source: z.enum(['USER', 'AI', 'GANTT', 'DAILY_CALL']).optional(),
});

const OP_PERMISSION: Record<ScenarioOp['type'], string> = {
  set_priority: 'scenario.op.priority', move_priority: 'scenario.op.priority',
  move_activity: 'scenario.op.schedule', set_duration: 'scenario.op.schedule', pull_in: 'scenario.op.schedule', replan_backward: 'scenario.op.schedule',
  regroup_units: 'scenario.op.schedule', split_visit: 'scenario.op.schedule', apply_test_plan: 'scenario.op.schedule',
  set_capacity: 'scenario.op.capacity', include_capacity_change: 'scenario.op.capacity', weekend_work: 'scenario.op.capacity', add_reservation: 'scenario.op.capacity',
  apply_configuration: 'scenario.op.configuration', commit_demand: 'scenario.op.configuration',
  reassign_unit: 'scenario.op.reassign', add_rework: 'scenario.op.rework', add_update_operation: 'scenario.op.rework',
};

async function checkOpPermissions(db: Db, user: AuthUser, ops: ScenarioOp[]) {
  for (const t of new Set(ops.map((o) => o.type))) {
    await requirePermission(db, user, OP_PERMISSION[t], `Role ${user.role} may not include "${t}" changes in a scenario`);
  }
}

const TEST_ACTIVITY_CODES = new Set(['EOL', 'VAL', 'RVAL', 'RW_RETEST', 'SW_RETEST']);

/** Resolve references (test plans, capacity changes) and enforce rules that no schedule approval can bypass. */
async function prepareOps(c: pg.PoolClient, ops: ScenarioOp[], base: PlanState): Promise<ScenarioOp[]> {
  const out: ScenarioOp[] = [];
  for (const op of ops) {
    if (op.type === 'apply_test_plan') {
      const tp = (await c.query('SELECT * FROM test_plans WHERE id = $1', [op.testPlanId])).rows[0];
      if (!tp) throw new HttpError(404, 'Test plan not found');
      if (tp.status !== 'APPROVED') throw new HttpError(422, `Test scope "${tp.name}" v${tp.version} is ${tp.status.toLowerCase()}: a duration change needs an approved test scope`, 'TEST_SCOPE_NOT_APPROVED');
      out.push({ ...op, durationSlots: tp.duration_slots });
    } else if (op.type === 'set_duration') {
      const a = base.activities.find((x) => x.id === op.activityId);
      if (a && TEST_ACTIVITY_CODES.has(a.code ?? '') && op.durationSlots < a.durationSlots) {
        throw new HttpError(422, 'Test durations can only be reduced through an approved change of test scope (apply_test_plan), not by a schedule change', 'TEST_SCOPE_REQUIRED');
      }
      out.push(op);
    } else if (op.type === 'include_capacity_change') {
      const ch = (await c.query('SELECT * FROM resource_capacity_changes WHERE id = $1', [op.changeId])).rows[0];
      if (!ch) throw new HttpError(404, 'Capacity change not found');
      out.push({ ...op, workCenterId: ch.work_center_id, capacity: Number(ch.capacity), fromDate: dayToIso(Math.round(Date.parse(ch.effective_from) / 86400000)) });
    } else out.push(op);
  }
  return out;
}

export interface SimulationResult {
  baseVersion: number;
  now: number;
  simulatedAt: string;
  projects: {
    id: number; code: string; name: string; customer: string; priorityBefore: number; priorityAfter: number;
    frozen: boolean; freezeStartDate: string | null; requiredDate: string | null; demandStatus: string;
    milestones: Record<string, { approved: number | null; before: number | null; after: number | null; deltaDays: number; beforeLabel: string; afterLabel: string; approvedLabel: string; confidenceBefore: string; confidenceAfter: string }>;
    changedActivities: number; impacted: boolean; delayed: boolean; improved: boolean; lateVsRequired: boolean;
  }[];
  changedActivities: { activityId: number; projectId: number; name: string; unit: string | null; beforeStart: number; afterStart: number; beforeFinish: number; afterFinish: number; deltaDays: number }[];
  addedActivities: { activityId: number; projectId: number; name: string; unit: string | null; start: number; finish: number }[];
  removedActivities: { activityId: number; projectId: number; name: string; unit: string | null }[];
  displaced: { activityId: number; projectId: number; name: string; byProjects: number[]; delayDays: number }[];
  capacityShifts: { workCenterId: number; workCenter: string; projectId: number; beforeSlots: number; afterSlots: number }[];
  violations: { activityId: number; type: string; message: string }[];
  structural: StructuralOutcome[];
  impactedShipments: { shipmentId: number; code: string; projectId: number; frozen: boolean }[];
  overloadsBefore: number;
  overloadsAfter: number;
  impactedProjects: number[];
  frozenImpacted: number[];
  inputVersions: Record<string, number>;
  requiresManagement: boolean;
  requiresReason: boolean;
  reasons: string[];
  summary: string;
}

async function withSimulationTx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const isClient = typeof (db as pg.PoolClient).release === 'function';
  if (!isClient) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const c = db as pg.PoolClient;
  await c.query('SAVEPOINT simulation');
  try {
    return await fn(c);
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT simulation').catch(() => {});
    await c.query('RELEASE SAVEPOINT simulation').catch(() => {});
  }
}

async function ownership(c: pg.PoolClient) {
  const units = (await c.query('SELECT id, project_id, system_id, shipment_id, internal_id, name FROM units')).rows;
  const systems = (await c.query('SELECT id, visit_id FROM systems')).rows;
  const shipments = (await c.query('SELECT id, code, project_id FROM shipments')).rows;
  return { units, systems, shipments };
}

/**
 * Deterministic what-if evaluation. Structural operations are applied inside a savepoint and rolled
 * back; nothing is persisted. The freeze is evaluated on the persisted forecast before any change.
 */
export async function evaluate(db: Db, user: AuthUser, rawOps: ScenarioOp[], opts: { recovery?: boolean } = {}): Promise<SimulationResult> {
  return withSimulationTx(db, async (c) => {
    let base = await loadPlanState(c);
    const ops = await prepareOps(c, rawOps, base);
    const freeze = await freezeInfo(c);
    const versions = Object.fromEntries((await c.query(`SELECT id, input_version FROM projects WHERE status = 'ACTIVE'`)).rows.map((r) => [String(r.id), r.input_version]));
    const ownBefore = await ownership(c);
    const namesBefore = new Map((await c.query('SELECT a.id, a.name, u.internal_id, u.name unit_name FROM activities a LEFT JOIN units u ON u.id = a.unit_id')).rows.map((r) => [r.id, r]));
    const structural: StructuralOutcome[] = [];
    let structuralBase: PlanState | undefined;
    const structuralOps = ops.filter((o) => STRUCTURAL_OPS.has(o.type)) as StructuralOp[];
    for (const op of structuralOps) {
      try { structural.push(await applyStructuralOp(c, user, op)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(422, (e as Error).message, 'INVALID_SCENARIO'); }
    }
    if (structuralOps.length) structuralBase = await loadPlanState(c);
    if (opts.recovery) {
      base = { ...base, pullIn: base.projects.map((p) => p.id) };
      if (structuralBase) structuralBase = { ...structuralBase, pullIn: structuralBase.projects.map((p) => p.id) };
    }
    let sim: ReturnType<typeof simulate>;
    try { sim = simulate(base, ops, structuralBase); } catch (e) { throw new HttpError(422, (e as Error).message, 'INVALID_SCENARIO'); }
    const { before, after, afterState, comparison } = sim;
    const ownAfter = await ownership(c);
    const names = new Map((await c.query('SELECT a.id, a.name, u.internal_id, u.name unit_name FROM activities a LEFT JOIN units u ON u.id = a.unit_id')).rows.map((r) => [r.id, r]));
    for (const [k, v] of namesBefore) if (!names.has(k)) names.set(k, v);
    const meta = (await c.query(`SELECT p.id, p.code, p.name, p.required_commissioning_date AS req, p.demand_status, c.name AS customer FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.status = 'ACTIVE'`)).rows;
    const wcNames = new Map((await c.query('SELECT id, name FROM work_centers')).rows.map((r) => [r.id, r.name]));
    const approved = new Map((await c.query(`SELECT project_id, type, approved_slot FROM milestones WHERE shipment_id IS NULL AND visit_id IS NULL`)).rows.map((r) => [`${r.project_id}:${r.type}`, r.approved_slot]));
    const cal = new CalendarSet(base.calendars, base.defaultCalendarId);
    const wd = (a: number | null, b: number | null) => (a === null || b === null ? 0 : cal.workingDaysBetween(a, b));

    // Which deliveries each activity belongs to (before and after structural changes).
    const shipmentsOf = (actId: number, st: PlanState, own: Awaited<ReturnType<typeof ownership>>) => {
      const a = st.activities.find((x) => x.id === actId);
      if (!a) return [] as number[];
      if (a.scope === 'SHIPMENT' || (a.scope === 'UNIT' && a.shipmentId)) return a.shipmentId ? [a.shipmentId] : [];
      if (a.scope === 'SYSTEM') return own.units.filter((u) => u.system_id === a.systemId && u.shipment_id).map((u) => u.shipment_id as number);
      if (a.scope === 'SITE') {
        const sys = own.systems.filter((s) => s.visit_id === a.visitId).map((s) => s.id);
        return own.units.filter((u) => sys.includes(u.system_id) && u.shipment_id).map((u) => u.shipment_id as number);
      }
      return [];
    };
    const impactedShip = new Set<number>();
    const touch = (id: number) => {
      for (const s of shipmentsOf(id, base, ownBefore)) impactedShip.add(s);
      for (const s of shipmentsOf(id, afterState, ownAfter)) impactedShip.add(s);
    };
    for (const ch of comparison.changedActivities) touch(ch.activityId);
    for (const ch of comparison.addedActivities) touch(ch.activityId);
    for (const ch of comparison.removedActivities) touch(ch.activityId);
    // Project-level discretionary changes touch every delivery of the project.
    const targeted = new Set<number>();
    const projOf = new Map(base.activities.map((a) => [a.id, a.projectId]));
    for (const op of ops) {
      if ('projectId' in op && op.type !== 'pull_in') targeted.add(op.projectId);
      if (op.type === 'pull_in') targeted.add(op.projectId);
      if ('activityId' in op && op.activityId) { const p = projOf.get(op.activityId); if (p) targeted.add(p); }
      if (op.type === 'reassign_unit') { targeted.add(op.toProjectId); const u = ownBefore.units.find((x) => x.id === op.unitId); if (u?.project_id) targeted.add(u.project_id); }
      if (op.type === 'apply_test_plan') for (const id of op.activityIds) { const p = projOf.get(id); if (p) targeted.add(p); }
    }
    for (const s of structural) for (const p of s.projects) targeted.add(p);
    for (const pc of comparison.priorityChanges) targeted.add(pc.projectId);
    const wholeProject = new Set<number>([...comparison.priorityChanges.map((p) => p.projectId),
      ...ops.filter((o) => o.type === 'apply_configuration' || o.type === 'commit_demand').flatMap((o) => (o.type === 'commit_demand' ? [o.projectId] : structural.flatMap((s) => s.projects)))]);
    for (const sh of ownBefore.shipments) if (wholeProject.has(sh.project_id)) impactedShip.add(sh.id);
    const shipMeta = new Map([...ownBefore.shipments, ...ownAfter.shipments].map((s) => [s.id, s]));
    const frozenShip = new Set<number>();
    for (const fi of freeze.values()) for (const s of fi.shipments) if (s.frozen) frozenShip.add(s.shipmentId);
    const impactedShipments = [...impactedShip].filter((id) => shipMeta.has(id)).map((id) => ({ shipmentId: id, code: shipMeta.get(id)!.code, projectId: shipMeta.get(id)!.project_id, frozen: frozenShip.has(id) }));
    const impacted = new Set([...comparison.impactedProjects, ...targeted, ...impactedShipments.map((s) => s.projectId)]);
    const frozenImpacted = [...new Set(impactedShipments.filter((s) => s.frozen).map((s) => s.projectId))];

    const projects: SimulationResult['projects'] = meta.map((p) => {
      const ms: SimulationResult['projects'][number]['milestones'] = {};
      for (const t of ['EOL', 'EXW', 'COMM']) {
        const bm = before.milestones.find((m) => m.projectId === p.id && m.type === t && m.shipmentId === null && !m.visitId);
        const am = after.milestones.find((m) => m.projectId === p.id && m.type === t && m.shipmentId === null && !m.visitId);
        const b = bm?.forecast ?? null; const a = am?.forecast ?? null;
        const ap = approved.get(`${p.id}:${t}`) ?? null;
        ms[t] = { approved: ap, before: b, after: a, deltaDays: wd(b, a), beforeLabel: finishLabel(b), afterLabel: finishLabel(a), approvedLabel: finishLabel(ap), confidenceBefore: bm?.confidence ?? 'FIRM', confidenceAfter: am?.confidence ?? 'FIRM' };
      }
      const f = freeze.get(p.id);
      const reqEnd = p.req ? (Date.parse(p.req) / 86400000 + 1) * 2 : null;
      return {
        id: p.id, code: p.code, name: p.name, customer: p.customer, demandStatus: p.demand_status,
        priorityBefore: base.projects.find((x) => x.id === p.id)?.priority ?? 0, priorityAfter: afterState.projects.find((x) => x.id === p.id)?.priority ?? 0,
        frozen: !!f?.frozen, freezeStartDate: f?.freezeStartDate ?? null, requiredDate: p.req, milestones: ms,
        changedActivities: comparison.changedActivities.filter((c2) => c2.projectId === p.id).length + comparison.addedActivities.filter((c2) => c2.projectId === p.id).length,
        impacted: impacted.has(p.id), delayed: comparison.delayedProjects.includes(p.id), improved: comparison.improvedProjects.includes(p.id),
        lateVsRequired: reqEnd !== null && (ms.COMM.after ?? 0) > reqEnd,
      };
    }).sort((a, b) => a.priorityAfter - b.priorityAfter);

    const pinnedViolations = after.violations.filter((v) => (v.type === 'capacity' || v.type === 'dependency' || v.type === 'readiness') && afterState.pinned.includes(v.activityId));
    const reasons: string[] = [];
    const policy = [...freeze.values()][0]?.policy;
    if (frozenImpacted.length) reasons.push(`Affects ${impactedShipments.filter((s) => s.frozen).length} frozen deliver${impactedShipments.filter((s) => s.frozen).length === 1 ? 'y' : 'ies'} (ExWorks − ${policy?.days ?? 21} days, persisted forecast) — Management / Program approval with justification required`);
    const delaysMilestones = comparison.milestoneDeltas.some((m) => m.deltaSlots > 0);
    const movesLater = ops.some((o) => o.type === 'move_activity' && o.start > (before.acts.get(o.activityId)?.start ?? Infinity));
    if (delaysMilestones) reasons.push('Delays one or more milestone forecasts — a justification is required');
    if (movesLater) reasons.push('Moves an activity to a later date — a reason is required');
    if (structuralOps.length) reasons.push('Changes the delivery structure (units, systems, shipments or operations) — a reason is required');
    if (pinnedViolations.length) reasons.push('Invalid schedule: capacity, dependency or readiness violations must be resolved before commit');
    for (const s of structural) for (const w of s.warnings) reasons.push(`Warning: ${w}`);
    const confWorse = comparison.confidenceChanges.filter((x) => x.after !== 'FIRM' && x.before === 'FIRM');
    if (confWorse.length) reasons.push(`${confWorse.length} milestone forecast(s) become conditional on unconfirmed readiness`);

    const lab = (id: number) => names.get(id);
    const changedActivities = comparison.changedActivities.map((x) => ({ ...x, name: lab(x.activityId)?.name ?? '', unit: lab(x.activityId)?.unit_name ?? lab(x.activityId)?.internal_id ?? null, deltaDays: wd(x.beforeFinish, x.afterFinish) }));
    const addedActivities = comparison.addedActivities.map((x) => ({ ...x, name: lab(x.activityId)?.name ?? '', unit: lab(x.activityId)?.unit_name ?? null }));
    const removedActivities = comparison.removedActivities.map((x) => ({ ...x, name: lab(x.activityId)?.name ?? '', unit: lab(x.activityId)?.unit_name ?? null }));
    const inputVersions = Object.fromEntries([...impacted].map((p) => [String(p), versions[String(p)] ?? 0]));
    return {
      baseVersion: await currentVersion(c), now: base.now, simulatedAt: new Date().toISOString(), projects, changedActivities, addedActivities, removedActivities,
      displaced: comparison.displaced.map((d) => ({ ...d, name: lab(d.activityId)?.name ?? '', delayDays: d.delaySlots / 2 })),
      capacityShifts: comparison.capacityShifts.map((s) => ({ ...s, workCenter: wcNames.get(s.workCenterId) ?? '' })),
      violations: pinnedViolations, structural, impactedShipments,
      overloadsBefore: before.overloads.length, overloadsAfter: after.overloads.length,
      impactedProjects: [...impacted], frozenImpacted, inputVersions,
      requiresManagement: frozenImpacted.length > 0,
      requiresReason: delaysMilestones || movesLater || frozenImpacted.length > 0 || structuralOps.length > 0,
      reasons,
      summary: [`${impacted.size} project(s) impacted`, `${comparison.delayedProjects.length} delayed`, `${comparison.improvedProjects.length} improved`,
        `${changedActivities.length} activities rescheduled`, ...(addedActivities.length ? [`${addedActivities.length} added`] : []), ...(removedActivities.length ? [`${removedActivities.length} removed`] : [])].join(', '),
    };
  });
}

/** Projects whose planning inputs changed since the scenario was simulated (actuals, materials, releases, configuration…). */
export async function staleProjects(db: Db, inputVersions: Record<string, number> | null) {
  if (!inputVersions) return [];
  const ids = Object.keys(inputVersions).map(Number);
  if (!ids.length) return [];
  const r = await db.query('SELECT id, code, input_version FROM projects WHERE id = ANY($1)', [ids]);
  return r.rows.filter((p) => inputVersions[String(p.id)] !== p.input_version).map((p) => p.code as string);
}

async function storeResult(c: pg.PoolClient, id: number, result: SimulationResult) {
  await c.query(`UPDATE scenarios SET base_version=$2, simulated_at=now(), result=$3, requires_management=$4, requires_reason=$5, frozen_projects=$6, input_versions=$7 WHERE id=$1`,
    [id, result.baseVersion, JSON.stringify(result), result.requiresManagement, result.requiresReason, JSON.stringify(result.frozenImpacted), JSON.stringify(result.inputVersions)]);
}

export async function createScenario(c: pg.PoolClient, user: AuthUser, input: z.infer<typeof scenarioSchema>) {
  await requirePermission(c, user, 'scenario.create');
  await checkOpPermissions(c, user, input.ops as ScenarioOp[]);
  const result = await evaluate(c, user, input.ops as ScenarioOp[]);
  const r = await c.query(`INSERT INTO scenarios (name, description, ops, created_by, source) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.name, input.description ?? null, JSON.stringify(input.ops), user.id, input.source ?? 'USER']);
  await storeResult(c, r.rows[0].id, result);
  await audit(c, { userId: user.id, action: 'scenario.create', changeClass: 'PRIORITY', entityType: 'scenario', entityId: r.rows[0].id, after: { ops: input.ops, summary: result.summary } });
  return { id: r.rows[0].id, result };
}

export async function updateScenarioOps(c: pg.PoolClient, user: AuthUser, id: number, input: { name?: string; description?: string; ops: ScenarioOp[] }) {
  const sc = await getOpenScenario(c, id);
  if (sc.created_by !== user.id && user.role !== 'MANAGEMENT') throw new HttpError(403, 'Only the author or Management can edit this scenario');
  await checkOpPermissions(c, user, input.ops);
  const result = await evaluate(c, user, input.ops);
  await c.query(`UPDATE scenarios SET name = COALESCE($2, name), description = COALESCE($3, description), ops = $4, status = 'DRAFT' WHERE id = $1`,
    [id, input.name ?? null, input.description ?? null, JSON.stringify(input.ops)]);
  await storeResult(c, id, result);
  return { id, result };
}

async function getOpenScenario(db: Db, id: number, forUpdate = false) {
  const sc = (await db.query(`SELECT * FROM scenarios WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!sc) throw new HttpError(404, 'Scenario not found');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(sc.status)) throw new HttpError(409, `Scenario is ${sc.status}`);
  return sc;
}

export async function resimulate(c: pg.PoolClient, user: AuthUser, id: number) {
  const sc = await getOpenScenario(c, id);
  const result = await evaluate(c, user, sc.ops);
  await storeResult(c, id, result);
  return result;
}

export async function submitScenario(c: pg.PoolClient, user: AuthUser, id: number, note?: string) {
  const sc = await getOpenScenario(c, id, true);
  await c.query(`UPDATE scenarios SET status='PENDING_APPROVAL', submitted_by=$2, justification = COALESCE($3, justification) WHERE id=$1`, [id, user.id, note ?? null]);
  await audit(c, { userId: user.id, action: 'scenario.submit', changeClass: 'PRIORITY', entityType: 'scenario', entityId: id, reason: note ?? null, before: { status: sc.status }, after: { status: 'PENDING_APPROVAL' } });
}

export async function rejectScenario(c: pg.PoolClient, user: AuthUser, id: number, reason?: string) {
  const sc = await getOpenScenario(c, id, true);
  if (sc.created_by !== user.id && !(await can(c, user, 'freeze.override'))) throw new HttpError(403, 'Only the author or Management can reject');
  await c.query(`UPDATE scenarios SET status='REJECTED', approved_by=$2, approved_at=now(), justification=$3 WHERE id=$1`, [id, user.id, reason ?? null]);
  await audit(c, { userId: user.id, action: 'scenario.reject', changeClass: 'PRIORITY', entityType: 'scenario', entityId: id, reason: reason ?? null });
}

/**
 * Commit a scenario atomically. Authorization, freeze and staleness are re-evaluated on the
 * persisted plan at commit time; a simulated forecast never authorizes the proposal that created it.
 */
export async function commitScenario(c: pg.PoolClient, user: AuthUser, id: number, body: { justification?: string; confirmLatest?: boolean }) {
  const sc = await getOpenScenario(c, id, true);
  const ops = sc.ops as ScenarioOp[];
  await checkOpPermissions(c, user, ops);
  const fresh = await evaluate(c, user, ops);
  const justification = body.justification?.trim() || null;
  if (fresh.violations.length) throw new HttpError(422, 'The scenario produces an invalid schedule and cannot be committed', 'INVALID_SCHEDULE', { violations: fresh.violations });
  const stale = await staleProjects(c, sc.input_versions);
  if (stale.length && !body.confirmLatest) {
    await storeResult(c, id, fresh);
    throw new HttpError(409, `Planning inputs changed since this scenario was simulated (${stale.join(', ')}): review the re-simulated impact and commit again.`, 'STALE_SCENARIO', { result: fresh, stale });
  }
  const override = fresh.frozenImpacted.length > 0;
  if (override) {
    if (!(await can(c, user, 'freeze.override'))) {
      await c.query(`UPDATE scenarios SET status='PENDING_APPROVAL', submitted_by=$2 WHERE id=$1`, [id, user.id]);
      await storeResult(c, id, fresh);
      return { status: 'PENDING_APPROVAL' as const, result: fresh, message: 'Change affects frozen deliveries: submitted for Management / Program approval' };
    }
    if (!justification) throw new HttpError(422, 'A justification is mandatory to override the freeze', 'JUSTIFICATION_REQUIRED');
  } else {
    await requirePermission(c, user, 'scenario.commit', `Role ${user.role} cannot commit scenarios`);
  }
  if (fresh.requiresReason && !justification) throw new HttpError(422, 'This change delays commitments or changes the delivery structure — a justification is required', 'JUSTIFICATION_REQUIRED');

  // Apply for real: structural operations first, then pure operations on top.
  const base = await loadPlanState(c);
  const prepared = await prepareOps(c, ops, base);
  const structuralOps = prepared.filter((o) => STRUCTURAL_OPS.has(o.type)) as StructuralOp[];
  const outcomes: StructuralOutcome[] = [];
  for (const op of structuralOps) outcomes.push(await applyStructuralOp(c, user, op));
  const afterBase = structuralOps.length ? await loadPlanState(c) : base;
  const sim = simulate(base, prepared, afterBase);
  const { afterState, after, comparison } = sim;
  const cls = override ? 'OVERRIDE' : 'APPROVED_CHANGE';
  for (const p of afterState.projects) {
    const b = afterBase.projects.find((x) => x.id === p.id);
    if (b && b.priority !== p.priority) {
      await c.query('UPDATE projects SET priority = $2 WHERE id = $1', [p.id, p.priority]);
      await audit(c, { userId: user.id, action: 'project.priority', changeClass: override ? 'OVERRIDE' : 'PRIORITY', entityType: 'project', entityId: p.id, projectId: p.id, scenarioId: id, before: { priority: b.priority }, after: { priority: p.priority }, reason: justification });
    }
  }
  for (const op of prepared) {
    if (op.type === 'set_capacity') {
      if (op.fromDate) {
        // A dated improvement is approved, not implemented: it feeds the executable plan only once implemented.
        await c.query(`INSERT INTO resource_capacity_changes (work_center_id, effective_from, capacity, status, reason, created_by, approved_by) VALUES ($1,$2,$3,'APPROVED',$4,$5,$5)`,
          [op.workCenterId, op.fromDate, op.capacity, justification ?? sc.name, user.id]);
      } else {
        const before = (await c.query('SELECT capacity FROM work_centers WHERE id = $1', [op.workCenterId])).rows[0];
        await c.query('UPDATE work_centers SET capacity = $2 WHERE id = $1', [op.workCenterId, op.capacity]);
        await c.query(`INSERT INTO resource_capacity_changes (work_center_id, effective_from, capacity, status, reason, created_by, approved_by, implemented_at) VALUES ($1, CURRENT_DATE, $2, 'IMPLEMENTED', $3, $4, $4, now())`,
          [op.workCenterId, op.capacity, justification ?? sc.name, user.id]);
        await audit(c, { userId: user.id, action: 'resource.capacity', changeClass: 'CONFIG', entityType: 'work_center', entityId: op.workCenterId, scenarioId: id, before, after: op, reason: justification });
        await bumpInputs(c, 'ALL');
      }
    } else if (op.type === 'include_capacity_change') {
      await c.query(`UPDATE resource_capacity_changes SET status = 'APPROVED', approved_by = $2 WHERE id = $1 AND status = 'PROPOSED'`, [op.changeId, user.id]);
    } else if (op.type === 'add_reservation') {
      await c.query(`INSERT INTO resource_reservations (work_center_id, start_slot, finish_slot, units, kind, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [op.workCenterId, op.start, op.finish, op.units, op.kind, op.reason ?? justification ?? sc.name, user.id]);
    } else if (op.type === 'weekend_work') {
      await c.query(`INSERT INTO weekend_authorizations (work_center_id, activity_id, date, capacity, reason, approved_by, scenario_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [op.workCenterId ?? null, op.activityId ?? null, op.date, op.capacity ?? null, justification ?? sc.name, user.id, id]);
      await audit(c, { userId: user.id, action: 'weekend_work.authorize', changeClass: 'APPROVED_CHANGE', entityType: 'weekend_authorization', scenarioId: id, after: op, reason: justification ?? sc.name });
    } else if (op.type === 'apply_test_plan') {
      const sysIds = afterBase.activities.filter((a) => op.activityIds.includes(a.id) && a.systemId).map((a) => a.systemId);
      await c.query('UPDATE systems SET test_plan_id = $2 WHERE id = ANY($1)', [sysIds, op.testPlanId]);
      await audit(c, { userId: user.id, action: 'test_scope.apply', changeClass: 'QUALITY', entityType: 'test_plan', entityId: op.testPlanId, scenarioId: id, after: op, reason: justification });
    }
  }
  const changedIds = new Set(comparison.changedActivities.map((x) => x.activityId));
  for (const a of afterState.activities) {
    const b = afterBase.activities.find((x) => x.id === a.id);
    if (!b) continue;
    const moved = afterState.pinned.includes(a.id);
    const newStart = changedIds.has(a.id) || moved ? after.acts.get(a.id)!.start : a.approvedStart;
    if (moved || changedIds.has(a.id) || b.durationSlots !== a.durationSlots || b.approvedStart !== a.approvedStart) {
      await c.query('UPDATE activities SET approved_start=$2, locked=$3, duration_slots=$4, phases=$5, updated_by=$6, updated_at=now() WHERE id=$1',
        [a.id, newStart, a.locked, a.durationSlots, a.phases ? JSON.stringify(a.phases) : null, user.id]);
    }
    if (moved || b.durationSlots !== a.durationSlots) {
      await audit(c, { userId: user.id, action: moved ? 'activity.move' : 'activity.duration', changeClass: cls, entityType: 'activity', entityId: a.id, projectId: a.projectId, scenarioId: id,
        before: { approvedStart: b.approvedStart, approvedStartLabel: slotToLabel(b.approvedStart), durationSlots: b.durationSlots },
        after: { approvedStart: newStart, approvedStartLabel: slotToLabel(newStart), durationSlots: a.durationSlots, locked: a.locked }, reason: justification });
    }
  }
  const added = comparison.addedActivities.map((x) => x.activityId);
  for (const aid of added) await c.query('UPDATE activities SET approved_start = $2 WHERE id = $1', [aid, after.acts.get(aid)?.start ?? null]);
  const projectsTouched = [...new Set([...fresh.impactedProjects, ...outcomes.flatMap((o) => o.projects)])];
  await bumpInputs(c, projectsTouched);
  const out = await recalculate(c, {
    userId: user.id, kind: override ? 'FREEZE_OVERRIDE' : 'SCENARIO_COMMIT', summary: `Scenario "${sc.name}" committed by ${user.name}`, scenarioId: id,
    approve: { activityIds: new Set([...changedIds, ...afterState.pinned, ...added]), projectIds: new Set(projectsTouched), kind: override ? 'OVERRIDE' : 'APPROVED_CHANGE', reason: justification ?? sc.name },
  });
  await c.query(`UPDATE scenarios SET status='COMMITTED', approved_by=$2, approved_at=now(), justification=$3, committed_version=$4, result=$5 WHERE id=$1`,
    [id, user.id, justification, out.version, JSON.stringify({ ...fresh, structural: outcomes })]);
  await audit(c, {
    userId: user.id, action: override ? 'scenario.commit.freeze_override' : 'scenario.commit', changeClass: cls, entityType: 'scenario', entityId: id, scenarioId: id, planVersion: out.version,
    after: { ops, summary: fresh.summary, frozenImpacted: fresh.frozenImpacted, frozenShipments: fresh.impactedShipments.filter((s) => s.frozen), structural: outcomes }, reason: justification,
  });
  return { status: 'COMMITTED' as const, version: out.version, result: fresh };
}

export { dayToIso };
