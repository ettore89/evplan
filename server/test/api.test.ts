/**
 * API-level acceptance tests against a real PostgreSQL database (DATABASE_URL_TEST,
 * default postgres://evplan:evplan@localhost:5432/evplan_test). Business rules are exercised through
 * the HTTP API so role, readiness and freeze enforcement are backend-verified. Section M contains the
 * acceptance tests derived from the program meetings (V4).
 */
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { trackerWorkbook } from './trackerFixture.js';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgres://evplan:evplan@localhost:5432/evplan_test';

let app: any;
let server: Server;
let pool: any;
const tokens: Record<string, string> = {};
const CLOCK = '2026-11-02T08:00:00+01:00'; // Monday AM
let ids: any;

const as = (u: string) => ({ Authorization: `Bearer ${tokens[u]}` });
async function setClock(ts: string) {
  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'clock_override'`, [JSON.stringify(ts)]);
}
async function createProject(code: string, required: string | null, lines: [string, number][], extra: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/projects').set(as('commercial')).send({
    code, name: `Project ${code}`, customerId: ids.customers['Voltway GmbH'], siteLocation: 'Kassel', country: 'DE', routeId: ids.routes['IT-DE'],
    requiredDate: required, lines: lines.map(([p, q]) => ({ productTypeId: ids.products[p], quantity: q })), ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function details(projectId: number) {
  return (await request(app).get(`/api/projects/${projectId}`).set(as('program'))).body;
}
const roleFor: Record<string, string> = { MANUFACTURING: 'mfg', TESTING: 'test', RND: 'rnd', LOGISTICS: 'logistics', SERVICE: 'service' };
const exec = (a: any, body: any, who?: string) => request(app).patch(`/api/activities/${a.id}/execution`).set(as(who ?? roleFor[a.function])).send(body);

beforeAll(async () => {
  const db = await import('../src/db/pool.js');
  pool = db.pool;
  const { migrate } = await import('../src/db/migrate.js');
  const md = await import('../src/db/masterData.js');
  await migrate();
  ids = await db.tx(async (c: any) => { await md.truncateAll(c); return md.insertMasterData(c); });
  await setClock(CLOCK);
  // Production software releases (approved for production, artifacts available) so readiness is firm by default.
  const { approveRelease, markArtifactAvailable, upsertRelease } = await import('../src/services/software.js');
  const ta = (await pool.query(`SELECT id, username, name, role FROM users WHERE username = 'techauth'`)).rows[0];
  await db.tx(async (c: any) => {
    for (const code of ['BOARD_FW', 'SYS_SW']) {
      const comp = (await c.query('SELECT id FROM sw_components WHERE code = $1', [code])).rows[0].id;
      const id = await upsertRelease(c, ta, { componentId: comp, version: '1.0.0', stage: 'IN_VALIDATION' });
      await approveRelease(c, ta, id, { scope: 'PRODUCTION', basisRef: 'VR-1', makeProductionTarget: true });
      await markArtifactAvailable(c, ta, id, { artifactRef: 'pkg-1.0.0' });
    }
  });
  const { createApp } = await import('../src/app.js');
  const { attachRealtime } = await import('../src/services/realtime.js');
  app = createApp();
  server = createServer(app);
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  for (const u of ['mfg', 'test', 'rnd', 'logistics', 'commercial', 'service', 'program', 'program2', 'techauth', 'quality']) {
    const r = await request(app).post('/api/auth/login').send({ username: u, password: 'demo' });
    tokens[u] = r.body.token;
  }
});

afterAll(async () => {
  server?.close();
  await pool?.end();
});

describe('Core planning rules', () => {
  let main: any;

  it('A — a project is planned as physical units, complete systems, a shipment and a site visit', async () => {
    main = await createProject('A01', '2027-02-26', [['X800', 2], ['POLLUX', 4]]);
    expect(main.feasible).toBe(true);
    const d = await details(main.projectId);
    expect(d.units).toHaveLength(6);
    for (const u of d.units) expect(u.internalId).toMatch(/^EVU-\d{6}$/);
    expect(d.systems).toHaveLength(2);
    expect(d.shipments).toHaveLength(1);
    expect(d.visits).toHaveLength(1);
    const by = (code: string) => d.activities.filter((a: any) => a.code === code);
    expect(by('VAL')).toHaveLength(2); // one validation per complete system, not per unit
    for (const v of by('VAL')) expect(v.scope).toBe('SYSTEM');
    expect(by('TRANSIT')).toHaveLength(1);
    expect(by('INSTALL')).toHaveLength(1);
    expect(by('COMM')).toHaveLength(2);
    expect(by('EOL')).toHaveLength(6);
    for (const a of d.activities) expect(a.forecastStart).toBe(a.approvedStart);
    expect(d.commitments.filter((c: any) => c.kind === 'BASELINE').length).toBeGreaterThanOrEqual(3);
  });

  it('enforces role authority in the backend', async () => {
    const d = await details(main.projectId);
    const eol = d.activities.find((a: any) => a.code === 'EOL');
    expect((await exec(eol, { comment: 'hi' }, 'mfg')).status).toBe(403);
    const r2 = await request(app).post('/api/scenarios').set(as('commercial')).send({ name: 'x', ops: [{ type: 'set_capacity', workCenterId: ids.wc.EOL_POS, capacity: 3 }] });
    expect(r2.status).toBe(403);
    const r3 = await request(app).post('/api/projects').set(as('test')).send({});
    expect([400, 403]).toContain(r3.status);
  });

  it('F — a delay needs a reason and keeps root-cause traceability', async () => {
    const d = await details(main.projectId);
    const pcba = d.activities.find((a: any) => a.code === 'PCBA_TEST' && a.unitSeq === 1);
    const bad = await exec(pcba, { expectedFinish: pcba.forecastFinish + 4 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('DELAY_REASON_REQUIRED');
    const ok = await exec(pcba, { expectedFinish: pcba.forecastFinish + 4, delayReason: 'ICT fixture out of calibration', delayCategory: 'QUALITY' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const root = (await pool.query('SELECT * FROM delay_events WHERE id = $1', [ok.body.delayEventId])).rows[0];
    expect(root.kind).toBe('ROOT');
    expect(root.reason).toBe('ICT fixture out of calibration');
    const after = await details(main.projectId);
    const succ = after.activities.find((a: any) => a.code === 'SUB_MFG' && a.unitSeq === 1);
    expect(succ.forecastStart).toBeGreaterThanOrEqual(pcba.forecastFinish + 4);
  });

  it('C — EOL positions and the shared power tester are never over-booked', async () => {
    const r = await pool.query(`SELECT work_center_id, slot, SUM(load) AS load FROM reservations WHERE work_center_id = ANY($1) GROUP BY 1, 2`, [[ids.wc.EOL_POS, ids.wc.EOL_HV]]);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(Number(row.load)).toBeLessThanOrEqual(row.work_center_id === ids.wc.EOL_POS ? 2 : 1);
    const prov = (await pool.query(`SELECT value FROM settings WHERE key = 'eol_resource_profile'`)).rows[0].value;
    expect(prov.status).toBe('PROVISIONAL');
  });

  it('D — rejects a fourth simultaneous system in Final Assembly', async () => {
    const p = await createProject('D01', '2027-04-15', [['X800', 4]]);
    const d = await details(p.projectId);
    const fa = d.activities.filter((a: any) => a.code === 'FA');
    const nwd = (await request(app).get('/api/gantt').set(as('program'))).body.nonWorkingDays;
    let slot = Math.max(...fa.map((a: any) => a.forecastStart)) + 20;
    while (nwd.includes(Math.floor(slot / 2))) slot += 2;
    const mk = (n: number) => fa.slice(0, n).map((a: any) => ({ type: 'move_activity', activityId: a.id, start: slot }));
    const three = await request(app).post('/api/simulate').set(as('program')).send({ ops: mk(3) });
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    expect(three.body.violations, JSON.stringify(three.body.violations)).toEqual([]);
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'four in FA', ops: mk(4) });
    expect(sc.body.result.violations.length).toBeGreaterThan(0);
    const commit = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'test' });
    expect(commit.status).toBe(422);
    expect(commit.body.code).toBe('INVALID_SCHEDULE');
  });

  it('G — the freeze needs Management approval for consequential changes but never blocks execution updates', async () => {
    const f = await createProject('G01', '2026-11-27', [['X800', 1], ['POLLUX', 1]]);
    const pf = await request(app).get('/api/portfolio').set(as('commercial'));
    const g = pf.body.projects.find((p: any) => p.id === f.projectId);
    expect(g.freeze.frozen).toBe(true);
    const sc = await request(app).post('/api/scenarios').set(as('commercial')).send({ name: 'G01 to top', ops: [{ type: 'move_priority', projectId: f.projectId, toRank: 1 }] });
    expect(sc.status).toBe(201);
    expect(sc.body.result.requiresManagement).toBe(true);
    const c1 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('commercial')).send({ justification: 'customer escalation' });
    expect(c1.status).toBe(202);
    const c2 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({});
    expect(c2.status).toBe(422);
    expect(c2.body.code).toBe('JUSTIFICATION_REQUIRED');
    const c3 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Approved in daily call: customer opening event', confirmLatest: true });
    expect(c3.status, JSON.stringify(c3.body)).toBe(200);
    const d = await details(f.projectId);
    const first = d.activities.find((a: any) => a.code === 'PCBA_MFG' && a.unitSeq === 1);
    const ex = await exec(first, { reportDelay: true, expectedFinish: first.forecastFinish + 6, delayReason: 'SMT line stop — reflow oven repair', delayCategory: 'RESOURCE' });
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    const after = await details(f.projectId);
    const exw = after.summary.milestones.find((m: any) => m.type === 'EXW');
    expect(exw.forecast).toBeGreaterThan(exw.latestApproved);
    expect(exw.delay?.reason).toBe('SMT line stop — reflow oven repair');
  });

  it('H — live call: a committed move is visible to a second user immediately', async () => {
    const port = (server.address() as AddressInfo).port;
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tokens.test}`);
    const wsProg = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tokens.program}`);
    ws.on('message', (m) => received.push(JSON.parse(String(m))));
    await Promise.all([new Promise((r) => ws.on('open', r)), new Promise((r) => wsProg.on('open', r))]);
    const d = await details(main.projectId);
    const pack = d.activities.find((a: any) => a.code === 'PACK' && a.unitSeq === 3);
    const g0 = await request(app).get('/api/gantt').set(as('program'));
    let newStart = pack.forecastStart + 4;
    while (g0.body.nonWorkingDays.includes(Math.floor(newStart / 2))) newStart++;
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'Move packaging', ops: [{ type: 'move_activity', activityId: pack.id, start: newStart }], source: 'DAILY_CALL' });
    const commit = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Packaging crew reassigned to urgent order', confirmLatest: true });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(received.find((m) => m.type === 'plan.updated' && m.version === commit.body.version)).toBeTruthy();
    const g = await request(app).get('/api/gantt').set(as('test'));
    const moved = g.body.activities.find((a: any) => a.id === pack.id);
    expect(moved.approvedStart).toBe(newStart);
    expect(moved.locked).toBe(true);
    expect(received.some((m) => m.type === 'presence' && m.users.length >= 2)).toBe(true);
    ws.close(); wsProg.close();
  });

  it('K — identical units are planned individually without quantity efficiencies', async () => {
    const p = await createProject('K01', '2027-05-28', [['X800', 3]]);
    const d = await details(p.projectId);
    const fa = d.activities.filter((a: any) => a.code === 'FA');
    expect(fa).toHaveLength(3);
    for (const a of fa) expect(a.durationSlots).toBe(1);
    const r = await pool.query(`SELECT SUM(load)::float AS l FROM reservations WHERE activity_id = ANY($1) AND work_center_id = $2`, [fa.map((a: any) => a.id), ids.wc.FA]);
    expect(r.rows[0].l).toBe(3);
  });
});

describe('Meeting-derived acceptance tests (V4)', () => {
  it('M1 — a part missing from the BOM raises a BOM correction and a gate on the first operation; supply is never allocated twice', async () => {
    const p = await createProject('M01', '2027-04-30', [['X800', 1], ['POLLUX', 1]]);
    const d = await details(p.projectId);
    const m = await request(app).post('/api/materials').set(as('program')).send({ partNumber: 'TST-CONV', description: 'Test media converter' });
    expect(m.status).toBe(201);
    const rc = await request(app).post('/api/materials/receipts').set(as('program')).send({ materialId: m.body.id, qty: 1, expectedDate: '2026-11-20', dateConfirmed: true, poRef: 'PO-T1' });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const reqs = [];
    for (const u of d.units) {
      const r = await request(app).post('/api/materials/requirements').set(as('program')).send({ materialId: m.body.id, qty: 1, unitId: u.id, neededAtCode: 'FA', reason: 'Fiber site' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.outsideBom).toBe(true);
      expect(r.body.bomCorrectionActionId).toBeTruthy();
      reqs.push(r.body);
    }
    const alloc = await pool.query(`SELECT COALESCE(SUM(qty),0)::float s FROM material_allocations WHERE requirement_id = ANY($1)`, [reqs.map((r) => r.requirementId)]);
    expect(alloc.rows[0].s).toBe(1);
    const gates = (await pool.query(`SELECT g.status, a.code FROM readiness_gates g JOIN activities a ON a.id = g.activity_id WHERE g.id = ANY($1) ORDER BY g.id`, [reqs.map((r) => r.gateId)])).rows;
    expect(gates.map((g: any) => g.code)).toEqual(['FA', 'FA']);
    expect(gates.map((g: any) => g.status).sort()).toEqual(['BLOCKED', 'PENDING']);
    const actions = (await pool.query(`SELECT * FROM action_items WHERE kind = 'BOM_CORRECTION' AND project_id = $1`, [p.projectId])).rows;
    expect(actions).toHaveLength(2);
    const bom = await pool.query('SELECT 1 FROM bom_items WHERE material_id = $1', [m.body.id]);
    expect(bom.rows).toHaveLength(0); // the engineering BOM is never changed silently
  });

  it('M2 — an announced firmware never satisfies the gate; EOL cannot complete until it is approved, available and installed', async () => {
    const p = await createProject('M02', '2027-04-30', [['X800', 1]]);
    const d = await details(p.projectId);
    const comp = (await pool.query(`SELECT id FROM sw_components WHERE code = 'SYS_SW'`)).rows[0].id;
    const rel = await request(app).post('/api/software/releases').set(as('techauth')).send({ componentId: comp, version: '1.1.0', expectedAvailableDate: '2026-11-20', notes: 'announced' });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    const relId = rel.body.result;
    const eol = d.activities.find((a: any) => a.code === 'EOL');
    await pool.query(`UPDATE readiness_gates SET spec = spec || $2 WHERE activity_id = $1 AND source_type = 'SOFTWARE'`, [eol.id, JSON.stringify({ releaseId: relId })]);
    await request(app).post('/api/recalculate').set(as('program')).send({});
    const gate = (await pool.query(`SELECT * FROM readiness_gates WHERE activity_id = $1 AND source_type = 'SOFTWARE'`, [eol.id])).rows[0];
    expect(gate.status).toBe('PENDING');
    expect(gate.forecast_slot).toBeTruthy();
    // Execute everything up to EOL, then try to complete EOL.
    await setClock('2027-04-28T18:00:00+02:00');
    for (const a of d.activities.filter((x: any) => x.scope === 'UNIT' && x.seq < 80).sort((x: any, y: any) => x.seq - y.seq)) {
      const r = await exec(a, { status: 'COMPLETED', actualStart: a.approvedStart, actualFinish: a.approvedFinish });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const st = await exec(eol, { status: 'IN_PROGRESS', pctComplete: 80 });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const done = await exec(eol, { status: 'COMPLETED', testOutcome: 'PASS', evidenceRef: 'EOL-1' });
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('GATE_OPEN');
    // approve + artifact + install with checks → completes
    expect((await request(app).post(`/api/software/releases/${relId}/approve`).set(as('techauth')).send({ scope: 'PRODUCTION', basisRef: 'VR-1.1' })).status).toBe(200);
    expect((await request(app).post(`/api/software/releases/${relId}/artifact`).set(as('techauth')).send({ artifactRef: 'pkg-1.1.0' })).status).toBe(200);
    const ok = await exec(eol, { status: 'COMPLETED', testOutcome: 'PASS', evidenceRef: 'EOL-1', softwareInstalled: { releaseId: relId, checksPassed: true },
      delayReason: 'Waited for system software 1.1.0 availability', delayCategory: 'ENGINEERING' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await setClock(CLOCK);
  });

  it('M3 — a borrowed unit: simulation shows donor and recipient impacts; the swap keeps traceability', async () => {
    const donor = await createProject('M03D', '2027-05-14', [['X800', 1], ['POLLUX', 1]]);
    const recip = await createProject('M03R', '2027-03-05', [['X800', 1], ['POLLUX', 1]]);
    const dd = await details(donor.projectId);
    const rd = await details(recip.projectId);
    const unit = dd.units.find((u: any) => u.productCode === 'POLLUX');
    const failed = rd.units.find((u: any) => u.productCode === 'POLLUX');
    const op = { type: 'reassign_unit', unitId: unit.id, toProjectId: recip.projectId, replacesUnitId: failed.id, reason: 'Protect recipient delivery' };
    const sim = await request(app).post('/api/simulate').set(as('program')).send({ ops: [op] });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect(sim.body.impactedProjects).toEqual(expect.arrayContaining([donor.projectId]));
    const still = await pool.query('SELECT project_id FROM units WHERE id = $1', [unit.id]);
    expect(still.rows[0].project_id).toBe(donor.projectId); // simulation rolls back
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'Borrow dispenser', ops: [op] });
    const c = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Approved swap', confirmLatest: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const moved = (await pool.query('SELECT * FROM units WHERE id = $1', [unit.id])).rows[0];
    expect(moved.project_id).toBe(recip.projectId);
    expect(moved.internal_id).toBe(unit.internalId); // identity stays with the physical unit
    const hist = (await pool.query(`SELECT event FROM unit_history WHERE unit_id = ANY($1)`, [[unit.id, failed.id]])).rows.map((r: any) => r.event);
    expect(hist).toEqual(expect.arrayContaining(['SWAP_OUT']));
    const donorAfter = await details(donor.projectId);
    expect(donorAfter.units.filter((u: any) => u.status === 'ACTIVE' && u.productCode === 'POLLUX')).toHaveLength(1); // replacement flow created
  });

  it('M4/M5 — non-production occupancy of the removal crew or shared R&D supply delays the dependent work', async () => {
    const p = await createProject('M04', '2027-03-19', [['X800', 1], ['POLLUX', 1]]);
    const d = await details(p.projectId);
    const val = d.activities.find((a: any) => a.code === 'VAL');
    const rem = d.activities.find((a: any) => a.code === 'VAL_REMOVE');
    const sim = await request(app).post('/api/simulate').set(as('program')).send({ ops: [
      { type: 'add_reservation', workCenterId: ids.wc.HANDLING, start: rem.forecastStart - 2, finish: rem.forecastStart + 4, units: 1, kind: 'MAINTENANCE', reason: 'Crew on retrofit' },
      { type: 'add_reservation', workCenterId: ids.wc.SKID_SUPPLY, start: val.forecastStart, finish: val.forecastStart + 2, units: 2, kind: 'TROUBLESHOOTING', reason: 'Debug on shared supply' },
    ] });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    const ch = sim.body.changedActivities.filter((x: any) => x.projectId === p.projectId);
    expect(ch.some((x: any) => x.name.startsWith('System validation'))).toBe(true);
    expect(ch.some((x: any) => x.name.startsWith('Packaging'))).toBe(true);
  });

  it('M6 — reduced validation can only be applied with an approved test scope', async () => {
    const p = await createProject('M06', '2027-04-02', [['X800', 1]]);
    const d = await details(p.projectId);
    const val = d.activities.find((a: any) => a.code === 'VAL');
    const tp = (await pool.query(`SELECT id FROM test_plans WHERE code = 'VAL-RED'`)).rows[0].id;
    const cut = await request(app).post('/api/simulate').set(as('program')).send({ ops: [{ type: 'set_duration', activityId: val.id, durationSlots: 2 }] });
    expect(cut.status).toBe(422);
    expect(cut.body.code).toBe('TEST_SCOPE_REQUIRED');
    const noScope = await request(app).post('/api/simulate').set(as('program')).send({ ops: [{ type: 'apply_test_plan', testPlanId: tp, activityIds: [val.id] }] });
    expect(noScope.status).toBe(422);
    expect(noScope.body.code).toBe('TEST_SCOPE_NOT_APPROVED');
    expect((await request(app).post(`/api/test-plans/${tp}/decision`).set(as('program')).send({ decision: 'APPROVED', note: 'not my authority' })).status).toBe(403);
    expect((await request(app).post(`/api/test-plans/${tp}/decision`).set(as('techauth')).send({ decision: 'APPROVED', note: 'EOL coverage extended (TR-77)' })).status).toBe(200);
    const ok = await request(app).post('/api/simulate').set(as('program')).send({ ops: [{ type: 'apply_test_plan', testPlanId: tp, activityIds: [val.id] }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('M7 — packaged but documents incomplete: dispatch is blocked and a document needs a reference to be ready', async () => {
    const p = await createProject('M07', '2027-03-26', [['X800', 1]]);
    const d = await details(p.projectId);
    const sh = d.shipments[0];
    const noRef = await request(app).put(`/api/shipments/${sh.id}/documents`).set(as('logistics')).send({ docType: 'Commercial invoice', status: 'READY' });
    expect(noRef.status).toBe(422);
    // Production history up to packaging (recorded directly: this test is about the outbound rules).
    await pool.query(`UPDATE activities SET status = 'COMPLETED', actual_start = approved_start, actual_finish = approved_finish, pct_complete = 100 WHERE project_id = $1 AND scope IN ('UNIT','SYSTEM')`, [p.projectId]);
    await request(app).post('/api/recalculate').set(as('program')).send({});
    const ob = await request(app).get('/api/outbound?days=400').set(as('logistics'));
    const s = ob.body.shipments.find((x: any) => x.id === sh.id);
    expect(s.exworksReached).toBe(true);
    expect(s.missingDocuments.length).toBeGreaterThan(0);
    expect(s.dispatchBlocked).toBe(true);
    const tr = (await details(p.projectId)).activities.find((a: any) => a.code === 'TRANSIT');
    expect(tr.gates.some((g: any) => g.title === 'Shipping documents ready' && g.status !== 'READY')).toBe(true);
    const ok = await request(app).put(`/api/shipments/${sh.id}/documents`).set(as('logistics')).send({ docType: 'Commercial invoice', status: 'READY', ref: 'INV-2026-1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('M8 — a Solo → Charge Dock change is a draft until approved, then applied through change control with Logistics acknowledgment', async () => {
    const p = await createProject('M08', '2027-05-21', [['X800', 1], ['POLLUX', 2]]);
    const cfg = await request(app).post(`/api/projects/${p.projectId}/configurations`).set(as('commercial')).send({
      systems: [{ code: 'SYS-1', composition: [{ productTypeId: ids.products.X800, quantity: 1 }, { productTypeId: ids.products.CDOCK, quantity: 2 }] }], scopeText: 'Docks instead of Solo',
    });
    expect(cfg.status, JSON.stringify(cfg.body)).toBe(201);
    const rec = await request(app).get(`/api/projects/${p.projectId}/reconciliation`).set(as('program'));
    expect(rec.body.drafts[0].differences.length).toBeGreaterThan(0);
    const early = await request(app).post('/api/simulate').set(as('commercial')).send({ ops: [{ type: 'apply_configuration', configurationId: cfg.body.id }] });
    expect(early.status).toBe(422);
    expect((await request(app).post(`/api/configurations/${cfg.body.id}/decision`).set(as('program')).send({ decision: 'APPROVED', note: 'customer PO change 2' })).status).toBe(200);
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'Apply config v2', ops: [{ type: 'apply_configuration', configurationId: cfg.body.id }] });
    expect(sc.status, JSON.stringify(sc.body)).toBe(201);
    const c = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Customer change order', confirmLatest: true });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const d = await details(p.projectId);
    expect(d.units.filter((u: any) => u.status === 'ACTIVE' && u.productCode === 'CDOCK')).toHaveLength(2);
    expect(d.units.filter((u: any) => u.status === 'ACTIVE' && u.productCode === 'POLLUX')).toHaveLength(0);
    const ack = (await pool.query(`SELECT * FROM action_items WHERE project_id = $1 AND kind = 'LOGISTICS_ACK' AND status = 'OPEN'`, [p.projectId])).rows;
    expect(ack.length).toBeGreaterThan(0);
  });

  it('M9 — two systems delivered first: each delivery has its own ExWorks, freeze and partial progress', async () => {
    const p = await createProject('M09', '2027-05-28', [['X800', 3], ['POLLUX', 3]], {
      lines: undefined,
      systems: [0, 1, 2].map((i) => ({ code: `SYS-${i + 1}`, composition: [{ productTypeId: ids.products.X800, quantity: 1 }, { productTypeId: ids.products.POLLUX, quantity: 1 }] })),
      deliveries: [{ systems: [0, 1] }, { systems: [2] }],
    });
    const d = await details(p.projectId);
    expect(d.shipments).toHaveLength(2);
    expect(d.shipments.map((s: any) => s.manifest_count)).toEqual([4, 2]);
    const parts = d.summary.milestoneParts.filter((m: any) => m.type === 'EXW');
    expect(parts).toHaveLength(2);
    expect(parts[0].forecast).toBeLessThanOrEqual(parts[1].forecast);
    const comm = d.summary.milestones.find((m: any) => m.type === 'COMM');
    expect(comm.progressLabel).toBe('0 of 3 systems commissioned');
    expect(d.summary.freeze.shipments).toHaveLength(2);
  });

  it('M10 — a delay inside the freeze is accepted as an execution fact; a missing explanation is flagged', async () => {
    const f = (await pool.query(`SELECT id FROM projects WHERE code = 'G01'`)).rows[0].id;
    const d = await details(f);
    const a = d.activities.find((x: any) => x.status !== 'COMPLETED' && x.code === 'SUB_MFG' && x.unitSeq === 1);
    const r = await exec(a, { reportDelay: true, expectedFinish: a.forecastFinish + 2, delayReason: 'Subassembly rework after visual inspection', delayCategory: 'QUALITY' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const nores = await exec(a, { expectedFinish: a.forecastFinish + 6 });
    expect(nores.status).toBe(422);
  });

  it('M11 — a scenario simulated on older inputs is stale and must be re-simulated before commit', async () => {
    const p = await createProject('M11', '2027-06-04', [['X800', 1]]);
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'Expedite M11', ops: [{ type: 'move_priority', projectId: p.projectId, toRank: 1 }] });
    expect(sc.status).toBe(201);
    const d = await details(p.projectId);
    const first = d.activities.find((a: any) => a.code === 'PCBA_MFG');
    expect((await exec(first, { pctComplete: 30, comment: 'started early' })).status).toBe(200);
    const list = await request(app).get('/api/scenarios').set(as('program'));
    expect(list.body.find((s: any) => s.id === sc.body.id).stale).toContain('M11');
    const c = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'go' });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('STALE_SCENARIO');
  });

  it('M12 — information from an older meeting cannot overwrite newer state', async () => {
    const d = await details((await pool.query(`SELECT id FROM projects WHERE code = 'M11'`)).rows[0].id);
    const a = d.activities.find((x: any) => x.code === 'PCBA_MFG');
    const old = await exec(a, { pctComplete: 10, asOf: '2026-10-20T09:00:00+02:00' });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('STALE_UPDATE');
  });

  it('M13 — tentative demand is planned indicatively and never displaces committed work', async () => {
    const before = await details((await pool.query(`SELECT id FROM projects WHERE code = 'A01'`)).rows[0].id);
    const t = await createProject('T01', null, [['X800', 4], ['POLLUX', 4]], { demandStatus: 'TENTATIVE', priority: 1 });
    const pf = await request(app).get('/api/portfolio').set(as('program'));
    const tp = pf.body.projects.find((p: any) => p.id === t.projectId);
    expect(tp.planStatus).toBe('INDICATIVE');
    expect(tp.milestones.every((m: any) => m.latestApproved === null)).toBe(true);
    const after = await details(before.project.id);
    const comm = (x: any) => x.summary.milestones.find((m: any) => m.type === 'COMM').forecast;
    expect(comm(after)).toBe(comm(before));
  });

  it('J — auditability of priorities, overrides, delays, readiness and commitments', async () => {
    const classes = (await pool.query('SELECT DISTINCT change_class FROM audit_events')).rows.map((r: any) => r.change_class);
    for (const c of ['EXECUTION', 'OVERRIDE', 'APPROVED_CHANGE', 'COMMERCIAL', 'MATERIAL', 'SOFTWARE', 'QUALITY']) expect(classes).toContain(c);
    const g01 = (await pool.query(`SELECT id FROM projects WHERE code = 'G01'`)).rows[0].id;
    expect((await request(app).post(`/api/projects/${g01}/accept-forecast`).set(as('program')).send({})).status).toBe(400);
    const acc = await request(app).post(`/api/projects/${g01}/accept-forecast`).set(as('program')).send({ reason: 'Re-commit after SMT repair' });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const d = await details(g01);
    const hist = d.commitments.filter((c: any) => c.type === 'EXW' && c.shipment_id === null);
    expect(hist[0].kind).toBe('BASELINE');
    expect(hist[hist.length - 1].reason).toBe('Re-commit after SMT repair');
    await expect(pool.query(`UPDATE audit_events SET reason = 'tamper'`)).rejects.toThrow(/append-only/);
  });

  it('AI assistant answers from deterministic services (offline mode)', async () => {
    process.env.AI_DISABLED = '1';
    const r = await request(app).post('/api/ai/chat').set(as('program')).send({ messages: [{ role: 'user', content: 'Why is the ExWorks date for Project G01 delayed?' }] });
    expect(r.status).toBe(200);
    expect(r.body.trace.map((t: any) => t.tool)).toContain('explain_milestone');
    expect(r.body.answer).toMatch(/SMT line stop|Subassembly rework/);
  });
});

describe('Ramp-up tracker import', () => {
  let batch: any;
  it('preview lists what would change and requires decisions for unmatched names', async () => {
    const buf = await trackerWorkbook();
    const r = await request(app).post('/api/imports/om-tracker').set(as('program')).set('Content-Type', 'application/octet-stream').set('x-filename', 'tracker.xlsx').send(buf);
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(201);
    batch = r.body;
    expect(r.body.report.summary.projects).toBe(3);
    expect(r.body.report.skippedRows.length).toBe(1); // component quantity line
    const berlin = r.body.report.groups.find((g: any) => g.texts.some((t: string) => t.includes('Nordwind')));
    expect(berlin.status).toBe('AMBIGUOUS'); // "Nordwind" matches both Nordwind projects: a person decides
    expect(r.body.blocking.length).toBeGreaterThan(0);
    expect((await request(app).post(`/api/imports/${batch.id}/apply`).set(as('program')).send({})).status).toBe(422);
    const commercial = await request(app).post('/api/imports/om-tracker').set(as('commercial')).set('Content-Type', 'application/octet-stream').send(buf);
    expect(commercial.status).toBe(403);
  });

  it('apply after decisions: projects, units with identities, readiness from colours, aliases remembered', async () => {
    const groups: any = {};
    for (const g of batch.report.groups) {
      if (g.status === 'AUTO') continue;
      groups[g.key] = g.texts.some((t: string) => /nordwind/i.test(t)) ? { kind: 'PROJECT', projectKey: 'nordwind energie berlin' } : g.suggestion ?? { kind: 'SKIP' };
    }
    const visits: any = {};
    for (const v of batch.report.visitGroups) if (v.status !== 'AUTO') visits[v.key] = { kind: 'PROJECT', projectKey: 'nordwind energie berlin' };
    const projects: any = {};
    for (const p of batch.report.projects) if (!p.proposed.country) projects[p.key] = { country: 'NO' === p.proposed.country ? 'SE' : 'SE' };
    const dec = await request(app).put(`/api/imports/${batch.id}/decisions`).set(as('program')).send({ groups, visits, projects });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect(dec.body.blocking).toEqual([]);
    const ap = await request(app).post(`/api/imports/${batch.id}/apply`).set(as('program')).send({});
    expect(ap.status, JSON.stringify(ap.body).slice(0, 800)).toBe(200);
    expect(ap.body.stats.projectsCreated).toBe(3);
    const p = (await pool.query(`SELECT * FROM projects WHERE source_ref = 'OMT:nordwind energie berlin'`)).rows[0];
    expect(p.demand_status).toBe('COMMITTED');
    const units = (await pool.query(`SELECT * FROM units WHERE project_id = $1 ORDER BY seq`, [p.id])).rows;
    expect(units.map((u: any) => u.serial).filter(Boolean).sort()).toEqual(['SOLO-T-0001', 'SOLO-T-0002', 'X08-T-0001']);
    const eol = (await pool.query(`SELECT a.status FROM activities a JOIN units u ON u.id = a.unit_id WHERE u.serial = 'X08-T-0001' AND a.code = 'EOL'`)).rows[0];
    expect(eol.status).toBe('COMPLETED');
    const tr = (await pool.query(`SELECT t.* FROM test_records t JOIN units u ON u.id = t.unit_id WHERE u.serial = 'X08-T-0001'`)).rows[0];
    expect(tr.outcome).toBe('INCONCLUSIVE'); // "Completed (no charge session)" is not a pass
    expect(tr.released_at).toBeNull();
    const gates = (await pool.query(`SELECT g.title, g.status FROM readiness_gates g JOIN units u ON u.id = g.unit_id WHERE u.serial = 'SOLO-T-0002' AND g.source_type = 'IMPORT' ORDER BY g.title`)).rows;
    expect(gates).toEqual(expect.arrayContaining([{ title: 'Sub-assembly ready: AC Box', status: 'READY' }, { title: 'Sub-assembly ready: DC Box', status: 'PENDING' },
      { title: 'Sub-assembly ready: Cooler', status: 'UNKNOWN' }, { title: 'Component availability', status: 'BLOCKED' }]));
    const fjord = (await pool.query(`SELECT * FROM projects WHERE source_ref = 'OMT:fjord transit oslo pilot'`)).rows[0];
    expect(fjord.demand_status).toBe('TENTATIVE');
    expect(fjord.required_commissioning_date).toBeNull();
    expect(fjord.required_commissioning_text).toBe('Q1 2027');
    const rnd = (await pool.query(`SELECT * FROM units WHERE serial = 'SOLO-T-0099'`)).rows[0];
    expect(rnd.project_id).toBeNull();
    expect(rnd.status).toBe('SPARE');
    const alias = (await pool.query(`SELECT * FROM name_aliases WHERE kind = 'PROJECT'`)).rows;
    expect(alias.some((a: any) => a.target_id === p.id)).toBe(true);
    const rel = (await pool.query(`SELECT stage FROM sw_releases WHERE version = '9.9.1.1'`)).rows[0];
    expect(rel.stage).toBe('CANDIDATE'); // listed in the tracker ≠ approved for use
    const topics = (await pool.query(`SELECT title FROM action_items WHERE source = 'IMPORT' AND kind = 'GENERAL'`)).rows.map((r: any) => r.title);
    expect(topics).toEqual(['Cooler fan supply']);
  });

  it('re-import resolves names from aliases, fills in new units and never applies an older workbook silently', async () => {
    const buf = await trackerWorkbook({ modified: new Date('2026-11-03T10:00:00Z'), extraUnit: true });
    const r = await request(app).post('/api/imports/om-tracker').set(as('program')).set('Content-Type', 'application/octet-stream').send(buf);
    expect(r.status).toBe(201);
    const berlin = r.body.report.groups.find((g: any) => g.texts.some((t: string) => t.includes('Nordwind')));
    expect(berlin.status).toBe('AUTO');
    expect(r.body.report.projects.find((p: any) => p.key === 'nordwind energie berlin').match.status).toBe('MATCHED');
    const ap = await request(app).post(`/api/imports/${r.body.id}/apply`).set(as('program')).send({});
    expect(ap.status, JSON.stringify(ap.body).slice(0, 600)).toBe(200);
    expect(ap.body.stats.projectsCreated).toBe(0);
    const n = await pool.query(`SELECT count(*)::int n FROM units WHERE serial = 'SOLO-T-0003'`);
    expect(n.rows[0].n).toBe(1);
    const older = await request(app).post('/api/imports/om-tracker').set(as('program')).set('Content-Type', 'application/octet-stream').send(await trackerWorkbook({ modified: new Date('2026-10-01T10:00:00Z') }));
    expect(older.body.report.olderThanApplied).toBe(true);
    const ap2 = await request(app).post(`/api/imports/${older.body.id}/apply`).set(as('program')).send({});
    expect(ap2.status).toBe(409);
    expect(ap2.body.code).toBe('STALE_IMPORT');
  });

  it('a project renamed in the tracker is updated, not duplicated: account numbers are ignored, other renames are confirmed', async () => {
    const r = await request(app).post('/api/imports/om-tracker').set(as('program')).set('Content-Type', 'application/octet-stream')
      .send(await trackerWorkbook({ modified: new Date('2026-11-04T10:00:00Z'), extraUnit: true, renamed: true }));
    expect(r.status).toBe(201);
    const berlin = r.body.report.projects.find((p: any) => p.label.startsWith('Nordwind Energie Berlin'));
    expect(berlin.match.status).toBe('MATCHED'); // "(500123, Nordwind AG)" added — same project
    const fjord = r.body.report.projects.find((p: any) => p.label === 'Fjord Transit Oslo');
    expect(fjord.match.status).toBe('CANDIDATE');
    expect(r.body.blocking.some((b: any) => b.kind === 'PROJECT_MATCH')).toBe(true);
    const old = (await pool.query(`SELECT id FROM projects WHERE source_ref = 'OMT:fjord transit oslo pilot'`)).rows[0].id;
    const dec = await request(app).put(`/api/imports/${r.body.id}/decisions`).set(as('program')).send({ projects: { [fjord.key]: { matchProjectId: old } } });
    expect(dec.body.blocking).toEqual([]);
    const before = Number((await pool.query(`SELECT count(*) n FROM projects`)).rows[0].n);
    const ap = await request(app).post(`/api/imports/${r.body.id}/apply`).set(as('program')).send({});
    expect(ap.status, JSON.stringify(ap.body).slice(0, 600)).toBe(200);
    expect(ap.body.stats.projectsCreated).toBe(0);
    expect(Number((await pool.query(`SELECT count(*) n FROM projects`)).rows[0].n)).toBe(before);
    expect((await pool.query(`SELECT source_ref FROM projects WHERE id = $1`, [old])).rows[0].source_ref).toBe('OMT:fjord transit oslo');
  });
});

describe('Cancelling a project', () => {
  it('removes it from the plan and dashboards without erasing anything; frozen deliveries need Management; it can be reactivated', async () => {
    const k01 = (await pool.query(`SELECT id FROM projects WHERE code = 'K01'`)).rows[0].id;
    const g01 = (await pool.query(`SELECT id FROM projects WHERE code = 'G01'`)).rows[0].id;
    expect((await request(app).post(`/api/projects/${k01}/cancel`).set(as('commercial')).send({ reason: 'x' })).status).toBe(422);
    expect((await request(app).post(`/api/projects/${k01}/cancel`).set(as('mfg')).send({ reason: 'Order withdrawn by the customer' })).status).toBe(403);
    const frozen = await request(app).post(`/api/projects/${g01}/cancel`).set(as('commercial')).send({ reason: 'Order withdrawn by the customer' });
    expect(frozen.status).toBe(403); // delivery inside the freeze
    const unitsBefore = Number((await pool.query('SELECT count(*) n FROM units WHERE project_id = $1', [k01])).rows[0].n);
    const ok = await request(app).post(`/api/projects/${k01}/cancel`).set(as('commercial')).send({ reason: 'Order withdrawn by the customer' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const pf = await request(app).get('/api/portfolio').set(as('program'));
    expect(pf.body.projects.some((p: any) => p.id === k01)).toBe(false);
    expect(Number((await pool.query(`SELECT count(*) n FROM reservations r JOIN activities a ON a.id = r.activity_id WHERE a.project_id = $1`, [k01])).rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) n FROM units WHERE project_id = $1', [k01])).rows[0].n)).toBe(unitsBefore);
    const inactive = await request(app).get('/api/projects-inactive').set(as('program'));
    expect(inactive.body.find((p: any) => p.id === k01).reason).toBe('Order withdrawn by the customer');
    const back = await request(app).post(`/api/projects/${k01}/reactivate`).set(as('commercial')).send({ reason: 'Customer re-confirmed the order' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const pf2 = await request(app).get('/api/portfolio').set(as('program'));
    const again = pf2.body.projects.find((p: any) => p.id === k01);
    expect(again.priority).toBe(Math.max(...pf2.body.projects.map((p: any) => p.priority)));
    const acts = (await pool.query(`SELECT action FROM audit_events WHERE project_id = $1 AND action LIKE 'project.%'`, [k01])).rows.map((r: any) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['project.cancel', 'project.reactivate']));
  });
});

describe('Logistics booking trigger', () => {
  it('raises a booking request ExWorks − 5 days, follows the date and closes only when the booking is recorded', async () => {
    const p = await createProject('L01', '2027-06-25', [['X800', 1], ['POLLUX', 1]]);
    let d = await details(p.projectId);
    const exw = d.summary.milestoneParts.find((m: any) => m.type === 'EXW');
    const exwDay = Math.floor((exw.forecast - 1) / 2);
    const iso = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
    const history = async (clockIso: string) => {
      await setClock(clockIso);
      const now = (await request(app).get('/api/meta').set(as('program'))).body.now;
      await pool.query(`UPDATE activities SET status = 'COMPLETED', actual_start = approved_start, actual_finish = approved_finish, pct_complete = 100 WHERE project_id = $1 AND approved_finish <= $2 AND status <> 'COMPLETED'`, [p.projectId, now]);
      await pool.query(`UPDATE activities SET status = 'IN_PROGRESS', actual_start = approved_start WHERE project_id = $1 AND approved_start < $2 AND approved_finish > $2 AND status NOT IN ('COMPLETED','IN_PROGRESS')`, [p.projectId, now]);
      expect((await request(app).post('/api/recalculate').set(as('program')).send({})).status).toBe(200);
    };
    const open = async () => (await pool.query(`SELECT * FROM action_items WHERE kind = 'TRANSPORT_BOOKING' AND project_id = $1 AND status = 'OPEN'`, [p.projectId])).rows;
    await history(`${iso(exwDay - 7)}T09:00:00+01:00`);
    expect(await open()).toHaveLength(0); // 7 days before ExWorks: not yet
    await history(`${iso(exwDay - 4)}T09:00:00+01:00`);
    const req = await open();
    expect(req).toHaveLength(1);
    expect(req[0].owner_role).toBe('LOGISTICS');
    const exwNow = (await details(p.projectId)).summary.milestoneParts.find((m: any) => m.type === 'EXW');
    expect(req[0].related.exwDate).toBe(iso(Math.floor((exwNow.forecast - 1) / 2)));
    expect(req[0].related.triggerDate).toBe(iso(Math.floor((exwNow.forecast - 1) / 2) - 5));
    const ob = await request(app).get('/api/outbound?days=30').set(as('logistics'));
    expect(ob.body.bookingRequests.some((x: any) => x.id === req[0].id)).toBe(true);
    // ticking it off is not a booking
    const tick = await request(app).patch(`/api/actions/${req[0].id}`).set(as('logistics')).send({ status: 'DONE' });
    expect(tick.status).toBe(422);
    expect(tick.body.code).toBe('BOOKING_REQUIRED');
    d = await details(p.projectId);
    const sh = d.shipments[0];
    expect((await request(app).patch(`/api/shipments/${sh.id}`).set(as('logistics')).send({ transportBooked: true })).status).toBe(422); // reference required
    const ok = await request(app).patch(`/api/shipments/${sh.id}`).set(as('logistics')).send({ transportBooked: true, bookingRef: 'DSV-778812' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await open()).toHaveLength(0);
    const closed = (await pool.query(`SELECT * FROM action_items WHERE id = $1`, [req[0].id])).rows[0];
    expect(closed.status).toBe('DONE');
    expect(closed.details).toContain('DSV-778812');
    await setClock(CLOCK);
  });
});
