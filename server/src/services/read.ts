import type { Db } from '../db/pool.js';
import { bottleneckAnalysis, conflictsByProject, dailyUtilization } from '../engine/analysis.js';
import { CalendarSet, dayOf, dayToIso, finishLabel, slotToLabel } from '../engine/calendar.js';
import { drivingChain, forwardSchedule } from '../engine/scheduler.js';
import type { MilestoneType } from '../engine/types.js';
import { currentSlot, currentVersion, getSetting, HttpError } from './common.js';
import { freezeInfo } from './projects.js';
import { presence } from './realtime.js';
import { conditionalActive, loadPlanState } from './state.js';

export const MILESTONE_LABEL: Record<MilestoneType, string> = { EOL: 'EOL Testing Completed', EXW: 'ExWorks Ready', COMM: 'Commissioned' };
const UNIT_WORD: Record<MilestoneType, string> = { EOL: 'units tested', EXW: 'units packed', COMM: 'systems commissioned' };

async function calendarSet(db: Db) {
  const st = await loadPlanState(db);
  return { cal: new CalendarSet(st.calendars, st.defaultCalendarId), state: st };
}

async function delayExplanations(db: Db, ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  const r = await db.query(
    `SELECT e.id, COALESCE(root.id, e.id) AS root_id, COALESCE(root.reason, e.reason) AS root_reason, COALESCE(root.category, e.category) AS root_category,
            COALESCE(root.kind, e.kind) AS root_kind, ra.name AS root_activity, COALESCE(ru.name, ru.internal_id) AS root_unit, ra.id AS root_activity_id,
            ra.function AS root_function, us.name AS user_name, rp.code AS root_project, e.created_at, e.related_projects
     FROM delay_events e
     LEFT JOIN delay_events root ON root.id = e.root_event_id
     LEFT JOIN activities ra ON ra.id = COALESCE(root.activity_id, e.activity_id)
     LEFT JOIN units ru ON ru.id = ra.unit_id
     LEFT JOIN projects rp ON rp.id = ra.project_id
     LEFT JOIN users us ON us.id = COALESCE(root.user_id, e.user_id) WHERE e.id = ANY($1)`, [ids]);
  return new Map(r.rows.map((x) => [x.id, {
    eventId: x.id, kind: x.root_kind, reason: x.root_reason, category: x.root_category, activity: x.root_activity, owner: x.root_function,
    activityId: x.root_activity_id, unit: x.root_unit, project: x.root_project, user: x.user_name, at: x.created_at,
  }]));
}

/** Milestone views: original commitment, latest approved, forecast, actual, variance, risk, confidence, partial completion. */
export async function milestoneViews(db: Db, projectIds?: number[]) {
  const { cal } = await calendarSet(db);
  const thresholds = await getSetting<{ amberDays: number; redDays: number }>(db, 'risk_thresholds', { amberDays: 0, redDays: 3 });
  const r = await db.query(`SELECT m.*, p.required_commissioning_date AS req, s.code shipment_code, v.code visit_code FROM milestones m JOIN projects p ON p.id = m.project_id
    LEFT JOIN shipments s ON s.id = m.shipment_id LEFT JOIN commissioning_visits v ON v.id = m.visit_id
    ${projectIds ? 'WHERE m.project_id = ANY($1)' : ''} ORDER BY m.project_id, m.shipment_id NULLS FIRST, m.visit_id NULLS FIRST`, projectIds ? [projectIds] : []);
  const expl = await delayExplanations(db, r.rows.map((m) => m.last_delay_event_id).filter(Boolean));
  const out = new Map<number, any[]>();
  const parts = new Map<number, any[]>();
  for (const m of r.rows) {
    const current = m.actual_slot ?? m.forecast_slot;
    const variance = m.approved_slot !== null && current !== null ? cal.workingDaysBetween(m.approved_slot, current) : 0;
    const varianceBaseline = m.baseline_slot !== null && current !== null ? cal.workingDaysBetween(m.baseline_slot, current) : 0;
    const reqEnd = m.req ? (Date.parse(m.req) / 86400000 + 1) * 2 : null;
    let risk: 'GREEN' | 'AMBER' | 'RED' | 'COMPLETE' = 'GREEN';
    if (m.complete) risk = 'COMPLETE';
    else if ((m.type === 'COMM' && reqEnd !== null && (m.forecast_slot ?? 0) > reqEnd) || variance >= thresholds.redDays) risk = 'RED';
    else if (variance > thresholds.amberDays || m.confidence === 'OPEN') risk = 'AMBER';
    const view = {
      id: m.id, type: m.type, label: MILESTONE_LABEL[m.type as MilestoneType], shipmentId: m.shipment_id, visitId: m.visit_id, scopeCode: m.shipment_code ?? m.visit_code ?? null,
      originalCommitted: m.baseline_slot, latestApproved: m.approved_slot, forecast: m.forecast_slot, actual: m.actual_slot,
      originalCommittedLabel: finishLabel(m.baseline_slot), latestApprovedLabel: finishLabel(m.approved_slot), forecastLabel: finishLabel(m.forecast_slot), actualLabel: finishLabel(m.actual_slot),
      varianceDays: variance, varianceVsOriginalDays: varianceBaseline, complete: m.complete, risk, missed: m.complete && variance > 0,
      confidence: m.confidence, done: m.done, total: m.total, progressLabel: m.total ? `${m.done} of ${m.total} ${UNIT_WORD[m.type as MilestoneType]}` : '',
      drivingActivityId: m.driving_activity_id,
      delay: variance > 0 || varianceBaseline > 0 ? expl.get(m.last_delay_event_id) ?? null : null,
    };
    if (m.shipment_id === null && m.visit_id === null) out.set(m.project_id, [...(out.get(m.project_id) ?? []), view]);
    else parts.set(m.project_id, [...(parts.get(m.project_id) ?? []), view]);
  }
  for (const [k, l] of out) out.set(k, ['EOL', 'EXW', 'COMM'].map((t) => l.find((x) => x.type === t)).filter(Boolean));
  return { main: out, parts };
}

/** Readiness summary per project: open gates by status, next blocker, last confirmation. */
export async function readinessSummary(db: Db, now: number) {
  const r = await db.query(`SELECT g.*, a.name activity, a.code activity_code, a.forecast_start, a.approved_start, a.is_critical, COALESCE(u.name, u.internal_id) unit, s.code system_code
    FROM readiness_gates g JOIN activities a ON a.id = g.activity_id LEFT JOIN units u ON u.id = g.unit_id LEFT JOIN systems s ON s.id = g.system_id
    WHERE a.status NOT IN ('COMPLETED','CANCELLED') ORDER BY a.forecast_start NULLS LAST`);
  const out = new Map<number, { UNKNOWN: number; PENDING: number; BLOCKED: number; READY: number; planned: number; conditional: number; nextBlocker: any; lastConfirmed: string | null }>();
  for (const g of r.rows) {
    const o = out.get(g.project_id) ?? { UNKNOWN: 0, PENDING: 0, BLOCKED: 0, READY: 0, planned: 0, conditional: 0, nextBlocker: null, lastConfirmed: null };
    out.set(g.project_id, o);
    if (g.awaiting_plan) { o.planned++; continue; }
    const cond = conditionalActive(g.conditional_release, now);
    if (cond && g.status !== 'READY') o.conditional++;
    o[g.status as 'UNKNOWN' | 'PENDING' | 'BLOCKED' | 'READY']++;
    if (g.last_confirmed_at && (!o.lastConfirmed || g.last_confirmed_at.toISOString() > o.lastConfirmed)) o.lastConfirmed = g.last_confirmed_at.toISOString();
    if (g.status !== 'READY' && !cond && !o.nextBlocker) {
      o.nextBlocker = { gateId: g.id, title: g.title, dimension: g.dimension, status: g.status, activity: g.activity, unit: g.unit ?? g.system_code, owner: g.owner_name ?? g.owner_role, neededFrom: slotToLabel(g.forecast_start), forecastLabel: finishLabel(g.forecast_slot) };
    }
  }
  return out;
}

