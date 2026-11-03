/**
 * Structural plan changes. Each function changes the persisted plan graph; scenarios call them
 * inside a savepoint to simulate (then roll back) and again on commit, so the committed plan is
 * produced by exactly the code that was simulated.
 */
import type pg from 'pg';
import type { StructuralOp } from '../engine/scenario.js';
import { initialPlan } from '../engine/scheduler.js';
import { HttpError, type AuthUser } from './common.js';
import { createUnit, syncProjectGraph } from './graph.js';
import { addRequirement, bomRequirementsForUnit } from './materials.js';
import { syncDerivedGates } from './gates.js';
import { loadPlanState } from './state.js';

export interface StructuralOutcome { projects: number[]; notes: string[]; warnings: string[] }

interface InsertSpec {
  code: string; name: string; function: string; workCenterId: number | null; slots: number;
  phases?: { name: string; slots: number; resources: { resourceId: number; units: number }[] }[];
  gates?: { dimension: string; title: string; status: string; blocks: string; sourceType?: string; sourceId?: number | null; spec?: unknown; ownerRole?: string; conditionalRelease?: unknown }[];
  reworkId?: number | null;
}

/** Insert activities into a unit's or system's chain right after its last completed activity. */
async function insertIntoChain(c: pg.PoolClient, owner: { unitId?: number; systemId?: number }, specs: InsertSpec[]) {
  const acts = owner.unitId
    ? (await c.query(`SELECT * FROM activities WHERE unit_id = $1 AND scope = 'UNIT' AND status <> 'CANCELLED' ORDER BY stage = 'POST', seq`, [owner.unitId])).rows
    : (await c.query(`SELECT * FROM activities WHERE system_id = $1 AND scope = 'SYSTEM' AND status <> 'CANCELLED' ORDER BY seq`, [owner.systemId])).rows;
  if (!acts.length) throw new HttpError(409, 'No activity chain to insert into');
  const done = acts.filter((a) => a.status === 'COMPLETED' || a.status === 'IN_PROGRESS');
  const after = done.length ? done[done.length - 1] : null;
  const next = acts.find((a) => !done.includes(a));
  const base = after ?? { seq: (next?.seq ?? 10) - 9, stage: next?.stage ?? 'PRE' };
  const limit = next && next.stage === base.stage ? next.seq : base.seq + 10;
  const used = new Set(acts.map((a) => a.seq));
  const tpl = after ?? next!;
  const ids: number[] = [];
  let seq = base.seq;
  for (const s of specs) {
    do { seq++; } while (used.has(seq));
    if (seq >= limit && next && next.stage === base.stage) throw new HttpError(409, 'No room left in the chain for another inserted operation');
    used.add(seq);
    const r = await c.query(
      `INSERT INTO activities (project_id, unit_id, system_id, shipment_id, scope, stage, seq, unit_seq, code, name, function, work_center_id, kind, duration_slots, phases, rework_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'work',$13,$14,$15,'CHANGE') RETURNING id`,
      [tpl.project_id, owner.unitId ?? null, owner.unitId ? tpl.system_id : owner.systemId, tpl.shipment_id, owner.unitId ? 'UNIT' : 'SYSTEM', base.stage, seq, tpl.unit_seq,
        s.code, s.name, s.function, s.workCenterId, s.slots, s.phases ? JSON.stringify(s.phases) : null, s.reworkId ?? null]);
    const id = r.rows[0].id;
    ids.push(id);
    for (const g of s.gates ?? []) {
      await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, system_id, dimension, title, status, blocks, owner_role, source_type, source_id, spec, conditional_release)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tpl.project_id, id, owner.unitId ?? null, owner.unitId ? tpl.system_id : owner.systemId, g.dimension, g.title, g.status, g.blocks, g.ownerRole ?? null,
        g.sourceType ?? 'MANUAL', g.sourceId ?? null, JSON.stringify(g.spec ?? {}), g.conditionalRelease ? JSON.stringify(g.conditionalRelease) : null]);
    }
  }
  return ids;
}

