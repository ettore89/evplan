import type { Db } from '../db/pool.js';
import { bottleneckAnalysis, conflictsByProject, dailyUtilization } from '../engine/analysis.js';
import { CalendarSet, dayOf, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import { drivingChain, forwardSchedule } from '../engine/scheduler.js';
import type { MilestoneType } from '../engine/types.js';
import { currentSlot, currentVersion, getSetting, HttpError } from './common.js';
import { freezeInfo } from './projects.js';
import { presence } from './realtime.js';
import { loadPlanState } from './state.js';

export const MILESTONE_LABEL: Record<MilestoneType, string> = { EOL: 'EOL Testing Completed', EXW: 'ExWorks Ready', COMM: 'Commissioned' };

async function calendarSet(db: Db) {
  const st = await loadPlanState(db);
  return { cal: new CalendarSet(st.calendars, st.defaultCalendarId), state: st };
}

interface MilestoneRow {
  id: number; project_id: number; type: MilestoneType; baseline_slot: number | null; approved_slot: number | null;
  forecast_slot: number | null; actual_slot: number | null; complete: boolean; last_delay_event_id: number | null; driving_activity_id: number | null;
}

async function delayExplanations(db: Db, ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  const r = await db.query(
    `WITH RECURSIVE ev AS (SELECT * FROM delay_events WHERE id = ANY($1))
     SELECT e.id, e.kind, e.reason, e.category, e.created_at, e.related_projects,
            COALESCE(root.id, e.id) AS root_id, COALESCE(root.reason, e.reason) AS root_reason, COALESCE(root.category, e.category) AS root_category,
            COALESCE(root.kind, e.kind) AS root_kind, ra.name AS root_activity, ru.serial AS root_unit, ra.id AS root_activity_id,
            us.name AS user_name, rp.code AS root_project
     FROM ev e
     LEFT JOIN delay_events root ON root.id = e.root_event_id
     LEFT JOIN activities ra ON ra.id = COALESCE(root.activity_id, e.activity_id)
     LEFT JOIN units ru ON ru.id = ra.unit_id
     LEFT JOIN projects rp ON rp.id = ra.project_id
     LEFT JOIN users us ON us.id = COALESCE(root.user_id, e.user_id)`, [ids]);
  return new Map(r.rows.map((x) => [x.id, {
    eventId: x.id, kind: x.root_kind, reason: x.root_reason, category: x.root_category, activity: x.root_activity,
    activityId: x.root_activity_id, unit: x.root_unit, project: x.root_project, user: x.user_name, at: x.created_at,
  }]));
}

export async function milestoneViews(db: Db, projectIds?: number[]) {
  const { cal } = await calendarSet(db);
  const thresholds = await getSetting<{ amberDays: number; redDays: number }>(db, 'risk_thresholds', { amberDays: 0, redDays: 3 });
  const r = await db.query(`SELECT m.*, p.required_commissioning_date AS req FROM milestones m JOIN projects p ON p.id = m.project_id
                            WHERE m.shipment_id IS NULL ${projectIds ? 'AND m.project_id = ANY($1)' : ''}`, projectIds ? [projectIds] : []);
  const expl = await delayExplanations(db, r.rows.map((m) => m.last_delay_event_id).filter(Boolean));
  const out = new Map<number, any[]>();
  for (const m of r.rows as (MilestoneRow & { req: string })[]) {
    const current = m.actual_slot ?? m.forecast_slot;
    const variance = m.approved_slot !== null && current !== null ? cal.workingDaysBetween(m.approved_slot, current) : 0;
    const varianceBaseline = m.baseline_slot !== null && current !== null ? cal.workingDaysBetween(m.baseline_slot, current) : 0;
    const reqEnd = (Date.parse(m.req) / 86400000 + 1) * 2;
    let risk: 'GREEN' | 'AMBER' | 'RED' | 'COMPLETE' = 'GREEN';
    if (m.complete) risk = variance > 0 ? 'COMPLETE' : 'COMPLETE';
    else if ((m.type === 'COMM' && (m.forecast_slot ?? 0) > reqEnd) || variance >= thresholds.redDays) risk = 'RED';
    else if (variance > thresholds.amberDays) risk = 'AMBER';
    const view = {
      id: m.id, type: m.type, label: MILESTONE_LABEL[m.type],
      originalCommitted: m.baseline_slot, latestApproved: m.approved_slot, forecast: m.forecast_slot, actual: m.actual_slot,
      originalCommittedLabel: finishLabel(m.baseline_slot), latestApprovedLabel: finishLabel(m.approved_slot),
      forecastLabel: finishLabel(m.forecast_slot), actualLabel: finishLabel(m.actual_slot),
      varianceDays: variance, varianceVsOriginalDays: varianceBaseline, complete: m.complete, risk,
      missed: m.complete && variance > 0,
      drivingActivityId: m.driving_activity_id,
      delay: variance > 0 || varianceBaseline > 0 ? expl.get(m.last_delay_event_id!) ?? null : null,
    };
    out.set(m.project_id, [...(out.get(m.project_id) ?? []), view]);
  }
  for (const [k, l] of out) out.set(k, ['EOL', 'EXW', 'COMM'].map((t) => l.find((x) => x.type === t)).filter(Boolean));
  return out;
}

export async function portfolio(db: Db) {
  const now = await currentSlot(db);
  const projects = await db.query(`
    SELECT p.*, c.name AS customer, c.country AS customer_country, r.code AS region, rt.name AS route_name, rt.code AS route_code
    FROM projects p JOIN customers c ON c.id = p.customer_id LEFT JOIN regions r ON r.id = c.region_id JOIN routes rt ON rt.id = p.route_id
    WHERE p.status = 'ACTIVE' ORDER BY p.priority, p.id`);
  const lines = await db.query(`SELECT ol.*, pt.code, pt.name, pt.family FROM order_lines ol JOIN product_types pt ON pt.id = ol.product_type_id ORDER BY ol.line_no`);
  const stats = await db.query(`
    SELECT project_id,
      SUM(duration_slots) FILTER (WHERE status <> 'CANCELLED') AS total,
      SUM(duration_slots) FILTER (WHERE status = 'COMPLETED') AS done,
      SUM(duration_slots * pct_complete / 100.0) FILTER (WHERE status IN ('IN_PROGRESS','BLOCKED')) AS partial,
      COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blockers,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED') AND approved_finish IS NOT NULL AND approved_finish <= $1) AS overdue,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED') AND forecast_finish > approved_finish) AS late_activities,
      COUNT(*) FILTER (WHERE status IN ('IN_PROGRESS','BLOCKED')) AS in_progress
    FROM activities GROUP BY project_id`, [now]);
  const st = new Map(stats.rows.map((s) => [s.project_id, s]));
  const ms = await milestoneViews(db);
  const freeze = await freezeInfo(db);
  return {
    now, nowLabel: slotToLabel(now), version: await currentVersion(db),
    projects: projects.rows.map((p) => {
      const s = st.get(p.id) ?? {};
      const mil = ms.get(p.id) ?? [];
      const order = ['COMPLETE', 'GREEN', 'AMBER', 'RED'];
      const risk = mil.reduce((acc: string, m: any) => (order.indexOf(m.risk) > order.indexOf(acc) ? m.risk : acc), 'GREEN');
      const next = mil.find((m: any) => !m.complete) ?? null;
      return {
        id: p.id, code: p.code, name: p.name, priority: p.priority, customer: p.customer, country: p.country,
        siteLocation: p.site_location, region: p.region, route: p.route_name, requiredDate: p.required_commissioning_date,
        planStatus: p.plan_status, earliestCommissioning: finishLabel(p.earliest_commissioning_slot),
        lines: lines.rows.filter((l) => l.project_id === p.id).map((l) => ({ productCode: l.code, productName: l.name, family: l.family, quantity: l.quantity })),
        progressPct: s.total ? Math.round(((Number(s.done ?? 0) + Number(s.partial ?? 0)) / Number(s.total)) * 100) : 0,
        openBlockers: Number(s.blockers ?? 0), overdue: Number(s.overdue ?? 0), lateActivities: Number(s.late_activities ?? 0),
        inProgress: Number(s.in_progress ?? 0),
        milestones: mil, risk, nextMilestone: next ? { type: next.type, label: next.label, forecastLabel: next.forecastLabel } : null,
        freeze: freeze.get(p.id) ?? { frozen: false, freezeStartDate: null, exworksDate: null },
      };
    }),
  };
}

const ACT_COLS = `a.id, a.project_id, a.unit_id, a.shipment_id, a.seq, a.unit_seq, a.code, a.name, a.function, a.work_center_id, a.kind, a.milestone_tag,
  a.duration_slots, a.status, a.pct_complete, a.assigned_user_id, a.baseline_start, a.baseline_finish, a.approved_start, a.approved_finish,
  a.forecast_start, a.forecast_finish, a.actual_start, a.actual_finish, a.expected_finish, a.locked, a.blocker, a.delay_reason, a.driver,
  a.is_critical, a.capacity_wait_slots, a.weekend_work, a.flags, a.last_delay_event_id, a.updated_at, uu.name AS updated_by_name, wc.name AS work_center`;

function mapActivity(a: any, expl: Map<number, any>) {
  const lastEvent = a.last_delay_event_id ? expl.get(a.last_delay_event_id) : null;
  const delayed = a.forecast_finish !== null && a.approved_finish !== null && a.forecast_finish > a.approved_finish;
  const rescheduled = a.baseline_finish !== null && a.approved_finish !== null && a.approved_finish !== a.baseline_finish;
  return {
    id: a.id, projectId: a.project_id, unitId: a.unit_id, shipmentId: a.shipment_id, seq: a.seq, unitSeq: a.unit_seq,
    code: a.code, name: a.name, function: a.function, workCenterId: a.work_center_id, workCenter: a.work_center, kind: a.kind,
    milestoneTag: a.milestone_tag, durationSlots: a.duration_slots, status: a.status, pctComplete: a.pct_complete,
    assignedUserId: a.assigned_user_id,
    baselineStart: a.baseline_start, baselineFinish: a.baseline_finish, approvedStart: a.approved_start, approvedFinish: a.approved_finish,
    forecastStart: a.forecast_start, forecastFinish: a.forecast_finish, actualStart: a.actual_start, actualFinish: a.actual_finish,
    expectedFinish: a.expected_finish, locked: a.locked, blocker: a.blocker, delayReason: a.delay_reason, driver: a.driver,
    isCritical: a.is_critical, capacityWaitSlots: a.capacity_wait_slots, weekendWork: a.weekend_work, flags: a.flags,
    delayed, rescheduled, delaySlots: delayed ? a.forecast_finish - a.approved_finish : 0,
    lastEvent, updatedByName: a.updated_by_name, updatedAt: a.updated_at,
  };
}

export async function activitiesFor(db: Db, where: string, params: unknown[]) {
  const r = await db.query(`SELECT ${ACT_COLS} FROM activities a LEFT JOIN users uu ON uu.id = a.updated_by LEFT JOIN work_centers wc ON wc.id = a.work_center_id
    JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE' ${where} ORDER BY a.project_id, a.unit_seq, a.seq`, params);
  const expl = await delayExplanations(db, r.rows.map((a) => a.last_delay_event_id).filter(Boolean));
  return r.rows.map((a) => mapActivity(a, expl));
}

export async function gantt(db: Db) {
  const pf = await portfolio(db);
  const { cal, state } = await calendarSet(db);
  const units = await db.query(`SELECT u.*, pt.code AS product_code, pt.name AS product_name, pt.family FROM units u
    JOIN order_lines ol ON ol.id = u.order_line_id JOIN product_types pt ON pt.id = ol.product_type_id ORDER BY u.project_id, u.seq`);
  const shipments = await db.query(`SELECT s.*, r.name AS route FROM shipments s JOIN routes r ON r.id = s.route_id`);
  const acts = await activitiesFor(db, '', []);
  const deps = await db.query(`SELECT pred_id, succ_id FROM dependencies`);
  const res = await db.query(`SELECT work_center_id, slot, SUM(load) AS load, COUNT(*) AS n, array_agg(activity_id) AS acts FROM reservations
    WHERE slot >= $1 GROUP BY work_center_id, slot`, [pf.now]);
  const wcs = await db.query('SELECT * FROM work_centers ORDER BY route_order, id');
  const weekend = await db.query(`SELECT w.*, wc.name AS work_center, a.name AS activity FROM weekend_authorizations w
    LEFT JOIN work_centers wc ON wc.id = w.work_center_id LEFT JOIN activities a ON a.id = w.activity_id WHERE w.active`);
  const ctxCap = (wcId: number, slot: number) => {
    const w = wcs.rows.find((x) => x.id === wcId);
    return Number(w?.capacity ?? Infinity);
  };
  const overloads = res.rows
    .filter((r) => Number(r.load) > ctxCap(r.work_center_id, r.slot) + 1e-6 || Number(r.n) > (wcs.rows.find((w) => w.id === r.work_center_id)?.max_concurrent ?? 99))
    .map((r) => ({ workCenterId: r.work_center_id, slot: r.slot, load: Number(r.load), activities: r.acts }));
  const minS = Math.min(pf.now, ...acts.map((a) => a.actualStart ?? a.forecastStart ?? pf.now));
  const maxS = Math.max(pf.now + 60, ...acts.map((a) => a.forecastFinish ?? 0));
  const nonWorking: number[] = [];
  for (let d = dayOf(minS) - 7; d <= dayOf(maxS) + 14; d++) if (!cal.isWorkingDay(state.defaultCalendarId, d)) nonWorking.push(d);
  const deliverable = shipments.rows.map((s) => ({ id: s.id, projectId: s.project_id, code: s.code, route: s.route }));
  return {
    now: pf.now, version: pf.version, range: { from: minS, to: maxS }, nonWorkingDays: nonWorking,
    projects: pf.projects,
    units: units.rows.map((u) => ({ id: u.id, projectId: u.project_id, serial: u.serial, seq: u.seq, productCode: u.product_code, productName: u.product_name, family: u.family, shipmentId: u.shipment_id })),
    shipments: deliverable,
    activities: acts,
    dependencies: deps.rows.map((d) => ({ pred: d.pred_id, succ: d.succ_id })),
    overloads,
    workCenters: wcs.rows.map((w) => ({ id: w.id, code: w.code, name: w.name, capacity: Number(w.capacity), maxConcurrent: w.max_concurrent, minRate: Number(w.min_rate), capacityModel: w.capacity_model })),
    weekendAuthorizations: weekend.rows.map((w) => ({ id: w.id, date: w.date, workCenter: w.work_center, activity: w.activity, reason: w.reason, capacity: w.capacity })),
  };
}

export async function projectDetails(db: Db, id: number) {
  const p = (await db.query(`SELECT p.*, c.name AS customer, c.country AS customer_country, rt.name AS route_name, rt.lead_time_days, rt.min_days, rt.max_days
    FROM projects p JOIN customers c ON c.id = p.customer_id JOIN routes rt ON rt.id = p.route_id WHERE p.id = $1`, [id])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  const pf = await portfolio(db);
  const summary = pf.projects.find((x) => x.id === id);
  const units = await db.query(`SELECT u.*, pt.code AS product_code, pt.name AS product_name FROM units u JOIN order_lines ol ON ol.id = u.order_line_id
    JOIN product_types pt ON pt.id = ol.product_type_id WHERE u.project_id = $1 ORDER BY u.seq`, [id]);
  const acts = await activitiesFor(db, 'AND a.project_id = $1', [id]);
  const comments = await db.query(`SELECT cm.*, u.name AS user_name, u.role, a.name AS activity, un.serial FROM comments cm JOIN users u ON u.id = cm.user_id
    LEFT JOIN activities a ON a.id = cm.activity_id LEFT JOIN units un ON un.id = a.unit_id WHERE cm.project_id = $1 ORDER BY cm.created_at DESC LIMIT 300`, [id]);
  const delays = await db.query(`SELECT e.*, a.name AS activity, un.serial, u.name AS user_name, ra.name AS origin_activity, ru.serial AS origin_unit, rp.code AS origin_project
    FROM delay_events e LEFT JOIN activities a ON a.id = e.activity_id LEFT JOIN units un ON un.id = a.unit_id LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN activities ra ON ra.id = e.origin_activity_id LEFT JOIN units ru ON ru.id = ra.unit_id LEFT JOIN projects rp ON rp.id = ra.project_id
    WHERE e.project_id = $1 AND e.kind IN ('ROOT','SYSTEM','APPROVED_CHANGE','CAPACITY') ORDER BY e.created_at DESC, e.id DESC LIMIT 300`, [id]);
  const commitments = await db.query(`SELECT mc.*, m.type, u.name AS user_name FROM milestone_commitments mc JOIN milestones m ON m.id = mc.milestone_id
    LEFT JOIN users u ON u.id = mc.user_id WHERE m.project_id = $1 AND m.shipment_id IS NULL ORDER BY mc.created_at, mc.id`, [id]);
  const history = await db.query(`SELECT ae.*, u.name AS user_name FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id
    WHERE ae.project_id = $1 ORDER BY ae.ts DESC LIMIT 300`, [id]);
  return {
    project: {
      id: p.id, code: p.code, name: p.name, customer: p.customer, siteLocation: p.site_location, country: p.country,
      route: p.route_name, transport: `${p.min_days}–${p.max_days} days (planned ${p.lead_time_days})`,
      requiredDate: p.required_commissioning_date, priority: p.priority, planStatus: p.plan_status,
      earliestCommissioning: finishLabel(p.earliest_commissioning_slot), notes: p.notes, createdAt: p.created_at,
    },
    summary,
    units: units.rows.map((u) => ({ id: u.id, serial: u.serial, seq: u.seq, productCode: u.product_code, productName: u.product_name, batchId: u.batch_id })),
    activities: acts,
    comments: comments.rows,
    delayEvents: delays.rows.map((e) => ({ ...e, prevFinishLabel: finishLabel(e.prev_finish), newFinishLabel: finishLabel(e.new_finish) })),
    commitments: commitments.rows.map((c) => ({ ...c, committedLabel: finishLabel(c.committed_slot), previousLabel: finishLabel(c.previous_slot) })),
    history: history.rows,
  };
}

/** Driving chain behind a milestone, from the milestone back to its originating activity. */
export async function milestoneChain(db: Db, projectId: number, type: MilestoneType) {
  const state = await loadPlanState(db);
  const result = forwardSchedule(state);
  const m = result.milestones.find((x) => x.projectId === projectId && x.type === type && x.shipmentId === null);
  if (!m || m.drivingActivityId === null) throw new HttpError(404, 'Milestone not found');
  const chain = drivingChain(state, result.acts, m.drivingActivityId);
  const ids = chain.map((n) => n.activityId);
  const acts = await activitiesFor(db, 'AND a.id = ANY($1)', [ids]);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const units = await db.query('SELECT id, serial FROM units WHERE project_id = $1', [projectId]);
  const serial = new Map(units.rows.map((u) => [u.id, u.serial]));
  const nodes = chain.map((n) => {
    const a = byId.get(n.activityId)!;
    return {
      activityId: n.activityId, name: a.name, unit: a.unitId ? serial.get(a.unitId) : 'Shipment', workCenter: a.workCenter,
      driver: n.driver, startLabel: slotToLabel(n.start), finishLabel: finishLabel(n.finish), status: a.status,
      delaySlots: a.delaySlots, delayed: a.delayed, lastEvent: a.lastEvent,
    };
  });
  // Originating activity: deepest delayed node whose delay was not itself caused by a predecessor.
  let origin: number | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].delayed || nodes[i].lastEvent?.kind === 'ROOT') { origin = nodes[i].activityId; break; }
  }
  return { projectId, type, label: MILESTONE_LABEL[type], forecastLabel: finishLabel(m.forecast), nodes, originActivityId: origin };
}

