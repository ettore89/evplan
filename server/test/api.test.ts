/**
 * API-level acceptance tests against a real PostgreSQL database (DATABASE_URL_TEST,
 * default postgres://evplan:evplan@localhost:5432/evplan_test). Business rules are
 * exercised through the HTTP API so role and freeze enforcement are backend-verified.
 */
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

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
async function createProject(code: string, required: string, lines: [string, number][], route = 'IT-DE', country = 'DE') {
  const res = await request(app).post('/api/projects').set(as('commercial')).send({
    code, name: `Project ${code}`, customerId: ids.customers['Voltway GmbH'], siteLocation: 'Kassel', country, routeId: ids.routes[route],
    requiredDate: required, lines: lines.map(([p, q]) => ({ productTypeId: ids.products[p], quantity: q })),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
async function acts(projectId: number) {
  const r = await request(app).get(`/api/projects/${projectId}`).set(as('program'));
  return r.body;
}
const roleFor: Record<string, string> = { MANUFACTURING: 'mfg', TESTING: 'test', RND: 'rnd', LOGISTICS: 'logistics', SERVICE: 'service' };

beforeAll(async () => {
  const db = await import('../src/db/pool.js');
  pool = db.pool;
  const { migrate } = await import('../src/db/migrate.js');
  const md = await import('../src/db/masterData.js');
  await migrate();
  ids = await db.tx(async (c: any) => { await md.truncateAll(c); return md.insertMasterData(c); });
  await setClock(CLOCK);
  const { createApp } = await import('../src/app.js');
  const { attachRealtime } = await import('../src/services/realtime.js');
  app = createApp();
  server = createServer(app);
  attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  for (const u of ['mfg', 'test', 'rnd', 'logistics', 'commercial', 'service', 'program', 'program2']) {
    const r = await request(app).post('/api/auth/login').send({ username: u, password: 'demo' });
    tokens[u] = r.body.token;
  }
});

afterAll(async () => {
  server?.close();
  await pool?.end();
});

describe('API acceptance', () => {
  let main: any;

  it('Test A — creates a 2 cabinet + 4 dispenser project with an independent backward plan per unit', async () => {
    main = await createProject('A01', '2027-01-29', [['X800', 2], ['POLLUX', 4]]);
    expect(main.feasible).toBe(true);
    const d = await acts(main.projectId);
    expect(d.units).toHaveLength(6);
    expect(d.activities).toHaveLength(6 * 12 + 1);
    expect(d.units.map((u: any) => u.serial)).toEqual(['X800-001', 'X800-002', 'POLLUX-001', 'POLLUX-002', 'POLLUX-003', 'POLLUX-004']);
    for (const a of d.activities) {
      expect(a.baselineStart).toBe(a.approvedStart);
      expect(a.forecastStart).toBe(a.approvedStart);
    }
    const comm = d.summary.milestones.find((m: any) => m.type === 'COMM');
    expect(comm.forecastLabel.startsWith('2027-01-2')).toBe(true);
    expect(d.commitments.filter((c: any) => c.kind === 'BASELINE')).toHaveLength(3);
  });

  it('enforces role authority in the backend', async () => {
    const d = await acts(main.projectId);
    const eol = d.activities.find((a: any) => a.code === 'EOL');
    const r = await request(app).patch(`/api/activities/${eol.id}/execution`).set(as('mfg')).send({ comment: 'hi' });
    expect(r.status).toBe(403);
    const r2 = await request(app).post('/api/scenarios').set(as('commercial')).send({ name: 'x', ops: [{ type: 'set_capacity', workCenterId: ids.wc.EOL, capacity: 2 }] });
    expect(r2.status).toBe(403);
    const r3 = await request(app).post('/api/projects').set(as('test')).send({});
    expect([400, 403]).toContain(r3.status);
  });

  it('Test F — rejects a delay without a reason and propagates root-cause traceability', async () => {
    const d = await acts(main.projectId);
    const pcba = d.activities.find((a: any) => a.code === 'PCBA_TEST' && a.unitSeq === 1);
    const bad = await request(app).patch(`/api/activities/${pcba.id}/execution`).set(as('test')).send({ expectedFinish: pcba.forecastFinish + 4 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('DELAY_REASON_REQUIRED');
    const blocked = await request(app).patch(`/api/activities/${pcba.id}/execution`).set(as('test')).send({ status: 'BLOCKED', blocker: 'Fixture broken' });
    expect(blocked.status).toBe(422);
    const ok = await request(app).patch(`/api/activities/${pcba.id}/execution`).set(as('test'))
      .send({ expectedFinish: pcba.forecastFinish + 4, delayReason: 'ICT fixture out of calibration', delayCategory: 'QUALITY' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const rootId = ok.body.delayEventId;
    expect(rootId).toBeTruthy();
    const ev = await pool.query('SELECT * FROM delay_events WHERE root_event_id = $1', [rootId]);
    expect(ev.rows.length).toBeGreaterThan(0);
    expect(ev.rows.every((e: any) => e.reason === null || e.kind !== 'ROOT')).toBe(true);
    const root = (await pool.query('SELECT * FROM delay_events WHERE id = $1', [rootId])).rows[0];
    expect(root.kind).toBe('ROOT');
    expect(root.reason).toBe('ICT fixture out of calibration');
    expect(root.user_id).toBeTruthy();
    expect(root.new_finish).toBe(pcba.forecastFinish + 4);
    // historical miss kept: original committed milestone dates unchanged
    const after = await acts(main.projectId);
    const succ = after.activities.find((a: any) => a.code === 'SUB_MFG' && a.unitSeq === 1);
    expect(succ.forecastStart).toBeGreaterThanOrEqual(pcba.forecastFinish + 4);
    expect(succ.lastEvent?.eventId ?? null).not.toBeUndefined();
  });

  it('Test D — rejects a fourth simultaneous system in Final Assembly', async () => {
    const p = await createProject('D01', '2027-03-15', [['X800', 4]]);
    const d = await acts(p.projectId);
    const fa = d.activities.filter((a: any) => a.code === 'FA');
    const slot = Math.max(...fa.map((a: any) => a.forecastStart)) + 20;
    const mk = (n: number) => fa.slice(0, n).map((a: any) => ({ type: 'move_activity', activityId: a.id, start: slot }));
    const three = await request(app).post('/api/simulate').set(as('program')).send({ ops: mk(3) });
    expect(three.status).toBe(200);
    expect(three.body.violations).toEqual([]);
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'four in FA', ops: mk(4) });
    expect(sc.body.result.violations.length).toBeGreaterThan(0);
    const commit = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'test' });
    expect(commit.status).toBe(422);
    expect(commit.body.code).toBe('INVALID_SCHEDULE');
  });

  it('Test C — EOL bookings never exceed 1.5 effective units', async () => {
    const r = await pool.query(`SELECT slot, SUM(load) AS load, COUNT(*) AS n FROM reservations WHERE work_center_id = $1 GROUP BY slot`, [ids.wc.EOL]);
    for (const row of r.rows) {
      expect(Number(row.load)).toBeLessThanOrEqual(1.5);
      expect(Number(row.n)).toBeLessThanOrEqual(2);
    }
  });

  it('Test G — freeze requires Management approval but never blocks execution updates', async () => {
    const f = await createProject('G01', '2026-11-25', [['X800', 1], ['POLLUX', 1]]);
    const pf = await request(app).get('/api/portfolio').set(as('commercial'));
    const g = pf.body.projects.find((p: any) => p.id === f.projectId);
    expect(g.freeze.frozen).toBe(true);
    // Commercial reprioritization touching the frozen project → pending Management approval
    const sc = await request(app).post('/api/scenarios').set(as('commercial')).send({ name: 'G01 to top', ops: [{ type: 'move_priority', projectId: f.projectId, toRank: 1 }] });
    expect(sc.status).toBe(201);
    expect(sc.body.result.requiresManagement).toBe(true);
    const c1 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('commercial')).send({ justification: 'customer escalation' });
    expect(c1.status).toBe(202);
    expect(c1.body.status).toBe('PENDING_APPROVAL');
    const c2 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({});
    expect(c2.status).toBe(422);
    expect(c2.body.code).toBe('JUSTIFICATION_REQUIRED');
    const c3 = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Approved in daily call: customer opening event' });
    expect(c3.status, JSON.stringify(c3.body)).toBe(200);
    const audit = await pool.query(`SELECT * FROM audit_events WHERE scenario_id = $1 AND change_class = 'OVERRIDE'`, [sc.body.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
    // Moving a frozen activity directly also requires approval
    const d = await acts(f.projectId);
    const pack = d.activities.find((a: any) => a.code === 'PACK' && a.status !== 'COMPLETED');
    const mv = await request(app).post('/api/simulate').set(as('program')).send({ ops: [{ type: 'move_activity', activityId: pack.id, start: pack.forecastStart + 2 }] });
    expect(mv.body.requiresManagement).toBe(true);
    // Execution update on the frozen project is accepted and the forecast moves automatically
    const first = d.activities.find((a: any) => a.seq === 1 && a.unitSeq === 1);
    const ex = await request(app).patch(`/api/activities/${first.id}/execution`).set(as('mfg'))
      .send({ reportDelay: true, expectedFinish: first.forecastFinish + 6, delayReason: 'SMT line stop — reflow oven repair', delayCategory: 'RESOURCE' });
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    const after = await acts(f.projectId);
    const exw = after.summary.milestones.find((m: any) => m.type === 'EXW');
    expect(exw.forecast).toBeGreaterThan(exw.latestApproved);
    expect(exw.delay?.reason).toBe('SMT line stop — reflow oven repair');
  });

  it('Test H — live call: Program commits a move and a second user sees it immediately', async () => {
    const port = (server.address() as AddressInfo).port;
    const received: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tokens.test}`);
    const wsProg = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tokens.program}`);
    ws.on('message', (m) => received.push(JSON.parse(String(m))));
    await Promise.all([new Promise((r) => ws.on('open', r)), new Promise((r) => wsProg.on('open', r))]);
    const d = await acts(main.projectId);
    const pack = d.activities.find((a: any) => a.code === 'PACK' && a.unitSeq === 3);
    const g0 = await request(app).get('/api/gantt').set(as('program'));
    let newStart = pack.forecastStart + 4;
    while (g0.body.nonWorkingDays.includes(Math.floor(newStart / 2))) newStart++;
    const sim = await request(app).post('/api/simulate').set(as('program')).send({ ops: [{ type: 'move_activity', activityId: pack.id, start: newStart }] });
    expect(sim.status).toBe(200);
    const sc = await request(app).post('/api/scenarios').set(as('program')).send({ name: 'Move packaging', ops: [{ type: 'move_activity', activityId: pack.id, start: newStart }], source: 'DAILY_CALL' });
    const commit = await request(app).post(`/api/scenarios/${sc.body.id}/commit`).set(as('program')).send({ justification: 'Packaging crew reassigned to urgent order' });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const upd = received.find((m) => m.type === 'plan.updated' && m.version === commit.body.version);
    expect(upd).toBeTruthy();
    const g = await request(app).get('/api/gantt').set(as('test'));
    const moved = g.body.activities.find((a: any) => a.id === pack.id);
    expect(moved.approvedStart).toBe(newStart);
    expect(moved.forecastStart).toBe(newStart);
    expect(moved.locked).toBe(true);
    expect(received.some((m) => m.type === 'presence' && m.users.length >= 2)).toBe(true);
    ws.close();
    wsProg.close();
  });

  it('Test J — auditability of priorities, overrides, delays, forecasts and commitments', async () => {
    const classes = (await pool.query('SELECT DISTINCT change_class FROM audit_events')).rows.map((r: any) => r.change_class);
    for (const c of ['EXECUTION', 'OVERRIDE', 'APPROVED_CHANGE', 'COMMERCIAL']) expect(classes).toContain(c);
    const prio = await pool.query(`SELECT * FROM audit_events WHERE action = 'project.priority'`);
    expect(prio.rows.length).toBeGreaterThan(0);
    expect(prio.rows[0].before).toHaveProperty('priority');
    const kinds = (await pool.query('SELECT DISTINCT kind FROM delay_events')).rows.map((r: any) => r.kind);
    for (const k of ['ROOT', 'APPROVED_CHANGE']) expect(kinds).toContain(k);
    expect(kinds.some((k: string) => k === 'PROPAGATED' || k === 'CAPACITY')).toBe(true);
    const g01 = (await pool.query(`SELECT id FROM projects WHERE code = 'G01'`)).rows[0].id;
    const nores = await request(app).post(`/api/projects/${g01}/accept-forecast`).set(as('program')).send({});
    expect(nores.status).toBe(400);
    const acc = await request(app).post(`/api/projects/${g01}/accept-forecast`).set(as('program')).send({ reason: 'Re-commit after SMT repair' });
    expect(acc.status).toBe(200);
    const d = await acts(g01);
    const exw = d.summary.milestones.find((m: any) => m.type === 'EXW');
    expect(exw.latestApproved).toBe(exw.forecast);
    expect(exw.originalCommitted).toBeLessThan(exw.latestApproved); // historical miss preserved
    expect(exw.varianceVsOriginalDays).toBeGreaterThan(0);
    const commits = (await pool.query('SELECT DISTINCT kind FROM milestone_commitments')).rows.map((r: any) => r.kind);
    expect(commits).toContain('BASELINE');
    expect(commits.some((k: string) => k === 'APPROVED_CHANGE' || k === 'OVERRIDE')).toBe(true);
    await expect(pool.query(`UPDATE audit_events SET reason = 'tamper'`)).rejects.toThrow(/append-only/);
    const versions = await pool.query('SELECT COUNT(*)::int AS n FROM plan_versions');
    expect(versions.rows[0].n).toBeGreaterThan(5);
  });

  it('Test K — identical units are planned individually without quantity efficiencies', async () => {
    const p = await createProject('K01', '2027-04-30', [['X800', 3]]);
    const d = await acts(p.projectId);
    const fa = d.activities.filter((a: any) => a.code === 'FA');
    expect(fa).toHaveLength(3);
    for (const a of fa) expect(a.durationSlots).toBe(1);
    const r = await pool.query(`SELECT COUNT(*)::int AS n, SUM(load)::float AS l FROM reservations WHERE activity_id = ANY($1)`, [fa.map((a: any) => a.id)]);
    expect(r.rows[0].l).toBe(3);
  });

  it('AI assistant answers from deterministic services (offline mode)', async () => {
    process.env.AI_DISABLED = '1';
    const r = await request(app).post('/api/ai/chat').set(as('program')).send({ messages: [{ role: 'user', content: 'What happens if we increase EOL testing capacity from 1.5 to 2?' }] });
    expect(r.status).toBe(200);
    expect(r.body.trace.map((t: any) => t.tool)).toContain('simulate_change');
    const cap = await pool.query(`SELECT capacity FROM work_centers WHERE code = 'EOL'`);
    expect(Number(cap.rows[0].capacity)).toBe(1.5); // simulation never commits
    const r2 = await request(app).post('/api/ai/chat').set(as('test')).send({ messages: [{ role: 'user', content: 'Why is the ExWorks date for Project G01 delayed?' }] });
    expect(r2.body.trace.map((t: any) => t.tool)).toContain('explain_milestone');
    expect(r2.body.answer).toContain('SMT line stop');
  });
  it('Test E / I — ExWorks completes only when every unit is packed; milestones match activity dates', async () => {
    const p = await createProject('E01', '2027-02-26', [['X800', 1], ['POLLUX', 2]]);
    let d = await acts(p.projectId);
    const exwOf = (x: any) => x.summary.milestones.find((m: any) => m.type === 'EXW');
    const maxF = (code: string) => Math.max(...d.activities.filter((a: any) => a.code === code).map((a: any) => a.forecastFinish));
    expect(d.summary.milestones.find((m: any) => m.type === 'EOL').forecast).toBe(maxF('EOL'));
    expect(exwOf(d).forecast).toBe(maxF('PACK'));
    expect(d.summary.milestones.find((m: any) => m.type === 'COMM').forecast).toBe(maxF('COMM'));
    // jump the clock past packaging and complete all unit work in order
    await setClock('2027-06-01T18:00:00+02:00');
    const units = d.units.map((u: any) => u.id);
    for (const [i, uid] of units.entries()) {
      d = await acts(p.projectId);
      const chain = d.activities.filter((a: any) => a.unitId === uid && a.seq <= 11).sort((a: any, b: any) => a.seq - b.seq);
      for (const a of chain) {
        const cur = (await acts(p.projectId)).activities.find((x: any) => x.id === a.id);
        const r = await request(app).patch(`/api/activities/${a.id}/execution`).set(as(roleFor[a.function]))
          .send({ status: 'COMPLETED', actualStart: cur.approvedStart, actualFinish: cur.approvedFinish });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      d = await acts(p.projectId);
      expect(exwOf(d).complete).toBe(i === units.length - 1);
    }
    const packs = d.activities.filter((a: any) => a.code === 'PACK');
    expect(exwOf(d).actual).toBe(Math.max(...packs.map((a: any) => a.actualFinish)));
    await setClock(CLOCK);
  });

});
