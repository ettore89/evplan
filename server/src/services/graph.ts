/**
 * Project graph: physical units → complete systems → shipment manifests → site interventions.
 * Activities are created from versioned routing templates; dependencies and resource holds are
 * always rebuilt from current membership, so structural changes (configuration changes, unit
 * reassignment, shipment regrouping, visit splits, inserted rework) share one code path.
 */
import type pg from 'pg';
import { generateActivities, type StepTemplate } from '../engine/generate.js';
import type { PhaseDef } from '../engine/types.js';
import { HttpError } from './common.js';

interface RoutingStepRow {
  id: number; seq: number; code: string; name: string; function: string; work_center_id: number | null; duration_slots: number;
  scope: string; stage: string; kind: string; predecessor_seqs: number[] | null; milestone_tag: string | null;
  use_destination_calendar: boolean; phases: PhaseDef[] | null; hold_from: { seq: number; resourceId: number; units: number } | null;
  test_plan_code: string | null; gate_templates: any[];
}

export async function routingVersion(c: pg.PoolClient, kind: 'UNIT' | 'SYSTEM' | 'SHIPMENT' | 'VISIT', productTypeId: number | null, versionId?: number | null) {
  const v = versionId
    ? (await c.query('SELECT * FROM routing_versions WHERE id = $1', [versionId])).rows[0]
    : (await c.query(`SELECT * FROM routing_versions WHERE template_kind = $1 AND status = 'APPROVED' AND effective_from <= CURRENT_DATE
        AND ($2::int IS NULL OR product_type_id = $2) ORDER BY effective_from DESC, version DESC LIMIT 1`, [kind, productTypeId])).rows[0];
  if (!v) throw new HttpError(400, `No approved ${kind} routing${productTypeId ? ` for product ${productTypeId}` : ''}`);
  const steps = (await c.query('SELECT * FROM routing_steps WHERE routing_version_id = $1 ORDER BY seq', [v.id])).rows as RoutingStepRow[];
  return { version: v, steps };
}

