import type pg from 'pg';
import { z } from 'zod';
import { finishLabel } from '../engine/calendar.js';
import { audit, bumpInputs, can, currentSlot, HttpError, type AuthUser } from './common.js';
import { openGates, syncDerivedGates } from './gates.js';
import { recordTestResult } from './quality.js';
import { recalculate } from './recalc.js';
import { recordInstallation } from './software.js';

export const executionSchema = z.object({
  status: z.enum(['NOT_STARTED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED']).optional(),
  actualStart: z.number().int().nullable().optional(),
  actualFinish: z.number().int().nullable().optional(),
  pctComplete: z.number().int().min(0).max(100).optional(),
  expectedFinish: z.number().int().nullable().optional(),
  blocker: z.string().max(2000).nullable().optional(),
  comment: z.string().max(4000).optional(),
  delayReason: z.string().max(4000).optional(),
  delayCategory: z.string().max(60).optional(),
  reportDelay: z.boolean().optional(),
  assignedUserId: z.number().int().nullable().optional(),
  /** Test outcome — mandatory when completing a test operation (testing performed ≠ passed). */
  testOutcome: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']).optional(),
  evidenceRef: z.string().max(500).optional(),
  /** Record the installation of the required software on the unit as part of completing the activity. */
  softwareInstalled: z.object({ releaseId: z.number().int(), checksPassed: z.boolean() }).optional(),
  /** Timestamp of the information source (e.g. a meeting or report); older information cannot overwrite newer state. */
  asOf: z.string().datetime({ offset: true }).optional(),
});
export type ExecutionInput = z.infer<typeof executionSchema>;

const TEST_CODES = new Set(['EOL', 'VAL', 'RVAL', 'RW_RETEST', 'SW_RETEST']);

async function mayExecute(c: pg.PoolClient, user: AuthUser, a: any) {
  if (await can(c, user, `activity.execute.${a.function}`)) return true;
  if (a.visit_id && user.role === 'RND') {
    // Early-access projects may be R&D-led by an approved, project-specific delegation.
    const v = (await c.query('SELECT rd_led, delegation_approved_by FROM commissioning_visits WHERE id = $1', [a.visit_id])).rows[0];
    if (v?.rd_led && v.delegation_approved_by) return true;
  }
  return false;
}

/**
 * Record execution progress. Always allowed for the responsible function — including on frozen
 * deliveries — because the freeze only restricts discretionary planning changes.
 * Any delay requires an explanation, which becomes the root cause of the propagated impact.
 */
