import type pg from 'pg';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { CalendarSet, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import { simulate, type ScenarioOp } from '../engine/scenario.js';
import type { PlanState } from '../engine/types.js';
import { audit, can, currentVersion, HttpError, requirePermission, type AuthUser } from './common.js';
import { freezeInfo } from './projects.js';
import { recalculate } from './recalc.js';
import { loadPlanState } from './state.js';

const slot = z.number().int();
export const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_priority'), order: z.array(z.number().int()).min(1) }),
  z.object({ type: z.literal('move_priority'), projectId: z.number().int(), toRank: z.number().int().min(1) }),
  z.object({ type: z.literal('move_activity'), activityId: z.number().int(), start: slot, pullInSuccessors: z.boolean().optional() }),
  z.object({ type: z.literal('set_capacity'), workCenterId: z.number().int(), capacity: z.number().positive().max(100), maxConcurrent: z.number().int().min(1).max(100).optional() }),
  z.object({ type: z.literal('weekend_work'), workCenterId: z.number().int().nullable().optional(), activityId: z.number().int().nullable().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capacity: z.number().positive().nullable().optional() }),
  z.object({ type: z.literal('set_duration'), activityId: z.number().int(), durationSlots: z.number().int().min(0).max(200) }),
  z.object({ type: z.literal('pull_in'), projectId: z.number().int() }),
  z.object({ type: z.literal('replan_backward'), projectId: z.number().int() }),
]);
export const scenarioSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  ops: z.array(opSchema).min(1).max(100),
  source: z.enum(['USER', 'AI', 'GANTT', 'DAILY_CALL']).optional(),
});

const OP_PERMISSION: Record<ScenarioOp['type'], string> = {
  set_priority: 'scenario.op.priority',
  move_priority: 'scenario.op.priority',
  move_activity: 'scenario.op.schedule',
  set_duration: 'scenario.op.schedule',
  pull_in: 'scenario.op.schedule',
  replan_backward: 'scenario.op.schedule',
  set_capacity: 'scenario.op.capacity',
  weekend_work: 'scenario.op.capacity',
};

async function checkOpPermissions(db: Db, user: AuthUser, ops: ScenarioOp[]) {
  for (const t of new Set(ops.map((o) => o.type))) {
    await requirePermission(db, user, OP_PERMISSION[t], `Role ${user.role} may not include "${t}" changes in a scenario`);
  }
}

export interface SimulationResult {
  baseVersion: number;
  now: number;
  simulatedAt: string;
  projects: {
    id: number; code: string; name: string; customer: string; priorityBefore: number; priorityAfter: number;
    frozen: boolean; freezeStartDate: string | null; requiredDate: string;
    milestones: Record<string, { approved: number | null; before: number | null; after: number | null; deltaDays: number; beforeLabel: string; afterLabel: string; approvedLabel: string }>;
    changedActivities: number; impacted: boolean; delayed: boolean; improved: boolean; lateVsRequired: boolean;
  }[];
  changedActivities: { activityId: number; projectId: number; name: string; unit: string | null; beforeStart: number; afterStart: number; beforeFinish: number; afterFinish: number; deltaDays: number }[];
  displaced: { activityId: number; projectId: number; name: string; byProjects: number[]; delayDays: number }[];
  capacityShifts: { workCenterId: number; workCenter: string; projectId: number; beforeSlots: number; afterSlots: number }[];
  violations: { activityId: number; type: string; message: string }[];
  overloadsBefore: number;
  overloadsAfter: number;
  impactedProjects: number[];
  frozenImpacted: number[];
  requiresManagement: boolean;
  requiresReason: boolean;
  reasons: string[];
  summary: string;
}

