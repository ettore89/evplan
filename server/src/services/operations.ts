/** Logistics, site readiness, configuration versions, unit identity and action items. */
import type pg from 'pg';
import { audit, bumpInputs, can, HttpError, requirePermission, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';

export async function updateShipment(c: pg.PoolClient, user: AuthUser, id: number, body: {
  coordinator?: string | null; bookingDeadline?: string | null; collectionAt?: string | null; receivingWindowStart?: string | null; receivingWindowEnd?: string | null;
  dims?: unknown; transportBooked?: boolean; bookingRef?: string | null; destination?: string | null; notes?: string | null;
}) {
  await requirePermission(c, user, 'logistics.manage', 'Shipment logistics data is maintained by Logistics');
  const s = (await c.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!s) throw new HttpError(404, 'Shipment not found');
  if (body.transportBooked && !(body.bookingRef ?? s.booking_ref)) throw new HttpError(422, 'A booking reference is required to mark transport as booked', 'EVIDENCE_REQUIRED');
  let deadline = body.bookingDeadline;
  if (deadline === undefined && body.collectionAt && !s.booking_deadline) {
    const lead = (await c.query('SELECT booking_lead_days FROM service_profiles WHERE id = $1', [s.service_profile_id])).rows[0]?.booking_lead_days ?? 3;
    deadline = new Date(new Date(body.collectionAt).getTime() - lead * 86400000).toISOString();
  }
  await c.query(`UPDATE shipments SET coordinator = COALESCE($2, coordinator), booking_deadline = CASE WHEN $3 THEN $4::timestamptz ELSE booking_deadline END,
    collection_at = CASE WHEN $5 THEN $6::timestamptz ELSE collection_at END, receiving_window_start = COALESCE($7, receiving_window_start), receiving_window_end = COALESCE($8, receiving_window_end),
    dims = COALESCE($9, dims), transport_booked = COALESCE($10, transport_booked), booking_ref = COALESCE($11, booking_ref), destination = COALESCE($12, destination), notes = COALESCE($13, notes) WHERE id = $1`,
  [id, body.coordinator ?? null, deadline !== undefined, deadline ?? null, body.collectionAt !== undefined, body.collectionAt ?? null, body.receivingWindowStart ?? null, body.receivingWindowEnd ?? null,
    body.dims ? JSON.stringify(body.dims) : null, body.transportBooked ?? null, body.bookingRef ?? null, body.destination ?? null, body.notes ?? null]);
  // A precise collection cut-off is kept as a timestamp on the hand-over activities (no half-day rounding).
  if (body.collectionAt !== undefined) await c.query(`UPDATE activities SET deadline_at = $2 WHERE shipment_id = $1 AND code = 'OUT_PREP'`, [id, body.collectionAt]);
  await syncDerivedGates(c, [s.project_id]);
  await bumpInputs(c, [s.project_id]);
  await audit(c, { userId: user.id, action: 'shipment.update', changeClass: 'LOGISTICS', entityType: 'shipment', entityId: id, projectId: s.project_id, before: s, after: body });
}

export async function upsertDocument(c: pg.PoolClient, user: AuthUser, shipmentId: number, body: { docType: string; status: 'MISSING' | 'IN_PROGRESS' | 'READY' | 'NOT_REQUIRED'; owner?: string | null; ref?: string | null; expectedDate?: string | null }) {
  await requirePermission(c, user, 'logistics.manage');
  const s = (await c.query('SELECT * FROM shipments WHERE id = $1', [shipmentId])).rows[0];
  if (!s) throw new HttpError(404, 'Shipment not found');
  if (body.status === 'READY' && !body.ref) throw new HttpError(422, 'Reference the document (number / location) to mark it ready', 'EVIDENCE_REQUIRED');
  await c.query(`INSERT INTO shipment_documents (shipment_id, doc_type, status, owner, ref, expected_date, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (shipment_id, doc_type) DO UPDATE SET status = EXCLUDED.status, owner = COALESCE(EXCLUDED.owner, shipment_documents.owner), ref = COALESCE(EXCLUDED.ref, shipment_documents.ref),
    expected_date = EXCLUDED.expected_date, updated_by = EXCLUDED.updated_by, updated_at = now()`, [shipmentId, body.docType, body.status, body.owner ?? null, body.ref ?? null, body.expectedDate ?? null, user.id]);
  await syncDerivedGates(c, [s.project_id]);
  await bumpInputs(c, [s.project_id]);
  await audit(c, { userId: user.id, action: 'shipment.document', changeClass: 'LOGISTICS', entityType: 'shipment', entityId: shipmentId, projectId: s.project_id, after: body });
}

export async function updateVisit(c: pg.PoolClient, user: AuthUser, id: number, body: {
  site?: string; installationResponsibility?: string; installationDays?: number; executionLeadName?: string | null; personnelConfirmed?: boolean; personnelEvidence?: string;
  siteWorkResponsible?: string | null; siteWorkResponsibleConfirmed?: boolean; siteAccessConfirmed?: boolean; rdLed?: boolean; approveDelegation?: boolean; specialists?: string; roles?: unknown; notes?: string;
}) {
  const v = (await c.query('SELECT * FROM commissioning_visits WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!v) throw new HttpError(404, 'Visit not found');
  if (!(await can(c, user, 'site.manage'))) throw new HttpError(403, 'Site readiness is maintained by Service');
  if (body.approveDelegation && user.role !== 'MANAGEMENT') throw new HttpError(403, 'Only Management / Program approves a project-specific delegation');
  if ((body.personnelConfirmed || body.siteWorkResponsibleConfirmed) && !body.personnelEvidence && !body.notes) {
    // Qualification and authorization are confirmed with evidence, never inferred from a job title.
    throw new HttpError(422, 'Reference the evidence for the confirmation (authorization / qualification record)', 'EVIDENCE_REQUIRED');
  }
  await c.query(`UPDATE commissioning_visits SET site = COALESCE($2, site), installation_responsibility = COALESCE($3, installation_responsibility), installation_days = COALESCE($4, installation_days),
    execution_lead_name = COALESCE($5, execution_lead_name), personnel_confirmed = COALESCE($6, personnel_confirmed), site_work_responsible = COALESCE($7, site_work_responsible),
    site_work_responsible_confirmed = COALESCE($8, site_work_responsible_confirmed), site_access_confirmed = COALESCE($9, site_access_confirmed), rd_led = COALESCE($10, rd_led),
    delegation_approved_by = CASE WHEN $11 THEN $12 ELSE delegation_approved_by END, specialists = COALESCE($13, specialists), roles = COALESCE($14, roles), notes = COALESCE($15, notes) WHERE id = $1`,
  [id, body.site ?? null, body.installationResponsibility ?? null, body.installationDays ?? null, body.executionLeadName ?? null, body.personnelConfirmed ?? null, body.siteWorkResponsible ?? null,
    body.siteWorkResponsibleConfirmed ?? null, body.siteAccessConfirmed ?? null, body.rdLed ?? null, !!body.approveDelegation, user.id, body.specialists ?? null, body.roles ? JSON.stringify(body.roles) : null, body.notes ?? null]);
  if (body.installationDays) await c.query(`UPDATE activities SET duration_slots = $2, phases = NULL WHERE visit_id = $1 AND code = 'INSTALL' AND status IN ('NOT_STARTED','READY')`, [id, body.installationDays * 2]);
  await syncDerivedGates(c, [v.project_id]);
  await bumpInputs(c, [v.project_id]);
  await audit(c, { userId: user.id, action: 'visit.update', changeClass: 'READINESS', entityType: 'commissioning_visit', entityId: id, projectId: v.project_id, before: v, after: body, reason: body.personnelEvidence ?? body.notes ?? null });
}

export async function createConfigurationVersion(c: pg.PoolClient, user: AuthUser, projectId: number, body: {
  systems: { code: string; name?: string; composition: { productTypeId: number; quantity: number }[] }[]; loose?: { productTypeId: number; quantity: number }[];
  scopeText?: string; source?: string; sourceRef?: string; asOf?: string | null; notes?: string;
}) {
  await requirePermission(c, user, 'scenario.op.configuration', 'Configuration changes are proposed by Commercial or Program');
  const p = (await c.query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  const last = (await c.query(`SELECT * FROM project_configurations WHERE project_id = $1 ORDER BY version DESC LIMIT 1`, [projectId])).rows[0];
  if (body.asOf && last?.as_of && new Date(body.asOf) < last.as_of) throw new HttpError(409, 'A newer configuration record already exists; older information cannot replace it', 'STALE_UPDATE');
  const v = (last?.version ?? 0) + 1;
  const r = await c.query(`INSERT INTO project_configurations (project_id, version, status, source, source_ref, as_of, scope_text, systems, loose, notes, created_by)
    VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [projectId, v, body.source ?? 'MANUAL', body.sourceRef ?? null, body.asOf ?? null, body.scopeText ?? null, JSON.stringify(body.systems), JSON.stringify(body.loose ?? []), body.notes ?? null, user.id]);
  await audit(c, { userId: user.id, action: 'configuration.draft', changeClass: 'COMMERCIAL', entityType: 'configuration', entityId: r.rows[0].id, projectId, after: body });
  return { id: r.rows[0].id, version: v };
}

export async function decideConfiguration(c: pg.PoolClient, user: AuthUser, id: number, decision: 'APPROVED' | 'REJECTED', note?: string) {
  await requirePermission(c, user, 'configuration.approve', 'Approving a configuration requires the configuration.approve authority');
  const cfg = (await c.query('SELECT * FROM project_configurations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cfg || cfg.status !== 'DRAFT') throw new HttpError(409, 'Only draft configurations can be decided');
  await c.query('UPDATE project_configurations SET status = $2, approved_by = $3, approved_at = now(), notes = COALESCE(notes, \'\') || $4 WHERE id = $1', [id, decision, user.id, note ? `\n${decision}: ${note}` : '']);
  await audit(c, { userId: user.id, action: `configuration.${decision.toLowerCase()}`, changeClass: 'COMMERCIAL', entityType: 'configuration', entityId: id, projectId: cfg.project_id, reason: note ?? null });
}

export async function updateUnit(c: pg.PoolClient, user: AuthUser, id: number, body: { serial?: string | null; location?: string | null; hwRevision?: string | null; notes?: string | null; evaluation?: boolean }) {
  const u = (await c.query('SELECT * FROM units WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!u) throw new HttpError(404, 'Unit not found');
  if (!['MANUFACTURING', 'TESTING', 'LOGISTICS', 'MANAGEMENT'].includes(user.role)) throw new HttpError(403, 'Unit identity is maintained by Manufacturing, Testing, Logistics or Program');
  if (body.serial) {
    const dup = (await c.query('SELECT internal_id FROM units WHERE serial = $1 AND id <> $2', [body.serial, id])).rows[0];
    if (dup) throw new HttpError(409, `Serial ${body.serial} is already used by ${dup.internal_id}`, 'DUPLICATE');
  }
  await c.query('UPDATE units SET serial = COALESCE($2, serial), location = COALESCE($3, location), hw_revision = COALESCE($4, hw_revision), notes = COALESCE($5, notes), evaluation_unit = COALESCE($6, evaluation_unit) WHERE id = $1',
    [id, body.serial ?? null, body.location ?? null, body.hwRevision ?? null, body.notes ?? null, body.evaluation ?? null]);
  for (const [k, ev] of [['serial', 'SERIAL'], ['location', 'LOCATION'], ['hwRevision', 'HW_REVISION']] as const) {
    if (body[k] !== undefined && body[k] !== (k === 'hwRevision' ? u.hw_revision : u[k])) {
      await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, user_id) VALUES ($1,$2,$3,$4,$5)`, [id, ev, JSON.stringify(k === 'hwRevision' ? u.hw_revision : u[k]), JSON.stringify(body[k]), user.id]);
    }
  }
  if (body.hwRevision && body.hwRevision !== u.hw_revision) {
    await c.query(`UPDATE test_records SET status = 'REVIEW_REQUIRED', review_reason = $2 WHERE (unit_id = $1 OR system_id = $3) AND status = 'VALID'`, [id, `Hardware revision changed to ${body.hwRevision}`, u.system_id]);
    await syncDerivedGates(c, [u.project_id]);
  }
  await audit(c, { userId: user.id, action: 'unit.update', changeClass: 'EXECUTION', entityType: 'unit', entityId: id, projectId: u.project_id, before: u, after: body });
}

export async function updateAction(c: pg.PoolClient, user: AuthUser, id: number, body: { status: 'ACKNOWLEDGED' | 'DONE' | 'CANCELLED'; note?: string }) {
  const a = (await c.query('SELECT * FROM action_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!a) throw new HttpError(404, 'Action not found');
  if (a.kind === 'LOGISTICS_ACK' && !(await can(c, user, 'logistics.acknowledge'))) throw new HttpError(403, 'Logistics / order-to-cash acknowledges configuration changes');
  if (a.owner_role && a.owner_role !== user.role && user.role !== 'MANAGEMENT' && a.kind !== 'LOGISTICS_ACK') throw new HttpError(403, `Owned by ${a.owner_role}`);
  await c.query('UPDATE action_items SET status = $2, closed_by = $3, closed_at = now(), details = COALESCE(details, \'\') || $4 WHERE id = $1', [id, body.status, user.id, body.note ? `\n${body.status}: ${body.note}` : '']);
  await syncDerivedGates(c, a.project_id ? [a.project_id] : undefined);
  await bumpInputs(c, [a.project_id]);
  await audit(c, { userId: user.id, action: `action.${body.status.toLowerCase()}`, changeClass: 'READINESS', entityType: 'action_item', entityId: id, projectId: a.project_id, reason: body.note ?? null });
}