export async function updateExecution(c: pg.PoolClient, user: AuthUser, activityId: number, input: ExecutionInput) {
  const a = (await c.query('SELECT * FROM activities WHERE id = $1 FOR UPDATE', [activityId])).rows[0];
  if (!a) throw new HttpError(404, 'Activity not found');
  if (!(await mayExecute(c, user, a))) throw new HttpError(403, `Role ${user.role} cannot update ${a.function} activities`, 'FORBIDDEN');
  if (input.asOf && new Date(input.asOf) < new Date(a.updated_at)) {
    throw new HttpError(409, `This information (as of ${input.asOf}) is older than the last update of "${a.name}" (${new Date(a.updated_at).toISOString()}) and cannot overwrite it`, 'STALE_UPDATE');
  }
  if (input.asOf && a.status === 'COMPLETED' && input.status && input.status !== 'COMPLETED') {
    throw new HttpError(409, 'A completed activity cannot be reopened from older information', 'STALE_UPDATE');
  }
  const now = await currentSlot(c);
  const nowEnd = now + 1;

  const next = {
    status: input.status ?? a.status,
    actual_start: input.actualStart !== undefined ? input.actualStart : a.actual_start,
    actual_finish: input.actualFinish !== undefined ? input.actualFinish : a.actual_finish,
    pct_complete: input.pctComplete ?? a.pct_complete,
    progress_slot: input.pctComplete !== undefined ? now : a.progress_slot,
    expected_finish: input.expectedFinish !== undefined ? input.expectedFinish : a.expected_finish,
    blocker: input.blocker !== undefined ? input.blocker : a.blocker,
    assigned_user_id: input.assignedUserId !== undefined ? input.assignedUserId : a.assigned_user_id,
  };

  if (a.status === 'COMPLETED' && next.status !== 'COMPLETED' && user.role !== 'MANAGEMENT') {
    throw new HttpError(403, 'Only Management / Program can re-open a completed activity');
  }
  const starting = ['IN_PROGRESS', 'COMPLETED'].includes(next.status) && !['IN_PROGRESS', 'COMPLETED', 'BLOCKED'].includes(a.status);
  if (starting) {
    const open = await c.query(
      `SELECT p.name FROM dependencies d JOIN activities p ON p.id = d.pred_id WHERE d.succ_id = $1 AND p.status NOT IN ('COMPLETED','CANCELLED')`, [activityId]);
    if (open.rows.length) throw new HttpError(409, `Predecessor not completed: ${open.rows.map((r) => r.name).join(', ')}`, 'PREDECESSOR_OPEN');
    const gates = await openGates(c, activityId, 'START', now);
    if (gates.length) {
      throw new HttpError(409, `Not ready to start: ${gates.map((g) => `${g.title} (${g.status.toLowerCase()})`).join('; ')}`, 'GATE_OPEN', { gates: gates.map((g) => ({ id: g.id, title: g.title, status: g.status })) });
    }
  }
  if (next.status === 'IN_PROGRESS' || next.status === 'BLOCKED') {
    if (next.status === 'IN_PROGRESS' && next.actual_start === null) next.actual_start = now;
    next.actual_finish = null;
  }
  let installRecorded = false;
  if (next.status === 'COMPLETED' && a.status !== 'COMPLETED') {
    if (input.softwareInstalled && a.unit_id) {
      await recordInstallation(c, user, { releaseId: input.softwareInstalled.releaseId, unitIds: [a.unit_id], checksPassed: input.softwareInstalled.checksPassed, note: `Installed during ${a.name}` });
      installRecorded = true;
      await syncDerivedGates(c, [a.project_id]);
    }
    const gates = await openGates(c, activityId, 'COMPLETE', now);
    if (gates.length) {
      throw new HttpError(409, `Cannot complete — progress is recorded but these conditions are open: ${gates.map((g) => `${g.title} (${g.status.toLowerCase()})`).join('; ')}`, 'GATE_OPEN',
        { gates: gates.map((g) => ({ id: g.id, title: g.title, status: g.status })) });
    }
    // Required software must actually be installed on this unit with checks passed.
    const swGates = (await c.query(`SELECT * FROM readiness_gates WHERE activity_id = $1 AND source_type = 'SOFTWARE' AND spec->>'requirement' = 'INSTALLED_VERIFIED'`, [activityId])).rows;
    for (const g of swGates) {
      if (g.conditional_release?.approvedBy && !g.conditional_release.revokedAt) continue;
      const comp = (await c.query('SELECT * FROM sw_components WHERE code = $1', [g.spec.component])).rows[0];
      const rid = g.spec.releaseId ?? comp?.production_release_id;
      const inst = rid ? (await c.query('SELECT 1 FROM unit_software WHERE unit_id = $1 AND release_id = $2 AND NOT superseded AND checks_passed_at IS NOT NULL', [a.unit_id, rid])).rows.length : 0;
      if (!inst) throw new HttpError(422, `Record the installation of the required ${comp?.name ?? g.spec.component} release (with checks passed) to complete this activity`, 'SOFTWARE_NOT_INSTALLED', { releaseId: rid });
    }
    if (TEST_CODES.has(a.code) && !input.testOutcome) {
      throw new HttpError(422, 'Record the test outcome (PASS / FAIL / INCONCLUSIVE): testing performed is not the same as passed and released', 'TEST_OUTCOME_REQUIRED');
    }
    if (next.actual_start === null) next.actual_start = Math.min(a.forecast_start ?? now, now);
    if (next.actual_finish === null) next.actual_finish = nowEnd;
    next.pct_complete = 100;
    next.expected_finish = null;
    next.blocker = null;
  }
  if (next.status === 'NOT_STARTED' || next.status === 'READY') { next.actual_start = null; next.actual_finish = null; }
  if (next.status !== 'BLOCKED' && a.status === 'BLOCKED' && input.blocker === undefined) next.blocker = null;
  if (next.actual_start !== null && next.actual_start > nowEnd) throw new HttpError(422, 'Actual start cannot be in the future');
  if (next.actual_finish !== null && next.actual_finish > nowEnd) throw new HttpError(422, 'Actual finish cannot be in the future');
  if (next.actual_finish !== null && next.actual_start !== null && next.actual_finish <= next.actual_start) throw new HttpError(422, 'Actual finish must be after actual start');
  if (next.status === 'BLOCKED' && !next.blocker) throw new HttpError(422, 'Describe the blocker when marking an activity Blocked', 'BLOCKER_REQUIRED');
  if (next.status === 'CANCELLED' && a.status !== 'CANCELLED' && !(input.comment || input.delayReason)) throw new HttpError(422, 'A comment is required to cancel / mark an activity not applicable');

  // Delay detection — every delay must carry an explanation.
  const triggers: string[] = [];
  if (next.status === 'BLOCKED' && a.status !== 'BLOCKED') triggers.push('blocked');
  if (input.expectedFinish != null && input.expectedFinish > (a.forecast_finish ?? -Infinity) && input.expectedFinish !== a.expected_finish) triggers.push('expected_completion_extended');
  if (next.actual_finish !== null && next.actual_finish !== a.actual_finish && a.approved_finish !== null && next.actual_finish > a.approved_finish) triggers.push('completed_after_commitment');
  if (input.reportDelay) triggers.push('reported_delay');
  const reason = input.delayReason?.trim();
  if (triggers.length && (!reason || reason.length < 3)) throw new HttpError(422, `A delay explanation is required (${triggers.join(', ')})`, 'DELAY_REASON_REQUIRED', { triggers });

  await c.query(
    `UPDATE activities SET status=$2, actual_start=$3, actual_finish=$4, pct_complete=$5, expected_finish=$6, blocker=$7,
       assigned_user_id=$8, delay_reason = COALESCE($9, delay_reason), progress_slot=$10, updated_by=$11, updated_at=now() WHERE id=$1`,
    [activityId, next.status, next.actual_start, next.actual_finish, next.pct_complete, next.expected_finish, next.blocker,
      next.assigned_user_id, triggers.length ? reason : null, next.progress_slot, user.id]);

  let testRecordId: number | null = null;
  if (next.status === 'COMPLETED' && a.status !== 'COMPLETED' && input.testOutcome) {
    const r = await recordTestResult(c, user, { activityId, outcome: input.testOutcome, evidenceRef: input.evidenceRef ?? null, swReleaseId: input.softwareInstalled?.releaseId ?? null });
    testRecordId = r.testRecordId;
    if (a.rework_id && a.code === 'RW_RETEST') await c.query(`UPDATE rework_packages SET status = $2 WHERE id = $1`, [a.rework_id, input.testOutcome === 'PASS' ? 'DONE' : 'IN_PROGRESS']);
  }
  if (a.rework_id && next.status === 'IN_PROGRESS') await c.query(`UPDATE rework_packages SET status = 'IN_PROGRESS' WHERE id = $1 AND status = 'PLANNED'`, [a.rework_id]);

  const rootEvents = new Map<number, number>();
  if (triggers.length) {
    const ev = await c.query(
      `INSERT INTO delay_events (activity_id, project_id, kind, origin_activity_id, category, reason, prev_start, prev_finish, user_id)
       VALUES ($1,$2,'ROOT',$1,$3,$4,$5,$6,$7) RETURNING id`, [activityId, a.project_id, input.delayCategory ?? 'OTHER', reason, a.forecast_start, a.forecast_finish, user.id]);
    rootEvents.set(activityId, ev.rows[0].id);
    await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'DELAY',$4)`, [a.project_id, activityId, user.id, `[${triggers.join(', ')}] ${reason}`]);
  }
  if (next.status === 'BLOCKED' && next.blocker && next.blocker !== a.blocker) {
    await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'BLOCKER',$4)`, [a.project_id, activityId, user.id, next.blocker]);
  }
  if (input.comment?.trim()) await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'COMMENT',$4)`, [a.project_id, activityId, user.id, input.comment.trim()]);
  await syncDerivedGates(c, [a.project_id]);
  await bumpInputs(c, [a.project_id]);

  const out = await recalculate(c, {
    userId: user.id, kind: 'EXECUTION',
    summary: `${user.name} updated "${a.name}" (${a.status} → ${next.status})${triggers.length ? ' — delay reported' : ''}`, rootEvents,
  });
  await audit(c, {
    userId: user.id, action: 'activity.execution', changeClass: 'EXECUTION', entityType: 'activity', entityId: activityId, projectId: a.project_id, planVersion: out.version,
    before: pick(a), after: { ...next, triggers, testOutcome: input.testOutcome, installRecorded, asOf: input.asOf }, reason: reason ?? input.comment ?? null,
  });
  const r = out.result.acts.get(activityId);
  return {
    version: out.version,
    delayEventId: rootEvents.get(activityId) ?? null,
    testRecordId,
    forecast: r ? { start: r.start, finish: r.finish, finishLabel: finishLabel(r.finish), confidence: r.confidence } : null,
    changedActivities: out.changes.length,
    milestoneChanges: out.milestoneChanges.filter((m) => m.prev !== m.next).map((m) => ({ ...m, prevLabel: finishLabel(m.prev), nextLabel: finishLabel(m.next) })),
  };
}

function pick(a: Record<string, unknown>) {
  const keys = ['status', 'actual_start', 'actual_finish', 'pct_complete', 'expected_finish', 'blocker', 'forecast_start', 'forecast_finish', 'approved_start', 'approved_finish'];
  return Object.fromEntries(keys.map((k) => [k, a[k]]));
}
