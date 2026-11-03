/**
 * Readiness gates. Manual gates are maintained by their owners; derived gates are recomputed from
 * the records they depend on (material allocations, software releases, test results, quality holds,
 * shipment documents/bookings, site responsibilities). Unknown readiness is never shown as ready.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { dayNumber } from '../engine/calendar.js';
import { audit, bumpInputs, currentSlot, HttpError, type AuthUser, can } from './common.js';

type Status = 'UNKNOWN' | 'PENDING' | 'READY' | 'BLOCKED';
interface Derived { status: Status; forecast: number | null; awaitingPlan: boolean; evidence?: string | null; notes?: string | null }

const dateToFinishSlot = (d: string | Date | null) => (d ? (dayNumber(typeof d === 'string' ? d : d.toISOString()) + 1) * 2 : null);

export async function materialStatus(db: Db, requirementId: number): Promise<Derived> {
  const req = (await db.query('SELECT * FROM material_requirements WHERE id = $1', [requirementId])).rows[0];
  if (!req || req.status === 'CANCELLED') return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Requirement cancelled' };
  if (req.status === 'CONSUMED') return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Consumed' };
  const allocs = (await db.query(`SELECT a.*, r.expected_date, r.date_confirmed, r.received_at, r.accepted FROM material_allocations a
    LEFT JOIN material_receipts r ON r.id = a.receipt_id WHERE a.requirement_id = $1`, [requirementId])).rows;
  const fromStock = allocs.filter((a) => a.stock_id).reduce((s, a) => s + Number(a.qty), 0);
  const fromReceipts = allocs.filter((a) => a.receipt_id);
  const total = fromStock + fromReceipts.reduce((s, a) => s + Number(a.qty), 0);
  const qty = Number(req.qty);
  if (fromStock >= qty - 1e-9) return { status: 'READY', forecast: null, awaitingPlan: false, notes: `${fromStock} allocated from accepted stock` };
  if (total < qty - 1e-9) return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `Shortage: ${qty - total} not covered by stock or expected receipts` };
  const unconfirmed = fromReceipts.some((a) => !a.expected_date || !a.date_confirmed);
  const latest = fromReceipts.reduce<string | null>((m, a) => (a.expected_date && (!m || a.expected_date > m) ? a.expected_date : m), null);
  // +1 day for receipt inspection / acceptance
  const forecast = latest ? (dayNumber(latest) + 2) * 2 : null;
  return { status: unconfirmed ? 'UNKNOWN' : 'PENDING', forecast, awaitingPlan: false, notes: unconfirmed ? 'Covered by an expected receipt with an unconfirmed date' : `Covered by confirmed receipt due ${latest}` };
}

/** Is a software release approved for this unit's use and its artifact available? */
export async function softwareStatus(db: Db, gate: any): Promise<Derived> {
  const spec = gate.spec ?? {};
  const comp = (await db.query('SELECT * FROM sw_components WHERE code = $1', [spec.component])).rows[0];
  if (!comp) return { status: 'UNKNOWN', forecast: null, awaitingPlan: false, notes: `Component ${spec.component} not defined` };
  const releaseId = spec.releaseId ?? comp.production_release_id;
  if (!releaseId) return { status: 'UNKNOWN', forecast: null, awaitingPlan: false, notes: 'No release designated for production use' };
  const rel = (await db.query('SELECT * FROM sw_releases WHERE id = $1', [releaseId])).rows[0];
  const unit = gate.unit_id ? (await db.query('SELECT id, evaluation_unit FROM units WHERE id = $1', [gate.unit_id])).rows[0] : null;
  const approvals = (await db.query('SELECT * FROM sw_release_approvals WHERE release_id = $1 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)', [releaseId])).rows;
  const covers = approvals.some((a) => a.scope === 'PRODUCTION' || (a.scope === 'SPECIFIC_UNITS' && unit && a.unit_ids.includes(unit.id)) || (a.scope === 'EVALUATION_UNITS' && unit?.evaluation_unit));
  const label = `${comp.name} ${rel.version}`;
  if (rel.stage === 'REJECTED') return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `${label} rejected` };
  if (rel.stage === 'APPROVED' && covers && rel.artifact_available_at) {
    if (spec.requirement === 'INSTALLED_VERIFIED' && unit) {
      const inst = (await db.query('SELECT * FROM unit_software WHERE unit_id = $1 AND release_id = $2 AND NOT superseded ORDER BY installed_at DESC LIMIT 1', [unit.id, releaseId])).rows[0];
      if (inst?.checks_passed_at) return { status: 'READY', forecast: null, awaitingPlan: false, notes: `${label} installed and checked`, evidence: `unit_software#${inst.id}` };
      return { status: 'READY', forecast: null, awaitingPlan: false, notes: `${label} available — install and checks are recorded at completion` };
    }
    return { status: 'READY', forecast: null, awaitingPlan: false, notes: `${label} approved for this use and available` };
  }
  const why = rel.stage !== 'APPROVED' ? `${label} is ${rel.stage.toLowerCase().replace('_', ' ')}` : !covers ? `${label} not approved for this unit's use` : `${label} approved but artifact not yet available`;
  // An announced or expected date never satisfies the gate; it only gives a conditional forecast.
  const fc = rel.expected_available_date ? dateToFinishSlot(rel.expected_available_date) : null;
  return { status: fc ? 'PENDING' : 'UNKNOWN', forecast: fc, awaitingPlan: false, notes: why + (fc ? ` (expected ${rel.expected_available_date}, not confirmed)` : '') };
}