const wcId = async (c: pg.PoolClient, code: string) => (await c.query('SELECT id FROM work_centers WHERE code = $1', [code])).rows[0]?.id as number;

export async function applyStructuralOp(c: pg.PoolClient, user: AuthUser, op: StructuralOp): Promise<StructuralOutcome> {
  switch (op.type) {
    case 'add_rework': return addRework(c, user, op.reworkId);
    case 'reassign_unit': return reassignUnit(c, user, op);
    case 'apply_configuration': return applyConfiguration(c, user, op.configurationId);
    case 'regroup_units': return regroupUnits(c, user, op);
    case 'split_visit': return splitVisit(c, user, op);
    case 'add_update_operation': return addUpdateOperation(c, user, op);
    case 'commit_demand': return commitDemand(c, user, op.projectId);
  }
}

async function addRework(c: pg.PoolClient, user: AuthUser, reworkId: number): Promise<StructuralOutcome> {
  const rw = (await c.query('SELECT * FROM rework_packages WHERE id = $1', [reworkId])).rows[0];
  if (!rw) throw new HttpError(404, 'Rework package not found');
  if (rw.status !== 'PROPOSED') throw new HttpError(409, `Rework is already ${rw.status.toLowerCase()}`);
  const eolPos = await wcId(c, 'EOL_POS'); const eolHv = await wcId(c, 'EOL_HV');
  const specs: InsertSpec[] = [
    { code: 'RW_PREP', name: `Rework preparation (kit, instruction, station) — RW#${rw.id}`, function: 'MANUFACTURING', workCenterId: rw.personnel_resource_id, slots: rw.prep_slots, reworkId: rw.id,
      phases: [{ name: 'Preparation', slots: rw.prep_slots, resources: rw.personnel_resource_id ? [{ resourceId: rw.personnel_resource_id, units: 1 }] : [] }],
      gates: [{ dimension: 'QUALITY', title: `Approved rework instruction${rw.instruction_ref ? ` (${rw.instruction_ref})` : ''}`, status: rw.instruction_approved ? 'READY' : 'PENDING', blocks: 'START', sourceType: 'REWORK_INSTRUCTION', sourceId: rw.id, ownerRole: 'MANUFACTURING' }] },
    { code: 'RW', name: `Rework: ${rw.scope}`, function: 'MANUFACTURING', workCenterId: rw.station_resource_id, slots: rw.hands_on_slots, reworkId: rw.id,
      phases: [{ name: 'Hands-on rework', slots: rw.hands_on_slots, resources: [rw.station_resource_id, rw.personnel_resource_id].filter(Boolean).map((r: number) => ({ resourceId: r, units: 1 })) }] },
  ];
  if (rw.retest === 'EOL') specs.push({ code: 'RW_RETEST', name: `Retest after rework (EOL) — RW#${rw.id}`, function: 'TESTING', workCenterId: eolPos, slots: 2, reworkId: rw.id,
    phases: [{ name: 'Retest', slots: 2, resources: [{ resourceId: eolPos, units: 1 }, { resourceId: eolHv, units: 1 }] }] });
  const ids = await insertIntoChain(c, { unitId: rw.unit_id }, specs);
  for (const p of rw.parts ?? []) {
    await addRequirement(c, { ...user, role: 'MANAGEMENT' } as AuthUser, { materialId: p.materialId, qty: p.qty, unitId: rw.unit_id, activityId: ids[1], reason: `Parts for rework #${rw.id}` });
  }
  if (rw.retest === 'VALIDATION' && rw.system_id) {
    await c.query(`UPDATE test_records SET status = 'REVIEW_REQUIRED', review_reason = $2 WHERE system_id = $1 AND status = 'VALID'`, [rw.system_id, `Rework #${rw.id} on a unit of this system`]);
  }
  await c.query(`UPDATE rework_packages SET status = 'PLANNED', insert_before_activity_id = $2 WHERE id = $1`, [rw.id, ids[ids.length - 1]]);
  await syncProjectGraph(c, rw.project_id, `Rework #${rw.id}`);
  await syncDerivedGates(c, [rw.project_id]);
  return { projects: [rw.project_id], notes: [`Rework #${rw.id} scheduled: preparation, hands-on${rw.retest !== 'NONE' ? ', retest' : ''}`], warnings: rw.instruction_approved ? [] : ['Rework instruction not yet approved: preparation cannot start'] };
}

