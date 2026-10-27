import bcrypt from 'bcryptjs';
import type pg from 'pg';

export const ROLES = ['MANUFACTURING', 'TESTING', 'RND', 'LOGISTICS', 'COMMERCIAL', 'SERVICE', 'MANAGEMENT'] as const;

const HOLIDAYS: Record<string, [string, string][]> = {
  IT: [['2026-11-01', 'Ognissanti'], ['2026-12-08', 'Immacolata'], ['2026-12-25', 'Natale'], ['2026-12-26', 'Santo Stefano'], ['2027-01-01', 'Capodanno'],
    ['2027-01-06', 'Epifania'], ['2027-03-29', 'Lunedì dell\'Angelo'], ['2027-04-25', 'Liberazione'], ['2027-05-01', 'Festa del Lavoro'], ['2027-06-02', 'Festa della Repubblica'], ['2027-08-15', 'Ferragosto']],
  DE: [['2026-12-25', 'Weihnachtstag'], ['2026-12-26', 'Zweiter Weihnachtstag'], ['2027-01-01', 'Neujahr'], ['2027-03-26', 'Karfreitag'], ['2027-03-29', 'Ostermontag'],
    ['2027-05-01', 'Tag der Arbeit'], ['2027-05-06', 'Christi Himmelfahrt'], ['2027-05-17', 'Pfingstmontag'], ['2027-10-03', 'Tag der Deutschen Einheit']],
  FR: [['2026-11-01', 'Toussaint'], ['2026-11-11', 'Armistice'], ['2026-12-25', 'Noël'], ['2027-01-01', 'Jour de l\'an'], ['2027-03-29', 'Lundi de Pâques'], ['2027-05-01', 'Fête du Travail'], ['2027-05-08', 'Victoire 1945']],
  NL: [['2026-12-25', 'Eerste Kerstdag'], ['2026-12-26', 'Tweede Kerstdag'], ['2027-01-01', 'Nieuwjaarsdag'], ['2027-03-29', 'Tweede Paasdag'], ['2027-04-27', 'Koningsdag']],
  AT: [['2026-12-08', 'Mariä Empfängnis'], ['2026-12-25', 'Christtag'], ['2026-12-26', 'Stefanitag'], ['2027-01-01', 'Neujahr'], ['2027-01-06', 'Heilige Drei Könige'], ['2027-03-29', 'Ostermontag']],
  US: [['2026-11-11', 'Veterans Day'], ['2026-11-26', 'Thanksgiving Day'], ['2026-12-25', 'Christmas Day'], ['2027-01-01', 'New Year\'s Day'], ['2027-01-18', 'Martin Luther King Jr. Day'],
    ['2027-02-15', 'Presidents\' Day'], ['2027-05-31', 'Memorial Day'], ['2027-07-05', 'Independence Day (observed)']],
};

export const SETTINGS: [string, unknown, string][] = [
  ['freeze_days', 21, 'Program-wide planning freeze: calendar days before the forecast ExWorks date'],
  ['timezone', 'Europe/Rome', 'Planning time zone of the production facility'],
  ['risk_thresholds', { amberDays: 0, redDays: 3 }, 'Milestone risk: AMBER when variance > amberDays, RED when ≥ redDays working days (or commissioning beyond the customer date)'],
  ['notification_thresholds', { milestoneVarianceDays: 1, blockedHours: 4, capacityUtilizationPct: 95 }, 'Thresholds used to highlight items in the daily call'],
  ['priority_rules', { newProjectPosition: 'BOTTOM', scarceCapacity: 'PROJECT_PRIORITY' }, 'New projects enter at the bottom of the shared ranking; scarce capacity is allocated by project priority'],
  ['half_day_granularity', true, 'Plan resolution is half a working day (AM / PM)'],
  ['eol_capacity_model', { mode: 'EFFECTIVE_UNITS', note: 'EOL testing approximated as 1.5 effective capacity units, max 2 systems concurrently, min rate 0.5. Phase-level modelling is a future extension.' }, 'Approximation used for partially parallel EOL testing'],
  ['clock_override', null, 'ISO timestamp that replaces the system clock (demos/tests only); null = real time'],
  ['demo_mode', true, 'Show demo users on the login page'],
];

