/**
 * Lightweight critical-component tracking (not MRP): requirements per unit/system attached to the
 * first operation that needs the part, allocations of accepted stock or expected receipts (never
 * double-allocated), and BOM-correction actions for requirements missing from the engineering BOM.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { audit, bumpInputs, HttpError, requirePermission, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';

async function lockMaterial(c: pg.PoolClient, materialId: number) {
  await c.query('SELECT pg_advisory_xact_lock(777000 + $1)', [materialId]);
}

/** Free quantity of a stock lot or receipt (not yet allocated to any requirement). */
async function freeQty(c: pg.PoolClient, kind: 'stock' | 'receipt', id: number) {
  if (kind === 'stock') {
    const r = await c.query(`SELECT s.qty_on_hand - COALESCE((SELECT SUM(a.qty) FROM material_allocations a JOIN material_requirements q ON q.id = a.requirement_id
      WHERE a.stock_id = s.id AND q.status = 'OPEN'), 0) AS free FROM material_stock s WHERE s.id = $1`, [id]);
    return Number(r.rows[0]?.free ?? 0);
  }
  const r = await c.query(`SELECT r.qty - COALESCE((SELECT SUM(qty) FROM material_allocations a WHERE a.receipt_id = r.id), 0) AS free
    FROM material_receipts r WHERE r.id = $1 AND r.received_at IS NULL`, [id]);
  return Number(r.rows[0]?.free ?? 0);
}

/** Allocate open requirements of a material: accepted stock first, then expected receipts by date; higher-priority projects first. */
export async function allocateMaterial(c: pg.PoolClient, materialId: number) {
  await lockMaterial(c, materialId);
  const reqs = (await c.query(`SELECT q.*, COALESCE(p.priority, 1e9) prio,
      q.qty - COALESCE((SELECT SUM(qty) FROM material_allocations a WHERE a.requirement_id = q.id), 0) AS missing
    FROM material_requirements q LEFT JOIN projects p ON p.id = q.project_id
    WHERE q.material_id = $1 AND q.status = 'OPEN' ORDER BY prio, q.id`, [materialId])).rows.filter((r) => Number(r.missing) > 1e-9);
  const stock = (await c.query('SELECT id FROM material_stock WHERE material_id = $1 ORDER BY id', [materialId])).rows;
  const receipts = (await c.query(`SELECT id FROM material_receipts WHERE material_id = $1 AND received_at IS NULL ORDER BY expected_date NULLS LAST, id`, [materialId])).rows;
  for (const r of reqs) {
    let missing = Number(r.missing);
    for (const [kind, rows] of [['stock', stock], ['receipt', receipts]] as const) {
      for (const s of rows) {
        if (missing <= 1e-9) break;
        const free = await freeQty(c, kind, s.id);
        if (free <= 1e-9) continue;
        const q = Math.min(free, missing);
        await c.query(`INSERT INTO material_allocations (requirement_id, ${kind === 'stock' ? 'stock_id' : 'receipt_id'}, qty) VALUES ($1,$2,$3)`, [r.id, s.id, q]);
        missing -= q;
      }
    }
  }
}