/**
 * Controlled unit reassignment (e.g. a dispenser borrowed from another project to protect a delivery).
 * Physical identity, installed components, location and test history stay with the unit; the
 * donor project receives a replacement unit flow; a replaced failed unit keeps its defect link.
 */
async function reassignUnit(c: pg.PoolClient, user: AuthUser, op: Extract<StructuralOp, { type: 'reassign_unit' }>): Promise<StructuralOutcome> {
  const u = (await c.query('SELECT u.*, pt.code product FROM units u JOIN product_types pt ON pt.id = u.product_type_id WHERE u.id = $1 FOR UPDATE', [op.unitId])).rows[0];
  if (!u) throw new HttpError(404, 'Unit not found');
  if (u.project_id === op.toProjectId) throw new HttpError(422, 'Unit already belongs to that project');
  if (u.disposition !== 'RELEASABLE') throw new HttpError(422, `Unit ${u.internal_id} is ${u.disposition.toLowerCase()}: it cannot be reassigned to a customer delivery`, 'NOT_RELEASABLE');
  const warnings: string[] = [];
  const notes: string[] = [];
  let targetSystem: number | null = null;
  let targetShipment: number | null = null;
  const recipient = (await c.query('SELECT * FROM projects WHERE id = $1', [op.toProjectId])).rows[0];
  if (!recipient) throw new HttpError(404, 'Recipient project not found');
  if (op.replacesUnitId) {
    const f = (await c.query('SELECT * FROM units WHERE id = $1 FOR UPDATE', [op.replacesUnitId])).rows[0];
    if (!f || f.project_id !== op.toProjectId) throw new HttpError(422, 'The replaced unit must belong to the recipient project');
    if (f.product_type_id !== u.product_type_id) throw new HttpError(422, 'Incompatible: replacement must be the same product', 'INCOMPATIBLE');
    if ((f.hw_revision ?? '') !== (u.hw_revision ?? '')) warnings.push(`Hardware revision differs (${u.hw_revision} vs ${f.hw_revision}): confirm compatibility; EOL retest recommended`);
    if ((f.item_code ?? '') && (u.item_code ?? '') && f.item_code !== u.item_code) warnings.push(`Item code differs (${u.item_code} vs ${f.item_code}): configuration/variant check required`);
    targetSystem = f.system_id; targetShipment = f.shipment_id;
    await c.query(`UPDATE units SET status = 'SPARE', system_id = NULL, shipment_id = NULL WHERE id = $1`, [f.id]);
    await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'SWAP_OUT',$2,$3,$4,$5)`,
      [f.id, JSON.stringify({ projectId: f.project_id, systemId: f.system_id, shipmentId: f.shipment_id }), JSON.stringify({ replacedBy: u.internal_id }), op.reason ?? 'Replaced by reassigned unit', user.id]);
    notes.push(`${f.internal_id} leaves the delivery scope (kept with its defect and investigation)`);
  } else {
    // add to the first system of the recipient that still lacks a unit of this product, else as loose unit of the first shipment
    targetShipment = (await c.query('SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq LIMIT 1', [op.toProjectId])).rows[0]?.id ?? null;
  }
  const donor = u.project_id;
  const donorSystem = u.system_id; const donorShipment = u.shipment_id;
  await c.query('UPDATE units SET project_id = $2, system_id = $3, shipment_id = $4 WHERE id = $1', [u.id, op.toProjectId, targetSystem, targetShipment]);
  await c.query('UPDATE activities SET project_id = $2 WHERE unit_id = $1', [u.id, op.toProjectId]);
  await c.query('UPDATE material_requirements SET project_id = $2 WHERE unit_id = $1', [u.id, op.toProjectId]);
  await c.query('UPDATE readiness_gates SET project_id = $2 WHERE unit_id = $1', [u.id, op.toProjectId]);
  await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'REASSIGNED',$2,$3,$4,$5)`,
    [u.id, JSON.stringify({ projectId: donor, systemId: donorSystem, shipmentId: donorShipment }), JSON.stringify({ projectId: op.toProjectId, systemId: targetSystem, shipmentId: targetShipment, replaces: op.replacesUnitId ?? null }), op.reason ?? null, user.id]);
  // Recipient system: previous validation evidence no longer covers the new composition.
  if (targetSystem) {
    const valDone = (await c.query(`SELECT 1 FROM activities WHERE system_id = $1 AND scope = 'SYSTEM' AND code = 'VAL' AND status IN ('COMPLETED','IN_PROGRESS')`, [targetSystem])).rows.length;
    await c.query(`UPDATE test_records SET status = 'REVIEW_REQUIRED', review_reason = $2 WHERE system_id = $1 AND unit_id IS NULL AND status = 'VALID'`, [targetSystem, `Unit swap: ${u.internal_id} replaces ${op.replacesUnitId ?? '—'}`]);
    if (valDone) {
      const skid = await wcId(c, 'SKID'); const supply = await wcId(c, 'SKID_SUPPLY'); const tech = await wcId(c, 'RND_TECH'); const crew = await wcId(c, 'HANDLING');
      await insertIntoChain(c, { systemId: targetSystem }, [
        { code: 'RVAL_SETUP', name: 'Re-validation setup after unit swap', function: 'RND', workCenterId: skid, slots: 1, phases: [{ name: 'Setup', slots: 1, resources: [{ resourceId: skid, units: 1 }, { resourceId: tech, units: 1 }] }] },
        { code: 'RVAL', name: 'Re-validation after unit swap (scope per technical authority)', function: 'RND', workCenterId: skid, slots: 2, phases: [{ name: 'Re-validation', slots: 2, resources: [{ resourceId: skid, units: 1 }, { resourceId: supply, units: 1 }] }] },
        { code: 'RVAL_REMOVE', name: 'Disconnection & removal after re-validation', function: 'RND', workCenterId: skid, slots: 1, phases: [{ name: 'Removal', slots: 1, resources: [{ resourceId: skid, units: 1 }, { resourceId: crew, units: 1 }] }] },
      ]);
      const ids = (await c.query(`SELECT id, code, seq FROM activities WHERE system_id = $1 AND code IN ('RVAL_SETUP','RVAL','RVAL_REMOVE') AND status = 'NOT_STARTED' ORDER BY seq`, [targetSystem])).rows;
      if (ids.length === 3) {
        await c.query('UPDATE activities SET hold_from_seq = $2, hold_resource_id = $3 WHERE id = $1', [ids[1].id, ids[0].seq, skid]);
        await c.query('UPDATE activities SET hold_from_seq = $2, hold_resource_id = $3 WHERE id = $1', [ids[2].id, ids[1].seq, skid]);
      }
      notes.push('Recipient system already validated: re-validation inserted');
    }
  }
  // Donor keeps its delivery scope: a replacement unit flow is created in its place.
  let replacement: string | null = null;
  if (donor) {
    const maxSeq = (await c.query('SELECT COALESCE(MAX(seq),0) m FROM units WHERE project_id = $1', [donor])).rows[0].m;
    const r = await createUnit(c, { projectId: donor, productTypeId: u.product_type_id, systemId: donorSystem, shipmentId: donorShipment, seq: maxSeq + 1, itemCode: u.item_code, hwRevision: u.hw_revision, userId: user.id, source: 'REPLACEMENT' });
    replacement = r.internalId;
    await c.query(`INSERT INTO unit_history (unit_id, event, to_value, reason, user_id) VALUES ($1,'REPLACEMENT_FOR',$2,$3,$4)`, [r.id, JSON.stringify({ replaces: u.internal_id }), op.reason ?? null, user.id]);
    await syncProjectGraph(c, donor, `Unit ${u.internal_id} reassigned`);
    await bomRequirementsForUnit(c, r.id);
    notes.push(`Donor project receives replacement unit ${replacement} (full production flow)`);
  }
  await syncProjectGraph(c, op.toProjectId, `Unit ${u.internal_id} received`);
  await syncDerivedGates(c, [op.toProjectId, ...(donor ? [donor] : [])]);
  return { projects: [op.toProjectId, ...(donor ? [donor] : [])], notes, warnings };
}

