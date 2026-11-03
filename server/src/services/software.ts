/**
 * Software / firmware / FPGA / tool releases as planning objects:
 * candidate → validation → approved for a defined use → artifact available → installed on
 * identified units → required checks passed. An announcement never satisfies a gate.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { audit, bumpInputs, HttpError, requirePermission, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';

async function projectsUsing(c: pg.PoolClient, componentCode: string) {
  const r = await c.query(`SELECT DISTINCT project_id FROM readiness_gates WHERE source_type = 'SOFTWARE' AND spec->>'component' = $1`, [componentCode]);
  return r.rows.map((x) => x.project_id as number);
}

export async function upsertRelease(c: pg.PoolClient, user: AuthUser, body: {
  id?: number; componentId: number; version: string; stage?: string; expectedAvailableDate?: string | null; artifactRef?: string | null; knownIssues?: string[]; notes?: string;
}) {
  await requirePermission(c, user, 'release.approve', 'Maintaining releases requires the release.approve authority');
  let id = body.id;
  const before = id ? (await c.query('SELECT * FROM sw_releases WHERE id = $1', [id])).rows[0] : null;
  if (body.stage === 'APPROVED') throw new HttpError(422, 'Use an approval with a defined scope to approve a release', 'USE_APPROVAL');
  if (id) {
    await c.query(`UPDATE sw_releases SET version=$2, stage=COALESCE($3, stage), expected_available_date=$4, artifact_ref=COALESCE($5, artifact_ref),
      known_issues=COALESCE($6, known_issues), notes=COALESCE($7, notes) WHERE id=$1`,
    [id, body.version, body.stage ?? null, body.expectedAvailableDate ?? null, body.artifactRef ?? null, body.knownIssues ? JSON.stringify(body.knownIssues) : null, body.notes ?? null]);
  } else {
    id = (await c.query(`INSERT INTO sw_releases (component_id, version, stage, expected_available_date, artifact_ref, known_issues, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [body.componentId, body.version, body.stage ?? 'CANDIDATE', body.expectedAvailableDate ?? null, body.artifactRef ?? null,
      JSON.stringify(body.knownIssues ?? []), body.notes ?? null, user.id])).rows[0].id;
  }
  const comp = (await c.query('SELECT * FROM sw_components WHERE id = $1', [body.componentId])).rows[0];
  await syncDerivedGates(c);
  await bumpInputs(c, await projectsUsing(c, comp.code));
  await audit(c, { userId: user.id, action: 'software.release', changeClass: 'SOFTWARE', entityType: 'sw_release', entityId: id!, before, after: body });
  return id!;
}

/** Approve a release for a defined use (evaluation units, specific units, production, field). */
export async function approveRelease(c: pg.PoolClient, user: AuthUser, releaseId: number, body: { scope: 'EVALUATION_UNITS' | 'SPECIFIC_UNITS' | 'PRODUCTION' | 'FIELD'; unitIds?: number[]; basisRef: string; validUntil?: string | null; makeProductionTarget?: boolean }) {
  await requirePermission(c, user, 'release.approve', 'Approving a release requires the designated technical authority (release.approve)');
  if (!body.basisRef?.trim()) throw new HttpError(422, 'An approval basis (evidence reference) is required');
  const rel = (await c.query('SELECT r.*, c.code component FROM sw_releases r JOIN sw_components c ON c.id = r.component_id WHERE r.id = $1', [releaseId])).rows[0];
  if (!rel) throw new HttpError(404, 'Release not found');
  if (body.scope === 'SPECIFIC_UNITS' && !body.unitIds?.length) throw new HttpError(422, 'List the units this approval covers');
  const a = await c.query(`INSERT INTO sw_release_approvals (release_id, scope, unit_ids, basis_ref, approved_by, valid_until) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [releaseId, body.scope, body.unitIds ?? [], body.basisRef, user.id, body.validUntil ?? null]);
  await c.query(`UPDATE sw_releases SET stage = 'APPROVED' WHERE id = $1`, [releaseId]);
  if (body.makeProductionTarget && body.scope === 'PRODUCTION') await c.query('UPDATE sw_components SET production_release_id = $2 WHERE id = $1', [rel.component_id, releaseId]);
  await syncDerivedGates(c);
  await bumpInputs(c, await projectsUsing(c, rel.component));
  await audit(c, { userId: user.id, action: 'software.approve', changeClass: 'SOFTWARE', entityType: 'sw_release', entityId: releaseId, after: body, reason: body.basisRef });
  return a.rows[0].id;
}

export async function markArtifactAvailable(c: pg.PoolClient, user: AuthUser, releaseId: number, body: { artifactRef: string }) {
  await requirePermission(c, user, 'release.approve');
  if (!body.artifactRef?.trim()) throw new HttpError(422, 'Reference the installation artifact (file location, package id)');
  const rel = (await c.query('SELECT r.*, c.code component FROM sw_releases r JOIN sw_components c ON c.id = r.component_id WHERE r.id = $1', [releaseId])).rows[0];
  if (!rel) throw new HttpError(404, 'Release not found');
  await c.query('UPDATE sw_releases SET artifact_ref = $2, artifact_available_at = now() WHERE id = $1', [releaseId, body.artifactRef]);
  await syncDerivedGates(c);
  await bumpInputs(c, await projectsUsing(c, rel.component));
  await audit(c, { userId: user.id, action: 'software.artifact_available', changeClass: 'SOFTWARE', entityType: 'sw_release', entityId: releaseId, after: body });
}

/**
 * Record an installation on identified units. Previous test results of those units are kept but
 * flagged for review because they were obtained with different software.
 */
export async function recordInstallation(c: pg.PoolClient, user: AuthUser, body: { releaseId: number; unitIds: number[]; checksPassed: boolean; note?: string }) {
  const rel = (await c.query('SELECT r.*, c.code component, c.name component_name FROM sw_releases r JOIN sw_components c ON c.id = r.component_id WHERE r.id = $1', [body.releaseId])).rows[0];
  if (!rel) throw new HttpError(404, 'Release not found');
  const approvals = (await c.query('SELECT * FROM sw_release_approvals WHERE release_id = $1 AND revoked_at IS NULL', [body.releaseId])).rows;
  for (const uid of body.unitIds) {
    const u = (await c.query('SELECT * FROM units WHERE id = $1', [uid])).rows[0];
    if (!u) throw new HttpError(404, `Unit ${uid} not found`);
    const basis = approvals.find((a) => a.scope === 'PRODUCTION' || (a.scope === 'SPECIFIC_UNITS' && a.unit_ids.includes(uid)) || (a.scope === 'EVALUATION_UNITS' && u.evaluation_unit));
    if (!basis) throw new HttpError(422, `${rel.component_name} ${rel.version} is not approved for unit ${u.internal_id}`, 'NOT_APPROVED_FOR_UNIT');
    if (!rel.artifact_available_at) throw new HttpError(422, `The installation artifact of ${rel.version} is not available`, 'ARTIFACT_UNAVAILABLE');
    const prev = (await c.query(`SELECT us.* FROM unit_software us JOIN sw_releases r ON r.id = us.release_id WHERE us.unit_id = $1 AND r.component_id = $2 AND NOT us.superseded`, [uid, rel.component_id])).rows;
    await c.query('UPDATE unit_software SET superseded = true WHERE id = ANY($1)', [prev.map((p) => p.id)]);
    await c.query(`INSERT INTO unit_software (unit_id, release_id, approval_id, installed_by, checks_passed_at, checks_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uid, body.releaseId, basis.id, user.id, body.checksPassed ? new Date() : null, body.checksPassed ? user.id : null]);
    await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'SW_INSTALLED',$2,$3,$4,$5)`,
      [uid, JSON.stringify(prev.map((p) => p.release_id)), JSON.stringify({ releaseId: body.releaseId, version: rel.version, approvalId: basis.id, checksPassed: body.checksPassed }), body.note ?? null, user.id]);
    if (prev.length) {
      await c.query(`UPDATE test_records SET status = 'REVIEW_REQUIRED', review_reason = $2 WHERE (unit_id = $1 OR system_id = $3) AND status = 'VALID'
        AND (sw_release_id IS NULL OR sw_release_id <> $4)`, [uid, `Software updated to ${rel.component_name} ${rel.version}`, u.system_id, body.releaseId]);
    }
  }
  await syncDerivedGates(c);
  const projects = (await c.query('SELECT DISTINCT project_id FROM units WHERE id = ANY($1)', [body.unitIds])).rows.map((r) => r.project_id);
  await bumpInputs(c, projects);
  await audit(c, { userId: user.id, action: 'software.install', changeClass: 'SOFTWARE', entityType: 'sw_release', entityId: body.releaseId, after: body, reason: body.note ?? null });
}

export async function softwareView(db: Db) {
  const comps = (await db.query('SELECT * FROM sw_components ORDER BY code')).rows;
  const rels = (await db.query(`SELECT r.*, u.name created_by_name FROM sw_releases r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.component_id, r.created_at`)).rows;
  const apps = (await db.query(`SELECT a.*, u.name approved_by_name FROM sw_release_approvals a LEFT JOIN users u ON u.id = a.approved_by ORDER BY a.approved_at`)).rows;
  const inst = (await db.query(`SELECT release_id, count(*)::int n, count(*) FILTER (WHERE checks_passed_at IS NOT NULL)::int checked FROM unit_software WHERE NOT superseded GROUP BY release_id`)).rows;
  const gates = (await db.query(`SELECT spec->>'component' component, status, count(*)::int n FROM readiness_gates WHERE source_type = 'SOFTWARE' GROUP BY 1, 2`)).rows;
  return comps.map((c) => ({
    ...c,
    releases: rels.filter((r) => r.component_id === c.id).map((r) => ({
      ...r, approvals: apps.filter((a) => a.release_id === r.id), installed: inst.find((i) => i.release_id === r.id)?.n ?? 0,
      checked: inst.find((i) => i.release_id === r.id)?.checked ?? 0, isProductionTarget: c.production_release_id === r.id,
    })),
    gates: gates.filter((g) => g.component === c.code),
  }));
}