export async function capacityView(db: Db, days = 42) {
  const state = await loadPlanState(db);
  const result = forwardSchedule(state);
  const from = dayOf(state.now);
  const util = dailyUtilization(state, result, from, from + days);
  const wcs = await db.query('SELECT * FROM work_centers ORDER BY route_order, id');
  const order = wcs.rows.map((w) => w.id);
  const bn = bottleneckAnalysis(state, result, order, new Map(wcs.rows.map((w) => [w.id, w.sizing_target_id])));
  const conflicts = conflictsByProject(state, result);
  const projects = await db.query(`SELECT id, code, name, priority FROM projects WHERE status = 'ACTIVE'`);
  const pcode = new Map(projects.rows.map((p) => [p.id, p.code]));
  const grouped = new Map<string, any>();
  for (const c of conflicts) {
    const k = `${c.projectId}:${c.workCenterId}`;
    const g = grouped.get(k) ?? { projectId: c.projectId, project: pcode.get(c.projectId), workCenterId: c.workCenterId, waitDays: 0, activities: 0, blockingProjects: new Set<number>() };
    g.waitDays += c.waitDays;
    g.activities++;
    for (const b of c.blockingProjects) g.blockingProjects.add(b);
    grouped.set(k, g);
  }
  const ms = await milestoneViews(db);
  const risk = { GREEN: 0, AMBER: 0, RED: 0, COMPLETE: 0 } as Record<string, number>;
  for (const l of ms.values()) for (const m of l) risk[m.risk]++;
  const proposals = bn
    .filter((b) => b.isProgramBottleneck || b.starvesDownstream || b.capacityWaitDays > 0)
    .sort((a, b) => b.capacityWaitDays - a.capacityWaitDays)
    .slice(0, 5)
    .map((b) => {
      const w = wcs.rows.find((x) => x.id === b.workCenterId);
      const step = w.capacity_model === 'effective' ? 0.5 : 1;
      const to = b.starvesDownstream && b.requiredCapacityToFeedDownstream ? Math.max(Number(w.capacity) + step, Math.ceil(b.requiredCapacityToFeedDownstream / step) * step) : Number(w.capacity) + step;
      return {
        workCenterId: b.workCenterId, workCenter: b.name, from: Number(w.capacity), to,
        rationale: b.starvesDownstream
          ? `Throughput ${b.throughputPerDay}/day is below downstream ${b.downstreamCode} (${b.downstreamThroughput}/day): +${b.additionalCapacityNeeded} capacity needed to avoid starving it`
          : b.isProgramBottleneck ? `Program bottleneck (lowest nominal throughput ${b.throughputPerDay} systems/day)` : `Queueing of ${b.capacityWaitDays} working days in the current plan`,
      };
    });
  return {
    now: state.now,
    workCenters: wcs.rows.map((w) => ({
      id: w.id, code: w.code, name: w.name, function: w.function, capacity: Number(w.capacity), maxConcurrent: w.max_concurrent, minRate: Number(w.min_rate),
      capacityModel: w.capacity_model, notes: w.notes,
    })),
    utilization: util.map((u) => ({ ...u, date: dayToIso(u.day) })),
    bottlenecks: bn,
    overloads: result.overloads.map((o) => ({ ...o, slotLabel: slotToLabel(o.slot) })),
    conflicts: [...grouped.values()].map((g) => ({ ...g, blockingProjects: [...g.blockingProjects].map((p) => pcode.get(p)) })).sort((a, b) => b.waitDays - a.waitDays),
    riskSummary: risk,
    proposals,
  };
}