/** Deterministic what-if evaluation. Never writes plan data. */
export async function evaluate(db: Db, ops: ScenarioOp[], state?: PlanState): Promise<SimulationResult> {
  const base = state ?? (await loadPlanState(db));
  let sim: ReturnType<typeof simulate>;
  try {
    sim = simulate(base, ops);
  } catch (e) {
    throw new HttpError(422, (e as Error).message, 'INVALID_SCENARIO');
  }
  const { before, after, afterState, comparison } = sim;
  const meta = await db.query(`SELECT p.id, p.code, p.name, p.required_commissioning_date AS req, c.name AS customer FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.status = 'ACTIVE'`);
  const actMeta = await db.query(`SELECT a.id, a.name, u.serial FROM activities a LEFT JOIN units u ON u.id = a.unit_id`);
  const wcMeta = await db.query('SELECT id, name FROM work_centers');
  const names = new Map(actMeta.rows.map((r) => [r.id, r]));
  const wcNames = new Map(wcMeta.rows.map((r) => [r.id, r.name]));
  const approved = await db.query(`SELECT project_id, type, approved_slot FROM milestones WHERE shipment_id IS NULL`);
  const apprMap = new Map(approved.rows.map((r) => [`${r.project_id}:${r.type}`, r.approved_slot]));
  const freeze = await freezeInfo(db);
  const cal = new CalendarSet(base.calendars, base.defaultCalendarId);
  const wd = (a: number | null, b: number | null) => (a === null || b === null ? 0 : cal.workingDaysBetween(a, b));

  // Projects explicitly targeted by discretionary operations.
  const targeted = new Set<number>();
  const projOf = new Map(base.activities.map((a) => [a.id, a.projectId]));
  for (const op of ops) {
    if ('projectId' in op) targeted.add(op.projectId);
    if ('activityId' in op && op.activityId) targeted.add(projOf.get(op.activityId)!);
  }
  for (const pc of comparison.priorityChanges) targeted.add(pc.projectId);
  const impacted = new Set([...comparison.impactedProjects, ...targeted]);

  const projects: SimulationResult['projects'] = meta.rows.map((p) => {
    const ms: SimulationResult['projects'][number]['milestones'] = {};
    for (const t of ['EOL', 'EXW', 'COMM']) {
      const b = before.milestones.find((m) => m.projectId === p.id && m.type === t && m.shipmentId === null)?.forecast ?? null;
      const a = after.milestones.find((m) => m.projectId === p.id && m.type === t && m.shipmentId === null)?.forecast ?? null;
      const ap = apprMap.get(`${p.id}:${t}`) ?? null;
      ms[t] = { approved: ap, before: b, after: a, deltaDays: wd(b, a), beforeLabel: finishLabel(b), afterLabel: finishLabel(a), approvedLabel: finishLabel(ap) };
    }
    const f = freeze.get(p.id);
    const reqEnd = (Date.parse(p.req) / 86400000 + 1) * 2;
    return {
      id: p.id, code: p.code, name: p.name, customer: p.customer,
      priorityBefore: base.projects.find((x) => x.id === p.id)?.priority ?? 0,
      priorityAfter: afterState.projects.find((x) => x.id === p.id)?.priority ?? 0,
      frozen: !!f?.frozen, freezeStartDate: f?.freezeStartDate ?? null, requiredDate: p.req,
      milestones: ms,
      changedActivities: comparison.changedActivities.filter((c) => c.projectId === p.id).length,
      impacted: impacted.has(p.id), delayed: comparison.delayedProjects.includes(p.id), improved: comparison.improvedProjects.includes(p.id),
      lateVsRequired: (ms.COMM.after ?? 0) > reqEnd,
    };
  }).sort((a, b) => a.priorityAfter - b.priorityAfter);

  const pinnedViolations = after.violations.filter((v) => (v.type === 'capacity' || v.type === 'dependency') && afterState.pinned.includes(v.activityId));
  const frozenImpacted = [...impacted].filter((pid) => freeze.get(pid)?.frozen);
  const reasons: string[] = [];
  if (frozenImpacted.length) reasons.push(`Affects ${frozenImpacted.length} project(s) inside the ${await freezeDays(db)}-day ExWorks freeze — Management / Program approval with justification required`);
  const delaysMilestones = comparison.milestoneDeltas.some((m) => m.deltaSlots > 0);
  const movesLater = ops.some((o) => o.type === 'move_activity' && o.start > (before.acts.get(o.activityId)?.start ?? Infinity));
  if (delaysMilestones) reasons.push('Delays one or more milestone forecasts — a justification is required');
  if (movesLater) reasons.push('Moves an activity to a later date — a reason is required');
  if (pinnedViolations.length) reasons.push('Invalid schedule: capacity or dependency violations must be resolved before commit');

  const changedActivities = comparison.changedActivities.map((c) => ({
    ...c, name: names.get(c.activityId)?.name ?? '', unit: names.get(c.activityId)?.serial ?? null, deltaDays: wd(c.beforeFinish, c.afterFinish),
  }));
  const summaryParts = [
    `${impacted.size} project(s) impacted`,
    `${comparison.delayedProjects.length} delayed`,
    `${comparison.improvedProjects.length} improved`,
    `${changedActivities.length} activities rescheduled`,
  ];
  return {
    baseVersion: await currentVersion(db),
    now: base.now,
    simulatedAt: new Date().toISOString(),
    projects,
    changedActivities,
    displaced: comparison.displaced.map((d) => ({ ...d, name: names.get(d.activityId)?.name ?? '', delayDays: d.delaySlots / 2 })),
    capacityShifts: comparison.capacityShifts.map((s) => ({ ...s, workCenter: wcNames.get(s.workCenterId) ?? '' })),
    violations: pinnedViolations.map((v) => ({ ...v, message: `${v.message}${names.get(v.activityId)?.serial ? ` [${names.get(v.activityId)!.serial}]` : ''}` })),
    overloadsBefore: before.overloads.length,
    overloadsAfter: after.overloads.length,
    impactedProjects: [...impacted],
    frozenImpacted,
    requiresManagement: frozenImpacted.length > 0,
    requiresReason: delaysMilestones || movesLater || frozenImpacted.length > 0,
    reasons,
    summary: summaryParts.join(', '),
  };
}