export const PERMISSIONS: [string, string[], string][] = [
  ['activity.execute.MANUFACTURING', ['MANUFACTURING', 'MANAGEMENT'], 'Update status/actuals of manufacturing & packaging activities'],
  ['activity.execute.TESTING', ['TESTING', 'MANAGEMENT'], 'Update PCBA/subassembly programming & testing and EOL testing'],
  ['activity.execute.RND', ['RND', 'MANAGEMENT'], 'Update validation and pre-commissioning'],
  ['activity.execute.LOGISTICS', ['LOGISTICS', 'MANAGEMENT'], 'Update shipments'],
  ['activity.execute.SERVICE', ['SERVICE', 'MANAGEMENT'], 'Update in-field commissioning'],
  ['project.create', ['COMMERCIAL', 'MANAGEMENT'], 'Create customer projects (initial backward plan)'],
  ['project.commercial.edit', ['COMMERCIAL', 'MANAGEMENT'], 'Edit customer required dates and commercial data'],
  ['scenario.create', ['COMMERCIAL', 'MANAGEMENT'], 'Create / simulate scenarios'],
  ['scenario.op.priority', ['COMMERCIAL', 'MANAGEMENT'], 'Propose priority changes'],
  ['scenario.op.schedule', ['MANAGEMENT'], 'Move activities, change durations, pull in, re-plan'],
  ['scenario.op.capacity', ['MANAGEMENT'], 'Change capacity assumptions, authorize weekend work'],
  ['scenario.commit', ['COMMERCIAL', 'MANAGEMENT'], 'Commit scenarios that do not affect frozen projects'],
  ['freeze.override', ['MANAGEMENT'], 'Approve / commit changes affecting frozen projects (justification mandatory)'],
  ['plan.recalculate', ['MANAGEMENT'], 'Trigger immediate recalculation'],
  ['plan.accept_forecast', ['MANAGEMENT'], 'Accept the current forecast as the new commitment'],
  ['activity.lock', ['MANAGEMENT'], 'Lock / unlock activity commitments'],
  ['snapshot.create', ['MANAGEMENT'], 'Start a daily call (plan snapshot)'],
  ['decision.create', ['MANAGEMENT'], 'Record daily-call decisions'],
  ['admin.config', ['MANAGEMENT'], 'Administration and configuration'],
];

export const DELAY_CATEGORIES: [string, string][] = [
  ['MATERIAL', 'Material shortage / late supplier delivery'], ['QUALITY', 'Quality issue / test failure'], ['RESOURCE', 'Staff or equipment unavailable'],
  ['ENGINEERING', 'Engineering / firmware issue'], ['CUSTOMER', 'Customer / site not ready'], ['LOGISTICS', 'Transport / customs'], ['OTHER', 'Other'], ['SYSTEM', 'System-detected'],
];

// [code, name, function, capacity, maxConcurrent, minRate, model, notes]
export const WORK_CENTERS: [string, string, string, number, number, number, 'discrete' | 'effective', string][] = [
  ['PCBA_MFG', 'PCBA Manufacturing', 'MANUFACTURING', 4, 4, 1, 'discrete', 'SMT line; sized to feed downstream throughput'],
  ['PCBA_PROG', 'PCBA Programming', 'TESTING', 4, 4, 1, 'discrete', ''],
  ['PCBA_TEST', 'PCBA Testing', 'TESTING', 4, 4, 1, 'discrete', ''],
  ['SUB_MFG', 'Subassembly Manufacturing', 'MANUFACTURING', 4, 4, 1, 'discrete', ''],
  ['SUB_TEST', 'Subassembly Testing', 'TESTING', 3, 3, 1, 'discrete', 'Sized to FA needs (FA: 3 parallel × 0.5 day)'],
  ['SUB_PROG', 'Subassembly Programming', 'TESTING', 3, 3, 1, 'discrete', 'Sized to FA needs'],
  ['FA', 'Final Assembly', 'MANUFACTURING', 3, 3, 1, 'discrete', '3 physical systems in parallel'],
  ['EOL', 'Final Assembly / EOL Testing', 'TESTING', 1.5, 2, 0.5, 'effective', 'Effective capacity 1.5 systems: two systems can overlap only partially (approximation, see settings.eol_capacity_model)'],
  ['VAL', 'R&D Validation', 'RND', 2, 2, 1, 'discrete', '2 systems in parallel'],
  ['PRECOMM', 'Pre-commissioning', 'RND', 2, 2, 1, 'discrete', '2 systems in parallel'],
  ['PACK', 'Packaging', 'MANUFACTURING', 3, 3, 1, 'discrete', ''],
  ['COMM', 'In-field Commissioning', 'SERVICE', 2, 2, 1, 'discrete', '2 systems in parallel (service teams)'],
];