export async function snapshotData(db: Db) {
  const acts = await db.query('SELECT id, project_id, status, forecast_start, forecast_finish, blocker FROM activities');
  const ms = await db.query('SELECT project_id, type, forecast_slot, approved_slot, actual_slot FROM milestones WHERE shipment_id IS NULL');
  const pr = await db.query(`SELECT id, code, priority FROM projects WHERE status = 'ACTIVE'`);
  return {
    priorities: pr.rows.map((p) => ({ id: p.id, code: p.code, priority: p.priority })),
    milestones: ms.rows.map((m) => ({ projectId: m.project_id, type: m.type, forecast: m.forecast_slot, approved: m.approved_slot, actual: m.actual_slot })),
    activities: acts.rows.map((a) => ({ id: a.id, projectId: a.project_id, status: a.status, fs: a.forecast_start, ff: a.forecast_finish, blocker: a.blocker })),
  };
}

export async function diffSinceSnapshot(db: Db, snapshotId?: number) {
  const snap = snapshotId
    ? (await db.query('SELECT * FROM plan_snapshots WHERE id = $1', [snapshotId])).rows[0]
    : (await db.query(`SELECT * FROM plan_snapshots WHERE kind = 'DAILY_CALL' ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0];
  if (!snap) return null;
  const cur = await snapshotData(db);
  const old = snap.data as Awaited<ReturnType<typeof snapshotData>>;
  const pcode = new Map(cur.priorities.map((p) => [p.id, p.code]));
  const oldPrio = new Map(old.priorities.map((p) => [p.id, p.priority]));
  const oldMs = new Map(old.milestones.map((m) => [`${m.projectId}:${m.type}`, m]));
  const oldActs = new Map(old.activities.map((a) => [a.id, a]));
  const names = await db.query(`SELECT a.id, a.name, u.serial FROM activities a LEFT JOIN units u ON u.id = a.unit_id`);
  const nm = new Map(names.rows.map((r) => [r.id, `${r.serial ? r.serial + ' · ' : ''}${r.name}`]));
  const { cal } = await calendarSet(db);
  const statusChanges = cur.activities
    .filter((a) => oldActs.has(a.id) && oldActs.get(a.id)!.status !== a.status)
    .map((a) => ({ activityId: a.id, projectId: a.projectId, project: pcode.get(a.projectId), name: nm.get(a.id), from: oldActs.get(a.id)!.status, to: a.status }));
  const events = await db.query(`SELECT ae.id, ae.ts, ae.action, ae.change_class, ae.reason, ae.project_id, p.code AS project, u.name AS user_name, u.role
    FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id LEFT JOIN projects p ON p.id = ae.project_id
    WHERE ae.ts > $1 AND ae.change_class <> 'SYSTEM' ORDER BY ae.ts DESC LIMIT 200`, [snap.created_at]);
  return {
    snapshot: { id: snap.id, label: snap.label, createdAt: snap.created_at },
    priorityChanges: cur.priorities.filter((p) => oldPrio.has(p.id) && oldPrio.get(p.id) !== p.priority).map((p) => ({ projectId: p.id, project: p.code, from: oldPrio.get(p.id), to: p.priority })),
    milestoneChanges: cur.milestones
      .filter((m) => { const o = oldMs.get(`${m.projectId}:${m.type}`); return o && (o.forecast !== m.forecast || o.actual !== m.actual || o.approved !== m.approved); })
      .map((m) => {
        const o = oldMs.get(`${m.projectId}:${m.type}`)!;
        return { projectId: m.projectId, project: pcode.get(m.projectId), type: m.type, label: MILESTONE_LABEL[m.type as MilestoneType], fromLabel: finishLabel(o.forecast), toLabel: finishLabel(m.forecast),
          deltaDays: o.forecast !== null && m.forecast !== null ? cal.workingDaysBetween(o.forecast, m.forecast) : 0, approvedChanged: o.approved !== m.approved, completed: o.actual === null && m.actual !== null };
      }),
    statusChanges,
    newBlockers: cur.activities.filter((a) => a.status === 'BLOCKED' && oldActs.get(a.id)?.status !== 'BLOCKED').map((a) => ({ activityId: a.id, project: pcode.get(a.projectId), name: nm.get(a.id), blocker: a.blocker })),
    rescheduledActivities: cur.activities.filter((a) => oldActs.has(a.id) && oldActs.get(a.id)!.ff !== a.ff).length,
    events: events.rows,
  };
}

export async function dailyControl(db: Db) {
  const pf = await portfolio(db);
  const now = pf.now;
  const today = dayOf(now);
  const acts = await activitiesFor(db, `AND a.status NOT IN ('COMPLETED','CANCELLED')`, []);
  const units = await db.query('SELECT id, serial FROM units');
  const serial = new Map(units.rows.map((u) => [u.id, u.serial]));
  const pcode = new Map(pf.projects.map((p) => [p.id, p.code]));
  const label = (a: any) => ({
    id: a.id, projectId: a.projectId, project: pcode.get(a.projectId), unit: a.unitId ? serial.get(a.unitId) : 'Shipment', name: a.name,
    function: a.function, workCenter: a.workCenter, status: a.status, forecastStartLabel: slotToLabel(a.forecastStart), forecastFinishLabel: finishLabel(a.forecastFinish),
    approvedFinishLabel: finishLabel(a.approvedFinish), delaySlots: a.delaySlots, blocker: a.blocker, driver: a.driver, isCritical: a.isCritical,
    forecastStart: a.forecastStart, forecastFinish: a.forecastFinish, approvedStart: a.approvedStart, approvedFinish: a.approvedFinish,
    expectedFinish: a.expectedFinish, actualStart: a.actualStart, pctComplete: a.pctComplete, locked: a.locked, lastEvent: a.lastEvent,
  });
  const todays = acts.filter((a) => a.forecastStart !== null && dayOf(a.forecastStart) <= today && dayOf((a.forecastFinish ?? 1) - 1) >= today);
  const overdue = acts.filter((a) => a.approvedFinish !== null && a.approvedFinish <= now);
  const blockers = acts.filter((a) => a.status === 'BLOCKED');
  const awaiting = acts.filter((a) => ['now', 'overdue'].includes(a.driver?.type) || (a.status !== 'IN_PROGRESS' && a.status !== 'BLOCKED' && a.approvedStart !== null && a.approvedStart < now));
  const cap = await capacityView(db, 14);
  const pending = await db.query(`SELECT s.id, s.name, s.status, s.result->>'summary' AS summary, s.frozen_projects, u.name AS created_by_name, s.created_at
    FROM scenarios s JOIN users u ON u.id = s.created_by WHERE s.status = 'PENDING_APPROVAL' ORDER BY s.created_at`);
  const decisions = await db.query(`SELECT d.*, p.code AS project, u.name AS user_name FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
    JOIN users u ON u.id = d.user_id ORDER BY d.status, d.created_at DESC LIMIT 50`);
  const mgmt: any[] = [];
  for (const s of pending.rows) mgmt.push({ kind: 'APPROVAL', title: `Approve scenario "${s.name}"`, detail: s.summary, scenarioId: s.id });
  for (const p of pf.projects) {
    if (p.planStatus === 'INFEASIBLE') mgmt.push({ kind: 'INFEASIBLE', title: `${p.code}: required commissioning date not achievable`, detail: `Earliest: ${p.earliestCommissioning}`, projectId: p.id });
    for (const m of p.milestones) if (m.risk === 'RED') mgmt.push({ kind: 'RISK', title: `${p.code}: ${m.label} at risk`, detail: `Forecast ${m.forecastLabel} vs committed ${m.latestApprovedLabel} (${m.varianceDays > 0 ? '+' : ''}${m.varianceDays} wd)`, projectId: p.id });
  }
  for (const o of cap.overloads.slice(0, 5)) mgmt.push({ kind: 'OVERLOAD', title: `Capacity overload at ${cap.workCenters.find((w) => w.id === o.workCenterId)?.name}`, detail: `${o.slotLabel}: ${o.load} / ${o.capacity}` });
  return {
    now, nowLabel: pf.nowLabel, version: pf.version,
    projects: pf.projects,
    todays: todays.map(label),
    overdue: overdue.map(label),
    blockers: blockers.map(label),
    awaitingUpdates: awaiting.map(label),
    capacityConflicts: { overloads: cap.overloads.slice(0, 30), queueing: cap.conflicts.slice(0, 15) },
    managementDecisions: mgmt,
    decisions: decisions.rows,
    changesSincePreviousCall: await diffSinceSnapshot(db),
    connectedUsers: presence(),
  };
}