/** Allocate a physical unit with a stable internal identity (the final serial may come later). */
export async function createUnit(c: pg.PoolClient, u: {
  projectId: number | null; productTypeId: number; systemId?: number | null; shipmentId?: number | null; orderLineId?: number | null;
  name?: string | null; serial?: string | null; itemCode?: string | null; hwRevision?: string | null; seq: number; source?: string; location?: string | null;
  userId?: number | null; status?: string; evaluation?: boolean;
}) {
  const rv = await routingVersion(c, 'UNIT', u.productTypeId);
  const pt = (await c.query('SELECT * FROM product_types WHERE id = $1', [u.productTypeId])).rows[0];
  const r = await c.query(
    `INSERT INTO units (internal_id, project_id, order_line_id, system_id, shipment_id, product_type_id, item_code, serial, name, seq, hw_revision,
       routing_version_id, location, source, status, evaluation_unit)
     VALUES ('tmp-' || gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [u.projectId, u.orderLineId ?? null, u.systemId ?? null, u.shipmentId ?? null, u.productTypeId, u.itemCode ?? null, u.serial ?? null,
      u.name ?? null, u.seq, u.hwRevision ?? pt.default_hw_revision, rv.version.id, u.location ?? 'Production facility', u.source ?? 'PLAN', u.status ?? 'ACTIVE', u.evaluation ?? false]);
  const id = r.rows[0].id;
  const internalId = `EVU-${String(id).padStart(6, '0')}`;
  await c.query('UPDATE units SET internal_id = $2, name = COALESCE(name, $3) WHERE id = $1', [id, internalId, `${pt.code}-${String(u.seq).padStart(3, '0')}`]);
  await c.query(`INSERT INTO unit_history (unit_id, event, to_value, reason, user_id) VALUES ($1,'CREATED',$2,$3,$4)`,
    [id, JSON.stringify({ projectId: u.projectId, systemId: u.systemId ?? null, shipmentId: u.shipmentId ?? null, product: pt.code }), u.source ?? 'Planned unit', u.userId ?? null]);
  return { id, internalId };
}

const scopeOf = (s: string) => (s === 'SITE_SYSTEM' ? 'SITE' : s);

async function insertActivity(c: pg.PoolClient, p: any, step: RoutingStepRow, owner: { unitId?: number | null; systemId?: number | null; shipmentId?: number | null; visitId?: number | null },
  extra: { unitSeq: number; calendarId: number | null; routeId: number | null; durationSlots?: number; phases?: PhaseDef[] | null; workCenterId?: number | null; name?: string; source?: string }) {
  const phases = extra.phases !== undefined ? extra.phases : step.phases;
  const duration = extra.durationSlots ?? (phases?.length ? phases.reduce((t, x) => t + x.slots, 0) : step.duration_slots);
  const r = await c.query(
    `INSERT INTO activities (project_id, unit_id, system_id, shipment_id, visit_id, scope, stage, routing_step_id, seq, unit_seq, code, name, function,
       work_center_id, calendar_id, route_id, kind, milestone_tag, duration_slots, phases, hold_from_seq, hold_resource_id, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [p.id, owner.unitId ?? null, owner.systemId ?? null, owner.shipmentId ?? null, owner.visitId ?? null, scopeOf(step.scope), step.stage ?? 'PRE', step.id,
      step.seq, extra.unitSeq, step.code, extra.name ?? step.name, step.function, extra.workCenterId !== undefined ? extra.workCenterId : step.work_center_id,
      extra.calendarId, extra.routeId, step.kind, step.milestone_tag, duration, phases ? JSON.stringify(phases) : null,
      step.hold_from?.seq ?? null, step.hold_from?.resourceId ?? null, extra.source ?? 'PLAN'],
  );
  const id = r.rows[0].id;
  for (const g of step.gate_templates ?? []) {
    await c.query(
      `INSERT INTO readiness_gates (project_id, activity_id, unit_id, system_id, shipment_id, visit_id, dimension, title, status, blocks, owner_role, source_type, spec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UNKNOWN',$9,$10,$11,$12)`,
      [p.id, id, owner.unitId ?? null, owner.systemId ?? null, owner.shipmentId ?? null, owner.visitId ?? null, g.dimension, g.title, g.blocks ?? 'START',
        g.owner ?? null, g.source ?? (g.dimension === 'SOFTWARE' ? 'SOFTWARE' : 'MANUAL'), JSON.stringify({ component: g.component, requirement: g.requirement })]);
  }
  return id;
}

async function teamFor(c: pg.PoolClient, p: any, visit: any) {
  if (visit?.team_resource_id) return visit.team_resource_id;
  const r = await c.query(`SELECT rg.code FROM routes rt LEFT JOIN regions rg ON rg.id = rt.region_id WHERE rt.id = $1`, [p.route_id]);
  const code = r.rows[0]?.code === 'NA' ? 'COMM_NA' : 'COMM_EU';
  return (await c.query('SELECT id FROM work_centers WHERE code = $1', [code])).rows[0]?.id ?? null;
}

/** Create activities that are missing for the project's current units, systems, shipments and visits. */
export async function ensureActivities(c: pg.PoolClient, projectId: number) {
  const p = (await c.query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
  if (!p) throw new HttpError(404, 'Project not found');
  const existing = (await c.query('SELECT id, unit_id, system_id, shipment_id, visit_id, scope, seq, status FROM activities WHERE project_id = $1', [projectId])).rows;
  // Any existing activity (also cancelled / N/A) counts: a step explicitly cancelled is never silently recreated.
  const has = (pred: (a: any) => boolean) => existing.some(pred);
  let created = 0;

  const units = (await c.query(`SELECT * FROM units WHERE project_id = $1 AND status = 'ACTIVE' ORDER BY seq, id`, [projectId])).rows;
  for (const u of units) {
    const rv = await routingVersion(c, 'UNIT', u.product_type_id, u.routing_version_id);
    for (const st of rv.steps) {
      if (has((a) => a.unit_id === u.id && a.seq === st.seq)) continue;
      await insertActivity(c, p, st, { unitId: u.id, systemId: u.system_id, shipmentId: u.shipment_id }, { unitSeq: u.seq, calendarId: st.use_destination_calendar ? p.calendar_id : null, routeId: null });
      created++;
    }
  }
  const systems = (await c.query(`SELECT * FROM systems WHERE project_id = $1 AND status = 'ACTIVE' ORDER BY id`, [projectId])).rows;
  const sysT = await routingVersion(c, 'SYSTEM', null);
  for (const [i, sy] of systems.entries()) {
    for (const st of sysT.steps) {
      if (has((a) => a.system_id === sy.id && a.scope === 'SYSTEM' && a.seq === st.seq)) continue;
      let durationSlots: number | undefined;
      let phases: PhaseDef[] | null | undefined;
      if (st.test_plan_code) {
        const tp = sy.test_plan_id
          ? (await c.query('SELECT * FROM test_plans WHERE id = $1', [sy.test_plan_id])).rows[0]
          : (await c.query(`SELECT * FROM test_plans WHERE code = $1 AND status = 'APPROVED' ORDER BY version DESC LIMIT 1`, [st.test_plan_code])).rows[0];
        if (tp && st.phases?.length) { durationSlots = tp.duration_slots; phases = st.phases.map((x, k) => (k === 0 ? { ...x, slots: tp.duration_slots } : x)); }
      }
      await insertActivity(c, p, st, { systemId: sy.id }, { unitSeq: 1000 + i + 1, calendarId: null, routeId: null, durationSlots, phases, name: `${st.name} — ${sy.code}` });
      created++;
    }
  }
  const shipments = (await c.query(`SELECT s.*, sp.internal_prep_slots, sp.transit_days, sp.customs_days, sp.final_delivery_days, r.lead_time_days
    FROM shipments s JOIN routes r ON r.id = s.route_id LEFT JOIN service_profiles sp ON sp.id = s.service_profile_id WHERE s.project_id = $1 ORDER BY s.seq, s.id`, [projectId])).rows;
  const shT = await routingVersion(c, 'SHIPMENT', null);
  for (const sh of shipments) {
    const dur: Record<string, number> = {
      OUT_PREP: sh.internal_prep_slots ?? 1, TRANSIT: (sh.transit_days ?? sh.lead_time_days) * 2,
      CUSTOMS: (sh.customs_days ?? 0) * 2, DELIVERY: (sh.final_delivery_days ?? 0) * 2,
    };
    for (const st of shT.steps) {
      const slots = dur[st.code] ?? st.duration_slots;
      if (slots <= 0 && st.code !== 'OUT_PREP') continue;
      if (has((a) => a.shipment_id === sh.id && a.scope === 'SHIPMENT' && a.seq === st.seq)) continue;
      await insertActivity(c, p, st, { shipmentId: sh.id }, {
        unitSeq: 2000 + sh.seq, calendarId: st.use_destination_calendar ? p.calendar_id : null, routeId: st.kind === 'transport' ? sh.route_id : null,
        durationSlots: slots, phases: st.phases ? st.phases.map((x) => ({ ...x, slots })) : null, name: `${st.name} — ${sh.code}`,
      });
      created++;
    }
  }
  const visits = (await c.query('SELECT * FROM commissioning_visits WHERE project_id = $1 ORDER BY id', [projectId])).rows;
  const vT = await routingVersion(c, 'VISIT', null);
  for (const [vi, v] of visits.entries()) {
    const vSystems = systems.filter((s) => s.visit_id === v.id);
    if (!vSystems.length) continue;
    const team = await teamFor(c, p, v);
    for (const st of vT.steps) {
      if (st.scope === 'SITE') {
        if (has((a) => a.visit_id === v.id && a.system_id === null && a.seq === st.seq)) continue;
        const slots = st.code === 'INSTALL' ? (v.installation_days ?? 2) * 2 : st.duration_slots;
        await insertActivity(c, p, st, { visitId: v.id }, { unitSeq: 3000 + vi, calendarId: p.calendar_id, routeId: null, durationSlots: slots, name: `${st.name} — ${v.code}` });
        created++;
      } else {
        for (const sy of vSystems) {
          if (has((a) => a.visit_id === v.id && a.system_id === sy.id && a.seq === st.seq)) continue;
          const phases = st.phases?.length ? st.phases.map((x) => ({ ...x, resources: x.resources.map((r) => ({ ...r, resourceId: team ?? r.resourceId })) }))
            : [{ name: st.name, slots: st.duration_slots, resources: team ? [{ resourceId: team, units: 1 }] : [] }];
          await insertActivity(c, p, st, { visitId: v.id, systemId: sy.id }, { unitSeq: 3100 + vi, calendarId: p.calendar_id, routeId: null, phases, workCenterId: team, name: `${st.name} — ${sy.code}` });
          created++;
        }
      }
    }
  }
  return created;
}

/**
 * Cancel open activities that no longer belong to the delivery scope (obsolete units, units moved
 * to another project, systems removed, commissioning of a system moved to another visit).
 * Completed work and its actual dates are always preserved.
 */
export async function cancelOrphans(c: pg.PoolClient, projectId: number, reason: string) {
  const r = await c.query(
    `UPDATE activities a SET status = 'CANCELLED', delay_reason = COALESCE(a.delay_reason, $2), updated_at = now()
     WHERE a.project_id = $1 AND a.status NOT IN ('COMPLETED','CANCELLED','IN_PROGRESS') AND (
       (a.unit_id IS NOT NULL AND EXISTS (SELECT 1 FROM units u WHERE u.id = a.unit_id AND (u.status <> 'ACTIVE' OR u.project_id IS DISTINCT FROM a.project_id)))
       OR (a.scope = 'SYSTEM' AND EXISTS (SELECT 1 FROM systems s WHERE s.id = a.system_id AND s.status <> 'ACTIVE'))
       OR (a.scope = 'SITE' AND a.system_id IS NOT NULL AND EXISTS (SELECT 1 FROM systems s WHERE s.id = a.system_id AND (s.status <> 'ACTIVE' OR s.visit_id IS DISTINCT FROM a.visit_id)))
       OR (a.scope = 'SITE' AND a.system_id IS NULL AND NOT EXISTS (SELECT 1 FROM systems s WHERE s.visit_id = a.visit_id AND s.status = 'ACTIVE'))
     ) RETURNING a.id`, [projectId, reason]);
  return r.rows.map((x) => x.id as number);
}

/** Rebuild dependencies and resource holds of a project from its current structure. */
export async function rebuildDependencies(c: pg.PoolClient, projectId: number) {
  const acts = (await c.query(`SELECT * FROM activities WHERE project_id = $1 AND status <> 'CANCELLED'`, [projectId])).rows;
  const ids = acts.map((a) => a.id);
  await c.query('DELETE FROM dependencies WHERE succ_id = ANY($1) OR pred_id = ANY($1)', [ids]);
  await c.query('DELETE FROM activity_holds WHERE activity_id = ANY($1)', [ids]);
  if (!acts.length) return;
  const units = (await c.query(`SELECT id, seq, system_id, shipment_id FROM units WHERE project_id = $1 AND status = 'ACTIVE'`, [projectId])).rows;
  const systems = (await c.query(`SELECT id, visit_id FROM systems WHERE project_id = $1 AND status = 'ACTIVE'`, [projectId])).rows;
  const shipments = (await c.query('SELECT id, route_id FROM shipments WHERE project_id = $1', [projectId])).rows;
  const visits = (await c.query('SELECT id FROM commissioning_visits WHERE project_id = $1', [projectId])).rows;
  const asStep = (a: any, scope: StepTemplate['scope']): StepTemplate => ({
    seq: a.seq, code: a.code, name: a.name, function: a.function, scope, stage: a.stage, kind: a.kind, workCenterId: a.work_center_id,
    durationSlots: a.duration_slots, phases: null, predecessorSeqs: null, milestoneTag: a.milestone_tag, useDestinationCalendar: false,
    holdFrom: a.hold_from_seq ? { seq: a.hold_from_seq, resourceId: a.hold_resource_id, units: 1 } : null,
  });
  const sysIds = new Set(systems.map((s) => s.id));
  const unitDefs = units.map((u) => ({
    key: String(u.id), seq: u.seq, systemKey: u.system_id && sysIds.has(u.system_id) ? String(u.system_id) : null, shipmentKey: u.shipment_id ? String(u.shipment_id) : null,
    steps: acts.filter((a) => a.unit_id === u.id && a.scope === 'UNIT').map((a) => asStep(a, 'UNIT')),
  }));
  const systemDefs = systems.map((s, i) => ({
    key: String(s.id), seq: i + 1, unitKeys: units.filter((u) => u.system_id === s.id).map((u) => String(u.id)),
    steps: acts.filter((a) => a.system_id === s.id && a.scope === 'SYSTEM').map((a) => asStep(a, 'SYSTEM')),
  }));
  const shipmentDefs = shipments.map((s) => ({ key: String(s.id), routeId: s.route_id, steps: acts.filter((a) => a.shipment_id === s.id && a.scope === 'SHIPMENT').map((a) => asStep(a, 'SHIPMENT')) }));
  const visitDefs = visits.map((v) => {
    const vs = systems.filter((s) => s.visit_id === v.id);
    const shipKeys = [...new Set(units.filter((u) => vs.some((s) => s.id === u.system_id) && u.shipment_id).map((u) => String(u.shipment_id)))];
    const siteSteps = acts.filter((a) => a.visit_id === v.id && a.scope === 'SITE' && a.system_id === null).map((a) => asStep(a, 'SITE'));
    const perSys = new Map<number, StepTemplate>();
    for (const a of acts.filter((x) => x.visit_id === v.id && x.scope === 'SITE' && x.system_id !== null)) perSys.set(a.seq, asStep(a, 'SITE_SYSTEM'));
    return { key: String(v.id), systemKeys: vs.map((s) => String(s.id)), shipmentKeys: shipKeys, steps: [...siteSteps, ...perSys.values()], calendarId: null };
  });
  const g = generateActivities({ units: unitDefs, systems: systemDefs, shipments: shipmentDefs, visits: visitDefs, destinationCalendarId: null });
  const idOf = new Map<string, number>();
  for (const a of acts) {
    if (a.scope === 'UNIT' && a.unit_id) idOf.set(`U:${a.unit_id}:${a.seq}`, a.id);
    else if (a.scope === 'SYSTEM') idOf.set(`Y:${a.system_id}:${a.seq}`, a.id);
    else if (a.scope === 'SHIPMENT') idOf.set(`S:${a.shipment_id}:${a.seq}`, a.id);
    else if (a.scope === 'SITE' && a.system_id === null) idOf.set(`V:${a.visit_id}:${a.seq}`, a.id);
    else if (a.scope === 'SITE') idOf.set(`W:${a.visit_id}:${a.system_id}:${a.seq}`, a.id);
  }
  const pred: number[] = [], succ: number[] = [], lag: number[] = [];
  for (const d of g.deps) {
    const p = idOf.get(d.predKey); const s = idOf.get(d.succKey);
    if (p && s && p !== s) { pred.push(p); succ.push(s); lag.push(d.lag); }
  }
  if (pred.length) await c.query(`INSERT INTO dependencies (pred_id, succ_id, lag_slots) SELECT * FROM unnest($1::int[], $2::int[], $3::int[]) ON CONFLICT DO NOTHING`, [pred, succ, lag]);
  for (const h of g.holds) {
    const a = idOf.get(h.succKey); const f = idOf.get(h.fromKey);
    if (a && f && h.resourceId) await c.query('INSERT INTO activity_holds (activity_id, from_activity_id, work_center_id, units) VALUES ($1,$2,$3,$4)', [a, f, h.resourceId, h.units]);
  }
  // unit activities follow their unit's current shipment (ExWorks per delivery)
  await c.query(`UPDATE activities a SET shipment_id = u.shipment_id, system_id = u.system_id FROM units u WHERE a.unit_id = u.id AND a.project_id = $1 AND a.scope = 'UNIT'`, [projectId]);
}

/** Bring a project's graph in line with its structure: create missing work, cancel orphans, rewire. */
export async function syncProjectGraph(c: pg.PoolClient, projectId: number, reason = 'Scope change') {
  const cancelled = await cancelOrphans(c, projectId, reason);
  const created = await ensureActivities(c, projectId);
  await rebuildDependencies(c, projectId);
  return { cancelled, created };
}
