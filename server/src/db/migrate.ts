import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = 4;

/**
 * Apply the schema. A V3 database (no schema_version) cannot be converted automatically because
 * V4 introduces systems, shipments manifests and site visits; demo databases are reset (and then
 * re-seeded), anything else is refused with instructions.
 */
export async function migrate() {
  const sqlPath = [join(here, 'schema.sql'), join(here, '../../../src/db/schema.sql')].find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  })!;
  const hasSettings = (await pool.query(`SELECT to_regclass('public.settings') AS t`)).rows[0].t !== null;
  if (hasSettings) {
    const v = await pool.query(`SELECT value FROM settings WHERE key = 'schema_version'`);
    const version = v.rows[0] ? Number(v.rows[0].value) : 3;
    if (version < SCHEMA_VERSION) {
      const demo = (await pool.query(`SELECT value FROM settings WHERE key = 'demo_mode'`)).rows[0]?.value === true;
      if (!demo && process.env.RESET_DB_ON_UPGRADE !== '1') {
        throw new Error(`Database schema version ${version} found; version ${SCHEMA_VERSION} requires a fresh database. Back up your data and start with RESET_DB_ON_UPGRADE=1.`);
      }
      console.log(`Upgrading schema ${version} → ${SCHEMA_VERSION}: resetting the database (demo data will be reloaded).`);
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
  }
  await pool.query(readFileSync(sqlPath, 'utf8'));
  await pool.query(`INSERT INTO settings (key, value, description) VALUES ('schema_version', $1, 'Database schema version')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(SCHEMA_VERSION)]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => { console.log('Schema migrated'); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
