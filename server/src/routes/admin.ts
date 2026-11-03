import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { lockPlan, pool, tx } from '../db/pool.js';
import { audit, HttpError, requirePermission } from '../services/common.js';
import { recalculate } from '../services/recalc.js';

interface EntityDef {
  table: string;
  pk?: string;
  columns: string[];
  /** Changes alter scheduling inputs: a reason is mandatory and the plan is recalculated. */
  affectsPlan?: boolean;
  order?: string;
}

export const ENTITIES: Record<string, EntityDef> = {
  users: { table: 'users', columns: ['username', 'name', 'role', 'active'], order: 'id' },
  regions: { table: 'regions', columns: ['code', 'name'] },
  customers: { table: 'customers', columns: ['name', 'country', 'region_id'], order: 'name' },
  product_types: { table: 'product_types', columns: ['code', 'name', 'family', 'item_codes', 'default_hw_revision'] },
  routing_versions: { table: 'routing_versions', affectsPlan: true, order: 'template_kind, product_type_id, version', columns: ['product_type_id', 'template_kind', 'code', 'version', 'effective_from', 'status', 'notes'] },
  routing_steps: {
    table: 'routing_steps', affectsPlan: true, order: 'routing_version_id, seq',
    columns: ['routing_version_id', 'seq', 'code', 'name', 'function', 'work_center_id', 'duration_slots', 'scope', 'stage', 'kind', 'predecessor_seqs', 'milestone_tag',
      'use_destination_calendar', 'phases', 'hold_from', 'test_plan_code', 'gate_templates'],
  },
  work_centers: { table: 'work_centers', affectsPlan: true, order: 'route_order, id', columns: ['code', 'name', 'function', 'resource_type', 'capacity', 'calendar_id', 'region', 'route_order', 'sizing_target_id', 'provisional', 'notes'] },
  resource_capacity_changes: { table: 'resource_capacity_changes', affectsPlan: true, order: 'work_center_id, effective_from', columns: ['work_center_id', 'effective_from', 'capacity', 'status', 'reason'] },
  resource_reservations: { table: 'resource_reservations', affectsPlan: true, order: 'start_slot', columns: ['work_center_id', 'start_slot', 'finish_slot', 'units', 'kind', 'reason', 'project_id', 'status'] },
  calendars: { table: 'calendars', affectsPlan: true, columns: ['code', 'name', 'country', 'working_weekdays'] },
  calendar_holidays: { table: 'calendar_holidays', affectsPlan: true, order: 'calendar_id, date', columns: ['calendar_id', 'date', 'name'] },
  weekend_authorizations: { table: 'weekend_authorizations', affectsPlan: true, order: 'date DESC', columns: ['work_center_id', 'activity_id', 'date', 'capacity', 'reason', 'active'] },
  routes: {
    table: 'routes', affectsPlan: true, order: 'code',
    columns: ['code', 'name', 'origin_country', 'destination_country', 'region_id', 'lead_time_days', 'min_days', 'max_days', 'operates_saturday', 'operates_sunday', 'holiday_calendar_ids', 'release_lag_slots', 'restrictions'],
  },
  service_profiles: {
    table: 'service_profiles', affectsPlan: true, order: 'route_id, code',
    columns: ['route_id', 'code', 'name', 'mode', 'service_level', 'internal_prep_slots', 'transit_days', 'customs_days', 'final_delivery_days', 'booking_lead_days', 'confirmation_status', 'notes'],
  },
  test_plans: { table: 'test_plans', affectsPlan: true, order: 'code, version', columns: ['code', 'name', 'version', 'scope', 'duration_slots', 'status', 'rationale'] },
  sw_components: { table: 'sw_components', columns: ['code', 'name', 'kind', 'product_family'] },
  materials: { table: 'materials', order: 'part_number', columns: ['part_number', 'description', 'critical', 'uom'] },
  bom_items: { table: 'bom_items', affectsPlan: true, order: 'product_type_id, material_id', columns: ['product_type_id', 'material_id', 'qty_per_unit', 'needed_at_code'] },
  delay_categories: { table: 'delay_categories', columns: ['code', 'name'] },
  permissions: { table: 'permissions', pk: 'action', order: 'action', columns: ['action', 'roles', 'description'] },
  settings: { table: 'settings', pk: 'key', order: 'key', affectsPlan: true, columns: ['key', 'value', 'description'] },
};

