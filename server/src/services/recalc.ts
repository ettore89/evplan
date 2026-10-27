import type pg from 'pg';
import { attributeChanges, type ActivityChange } from '../engine/analysis.js';
import { drivingChain, forwardSchedule } from '../engine/scheduler.js';
import type { Driver, PlanState, ScheduleResult } from '../engine/types.js';
import { finishLabel } from '../engine/calendar.js';
import { afterCommit } from '../db/pool.js';
import { newVersion } from './common.js';
import { loadPlanState } from './state.js';
import { broadcast } from './realtime.js';

export interface ApprovalSpec {
  /** Activities whose new forecast becomes the approved schedule. */
  activityIds: Set<number>;
  /** Projects whose milestone commitments are re-approved when their forecast changed. */
  projectIds: Set<number>;
  kind: 'BASELINE' | 'APPROVED_CHANGE' | 'OVERRIDE';
  reason: string | null;
}

export interface RecalcContext {
  userId: number | null;
  kind: string;
  summary: string;
  rootEvents?: Map<number, number>;
  scenarioId?: number | null;
  approve?: ApprovalSpec;
  state?: PlanState;
  quiet?: boolean;
}

export interface MilestoneChange {
  milestoneId: number;
  projectId: number;
  type: string;
  prev: number | null;
  next: number | null;
  rootEventId: number | null;
}

export interface RecalcOutcome {
  version: number;
  changes: ActivityChange[];
  milestoneChanges: MilestoneChange[];
  result: ScheduleResult;
  state: PlanState;
}

const SYSTEM_REASON: Partial<Record<Driver['type'], string>> = {
  now: 'Planned start passed without start confirmation (awaiting owner update)',
  overdue: 'Activity overdue against its expected completion (awaiting owner update)',
  blocked: 'Activity blocked — no progress possible until the blocker is resolved',
  capacity: 'Work-center capacity contention',
  locked: 'Locked commitment',
};

function driverJson(d: Driver) {
  return JSON.stringify(d);
}

/**
 * Global forward recalculation (Mode B), persisted atomically with traceable delay events.
 * Must be called inside a transaction holding the plan lock.
 */
