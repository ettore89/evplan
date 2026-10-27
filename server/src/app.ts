import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { pool, tx, lockPlan } from './db/pool.js';
import { authenticate, login } from './services/auth.js';
import { adminRouter } from './routes/admin.js';
import { aiRouter } from './routes/ai.js';
import { audit, can, currentSlot, HttpError, requirePermission } from './services/common.js';
import { executionSchema, updateExecution } from './services/execution.js';
import { createProject, createProjectSchema, freezeInfo } from './services/projects.js';
import {
  activitiesFor, capacityView, dailyControl, diffSinceSnapshot, gantt, milestoneChain, portfolio, projectDetails, snapshotData,
} from './services/read.js';
import { recalculate } from './services/recalc.js';
import { presence } from './services/realtime.js';
import {
  commitScenario, createScenario, evaluate, opSchema, rejectScenario, resimulate, scenarioSchema, submitScenario, updateScenarioOps,
} from './services/scenarios.js';
import type { ScenarioOp } from './engine/scenario.js';

const id = (req: Request, key = 'id') => {
  const n = Number(req.params[key]);
  if (!Number.isInteger(n)) throw new HttpError(400, `Invalid ${key}`);
  return n;
};

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.post('/api/auth/login', async (req, res) => {
    const body = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    res.json(await login(body.username, body.password));
  });
  app.get('/api/auth/demo-users', async (_req, res) => {
    const demo = (await pool.query(`SELECT value FROM settings WHERE key = 'demo_mode'`)).rows[0]?.value ?? false;
    if (!demo) return res.json([]);
    const r = await pool.query('SELECT username, name, role FROM users WHERE active ORDER BY id');
    res.json(r.rows);
  });

  const api = express.Router();
  api.use(authenticate);

  api.get('/me', async (req, res) => {
    const perms = await pool.query('SELECT action FROM permissions WHERE $1 = ANY(roles)', [req.user.role]);
    res.json({ user: req.user, permissions: perms.rows.map((r) => r.action) });
  });

  api.get('/meta', async (_req, res) => {
    const q = (s: string) => pool.query(s).then((r) => r.rows);
    const [customers, routes, productTypes, workCenters, calendars, delayCategories, users, settings, regions] = await Promise.all([
      q('SELECT * FROM customers ORDER BY name'), q('SELECT * FROM routes ORDER BY code'), q('SELECT * FROM product_types ORDER BY code'),
      q('SELECT * FROM work_centers ORDER BY route_order, id'), q('SELECT * FROM calendars ORDER BY id'), q('SELECT * FROM delay_categories ORDER BY id'),
      q('SELECT id, username, name, role FROM users WHERE active ORDER BY name'), q(`SELECT key, value FROM settings`), q('SELECT * FROM regions ORDER BY code'),
    ]);
    res.json({ customers, routes, productTypes, workCenters, calendars, delayCategories, users, regions,
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])), now: await currentSlot(pool) });
  });

  api.get('/portfolio', async (_req, res) => res.json(await portfolio(pool)));
  api.get('/gantt', async (_req, res) => res.json(await gantt(pool)));
  api.get('/capacity', async (_req, res) => res.json(await capacityView(pool)));
  api.get('/daily', async (_req, res) => res.json(await dailyControl(pool)));
  api.get('/presence', (_req, res) => res.json(presence()));

  api.get('/projects/:id', async (req, res) => res.json(await projectDetails(pool, id(req))));
  api.post('/projects', async (req, res) => {
    const input = createProjectSchema.parse(req.body);
    res.status(201).json(await tx(async (c) => { await lockPlan(c); return createProject(c, req.user, input); }));
  });
  api.patch('/projects/:id/commercial', async (req, res) => {
    const body = z.object({
      requiredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), name: z.string().optional(), siteLocation: z.string().optional(),
      notes: z.string().optional(), reason: z.string().min(3),
    }).parse(req.body);
    const out = await tx(async (c) => {
      await lockPlan(c);
      await requirePermission(c, req.user, 'project.commercial.edit');
      const before = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [id(req)])).rows[0];
      if (!before) throw new HttpError(404, 'Project not found');
      await c.query(`UPDATE projects SET required_commissioning_date = COALESCE($2, required_commissioning_date), name = COALESCE($3, name),
        site_location = COALESCE($4, site_location), notes = COALESCE($5, notes) WHERE id = $1`,
      [before.id, body.requiredDate ?? null, body.name ?? null, body.siteLocation ?? null, body.notes ?? null]);
      await audit(c, { userId: req.user.id, action: 'project.commercial', changeClass: 'COMMERCIAL', entityType: 'project', entityId: before.id, projectId: before.id,
        before: { requiredDate: before.required_commissioning_date, name: before.name, siteLocation: before.site_location, notes: before.notes },
        after: body, reason: body.reason });
      return { ok: true };
    });
    res.json(out);
  });
  api.post('/projects/:id/accept-forecast', async (req, res) => {
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    const pid = id(req);
    const out = await tx(async (c) => {
      await lockPlan(c);
      await requirePermission(c, req.user, 'plan.accept_forecast');
      const fz = (await freezeInfo(c, [pid])).get(pid);
      const acts = await c.query(`SELECT id FROM activities WHERE project_id = $1 AND status NOT IN ('COMPLETED','CANCELLED')`, [pid]);
      const r = await recalculate(c, {
        userId: req.user.id, kind: 'ACCEPT_FORECAST', summary: `Forecast accepted as new commitment by ${req.user.name}`,
        approve: { activityIds: new Set(acts.rows.map((a) => a.id)), projectIds: new Set([pid]), kind: fz?.frozen ? 'OVERRIDE' : 'APPROVED_CHANGE', reason: body.reason },
      });
      // milestones re-committed even if the forecast did not change in this run
      const ms = await c.query('SELECT id, forecast_slot, approved_slot FROM milestones WHERE project_id = $1 AND shipment_id IS NULL', [pid]);
      for (const m of ms.rows) {
        if (m.forecast_slot !== m.approved_slot && m.forecast_slot !== null) {
          await c.query('UPDATE milestones SET approved_slot = forecast_slot WHERE id = $1', [m.id]);
          await c.query(`INSERT INTO milestone_commitments (milestone_id, committed_slot, previous_slot, kind, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
            [m.id, m.forecast_slot, m.approved_slot, fz?.frozen ? 'OVERRIDE' : 'APPROVED_CHANGE', body.reason, req.user.id]);
        }
      }
      await c.query(`UPDATE activities SET approved_start = forecast_start, approved_finish = forecast_finish WHERE project_id = $1 AND status NOT IN ('COMPLETED','CANCELLED')`, [pid]);
      await audit(c, { userId: req.user.id, action: 'project.accept_forecast', changeClass: fz?.frozen ? 'OVERRIDE' : 'APPROVED_CHANGE', entityType: 'project', entityId: pid, projectId: pid, planVersion: r.version, reason: body.reason });
      return { version: r.version };
    });
    res.json(out);
  });

  api.get('/milestones/:projectId/:type/chain', async (req, res) => {
    const type = z.enum(['EOL', 'EXW', 'COMM']).parse(req.params.type);
    res.json(await milestoneChain(pool, id(req, 'projectId'), type));
  });

  api.get('/activities/:id', async (req, res) => {
    const [a] = await activitiesFor(pool, 'AND a.id = $1', [id(req)]);
    if (!a) throw new HttpError(404, 'Activity not found');
    const events = await pool.query(`SELECT e.*, u.name AS user_name, ra.name AS origin_activity FROM delay_events e LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN activities ra ON ra.id = e.origin_activity_id WHERE e.activity_id = $1 ORDER BY e.id DESC LIMIT 100`, [a.id]);
    const comments = await pool.query(`SELECT cm.*, u.name AS user_name, u.role FROM comments cm JOIN users u ON u.id = cm.user_id WHERE cm.activity_id = $1 ORDER BY cm.created_at DESC`, [a.id]);
    const preds = await pool.query(`SELECT p.id, p.name, p.status, p.forecast_finish FROM dependencies d JOIN activities p ON p.id = d.pred_id WHERE d.succ_id = $1`, [a.id]);
    const canEdit = await can(pool, req.user, `activity.execute.${a.function}`);
    res.json({ activity: a, events: events.rows, comments: comments.rows, predecessors: preds.rows, canEdit });
  });
  api.patch('/activities/:id/execution', async (req, res) => {
    const input = executionSchema.parse(req.body);
    res.json(await tx(async (c) => { await lockPlan(c); return updateExecution(c, req.user, id(req), input); }));
  });
  api.post('/activities/:id/comments', async (req, res) => {
    const body = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const a = (await pool.query('SELECT project_id FROM activities WHERE id = $1', [id(req)])).rows[0];
    if (!a) throw new HttpError(404, 'Activity not found');
    const r = await pool.query(`INSERT INTO comments (project_id, activity_id, user_id, text) VALUES ($1,$2,$3,$4) RETURNING *`, [a.project_id, id(req), req.user.id, body.text]);
    res.status(201).json(r.rows[0]);
  });
  api.post('/activities/:id/lock', async (req, res) => {
    const body = z.object({ locked: z.boolean(), reason: z.string().min(3) }).parse(req.body);
    const out = await tx(async (c) => {
      await lockPlan(c);
      await requirePermission(c, req.user, 'activity.lock');
      const a = (await c.query('UPDATE activities SET locked = $2 WHERE id = $1 RETURNING project_id', [id(req), body.locked])).rows[0];
      if (!a) throw new HttpError(404, 'Activity not found');
      const r = await recalculate(c, { userId: req.user.id, kind: 'LOCK', summary: `${body.locked ? 'Locked' : 'Unlocked'} activity ${id(req)}` });
      await audit(c, { userId: req.user.id, action: body.locked ? 'activity.lock' : 'activity.unlock', changeClass: 'APPROVED_CHANGE', entityType: 'activity', entityId: id(req), projectId: a.project_id, planVersion: r.version, reason: body.reason });
      return { version: r.version };
    });
    res.json(out);
  });

  // Scenarios
  api.post('/simulate', async (req, res) => {
    const ops = z.array(opSchema).min(1).parse(req.body.ops) as ScenarioOp[];
    await requirePermission(pool, req.user, 'scenario.create');
    res.json(await evaluate(pool, ops));
  });
  api.get('/scenarios', async (_req, res) => {
    const r = await pool.query(`SELECT s.id, s.name, s.description, s.status, s.ops, s.created_at, s.requires_management, s.requires_reason, s.frozen_projects,
      s.result->>'summary' AS summary, s.justification, s.source, u.name AS created_by_name, a.name AS approved_by_name, s.approved_at
      FROM scenarios s JOIN users u ON u.id = s.created_by LEFT JOIN users a ON a.id = s.approved_by ORDER BY s.created_at DESC LIMIT 200`);
    res.json(r.rows);
  });
  api.get('/scenarios/:id', async (req, res) => {
    const r = await pool.query(`SELECT s.*, u.name AS created_by_name, a.name AS approved_by_name FROM scenarios s JOIN users u ON u.id = s.created_by
      LEFT JOIN users a ON a.id = s.approved_by WHERE s.id = $1`, [id(req)]);
    if (!r.rows.length) throw new HttpError(404, 'Scenario not found');
    res.json(r.rows[0]);
  });
  api.post('/scenarios', async (req, res) => {
    const input = scenarioSchema.parse(req.body);
    res.status(201).json(await tx((c) => createScenario(c, req.user, input)));
  });
  api.put('/scenarios/:id', async (req, res) => {
    const body = z.object({ name: z.string().optional(), description: z.string().optional(), ops: z.array(opSchema).min(1) }).parse(req.body);
    res.json(await tx((c) => updateScenarioOps(c, req.user, id(req), body as any)));
  });
  api.post('/scenarios/:id/simulate', async (req, res) => res.json(await tx((c) => resimulate(c, id(req)))));
  api.post('/scenarios/:id/submit', async (req, res) => {
    await tx((c) => submitScenario(c, req.user, id(req), req.body?.note));
    res.json({ ok: true });
  });
  api.post('/scenarios/:id/reject', async (req, res) => {
    await tx((c) => rejectScenario(c, req.user, id(req), req.body?.reason));
    res.json({ ok: true });
  });
  api.post('/scenarios/:id/commit', async (req, res) => {
    const body = z.object({ justification: z.string().max(4000).optional(), confirmLatest: z.boolean().optional() }).parse(req.body ?? {});
    const out = await tx(async (c) => { await lockPlan(c); return commitScenario(c, req.user, id(req), body); });
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 200).json(out);
  });

  api.post('/recalculate', async (req, res) => {
    const out = await tx(async (c) => {
      await lockPlan(c);
      await requirePermission(c, req.user, 'plan.recalculate');
      const r = await recalculate(c, { userId: req.user.id, kind: 'MANUAL_RECALC', summary: `Recalculation triggered by ${req.user.name}` });
      return { version: r.version, changedActivities: r.changes.length, milestoneChanges: r.milestoneChanges.length };
    });
    res.json(out);
  });

  // Daily call snapshots and decisions
  api.get('/snapshots', async (_req, res) => {
    const r = await pool.query(`SELECT s.id, s.label, s.kind, s.plan_version, s.created_at, u.name AS created_by_name FROM plan_snapshots s
      LEFT JOIN users u ON u.id = s.created_by ORDER BY s.created_at DESC LIMIT 100`);
    res.json(r.rows);
  });
  api.post('/snapshots', async (req, res) => {
    const body = z.object({ label: z.string().min(1), kind: z.enum(['DAILY_CALL', 'MANUAL']).default('DAILY_CALL') }).parse(req.body);
    await requirePermission(pool, req.user, 'snapshot.create');
    const data = await snapshotData(pool);
    const v = (await pool.query('SELECT COALESCE(MAX(id),0) v FROM plan_versions')).rows[0].v;
    const r = await pool.query('INSERT INTO plan_snapshots (label, kind, plan_version, created_by, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, label, created_at',
      [body.label, body.kind, v, req.user.id, JSON.stringify(data)]);
    await audit(pool, { userId: req.user.id, action: 'snapshot.create', changeClass: 'SYSTEM', entityType: 'snapshot', entityId: r.rows[0].id, reason: body.label });
    res.status(201).json(r.rows[0]);
  });
  api.get('/snapshots/:id/diff', async (req, res) => res.json(await diffSinceSnapshot(pool, id(req))));
  api.post('/decisions', async (req, res) => {
    const body = z.object({ text: z.string().min(2), projectId: z.number().int().nullable().optional(), owner: z.string().optional(), snapshotId: z.number().int().nullable().optional() }).parse(req.body);
    await requirePermission(pool, req.user, 'decision.create');
    const r = await pool.query('INSERT INTO decisions (snapshot_id, project_id, text, owner, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [body.snapshotId ?? null, body.projectId ?? null, body.text, body.owner ?? null, req.user.id]);
    await audit(pool, { userId: req.user.id, action: 'decision.create', changeClass: 'APPROVED_CHANGE', entityType: 'decision', entityId: r.rows[0].id, projectId: body.projectId ?? null, reason: body.text });
    res.status(201).json(r.rows[0]);
  });
  api.patch('/decisions/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['OPEN', 'DONE']) }).parse(req.body);
    await requirePermission(pool, req.user, 'decision.create');
    await pool.query('UPDATE decisions SET status = $2 WHERE id = $1', [id(req), body.status]);
    res.json({ ok: true });
  });

  api.get('/audit', async (req, res) => {
    const pid = req.query.projectId ? Number(req.query.projectId) : null;
    const cls = req.query.changeClass ? String(req.query.changeClass) : null;
    const r = await pool.query(`SELECT ae.*, u.name AS user_name, u.role, p.code AS project FROM audit_events ae LEFT JOIN users u ON u.id = ae.user_id
      LEFT JOIN projects p ON p.id = ae.project_id WHERE ($1::int IS NULL OR ae.project_id = $1) AND ($2::text IS NULL OR ae.change_class = $2)
      ORDER BY ae.ts DESC, ae.id DESC LIMIT 500`, [pid, cls]);
    res.json(r.rows);
  });
  api.get('/delay-events', async (req, res) => {
    const pid = req.query.projectId ? Number(req.query.projectId) : null;
    const r = await pool.query(`SELECT e.*, a.name AS activity, un.serial, p.code AS project, u.name AS user_name, ra.name AS origin_activity
      FROM delay_events e JOIN projects p ON p.id = e.project_id LEFT JOIN activities a ON a.id = e.activity_id LEFT JOIN units un ON un.id = a.unit_id
      LEFT JOIN users u ON u.id = e.user_id LEFT JOIN activities ra ON ra.id = e.origin_activity_id
      WHERE ($1::int IS NULL OR e.project_id = $1) ORDER BY e.id DESC LIMIT 500`, [pid]);
    res.json(r.rows);
  });

  api.use('/admin', adminRouter());
  api.use('/ai', aiRouter());
  app.use('/api', api);

  // Built web client
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [join(here, '../../web/dist'), join(here, '../../../web/dist')].find((p) => existsSync(p));
  if (webDist) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', details: err.issues });
    const pgErr = err as { code?: string; detail?: string; message?: string };
    if (pgErr?.code === '23505') return res.status(409).json({ error: pgErr.detail ?? 'Duplicate value', code: 'DUPLICATE' });
    if (pgErr?.code === '23503') return res.status(409).json({ error: pgErr.detail ?? 'Referenced record', code: 'FK' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