export async function portfolio(db: Db) {
  const now = await currentSlot(db);
  const projects = await db.query(`
    SELECT p.*, c.name AS customer, r.code AS region, rt.name AS route_name, sp.name AS service_profile, sp.confirmation_status AS service_status
    FROM projects p JOIN customers c ON c.id = p.customer_id LEFT JOIN regions r ON r.id = c.region_id JOIN routes rt ON rt.id = p.route_id
    LEFT JOIN service_profiles sp ON sp.id = p.service_profile_id WHERE p.status = 'ACTIVE' ORDER BY p.priority, p.id`);
  const lines = await db.query(`SELECT ol.*, pt.code, pt.name, pt.family, (SELECT array_agg(DISTINCT u.item_code) FROM units u WHERE u.order_line_id = ol.id AND u.item_code IS NOT NULL) item_codes
    FROM order_lines ol JOIN product_types pt ON pt.id = ol.product_type_id ORDER BY ol.line_no`);
  const stats = await db.query(`
    SELECT project_id,
      SUM(duration_slots) FILTER (WHERE status <> 'CANCELLED') AS total, SUM(duration_slots) FILTER (WHERE status = 'COMPLETED') AS done,
      SUM(duration_slots * pct_complete / 100.0) FILTER (WHERE status IN ('IN_PROGRESS','BLOCKED')) AS partial,
      COUNT(*) FILTER (WHERE status = 'BLOCKED') AS blockers,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED') AND approved_finish IS NOT NULL AND approved_finish <= $1) AS overdue,
      COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED') AND forecast_finish > approved_finish) AS late_activities,
      MAX(updated_at) FILTER (WHERE updated_by IS NOT NULL) AS last_update
    FROM activities GROUP BY project_id`, [now]);
  const counts = await db.query(`SELECT project_id, COUNT(*) FILTER (WHERE status = 'ACTIVE') units, COUNT(DISTINCT system_id) FILTER (WHERE status = 'ACTIVE') systems,
      COUNT(*) FILTER (WHERE disposition <> 'RELEASABLE' AND status = 'ACTIVE') held FROM units GROUP BY project_id`);
  const st = new Map(stats.rows.map((s) => [s.project_id, s]));
  const cn = new Map(counts.rows.map((s) => [s.project_id, s]));
  const ms = await milestoneViews(db);
  const freeze = await freezeInfo(db);
  const readiness = await readinessSummary(db, now);
  return {
    now, nowLabel: slotToLabel(now), version: await currentVersion(db),
    projects: projects.rows.map((p) => {
      const s = st.get(p.id) ?? {};
      const mil = ms.main.get(p.id) ?? [];
      const order = ['COMPLETE', 'GREEN', 'AMBER', 'RED'];
      const risk = mil.reduce((acc: string, m: any) => (order.indexOf(m.risk) > order.indexOf(acc) ? m.risk : acc), 'GREEN');
      const conf = mil.reduce((acc: string, m: any) => (m.confidence === 'OPEN' ? 'OPEN' : m.confidence === 'CONDITIONAL' && acc !== 'OPEN' ? 'CONDITIONAL' : acc), 'FIRM');
      const next = mil.find((m: any) => !m.complete) ?? null;
      const rd = readiness.get(p.id) ?? { UNKNOWN: 0, PENDING: 0, BLOCKED: 0, READY: 0, planned: 0, conditional: 0, nextBlocker: null, lastConfirmed: null };
      const lastUpdate = [s.last_update?.toISOString?.(), rd.lastConfirmed].filter(Boolean).sort().pop() ?? null;
      const executing = Number(s.done ?? 0) > 0 || Number(s.partial ?? 0) > 0;
      return {
        id: p.id, code: p.code, name: p.name, priority: p.priority, customer: p.customer, country: p.country, siteLocation: p.site_location, region: p.region,
        route: p.route_name, serviceProfile: p.service_profile, serviceStatus: p.service_status, requiredDate: p.required_commissioning_date,
        requiredText: p.required_commissioning_text, requiredExwText: p.required_exw_text, wave: p.wave, series: p.series, sapOrderRef: p.sap_order_ref, o2cOwner: p.o2c_owner,
        demandStatus: p.demand_status, lifecycle: p.demand_status === 'COMMITTED' ? (executing ? 'EXECUTION' : 'COMMITTED') : p.demand_status === 'APPROVED' ? 'APPROVED_AWAITING_SCHEDULE' : 'TENTATIVE',
        planStatus: p.plan_status, planConfidence: p.plan_confidence, earliestCommissioning: finishLabel(p.earliest_commissioning_slot), source: p.source,
        lines: lines.rows.filter((l) => l.project_id === p.id).map((l) => ({ productCode: l.code, productName: l.name, family: l.family, quantity: l.quantity, itemCodes: l.item_codes ?? [] })),
        units: Number(cn.get(p.id)?.units ?? 0), systems: Number(cn.get(p.id)?.systems ?? 0), heldUnits: Number(cn.get(p.id)?.held ?? 0),
        progressPct: s.total ? Math.round(((Number(s.done ?? 0) + Number(s.partial ?? 0)) / Number(s.total)) * 100) : 0,
        openBlockers: Number(s.blockers ?? 0), overdue: Number(s.overdue ?? 0), lateActivities: Number(s.late_activities ?? 0),
        milestones: mil, milestoneParts: ms.parts.get(p.id) ?? [], risk, confidence: conf,
        nextMilestone: next ? { type: next.type, label: next.label, forecastLabel: next.forecastLabel } : null,
        readiness: rd, lastUpdate,
        freeze: freeze.get(p.id) ?? { frozen: false, freezeStartDate: null, exworksDate: null, shipments: [] },
      };
    }),
  };
}

const ACT_COLS = `a.*, uu.name AS updated_by_name, wc.name AS work_center, COALESCE(un.name, un.internal_id) AS unit_label, un.internal_id, sy.code AS system_code`;