export async function recalculate(c: pg.PoolClient, ctx: RecalcContext): Promise<RecalcOutcome> {
  // Activities whose predecessors are all finished become Ready to Start.
  await c.query(`
    UPDATE activities a SET status = 'READY', updated_at = now()
    WHERE a.status = 'NOT_STARTED'
      AND EXISTS (SELECT 1 FROM dependencies d WHERE d.succ_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN activities p ON p.id = d.pred_id
                      WHERE d.succ_id = a.id AND p.status NOT IN ('COMPLETED','CANCELLED'))`);

  const state = ctx.state ?? (await loadPlanState(c));
  const result = forwardSchedule(state);
  const prevRows = await c.query('SELECT id, forecast_start, forecast_finish, approved_start, approved_finish, baseline_start, project_id FROM activities');
  const prev = new Map<number, { start: number | null; finish: number | null }>();
  const prevRow = new Map<number, (typeof prevRows.rows)[number]>();
  for (const r of prevRows.rows) {
    prev.set(r.id, { start: r.forecast_start, finish: r.forecast_finish });
    prevRow.set(r.id, r);
  }
  const changes = attributeChanges(state, result, prev);
  const version = await newVersion(c, ctx.kind, ctx.summary, ctx.userId, ctx.scenarioId ?? null);

  // 1. Activity forecasts (+ approvals)
  const ids: number[] = [], fs: number[] = [], ff: number[] = [], drv: string[] = [], crit: boolean[] = [];
  const wait: number[] = [], wk: boolean[] = [], flags: string[] = [], appr: boolean[] = [];
  for (const [id, r] of result.acts) {
    ids.push(id); fs.push(r.start); ff.push(r.finish); drv.push(driverJson(r.driver)); crit.push(result.critical.has(id));
    wait.push(r.capacityWaitSlots); wk.push(r.weekend); flags.push(r.flags.join(','));
    appr.push(!!ctx.approve?.activityIds.has(id));
  }
  await c.query(`
    UPDATE activities a SET forecast_start = v.fs, forecast_finish = v.ff, driver = v.drv::jsonb, is_critical = v.crit,
      capacity_wait_slots = v.wait, weekend_work = v.wk, flags = CASE WHEN v.flags = '' THEN '{}'::text[] ELSE string_to_array(v.flags, ',') END,
      approved_start = CASE WHEN v.appr THEN v.fs ELSE a.approved_start END,
      approved_finish = CASE WHEN v.appr THEN v.ff ELSE a.approved_finish END,
      baseline_start = CASE WHEN v.appr AND a.baseline_start IS NULL THEN v.fs ELSE a.baseline_start END,
      baseline_finish = CASE WHEN v.appr AND a.baseline_finish IS NULL THEN v.ff ELSE a.baseline_finish END
    FROM (SELECT unnest($1::int[]) id, unnest($2::int[]) fs, unnest($3::int[]) ff, unnest($4::text[]) drv, unnest($5::bool[]) crit,
                 unnest($6::int[]) wait, unnest($7::bool[]) wk, unnest($8::text[]) flags, unnest($9::bool[]) appr) v
    WHERE a.id = v.id`, [ids, fs, ff, drv, crit, wait, wk, flags, appr]);

  // 2. Capacity reservations
  await c.query('DELETE FROM reservations');
  const rAct: number[] = [], rWc: number[] = [], rSlot: number[] = [], rLoad: number[] = [];
  const wcOf = new Map(state.activities.map((a) => [a.id, a.workCenterId]));
  for (const [id, r] of result.acts) {
    const wc = wcOf.get(id);
    if (!wc) continue;
    for (const [s, l] of r.bookings) { rAct.push(id); rWc.push(wc); rSlot.push(s); rLoad.push(l); }
  }
  if (rAct.length) {
    await c.query(`INSERT INTO reservations (activity_id, work_center_id, slot, load)
      SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::numeric[]) ON CONFLICT DO NOTHING`, [rAct, rWc, rSlot, rLoad]);
  }

  // 3. Delay / change events with root-cause links
  const eventOf = new Map<number, number>(ctx.rootEvents ?? []);
  const approving = ctx.approve;
  for (const ch of changes) {
    if (approving?.activityIds.has(ch.activityId)) continue;
    if (ch.kind !== 'root' || eventOf.has(ch.activityId)) continue;
    const r = result.acts.get(ch.activityId)!;
    const reason = SYSTEM_REASON[r.driver.type] ?? 'Schedule recalculation';
    const ins = await c.query(
      `INSERT INTO delay_events (activity_id, project_id, kind, origin_activity_id, reason, prev_start, prev_finish, new_start, new_finish, user_id, plan_version, category)
       VALUES ($1,$2,'SYSTEM',$1,$3,$4,$5,$6,$7,NULL,$8,'SYSTEM') RETURNING id`,
      [ch.activityId, ch.projectId, reason, ch.prevStart, ch.prevFinish, ch.newStart, ch.newFinish, version]);
    eventOf.set(ch.activityId, ins.rows[0].id);
  }
  // user-reported roots: fill in the calculated dates
  for (const ch of changes) {
    const ev = ctx.rootEvents?.get(ch.activityId);
    if (ev) await c.query('UPDATE delay_events SET prev_start=$2, prev_finish=$3, new_start=$4, new_finish=$5, plan_version=$6 WHERE id=$1',
      [ev, ch.prevStart, ch.prevFinish, ch.newStart, ch.newFinish, version]);
  }
  const relatedByRoot = new Map<number, Set<number>>();
  const bulk = { act: [] as number[], proj: [] as number[], kind: [] as string[], root: [] as (number | null)[], origin: [] as number[],
    reason: [] as (string | null)[], ps: [] as (number | null)[], pf: [] as (number | null)[], ns: [] as number[], nf: [] as number[], rel: [] as string[] };
  for (const ch of changes) {
    let kind: string;
    let root: number | null = null;
    let reason: string | null = null;
    if (approving?.activityIds.has(ch.activityId)) {
      kind = 'APPROVED_CHANGE';
      reason = approving.reason;
    } else if (ch.kind === 'root') continue;
    else if (ch.kind === 'improvement') kind = 'IMPROVEMENT';
    else {
      kind = ch.kind === 'capacity' ? 'CAPACITY' : 'PROPAGATED';
      root = eventOf.get(ch.originActivityId) ?? null;
      if (root) {
        const set = relatedByRoot.get(root) ?? new Set();
        set.add(ch.projectId);
        relatedByRoot.set(root, set);
      }
      if (ch.kind === 'capacity') reason = 'Delayed by work-center capacity contention';
    }
    bulk.act.push(ch.activityId); bulk.proj.push(ch.projectId); bulk.kind.push(kind); bulk.root.push(root); bulk.origin.push(ch.originActivityId);
    bulk.reason.push(reason); bulk.ps.push(ch.prevStart); bulk.pf.push(ch.prevFinish); bulk.ns.push(ch.newStart); bulk.nf.push(ch.newFinish);
    bulk.rel.push(JSON.stringify(ch.displacedBy));
  }
  if (bulk.act.length) {
    const ins = await c.query(
      `INSERT INTO delay_events (activity_id, project_id, kind, root_event_id, origin_activity_id, reason, prev_start, prev_finish, new_start, new_finish, related_projects, user_id, plan_version, scenario_id)
       SELECT a, p, k, r, o, re, ps, pf, ns, nf, rel::jsonb, $12, $13, $14
       FROM unnest($1::int[], $2::int[], $3::text[], $4::int[], $5::int[], $6::text[], $7::int[], $8::int[], $9::int[], $10::int[], $11::text[])
         AS t(a, p, k, r, o, re, ps, pf, ns, nf, rel)
       RETURNING id, activity_id`,
      [bulk.act, bulk.proj, bulk.kind, bulk.root, bulk.origin, bulk.reason, bulk.ps, bulk.pf, bulk.ns, bulk.nf, bulk.rel,
        approving ? ctx.userId : null, version, ctx.scenarioId ?? null]);
    const lastIds = ins.rows.map((r) => r.id);
    const lastActs = ins.rows.map((r) => r.activity_id);
    await c.query(`UPDATE activities a SET last_delay_event_id = v.e FROM (SELECT unnest($1::int[]) id, unnest($2::int[]) e) v WHERE a.id = v.id`, [lastActs, lastIds]);
  }
  for (const [actId, ev] of eventOf) await c.query('UPDATE activities SET last_delay_event_id = $2 WHERE id = $1', [actId, ev]);
  for (const [root, projects] of relatedByRoot) {
    await c.query('UPDATE delay_events SET related_projects = $2 WHERE id = $1', [root, JSON.stringify([...projects])]);
  }

  // 4. Milestones
  const existing = await c.query('SELECT * FROM milestones');
  const key = (p: number, t: string, s: number | null) => `${p}:${t}:${s ?? 0}`;
  const exMap = new Map(existing.rows.map((m) => [key(m.project_id, m.type, m.shipment_id), m]));
  const changeOf = new Map(changes.map((ch) => [ch.activityId, ch]));
  const milestoneChanges: MilestoneChange[] = [];
  const impactedByRoot = new Map<number, unknown[]>();
  for (const m of result.milestones) {
    const ex = exMap.get(key(m.projectId, m.type, m.shipmentId));
    let rootEventId: number | null = ex?.last_delay_event_id ?? null;
    const changed = (ex?.forecast_slot ?? null) !== m.forecast;
    if (changed && m.forecast !== null && ex?.forecast_slot !== null && ex?.forecast_slot !== undefined && m.forecast > ex.forecast_slot && m.drivingActivityId) {
      // Identify the originating delay along the driving chain.
      rootEventId = null;
      for (const n of drivingChain(state, result.acts, m.drivingActivityId)) {
        const ch = changeOf.get(n.activityId);
        if (!ch) continue;
        const ev = eventOf.get(ch.originActivityId);
        if (ev) { rootEventId = ev; break; }
      }
    }
    const approve = approving && approving.projectIds.has(m.projectId) && (changed || ex?.approved_slot === null || ex === undefined);
    let id: number;
    if (ex) {
      await c.query(
        `UPDATE milestones SET forecast_slot=$2, actual_slot=$3, complete=$4, driving_activity_id=$5, last_delay_event_id=$6,
           approved_slot = CASE WHEN $7 THEN $2 ELSE approved_slot END,
           baseline_slot = CASE WHEN $7 AND baseline_slot IS NULL THEN $2 ELSE baseline_slot END, updated_at = now()
         WHERE id = $1`,
        [ex.id, m.forecast, m.actual, m.complete, m.drivingActivityId, rootEventId, !!approve]);
      id = ex.id;
    } else {
      const ins = await c.query(
        `INSERT INTO milestones (project_id, shipment_id, type, forecast_slot, actual_slot, complete, driving_activity_id, approved_slot, baseline_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [m.projectId, m.shipmentId, m.type, m.forecast, m.actual, m.complete, m.drivingActivityId, approve ? m.forecast : null]);
      id = ins.rows[0].id;
    }
    if (approve && m.forecast !== null && (ex?.approved_slot ?? null) !== m.forecast) {
      await c.query(
        `INSERT INTO milestone_commitments (milestone_id, committed_slot, previous_slot, kind, reason, scenario_id, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, m.forecast, ex?.approved_slot ?? null, ex?.approved_slot === null || !ex ? 'BASELINE' : approving!.kind, approving!.reason, ctx.scenarioId ?? null, ctx.userId]);
    }
    if (changed) {
      milestoneChanges.push({ milestoneId: id, projectId: m.projectId, type: m.type, prev: ex?.forecast_slot ?? null, next: m.forecast, rootEventId });
      if (rootEventId && m.shipmentId === null) {
        const l = impactedByRoot.get(rootEventId) ?? [];
        l.push({ projectId: m.projectId, type: m.type, prev: ex?.forecast_slot ?? null, next: m.forecast, prevLabel: finishLabel(ex?.forecast_slot), nextLabel: finishLabel(m.forecast) });
        impactedByRoot.set(rootEventId, l);
      }
    }
  }
  for (const [ev, list] of impactedByRoot) {
    await c.query(`UPDATE delay_events SET impacted_milestones = impacted_milestones || $2::jsonb WHERE id = $1`, [ev, JSON.stringify(list)]);
  }

  if (!ctx.quiet) {
    const summary = {
      type: 'plan.updated', version, kind: ctx.kind, summary: ctx.summary, userId: ctx.userId,
      changedActivities: changes.length, milestoneChanges: milestoneChanges.length,
    };
    afterCommit(c, () => broadcast(summary));
  }
  return { version, changes, milestoneChanges, result, state };
}
