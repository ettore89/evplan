/**
 * Removal of the demonstration data. Everything the demo seed created goes — projects with their units,
 * activities and actions, and the demo side data that would otherwise distort a real plan: software
 * approvals, stock and purchase orders, BOM lines, resource reservations, issues, scenarios, the demo
 * "previous daily call" and the fictional customers. Master data, users and the audit trail stay.
 *
 * New seeds record their ids in settings.demo_records. Databases seeded by an earlier version are
 * cleaned using the fingerprints of that seed.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { audit, requirePermission, type AuthUser } from './common.js';

export const DEMO_TABLES = ['sw_releases', 'issues', 'resource_reservations', 'material_stock', 'material_receipts', 'bom_items', 'plan_snapshots', 'scenarios', 'customers', 'units'] as const;
type DemoRecords = Partial<Record<(typeof DEMO_TABLES)[number], number[]>>;

/** Called at the end of the seed: remember every demo record outside the demo projects. */
export async function recordDemoData(db: Db) {
  const rec: DemoRecords = {};
  for (const t of DEMO_TABLES) {
    rec[t] = (await db.query(`SELECT id FROM ${t}${t === 'units' ? ` WHERE project_id IS NULL` : ''}`)).rows.map((r) => r.id);
  }
  await db.query(`INSERT INTO settings (key, value, description) VALUES ('demo_records', $1, 'Records created by the demonstration seed (removed together with the demo projects)')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(rec)]);
}

/** Fingerprints of the demo seed of earlier versions (databases seeded before demo_records existed). */
async function legacyDemoRecords(c: pg.PoolClient): Promise<DemoRecords> {
  const ids = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows.map((r) => r.id as number);
  const seedStart = (await c.query(`SELECT min(created_at) t FROM projects WHERE source = 'DEMO'`)).rows[0]?.t;
  if (!seedStart) return {};
  const win = [seedStart, seedStart];
  return {
    sw_releases: await ids(`SELECT r.id FROM sw_releases r JOIN users u ON u.id = r.created_by WHERE u.username = 'techauth'
      AND r.created_at BETWEEN $1::timestamptz - interval '15 minutes' AND $2::timestamptz + interval '15 minutes'
      AND (EXISTS (SELECT 1 FROM sw_release_approvals a WHERE a.release_id = r.id AND a.basis_ref LIKE 'Validation report VR-%') OR r.notes = 'Announced in the program meeting; availability not yet confirmed')`, win),
    issues: await ids(`SELECT id FROM issues WHERE external_ref = 'ADO-4711' AND title = 'Cable cooler pump noise above limit'`),
    resource_reservations: await ids(`SELECT id FROM resource_reservations WHERE reason IN ('Handling crew assigned to the site-controller retrofit', 'R&D troubleshooting of the DC-bus controller on the shared supply')`),
    material_stock: await ids(`SELECT s.id FROM material_stock s JOIN materials m ON m.id = s.material_id WHERE s.location = 'Main warehouse' AND m.part_number IN ('K1-DC-CONT','CAB-COOLER')
      AND s.as_of BETWEEN $1::timestamptz - interval '15 minutes' AND $2::timestamptz + interval '15 minutes'`, win),
    material_receipts: await ids(`SELECT id FROM material_receipts WHERE po_ref IN ('PO-450011','PO-450037','PO-450052')`),
    bom_items: await ids(`SELECT b.id FROM bom_items b JOIN materials m ON m.id = b.material_id JOIN product_types p ON p.id = b.product_type_id
      WHERE (m.part_number = 'K1-DC-CONT' AND p.code IN ('X800','X1200')) OR (m.part_number = 'CAB-COOLER' AND p.code = 'X800')`),
    plan_snapshots: await ids(`SELECT id FROM plan_snapshots WHERE label LIKE 'Daily call %' AND created_at < $1::timestamptz + interval '15 minutes'`, [seedStart]),
    scenarios: await ids(`SELECT id FROM scenarios WHERE name IN ('Borrow evaluation dispenser for P03', 'Expedite Innsbruck (P05)', 'Reduced validation for P05', 'Saturday EOL shift')`),
    customers: await ids(`SELECT id FROM customers WHERE name IN ('Voltway GmbH','Charge&Go SAS','MetroFleet Transit Inc.','Sunrise Logistics B.V.','Alpine Energie AG','Lakeside Bus Authority','Autostrade Elettriche S.p.A.','Helvetia Bus AG')`),
    units: await ids(`SELECT id FROM units WHERE project_id IS NULL AND source = 'DEMO'`),
  };
}

export async function demoDataSummary(db: Db) {
  const projects = Number((await db.query(`SELECT count(*) n FROM projects WHERE source = 'DEMO'`)).rows[0].n);
  return { projects };
}

export async function removeDemoData(c: pg.PoolClient, user: AuthUser, opts: { viaImport?: number } = {}) {
  if (!opts.viaImport) await requirePermission(c, user, 'admin.config', 'Removing the demo data requires Management / Program');
  const stored = (await c.query(`SELECT value FROM settings WHERE key = 'demo_records'`)).rows[0]?.value as DemoRecords | undefined;
  const rec = stored ?? await legacyDemoRecords(c);
  const projects = (await c.query(`DELETE FROM projects WHERE source = 'DEMO' RETURNING id, code`)).rows;
  const removed: Record<string, number> = { projects: projects.length };
  const del = async (table: string, ids: number[] | undefined, extra = '') => {
    if (!ids?.length) return;
    removed[table] = (await c.query(`DELETE FROM ${table} WHERE id = ANY($1) ${extra}`, [ids])).rowCount ?? 0;
  };
  // Software: demo releases are no longer the production target; units keep nothing installed from them.
  if (rec.sw_releases?.length) {
    await c.query('UPDATE sw_components SET production_release_id = NULL WHERE production_release_id = ANY($1)', [rec.sw_releases]);
    await c.query('UPDATE test_records SET sw_release_id = NULL WHERE sw_release_id = ANY($1)', [rec.sw_releases]);
    await c.query('DELETE FROM unit_software WHERE release_id = ANY($1)', [rec.sw_releases]);
  }
  await del('units', rec.units);
  await c.query(`DELETE FROM units WHERE project_id IS NULL AND source = 'DEMO'`);
  await del('sw_releases', rec.sw_releases);
  await del('issues', rec.issues);
  await del('resource_reservations', rec.resource_reservations);
  await del('material_receipts', rec.material_receipts);
  await del('material_stock', rec.material_stock);
  await del('bom_items', rec.bom_items);
  await del('plan_snapshots', rec.plan_snapshots);
  await del('scenarios', rec.scenarios);
  await del('customers', rec.customers, 'AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.customer_id = customers.id)');
  await c.query(`DELETE FROM settings WHERE key = 'demo_records'`);
  await audit(c, { userId: user.id, action: 'demo.remove', changeClass: 'CONFIG', entityType: 'demo_data', after: { removed, projects: projects.map((p) => p.code), viaImport: opts.viaImport ?? null },
    reason: opts.viaImport ? `Ramp-up tracker import #${opts.viaImport}` : 'Demo data removed' });
  return removed;
}
