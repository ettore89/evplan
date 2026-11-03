/**
 * Test evidence, release decisions, quality holds, issues and rework packages.
 * "Testing performed" (activity completed) is distinct from "passed and released" (test record).
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { audit, bumpInputs, can, HttpError, requirePermission, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';

export async function recordTestResult(c: pg.PoolClient, user: AuthUser, body: {
  activityId: number; outcome: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; evidenceRef?: string | null; release?: boolean; swReleaseId?: number | null;
}) {
  const a = (await c.query('SELECT a.*, rs.test_plan_code FROM activities a LEFT JOIN routing_steps rs ON rs.id = a.routing_step_id WHERE a.id = $1', [body.activityId])).rows[0];
  if (!a) throw new HttpError(404, 'Activity not found');
  const plan = a.test_plan_code ? (await c.query(`SELECT * FROM test_plans WHERE code = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1`, [a.test_plan_code])).rows[0] : null;
  const releaseNow = body.outcome === 'PASS' && body.release !== false && (await can(c, user, 'quality.release'));
  const sys = a.scope === 'SYSTEM' ? a.system_id : null;
  if (a.unit_id) await c.query(`UPDATE test_records SET status = 'SUPERSEDED' WHERE unit_id = $1 AND status <> 'SUPERSEDED' AND test_plan_id IS NOT DISTINCT FROM $2`, [a.unit_id, plan?.id ?? null]);
  if (sys) await c.query(`UPDATE test_records SET status = 'SUPERSEDED' WHERE system_id = $1 AND unit_id IS NULL AND status <> 'SUPERSEDED'`, [sys]);
  const r = await c.query(`INSERT INTO test_records (unit_id, system_id, activity_id, test_plan_id, outcome, evidence_ref, recorded_by, released_by, released_at, sw_release_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [a.unit_id, sys ?? (a.unit_id ? null : a.system_id), a.id, plan?.id ?? null, body.outcome, body.evidenceRef ?? null, user.id,
    releaseNow ? user.id : null, releaseNow ? new Date() : null, body.swReleaseId ?? null]);
  if (body.outcome === 'FAIL') {
    const unitIds = a.unit_id ? [a.unit_id] : (await c.query(`SELECT id FROM units WHERE system_id = $1 AND status = 'ACTIVE'`, [a.system_id])).rows.map((x) => x.id);
    for (const uid of unitIds) await openHold(c, user, { unitId: uid, disposition: 'REWORK_REQUIRED', reason: `${a.name} failed${body.evidenceRef ? ` (${body.evidenceRef})` : ''}` }, true);
  }
  await syncDerivedGates(c, [a.project_id]);
  await audit(c, { userId: user.id, action: 'test.result', changeClass: 'QUALITY', entityType: 'test_record', entityId: r.rows[0].id, projectId: a.project_id,
    after: { ...body, released: releaseNow }, reason: body.evidenceRef ?? null });
  return { testRecordId: r.rows[0].id, released: releaseNow };
}

export async function releaseTestRecord(c: pg.PoolClient, user: AuthUser, id: number, note?: string) {
  await requirePermission(c, user, 'quality.release', 'Releasing test results requires the quality.release authority');
  const t = (await c.query('SELECT t.*, a.project_id FROM test_records t LEFT JOIN activities a ON a.id = t.activity_id WHERE t.id = $1', [id])).rows[0];
  if (!t) throw new HttpError(404, 'Test record not found');
  if (t.outcome !== 'PASS') throw new HttpError(422, 'Only passed results can be released');
  if (t.status !== 'VALID') throw new HttpError(422, `This result is ${t.status.toLowerCase().replace('_', ' ')}; repeat or review the test first`);
  await c.query('UPDATE test_records SET released_by = $2, released_at = now() WHERE id = $1', [id, user.id]);
  await syncDerivedGates(c, t.project_id ? [t.project_id] : undefined);
  await audit(c, { userId: user.id, action: 'test.release', changeClass: 'QUALITY', entityType: 'test_record', entityId: id, projectId: t.project_id, reason: note ?? null });
}

/** Re-confirm a result flagged for review (e.g. after a configuration change that did not affect it). */
export async function reviewTestRecord(c: pg.PoolClient, user: AuthUser, id: number, body: { decision: 'STILL_VALID' | 'REPEAT'; note: string }) {
  await requirePermission(c, user, 'quality.release');
  if (!body.note?.trim()) throw new HttpError(422, 'Explain the review decision');
  const t = (await c.query('SELECT * FROM test_records WHERE id = $1', [id])).rows[0];
  if (!t || t.status !== 'REVIEW_REQUIRED') throw new HttpError(409, 'No review pending for this result');
  if (body.decision === 'STILL_VALID') await c.query(`UPDATE test_records SET status = 'VALID', review_reason = review_reason || ' — reviewed: ' || $2 WHERE id = $1`, [id, body.note]);
  else await c.query(`UPDATE test_records SET status = 'SUPERSEDED', review_reason = review_reason || ' — repeat required: ' || $2 WHERE id = $1`, [id, body.note]);
  await syncDerivedGates(c);
  await audit(c, { userId: user.id, action: 'test.review', changeClass: 'QUALITY', entityType: 'test_record', entityId: id, after: body, reason: body.note });
}

