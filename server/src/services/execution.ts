import type pg from 'pg';
import { z } from 'zod';
import { finishLabel } from '../engine/calendar.js';
import { audit, currentSlot, HttpError, requirePermission, type AuthUser } from './common.js';
import { recalculate } from './recalc.js';

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
});
export type ExecutionInput = z.infer<typeof executionSchema>;

/**
 * Record execution progress. Always allowed for the responsible function — including on
 * frozen projects — because the freeze only restricts discretionary planning changes.
 * Any delay requires an explanation, which becomes the root cause of the propagated impact.
 */
export async function updateExecution(c: pg.PoolClient, user: AuthUser, activityId: number, input: ExecutionInput) {
  const a = (await c.query('SELECT * FROM activities WHERE id = $1 FOR UPDATE', [activityId])).rows[0];
  if (!a) throw new HttpError(404, 'Activity not found');
  await requirePermission(c, user, `activity.execute.${a.function}`,
    `Role ${user.role} cannot update ${a.function} activities`);
  const now = await currentSlot(c);
  const nowEnd = now + 1;

  const next = {
    status: input.status ?? a.status,
    actual_start: input.actualStart !== undefined ? input.actualStart : a.actual_start,
    actual_finish: input.actualFinish !== undefined ? input.actualFinish : a.actual_finish,
    pct_complete: input.pctComplete ?? a.pct_complete,
    expected_finish: input.expectedFinish !== undefined ? input.expectedFinish : a.expected_finish,
    blocker: input.blocker !== undefined ? input.blocker : a.blocker,
    assigned_user_id: input.assignedUserId !== undefined ? input.assignedUserId : a.assigned_user_id,
  };

  if (a.status === 'COMPLETED' && next.status !== 'COMPLETED' && user.role !== 'MANAGEMENT') {
    throw new HttpError(403, 'Only Management / Program can re-open a completed activity');
  }
  if (['IN_PROGRESS', 'COMPLETED'].includes(next.status) && !['IN_PROGRESS', 'COMPLETED', 'BLOCKED'].includes(a.status)) {
    const open = await c.query(
      `SELECT p.name, p.status FROM dependencies d JOIN activities p ON p.id = d.pred_id
       WHERE d.succ_id = $1 AND p.status NOT IN ('COMPLETED','CANCELLED')`, [activityId]);
    if (open.rows.length) throw new HttpError(409, `Predecessor not completed: ${open.rows.map((r) => r.name).join(', ')}`, 'PREDECESSOR_OPEN');
  }
  if (next.status === 'IN_PROGRESS' || next.status === 'BLOCKED') {
    if (next.status === 'IN_PROGRESS' && next.actual_start === null) next.actual_start = now;
    next.actual_finish = null;
  }
  if (next.status === 'COMPLETED') {
    if (next.actual_start === null) next.actual_start = Math.min(a.forecast_start ?? now, now);
    if (next.actual_finish === null) next.actual_finish = nowEnd;
    next.pct_complete = 100;
    next.expected_finish = null;
    next.blocker = null;
  }
  if (next.status === 'NOT_STARTED' || next.status === 'READY') {
    next.actual_start = null;
    next.actual_finish = null;
  }
  if (next.status !== 'BLOCKED' && a.status === 'BLOCKED' && input.blocker === undefined) next.blocker = null;
  if (next.actual_start !== null && next.actual_start > nowEnd) throw new HttpError(422, 'Actual start cannot be in the future');
  if (next.actual_finish !== null && next.actual_finish > nowEnd) throw new HttpError(422, 'Actual finish cannot be in the future');
  if (next.actual_finish !== null && next.actual_start !== null && next.actual_finish <= next.actual_start) {
    throw new HttpError(422, 'Actual finish must be after actual start');
  }
  if (next.status === 'BLOCKED' && !next.blocker) throw new HttpError(422, 'Describe the blocker when marking an activity Blocked', 'BLOCKER_REQUIRED');
  if (next.status === 'CANCELLED' && a.status !== 'CANCELLED' && !(input.comment || input.delayReason)) {
    throw new HttpError(422, 'A comment is required to cancel / mark an activity not applicable');
  }

  // Delay detection — every delay must carry an explanation.
  const triggers: string[] = [];
  if (next.status === 'BLOCKED' && a.status !== 'BLOCKED') triggers.push('blocked');
  if (input.expectedFinish != null && input.expectedFinish > (a.forecast_finish ?? -Infinity) && input.expectedFinish !== a.expected_finish) {
    triggers.push('expected_completion_extended');
  }
  if (next.actual_finish !== null && next.actual_finish !== a.actual_finish && a.approved_finish !== null && next.actual_finish > a.approved_finish) {
    triggers.push('completed_after_commitment');
  }
  if (input.reportDelay) triggers.push('reported_delay');
  const reason = input.delayReason?.trim();
  if (triggers.length && (!reason || reason.length < 3)) {
    throw new HttpError(422, `A delay explanation is required (${triggers.join(', ')})`, 'DELAY_REASON_REQUIRED', { triggers });
  }

  await c.query(
    `UPDATE activities SET status=$2, actual_start=$3, actual_finish=$4, pct_complete=$5, expected_finish=$6, blocker=$7,
       assigned_user_id=$8, delay_reason = COALESCE($9, delay_reason), updated_by=$10, updated_at=now() WHERE id=$1`,
    [activityId, next.status, next.actual_start, next.actual_finish, next.pct_complete, next.expected_finish, next.blocker,
      next.assigned_user_id, triggers.length ? reason : null, user.id],
  );

  const rootEvents = new Map<number, number>();
  if (triggers.length) {
    const ev = await c.query(
      `INSERT INTO delay_events (activity_id, project_id, kind, origin_activity_id, category, reason, prev_start, prev_finish, user_id)
       VALUES ($1,$2,'ROOT',$1,$3,$4,$5,$6,$7) RETURNING id`,
      [activityId, a.project_id, input.delayCategory ?? 'OTHER', reason, a.forecast_start, a.forecast_finish, user.id]);
    rootEvents.set(activityId, ev.rows[0].id);
    await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'DELAY',$4)`,
      [a.project_id, activityId, user.id, `[${triggers.join(', ')}] ${reason}`]);
  }
  if (next.status === 'BLOCKED' && next.blocker && next.blocker !== a.blocker) {
    await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'BLOCKER',$4)`,
      [a.project_id, activityId, user.id, next.blocker]);
  }
  if (input.comment?.trim()) {
    await c.query(`INSERT INTO comments (project_id, activity_id, user_id, kind, text) VALUES ($1,$2,$3,'COMMENT',$4)`,
      [a.project_id, activityId, user.id, input.comment.trim()]);
  }

  const out = await recalculate(c, {
    userId: user.id, kind: 'EXECUTION',
    summary: `${user.name} updated "${a.name}" (${a.status} → ${next.status})${triggers.length ? ' — delay reported' : ''}`,
    rootEvents,
  });
  await audit(c, {
    userId: user.id, action: 'activity.execution', changeClass: 'EXECUTION', entityType: 'activity', entityId: activityId,
    projectId: a.project_id, planVersion: out.version,
    before: pick(a), after: { ...next, triggers }, reason: reason ?? input.comment ?? null,
  });
  const r = out.result.acts.get(activityId);
  return {
    version: out.version,
    delayEventId: rootEvents.get(activityId) ?? null,
    forecast: r ? { start: r.start, finish: r.finish, finishLabel: finishLabel(r.finish) } : null,
    changedActivities: out.changes.length,
    milestoneChanges: out.milestoneChanges.filter((m) => m.prev !== m.next).map((m) => ({ ...m, prevLabel: finishLabel(m.prev), nextLabel: finishLabel(m.next) })),
  };
}

function pick(a: Record<string, unknown>) {
  const keys = ['status', 'actual_start', 'actual_finish', 'pct_complete', 'expected_finish', 'blocker', 'forecast_start', 'forecast_finish', 'approved_start', 'approved_finish'];
  return Object.fromEntries(keys.map((k) => [k, a[k]]));
}