function mapActivity(a: any, expl: Map<number, any>, gates: Map<number, any[]>) {
  const lastEvent = a.last_delay_event_id ? expl.get(a.last_delay_event_id) : null;
  const delayed = a.forecast_finish !== null && a.approved_finish !== null && a.forecast_finish > a.approved_finish;
  const rescheduled = a.baseline_finish !== null && a.approved_finish !== null && a.approved_finish !== a.baseline_finish;
  return {
    id: a.id, projectId: a.project_id, unitId: a.unit_id, systemId: a.system_id, shipmentId: a.shipment_id, visitId: a.visit_id, scope: a.scope, stage: a.stage,
    seq: a.seq, unitSeq: a.unit_seq, code: a.code, name: a.name, function: a.function, workCenterId: a.work_center_id, workCenter: a.work_center, kind: a.kind,
    milestoneTag: a.milestone_tag, durationSlots: a.duration_slots, phases: a.phases, status: a.status, pctComplete: a.pct_complete, assignedUserId: a.assigned_user_id,
    baselineStart: a.baseline_start, baselineFinish: a.baseline_finish, approvedStart: a.approved_start, approvedFinish: a.approved_finish,
    forecastStart: a.forecast_start, forecastFinish: a.forecast_finish, actualStart: a.actual_start, actualFinish: a.actual_finish,
    expectedFinish: a.expected_finish, deadlineAt: a.deadline_at, locked: a.locked, blocker: a.blocker, delayReason: a.delay_reason, driver: a.driver,
    confidence: a.confidence, isCritical: a.is_critical, capacityWaitSlots: a.capacity_wait_slots, weekendWork: a.weekend_work, flags: a.flags, source: a.source, reworkId: a.rework_id,
    unitLabel: a.unit_label, internalId: a.internal_id, systemCode: a.system_code,
    delayed, rescheduled, delaySlots: delayed ? a.forecast_finish - a.approved_finish : 0,
    gates: gates.get(a.id) ?? [], lastEvent, updatedByName: a.updated_by_name, updatedAt: a.updated_at,
  };
}

export async function activitiesFor(db: Db, where: string, params: unknown[]) {
  const now = await currentSlot(db);
  const r = await db.query(`SELECT ${ACT_COLS} FROM activities a LEFT JOIN users uu ON uu.id = a.updated_by LEFT JOIN work_centers wc ON wc.id = a.work_center_id
    LEFT JOIN units un ON un.id = a.unit_id LEFT JOIN systems sy ON sy.id = a.system_id
    JOIN projects p ON p.id = a.project_id WHERE p.status = 'ACTIVE' ${where} ORDER BY a.project_id, a.unit_seq, a.stage = 'POST', a.seq`, params);
  const expl = await delayExplanations(db, r.rows.map((a) => a.last_delay_event_id).filter(Boolean));
  const ids = r.rows.map((a) => a.id);
  const g = await db.query(`SELECT id, activity_id, dimension, title, status, blocks, forecast_slot, awaiting_plan, owner_role, owner_name, conditional_release, source_type, notes, evidence_ref, last_confirmed_at
    FROM readiness_gates WHERE activity_id = ANY($1) ORDER BY id`, [ids]);
  const gates = new Map<number, any[]>();
  for (const x of g.rows) gates.set(x.activity_id, [...(gates.get(x.activity_id) ?? []), {
    id: x.id, dimension: x.dimension, title: x.title, status: x.status, blocks: x.blocks, forecastLabel: finishLabel(x.forecast_slot), awaitingPlan: x.awaiting_plan,
    owner: x.owner_name ?? x.owner_role, conditional: conditionalActive(x.conditional_release, now), conditionalRelease: x.conditional_release, source: x.source_type, notes: x.notes,
    evidence: x.evidence_ref, lastConfirmedAt: x.last_confirmed_at,
  }]);
  return r.rows.map((a) => mapActivity(a, expl, gates));
}

export async function gantt(db: Db) {
  const pf = await portfolio(db);
  const { cal, state } = await calendarSet(db);
  const units = await db.query(`SELECT u.*, pt.code AS product_code, pt.name AS product_name, pt.family FROM units u JOIN product_types pt ON pt.id = u.product_type_id
    JOIN projects p ON p.id = u.project_id WHERE p.status = 'ACTIVE' ORDER BY u.project_id, u.seq`);
  const systems = await db.query(`SELECT * FROM systems WHERE status = 'ACTIVE' ORDER BY project_id, id`);
  const shipments = await db.query(`SELECT s.*, r.name AS route, sp.name service FROM shipments s JOIN routes r ON r.id = s.route_id LEFT JOIN service_profiles sp ON sp.id = s.service_profile_id ORDER BY project_id, seq`);
  const visits = await db.query(`SELECT * FROM commissioning_visits ORDER BY project_id, id`);
  const acts = await activitiesFor(db, `AND a.status <> 'CANCELLED'`, []);
  const deps = await db.query(`SELECT pred_id, succ_id FROM dependencies`);
  const holds = await db.query(`SELECT activity_id, from_activity_id, work_center_id FROM activity_holds`);
  const res = await db.query(`SELECT r.work_center_id, r.slot, SUM(r.load) AS load, array_agg(r.activity_id) AS acts FROM reservations r WHERE r.slot >= $1 GROUP BY 1, 2`, [pf.now]);
  const wcs = await db.query('SELECT * FROM work_centers ORDER BY route_order, id');
  const resv = await db.query(`SELECT * FROM resource_reservations WHERE status IN ('PLANNED','ACTIVE')`);
  const capOf = (wcId: number, slot: number) => {
    const w = wcs.rows.find((x) => x.id === wcId);
    let cap = Number(w?.capacity ?? Infinity);
    for (const ch of state.capacityChanges ?? []) if (ch.resourceId === wcId && ch.fromDay <= dayOf(slot)) cap = ch.capacity;
    const occupied = resv.rows.filter((r) => r.work_center_id === wcId && r.start_slot <= slot && r.finish_slot > slot).reduce((s, r) => s + Number(r.units), 0);
    return cap - occupied;
  };
  const weekend = await db.query(`SELECT w.*, wc.name AS work_center, a.name AS activity FROM weekend_authorizations w
    LEFT JOIN work_centers wc ON wc.id = w.work_center_id LEFT JOIN activities a ON a.id = w.activity_id WHERE w.active`);
  const overloads = res.rows.filter((r) => Number(r.load) > capOf(r.work_center_id, r.slot) + 1e-6)
    .map((r) => ({ workCenterId: r.work_center_id, slot: r.slot, load: Number(r.load), activities: r.acts }));
  const minS = Math.min(pf.now, ...acts.map((a) => a.actualStart ?? a.forecastStart ?? pf.now));
  const maxS = Math.max(pf.now + 60, ...acts.map((a) => a.forecastFinish ?? 0));
  const nonWorking: number[] = [];
  for (let d = dayOf(minS) - 7; d <= dayOf(maxS) + 14; d++) if (!cal.isWorkingDay(state.defaultCalendarId, d)) nonWorking.push(d);
  return {
    now: pf.now, version: pf.version, range: { from: minS, to: maxS }, nonWorkingDays: nonWorking,
    projects: pf.projects,
    units: units.rows.map((u) => ({ id: u.id, internalId: u.internal_id, projectId: u.project_id, name: u.name, serial: u.serial ?? u.name ?? u.internal_id, seq: u.seq, productCode: u.product_code,
      productName: u.product_name, family: u.family, systemId: u.system_id, shipmentId: u.shipment_id, disposition: u.disposition, status: u.status, hwRevision: u.hw_revision })),
    systems: systems.rows.map((s) => ({ id: s.id, projectId: s.project_id, code: s.code, name: s.name, composition: s.composition, visitId: s.visit_id })),
    shipments: shipments.rows.map((s) => ({ id: s.id, projectId: s.project_id, code: s.code, route: s.route, service: s.service, collectionAt: s.collection_at, bookingDeadline: s.booking_deadline, transportBooked: s.transport_booked })),
    visits: visits.rows.map((v) => ({ id: v.id, projectId: v.project_id, code: v.code, site: v.site })),
    activities: acts,
    dependencies: deps.rows.map((d) => ({ pred: d.pred_id, succ: d.succ_id })),
    holds: holds.rows.map((h) => ({ activityId: h.activity_id, fromActivityId: h.from_activity_id, workCenterId: h.work_center_id })),
    overloads,
    workCenters: wcs.rows.map((w) => ({ id: w.id, code: w.code, name: w.name, type: w.resource_type, capacity: Number(w.capacity), provisional: w.provisional })),
    weekendAuthorizations: weekend.rows.map((w) => ({ id: w.id, date: w.date, workCenter: w.work_center, activity: w.activity, reason: w.reason, capacity: w.capacity })),
    reservations: resv.rows.map((r) => ({ id: r.id, workCenterId: r.work_center_id, start: r.start_slot, finish: r.finish_slot, units: Number(r.units), kind: r.kind, reason: r.reason })),
  };
}