/** Apply an approved configuration version: obsolete demand is identified, missing unit flows created, logistics notified. */
async function applyConfiguration(c: pg.PoolClient, user: AuthUser, configurationId: number): Promise<StructuralOutcome> {
  const cfg = (await c.query('SELECT * FROM project_configurations WHERE id = $1 FOR UPDATE', [configurationId])).rows[0];
  if (!cfg) throw new HttpError(404, 'Configuration not found');
  if (cfg.status !== 'APPROVED') throw new HttpError(422, 'Only an approved configuration version can be applied through change control', 'NOT_APPROVED');
  const pid = cfg.project_id;
  const notes: string[] = []; const warnings: string[] = [];
  const systems = (await c.query(`SELECT * FROM systems WHERE project_id = $1 AND status = 'ACTIVE' ORDER BY id`, [pid])).rows;
  const shipment = (await c.query('SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq LIMIT 1', [pid])).rows[0]?.id ?? null;
  const visit = (await c.query('SELECT id FROM commissioning_visits WHERE project_id = $1 ORDER BY id LIMIT 1', [pid])).rows[0]?.id ?? null;
  const target: { code: string; name?: string; composition: { productTypeId: number; quantity: number }[] }[] = cfg.systems ?? [];
  const keepSystems = new Set<number>();
  let seq = (await c.query('SELECT COALESCE(MAX(seq),0) m FROM units WHERE project_id = $1', [pid])).rows[0].m;
  const newUnits: number[] = [];
  for (const t of target) {
    let sys = systems.find((s) => s.code === t.code);
    if (!sys) {
      sys = (await c.query('INSERT INTO systems (project_id, code, name, composition, visit_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [pid, t.code, t.name ?? t.code, null, visit])).rows[0];
      notes.push(`New system ${t.code}`);
    }
    keepSystems.add(sys.id);
    const units = (await c.query(`SELECT u.*, (SELECT count(*) FROM activities a WHERE a.unit_id = u.id AND a.status IN ('COMPLETED','IN_PROGRESS')) started FROM units u
      WHERE u.system_id = $1 AND u.status = 'ACTIVE' ORDER BY started, u.id DESC`, [sys.id])).rows;
    const wanted = new Map(t.composition.map((x) => [x.productTypeId, x.quantity]));
    for (const [pt, qty] of wanted) {
      const have = units.filter((u) => u.product_type_id === pt);
      for (let i = have.length; i < qty; i++) {
        seq++;
        const r = await createUnit(c, { projectId: pid, productTypeId: pt, systemId: sys.id, shipmentId: shipment, seq, userId: user.id, source: 'CONFIG_CHANGE' });
        newUnits.push(r.id);
      }
      // excess units of a product: least-progressed first become spare (reusable), never silently deleted
      for (const u of have.slice(0, Math.max(0, have.length - qty))) await makeSpare(c, user, u, `Configuration v${cfg.version}: obsolete demand`);
    }
    for (const u of units.filter((x) => !wanted.has(x.product_type_id))) await makeSpare(c, user, u, `Configuration v${cfg.version}: product no longer in configuration`);
    const comp = (await c.query(`SELECT string_agg(n || '× ' || code, ' + ') s FROM (SELECT pt.code, count(*) n FROM units u JOIN product_types pt ON pt.id = u.product_type_id
      WHERE u.system_id = $1 AND u.status = 'ACTIVE' GROUP BY pt.code) x`, [sys.id])).rows[0].s;
    await c.query('UPDATE systems SET composition = $2 WHERE id = $1', [sys.id, comp]);
  }
  for (const s of systems.filter((x) => !keepSystems.has(x.id))) {
    await c.query(`UPDATE systems SET status = 'OBSOLETE' WHERE id = $1`, [s.id]);
    const units = (await c.query(`SELECT * FROM units WHERE system_id = $1 AND status = 'ACTIVE'`, [s.id])).rows;
    for (const u of units) await makeSpare(c, user, u, `Configuration v${cfg.version}: system ${s.code} removed`);
    notes.push(`System ${s.code} obsolete`);
  }
  // order lines follow the applied configuration
  await c.query('DELETE FROM order_lines WHERE project_id = $1', [pid]);
  const totals = new Map<number, number>();
  for (const t of target) for (const x of t.composition) totals.set(x.productTypeId, (totals.get(x.productTypeId) ?? 0) + x.quantity);
  let line = 0;
  for (const [pt, q] of totals) {
    line++;
    const ol = (await c.query('INSERT INTO order_lines (project_id, line_no, product_type_id, quantity) VALUES ($1,$2,$3,$4) RETURNING id', [pid, line, pt, q])).rows[0];
    await c.query(`UPDATE units SET order_line_id = $3 WHERE project_id = $1 AND product_type_id = $2 AND status = 'ACTIVE'`, [pid, pt, ol.id]);
  }
  await c.query(`UPDATE project_configurations SET status = 'SUPERSEDED' WHERE project_id = $1 AND status = 'APPLIED'`, [pid]);
  await c.query(`UPDATE project_configurations SET status = 'APPLIED', applied_at = now() WHERE id = $1`, [cfg.id]);
  // affected validation evidence and logistics reconciliation
  await c.query(`UPDATE test_records SET status = 'REVIEW_REQUIRED', review_reason = $2 WHERE system_id = ANY($1) AND unit_id IS NULL AND status = 'VALID'`, [[...keepSystems], `Configuration changed to v${cfg.version}`]);
  const ack = (await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, related, created_by)
    VALUES ('LOGISTICS_ACK', $1, $2, $3, 'LOGISTICS', $4, $5) RETURNING id`,
  [`Acknowledge configuration change v${cfg.version}`, `Product codes / quantities changed: ${cfg.scope_text ?? ''}. Update shipment manifest, dimensions and order-to-cash records.`, pid,
    JSON.stringify({ configurationId: cfg.id }), user.id])).rows[0].id;
  await syncProjectGraph(c, pid, `Configuration v${cfg.version}`);
  for (const uid of newUnits) await bomRequirementsForUnit(c, uid);
  const outPreps = (await c.query(`SELECT a.* FROM activities a WHERE a.project_id = $1 AND a.code = 'OUT_PREP' AND a.status NOT IN ('COMPLETED','CANCELLED')`, [pid])).rows;
  for (const a of outPreps) {
    await c.query(`INSERT INTO readiness_gates (project_id, activity_id, shipment_id, dimension, title, status, blocks, owner_role, source_type, source_id)
      VALUES ($1,$2,$3,'EXTERNAL',$4,'PENDING','START','LOGISTICS','LOGISTICS_ACK',$5)`, [pid, a.id, a.shipment_id, `Logistics / O2C acknowledged configuration v${cfg.version}`, ack]);
  }
  await syncDerivedGates(c, [pid]);
  notes.push(`${newUnits.length} unit flow(s) added; logistics acknowledgment requested`);
  return { projects: [pid], notes, warnings };
}

async function makeSpare(c: pg.PoolClient, user: AuthUser, u: any, reason: string) {
  await c.query(`UPDATE units SET status = 'SPARE', system_id = NULL, shipment_id = NULL WHERE id = $1`, [u.id]);
  await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'OBSOLETE_DEMAND',$2,'{"status":"SPARE"}',$3,$4)`,
    [u.id, JSON.stringify({ projectId: u.project_id, systemId: u.system_id }), reason, user.id]);
}

async function regroupUnits(c: pg.PoolClient, user: AuthUser, op: Extract<StructuralOp, { type: 'regroup_units' }>): Promise<StructuralOutcome> {
  const units = (await c.query('SELECT * FROM units WHERE id = ANY($1)', [op.unitIds])).rows;
  if (!units.length) throw new HttpError(422, 'No units selected');
  const pid = units[0].project_id;
  if (units.some((u) => u.project_id !== pid)) throw new HttpError(422, 'Units must belong to the same project');
  let target = op.toShipmentId ?? null;
  if (!target) {
    const first = (await c.query('SELECT * FROM shipments WHERE project_id = $1 ORDER BY seq LIMIT 1', [pid])).rows[0];
    const seq = (await c.query('SELECT COALESCE(MAX(seq),0)+1 s FROM shipments WHERE project_id = $1', [pid])).rows[0].s;
    target = (await c.query(`INSERT INTO shipments (project_id, code, seq, route_id, service_profile_id, destination) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [pid, op.newShipment?.code ?? `SH${seq}`, seq, first.route_id, op.newShipment?.serviceProfileId ?? first.service_profile_id, first.destination])).rows[0].id;
    for (const d of ['Commercial invoice', 'Packing list', 'Delivery note']) await c.query('INSERT INTO shipment_documents (shipment_id, doc_type) VALUES ($1,$2)', [target, d]);
  }
  const done = (await c.query(`SELECT 1 FROM activities a WHERE a.shipment_id = (SELECT shipment_id FROM units WHERE id = $1) AND a.scope = 'SHIPMENT' AND a.code = 'TRANSIT' AND a.status <> 'NOT_STARTED'`, [units[0].id])).rows.length;
  if (done) throw new HttpError(409, 'The current shipment of these units has already left');
  for (const u of units) {
    await c.query('UPDATE units SET shipment_id = $2 WHERE id = $1', [u.id, target]);
    await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'SHIPMENT_REGROUPED',$2,$3,'Shipment regrouping',$4)`,
      [u.id, JSON.stringify({ shipmentId: u.shipment_id }), JSON.stringify({ shipmentId: target }), user.id]);
  }
  await syncProjectGraph(c, pid, 'Shipment regrouping');
  await syncDerivedGates(c, [pid]);
  return { projects: [pid], notes: [`${units.length} unit(s) moved to shipment #${target}`], warnings: [] };
}

async function splitVisit(c: pg.PoolClient, user: AuthUser, op: Extract<StructuralOp, { type: 'split_visit' }>): Promise<StructuralOutcome> {
  const systems = (await c.query('SELECT * FROM systems WHERE id = ANY($1)', [op.systemIds])).rows;
  if (!systems.length) throw new HttpError(422, 'No systems selected');
  const pid = systems[0].project_id;
  const tpl = (await c.query('SELECT * FROM commissioning_visits WHERE project_id = $1 ORDER BY id LIMIT 1', [pid])).rows[0];
  const n = (await c.query('SELECT count(*)::int n FROM commissioning_visits WHERE project_id = $1', [pid])).rows[0].n;
  const v = (await c.query(`INSERT INTO commissioning_visits (project_id, code, site, installation_responsibility, installation_days, team_resource_id, site_work_responsible, execution_lead_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [pid, op.visitCode ?? `V${n + 1}`, tpl?.site, tpl?.installation_responsibility, tpl?.installation_days ?? 2, tpl?.team_resource_id,
    tpl?.site_work_responsible ?? null, tpl?.execution_lead_name ?? null])).rows[0].id;
  await c.query('UPDATE systems SET visit_id = $2 WHERE id = ANY($1)', [op.systemIds, v]);
  await syncProjectGraph(c, pid, 'Commissioning visit split');
  await syncDerivedGates(c, [pid]);
  return { projects: [pid], notes: [`${systems.length} system(s) moved to a separate commissioning visit`], warnings: [] };
}

/**
 * "Continue with the approved version now, update later": an explicit update operation for the
 * identified units (with optional retest), and a recorded conditional release of the original
 * requirement — never a silent removal of the requirement.
 */
async function addUpdateOperation(c: pg.PoolClient, user: AuthUser, op: Extract<StructuralOp, { type: 'add_update_operation' }>): Promise<StructuralOutcome> {
  const rel = (await c.query('SELECT r.*, c.code component, c.name component_name FROM sw_releases r JOIN sw_components c ON c.id = r.component_id WHERE r.id = $1', [op.releaseId])).rows[0];
  if (!rel) throw new HttpError(404, 'Release not found');
  const eolPos = await wcId(c, 'EOL_POS'); const eolHv = await wcId(c, 'EOL_HV');
  const projects = new Set<number>();
  for (const uid of op.unitIds) {
    const u = (await c.query('SELECT * FROM units WHERE id = $1', [uid])).rows[0];
    if (!u) throw new HttpError(404, `Unit ${uid} not found`);
    projects.add(u.project_id);
    const specs: InsertSpec[] = [{
      code: 'SW_UPDATE', name: `Update ${rel.component_name} to ${rel.version}`, function: 'TESTING', workCenterId: eolPos, slots: op.durationSlots ?? 1,
      phases: [{ name: 'Software update', slots: op.durationSlots ?? 1, resources: [{ resourceId: eolPos, units: 1 }] }],
      gates: [{ dimension: 'SOFTWARE', title: `${rel.component_name} ${rel.version} approved & available`, status: 'UNKNOWN', blocks: 'START', sourceType: 'SOFTWARE', spec: { component: rel.component, requirement: 'AVAILABLE', releaseId: rel.id } }],
    }];
    if (op.retest !== false) specs.push({ code: 'SW_RETEST', name: `Functional retest after ${rel.version} update`, function: 'TESTING', workCenterId: eolPos, slots: 1,
      phases: [{ name: 'Retest', slots: 1, resources: [{ resourceId: eolPos, units: 1 }, { resourceId: eolHv, units: 1 }] }] });
    const ids = await insertIntoChain(c, { unitId: uid }, specs);
    const cr = { scope: `Unit ${u.internal_id}: complete EOL with the currently approved version`, conditions: `Update to ${rel.version} in activity #${ids[0]}${op.retest !== false ? ' with retest' : ''} before system validation`,
      expirySlot: null, approvedBy: user.id, approverName: user.name, approvedAt: new Date().toISOString(), viaUpdateOperation: ids[0] };
    await c.query(`UPDATE readiness_gates SET conditional_release = $2 WHERE unit_id = $1 AND source_type = 'SOFTWARE' AND blocks = 'COMPLETE' AND spec->>'component' = $3`, [uid, JSON.stringify(cr), rel.component]);
  }
  for (const p of projects) await syncProjectGraph(c, p, `Software update ${rel.version}`);
  await syncDerivedGates(c, [...projects]);
  return { projects: [...projects], notes: [`Update operation to ${rel.version} added for ${op.unitIds.length} unit(s)`], warnings: rel.stage !== 'APPROVED' ? [`${rel.version} is not yet approved: the update operation stays gated`] : [] };
}

/** Commit tentative/approved demand: Mode A backward plan from its required date becomes the baseline. */
async function commitDemand(c: pg.PoolClient, user: AuthUser, projectId: number): Promise<StructuralOutcome> {
  const p = (await c.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [projectId])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  if (p.demand_status === 'COMMITTED') throw new HttpError(409, 'Project already committed');
  if (!p.required_commissioning_date) throw new HttpError(422, 'A required commissioning date is needed to commit the demand');
  await c.query(`UPDATE projects SET demand_status = 'COMMITTED' WHERE id = $1`, [projectId]);
  const state = await loadPlanState(c);
  const plan = initialPlan(state, projectId);
  const own = state.activities.filter((a) => a.projectId === projectId && a.status !== 'COMPLETED');
  for (const a of own) await c.query('UPDATE activities SET approved_start = $2 WHERE id = $1', [a.id, plan.starts.get(a.id) ?? null]);
  const comm = plan.result.milestones.find((m) => m.projectId === projectId && m.type === 'COMM' && m.shipmentId === null && !m.visitId);
  await c.query('UPDATE projects SET plan_status = $2, earliest_commissioning_slot = $3, plan_confidence = $4 WHERE id = $1',
    [projectId, plan.feasible ? 'FEASIBLE' : 'INFEASIBLE', comm?.forecast ?? null, plan.confidence]);
  return { projects: [projectId], notes: [`Demand committed (${plan.feasible ? 'feasible' : 'infeasible'}, ${plan.confidence.toLowerCase()})`], warnings: [] };
}
