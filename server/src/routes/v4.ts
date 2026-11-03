/** V4 API: readiness gates, materials, software releases, quality & rework, units, logistics, visits, configuration, capacity timeline. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { lockPlan, pool, tx } from '../db/pool.js';
import { audit, bumpInputs, HttpError, requirePermission } from '../services/common.js';
import { conditionalRelease, createManualGate, syncDerivedGates, updateGate } from '../services/gates.js';
import { addRequirement, materialsView, receiveReceipt, upsertReceipt, upsertStock } from '../services/materials.js';
import { createConfigurationVersion, decideConfiguration, updateAction, updateShipment, updateUnit, updateVisit, upsertDocument } from '../services/operations.js';
import { approveReworkInstruction, openHold, proposeRework, qualityView, releaseHold, releaseTestRecord, reviewTestRecord, upsertIssue } from '../services/quality.js';
import { activitiesFor, outboundReview, readinessSummary, reconciliation } from '../services/read.js';
import { recalculate } from '../services/recalc.js';
import { approveRelease, markArtifactAvailable, recordInstallation, softwareView, upsertRelease } from '../services/software.js';
import { currentSlot } from '../services/common.js';
import { finishLabel, slotToLabel } from '../engine/calendar.js';

const id = (req: Request, key = 'id') => {
  const n = Number(req.params[key]);
  if (!Number.isInteger(n)) throw new HttpError(400, `Invalid ${key}`);
  return n;
};

/** Run a mutation in a transaction holding the plan lock, then recalculate so every user sees the effect. */
async function mutate<T>(user: any, summary: string, fn: (c: any) => Promise<T>) {
  return tx(async (c) => {
    await lockPlan(c);
    const out = await fn(c);
    await syncDerivedGates(c);
    const r = await recalculate(c, { userId: user.id, kind: 'READINESS', summary });
    return { ...(typeof out === 'object' && out !== null ? out : { result: out }), version: r.version };
  });
}