/** Configuration reconciliation: approved configuration vs live unit flows, and newer drafts/imports vs applied. */
export async function reconciliation(db: Db, projectId: number) {
  const cfgs = (await db.query(`SELECT c.*, u.name created_by_name, a.name approved_by_name FROM project_configurations c LEFT JOIN users u ON u.id = c.created_by
    LEFT JOIN users a ON a.id = c.approved_by WHERE c.project_id = $1 ORDER BY version`, [projectId])).rows;
  const applied = cfgs.filter((c) => c.status === 'APPLIED').pop() ?? null;
  const pts = new Map((await db.query('SELECT id, code, name FROM product_types')).rows.map((p) => [p.id, p]));
  const systems = (await db.query(`SELECT * FROM systems WHERE project_id = $1 ORDER BY id`, [projectId])).rows;
  const units = (await db.query(`SELECT u.*, pt.code product FROM units u JOIN product_types pt ON pt.id = u.product_type_id WHERE u.project_id = $1`, [projectId])).rows;
  const issues: { kind: string; message: string; system?: string; unitId?: number }[] = [];
  const compare = (cfg: any, label: string) => {
    for (const t of cfg?.systems ?? []) {
      const sys = systems.find((s) => s.code === t.code && s.status === 'ACTIVE');
      if (!sys) { issues.push({ kind: 'MISSING_SYSTEM', message: `${label}: system ${t.code} has no unit flows`, system: t.code }); continue; }
      for (const x of t.composition) {
        const have = units.filter((u) => u.system_id === sys.id && u.status === 'ACTIVE' && u.product_type_id === x.productTypeId).length;
        if (have < x.quantity) issues.push({ kind: 'MISSING_UNITS', message: `${label}: ${t.code} needs ${x.quantity}× ${pts.get(x.productTypeId)?.code}, plan has ${have}`, system: t.code });
        if (have > x.quantity) issues.push({ kind: 'OBSOLETE_UNITS', message: `${label}: ${t.code} plans ${have}× ${pts.get(x.productTypeId)?.code}, configuration needs ${x.quantity}`, system: t.code });
      }
      for (const u of units.filter((uu) => uu.system_id === sys.id && uu.status === 'ACTIVE' && !t.composition.some((x: any) => x.productTypeId === uu.product_type_id))) {
        issues.push({ kind: 'MISMATCHED_UNIT', message: `${label}: ${u.name ?? u.internal_id} (${u.product}) is not part of ${t.code}`, system: t.code, unitId: u.id });
      }
    }
    for (const s of systems.filter((x) => x.status === 'ACTIVE' && !(cfg?.systems ?? []).some((t: any) => t.code === x.code))) {
      issues.push({ kind: 'OBSOLETE_SYSTEM', message: `${label}: system ${s.code} is planned but not in the configuration`, system: s.code });
    }
  };
  if (applied) compare(applied, `v${applied.version}`);
  const pendingNewer = cfgs.filter((c) => (c.status === 'DRAFT' || c.status === 'APPROVED') && (!applied || c.version > applied.version));
  const drafts: any[] = [];
  for (const d of pendingNewer) {
    const before = issues.length;
    compare(d, `v${d.version} (${d.status.toLowerCase()}${d.source !== 'MANUAL' ? `, ${d.source}` : ''})`);
    drafts.push({ id: d.id, version: d.version, status: d.status, differences: issues.splice(before) });
  }
  const spare = units.filter((u) => u.status === 'SPARE').map((u) => ({ id: u.id, internalId: u.internal_id, name: u.name, product: u.product, disposition: u.disposition }));
  const acks = (await db.query(`SELECT * FROM action_items WHERE project_id = $1 AND kind = 'LOGISTICS_ACK' ORDER BY created_at DESC`, [projectId])).rows;
  return {
    configurations: cfgs.map((c) => ({ ...c, systems: (c.systems ?? []).map((s: any) => ({ ...s, label: s.composition.map((x: any) => `${x.quantity}× ${pts.get(x.productTypeId)?.code}`).join(' + ') })) })),
    applied: applied ? { id: applied.id, version: applied.version } : null,
    issues, drafts, spareUnits: spare, logisticsAcks: acks, inSync: issues.length === 0 && drafts.every((d) => !d.differences.length),
  };
}