export async function addRequirement(c: pg.PoolClient, user: AuthUser, body: {
  materialId: number; qty: number; unitId?: number | null; systemId?: number | null; neededAtCode?: string | null; activityId?: number | null; reason?: string;
}) {
  await requirePermission(c, user, 'material.confirm', 'Adding material requirements requires the material.confirm authority');
  const unit = body.unitId ? (await c.query('SELECT * FROM units WHERE id = $1', [body.unitId])).rows[0] : null;
  const projectId = unit?.project_id ?? (body.systemId ? (await c.query('SELECT project_id FROM systems WHERE id = $1', [body.systemId])).rows[0]?.project_id : null);
  let activityId = body.activityId ?? null;
  if (!activityId && body.neededAtCode) {
    const a = (await c.query(`SELECT id FROM activities WHERE ${body.unitId ? 'unit_id' : 'system_id'} = $1 AND code = $2 AND status <> 'CANCELLED' ORDER BY seq LIMIT 1`,
      [body.unitId ?? body.systemId, body.neededAtCode])).rows[0];
    activityId = a?.id ?? null;
  }
  if (!activityId) throw new HttpError(422, 'Identify the first operation that needs the part (neededAtCode or activityId)');
  const act = (await c.query('SELECT * FROM activities WHERE id = $1', [activityId])).rows[0];
  if (act.status === 'COMPLETED') throw new HttpError(409, `"${act.name}" is already completed`);
  const product = unit ? unit.product_type_id : null;
  const inBom = product ? (await c.query('SELECT 1 FROM bom_items WHERE product_type_id = $1 AND material_id = $2', [product, body.materialId])).rows.length > 0 : false;
  const mat = (await c.query('SELECT * FROM materials WHERE id = $1', [body.materialId])).rows[0];
  if (!mat) throw new HttpError(404, 'Material not found');
  const r = await c.query(`INSERT INTO material_requirements (project_id, unit_id, system_id, material_id, qty, needed_at_activity_id, source, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [projectId, body.unitId ?? null, body.systemId ?? act.system_id ?? null, body.materialId, body.qty, activityId, inBom ? 'BOM' : 'MANUAL', user.id]);
  const reqId = r.rows[0].id;
  let actionId: number | null = null;
  if (!inBom) {
    // The engineering master is not modified silently: a correction action is raised instead.
    const pt = product ? (await c.query('SELECT code FROM product_types WHERE id = $1', [product])).rows[0]?.code : null;
    actionId = (await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, related, created_by)
      VALUES ('BOM_CORRECTION', $1, $2, $3, 'RND', $4, $5) RETURNING id`,
    [`Add ${mat.part_number} (${mat.description}) to the ${pt ?? 'product'} BOM`, body.reason ?? 'Requirement identified outside the current BOM',
      projectId, JSON.stringify({ requirementId: reqId, materialId: mat.id, productTypeId: product, qtyPerUnit: body.qty, neededAt: act.code }), user.id])).rows[0].id;
    await c.query('UPDATE material_requirements SET bom_correction_action_id = $2 WHERE id = $1', [reqId, actionId]);
  }
  const gate = await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, system_id, dimension, title, status, blocks, owner_role, source_type, source_id, notes, created_by)
    VALUES ($1,$2,$3,$4,'MATERIAL',$5,'UNKNOWN','START','MANUFACTURING','MATERIAL',$6,$7,$8) RETURNING id`,
  [projectId, activityId, body.unitId ?? null, act.system_id, `${mat.description} (${mat.part_number}) × ${body.qty}`, reqId, body.reason ?? null, user.id]);
  await allocateMaterial(c, body.materialId);
  await syncDerivedGates(c, projectId ? [projectId] : undefined);
  await bumpInputs(c, [projectId]);
  await audit(c, { userId: user.id, action: inBom ? 'material.requirement' : 'material.requirement.manual', changeClass: 'MATERIAL', entityType: 'material_requirement',
    entityId: reqId, projectId, after: { ...body, bomCorrectionAction: actionId, gateId: gate.rows[0].id }, reason: body.reason ?? null });
  return { requirementId: reqId, gateId: gate.rows[0].id, bomCorrectionActionId: actionId, outsideBom: !inBom };
}

export async function upsertStock(c: pg.PoolClient, user: AuthUser, body: { materialId: number; location: string; qtyOnHand: number; asOf?: string; reason?: string }) {
  await requirePermission(c, user, 'material.confirm');
  await lockMaterial(c, body.materialId);
  const ex = (await c.query('SELECT * FROM material_stock WHERE material_id = $1 AND location = $2', [body.materialId, body.location])).rows[0];
  if (ex && body.asOf && new Date(body.asOf) < ex.as_of) throw new HttpError(409, `A newer stock figure exists (as of ${ex.as_of.toISOString()})`, 'STALE_UPDATE');
  const allocated = ex ? Number((await c.query(`SELECT COALESCE(SUM(a.qty),0) s FROM material_allocations a JOIN material_requirements q ON q.id = a.requirement_id WHERE a.stock_id = $1 AND q.status = 'OPEN'`, [ex.id])).rows[0].s) : 0;
  if (ex && body.qtyOnHand < allocated) {
    // Shrinking stock below its allocations releases the youngest allocations, which then re-allocate or show a shortage.
    const allocs = (await c.query(`SELECT a.* FROM material_allocations a WHERE a.stock_id = $1 ORDER BY a.id DESC`, [ex.id])).rows;
    let excess = allocated - body.qtyOnHand;
    for (const a of allocs) {
      if (excess <= 1e-9) break;
      const take = Math.min(excess, Number(a.qty));
      if (take >= Number(a.qty) - 1e-9) await c.query('DELETE FROM material_allocations WHERE id = $1', [a.id]);
      else await c.query('UPDATE material_allocations SET qty = qty - $2 WHERE id = $1', [a.id, take]);
      excess -= take;
    }
  }
  if (ex) await c.query('UPDATE material_stock SET qty_on_hand = $2, as_of = COALESCE($3, now()) WHERE id = $1', [ex.id, body.qtyOnHand, body.asOf ?? null]);
  else await c.query('INSERT INTO material_stock (material_id, location, qty_on_hand, as_of) VALUES ($1,$2,$3,COALESCE($4, now()))', [body.materialId, body.location, body.qtyOnHand, body.asOf ?? null]);
  await allocateMaterial(c, body.materialId);
  const changed = await syncDerivedGates(c);
  await audit(c, { userId: user.id, action: 'material.stock', changeClass: 'MATERIAL', entityType: 'material', entityId: body.materialId, before: ex ?? null, after: body, reason: body.reason ?? null });
  return { changedProjects: changed };
}

export async function upsertReceipt(c: pg.PoolClient, user: AuthUser, body: { id?: number; materialId: number; qty: number; expectedDate?: string | null; dateConfirmed?: boolean; poRef?: string; location?: string }) {
  await requirePermission(c, user, 'material.confirm');
  await lockMaterial(c, body.materialId);
  let id = body.id;
  if (id) {
    await c.query('UPDATE material_receipts SET qty=$2, expected_date=$3, date_confirmed=$4, po_ref=COALESCE($5,po_ref), location=COALESCE($6,location), as_of=now() WHERE id=$1',
      [id, body.qty, body.expectedDate ?? null, !!body.dateConfirmed, body.poRef ?? null, body.location ?? null]);
  } else {
    id = (await c.query('INSERT INTO material_receipts (material_id, qty, expected_date, date_confirmed, po_ref, location) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [body.materialId, body.qty, body.expectedDate ?? null, !!body.dateConfirmed, body.poRef ?? null, body.location ?? 'Warehouse'])).rows[0].id;
  }
  await allocateMaterial(c, body.materialId);
  const changed = await syncDerivedGates(c);
  await audit(c, { userId: user.id, action: 'material.receipt', changeClass: 'MATERIAL', entityType: 'material_receipt', entityId: id!, after: body });
  return { id, changedProjects: changed };
}

/** Goods receipt accepted: the receipt becomes stock and its allocations follow it. */
export async function receiveReceipt(c: pg.PoolClient, user: AuthUser, id: number, body: { accepted: boolean; location?: string }) {
  await requirePermission(c, user, 'material.confirm');
  const r = (await c.query('SELECT * FROM material_receipts WHERE id = $1', [id])).rows[0];
  if (!r) throw new HttpError(404, 'Receipt not found');
  if (r.received_at) throw new HttpError(409, 'Already received');
  await lockMaterial(c, r.material_id);
  await c.query('UPDATE material_receipts SET received_at = now(), accepted = $2 WHERE id = $1', [id, body.accepted]);
  if (body.accepted) {
    const loc = body.location ?? r.location ?? 'Warehouse';
    const st = (await c.query(`INSERT INTO material_stock (material_id, location, qty_on_hand) VALUES ($1,$2,$3)
      ON CONFLICT (material_id, location) DO UPDATE SET qty_on_hand = material_stock.qty_on_hand + EXCLUDED.qty_on_hand, as_of = now() RETURNING id`, [r.material_id, loc, r.qty])).rows[0];
    await c.query('UPDATE material_allocations SET receipt_id = NULL, stock_id = $2 WHERE receipt_id = $1', [id, st.id]);
  } else {
    await c.query('DELETE FROM material_allocations WHERE receipt_id = $1', [id]);
  }
  await allocateMaterial(c, r.material_id);
  const changed = await syncDerivedGates(c);
  await audit(c, { userId: user.id, action: body.accepted ? 'material.receipt.accepted' : 'material.receipt.rejected', changeClass: 'MATERIAL', entityType: 'material_receipt', entityId: id, after: body });
  return { changedProjects: changed };
}

/** BOM requirements for a newly created unit (attached to the first operation that needs each part). */
export async function bomRequirementsForUnit(c: pg.PoolClient, unitId: number) {
  const u = (await c.query('SELECT * FROM units WHERE id = $1', [unitId])).rows[0];
  const items = (await c.query('SELECT b.*, m.description, m.part_number FROM bom_items b JOIN materials m ON m.id = b.material_id WHERE b.product_type_id = $1', [u.product_type_id])).rows;
  for (const b of items) {
    const a = (await c.query(`SELECT id, system_id FROM activities WHERE unit_id = $1 AND code = $2 AND status <> 'CANCELLED' ORDER BY seq LIMIT 1`, [unitId, b.needed_at_code])).rows[0];
    if (!a) continue;
    const rq = await c.query(`INSERT INTO material_requirements (project_id, unit_id, material_id, qty, needed_at_activity_id, source) VALUES ($1,$2,$3,$4,$5,'BOM') RETURNING id`,
      [u.project_id, unitId, b.material_id, b.qty_per_unit, a.id]);
    await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, dimension, title, status, blocks, owner_role, source_type, source_id)
      VALUES ($1,$2,$3,'MATERIAL',$4,'UNKNOWN','START','MANUFACTURING','MATERIAL',$5)`, [u.project_id, a.id, unitId, `${b.description} (${b.part_number}) × ${b.qty_per_unit}`, rq.rows[0].id]);
    await allocateMaterial(c, b.material_id);
  }
}