async function testReleaseStatus(db: Db, gate: any, mode: 'SYSTEM_VAL' | 'UNITS_EOL'): Promise<Derived> {
  if (mode === 'SYSTEM_VAL') {
    const systemId = gate.system_id ?? (gate.unit_id ? (await db.query('SELECT system_id FROM units WHERE id = $1', [gate.unit_id])).rows[0]?.system_id : null);
    if (!systemId) return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'No system validation required' };
    const recs = (await db.query(`SELECT * FROM test_records WHERE system_id = $1 AND unit_id IS NULL ORDER BY executed_at DESC`, [systemId])).rows;
    const latest = recs.find((r) => r.status !== 'SUPERSEDED');
    if (!latest) return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: 'Awaiting the planned system validation' };
    if (latest.status === 'REVIEW_REQUIRED') {
      const replan = (await db.query(`SELECT 1 FROM activities WHERE system_id = $1 AND scope = 'SYSTEM' AND code IN ('VAL','RVAL') AND status NOT IN ('COMPLETED','CANCELLED')`, [systemId])).rows.length;
      if (replan) return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: `Re-validation planned: ${latest.review_reason}` };
      return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `Validation result needs review: ${latest.review_reason}` };
    }
    if (latest.outcome !== 'PASS') return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `Validation ${latest.outcome}` };
    if (!latest.released_at) return { status: 'PENDING', forecast: null, awaitingPlan: false, notes: 'Validation passed — awaiting release decision' };
    return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Validation passed and released', evidence: `test_record#${latest.id}` };
  }
  const units = (await db.query(`SELECT id FROM units WHERE system_id = $1 AND status = 'ACTIVE'`, [gate.system_id])).rows;
  let pending = 0; let awaiting = 0;
  for (const u of units) {
    const latest = (await db.query(`SELECT * FROM test_records WHERE unit_id = $1 AND status <> 'SUPERSEDED' ORDER BY executed_at DESC LIMIT 1`, [u.id])).rows[0];
    if (!latest) { awaiting++; continue; }
    if (latest.status === 'REVIEW_REQUIRED') return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `EOL result of unit ${u.id} needs review: ${latest.review_reason}` };
    if (latest.outcome !== 'PASS') return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `EOL ${latest.outcome} on a unit of this system` };
    if (!latest.released_at) pending++;
  }
  if (awaiting) return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: `${awaiting} unit EOL result(s) awaited from the plan` };
  if (pending) return { status: 'PENDING', forecast: null, awaitingPlan: false, notes: `${pending} EOL result(s) passed — awaiting release` };
  return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'All unit EOL results passed and released' };
}

async function techReleaseStatus(db: Db, gate: any): Promise<Derived> {
  const holds = (await db.query(`SELECT h.* FROM quality_holds h JOIN units u ON u.id = h.unit_id WHERE u.shipment_id = $1 AND h.status = 'OPEN'`, [gate.shipment_id])).rows;
  if (holds.length) return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `${holds.length} open quality hold(s) on manifest units` };
  const bad = (await db.query(`SELECT count(*)::int n FROM units WHERE shipment_id = $1 AND status = 'ACTIVE' AND disposition <> 'RELEASABLE'`, [gate.shipment_id])).rows[0].n;
  if (bad) return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `${bad} manifest unit(s) not releasable` };
  return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: 'Released when packaging of all manifest units is complete' };
}

