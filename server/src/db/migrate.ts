import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sqlPath = [join(here, 'schema.sql'), join(here, '../../../src/db/schema.sql')].find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  })!;
  await pool.query(readFileSync(sqlPath, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => { console.log('Schema migrated'); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
}