export async function materialsView(db: Db) {
  const mats = (await db.query('SELECT * FROM materials ORDER BY part_number')).rows;
  const out = [];
  for (const m of mats) {
    const stock = (await db.query('SELECT * FROM material_stock WHERE material_id = $1 ORDER BY location', [m.id])).rows;
    const receipts = (await db.query('SELECT * FROM material_receipts WHERE material_id = $1 ORDER BY expected_date NULLS LAST', [m.id])).rows;
    const reqs = (await db.query(`SELECT q.*, p.code project, u.internal_id, u.name unit_name, a.name needed_at, g.status gate_status, g.id gate_id,
        COALESCE((SELECT SUM(qty) FROM material_allocations x WHERE x.requirement_id = q.id AND x.stock_id IS NOT NULL),0) from_stock,
        COALESCE((SELECT SUM(qty) FROM material_allocations x WHERE x.requirement_id = q.id AND x.receipt_id IS NOT NULL),0) from_receipts
      FROM material_requirements q LEFT JOIN projects p ON p.id = q.project_id LEFT JOIN units u ON u.id = q.unit_id LEFT JOIN activities a ON a.id = q.needed_at_activity_id
      LEFT JOIN readiness_gates g ON g.source_type = 'MATERIAL' AND g.source_id = q.id
      WHERE q.material_id = $1 AND q.status = 'OPEN' ORDER BY p.priority NULLS LAST, q.id`, [m.id])).rows;
    const onHand = stock.reduce((s, x) => s + Number(x.qty_on_hand), 0);
    const required = reqs.reduce((s, x) => s + Number(x.qty), 0);
    const incoming = receipts.filter((r) => !r.received_at).reduce((s, x) => s + Number(x.qty), 0);
    out.push({ ...m, onHand, incoming, required, shortage: Math.max(0, required - onHand - incoming), stock, receipts, requirements: reqs });
  }
  return out;
}