export function v4Router() {
  const r = Router();

  // Readiness gates
  r.get('/readiness', async (req, res) => {
    const now = await currentSlot(pool);
    const pid = req.query.projectId ? Number(req.query.projectId) : null;
    const g = await pool.query(`SELECT g.*, p.code project, a.name activity, a.code activity_code, a.forecast_start, a.status activity_status, COALESCE(u.name, u.internal_id) unit, s.code system_code, sh.code shipment_code, v.code visit_code,
        cu.name confirmed_by_name
      FROM readiness_gates g LEFT JOIN projects p ON p.id = g.project_id LEFT JOIN activities a ON a.id = g.activity_id LEFT JOIN units u ON u.id = g.unit_id
      LEFT JOIN systems s ON s.id = g.system_id LEFT JOIN shipments sh ON sh.id = g.shipment_id LEFT JOIN commissioning_visits v ON v.id = g.visit_id LEFT JOIN users cu ON cu.id = g.last_confirmed_by
      WHERE p.status = 'ACTIVE' AND a.status NOT IN ('COMPLETED','CANCELLED') AND ($1::int IS NULL OR g.project_id = $1)
      ORDER BY g.status = 'READY', g.awaiting_plan, a.forecast_start NULLS LAST, g.id`, [pid]);
    res.json({ now, summary: Object.fromEntries(await readinessSummary(pool, now)), gates: g.rows.map((x) => ({ ...x, neededFromLabel: slotToLabel(x.forecast_start), forecastLabel: finishLabel(x.forecast_slot) })) });
  });
  r.post('/gates', async (req, res) => {
    const body = z.object({ activityId: z.number().int(), dimension: z.enum(['CONFIGURATION', 'MATERIAL', 'SOFTWARE', 'RESOURCE', 'QUALITY', 'EXTERNAL']), title: z.string().min(3), blocks: z.enum(['START', 'COMPLETE']).optional(),
      status: z.enum(['UNKNOWN', 'PENDING', 'READY', 'BLOCKED']).optional(), forecastSlot: z.number().int().nullable().optional(), ownerRole: z.string().optional(), ownerName: z.string().optional(), notes: z.string().optional() }).parse(req.body);
    res.status(201).json(await mutate(req.user, `${req.user.name} added a readiness gate`, (c) => createManualGate(c, req.user, body)));
  });
  r.patch('/gates/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['UNKNOWN', 'PENDING', 'READY', 'BLOCKED']).optional(), forecastSlot: z.number().int().nullable().optional(), evidenceRef: z.string().nullable().optional(),
      ownerName: z.string().nullable().optional(), notes: z.string().nullable().optional(), confirm: z.boolean().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated readiness`, (c) => updateGate(c, req.user, id(req), body)));
  });
  r.post('/gates/:id/conditional-release', async (req, res) => {
    const body = z.object({ scope: z.string().default(''), conditions: z.string().default(''), expirySlot: z.number().int().nullable().optional(), revoke: z.boolean().optional() }).parse(req.body);
    if (!body.revoke && (body.scope.length < 3 || body.conditions.length < 3)) throw new HttpError(422, 'A conditional release needs its scope and conditions');
    res.json(await mutate(req.user, `${req.user.name} ${body.revoke ? 'revoked' : 'approved'} a conditional release`, (c) => conditionalRelease(c, req.user, id(req), body)));
  });

  // Materials
  r.get('/materials', async (_req, res) => res.json(await materialsView(pool)));
  r.post('/materials', async (req, res) => {
    const body = z.object({ partNumber: z.string().min(2), description: z.string().min(2), critical: z.boolean().optional() }).parse(req.body);
    await requirePermission(pool, req.user, 'material.confirm');
    const m = await pool.query('INSERT INTO materials (part_number, description, critical) VALUES ($1,$2,$3) RETURNING *', [body.partNumber, body.description, body.critical ?? true]);
    res.status(201).json(m.rows[0]);
  });
  r.post('/materials/requirements', async (req, res) => {
    const body = z.object({ materialId: z.number().int(), qty: z.number().positive(), unitId: z.number().int().nullable().optional(), systemId: z.number().int().nullable().optional(),
      neededAtCode: z.string().nullable().optional(), activityId: z.number().int().nullable().optional(), reason: z.string().optional() }).parse(req.body);
    res.status(201).json(await mutate(req.user, `${req.user.name} added a material requirement`, (c) => addRequirement(c, req.user, body)));
  });
  r.post('/materials/stock', async (req, res) => {
    const body = z.object({ materialId: z.number().int(), location: z.string().min(1), qtyOnHand: z.number().min(0), asOf: z.string().optional(), reason: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated stock`, (c) => upsertStock(c, req.user, body)));
  });
  r.post('/materials/receipts', async (req, res) => {
    const body = z.object({ id: z.number().int().optional(), materialId: z.number().int(), qty: z.number().positive(), expectedDate: z.string().nullable().optional(), dateConfirmed: z.boolean().optional(), poRef: z.string().optional(), location: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated an expected receipt`, (c) => upsertReceipt(c, req.user, body)));
  });
  r.post('/materials/receipts/:id/receive', async (req, res) => {
    const body = z.object({ accepted: z.boolean(), location: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} recorded a goods receipt`, (c) => receiveReceipt(c, req.user, id(req), body)));
  });

  // Software releases
  r.get('/software', async (_req, res) => res.json(await softwareView(pool)));
  r.post('/software/releases', async (req, res) => {
    const body = z.object({ id: z.number().int().optional(), componentId: z.number().int(), version: z.string().min(1), stage: z.enum(['CANDIDATE', 'IN_VALIDATION', 'REJECTED', 'SUPERSEDED']).optional(),
      expectedAvailableDate: z.string().nullable().optional(), artifactRef: z.string().nullable().optional(), knownIssues: z.array(z.string()).optional(), notes: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated a software release`, (c) => upsertRelease(c, req.user, body)));
  });
  r.post('/software/releases/:id/approve', async (req, res) => {
    const body = z.object({ scope: z.enum(['EVALUATION_UNITS', 'SPECIFIC_UNITS', 'PRODUCTION', 'FIELD']), unitIds: z.array(z.number().int()).optional(), basisRef: z.string(), validUntil: z.string().nullable().optional(), makeProductionTarget: z.boolean().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} approved a software release`, (c) => approveRelease(c, req.user, id(req), body)));
  });
  r.post('/software/releases/:id/artifact', async (req, res) => {
    const body = z.object({ artifactRef: z.string() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} published a release artifact`, (c) => markArtifactAvailable(c, req.user, id(req), body)));
  });
  r.post('/software/install', async (req, res) => {
    const body = z.object({ releaseId: z.number().int(), unitIds: z.array(z.number().int()).min(1), checksPassed: z.boolean(), note: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} recorded a software installation`, (c) => recordInstallation(c, req.user, body)));
  });

  // Quality, tests, issues, rework
  r.get('/quality', async (req, res) => res.json(await qualityView(pool, req.query.projectId ? Number(req.query.projectId) : undefined)));
  r.post('/tests/:id/release', async (req, res) => res.json(await mutate(req.user, `${req.user.name} released a test result`, (c) => releaseTestRecord(c, req.user, id(req), req.body?.note))));
  r.post('/tests/:id/review', async (req, res) => {
    const body = z.object({ decision: z.enum(['STILL_VALID', 'REPEAT']), note: z.string() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} reviewed a test result`, (c) => reviewTestRecord(c, req.user, id(req), body)));
  });
  r.post('/test-plans/:id/decision', async (req, res) => {
    const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().min(3) }).parse(req.body);
    const out = await tx(async (c) => {
      await requirePermission(c, req.user, 'test_scope.approve', 'Approving a test scope requires the designated technical authority');
      const tp = (await c.query('SELECT * FROM test_plans WHERE id = $1 FOR UPDATE', [id(req)])).rows[0];
      if (!tp || !['DRAFT', 'PROPOSED'].includes(tp.status)) throw new HttpError(409, 'Only draft/proposed test plans can be decided');
      await c.query('UPDATE test_plans SET status = $2, approved_by = $3, approved_at = now(), rationale = rationale || $4 WHERE id = $1', [tp.id, body.decision, req.user.id, ` — ${body.decision}: ${body.note}`]);
      await audit(c, { userId: req.user.id, action: `test_scope.${body.decision.toLowerCase()}`, changeClass: 'QUALITY', entityType: 'test_plan', entityId: tp.id, reason: body.note });
      return { ok: true };
    });
    res.json(out);
  });
  r.post('/holds', async (req, res) => {
    const body = z.object({ unitId: z.number().int(), disposition: z.enum(['BLOCKED', 'REWORK_REQUIRED', 'DEV_ONLY']), reason: z.string().min(3), issueId: z.number().int().nullable().optional() }).parse(req.body);
    res.status(201).json(await mutate(req.user, `${req.user.name} opened a quality hold`, (c) => openHold(c, req.user, body)));
  });
  r.post('/holds/:id/release', async (req, res) => res.json(await mutate(req.user, `${req.user.name} released a quality hold`, (c) => releaseHold(c, req.user, id(req), String(req.body?.note ?? '')))));
  r.post('/issues', async (req, res) => {
    const body = z.object({ externalRef: z.string().nullable().optional(), title: z.string().min(3), symptom: z.string().optional(), rootCause: z.string().nullable().optional(), owner: z.string().optional(), projectId: z.number().int().nullable().optional(), unitIds: z.array(z.number().int()).optional() }).parse(req.body);
    res.status(201).json({ id: await tx((c) => upsertIssue(c, req.user, body)) });
  });
  r.put('/issues/:id', async (req, res) => {
    const body = z.object({ externalRef: z.string().nullable().optional(), title: z.string().min(3), symptom: z.string().optional(), rootCause: z.string().nullable().optional(), status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED']).optional(), owner: z.string().optional(), unitIds: z.array(z.number().int()).optional() }).parse(req.body);
    res.json({ id: await tx((c) => upsertIssue(c, req.user, { ...body, id: id(req) })) });
  });
  r.post('/rework', async (req, res) => {
    const body = z.object({ unitId: z.number().int(), issueId: z.number().int().nullable().optional(), scope: z.string().min(3), instructionRef: z.string().nullable().optional(), stationCode: z.string().optional(),
      prepSlots: z.number().int().min(0).optional(), handsOnSlots: z.number().int().min(1).optional(), retest: z.enum(['NONE', 'EOL', 'VALIDATION']).optional(), parts: z.array(z.object({ materialId: z.number().int(), qty: z.number().positive() })).optional(), owner: z.string().optional() }).parse(req.body);
    res.status(201).json({ id: await tx((c) => proposeRework(c, req.user, body)) });
  });
  r.post('/rework/:id/approve-instruction', async (req, res) => res.json(await mutate(req.user, `${req.user.name} approved a rework instruction`, (c) => approveReworkInstruction(c, req.user, id(req), String(req.body?.ref ?? '')))));

  // Units
  r.get('/units/:id', async (req, res) => {
    const u = (await pool.query(`SELECT u.*, pt.code product_code, pt.name product_name, p.code project, s.code system_code, sh.code shipment_code FROM units u JOIN product_types pt ON pt.id = u.product_type_id
      LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN systems s ON s.id = u.system_id LEFT JOIN shipments sh ON sh.id = u.shipment_id WHERE u.id = $1`, [id(req)])).rows[0];
    if (!u) throw new HttpError(404, 'Unit not found');
    const history = (await pool.query(`SELECT h.*, us.name user_name FROM unit_history h LEFT JOIN users us ON us.id = h.user_id WHERE h.unit_id = $1 ORDER BY h.created_at`, [u.id])).rows;
    const software = (await pool.query(`SELECT us.*, r.version, c.name component, a.scope approval_scope, a.basis_ref FROM unit_software us JOIN sw_releases r ON r.id = us.release_id JOIN sw_components c ON c.id = r.component_id
      LEFT JOIN sw_release_approvals a ON a.id = us.approval_id WHERE us.unit_id = $1 ORDER BY us.installed_at`, [u.id])).rows;
    const tests = (await pool.query(`SELECT t.*, tp.code plan_code, tp.version plan_version, a.name activity FROM test_records t LEFT JOIN test_plans tp ON tp.id = t.test_plan_id
      LEFT JOIN activities a ON a.id = t.activity_id WHERE t.unit_id = $1 OR (t.system_id = $2 AND t.unit_id IS NULL) ORDER BY t.executed_at`, [u.id, u.system_id])).rows;
    const issues = (await pool.query(`SELECT i.* FROM issues i JOIN issue_units iu ON iu.issue_id = i.id WHERE iu.unit_id = $1`, [u.id])).rows;
    const holds = (await pool.query(`SELECT * FROM quality_holds WHERE unit_id = $1 ORDER BY created_at`, [u.id])).rows;
    const acts = await activitiesFor(pool, 'AND a.unit_id = $1', [u.id]);
    res.json({ unit: u, history, software, tests, issues, holds, activities: acts });
  });
  r.patch('/units/:id', async (req, res) => {
    const body = z.object({ serial: z.string().nullable().optional(), location: z.string().nullable().optional(), hwRevision: z.string().nullable().optional(), notes: z.string().nullable().optional(), evaluation: z.boolean().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated unit identity`, (c) => updateUnit(c, req.user, id(req), body)));
  });

  // Logistics and site readiness
  r.get('/outbound', async (req, res) => res.json(await outboundReview(pool, req.query.days ? Number(req.query.days) : 21)));
  r.patch('/shipments/:id', async (req, res) => {
    const body = z.object({ coordinator: z.string().nullable().optional(), bookingDeadline: z.string().nullable().optional(), collectionAt: z.string().nullable().optional(),
      receivingWindowStart: z.string().nullable().optional(), receivingWindowEnd: z.string().nullable().optional(), dims: z.any().optional(), transportBooked: z.boolean().optional(),
      bookingRef: z.string().nullable().optional(), destination: z.string().nullable().optional(), notes: z.string().nullable().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated shipment logistics`, (c) => updateShipment(c, req.user, id(req), body)));
  });
  r.put('/shipments/:id/documents', async (req, res) => {
    const body = z.object({ docType: z.string().min(2), status: z.enum(['MISSING', 'IN_PROGRESS', 'READY', 'NOT_REQUIRED']), owner: z.string().nullable().optional(), ref: z.string().nullable().optional(), expectedDate: z.string().nullable().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated shipping documents`, (c) => upsertDocument(c, req.user, id(req), body)));
  });
  r.patch('/visits/:id', async (req, res) => {
    const body = z.object({ site: z.string().optional(), installationResponsibility: z.string().optional(), installationDays: z.number().int().min(0).max(60).optional(), executionLeadName: z.string().nullable().optional(),
      personnelConfirmed: z.boolean().optional(), personnelEvidence: z.string().optional(), siteWorkResponsible: z.string().nullable().optional(), siteWorkResponsibleConfirmed: z.boolean().optional(),
      siteAccessConfirmed: z.boolean().optional(), rdLed: z.boolean().optional(), approveDelegation: z.boolean().optional(), specialists: z.string().optional(), roles: z.any().optional(), notes: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated site readiness`, (c) => updateVisit(c, req.user, id(req), body)));
  });

  // Configuration versions and reconciliation
  r.get('/projects/:id/reconciliation', async (req, res) => res.json(await reconciliation(pool, id(req))));
  r.post('/projects/:id/configurations', async (req, res) => {
    const comp = z.array(z.object({ productTypeId: z.number().int(), quantity: z.number().int().min(0) }));
    const body = z.object({ systems: z.array(z.object({ code: z.string(), name: z.string().optional(), composition: comp })), loose: comp.optional(), scopeText: z.string().optional(),
      source: z.string().optional(), sourceRef: z.string().optional(), asOf: z.string().nullable().optional(), notes: z.string().optional() }).parse(req.body);
    res.status(201).json(await tx((c) => createConfigurationVersion(c, req.user, id(req), body)));
  });
  r.post('/configurations/:id/decision', async (req, res) => {
    const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().optional() }).parse(req.body);
    await tx((c) => decideConfiguration(c, req.user, id(req), body.decision, body.note));
    res.json({ ok: true });
  });
  r.get('/actions', async (_req, res) => res.json((await pool.query(`SELECT a.*, p.code project FROM action_items a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.status = 'OPEN' DESC, a.created_at DESC LIMIT 300`)).rows));
  r.patch('/actions/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['ACKNOWLEDGED', 'DONE', 'CANCELLED']), note: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated an action`, (c) => updateAction(c, req.user, id(req), body)));
  });

  // Capacity timeline: proposed → approved → implemented → verified
  r.post('/capacity-changes', async (req, res) => {
    const body = z.object({ workCenterId: z.number().int(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capacity: z.number().positive(), reason: z.string().min(3) }).parse(req.body);
    const out = await tx(async (c) => {
      const r2 = await c.query(`INSERT INTO resource_capacity_changes (work_center_id, effective_from, capacity, status, reason, created_by) VALUES ($1,$2,$3,'PROPOSED',$4,$5) RETURNING id`,
        [body.workCenterId, body.effectiveFrom, body.capacity, body.reason, req.user.id]);
      await audit(c, { userId: req.user.id, action: 'capacity.propose', changeClass: 'CONFIG', entityType: 'capacity_change', entityId: r2.rows[0].id, after: body, reason: body.reason });
      return { id: r2.rows[0].id };
    });
    res.status(201).json(out);
  });
  r.patch('/capacity-changes/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['APPROVED', 'IMPLEMENTED', 'VERIFIED', 'REJECTED']), note: z.string().min(3) }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} set a capacity change to ${body.status.toLowerCase()}`, async (c) => {
      await requirePermission(c, req.user, 'scenario.op.capacity');
      const ch = (await c.query('SELECT * FROM resource_capacity_changes WHERE id = $1 FOR UPDATE', [id(req)])).rows[0];
      if (!ch) throw new HttpError(404, 'Capacity change not found');
      const order = ['PROPOSED', 'APPROVED', 'IMPLEMENTED', 'VERIFIED'];
      if (body.status !== 'REJECTED' && order.indexOf(body.status) !== order.indexOf(ch.status) + 1) throw new HttpError(409, `A ${ch.status.toLowerCase()} change cannot become ${body.status.toLowerCase()}`);
      await c.query(`UPDATE resource_capacity_changes SET status = $2, approved_by = CASE WHEN $2 = 'APPROVED' THEN $3 ELSE approved_by END,
        implemented_at = CASE WHEN $2 = 'IMPLEMENTED' THEN now() ELSE implemented_at END, verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE verified_at END WHERE id = $1`, [ch.id, body.status, req.user.id]);
      if (body.status === 'IMPLEMENTED') await bumpInputs(c, 'ALL');
      await audit(c, { userId: req.user.id, action: `capacity.${body.status.toLowerCase()}`, changeClass: 'CONFIG', entityType: 'capacity_change', entityId: ch.id, before: ch, after: body, reason: body.note });
      return { ok: true };
    }));
  });
  r.patch('/reservations/:id', async (req, res) => {
    const body = z.object({ status: z.enum(['ACTIVE', 'RELEASED', 'CANCELLED']), note: z.string().optional() }).parse(req.body);
    res.json(await mutate(req.user, `${req.user.name} updated a resource reservation`, async (c) => {
      const rv = (await c.query('SELECT * FROM resource_reservations WHERE id = $1', [id(req)])).rows[0];
      if (!rv) throw new HttpError(404, 'Reservation not found');
      if (rv.created_by !== req.user.id) await requirePermission(c, req.user, 'scenario.op.capacity');
      const now = await currentSlot(c);
      await c.query(`UPDATE resource_reservations SET status = $2, finish_slot = CASE WHEN $2 = 'RELEASED' AND finish_slot > $3 THEN GREATEST(start_slot + 1, $3) ELSE finish_slot END WHERE id = $1`, [rv.id, body.status, now]);
      await bumpInputs(c, 'ALL');
      await audit(c, { userId: req.user.id, action: `reservation.${body.status.toLowerCase()}`, changeClass: 'CONFIG', entityType: 'reservation', entityId: rv.id, reason: body.note ?? null });
      return { ok: true };
    }));
  });
  return r;
}