/** Open a quality hold: the unit cannot silently become eligible by moving a Gantt bar. */
export async function openHold(c: pg.PoolClient, user: AuthUser, body: { unitId: number; disposition: 'BLOCKED' | 'REWORK_REQUIRED' | 'DEV_ONLY'; reason: string; issueId?: number | null }, system = false) {
  if (!system) await requirePermission(c, user, 'quality.disposition', 'Setting a quality disposition requires the quality.disposition authority');
  const u = (await c.query('SELECT * FROM units WHERE id = $1', [body.unitId])).rows[0];
  if (!u) throw new HttpError(404, 'Unit not found');
  const h = (await c.query(`INSERT INTO quality_holds (unit_id, disposition, reason, issue_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [u.id, body.disposition, body.reason, body.issueId ?? null, user.id])).rows[0];
  await c.query('UPDATE units SET disposition = $2 WHERE id = $1', [u.id, body.disposition]);
  await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'DISPOSITION',$2,$3,$4,$5)`,
    [u.id, JSON.stringify(u.disposition), JSON.stringify(body.disposition), body.reason, user.id]);
  const next = (await c.query(`SELECT * FROM activities WHERE unit_id = $1 AND status NOT IN ('COMPLETED','CANCELLED') ORDER BY stage = 'POST', seq LIMIT 1`, [u.id])).rows[0];
  if (next) {
    const g = (await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, dimension, title, status, blocks, owner_role, source_type, source_id)
      VALUES ($1,$2,$3,'QUALITY',$4,'BLOCKED',$5,'TESTING','QUALITY_HOLD',$6) RETURNING id`,
    [u.project_id, next.id, u.id, `Quality hold — ${body.disposition.replace('_', ' ').toLowerCase()}: ${body.reason}`, next.status === 'IN_PROGRESS' ? 'COMPLETE' : 'START', h.id])).rows[0];
    await c.query('UPDATE quality_holds SET gate_id = $2 WHERE id = $1', [h.id, g.id]);
  }
  if (body.issueId) await c.query('INSERT INTO issue_units (issue_id, unit_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [body.issueId, u.id]);
  await bumpInputs(c, [u.project_id]);
  await audit(c, { userId: user.id, action: 'quality.hold', changeClass: 'QUALITY', entityType: 'unit', entityId: u.id, projectId: u.project_id, after: body, reason: body.reason });
  return h.id;
}

export async function releaseHold(c: pg.PoolClient, user: AuthUser, id: number, note: string) {
  await requirePermission(c, user, 'quality.disposition', 'Releasing a quality hold requires the quality.disposition authority');
  if (!note?.trim()) throw new HttpError(422, 'A release note is required');
  const h = (await c.query('SELECT * FROM quality_holds WHERE id = $1', [id])).rows[0];
  if (!h || h.status !== 'OPEN') throw new HttpError(409, 'Hold is not open');
  await c.query(`UPDATE quality_holds SET status = 'RELEASED', released_by = $2, released_at = now(), release_note = $3 WHERE id = $1`, [id, user.id, note]);
  const other = (await c.query(`SELECT count(*)::int n FROM quality_holds WHERE unit_id = $1 AND status = 'OPEN'`, [h.unit_id])).rows[0].n;
  if (!other) {
    await c.query(`UPDATE units SET disposition = 'RELEASABLE' WHERE id = $1`, [h.unit_id]);
    await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'DISPOSITION',$2,'"RELEASABLE"',$3,$4)`,
      [h.unit_id, JSON.stringify(h.disposition), note, user.id]);
  }
  await syncDerivedGates(c);
  const u = (await c.query('SELECT project_id FROM units WHERE id = $1', [h.unit_id])).rows[0];
  await bumpInputs(c, [u?.project_id]);
  await audit(c, { userId: user.id, action: 'quality.hold.release', changeClass: 'QUALITY', entityType: 'quality_hold', entityId: id, projectId: u?.project_id, reason: note });
}