export async function projectDetails(db: Db, id: number) {
  const p = (await db.query(`SELECT p.*, c.name AS customer, rt.name AS route_name, sp.name AS service_profile, sp.confirmation_status
    FROM projects p JOIN customers c ON c.id = p.customer_id JOIN routes rt ON rt.id = p.route_id LEFT JOIN service_profiles sp ON sp.id = p.service_profile_id WHERE p.id = $1`, [id])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  const pf = await portfolio(db);
  const summary = pf.projects.find((x) => x.id === id);
  const units = (await db.query(`SELECT u.*, pt.code AS product_code, pt.name AS product_name, s.code system_code, sh.code shipment_code,
      (SELECT json_agg(json_build_object('version', r.version, 'component', c.code, 'checks', us.checks_passed_at IS NOT NULL)) FROM unit_software us
        JOIN sw_releases r ON r.id = us.release_id JOIN sw_components c ON c.id = r.component_id WHERE us.unit_id = u.id AND NOT us.superseded) software
    FROM units u JOIN product_types pt ON pt.id = u.product_type_id LEFT JOIN systems s ON s.id = u.system_id LEFT JOIN shipments sh ON sh.id = u.shipment_id
    WHERE u.project_id = $1 ORDER BY u.status = 'ACTIVE' DESC, u.seq`, [id])).rows;
  const unitHistory = (await db.query(`SELECT h.*, u.internal_id, us.name user_name FROM unit_history h JOIN units u ON u.id = h.unit_id LEFT JOIN users us ON us.id = h.user_id
    WHERE u.project_id = $1 OR h.from_value->>'projectId' = $2 ORDER BY h.created_at DESC LIMIT 300`, [id, String(id)])).rows;
  const systems = (await db.query(`SELECT s.*, v.code visit_code FROM systems s LEFT JOIN commissioning_visits v ON v.id = s.visit_id WHERE s.project_id = $1 ORDER BY s.id`, [id])).rows;
  const shipments = (await db.query(`SELECT s.*, sp.name service, sp.mode, sp.confirmation_status, sp.booking_lead_days,
      (SELECT json_agg(d ORDER BY d.id) FROM shipment_documents d WHERE d.shipment_id = s.id) documents,
      (SELECT count(*) FROM units u WHERE u.shipment_id = s.id AND u.status = 'ACTIVE')::int manifest_count
    FROM shipments s LEFT JOIN service_profiles sp ON sp.id = s.service_profile_id WHERE s.project_id = $1 ORDER BY s.seq`, [id])).rows;
  const visits = (await db.query(`SELECT v.*, w.name team FROM commissioning_visits v LEFT JOIN work_centers w ON w.id = v.team_resource_id WHERE v.project_id = $1 ORDER BY v.id`, [id])).rows;
  const acts = await activitiesFor(db, 'AND a.project_id = $1', [id]);
  const comments = (await db.query(`SELECT cm.*, u.name AS user_name, u.role, a.name AS activity FROM comments cm JOIN users u ON u.id = cm.user_id
    LEFT JOIN activities a ON a.id = cm.activity_id WHERE cm.project_id = $1 ORDER BY cm.created_at DESC LIMIT 300`, [id])).rows;
  const delays = (await db.query(`SELECT e.*, a.name AS activity, COALESCE(un.name, un.internal_id) unit_label, u.name AS user_name, ra.name AS origin_activity, COALESCE(ru.name, ru.internal_id) AS origin_unit, rp.code AS origin_project
    FROM delay_events e LEFT JOIN activities a ON a.id = e.activity_id LEFT JOIN units un ON un.id = a.unit_id LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN activities ra ON ra.id = e.origin_activity_id LEFT JOIN units ru ON ru.id = ra.unit_id LEFT JOIN projects rp ON rp.id = ra.project_id
    WHERE e.project_id = $1 AND e.kind IN ('ROOT','SYSTEM','APPROVED_CHANGE','CAPACITY','EXPLANATION_REQUIRED') ORDER BY e.created_at DESC, e.id DESC LIMIT 300`, [id])).rows;
  const commitments = (await db.query(`SELECT mc.*, m.type, m.shipment_id, m.visit_id, u.name AS user_name FROM milestone_commitments mc JOIN milestones m ON m.id = mc.milestone_id
    LEFT JOIN users u ON u.id = mc.user_id WHERE m.project_id = $1 ORDER BY mc.created_at, mc.id`, [id])).rows;
  const history = (await db.query(`SELECT ae.*, u.name AS user_name FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id WHERE ae.project_id = $1 ORDER BY ae.ts DESC LIMIT 300`, [id])).rows;
  const materials = (await db.query(`SELECT q.*, m.part_number, m.description, COALESCE(u.name, u.internal_id) unit_label, a.name needed_at, g.status gate_status, g.notes gate_notes, g.forecast_slot,
      ai.title bom_action, ai.status bom_action_status
    FROM material_requirements q JOIN materials m ON m.id = q.material_id LEFT JOIN units u ON u.id = q.unit_id LEFT JOIN activities a ON a.id = q.needed_at_activity_id
    LEFT JOIN readiness_gates g ON g.source_type = 'MATERIAL' AND g.source_id = q.id LEFT JOIN action_items ai ON ai.id = q.bom_correction_action_id
    WHERE q.project_id = $1 AND q.status = 'OPEN' ORDER BY q.id`, [id])).rows;
  const actions = (await db.query(`SELECT * FROM action_items WHERE project_id = $1 ORDER BY status = 'OPEN' DESC, created_at DESC`, [id])).rows;
  return {
    project: {
      id: p.id, code: p.code, name: p.name, customer: p.customer, siteLocation: p.site_location, country: p.country, route: p.route_name, serviceProfile: p.service_profile,
      serviceConfirmation: p.confirmation_status, requiredDate: p.required_commissioning_date, requiredText: p.required_commissioning_text, requiredExwText: p.required_exw_text,
      priority: p.priority, demandStatus: p.demand_status, planStatus: p.plan_status, planConfidence: p.plan_confidence, earliestCommissioning: finishLabel(p.earliest_commissioning_slot),
      notes: p.notes, createdAt: p.created_at, sapOrderRef: p.sap_order_ref, o2cOwner: p.o2c_owner, spoc: p.spoc, wave: p.wave, series: p.series, rationale: p.rationale,
      customerSituation: p.customer_situation, mitigations: p.mitigations, source: p.source,
    },
    summary,
    units: units.map((u) => ({ id: u.id, internalId: u.internal_id, serial: u.serial, name: u.name, seq: u.seq, productCode: u.product_code, productName: u.product_name, itemCode: u.item_code,
      hwRevision: u.hw_revision, location: u.location, disposition: u.disposition, status: u.status, systemId: u.system_id, systemCode: u.system_code, shipmentId: u.shipment_id,
      shipmentCode: u.shipment_code, software: u.software ?? [], batchId: u.batch_id, evaluation: u.evaluation_unit, source: u.source })),
    unitHistory, systems, shipments, visits, activities: acts, comments,
    delayEvents: delays.map((e) => ({ ...e, prevFinishLabel: finishLabel(e.prev_finish), newFinishLabel: finishLabel(e.new_finish) })),
    commitments: commitments.map((c) => ({ ...c, committedLabel: finishLabel(c.committed_slot), previousLabel: finishLabel(c.previous_slot) })),
    history, materials: materials.map((m) => ({ ...m, forecastLabel: finishLabel(m.forecast_slot) })), actions,
    reconciliation: await reconciliation(db, id),
  };
}

/** Driving chain behind a milestone, from the milestone back to the originating activity or gate, with owners and affected projects. */
export async function milestoneChain(db: Db, projectId: number, type: MilestoneType) {
  const state = await loadPlanState(db);
  const result = forwardSchedule(state);
  const m = result.milestones.find((x) => x.projectId === projectId && x.type === type && x.shipmentId === null && !x.visitId);
  if (!m || m.drivingActivityId === null) throw new HttpError(404, 'Milestone not found');
  const chain = drivingChain(state, result.acts, m.drivingActivityId);
  const ids = chain.map((n) => n.activityId);
  const acts = await activitiesFor(db, 'AND a.id = ANY($1)', [ids]);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const gateIds = chain.map((n) => (n.driver.type === 'gate' ? n.driver.gateId : null)).filter((x): x is number => x !== null);
  const gates = new Map((await db.query('SELECT * FROM readiness_gates WHERE id = ANY($1)', [gateIds])).rows.map((g) => [g.id, g]));
  const projCodes = new Map((await db.query('SELECT id, code FROM projects')).rows.map((p) => [p.id, p.code]));
  const nodes = chain.map((n) => {
    const a = byId.get(n.activityId)!;
    const g = n.driver.type === 'gate' ? gates.get(n.driver.gateId) : null;
    const blockers = n.driver.type === 'capacity' ? [...new Set(n.driver.blockers.map((b) => state.activities.find((x) => x.id === b)?.projectId).filter((x): x is number => !!x && x !== projectId))].map((p) => projCodes.get(p)) : [];
    return {
      activityId: n.activityId, name: a.name, unit: a.unitLabel ?? a.systemCode ?? a.scope, workCenter: a.workCenter, owner: a.function, driver: n.driver,
      startLabel: slotToLabel(n.start), finishLabel: finishLabel(n.finish), status: a.status, delaySlots: a.delaySlots, delayed: a.delayed, lastEvent: a.lastEvent, confidence: a.confidence,
      gate: g ? { id: g.id, title: g.title, dimension: g.dimension, status: g.status, owner: g.owner_name ?? g.owner_role, notes: g.notes, forecastLabel: finishLabel(g.forecast_slot) } : null,
      competingProjects: blockers,
    };
  });
  let origin: number | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].delayed || nodes[i].lastEvent?.kind === 'ROOT' || nodes[i].gate) { origin = nodes[i].activityId; break; }
  const originNode = nodes.find((n) => n.activityId === origin);
  const related = originNode?.lastEvent?.eventId ? (await db.query('SELECT related_projects FROM delay_events WHERE id = $1', [originNode.lastEvent.eventId])).rows[0]?.related_projects ?? [] : [];
  return {
    projectId, type, label: MILESTONE_LABEL[type], forecastLabel: finishLabel(m.forecast), confidence: m.confidence, nodes, originActivityId: origin,
    originIssue: originNode ? (originNode.gate ? `${originNode.gate.title} (${originNode.gate.status.toLowerCase()})` : originNode.lastEvent?.reason ?? null) : null,
    responsibleOwner: originNode ? (originNode.gate?.owner ?? originNode.owner) : null,
    affectedProjects: (related as number[]).map((p) => projCodes.get(p)).filter(Boolean),
  };
}