function def(name: string) {
  const d = ENTITIES[name];
  if (!d) throw new HttpError(404, `Unknown entity ${name}`);
  return d;
}

function values(d: EntityDef, body: Record<string, unknown>) {
  const cols = d.columns.filter((c) => c in body);
  return { cols, vals: cols.map((c) => (['value', 'phases', 'hold_from', 'gate_templates'].includes(c) && body[c] !== null && typeof body[c] !== 'string' ? JSON.stringify(body[c]) : body[c] === '' ? null : body[c])) };
}

export function adminRouter() {
  const r = Router();

  r.get('/:entity', async (req, res) => {
    const d = def(req.params.entity);
    const rows = await pool.query(`SELECT * FROM ${d.table} ORDER BY ${d.order ?? 'id'}`);
    res.json(rows.rows.map((x) => { delete x.password_hash; return x; }));
  });

  const mutate = async (req: any, kind: 'create' | 'update' | 'delete') => {
    const d = def(req.params.entity);
    return tx(async (c) => {
      await lockPlan(c);
      await requirePermission(c, req.user, 'admin.config');
      const reason: string | undefined = req.body?._reason;
      if (d.affectsPlan && (!reason || reason.trim().length < 3)) throw new HttpError(422, 'A reason is required for changes to planning parameters', 'REASON_REQUIRED');
      const pk = d.pk ?? 'id';
      let before: unknown = null;
      let after: unknown = null;
      let entityId: number | null = null;
      if (kind !== 'create') {
        before = (await c.query(`SELECT * FROM ${d.table} WHERE ${pk} = $1`, [req.params.id])).rows[0];
        if (!before) throw new HttpError(404, 'Not found');
      }
      if (kind === 'create') {
        const { cols, vals } = values(d, req.body);
        if (d.table === 'users') {
          cols.push('password_hash');
          vals.push(await bcrypt.hash(String(req.body.password ?? 'demo'), 10));
        }
        if (d.table === 'weekend_authorizations') { cols.push('approved_by'); vals.push(req.user.id); }
        const row = (await c.query(`INSERT INTO ${d.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals)).rows[0];
        after = row;
        entityId = typeof row.id === 'number' ? row.id : null;
      } else if (kind === 'update') {
        const { cols, vals } = values(d, req.body);
        if (d.table === 'users' && req.body.password) { cols.push('password_hash'); vals.push(await bcrypt.hash(String(req.body.password), 10)); }
        if (!cols.length) throw new HttpError(400, 'Nothing to update');
        const row = (await c.query(`UPDATE ${d.table} SET ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE ${pk} = $1 RETURNING *`, [req.params.id, ...vals])).rows[0];
        after = row;
        entityId = typeof row.id === 'number' ? row.id : null;
      } else {
        await c.query(`DELETE FROM ${d.table} WHERE ${pk} = $1`, [req.params.id]);
        entityId = typeof (before as any).id === 'number' ? (before as any).id : null;
      }
      const strip = (x: any) => (x && typeof x === 'object' ? { ...x, password_hash: undefined } : x);
      let version: number | null = null;
      if (d.affectsPlan) {
        const out = await recalculate(c, { userId: req.user.id, kind: 'CONFIG', summary: `${req.user.name} changed ${d.table}${reason ? `: ${reason}` : ''}` });
        version = out.version;
      }
      await audit(c, { userId: req.user.id, action: `admin.${d.table}.${kind}`, changeClass: 'CONFIG', entityType: d.table, entityId, planVersion: version, before: strip(before), after: strip(after), reason: reason ?? null });
      return strip(after) ?? { ok: true };
    });
  };
  r.post('/:entity', async (req, res) => res.status(201).json(await mutate(req, 'create')));
  r.put('/:entity/:id', async (req, res) => res.json(await mutate(req, 'update')));
  r.delete('/:entity/:id', async (req, res) => res.json(await mutate(req, 'delete')));
  return r;
}
