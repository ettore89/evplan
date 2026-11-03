import type { Db } from '../db/pool.js';
import { dayOf, nowSlot } from '../engine/calendar.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

export type Role = 'MANUFACTURING' | 'TESTING' | 'RND' | 'LOGISTICS' | 'COMMERCIAL' | 'SERVICE' | 'MANAGEMENT';

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  role: Role;
}

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? (r.rows[0].value as T) : fallback;
}

/** Current planning slot. `clock_override` (ISO timestamp) supports demos and tests. */
export async function currentSlot(db: Db): Promise<number> {
  const override = await getSetting<string | null>(db, 'clock_override', null);
  const tz = await getSetting<string>(db, 'timezone', 'Europe/Rome');
  return nowSlot(override ? new Date(override) : new Date(), tz);
}

export async function todayDay(db: Db) {
  return dayOf(await currentSlot(db));
}

/** Role-based permission, or a narrow capability granted to this named user. */
export async function can(db: Db, user: AuthUser, action: string): Promise<boolean> {
  const cap = await db.query('SELECT 1 FROM user_capabilities WHERE user_id = $1 AND capability = $2', [user.id, action]);
  if (cap.rows.length) return true;
  const r = await db.query('SELECT roles FROM permissions WHERE action = $1', [action]);
  if (!r.rows.length) return user.role === 'MANAGEMENT';
  return (r.rows[0].roles as string[]).includes(user.role);
}

export async function capabilitiesOf(db: Db, user: AuthUser): Promise<string[]> {
  const r = await db.query(`SELECT action FROM permissions WHERE $1 = ANY(roles)
    UNION SELECT capability FROM user_capabilities WHERE user_id = $2`, [user.role, user.id]);
  return r.rows.map((x) => x.action);
}

/**
 * Mark the planning inputs of projects as changed (actuals, configuration, materials, releases,
 * capacity…). Scenarios simulated on older inputs of an affected project become stale.
 */
export async function bumpInputs(db: Db, projectIds: (number | null | undefined)[] | 'ALL') {
  if (projectIds === 'ALL') {
    await db.query(`UPDATE projects SET input_version = input_version + 1 WHERE status = 'ACTIVE'`);
    return;
  }
  const ids = [...new Set(projectIds.filter((x): x is number => typeof x === 'number'))];
  if (ids.length) await db.query('UPDATE projects SET input_version = input_version + 1 WHERE id = ANY($1)', [ids]);
}

export async function requirePermission(db: Db, user: AuthUser, action: string, message?: string) {
  if (!(await can(db, user, action))) {
    throw new HttpError(403, message ?? `Role ${user.role} is not permitted to perform "${action}"`, 'FORBIDDEN');
  }
}

export interface AuditInput {
  userId: number | null;
  action: string;
  changeClass: 'EXECUTION' | 'APPROVED_CHANGE' | 'OVERRIDE' | 'PRIORITY' | 'CONFIG' | 'FORECAST' | 'COMMERCIAL' | 'SYSTEM' | 'READINESS' | 'QUALITY' | 'MATERIAL' | 'SOFTWARE' | 'LOGISTICS' | 'IMPORT';
  entityType: string;
  entityId?: number | null;
  projectId?: number | null;
  scenarioId?: number | null;
  planVersion?: number | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export async function audit(db: Db, a: AuditInput) {
  await db.query(
    `INSERT INTO audit_events (user_id, action, change_class, entity_type, entity_id, project_id, scenario_id, plan_version, before, after, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [a.userId, a.action, a.changeClass, a.entityType, a.entityId ?? null, a.projectId ?? null, a.scenarioId ?? null,
      a.planVersion ?? null, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null],
  );
}

export async function newVersion(db: Db, kind: string, summary: string, userId: number | null, scenarioId: number | null = null): Promise<number> {
  const r = await db.query('INSERT INTO plan_versions (kind, summary, user_id, scenario_id) VALUES ($1,$2,$3,$4) RETURNING id', [kind, summary, userId, scenarioId]);
  return r.rows[0].id;
}

export async function currentVersion(db: Db): Promise<number> {
  const r = await db.query('SELECT COALESCE(MAX(id), 0) AS v FROM plan_versions');
  return Number(r.rows[0].v);
}