export async function capacityView(db: Db, days = 42) {
  const state = await loadPlanState(db);
  const result = forwardSchedule(state);
  const from = dayOf(state.now);
  const util = dailyUtilization(state, result, from, from + days);
  const wcs = (await db.query('SELECT * FROM work_centers ORDER BY route_order, id')).rows;
  const bn = bottleneckAnalysis(state, result, wcs.map((w) => w.id), new Map(wcs.map((w) => [w.id, w.sizing_target_id])));
  const conflicts = conflictsByProject(state, result);
  const pcode = new Map((await db.query(`SELECT id, code FROM projects`)).rows.map((p) => [p.id, p.code]));
  const grouped = new Map<string, any>();
  for (const c of conflicts) {
    const k = `${c.projectId}:${c.workCenterId}`;
    const g = grouped.get(k) ?? { projectId: c.projectId, project: pcode.get(c.projectId), workCenterId: c.workCenterId, waitDays: 0, activities: 0, blockingProjects: new Set<number>() };
    g.waitDays += c.waitDays; g.activities++;
    for (const b of c.blockingProjects) g.blockingProjects.add(b);
    grouped.set(k, g);
  }
  const ms = await milestoneViews(db);
  const risk = { GREEN: 0, AMBER: 0, RED: 0, COMPLETE: 0 } as Record<string, number>;
  for (const l of ms.main.values()) for (const m of l) risk[m.risk]++;
  const proposals = bn.filter((b) => b.isProgramBottleneck || b.starvesDownstream || b.capacityWaitDays > 0).sort((a, b) => b.capacityWaitDays - a.capacityWaitDays).slice(0, 5).map((b) => {
    const w = wcs.find((x) => x.id === b.workCenterId);
    const to = b.starvesDownstream && b.requiredCapacityToFeedDownstream ? Math.max(Number(w.capacity) + 1, Math.ceil(b.requiredCapacityToFeedDownstream)) : Number(w.capacity) + 1;
    return { workCenterId: b.workCenterId, workCenter: b.name, from: Number(w.capacity), to,
      rationale: b.starvesDownstream ? `Throughput ${b.throughputPerDay} units/day is below ${b.downstreamCode} (${b.downstreamThroughput}/day): +${b.additionalCapacityNeeded} needed`
        : b.isProgramBottleneck ? `Program bottleneck (lowest nominal throughput ${b.throughputPerDay} units/day)` : `Queueing of ${b.capacityWaitDays} working days in the current plan` };
  });
  const changes = (await db.query(`SELECT c.*, w.name work_center, u.name created_by_name FROM resource_capacity_changes c JOIN work_centers w ON w.id = c.work_center_id
    LEFT JOIN users u ON u.id = c.created_by ORDER BY c.effective_from DESC, c.id DESC`)).rows;
  const reservations = (await db.query(`SELECT r.*, w.name work_center FROM resource_reservations r JOIN work_centers w ON w.id = r.work_center_id WHERE r.status IN ('PLANNED','ACTIVE') AND r.finish_slot > $1 ORDER BY r.start_slot`, [state.now])).rows;
  const eolProfile = await getSetting<any>(db, 'eol_resource_profile', null);
  const assumptions = { eol: eolProfile, validation: await getSetting<any>(db, 'validation_assumptions', null), precommissioning: await getSetting<any>(db, 'precommissioning_allocation', null) };
  return {
    now: state.now,
    workCenters: wcs.map((w) => ({ id: w.id, code: w.code, name: w.name, function: w.function, type: w.resource_type, capacity: Number(w.capacity), region: w.region, provisional: w.provisional, notes: w.notes })),
    utilization: util.map((u) => ({ ...u, date: dayToIso(u.day) })),
    bottlenecks: bn,
    overloads: result.overloads.map((o) => ({ ...o, slotLabel: slotToLabel(o.slot) })),
    conflicts: [...grouped.values()].map((g) => ({ ...g, blockingProjects: [...g.blockingProjects].map((p) => pcode.get(p)) })).sort((a, b) => b.waitDays - a.waitDays),
    riskSummary: risk, proposals,
    capacityChanges: changes.map((c) => ({ ...c, capacity: Number(c.capacity) })),
    reservations: reservations.map((r) => ({ ...r, startLabel: slotToLabel(r.start_slot), finishLabel: finishLabel(r.finish_slot) })),
    assumptions,
  };
}