// [seq, code, name, function, wc code | null, days, scope, kind, milestone, useDestinationCalendar]
export const STANDARD_ROUTING: [number, string, string, string, string | null, number, 'unit' | 'shipment', 'work' | 'transport', string | null, boolean][] = [
  [1, 'PCBA_MFG', 'Manufacturing PCBAs', 'MANUFACTURING', 'PCBA_MFG', 1, 'unit', 'work', null, false],
  [2, 'PCBA_PROG', 'Programming PCBAs', 'TESTING', 'PCBA_PROG', 0.5, 'unit', 'work', null, false],
  [3, 'PCBA_TEST', 'Testing PCBAs', 'TESTING', 'PCBA_TEST', 0.5, 'unit', 'work', null, false],
  [4, 'SUB_MFG', 'Manufacturing subassemblies', 'MANUFACTURING', 'SUB_MFG', 1, 'unit', 'work', null, false],
  [5, 'SUB_TEST', 'Testing subassemblies', 'TESTING', 'SUB_TEST', 0.5, 'unit', 'work', null, false],
  [6, 'SUB_PROG', 'Programming subassemblies', 'TESTING', 'SUB_PROG', 0.5, 'unit', 'work', null, false],
  [7, 'FA', 'Final assembly (FA)', 'MANUFACTURING', 'FA', 0.5, 'unit', 'work', null, false],
  [8, 'EOL', 'Final assembly / EOL testing', 'TESTING', 'EOL', 1, 'unit', 'work', 'EOL', false],
  [9, 'VAL', 'Validation', 'RND', 'VAL', 2, 'unit', 'work', null, false],
  [10, 'PRECOMM', 'Pre-commissioning', 'RND', 'PRECOMM', 0.5, 'unit', 'work', null, false],
  [11, 'PACK', 'Packaging', 'MANUFACTURING', 'PACK', 1, 'unit', 'work', 'PACK', false],
  [12, 'SHIP', 'Shipment', 'LOGISTICS', null, 0, 'shipment', 'transport', null, false],
  [13, 'COMM', 'In-field commissioning', 'SERVICE', 'COMM', 2, 'unit', 'work', 'COMM', true],
];