/** Issues mirror the external tracker; similar symptoms are never merged automatically. */
export async function upsertIssue(c: pg.PoolClient, user: AuthUser, body: { id?: number; externalRef?: string | null; title: string; symptom?: string; rootCause?: string | null; status?: string; owner?: string; projectId?: number | null; unitIds?: number[] }) {
  let id = body.id;
  if (id) {
    await c.query(`UPDATE issues SET external_ref=COALESCE($2,external_ref), title=$3, symptom=COALESCE($4,symptom), root_cause=COALESCE($5,root_cause), status=COALESCE($6,status),
      owner=COALESCE($7,owner), project_id=COALESCE($8,project_id), updated_at=now() WHERE id=$1`,
    [id, body.externalRef ?? null, body.title, body.symptom ?? null, body.rootCause ?? null, body.status ?? null, body.owner ?? null, body.projectId ?? null]);
  } else {
    id = (await c.query(`INSERT INTO issues (external_ref, title, symptom, root_cause, status, owner, project_id, created_by) VALUES ($1,$2,$3,$4,COALESCE($5,'OPEN'),$6,$7,$8) RETURNING id`,
      [body.externalRef ?? null, body.title, body.symptom ?? null, body.rootCause ?? null, body.status ?? null, body.owner ?? null, body.projectId ?? null, user.id])).rows[0].id;
  }
  for (const u of body.unitIds ?? []) await c.query('INSERT INTO issue_units (issue_id, unit_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, u]);
  await audit(c, { userId: user.id, action: body.id ? 'issue.update' : 'issue.create', changeClass: 'QUALITY', entityType: 'issue', entityId: id!, projectId: body.projectId ?? null, after: body });
  return id!;
}

/** A proposed rework work package. It is scheduled only through an approved scenario (op add_rework). */
export async function proposeRework(c: pg.PoolClient, user: AuthUser, body: {
  unitId: number; issueId?: number | null; scope: string; instructionRef?: string | null; stationCode?: string; prepSlots?: number; handsOnSlots?: number;
  retest?: 'NONE' | 'EOL' | 'VALIDATION'; parts?: { materialId: number; qty: number }[]; owner?: string;
}) {
  const u = (await c.query('SELECT * FROM units WHERE id = $1', [body.unitId])).rows[0];
  if (!u) throw new HttpError(404, 'Unit not found');
  const st = (await c.query('SELECT id FROM work_centers WHERE code = $1', [body.stationCode ?? 'REWORK'])).rows[0];
  const me = (await c.query(`SELECT id FROM work_centers WHERE code = 'ME_QA'`)).rows[0];
  const r = await c.query(`INSERT INTO rework_packages (project_id, unit_id, system_id, issue_id, scope, instruction_ref, station_resource_id, personnel_resource_id, prep_slots, hands_on_slots,
      retest, parts, owner, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
  [u.project_id, u.id, u.system_id, body.issueId ?? null, body.scope, body.instructionRef ?? null, st?.id ?? null, me?.id ?? null, body.prepSlots ?? 1, body.handsOnSlots ?? 1,
    body.retest ?? 'EOL', JSON.stringify(body.parts ?? []), body.owner ?? null, user.id]);
  await audit(c, { userId: user.id, action: 'rework.propose', changeClass: 'QUALITY', entityType: 'rework', entityId: r.rows[0].id, projectId: u.project_id, after: body });
  return r.rows[0].id;
}

export async function approveReworkInstruction(c: pg.PoolClient, user: AuthUser, id: number, ref: string) {
  await requirePermission(c, user, 'quality.disposition', 'Approving a rework instruction requires Manufacturing Engineering / Quality authority');
  const rw = (await c.query('SELECT * FROM rework_packages WHERE id = $1', [id])).rows[0];
  if (!rw) throw new HttpError(404, 'Rework not found');
  await c.query('UPDATE rework_packages SET instruction_ref = COALESCE($2, instruction_ref), instruction_approved = true, instruction_approved_by = $3 WHERE id = $1', [id, ref, user.id]);
  await c.query(`UPDATE readiness_gates SET status = 'READY', evidence_ref = $2, last_confirmed_at = now(), last_confirmed_by = $3 WHERE source_type = 'REWORK_INSTRUCTION' AND source_id = $1`, [id, ref, user.id]);
  await bumpInputs(c, [rw.project_id]);
  await audit(c, { userId: user.id, action: 'rework.instruction.approve', changeClass: 'QUALITY', entityType: 'rework', entityId: id, projectId: rw.project_id, reason: ref });
}

export async function qualityView(db: Db, projectId?: number) {
  const where = projectId ? 'WHERE u.project_id = $1' : '';
  const params = projectId ? [projectId] : [];
  const holds = (await db.query(`SELECT h.*, u.internal_id, u.name unit_name, u.serial, p.code project, i.external_ref, i.title issue_title
    FROM quality_holds h JOIN units u ON u.id = h.unit_id LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN issues i ON i.id = h.issue_id ${where} ORDER BY h.status, h.created_at DESC`, params)).rows;
  const rework = (await db.query(`SELECT r.*, u.internal_id, u.name unit_name, p.code project, i.external_ref FROM rework_packages r LEFT JOIN units u ON u.id = r.unit_id
    LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN issues i ON i.id = r.issue_id ${projectId ? 'WHERE r.project_id = $1' : ''} ORDER BY r.created_at DESC`, params)).rows;
  const issues = (await db.query(`SELECT i.*, p.code project, (SELECT json_agg(json_build_object('id', u.id, 'internalId', u.internal_id, 'name', u.name)) FROM issue_units iu JOIN units u ON u.id = iu.unit_id WHERE iu.issue_id = i.id) units
    FROM issues i LEFT JOIN projects p ON p.id = i.project_id ${projectId ? 'WHERE i.project_id = $1' : ''} ORDER BY i.status, i.updated_at DESC`, params)).rows;
  const tests = (await db.query(`SELECT t.*, u.internal_id, u.name unit_name, s.code system_code, tp.code plan_code, tp.version plan_version, a.name activity
    FROM test_records t LEFT JOIN units u ON u.id = t.unit_id LEFT JOIN systems s ON s.id = t.system_id LEFT JOIN test_plans tp ON tp.id = t.test_plan_id
    LEFT JOIN activities a ON a.id = t.activity_id ${projectId ? 'WHERE COALESCE(u.project_id, s.project_id) = $1' : ''} ORDER BY t.executed_at DESC LIMIT 300`, params)).rows;
  const plans = (await db.query('SELECT * FROM test_plans ORDER BY code, version')).rows;
  const coverage = (await db.query('SELECT * FROM test_coverage ORDER BY product_family, module')).rows;
  return { holds, rework, issues, tests, plans, coverage };
}
