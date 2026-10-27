/**
 * Demonstration data: master data plus eight EV-charging projects. Every project is created
 * through the real planning services (Mode A backward plan at its historical order date);
 * history up to today is then executed and a few realistic execution events are recorded
 * through the same services users call.
 */
import { fileURLToPath } from 'node:url';
import { dayNumber, dayToIso, nowSlot } from '../engine/calendar.js';
import type { AuthUser } from '../services/common.js';
import { updateExecution } from '../services/execution.js';
import { createProject } from '../services/projects.js';
import { recalculate } from '../services/recalc.js';
import { commitScenario, createScenario } from '../services/scenarios.js';
import { snapshotData } from '../services/read.js';
import { migrate } from './migrate.js';
import { insertMasterData, truncateAll } from './masterData.js';
import { lockPlan, pool, tx } from './pool.js';

const iso = (d: number) => dayToIso(d);

async function setClock(ts: string | null) {
  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'clock_override'`, [JSON.stringify(ts)]);
}

async function user(username: string): Promise<AuthUser> {
  const r = await pool.query('SELECT id, username, name, role FROM users WHERE username = $1', [username]);
  return r.rows[0];
}

export async function seed({ today = dayToIso(Math.floor(nowSlot() / 2)) } = {}) {
  await migrate();
  const T = dayNumber(today);
  const ids = await tx(async (c) => { await truncateAll(c); return insertMasterData(c); });
  const commercial = await user('commercial');
  const program = await user('program');

  const P = ids.products;
  const C = ids.customers;
  const R = ids.routes;
  const projects: { code: string; name: string; customer: string; site: string; country: string; route: string; created: number; required: number; lines: [number, number][]; notes?: string }[] = [
    { code: 'P01', name: 'Kassel Autobahn Hub', customer: 'Voltway GmbH', site: 'Kassel Ost, A7', country: 'DE', route: 'IT-DE', created: T - 30, required: T + 13, lines: [[P.X800, 2], [P.POLLUX, 4]] },
    { code: 'P02', name: 'Lyon Part-Dieu Fast Charging', customer: 'Charge&Go SAS', site: 'Lyon', country: 'FR', route: 'IT-FR', created: T - 26, required: T + 12, lines: [[P.X800, 1], [P.POLLUX, 2]] },
    { code: 'P03', name: 'Denver Bus Depot Phase 1', customer: 'MetroFleet Transit Inc.', site: 'Denver, CO', country: 'US', route: 'IT-US', created: T - 21, required: T + 33, lines: [[P.X800, 2], [P.POLLUX, 2]] },
    { code: 'P04', name: 'Rotterdam Port Logistics', customer: 'Sunrise Logistics B.V.', site: 'Maasvlakte, Rotterdam', country: 'NL', route: 'IT-NL', created: T - 16, required: T + 52, lines: [[P.X800, 3], [P.POLLUX, 6]] },
    { code: 'P05', name: 'Innsbruck Brenner Plaza', customer: 'Alpine Energie AG', site: 'Innsbruck', country: 'AT', route: 'IT-AT', created: T - 9, required: T + 56, lines: [[P.X1200, 1], [P.VEGA, 2]] },
    { code: 'P06', name: 'Columbus Transit Depot', customer: 'Lakeside Bus Authority', site: 'Columbus, OH', country: 'US', route: 'IT-US', created: T - 5, required: T + 80, lines: [[P.X800, 4], [P.POLLUX, 4]] },
    { code: 'P07', name: 'A1 Service Areas Bologna', customer: 'Autostrade Elettriche S.p.A.', site: 'Bologna', country: 'IT', route: 'IT-IT', created: T - 2, required: T + 86, lines: [[P.X1200, 2], [P.VEGA, 4]] },
    { code: 'P08', name: 'Hamburg Harbour Fleet', customer: 'Voltway GmbH', site: 'Hamburg', country: 'DE', route: 'IT-DE', created: T - 1, required: T + 26, lines: [[P.X800, 2], [P.POLLUX, 4]], notes: 'Customer asked for very short lead time' },
  ];
  const pid: Record<string, number> = {};
  for (const p of projects) {
    await setClock(`${iso(p.created)}T09:00:00+01:00`);
    const out = await tx(async (c) => {
      await lockPlan(c);
      return createProject(c, commercial, {
        code: p.code, name: p.name, customerId: C[p.customer], siteLocation: p.site, country: p.country, routeId: R[p.route],
        requiredDate: iso(p.required), notes: p.notes, lines: p.lines.map(([productTypeId, quantity]) => ({ productTypeId, quantity })),
      });
    });
    pid[p.code] = out.projectId;
    console.log(`  ${p.code} planned (${out.feasible ? 'feasible' : 'INFEASIBLE'})`);
  }

  // Execute history up to yesterday evening exactly as planned.
  await setClock(null);
  await setClock(`${iso(T)}T08:30:00+01:00`);
  const now = T * 2;
  await tx(async (c) => {
    await lockPlan(c);
    await c.query(`UPDATE activities SET status = 'COMPLETED', actual_start = approved_start, actual_finish = approved_finish, pct_complete = 100,
      updated_by = NULL WHERE approved_finish <= $1`, [now]);
    await c.query(`UPDATE activities SET status = 'IN_PROGRESS', actual_start = approved_start, pct_complete = 40 WHERE approved_start < $1 AND approved_finish > $1`, [now]);
    await recalculate(c, { userId: null, kind: 'SEED_HISTORY', summary: 'Execution history loaded', quiet: true });
  });

  // Previous daily call (yesterday) — later updates show up as "changes since previous call".
  const snap = await pool.query(`INSERT INTO plan_snapshots (label, kind, plan_version, created_by, data, created_at)
    VALUES ($1, 'DAILY_CALL', (SELECT MAX(id) FROM plan_versions), $2, $3, $4) RETURNING id`,
  [`Daily call ${iso(T - 1)}`, program.id, JSON.stringify(await snapshotData(pool)), `${iso(T - 1)}T09:00:00+01:00`]);
  await pool.query(`INSERT INTO decisions (snapshot_id, project_id, text, owner, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [snap.rows[0].id, pid.P04, 'Confirm DC contactor delivery date with supplier before releasing remaining P04 cabinets to FA', 'Purchasing / M. Bianchi', program.id, `${iso(T - 1)}T09:40:00+01:00`]);

  // Realistic execution events recorded through the services.
  const act = async (code: string, unitSeq: number, step: string, statuses = ['IN_PROGRESS', 'READY', 'NOT_STARTED']) =>
    (await pool.query(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = $1 AND a.unit_seq = $2 AND a.code = $3 AND a.status = ANY($4)`,
      [code, unitSeq, step, statuses])).rows[0];
  const exec = async (username: string, a: any, input: any) => {
    if (!a) return;
    const u = await user(username);
    try {
      await tx(async (c) => { await lockPlan(c); return updateExecution(c, u, a.id, input); });
    } catch (e) {
      console.warn(`  skipped event on ${a.name}: ${(e as Error).message}`);
    }
  };
  // 1. Open blocker on an in-flight cabinet
  const p04eol = (await pool.query(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'P04' AND a.status IN ('IN_PROGRESS','READY','NOT_STARTED')
    AND a.code IN ('FA','EOL','SUB_TEST','SUB_PROG','PCBA_TEST','SUB_MFG') ORDER BY a.forecast_start, a.unit_seq LIMIT 1`)).rows[0];
  await exec(p04eol?.function === 'MANUFACTURING' ? 'mfg' : 'test', p04eol, {
    status: 'BLOCKED', blocker: 'DC contactor (K1) missing — supplier shipment delayed at customs', delayReason: 'Material shortage: DC contactor K1 not delivered', delayCategory: 'MATERIAL',
    ...(p04eol?.status === 'IN_PROGRESS' ? {} : {}),
  });
  // 2. Validation finding extends a P03 cabinet by 2 working days
  const p03val = (await pool.query(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE a.code = 'VAL' AND a.status IN ('IN_PROGRESS','READY')
    ORDER BY (a.status = 'IN_PROGRESS') DESC, p.priority LIMIT 1`)).rows[0];
  if (p03val) {
    if (p03val.status !== 'IN_PROGRESS') {
      // start it if its predecessors are complete
      await exec('rnd', p03val, { status: 'IN_PROGRESS' });
    }
    await exec('rnd', p03val, { expectedFinish: (p03val.forecast_finish ?? now) + 4, delayReason: 'OCPP 2.0.1 firmware regression found during validation; patched build under retest', delayCategory: 'ENGINEERING' });
  }
  // 3. PCBA test delay on a P06 cabinet (Test B style)
  const p06pcba = await act('P06', 1, 'PCBA_TEST');
  await exec('test', p06pcba, { reportDelay: true, expectedFinish: (p06pcba?.forecast_finish ?? now) + 4, delayReason: 'ICT fixture calibration out of tolerance; retest of PCBA lot required', delayCategory: 'QUALITY' });
  // 4. Progress updates on P01
  const p01 = await pool.query(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE p.code = 'P01' AND a.status = 'IN_PROGRESS' ORDER BY a.forecast_finish LIMIT 2`);
  for (const a of p01.rows) await exec(a.function === 'RND' ? 'rnd' : a.function === 'TESTING' ? 'test' : a.function === 'SERVICE' ? 'service' : a.function === 'LOGISTICS' ? 'logistics' : 'mfg', a, { pctComplete: 80, comment: 'On track, finishing this shift' });

  // 5. Weekend work authorized for EOL testing next Saturday (committed by Program Management)
  const sat = T + ((6 - ((T + 4) % 7) + 7) % 7 || 7);
  await tx(async (c) => {
    await lockPlan(c);
    const sc = await createScenario(c, program, { name: 'Saturday EOL shift', description: 'Recover EOL backlog with a Saturday shift', ops: [{ type: 'weekend_work', workCenterId: ids.wc.EOL, date: iso(sat), capacity: 1.5 }], source: 'DAILY_CALL' });
    await commitScenario(c, program, sc.id, { justification: 'Recover EOL backlog caused by the K1 contactor shortage; overtime approved by plant manager', confirmLatest: true });
  });
  // 6. Commercial proposes moving P05 to the top of the ranking (pending approval if frozen projects are hit)
  await tx(async (c) => {
    await lockPlan(c);
    const sc = await createScenario(c, commercial, { name: 'Expedite Innsbruck (P05)', description: 'Customer requests earlier opening of the Brenner plaza', ops: [{ type: 'move_priority', projectId: pid.P05, toRank: 1 }] });
    await commitScenario(c, commercial, sc.id, { justification: 'Customer escalation', confirmLatest: true }).catch((e) => console.warn('  P05 scenario:', e.message));
  });

  await setClock(null);
  console.log('Seed complete.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
