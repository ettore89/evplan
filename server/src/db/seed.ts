/**
 * V4 demonstration data (synthetic — no real customers). Every project is created through the real
 * planning services at its historical order date; history up to today is executed; then the situations
 * discussed in the program meetings are recorded through the same services users call:
 *  1 a part missing from the BOM (manual requirement → BOM-correction action, gate on the first operation)
 *  2 firmware not available while EOL is ~80 % done (EOL cannot complete; announcement ≠ availability)
 *  3 a borrowed dispenser (quality hold on a unit, evaluation spare proposed as substitute)
 *  4 a skid still occupied after validation (removal crew unavailable → packaging waits)
 *  5 shared R&D supply used for troubleshooting (non-production reservation)
 *  6 reduced validation proposed (test scope not yet approved → cannot be applied)
 *  7 packaged but shipping documents incomplete (dispatch blocked)
 *  8 Solo → Charge Dock configuration change (draft, needs approval and Logistics acknowledgment)
 *  9 two systems delivered first (split delivery, per-shipment ExWorks and freeze)
 * 10 a delay inside the freeze (explanation required)
 * 11 a stale scenario (simulated, then the inputs changed)
 * 12 tentative demand planned indicatively, never displacing committed work
 */
import { fileURLToPath } from 'node:url';
import { dayNumber, dayToIso, nowSlot } from '../engine/calendar.js';
import type { AuthUser } from '../services/common.js';
import { updateExecution } from '../services/execution.js';
import { syncDerivedGates, updateGate } from '../services/gates.js';
import { addRequirement, upsertReceipt, upsertStock } from '../services/materials.js';
import { createConfigurationVersion, updateShipment, updateVisit, upsertDocument } from '../services/operations.js';
import { createProject } from '../services/projects.js';
import { openHold, upsertIssue } from '../services/quality.js';
import { recalculate } from '../services/recalc.js';
import { snapshotData } from '../services/read.js';
import { createScenario } from '../services/scenarios.js';
import { approveRelease, markArtifactAvailable, upsertRelease } from '../services/software.js';
import { createUnit } from '../services/graph.js';
import { migrate } from './migrate.js';
import { insertMasterData, truncateAll } from './masterData.js';
import { lockPlan, pool, tx } from './pool.js';

const iso = (d: number) => dayToIso(d);

async function setClock(ts: string | null) {
  await pool.query(`UPDATE settings SET value = $1 WHERE key = 'clock_override'`, [JSON.stringify(ts)]);
}
async function user(username: string): Promise<AuthUser> {
  return (await pool.query('SELECT id, username, name, role FROM users WHERE username = $1', [username])).rows[0];
}
const locked = <T>(fn: (c: any) => Promise<T>) => tx(async (c) => { await lockPlan(c); return fn(c); });