async function docsStatus(db: Db, gate: any): Promise<Derived> {
  const docs = (await db.query('SELECT * FROM shipment_documents WHERE shipment_id = $1', [gate.shipment_id])).rows;
  if (!docs.length) return { status: 'UNKNOWN', forecast: null, awaitingPlan: false, notes: 'Document checklist not defined' };
  const open = docs.filter((d) => d.status !== 'READY' && d.status !== 'NOT_REQUIRED');
  if (!open.length) return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'All shipping documents ready' };
  const packed = (await db.query(`SELECT bool_and(a.status = 'COMPLETED') done FROM activities a JOIN units u ON u.id = a.unit_id
    WHERE u.shipment_id = $1 AND a.milestone_tag = 'PACK' AND a.status <> 'CANCELLED'`, [gate.shipment_id])).rows[0]?.done;
  const dated = open.every((d) => d.expected_date);
  const latest = open.reduce<string | null>((m, d) => (d.expected_date && (!m || d.expected_date > m) ? d.expected_date : m), null);
  const names = open.map((d) => d.doc_type).join(', ');
  if (dated && latest) return { status: 'PENDING', forecast: dateToFinishSlot(latest), awaitingPlan: false, notes: `Open: ${names} (expected ${latest})` };
  return { status: packed ? 'BLOCKED' : 'UNKNOWN', forecast: null, awaitingPlan: false, notes: `Open without date: ${names}${packed ? ' — dispatch blocked' : ''}` };
}

async function bookingStatus(db: Db, gate: any, now: number): Promise<Derived> {
  const sh = (await db.query('SELECT * FROM shipments WHERE id = $1', [gate.shipment_id])).rows[0];
  if (sh.transport_booked) return { status: 'READY', forecast: null, awaitingPlan: false, notes: `Booked${sh.booking_ref ? ` (${sh.booking_ref})` : ''}`, evidence: sh.booking_ref };
  if (sh.booking_deadline && dayNumber(sh.booking_deadline.toISOString()) * 2 < now) return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: 'Booking deadline passed without a booking' };
  return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: sh.booking_deadline ? `Book before ${sh.booking_deadline.toISOString().slice(0, 16).replace('T', ' ')}` : 'Booking deadline not set' };
}

async function visitStatus(db: Db, gate: any, kind: 'SITE_RESPONSIBLE' | 'COMM_PERSONNEL' | 'SITE'): Promise<Derived | null> {
  const v = (await db.query('SELECT * FROM commissioning_visits WHERE id = $1', [gate.visit_id])).rows[0];
  if (!v) return null;
  if (kind === 'SITE_RESPONSIBLE') {
    if (v.site_work_responsible && v.site_work_responsible_confirmed) return { status: 'READY', forecast: null, awaitingPlan: false, notes: `${v.site_work_responsible} (confirmed)` };
    if (v.site_work_responsible) return { status: 'PENDING', forecast: null, awaitingPlan: false, notes: `${v.site_work_responsible} named — confirmation of authorization pending` };
    return { status: 'UNKNOWN', forecast: null, awaitingPlan: false, notes: 'No site work-responsible person designated' };
  }
  if (kind === 'COMM_PERSONNEL') {
    const lead = v.execution_lead_name ?? null;
    if (lead && v.personnel_confirmed) return { status: 'READY', forecast: null, awaitingPlan: false, notes: `Lead ${lead}${v.rd_led ? ' (R&D-led, delegation recorded)' : ''}` };
    if (lead) return { status: 'PENDING', forecast: null, awaitingPlan: false, notes: `Lead ${lead} — qualification/authorization evidence not yet confirmed` };
    return { status: 'UNKNOWN', forecast: null, awaitingPlan: false, notes: 'Commissioning personnel not assigned' };
  }
  return null; // SITE readiness stays a manual gate unless site access is confirmed
}

