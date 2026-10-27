import pg from 'pg';

// numeric columns come back as strings by default; capacities are small decimals.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// date columns stay ISO strings (no time-zone shifting).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://evplan:evplan@localhost:5432/evplan';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export type Db = pg.PoolClient | pg.Pool;

const afterCommitHooks = new WeakMap<pg.PoolClient, (() => void)[]>();

/** Run `fn` once the surrounding transaction has committed (e.g. real-time broadcasts). */
export function afterCommit(c: pg.PoolClient, fn: () => void) {
  const l = afterCommitHooks.get(c) ?? [];
  l.push(fn);
  afterCommitHooks.set(c, l);
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  afterCommitHooks.delete(c);
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    const hooks = afterCommitHooks.get(c) ?? [];
    afterCommitHooks.delete(c);
    for (const h of hooks) {
      try { h(); } catch (e) { console.error(e); }
    }
    return r;
  } catch (e) {
    afterCommitHooks.delete(c);
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Serialize all plan mutations (recalculations are global). */
export async function lockPlan(c: pg.PoolClient) {
  await c.query('SELECT pg_advisory_xact_lock(424242)');
}