async function freezeDays(db: Db) {
  const r = await db.query(`SELECT value FROM settings WHERE key = 'freeze_days'`);
  return r.rows[0]?.value ?? 21;
}

export async function createScenario(c: pg.PoolClient, user: AuthUser, input: z.infer<typeof scenarioSchema>) {
  await requirePermission(c, user, 'scenario.create');
  await checkOpPermissions(c, user, input.ops as ScenarioOp[]);
  const result = await evaluate(c, input.ops as ScenarioOp[]);
  const r = await c.query(
    `INSERT INTO scenarios (name, description, ops, created_by, base_version, simulated_at, result, requires_management, requires_reason, frozen_projects, source)
     VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10) RETURNING id`,
    [input.name, input.description ?? null, JSON.stringify(input.ops), user.id, result.baseVersion, JSON.stringify(result),
      result.requiresManagement, result.requiresReason, JSON.stringify(result.frozenImpacted), input.source ?? 'USER'],
  );
  await audit(c, { userId: user.id, action: 'scenario.create', changeClass: 'PRIORITY', entityType: 'scenario', entityId: r.rows[0].id, after: { ops: input.ops, summary: result.summary } });
  return { id: r.rows[0].id, result };
}

export async function updateScenarioOps(c: pg.PoolClient, user: AuthUser, id: number, input: { name?: string; description?: string; ops: ScenarioOp[] }) {
  const sc = await getOpenScenario(c, id);
  if (sc.created_by !== user.id && user.role !== 'MANAGEMENT') throw new HttpError(403, 'Only the author or Management can edit this scenario');
  await checkOpPermissions(c, user, input.ops);
  const result = await evaluate(c, input.ops);
  await c.query(
    `UPDATE scenarios SET name = COALESCE($2, name), description = COALESCE($3, description), ops = $4, base_version = $5, simulated_at = now(), result = $6,
       requires_management = $7, requires_reason = $8, frozen_projects = $9, status = 'DRAFT' WHERE id = $1`,
    [id, input.name ?? null, input.description ?? null, JSON.stringify(input.ops), result.baseVersion, JSON.stringify(result), result.requiresManagement, result.requiresReason, JSON.stringify(result.frozenImpacted)],
  );
  return { id, result };
}