export async function seed({ today = dayToIso(Math.floor(nowSlot() / 2)), quiet = false } = {}) {
  const log = (...a: unknown[]) => { if (!quiet) console.log(...a); };
  await migrate();
  const T = dayNumber(today);
  const ids = await tx(async (c) => { await truncateAll(c); return insertMasterData(c); });
  const [commercial, program, techauth, quality, mfg, logistics, service] = await Promise.all(['commercial', 'program', 'techauth', 'quality', 'mfg', 'logistics', 'service'].map(user));
  const P = ids.products; const C = ids.customers; const R = ids.routes;
  const mat = async (pn: string) => (await pool.query('SELECT id FROM materials WHERE part_number = $1', [pn])).rows[0].id;
  const comp = async (code: string) => (await pool.query('SELECT id FROM sw_components WHERE code = $1', [code])).rows[0].id;

  // Engineering BOM (critical components only) and stock, before projects create their requirements.
  await tx(async (c) => {
    await c.query(`INSERT INTO bom_items (product_type_id, material_id, qty_per_unit, needed_at_code) VALUES ($1,$2,1,'FA'), ($3,$2,1,'FA'), ($1,$4,1,'FA')`,
      [P.X800, await mat('K1-DC-CONT'), P.X1200, await mat('CAB-COOLER')]);
    await upsertStock(c, program, { materialId: await mat('K1-DC-CONT'), location: 'Main warehouse', qtyOnHand: 6, reason: 'Initial count' });
    await upsertStock(c, program, { materialId: await mat('CAB-COOLER'), location: 'Main warehouse', qtyOnHand: 14, reason: 'Initial count' });
    await upsertReceipt(c, program, { materialId: await mat('K1-DC-CONT'), qty: 6, expectedDate: iso(T + 9), dateConfirmed: true, poRef: 'PO-450011' });
    await upsertReceipt(c, program, { materialId: await mat('K1-DC-CONT'), qty: 6, expectedDate: iso(T + 30), dateConfirmed: false, poRef: 'PO-450037' });
    // Released software: firmware and system software approved for production with artifacts available.
    for (const [code, version] of [['BOARD_FW', '3.2.0'], ['SYS_SW', '2.9.2.36'], ['DCC_FPGA', '1.4.1']] as const) {
      const id = await upsertRelease(c, techauth, { componentId: await comp(code), version, stage: 'IN_VALIDATION', knownIssues: [] });
      await approveRelease(c, techauth, id, { scope: 'PRODUCTION', basisRef: `Validation report VR-${code}-${version}`, makeProductionTarget: true });
      await markArtifactAvailable(c, techauth, id, { artifactRef: `\\\\fileserver\\releases\\${code}\\${version}` });
    }
    // Announced, not yet available: 2.9.3 adds Charge Dock support.
    await upsertRelease(c, techauth, { componentId: await comp('SYS_SW'), version: '2.9.3', stage: 'IN_VALIDATION', expectedAvailableDate: iso(T + 8),
      knownIssues: ['Charge Dock temperature sensor box-check still under investigation'], notes: 'Announced in the program meeting; availability not yet confirmed' });
  });

  const projects: { code: string; name: string; customer: string; site: string; country: string; route: string; created: number; required: number | null; lines: [number, number][];
    demand?: 'TENTATIVE' | 'APPROVED' | 'COMMITTED'; deliveries?: number[][]; profile?: string; notes?: string }[] = [
    { code: 'P01', name: 'Kassel Autobahn Hub', customer: 'Voltway GmbH', site: 'Kassel Ost, A7', country: 'DE', route: 'IT-DE', created: T - 30, required: T + 13, lines: [[P.X800, 2], [P.POLLUX, 4]] },
    { code: 'P02', name: 'Lyon Part-Dieu Fast Charging', customer: 'Charge&Go SAS', site: 'Lyon', country: 'FR', route: 'IT-FR', created: T - 26, required: T + 12, lines: [[P.X800, 1], [P.POLLUX, 2]] },
    { code: 'P03', name: 'Denver Bus Depot Phase 1', customer: 'MetroFleet Transit Inc.', site: 'Denver, CO', country: 'US', route: 'IT-US', created: T - 21, required: T + 40, lines: [[P.X800, 2], [P.POLLUX, 2]], profile: 'US-AIR' },
    { code: 'P04', name: 'Rotterdam Port Logistics', customer: 'Sunrise Logistics B.V.', site: 'Maasvlakte, Rotterdam', country: 'NL', route: 'IT-NL', created: T - 16, required: T + 52, lines: [[P.X800, 3], [P.POLLUX, 6]], deliveries: [[0, 1], [2]] },
    { code: 'P05', name: 'Innsbruck Brenner Plaza', customer: 'Alpine Energie AG', site: 'Innsbruck', country: 'AT', route: 'IT-AT', created: T - 9, required: T + 56, lines: [[P.X1200, 1], [P.VEGA, 2]] },
    { code: 'P06', name: 'Columbus Transit Depot', customer: 'Lakeside Bus Authority', site: 'Columbus, OH', country: 'US', route: 'IT-US', created: T - 5, required: T + 80, lines: [[P.X800, 4], [P.POLLUX, 4]], profile: 'US-AIR' },
    { code: 'P07', name: 'A1 Service Areas Bologna', customer: 'Autostrade Elettriche S.p.A.', site: 'Bologna', country: 'IT', route: 'IT-IT', created: T - 2, required: null, lines: [[P.X1200, 2], [P.VEGA, 4]], demand: 'APPROVED', notes: 'Order approved; customer date to be confirmed' },
    { code: 'P08', name: 'Hamburg Harbour Fleet', customer: 'Voltway GmbH', site: 'Hamburg', country: 'DE', route: 'IT-DE', created: T - 1, required: T + 26, lines: [[P.X800, 2], [P.POLLUX, 4]], notes: 'Customer asked for very short lead time' },
    { code: 'P09', name: 'Zürich Depot Pilot', customer: 'Helvetia Bus AG', site: 'Zürich', country: 'CH', route: 'IT-CH', created: T - 1, required: null, lines: [[P.M400, 2], [P.CDOCK, 4]], demand: 'TENTATIVE', notes: 'Forecast demand — no order yet' },
  ];
  const pid: Record<string, number> = {};
  for (const p of projects) {
    await setClock(`${iso(p.created)}T09:00:00+01:00`);
    const out = await locked((c) => createProject(c, commercial, {
      code: p.code, name: p.name, customerId: C[p.customer], siteLocation: p.site, country: p.country, routeId: R[p.route], requiredDate: p.required === null ? null : iso(p.required),
      demandStatus: p.demand, notes: p.notes, serviceProfileId: p.profile ? ids.profiles[p.profile] : undefined,
      lines: p.deliveries ? undefined : p.lines.map(([productTypeId, quantity]) => ({ productTypeId, quantity })),
      systems: p.deliveries ? Array.from({ length: p.lines[0][1] }, (_, i) => ({ code: `SYS-${i + 1}`, composition: [{ productTypeId: p.lines[0][0], quantity: 1 }, { productTypeId: p.lines[1][0], quantity: p.lines[1][1] / p.lines[0][1] }] })) : undefined,
      deliveries: p.deliveries?.map((systems) => ({ systems })),
    }, { source: 'DEMO' }));
    pid[p.code] = out.projectId;
    log(`  ${p.code} planned (${out.feasible === null ? 'indicative' : out.feasible ? 'feasible' : 'INFEASIBLE'}${out.confidence && out.confidence !== 'FIRM' ? `, ${out.confidence.toLowerCase()}` : ''})`);
  }
  await setClock(null);
  const now = nowSlot();

  // Readiness that is normally confirmed early: site configuration, connectivity, site access and people for the near-term projects.
  await tx(async (c) => {
    const gates = (await c.query(`SELECT g.*, p.code, a.approved_start FROM readiness_gates g JOIN projects p ON p.id = g.project_id JOIN activities a ON a.id = g.activity_id WHERE g.source_type = 'MANUAL'`)).rows;
    for (const g of gates) {
      const soon = (g.approved_start ?? Infinity) < now + 30;
      const late = ['P07', 'P09'].includes(g.code);
      if (late) continue;
      if (soon || ['P01', 'P02', 'P03', 'P04'].includes(g.code)) {
        await c.query(`UPDATE readiness_gates SET status = 'READY', evidence_ref = $2, owner_name = $3, last_confirmed_at = now(), last_confirmed_by = $4 WHERE id = $1`,
          [g.id, g.dimension === 'CONFIGURATION' ? `Site configuration sheet ${g.code} v1` : 'Customer confirmation e-mail', g.dimension === 'CONFIGURATION' ? 'Luca Ferri' : 'Tom Becker', program.id]);
      } else {
        await c.query(`UPDATE readiness_gates SET status = 'PENDING', forecast_slot = $2, owner_name = $3 WHERE id = $1`, [g.id, Math.max(now + 4, (g.approved_start ?? now + 10) - 6), 'Tom Becker']);
      }
    }
    for (const code of ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P08']) {
      for (const v of (await c.query('SELECT id FROM commissioning_visits WHERE project_id = $1', [pid[code]])).rows) {
        await updateVisit(c, program, v.id, { executionLeadName: code === 'P03' || code === 'P06' ? 'Mike Ortiz (Service NA)' : 'Tom Becker', personnelConfirmed: ['P01', 'P02', 'P04'].includes(code),
          siteWorkResponsible: ['P01', 'P02', 'P04', 'P05'].includes(code) ? (code === 'P02' ? 'J. Moreau (customer site manager)' : 'Customer electrical contractor') : null,
          siteWorkResponsibleConfirmed: ['P01', 'P04'].includes(code), siteAccessConfirmed: ['P01', 'P02', 'P04'].includes(code),
          personnelEvidence: ['P01', 'P02', 'P04'].includes(code) ? 'Qualification matrix SRV-2026-11 + customer authorization letter' : undefined });
      }
    }
    await syncDerivedGates(c);
  });

  // History up to the current half-day executed as planned, with released test results and installed software.
  await locked(async (c) => {
    await c.query(`UPDATE activities SET status = 'COMPLETED', actual_start = approved_start, actual_finish = approved_finish, pct_complete = 100, updated_by = NULL WHERE approved_finish <= $1`, [now]);
    await c.query(`UPDATE activities SET status = 'IN_PROGRESS', actual_start = approved_start, pct_complete = 40 WHERE approved_start < $1 AND approved_finish > $1 AND status <> 'COMPLETED'`, [now]);
    const sw = (await c.query(`SELECT r.id, a.id approval FROM sw_releases r JOIN sw_components c ON c.production_release_id = r.id JOIN sw_release_approvals a ON a.release_id = r.id WHERE c.code = 'SYS_SW'`)).rows[0];
    const eol = (await c.query(`SELECT id, unit_id, actual_finish FROM activities WHERE code = 'EOL' AND status = 'COMPLETED'`)).rows;
    for (const a of eol) {
      await c.query(`INSERT INTO unit_software (unit_id, release_id, approval_id, installed_by, checks_passed_at, checks_by) VALUES ($1,$2,$3,$4,now(),$4)`, [a.unit_id, sw.id, sw.approval, mfg.id]);
      await c.query(`INSERT INTO test_records (unit_id, activity_id, test_plan_id, outcome, evidence_ref, recorded_by, released_by, released_at)
        VALUES ($1,$2,(SELECT id FROM test_plans WHERE code = 'EOL-STD'),'PASS',$3,$4,$5,now())`, [a.unit_id, a.id, `EOL report ${a.unit_id}`, mfg.id, quality.id]);
    }
    for (const a of (await c.query(`SELECT id, system_id FROM activities WHERE code = 'VAL' AND status = 'COMPLETED'`)).rows) {
      await c.query(`INSERT INTO test_records (system_id, activity_id, test_plan_id, outcome, evidence_ref, recorded_by, released_by, released_at)
        VALUES ($1,$2,(SELECT id FROM test_plans WHERE code = 'VAL-STD' AND status = 'APPROVED'),'PASS',$3,$4,$5,now())`, [a.system_id, a.id, `Validation report SYS${a.system_id}`, techauth.id, techauth.id]);
    }
    await syncDerivedGates(c);
    await recalculate(c, { userId: null, kind: 'SEED_HISTORY', summary: 'Execution history loaded', quiet: true });
  });

  // Previous daily call (yesterday) — later updates show up as "changes since previous call".
  const snap = await pool.query(`INSERT INTO plan_snapshots (label, kind, plan_version, created_by, data, created_at)
    VALUES ($1, 'DAILY_CALL', (SELECT MAX(id) FROM plan_versions), $2, $3, $4) RETURNING id`,
  [`Daily call ${iso(T - 1)}`, program.id, JSON.stringify(await snapshotData(pool)), `${iso(T - 1)}T09:00:00+01:00`]);
  await pool.query(`INSERT INTO decisions (snapshot_id, project_id, text, owner, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [snap.rows[0].id, pid.P04, 'Confirm DC contactor delivery date with the supplier before releasing the third P04 cabinet to FA', 'Purchasing / M. Bianchi', program.id, `${iso(T - 1)}T09:40:00+01:00`]);

  const step = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0];
  const attempt = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { log(`  (${label}: ${(e as Error).message})`); } };

  // 1 — Fiber-to-Ethernet converter needed for P04 system 3, not in the BOM.
  await attempt('missing BOM part', async () => {
    const u = await step(`SELECT u.id FROM units u JOIN systems s ON s.id = u.system_id JOIN product_types pt ON pt.id = u.product_type_id WHERE u.project_id = $1 AND s.code = 'SYS-3' AND pt.family = 'POWER_CABINET'`, [pid.P04]);
    await locked(async (c) => {
      await upsertReceipt(c, mfg, { materialId: await mat('FIB-ETH'), qty: 2, expectedDate: iso(T + 10), dateConfirmed: false, poRef: 'PO-450052' });
      await addRequirement(c, mfg, { materialId: await mat('FIB-ETH'), qty: 1, unitId: u.id, neededAtCode: 'FA', reason: 'Site uses fiber backhaul — converter missing from the engineering BOM' });
      await recalculate(c, { userId: mfg.id, kind: 'MATERIAL', summary: 'Manual requirement: fiber-to-Ethernet converter for P04 SYS-3' });
    });
  });

  // 2 — an EOL test at ~80 % needs system software 2.9.3 (Charge Dock support) that is announced but not available.
  await attempt('firmware gate', async () => {
    const rel = await step(`SELECT r.id FROM sw_releases r JOIN sw_components c ON c.id = r.component_id WHERE c.code = 'SYS_SW' AND r.version = '2.9.3'`, []);
    const a = await step(`SELECT a.* FROM activities a JOIN projects p ON p.id = a.project_id WHERE a.code = 'EOL' AND a.status IN ('IN_PROGRESS','NOT_STARTED','READY') AND p.code IN ('P01','P02','P03','P04')
      ORDER BY a.status = 'IN_PROGRESS' DESC, a.forecast_start LIMIT 1`, []);
    if (!a) return;
    await locked(async (c) => {
      await c.query(`UPDATE readiness_gates SET spec = spec || $2 WHERE activity_id = $1 AND source_type = 'SOFTWARE'`, [a.id, JSON.stringify({ releaseId: rel.id })]);
      await c.query(`UPDATE activities SET status = 'IN_PROGRESS', actual_start = COALESCE(actual_start, $2), pct_complete = 80, progress_slot = $3 WHERE id = $1`, [a.id, Math.min(a.approved_start ?? now - 1, now - 1), now]);
      await syncDerivedGates(c, [a.project_id]);
      await recalculate(c, { userId: null, kind: 'SOFTWARE', summary: 'EOL requires system software 2.9.3 (Charge Dock support)' });
    });
  });

  // 3 — P03 dispenser on quality hold; an evaluation spare exists and could be borrowed (proposal only).
  await attempt('borrowed dispenser', async () => {
    const u = await step(`SELECT u.id FROM units u JOIN product_types pt ON pt.id = u.product_type_id WHERE u.project_id = $1 AND pt.code = 'POLLUX' ORDER BY u.seq LIMIT 1`, [pid.P03]);
    await locked(async (c) => {
      const issue = await upsertIssue(c, quality, { externalRef: 'ADO-4711', title: 'Cable cooler pump noise above limit', symptom: 'Pump noise 62 dB(A) at EOL', status: 'INVESTIGATING', owner: 'R&D Thermal', projectId: pid.P03, unitIds: [u.id] });
      await openHold(c, quality, { unitId: u.id, disposition: 'BLOCKED', reason: 'Cable cooler pump noise — waiting for root cause (ADO-4711)', issueId: issue as any });
      const spare = await createUnit(c, { projectId: null, productTypeId: P.POLLUX, name: 'POLLUX-EVAL-07', serial: 'SOLO-EVAL-007', seq: 1, source: 'DEMO', status: 'SPARE', evaluation: true, location: 'R&D lab', hwRevision: 'SILVER' });
      await c.query(`UPDATE units SET notes = 'Evaluation unit — completed EOL with 2.9.2.36; could replace a blocked dispenser after compatibility review' WHERE id = $1`, [spare.id]);
      await recalculate(c, { userId: quality.id, kind: 'QUALITY', summary: 'Quality hold on a P03 dispenser' });
      await createScenario(c, program, { name: 'Borrow evaluation dispenser for P03', description: 'Replace the blocked P03 dispenser with evaluation unit POLLUX-EVAL-07 (traceability and compatibility review required)',
        ops: [{ type: 'reassign_unit', unitId: spare.id, toProjectId: pid.P03, replacesUnitId: u.id, reason: 'Blocked unit waits for root cause; evaluation unit is compatible (SILVER, 2.9.2.36)' }] } as any);
    });
  });

  // 4 + 5 — removal crew unavailable after a validation; shared HV supply used for troubleshooting tomorrow.
  await attempt('skid & supply', async () => {
    await locked(async (c) => {
      await c.query(`INSERT INTO resource_reservations (work_center_id, start_slot, finish_slot, units, kind, reason, status, created_by) VALUES ($1,$2,$3,1,'MAINTENANCE',$4,'ACTIVE',$5)`,
        [ids.wc.HANDLING, now, now + 3, 'Handling crew assigned to the site-controller retrofit', program.id]);
      await c.query(`INSERT INTO resource_reservations (work_center_id, start_slot, finish_slot, units, kind, reason, status, created_by) VALUES ($1,$2,$3,1,'TROUBLESHOOTING',$4,'ACTIVE',$5)`,
        [ids.wc.SKID_SUPPLY, now + 2, now + 4, 'R&D troubleshooting of the DC-bus controller on the shared supply', techauth.id]);
      await recalculate(c, { userId: program.id, kind: 'CAPACITY', summary: 'Handling crew and shared R&D supply reserved' });
    });
  });

  // 6 — reduced validation is only a proposed test scope (VAL-RED, status PROPOSED, master data): a scenario using it is
  //     refused until Testing / the technical authority approves the scope.

  // 7 — P01 shipment: packaging done soon, commercial invoice still missing; booking deadline set.
  await attempt('documents', async () => {
    const sh = await step(`SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq LIMIT 1`, [pid.P01]);
    await locked(async (c) => {
      await upsertDocument(c, logistics, sh.id, { docType: 'Packing list', status: 'READY', owner: 'Sara Conti', ref: 'PL-26-1187' });
      await upsertDocument(c, logistics, sh.id, { docType: 'Delivery note', status: 'READY', owner: 'Sara Conti', ref: 'DN-26-0932' });
      await upsertDocument(c, logistics, sh.id, { docType: 'Commercial invoice', status: 'MISSING', owner: 'O2C', ref: null });
      await updateShipment(c, logistics, sh.id, { coordinator: 'Sara Conti', collectionAt: new Date((Math.floor(now / 2) + 6) * 86400000 + 10 * 3600000).toISOString() });
      await recalculate(c, { userId: logistics.id, kind: 'LOGISTICS', summary: 'P01 outbound data updated' });
    });
  });

  // 8 — P08: two Solo dispensers replaced by Charge Docks (draft configuration, not yet applied).
  await attempt('configuration change', async () => {
    await tx((c) => createConfigurationVersion(c, commercial, pid.P08, {
      systems: [{ code: 'SYS-1', composition: [{ productTypeId: P.X800, quantity: 1 }, { productTypeId: P.POLLUX, quantity: 2 }] },
        { code: 'SYS-2', composition: [{ productTypeId: P.X800, quantity: 1 }, { productTypeId: P.CDOCK, quantity: 2 }] }],
      scopeText: 'Customer change: system 2 with 2 Charge Docks instead of 2 Solo dispensers', source: 'CUSTOMER', sourceRef: 'Customer e-mail', notes: 'Needs approval, Logistics acknowledgment and the Charge Dock software (2.9.3)',
    }));
  });

  // 10 — delay inside the freeze: P01 packaging reported late (reason mandatory, explanation recorded).
  await attempt('delay in freeze', async () => {
    const a = await step(`SELECT a.* FROM activities a WHERE a.project_id = $1 AND a.status IN ('IN_PROGRESS','NOT_STARTED','READY') AND a.scope = 'UNIT' ORDER BY a.forecast_start LIMIT 1`, [pid.P01]);
    if (!a) return;
    await tx(async (c) => { await lockPlan(c); return updateExecution(c, a.function === 'TESTING' ? await user('test') : mfg, a.id, {
      reportDelay: true, expectedFinish: (a.forecast_finish ?? now) + 2, delayReason: 'Cabinet cooler fan connector damaged in FA; replacement from stock', delayCategory: 'QUALITY' }); });
  });

  // 11 — stale scenario: simulated, then an execution update changes its inputs.
  await attempt('stale scenario', async () => {
    await locked((c) => createScenario(c, commercial, { name: 'Expedite Innsbruck (P05)', description: 'Customer requests earlier opening of the Brenner plaza', ops: [{ type: 'move_priority', projectId: pid.P05, toRank: 2 }] } as any));
    const a = await step(`SELECT a.* FROM activities a WHERE a.project_id = $1 AND a.status = 'IN_PROGRESS' ORDER BY a.forecast_finish LIMIT 1`, [pid.P05])
      ?? await step(`SELECT a.* FROM activities a WHERE a.project_id = $1 AND a.status IN ('NOT_STARTED','READY') ORDER BY a.forecast_start LIMIT 1`, [pid.P05]);
    if (a) await tx(async (c) => { await lockPlan(c); return updateExecution(c, a.function === 'TESTING' ? await user('test') : mfg, a.id, { pctComplete: 60, comment: 'Progress update from the line' }); });
  });

  // Supplier gate on a later project: an unconfirmed manual gate shows open-ended uncertainty.
  await attempt('open gate', async () => {
    const g = await step(`SELECT g.id FROM readiness_gates g WHERE g.project_id = $1 AND g.dimension = 'EXTERNAL' AND g.source_type = 'MANUAL' ORDER BY g.id LIMIT 1`, [pid.P06]);
    if (g) await locked(async (c) => { await updateGate(c, program, g.id, { status: 'UNKNOWN', forecastSlot: null, notes: 'Backend (OCPP) provider not yet selected by the customer' }); await recalculate(c, { userId: program.id, kind: 'READINESS', summary: 'P06 backend readiness unknown' }); });
  });

  await pool.query(`UPDATE units SET source = 'DEMO' WHERE project_id IS NULL AND source <> 'IMPORT'`);
  await setClock(null);
  log('Seed complete.');
  return { pid };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