export async function insertMasterData(c: pg.PoolClient) {
  for (const [k, v, d] of SETTINGS) await c.query('INSERT INTO settings (key, value, description) VALUES ($1,$2,$3)', [k, JSON.stringify(v), d]);
  for (const [a, r, d] of PERMISSIONS) await c.query('INSERT INTO permissions (action, roles, description) VALUES ($1,$2,$3)', [a, r, d]);
  const hash = await bcrypt.hash('demo', 8);
  const users: [string, string, string][] = [
    ['mfg', 'Marco Bianchi', 'MANUFACTURING'], ['test', 'Giulia Rossi', 'TESTING'], ['rnd', 'Luca Ferri', 'RND'], ['logistics', 'Sara Conti', 'LOGISTICS'],
    ['commercial', 'Anna Weber', 'COMMERCIAL'], ['service', 'Tom Becker', 'SERVICE'], ['program', 'Paolo Ricci', 'MANAGEMENT'], ['program2', 'Elena Gallo', 'MANAGEMENT'],
  ];
  for (const [u, n, r] of users) await c.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4)', [u, n, r, hash]);
  await c.query(`INSERT INTO regions (code, name) VALUES ('EU','Europe'), ('NA','North America')`);
  const cal: Record<string, number> = {};
  for (const [code, name, country] of [['IT-FAC', 'Production facility (Italy)', 'IT'], ['DE', 'Germany', 'DE'], ['FR', 'France', 'FR'], ['NL', 'Netherlands', 'NL'], ['AT', 'Austria', 'AT'], ['US', 'United States', 'US']]) {
    cal[country] = (await c.query('INSERT INTO calendars (code, name, country) VALUES ($1,$2,$3) RETURNING id', [code, name, country])).rows[0].id;
    for (const [d, n] of HOLIDAYS[country] ?? []) await c.query('INSERT INTO calendar_holidays (calendar_id, date, name) VALUES ($1,$2,$3)', [cal[country], d, n]);
  }
  await c.query(`UPDATE settings SET value = $1 WHERE key = 'default_calendar_id'`, [JSON.stringify(cal.IT)]);
  await c.query(`INSERT INTO settings (key, value, description) VALUES ('default_calendar_id', $1, 'Facility working calendar') ON CONFLICT (key) DO NOTHING`, [JSON.stringify(cal.IT)]);
  const wc: Record<string, number> = {};
  for (const [i, [code, name, fn, cap, mc, mr, model, notes]] of WORK_CENTERS.entries()) {
    wc[code] = (await c.query(`INSERT INTO work_centers (code, name, function, capacity, max_concurrent, min_rate, capacity_model, calendar_id, route_order, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [code, name, fn, cap, mc, mr, model, cal.IT, i + 1, notes])).rows[0].id;
  }
  // Subassembly testing/programming are sized to feed Final Assembly throughput.
  await c.query('UPDATE work_centers SET sizing_target_id = $1 WHERE code IN ($2, $3)', [wc.FA, 'SUB_TEST', 'SUB_PROG']);
  const eu = (await c.query(`SELECT id FROM regions WHERE code='EU'`)).rows[0].id;
  const na = (await c.query(`SELECT id FROM regions WHERE code='NA'`)).rows[0].id;
  const routes: Record<string, number> = {};
  const rdefs: [string, string, string, number, number, number, number, boolean, boolean, number[], string][] = [
    ['IT-DE', 'Italy → Germany (road)', 'DE', eu, 3, 2, 3, true, false, [cal.DE, cal.IT], 'Sunday truck ban (DE); no transport on public holidays'],
    ['IT-FR', 'Italy → France (road)', 'FR', eu, 3, 2, 3, true, false, [cal.FR, cal.IT], 'Sunday/holiday HGV restrictions'],
    ['IT-NL', 'Italy → Netherlands (road)', 'NL', eu, 3, 2, 3, true, false, [cal.NL], ''],
    ['IT-AT', 'Italy → Austria (road)', 'AT', eu, 2, 2, 3, true, false, [cal.AT, cal.IT], 'Weekend & holiday driving bans in Austria'],
    ['IT-IT', 'Domestic Italy (road)', 'IT', eu, 1, 1, 2, true, false, [cal.IT], ''],
    ['IT-US', 'Italy → United States (air/road)', 'US', na, 10, 5, 10, true, true, [cal.US], 'Customs clearance included; trucking 7 days/week'],
  ];
  for (const [code, name, dest, region, lead, min, max, sat, sun, hol, restr] of rdefs) {
    routes[code] = (await c.query(`INSERT INTO routes (code, name, origin_country, destination_country, region_id, lead_time_days, min_days, max_days,
      operates_saturday, operates_sunday, holiday_calendar_ids, restrictions) VALUES ($1,$2,'IT',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [code, name, dest, region, lead, min, max, sat, sun, hol, restr])).rows[0].id;
  }
  const products: Record<string, number> = {};
  for (const [code, name, family] of [['X800', 'Power Cabinet X800', 'POWER_CABINET'], ['X1200', 'Power Cabinet X1200', 'POWER_CABINET'], ['POLLUX', 'Dispenser POLLUX', 'DISPENSER'], ['VEGA', 'Dispenser VEGA', 'DISPENSER']]) {
    products[code] = (await c.query('INSERT INTO product_types (code, name, family) VALUES ($1,$2,$3) RETURNING id', [code, name, family])).rows[0].id;
    for (const [seq, scode, sname, fn, wcc, days, scope, kind, ms, dest] of STANDARD_ROUTING) {
      // X1200 cabinets need a longer EOL run (product-specific routing example).
      const d = code === 'X1200' && scode === 'EOL' ? 1.5 : days;
      await c.query(`INSERT INTO routing_steps (product_type_id, seq, code, name, function, work_center_id, duration_slots, scope, kind, milestone_tag, use_destination_calendar)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [products[code], seq, scode, sname, fn, wcc ? wc[wcc] : null, Math.round(d * 2), scope, kind, ms, dest]);
    }
  }
  for (const [code, name] of DELAY_CATEGORIES) await c.query('INSERT INTO delay_categories (code, name) VALUES ($1,$2)', [code, name]);
  const customers: Record<string, number> = {};
  for (const [name, country, region] of [['Voltway GmbH', 'DE', eu], ['Charge&Go SAS', 'FR', eu], ['MetroFleet Transit Inc.', 'US', na], ['Sunrise Logistics B.V.', 'NL', eu],
    ['Alpine Energie AG', 'AT', eu], ['Lakeside Bus Authority', 'US', na], ['Autostrade Elettriche S.p.A.', 'IT', eu]] as [string, string, number][]) {
    customers[name] = (await c.query('INSERT INTO customers (name, country, region_id) VALUES ($1,$2,$3) RETURNING id', [name, country, region])).rows[0].id;
  }
  return { cal, wc, routes, products, customers };
}

export async function truncateAll(c: pg.PoolClient) {
  await c.query(`TRUNCATE audit_events, decisions, plan_snapshots, scenarios, comments, delay_events, plan_versions, milestone_commitments, milestones,
    weekend_authorizations, reservations, dependencies, activities, units, shipments, order_lines, projects, delay_categories, routing_steps, product_types,
    routes, work_centers, customers, calendar_holidays, calendars, regions, permissions, users, settings RESTART IDENTITY CASCADE`);
}