export async function deriveGate(db: Db, g: any, now: number): Promise<Derived | null> {
  switch (g.source_type) {
    case 'MATERIAL': return materialStatus(db, g.source_id);
    case 'SOFTWARE': return softwareStatus(db, g);
    case 'TEST_RELEASE': return testReleaseStatus(db, g, 'SYSTEM_VAL');
    case 'TEST_RELEASE_EOL': return testReleaseStatus(db, g, 'UNITS_EOL');
    case 'TECH_RELEASE': return techReleaseStatus(db, g);
    case 'SHIPMENT_DOCS': return docsStatus(db, g);
    case 'SHIPMENT_BOOKING': return bookingStatus(db, g, now);
    case 'SITE_RESPONSIBLE': return visitStatus(db, g, 'SITE_RESPONSIBLE');
    case 'COMM_PERSONNEL': return visitStatus(db, g, 'COMM_PERSONNEL');
    case 'SITE': {
      const v = (await db.query('SELECT site_access_confirmed FROM commissioning_visits WHERE id = $1', [g.visit_id])).rows[0];
      return v?.site_access_confirmed ? { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Site access & installation readiness confirmed' } : null;
    }
    case 'LOGISTICS_ACK': {
      const a = (await db.query('SELECT * FROM action_items WHERE id = $1', [g.source_id])).rows[0];
      if (!a || a.status === 'ACKNOWLEDGED' || a.status === 'DONE') return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Configuration change acknowledged by Logistics / O2C' };
      return { status: 'PENDING', forecast: null, awaitingPlan: false, notes: 'Configuration change awaiting Logistics / O2C acknowledgment' };
    }
    case 'QUALITY_HOLD': {
      const h = (await db.query('SELECT * FROM quality_holds WHERE id = $1', [g.source_id])).rows[0];
      if (!h || h.status === 'RELEASED') return { status: 'READY', forecast: null, awaitingPlan: false, notes: 'Hold released' };
      const planned = (await db.query(`SELECT r.id FROM rework_packages r WHERE r.unit_id = $1 AND r.status IN ('PLANNED','IN_PROGRESS')`, [h.unit_id])).rows[0];
      if (planned) return { status: 'PENDING', forecast: null, awaitingPlan: true, notes: `${h.disposition}: ${h.reason} — resolution planned through rework #${planned.id} and retest; release by Quality required` };
      return { status: 'BLOCKED', forecast: null, awaitingPlan: false, notes: `${h.disposition}: ${h.reason}` };
    }
    default: return null;
  }
}

/** Recompute derived gates (optionally for some projects). Returns projects whose gates changed. */
export async function syncDerivedGates(c: pg.PoolClient, projectIds?: number[]) {
  const now = await currentSlot(c);
  const gates = (await c.query(`SELECT * FROM readiness_gates WHERE source_type <> 'MANUAL' ${projectIds ? 'AND project_id = ANY($1)' : ''}`, projectIds ? [projectIds] : [])).rows;
  const changed = new Set<number>();
  for (const g of gates) {
    const d = await deriveGate(c, g, now);
    if (!d) continue;
    if (d.status !== g.status || d.forecast !== g.forecast_slot || d.awaitingPlan !== g.awaiting_plan || (d.notes ?? null) !== (g.notes ?? null)) {
      await c.query(`UPDATE readiness_gates SET status=$2, forecast_slot=$3, awaiting_plan=$4, notes=$5, evidence_ref=COALESCE($6, evidence_ref), updated_at=now() WHERE id=$1`,
        [g.id, d.status, d.forecast, d.awaitingPlan, d.notes ?? null, d.evidence ?? null]);
      if (g.project_id && (d.status !== g.status || d.forecast !== g.forecast_slot || d.awaitingPlan !== g.awaiting_plan)) changed.add(g.project_id);
    }
  }
  if (changed.size) await bumpInputs(c, [...changed]);
  return [...changed];
}

/** Manual gate update by its owner (or gate.manage). */
export async function updateGate(c: pg.PoolClient, user: AuthUser, id: number, body: { status?: Status; forecastSlot?: number | null; evidenceRef?: string | null; ownerName?: string | null; notes?: string | null; confirm?: boolean }) {
  const g = (await c.query('SELECT * FROM readiness_gates WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!g) throw new HttpError(404, 'Gate not found');
  if (!['MANUAL', 'IMPORT'].includes(g.source_type) && body.status) throw new HttpError(409, 'This gate is derived from its source records; update the source (materials, release, test result, documents…) instead', 'DERIVED_GATE');
  const owner = g.owner_role === user.role || g.owner_user_id === user.id;
  if (!owner && !(await can(c, user, 'gate.manage'))) throw new HttpError(403, `Gate owned by ${g.owner_role ?? 'its owner'}`);
  if (body.status === 'READY' && !body.evidenceRef && !g.evidence_ref) throw new HttpError(422, 'Evidence / reference is required to mark a gate Ready', 'EVIDENCE_REQUIRED');
  await c.query(`UPDATE readiness_gates SET status = COALESCE($2, status), forecast_slot = CASE WHEN $3 THEN $4 ELSE forecast_slot END,
    evidence_ref = COALESCE($5, evidence_ref), owner_name = COALESCE($6, owner_name), notes = COALESCE($7, notes),
    last_confirmed_at = CASE WHEN $8 OR $2 IS NOT NULL THEN now() ELSE last_confirmed_at END,
    last_confirmed_by = CASE WHEN $8 OR $2 IS NOT NULL THEN $9 ELSE last_confirmed_by END, updated_at = now() WHERE id = $1`,
  [id, body.status ?? null, body.forecastSlot !== undefined, body.forecastSlot ?? null, body.evidenceRef ?? null, body.ownerName ?? null, body.notes ?? null, !!body.confirm, user.id]);
  await bumpInputs(c, [g.project_id]);
  await audit(c, { userId: user.id, action: 'gate.update', changeClass: 'READINESS', entityType: 'gate', entityId: id, projectId: g.project_id,
    before: { status: g.status, forecast: g.forecast_slot }, after: body, reason: body.notes ?? body.evidenceRef ?? null });
}

export async function createManualGate(c: pg.PoolClient, user: AuthUser, body: { activityId: number; dimension: string; title: string; blocks?: 'START' | 'COMPLETE'; status?: Status; forecastSlot?: number | null; ownerRole?: string; ownerName?: string; notes?: string }) {
  if (!(await can(c, user, 'gate.manage')) && !(await can(c, user, 'material.confirm'))) throw new HttpError(403, 'Not allowed to create gates');
  const a = (await c.query('SELECT * FROM activities WHERE id = $1', [body.activityId])).rows[0];
  if (!a) throw new HttpError(404, 'Activity not found');
  const r = await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, system_id, shipment_id, visit_id, dimension, title, status, blocks, forecast_slot, owner_role, owner_name, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
  [a.project_id, a.id, a.unit_id, a.system_id, a.shipment_id, a.visit_id, body.dimension, body.title, body.status ?? 'UNKNOWN', body.blocks ?? 'START', body.forecastSlot ?? null,
    body.ownerRole ?? null, body.ownerName ?? null, body.notes ?? null, user.id]);
  await bumpInputs(c, [a.project_id]);
  await audit(c, { userId: user.id, action: 'gate.create', changeClass: 'READINESS', entityType: 'gate', entityId: r.rows[0].id, projectId: a.project_id, after: body });
  return r.rows[0].id;
}

/** Conditional release: work may proceed despite the gate, within a recorded scope, conditions and expiry. */
export async function conditionalRelease(c: pg.PoolClient, user: AuthUser, id: number, body: { scope: string; conditions: string; expirySlot?: number | null; revoke?: boolean }) {
  if (!(await can(c, user, 'gate.conditional_release'))) throw new HttpError(403, 'Conditional release requires the gate.conditional_release authority');
  const g = (await c.query('SELECT * FROM readiness_gates WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!g) throw new HttpError(404, 'Gate not found');
  const cr = body.revoke ? { ...(g.conditional_release ?? {}), revokedAt: new Date().toISOString(), revokedBy: user.id }
    : { scope: body.scope, conditions: body.conditions, expirySlot: body.expirySlot ?? null, approvedBy: user.id, approverName: user.name, approvedAt: new Date().toISOString() };
  await c.query('UPDATE readiness_gates SET conditional_release = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(cr)]);
  await bumpInputs(c, [g.project_id]);
  await audit(c, { userId: user.id, action: body.revoke ? 'gate.conditional_release.revoke' : 'gate.conditional_release', changeClass: 'READINESS', entityType: 'gate', entityId: id, projectId: g.project_id, after: cr, reason: body.conditions ?? null });
}

/** Gates that are not (yet) satisfied for an activity, for execution checks. */
export async function openGates(db: Db, activityId: number, blocks: 'START' | 'COMPLETE', now: number) {
  const r = await db.query(`SELECT * FROM readiness_gates WHERE activity_id = $1 AND blocks = $2 AND status <> 'READY'`, [activityId, blocks]);
  return r.rows.filter((g) => !(g.conditional_release?.approvedBy && !g.conditional_release.revokedAt && (g.conditional_release.expirySlot == null || g.conditional_release.expirySlot > now)));
}