export async function snapshotData(db: Db) {
  const acts = await db.query('SELECT id, project_id, status, forecast_start, forecast_finish, blocker, confidence FROM activities');
  const ms = await db.query('SELECT project_id, type, forecast_slot, approved_slot, actual_slot, confidence FROM milestones WHERE shipment_id IS NULL AND visit_id IS NULL');
  const pr = await db.query(`SELECT id, code, priority FROM projects WHERE status = 'ACTIVE'`);
  const gates = await db.query(`SELECT id, project_id, status, title FROM readiness_gates`);
  return {
    priorities: pr.rows.map((p) => ({ id: p.id, code: p.code, priority: p.priority })),
    milestones: ms.rows.map((m) => ({ projectId: m.project_id, type: m.type, forecast: m.forecast_slot, approved: m.approved_slot, actual: m.actual_slot, confidence: m.confidence })),
    activities: acts.rows.map((a) => ({ id: a.id, projectId: a.project_id, status: a.status, fs: a.forecast_start, ff: a.forecast_finish, blocker: a.blocker })),
    gates: gates.rows.map((g) => ({ id: g.id, projectId: g.project_id, status: g.status, title: g.title })),
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
  const oldGates = new Map((old.gates ?? []).map((g) => [g.id, g]));
  const names = await db.query(`SELECT a.id, a.name, COALESCE(u.name, u.internal_id) unit FROM activities a LEFT JOIN units u ON u.id = a.unit_id`);
  const nm = new Map(names.rows.map((r) => [r.id, `${r.unit ? r.unit + ' · ' : ''}${r.name}`]));
  const { cal } = await calendarSet(db);
  const events = await db.query(`SELECT ae.id, ae.ts, ae.action, ae.change_class, ae.reason, ae.project_id, p.code AS project, u.name AS user_name, u.role
    FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id LEFT JOIN projects p ON p.id = ae.project_id
    WHERE ae.ts > $1 AND ae.change_class <> 'SYSTEM' ORDER BY ae.ts DESC LIMIT 200`, [snap.created_at]);
  return {
    snapshot: { id: snap.id, label: snap.label, createdAt: snap.created_at },
    priorityChanges: cur.priorities.filter((p) => oldPrio.has(p.id) && oldPrio.get(p.id) !== p.priority).map((p) => ({ projectId: p.id, project: p.code, from: oldPrio.get(p.id), to: p.priority })),
    milestoneChanges: cur.milestones.filter((m) => { const o = oldMs.get(`${m.projectId}:${m.type}`); return o && (o.forecast !== m.forecast || o.actual !== m.actual || o.approved !== m.approved || o.confidence !== m.confidence); })
      .map((m) => {
        const o = oldMs.get(`${m.projectId}:${m.type}`)!;
        return { projectId: m.projectId, project: pcode.get(m.projectId), type: m.type, label: MILESTONE_LABEL[m.type as MilestoneType], fromLabel: finishLabel(o.forecast), toLabel: finishLabel(m.forecast),
          deltaDays: o.forecast !== null && m.forecast !== null ? cal.workingDaysBetween(o.forecast, m.forecast) : 0, approvedChanged: o.approved !== m.approved, completed: o.actual === null && m.actual !== null,
          confidenceFrom: o.confidence ?? 'FIRM', confidenceTo: m.confidence };
      }),
    statusChanges: cur.activities.filter((a) => oldActs.has(a.id) && oldActs.get(a.id)!.status !== a.status).map((a) => ({ activityId: a.id, projectId: a.projectId, project: pcode.get(a.projectId), name: nm.get(a.id), from: oldActs.get(a.id)!.status, to: a.status })),
    newBlockers: cur.activities.filter((a) => a.status === 'BLOCKED' && oldActs.get(a.id)?.status !== 'BLOCKED').map((a) => ({ activityId: a.id, project: pcode.get(a.projectId), name: nm.get(a.id), blocker: a.blocker })),
    gateChanges: cur.gates.filter((g) => oldGates.get(g.id)?.status !== g.status).map((g) => ({ gateId: g.id, project: pcode.get(g.projectId), title: g.title, from: oldGates.get(g.id)?.status ?? 'NEW', to: g.status })).slice(0, 60),
    rescheduledActivities: cur.activities.filter((a) => oldActs.has(a.id) && oldActs.get(a.id)!.ff !== a.ff).length,
    events: events.rows,
  };
}

/** Weekly outbound review: upcoming shipments, booking deadlines, missing documents, unacknowledged configuration changes. */
export async function outboundReview(db: Db, horizonDays = 21) {
  const now = await currentSlot(db);
  const shipments = (await db.query(`SELECT s.*, p.code project, p.name project_name, p.priority, sp.name service, sp.mode, sp.confirmation_status, sp.booking_lead_days,
      m.forecast_slot exw_forecast, m.actual_slot exw_actual, m.confidence exw_confidence,
      (SELECT a.forecast_start FROM activities a WHERE a.shipment_id = s.id AND a.code = 'TRANSIT' AND a.status <> 'CANCELLED' LIMIT 1) dispatch_forecast,
      (SELECT a.status FROM activities a WHERE a.shipment_id = s.id AND a.code = 'TRANSIT' AND a.status <> 'CANCELLED' LIMIT 1) transit_status,
      (SELECT json_agg(d ORDER BY d.id) FROM shipment_documents d WHERE d.shipment_id = s.id) documents,
      (SELECT count(*) FROM units u WHERE u.shipment_id = s.id AND u.status = 'ACTIVE')::int manifest,
      (SELECT count(*) FROM units u WHERE u.shipment_id = s.id AND u.status = 'ACTIVE' AND u.disposition <> 'RELEASABLE')::int held
    FROM shipments s JOIN projects p ON p.id = s.project_id LEFT JOIN service_profiles sp ON sp.id = s.service_profile_id
    LEFT JOIN milestones m ON m.shipment_id = s.id AND m.type = 'EXW'
    WHERE p.status = 'ACTIVE' ORDER BY m.forecast_slot NULLS LAST`)).rows;
  const horizon = now + horizonDays * 2;
  const upcoming = shipments.filter((s) => s.transit_status !== 'COMPLETED' && s.transit_status !== 'IN_PROGRESS' && (s.exw_forecast ?? Infinity) <= horizon);
  const acks = (await db.query(`SELECT a.*, p.code project FROM action_items a LEFT JOIN projects p ON p.id = a.project_id WHERE a.kind = 'LOGISTICS_ACK' AND a.status = 'OPEN' ORDER BY a.created_at`)).rows;
  return {
    now, horizonDays,
    shipments: upcoming.map((s) => {
      const docs = (s.documents ?? []) as any[];
      const missing = docs.filter((d) => d.status !== 'READY' && d.status !== 'NOT_REQUIRED');
      const bookingDue = s.booking_deadline ? s.booking_deadline.toISOString() : null;
      return {
        id: s.id, code: s.code, project: s.project, projectId: s.project_id, priority: s.priority, service: s.service, mode: s.mode, serviceStatus: s.confirmation_status,
        exworksLabel: finishLabel(s.exw_actual ?? s.exw_forecast), exworksReached: s.exw_actual !== null, exwConfidence: s.exw_confidence, dispatchLabel: slotToLabel(s.dispatch_forecast),
        manifest: s.manifest, held: s.held, transportBooked: s.transport_booked, bookingRef: s.booking_ref, bookingDeadline: bookingDue,
        bookingOverdue: !s.transport_booked && bookingDue !== null && new Date(bookingDue).getTime() < Date.now(),
        collectionAt: s.collection_at, receivingWindow: s.receiving_window_start ? `${s.receiving_window_start} → ${s.receiving_window_end ?? ''}` : null,
        coordinator: s.coordinator, documents: docs, missingDocuments: missing.map((d) => d.doc_type),
        dispatchBlocked: (s.exw_actual !== null && missing.length > 0) || s.held > 0,
      };
    }),
    unacknowledgedConfigurationChanges: acks,
  };
}

export async function dailyControl(db: Db) {
  const pf = await portfolio(db);
  const now = pf.now;
  const today = dayOf(now);
  const acts = await activitiesFor(db, `AND a.status NOT IN ('COMPLETED','CANCELLED')`, []);
  const pcode = new Map(pf.projects.map((p) => [p.id, p.code]));
  const label = (a: any) => ({
    id: a.id, projectId: a.projectId, project: pcode.get(a.projectId), unit: a.unitLabel ?? a.systemCode ?? (a.scope === 'SHIPMENT' ? 'Shipment' : a.scope === 'SITE' ? 'Site' : ''), name: a.name,
    function: a.function, workCenter: a.workCenter, status: a.status, forecastStartLabel: slotToLabel(a.forecastStart), forecastFinishLabel: finishLabel(a.forecastFinish),
    approvedFinishLabel: finishLabel(a.approvedFinish), delaySlots: a.delaySlots, blocker: a.blocker, driver: a.driver, isCritical: a.isCritical, confidence: a.confidence,
    forecastStart: a.forecastStart, forecastFinish: a.forecastFinish, approvedStart: a.approvedStart, approvedFinish: a.approvedFinish, deadlineAt: a.deadlineAt,
    expectedFinish: a.expectedFinish, actualStart: a.actualStart, pctComplete: a.pctComplete, locked: a.locked, lastEvent: a.lastEvent,
    openGates: a.gates.filter((g: any) => g.status !== 'READY' && !g.awaitingPlan && !g.conditional).map((g: any) => ({ id: g.id, title: g.title, status: g.status, blocks: g.blocks, owner: g.owner })),
  });
  const todays = acts.filter((a) => a.forecastStart !== null && dayOf(a.forecastStart) <= today && dayOf((a.forecastFinish ?? 1) - 1) >= today);
  const overdue = acts.filter((a) => a.approvedFinish !== null && a.approvedFinish <= now);
  const blockers = acts.filter((a) => a.status === 'BLOCKED');
  const explanationRequired = acts.filter((a) => ['now', 'overdue'].includes(a.driver?.type) || (a.status !== 'IN_PROGRESS' && a.status !== 'BLOCKED' && a.approvedStart !== null && a.approvedStart < now && !a.gates.some((g: any) => g.status !== 'READY' && !g.awaitingPlan)));
  const handoverCodes = new Set(['VAL_REMOVE', 'RVAL_REMOVE', 'PACK', 'OUT_PREP', 'TRANSIT', 'INSTALL']);
  const handovers = acts.filter((a) => handoverCodes.has(a.code) && a.forecastStart !== null && a.forecastStart <= now + 6);
  const readinessGaps = acts.flatMap((a) => a.gates.filter((g: any) => g.status !== 'READY' && !g.awaitingPlan && !g.conditional).map((g: any) => ({ gate: g, activity: label(a), needed: a.forecastStart })))
    .filter((x) => (x.needed ?? Infinity) <= now + 20).sort((x, y) => (x.needed ?? 0) - (y.needed ?? 0)).slice(0, 40);
  const cap = await capacityView(db, 14);
  const shared = cap.overloads.filter((o) => ['SHARED', 'SKID', 'PERSONNEL'].includes(cap.workCenters.find((w) => w.id === o.workCenterId)?.type ?? '')).slice(0, 20);
  const pending = await db.query(`SELECT s.id, s.name, s.status, s.result->>'summary' AS summary, s.frozen_projects, u.name AS created_by_name, s.created_at
    FROM scenarios s JOIN users u ON u.id = s.created_by WHERE s.status = 'PENDING_APPROVAL' ORDER BY s.created_at`);
  const decisions = await db.query(`SELECT d.*, p.code AS project, u.name AS user_name FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
    JOIN users u ON u.id = d.user_id ORDER BY d.status, d.created_at DESC LIMIT 50`);
  const openActions = (await db.query(`SELECT a.*, p.code project FROM action_items a LEFT JOIN projects p ON p.id = a.project_id WHERE a.status = 'OPEN' ORDER BY a.created_at DESC LIMIT 40`)).rows;
  const mgmt: any[] = [];
  for (const s of pending.rows) mgmt.push({ kind: 'APPROVAL', title: `Approve scenario "${s.name}"`, detail: s.summary, scenarioId: s.id });
  for (const p of pf.projects) {
    if (p.planStatus === 'INFEASIBLE') mgmt.push({ kind: 'INFEASIBLE', title: `${p.code}: required commissioning date not achievable`, detail: `Earliest: ${p.earliestCommissioning}`, projectId: p.id });
    for (const m of p.milestones) if (m.risk === 'RED') mgmt.push({ kind: 'RISK', title: `${p.code}: ${m.label} at risk`, detail: `Forecast ${m.forecastLabel} vs committed ${m.latestApprovedLabel} (${m.varianceDays > 0 ? '+' : ''}${m.varianceDays} wd)`, projectId: p.id });
    if (p.readiness.BLOCKED > 0) mgmt.push({ kind: 'READINESS', title: `${p.code}: ${p.readiness.BLOCKED} blocked readiness gate(s)`, detail: p.readiness.nextBlocker ? `${p.readiness.nextBlocker.title} — ${p.readiness.nextBlocker.owner ?? ''}` : '', projectId: p.id });
  }
  for (const o of cap.overloads.slice(0, 5)) mgmt.push({ kind: 'OVERLOAD', title: `Capacity overload at ${cap.workCenters.find((w) => w.id === o.workCenterId)?.name}`, detail: `${o.slotLabel}: ${o.load} / ${o.capacity}` });
  return {
    now, nowLabel: pf.nowLabel, version: pf.version, projects: pf.projects,
    todays: todays.map(label), overdue: overdue.map(label), blockers: blockers.map(label), awaitingUpdates: explanationRequired.map(label), explanationRequired: explanationRequired.map(label),
    handovers: handovers.map(label), readinessGaps,
    capacityConflicts: { overloads: cap.overloads.slice(0, 30), queueing: cap.conflicts.slice(0, 15), sharedResource: shared },
    managementDecisions: mgmt, decisions: decisions.rows, openActions,
    changesSincePreviousCall: await diffSinceSnapshot(db),
    outbound: await outboundReview(db, 10),
    connectedUsers: presence(),
  };
}