async function getOpenScenario(db: Db, id: number, forUpdate = false) {
  const r = await db.query(`SELECT * FROM scenarios WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
  const sc = r.rows[0];
  if (!sc) throw new HttpError(404, 'Scenario not found');
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(sc.status)) throw new HttpError(409, `Scenario is ${sc.status}`);
  return sc;
}

export async function resimulate(c: pg.PoolClient, id: number) {
  const sc = await getOpenScenario(c, id);
  const result = await evaluate(c, sc.ops);
  await c.query(`UPDATE scenarios SET base_version=$2, simulated_at=now(), result=$3, requires_management=$4, requires_reason=$5, frozen_projects=$6 WHERE id=$1`,
    [id, result.baseVersion, JSON.stringify(result), result.requiresManagement, result.requiresReason, JSON.stringify(result.frozenImpacted)]);
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
 * Commit a scenario atomically. Authorization and the freeze check are re-evaluated on the
 * persisted plan at commit time; the simulated forecast never influences its own freeze check.
 */
export async function commitScenario(c: pg.PoolClient, user: AuthUser, id: number, body: { justification?: string; confirmLatest?: boolean }) {
  const sc = await getOpenScenario(c, id, true);
  const ops = sc.ops as ScenarioOp[];
  await checkOpPermissions(c, user, ops);
  const base = await loadPlanState(c);
  const fresh = await evaluate(c, ops, base);
  const justification = body.justification?.trim() || null;

  if (fresh.violations.length) {
    throw new HttpError(422, 'The scenario produces an invalid schedule and cannot be committed', 'INVALID_SCHEDULE', { violations: fresh.violations });
  }
  const stored = sc.result as SimulationResult | null;
  if (stored && stored.baseVersion !== fresh.baseVersion && !body.confirmLatest) {
    const sig = (r: SimulationResult) => JSON.stringify([[...r.impactedProjects].sort(), [...r.frozenImpacted].sort(), r.projects.map((p) => [p.id, p.milestones.COMM.after, p.milestones.EXW.after])]);
    if (sig(stored) !== sig(fresh)) {
      await c.query(`UPDATE scenarios SET result=$2, base_version=$3, simulated_at=now(), requires_management=$4, frozen_projects=$5 WHERE id=$1`,
        [id, JSON.stringify(fresh), fresh.baseVersion, fresh.requiresManagement, JSON.stringify(fresh.frozenImpacted)]);
      throw new HttpError(409, 'The plan changed since this scenario was simulated. Review the updated impact and commit again.', 'STALE_SIMULATION', { result: fresh });
    }
  }
  const override = fresh.frozenImpacted.length > 0;
  if (override) {
    if (!(await can(c, user, 'freeze.override'))) {
      await c.query(`UPDATE scenarios SET status='PENDING_APPROVAL', submitted_by=$2, result=$3, requires_management=true, frozen_projects=$4 WHERE id=$1`,
        [id, user.id, JSON.stringify(fresh), JSON.stringify(fresh.frozenImpacted)]);
      return { status: 'PENDING_APPROVAL' as const, result: fresh, message: 'Change affects frozen projects: submitted for Management / Program approval' };
    }
    if (!justification) throw new HttpError(422, 'A justification is mandatory to override the 21-day freeze', 'JUSTIFICATION_REQUIRED');
  } else {
    await requirePermission(c, user, 'scenario.commit', `Role ${user.role} cannot commit scenarios`);
  }
  if (fresh.requiresReason && !justification) throw new HttpError(422, 'This change delays commitments — a justification is required', 'JUSTIFICATION_REQUIRED');

  // Persist the scenario's plan inputs.
  const sim = simulate(base, ops);
  const { afterState, after, comparison } = sim;
  for (const p of afterState.projects) {
    const b = base.projects.find((x) => x.id === p.id)!;
    if (b.priority !== p.priority) {
      await c.query('UPDATE projects SET priority = $2 WHERE id = $1', [p.id, p.priority]);
      await audit(c, { userId: user.id, action: 'project.priority', changeClass: override ? 'OVERRIDE' : 'PRIORITY', entityType: 'project', entityId: p.id, projectId: p.id, scenarioId: id, before: { priority: b.priority }, after: { priority: p.priority }, reason: justification });
    }
  }
  for (const w of afterState.workCenters) {
    const b = base.workCenters.find((x) => x.id === w.id)!;
    if (b.capacity !== w.capacity || b.maxConcurrent !== w.maxConcurrent) {
      await c.query('UPDATE work_centers SET capacity=$2, max_concurrent=$3 WHERE id=$1', [w.id, w.capacity, w.maxConcurrent]);
      await audit(c, { userId: user.id, action: 'work_center.capacity', changeClass: 'CONFIG', entityType: 'work_center', entityId: w.id, scenarioId: id, before: b, after: w, reason: justification });
    }
  }
  for (const wa of afterState.weekendAuths.slice(base.weekendAuths.length)) {
    await c.query(`INSERT INTO weekend_authorizations (work_center_id, activity_id, date, capacity, reason, approved_by, scenario_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [wa.workCenterId, wa.activityId, dayToIso(wa.day), wa.capacity, justification ?? sc.name, user.id, id]);
    await audit(c, { userId: user.id, action: 'weekend_work.authorize', changeClass: 'APPROVED_CHANGE', entityType: 'weekend_authorization', scenarioId: id, after: { ...wa, date: dayToIso(wa.day) }, reason: justification ?? sc.name });
  }
  const changedIds = new Set(comparison.changedActivities.map((x) => x.activityId));
  for (const a of afterState.activities) {
    const b = base.activities.find((x) => x.id === a.id)!;
    const moved = afterState.pinned.includes(a.id);
    const newStart = changedIds.has(a.id) || moved ? after.acts.get(a.id)!.start : a.approvedStart;
    if (moved || changedIds.has(a.id) || b.durationSlots !== a.durationSlots || b.approvedStart !== a.approvedStart) {
      await c.query('UPDATE activities SET approved_start=$2, locked=$3, duration_slots=$4, updated_by=$5, updated_at=now() WHERE id=$1',
        [a.id, newStart, a.locked, a.durationSlots, user.id]);
    }
    if (moved || b.durationSlots !== a.durationSlots) {
      await audit(c, { userId: user.id, action: moved ? 'activity.move' : 'activity.duration', changeClass: override ? 'OVERRIDE' : 'APPROVED_CHANGE',
        entityType: 'activity', entityId: a.id, projectId: a.projectId, scenarioId: id,
        before: { approvedStart: b.approvedStart, approvedStartLabel: slotToLabel(b.approvedStart), durationSlots: b.durationSlots },
        after: { approvedStart: newStart, approvedStartLabel: slotToLabel(newStart), durationSlots: a.durationSlots, locked: a.locked }, reason: justification });
    }
  }
  const out = await recalculate(c, {
    userId: user.id, kind: override ? 'FREEZE_OVERRIDE' : 'SCENARIO_COMMIT', summary: `Scenario "${sc.name}" committed by ${user.name}`, scenarioId: id,
    approve: {
      activityIds: new Set([...changedIds, ...afterState.pinned]),
      projectIds: new Set(fresh.impactedProjects),
      kind: override ? 'OVERRIDE' : 'APPROVED_CHANGE',
      reason: justification ?? sc.name,
    },
  });
  await c.query(`UPDATE scenarios SET status='COMMITTED', approved_by=$2, approved_at=now(), justification=$3, committed_version=$4, result=$5 WHERE id=$1`,
    [id, user.id, justification, out.version, JSON.stringify(fresh)]);
  await audit(c, {
    userId: user.id, action: override ? 'scenario.commit.freeze_override' : 'scenario.commit', changeClass: override ? 'OVERRIDE' : 'APPROVED_CHANGE',
    entityType: 'scenario', entityId: id, scenarioId: id, planVersion: out.version, after: { ops, summary: fresh.summary, frozenImpacted: fresh.frozenImpacted }, reason: justification,
  });
  return { status: 'COMMITTED' as const, version: out.version, result: fresh };
}
