import bcrypt from 'bcryptjs';
import type pg from 'pg';

export const ROLES = ['MANUFACTURING', 'TESTING', 'RND', 'LOGISTICS', 'COMMERCIAL', 'SERVICE', 'MANAGEMENT'] as const;

const HOLIDAYS: Record<string, [string, string][]> = {
  IT: [['2026-11-01', 'Ognissanti'], ['2026-12-08', 'Immacolata'], ['2026-12-25', 'Natale'], ['2026-12-26', 'Santo Stefano'], ['2027-01-01', 'Capodanno'],
    ['2027-01-06', 'Epifania'], ['2027-03-29', 'Lunedì dell\'Angelo'], ['2027-04-25', 'Liberazione'], ['2027-05-01', 'Festa del Lavoro'], ['2027-06-02', 'Festa della Repubblica'], ['2027-08-15', 'Ferragosto']],
  DE: [['2026-12-25', 'Weihnachtstag'], ['2026-12-26', 'Zweiter Weihnachtstag'], ['2027-01-01', 'Neujahr'], ['2027-03-26', 'Karfreitag'], ['2027-03-29', 'Ostermontag'],
    ['2027-05-01', 'Tag der Arbeit'], ['2027-05-06', 'Christi Himmelfahrt'], ['2027-05-17', 'Pfingstmontag'], ['2027-10-03', 'Tag der Deutschen Einheit']],
  FR: [['2026-11-01', 'Toussaint'], ['2026-11-11', 'Armistice'], ['2026-12-25', 'Noël'], ['2027-01-01', 'Jour de l\'an'], ['2027-03-29', 'Lundi de Pâques'], ['2027-05-01', 'Fête du Travail']],
  NL: [['2026-12-25', 'Eerste Kerstdag'], ['2026-12-26', 'Tweede Kerstdag'], ['2027-01-01', 'Nieuwjaarsdag'], ['2027-03-29', 'Tweede Paasdag'], ['2027-04-27', 'Koningsdag']],
  AT: [['2026-12-08', 'Mariä Empfängnis'], ['2026-12-25', 'Christtag'], ['2026-12-26', 'Stefanitag'], ['2027-01-01', 'Neujahr'], ['2027-01-06', 'Heilige Drei Könige'], ['2027-03-29', 'Ostermontag']],
  CH: [['2026-12-25', 'Weihnachten'], ['2026-12-26', 'Stephanstag'], ['2027-01-01', 'Neujahr'], ['2027-01-02', 'Berchtoldstag'], ['2027-03-26', 'Karfreitag'], ['2027-03-29', 'Ostermontag']],
  ES: [['2026-12-08', 'Inmaculada Concepción'], ['2026-12-25', 'Navidad'], ['2027-01-01', 'Año Nuevo'], ['2027-01-06', 'Epifanía'], ['2027-03-26', 'Viernes Santo']],
  SE: [['2026-12-24', 'Julafton'], ['2026-12-25', 'Juldagen'], ['2026-12-26', 'Annandag jul'], ['2027-01-01', 'Nyårsdagen'], ['2027-01-06', 'Trettondedag jul']],
  FI: [['2026-12-06', 'Itsenäisyyspäivä'], ['2026-12-24', 'Jouluaatto'], ['2026-12-25', 'Joulupäivä'], ['2026-12-26', 'Tapaninpäivä'], ['2027-01-01', 'Uudenvuodenpäivä']],
  GB: [['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (substitute)'], ['2027-01-01', 'New Year\'s Day'], ['2027-03-26', 'Good Friday'], ['2027-03-29', 'Easter Monday']],
  GR: [['2026-12-25', 'Christmas'], ['2026-12-26', 'Synaxis'], ['2027-01-01', 'New Year'], ['2027-01-06', 'Epiphany']],
  US: [['2026-11-11', 'Veterans Day'], ['2026-11-26', 'Thanksgiving Day'], ['2026-12-25', 'Christmas Day'], ['2027-01-01', 'New Year\'s Day'], ['2027-01-18', 'Martin Luther King Jr. Day'],
    ['2027-02-15', 'Presidents\' Day'], ['2027-05-31', 'Memorial Day'], ['2027-07-05', 'Independence Day (observed)']],
  CA: [['2026-11-11', 'Remembrance Day'], ['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (observed)'], ['2027-01-01', 'New Year\'s Day'], ['2027-03-26', 'Good Friday']],
  AU: [['2026-12-25', 'Christmas Day'], ['2026-12-28', 'Boxing Day (observed)'], ['2027-01-01', 'New Year\'s Day'], ['2027-01-26', 'Australia Day']],
};
const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Production facility (Italy)', DE: 'Germany', FR: 'France', NL: 'Netherlands', AT: 'Austria', CH: 'Switzerland', ES: 'Spain', SE: 'Sweden',
  FI: 'Finland', GB: 'United Kingdom', GR: 'Greece', US: 'United States', CA: 'Canada', AU: 'Australia',
};

export const SETTINGS: [string, unknown, string][] = [
  ['freeze_days', 21, 'Program-wide planning freeze: calendar days before the forecast ExWorks date'],
  ['freeze_policy', { days: 21, inclusive: true, persistent: true, scope: 'SHIPMENT', decisionStatus: 'PROPOSED' },
    'Freeze boundary inclusive from ExWorks − 21 calendar days (recommended). persistent: a frozen delivery stays frozen even if its forecast slips. scope SHIPMENT: each delivery freezes on its own ExWorks. Persistent vs dynamic and split-delivery scope still require explicit approval (decisionStatus).'],
  ['timezone', 'Europe/Rome', 'Planning time zone of the production facility'],
  ['slot_hours', { amStart: '08:00', amEnd: '12:00', pmEnd: '17:00' }, 'Shift hours used to check precise cut-offs (collection, skid removal) against half-day slots'],
  ['risk_thresholds', { amberDays: 0, redDays: 3 }, 'Milestone risk: AMBER when variance > amberDays, RED when ≥ redDays working days (or commissioning beyond the customer date)'],
  ['notification_thresholds', { milestoneVarianceDays: 1, blockedHours: 4, capacityUtilizationPct: 95, staleConfirmationDays: 5 }, 'Thresholds used to highlight items in the daily call'],
  ['priority_rules', { newProjectPosition: 'BOTTOM', scarceCapacity: 'PROJECT_PRIORITY', demandOrder: ['COMMITTED', 'APPROVED', 'TENTATIVE'] }, 'Committed demand is served before approved and tentative demand; within a class, by the shared ranking'],
  ['half_day_granularity', true, 'Plan resolution is half a working day (AM / PM); precise timestamps are kept for cut-offs'],
  ['eol_resource_profile', { status: 'PROVISIONAL', profile: 'CONSERVATIVE_NO_OVERLAP', note: 'EOL uses two positions and one shared power test system needed for the whole test: a conservative fallback with no overlap. Testing must define the real phases (which sub-steps need the shared tester) before the ~1.5 systems/day business assumption can be scheduled.' },
    'EOL partial parallelisation must come from Testing; until configured the conservative profile is used and labelled provisional'],
  ['validation_assumptions', { sharedWithPrecommissioning: false, status: 'TO_CONFIRM', note: 'Validation skids and the pre-commissioning bench are modelled as separate resources sharing the R&D engineer pool. Confirm whether they are the same skids/personnel.' }, 'Open assumption on shared validation / pre-commissioning capacity'],
  ['precommissioning_allocation', { configurationReadiness: 'GATE_BEFORE_VALIDATION', finalPrecommissioningSlots: 1, status: 'TO_CONFIRM', note: 'Site configuration & numbering is a readiness gate before validation (no duration); the existing 0.5-day allowance is the final pre-commissioning after validation. Confirm the split.' }, 'How the 0.5-day pre-commissioning allowance is allocated'],
  ['offline_mode', { supported: false, note: 'Updates outside meetings are assumed to be made while connected. Disconnected editing and synchronisation are not implemented.' }, 'Offline usage assumption'],
  ['logistics_booking_trigger', { days: 5, dayType: 'CALENDAR', enabled: true },
    'Raise a transport-booking request to Logistics when a delivery\'s ExWorks date is within this many days and transport is not booked (dayType CALENDAR or WORKING)'],
  ['import_rules', { countryKeywords: [], internalHint: '', productNamePatterns: [], noiseWords: [] },
    'Ramp-up tracker import: organisation-specific vocabulary added to the generic rules. countryKeywords: [regex, ISO country]; internalHint: regex for internal / R&D rows; productNamePatterns: [regex, product code] for code names used in the tracker; noiseWords: words ignored when matching names'],
  ['clock_override', null, 'ISO timestamp that replaces the system clock (demos/tests only); null = real time'],
  ['demo_mode', true, 'Show demo users on the login page'],
];

export const PERMISSIONS: [string, string[], string][] = [
  ['activity.execute.MANUFACTURING', ['MANUFACTURING', 'MANAGEMENT'], 'Update status/actuals of manufacturing & packaging activities'],
  ['activity.execute.TESTING', ['TESTING', 'MANAGEMENT'], 'Update PCBA/subassembly programming & testing and EOL testing'],
  ['activity.execute.RND', ['RND', 'MANAGEMENT'], 'Update validation and pre-commissioning'],
  ['activity.execute.LOGISTICS', ['LOGISTICS', 'MANAGEMENT'], 'Update shipments'],
  ['activity.execute.SERVICE', ['SERVICE', 'MANAGEMENT'], 'Update installation and in-field commissioning'],
  ['project.create', ['COMMERCIAL', 'MANAGEMENT'], 'Create customer projects (initial backward plan)'],
  ['project.commercial.edit', ['COMMERCIAL', 'MANAGEMENT'], 'Edit customer required dates and commercial data'],
  ['scenario.create', ['COMMERCIAL', 'MANAGEMENT'], 'Create / simulate scenarios'],
  ['scenario.op.priority', ['COMMERCIAL', 'MANAGEMENT'], 'Propose priority changes'],
  ['scenario.op.schedule', ['MANAGEMENT'], 'Move activities, change durations, pull in, re-plan, regroup shipments, split visits'],
  ['scenario.op.capacity', ['MANAGEMENT'], 'Change capacity assumptions, reservations, weekend work'],
  ['scenario.op.configuration', ['COMMERCIAL', 'MANAGEMENT'], 'Propose configuration changes and demand commitment'],
  ['scenario.op.reassign', ['MANAGEMENT'], 'Propose unit reassignment between projects'],
  ['scenario.op.rework', ['MANAGEMENT'], 'Schedule rework packages and software update operations'],
  ['scenario.commit', ['COMMERCIAL', 'MANAGEMENT'], 'Commit scenarios that do not affect frozen deliveries'],
  ['freeze.override', ['MANAGEMENT'], 'Approve / commit changes affecting frozen deliveries (justification mandatory)'],
  ['plan.recalculate', ['MANAGEMENT'], 'Trigger immediate recalculation'],
  ['plan.accept_forecast', ['MANAGEMENT'], 'Accept the current forecast as the new commitment'],
  ['activity.lock', ['MANAGEMENT'], 'Lock / unlock activity commitments'],
  ['snapshot.create', ['MANAGEMENT'], 'Start a daily call (plan snapshot)'],
  ['decision.create', ['MANAGEMENT'], 'Record daily-call decisions'],
  ['admin.config', ['MANAGEMENT'], 'Administration and configuration'],
  ['import.apply', ['MANAGEMENT'], 'Apply reviewed imports (orders, materials, ramp-up tracker)'],
  // Narrow capabilities: granted to named users (user_capabilities) or to roles listed here.
  ['gate.manage', ['MANAGEMENT'], 'Create readiness gates; owners update their own gates'],
  ['gate.conditional_release', ['MANAGEMENT'], 'Approve a conditional release (scope, conditions, expiry)'],
  ['material.confirm', ['MANAGEMENT'], 'Confirm receipts, stock and allocations; add manual requirements'],
  ['configuration.approve', ['MANAGEMENT'], 'Approve a customer configuration version'],
  ['quality.disposition', [], 'Set unit dispositions, open/release quality holds'],
  ['quality.release', [], 'Release test results (passed and released)'],
  ['release.approve', [], 'Approve software/firmware releases for a defined scope'],
  ['test_scope.approve', [], 'Approve test plans / reduced validation scope'],
  ['logistics.acknowledge', ['LOGISTICS', 'MANAGEMENT'], 'Acknowledge configuration changes for logistics / order-to-cash'],
  ['logistics.manage', ['LOGISTICS', 'MANAGEMENT'], 'Shipment bookings, documents, collection slots'],
  ['site.manage', ['SERVICE', 'MANAGEMENT'], 'Site readiness, installation and commissioning-visit data'],
];

export const DELAY_CATEGORIES: [string, string][] = [
  ['MATERIAL', 'Material shortage / late supplier delivery'], ['QUALITY', 'Quality issue / test failure'], ['RESOURCE', 'Staff or equipment unavailable'],
  ['ENGINEERING', 'Engineering / firmware issue'], ['SOFTWARE', 'Software release not available'], ['CUSTOMER', 'Customer / site not ready'],
  ['LOGISTICS', 'Transport / customs / documents'], ['CONFIGURATION', 'Configuration change'], ['OTHER', 'Other'], ['SYSTEM', 'System-detected'],
];

// [code, name, function, type, capacity, region, notes, provisional]
export const RESOURCES: [string, string, string, string, number, string | null, string, boolean][] = [
  ['PCBA_MFG', 'PCBA manufacturing line', 'MANUFACTURING', 'STATION', 4, null, 'Sized to feed downstream throughput', false],
  ['PCBA_PROG', 'PCBA programming', 'TESTING', 'STATION', 4, null, '', false],
  ['PCBA_TEST', 'PCBA testing', 'TESTING', 'STATION', 4, null, '', false],
  ['SUB_MFG', 'Subassembly manufacturing', 'MANUFACTURING', 'STATION', 4, null, '', false],
  ['SUB_TEST', 'Subassembly testing', 'TESTING', 'STATION', 3, null, 'Sized to Final Assembly needs', false],
  ['SUB_PROG', 'Subassembly programming', 'TESTING', 'STATION', 3, null, 'Sized to Final Assembly needs', false],
  ['FA', 'Final assembly positions', 'MANUFACTURING', 'POSITION', 3, null, '3 physical systems in parallel', false],
  ['EOL_POS', 'EOL test positions', 'TESTING', 'POSITION', 2, null, 'Two physical EOL positions', false],
  ['EOL_HV', 'EOL power test system (shared)', 'TESTING', 'SHARED', 1, null, 'Exclusive shared equipment — which EOL phases need it must be defined by Testing (provisional)', true],
  ['REWORK', 'Rework station', 'MANUFACTURING', 'STATION', 1, null, 'Compatible station for rework', false],
  ['ME_QA', 'Manufacturing Engineering / Quality support', 'MANUFACTURING', 'PERSONNEL', 1, null, 'Required for rework instructions and approvals', false],
  ['SKID', 'Validation skids', 'RND', 'SKID', 2, null, '2 skids; occupied from setup until disconnection & removal', false],
  ['SKID_SUPPLY', 'Shared R&D HV supply / setup', 'RND', 'SHARED', 2, null, 'Shared infrastructure behind both skids; troubleshooting and regression use reduce it', false],
  ['RND_TECH', 'R&D validation engineers', 'RND', 'PERSONNEL', 3, null, 'Shared by validation setup and pre-commissioning (assumption to confirm)', false],
  ['HANDLING', 'Handling crew (disconnection & removal)', 'MANUFACTURING', 'PERSONNEL', 1, null, 'Needed to release a skid', false],
  ['PRECOMM', 'Pre-commissioning bench', 'RND', 'STATION', 2, null, '2 systems in parallel; separate from skids (assumption to confirm)', false],
  ['PACK', 'Packaging area', 'MANUFACTURING', 'AREA', 3, null, '', false],
  ['LOG_PREP', 'Outbound preparation', 'LOGISTICS', 'PERSONNEL', 2, null, 'Internal outbound preparation (labels, loading)', false],
  ['COMM_EU', 'Commissioning teams Europe', 'SERVICE', 'TEAM', 2, 'EU', '2 systems in parallel', false],
  ['COMM_NA', 'Commissioning teams North America', 'SERVICE', 'TEAM', 2, 'NA', '2 systems in parallel', false],
];

// [code, name, family, item code patterns, default hw revision]
export const PRODUCTS: [string, string, string, string[], string][] = [
  ['X800', 'Power Cabinet X800', 'POWER_CABINET', ['YAD.B13*'], 'SILVER'],
  ['X1200', 'Power Cabinet X1200', 'POWER_CABINET', [], 'SILVER'],
  ['M400', 'Power Cabinet M400', 'POWER_CABINET', ['YAE.A0L0*'], 'SILVER'],
  ['M200', 'Power Cabinet M200', 'POWER_CABINET', ['YAE.A0L1*'], 'SILVER'],
  ['POLLUX', 'Dispenser POLLUX (Solo)', 'DISPENSER', ['YAD.A0H*'], 'SILVER'],
  ['DUO', 'Dispenser DUO', 'DISPENSER', ['YAD.A0N*'], 'SILVER'],
  ['VEGA', 'Dispenser VEGA', 'DISPENSER', [], 'SILVER'],
  ['ULTRA', 'Dispenser ULTRA (MCS)', 'DISPENSER', ['YAD.P09*'], 'BRONZE'],
  ['CDOCK', 'Charge Dock', 'CHARGE_DOCK', ['YAE.A0Q*'], 'SILVER'],
];

interface StepRow {
  seq: number; code: string; name: string; fn: string; wc: string | null; slots: number;
  scope?: string; stage?: string; kind?: string; tag?: string | null; dest?: boolean;
  phases?: { name: string; slots: number; resources: [string, number][] }[];
  holdFrom?: { seq: number; wc: string };
  testPlan?: string;
  gates?: unknown[];
}

const unitSteps = (eolSlots = 2): StepRow[] => [
  { seq: 10, code: 'PCBA_MFG', name: 'Manufacturing PCBAs', fn: 'MANUFACTURING', wc: 'PCBA_MFG', slots: 2 },
  { seq: 20, code: 'PCBA_PROG', name: 'Programming PCBAs', fn: 'TESTING', wc: 'PCBA_PROG', slots: 1,
    gates: [{ dimension: 'SOFTWARE', component: 'BOARD_FW', requirement: 'AVAILABLE', blocks: 'START', title: 'Board firmware approved & available' }] },
  { seq: 30, code: 'PCBA_TEST', name: 'Testing PCBAs', fn: 'TESTING', wc: 'PCBA_TEST', slots: 1 },
  { seq: 40, code: 'SUB_MFG', name: 'Manufacturing subassemblies', fn: 'MANUFACTURING', wc: 'SUB_MFG', slots: 2 },
  { seq: 50, code: 'SUB_TEST', name: 'Testing subassemblies', fn: 'TESTING', wc: 'SUB_TEST', slots: 1 },
  { seq: 60, code: 'SUB_PROG', name: 'Programming subassemblies', fn: 'TESTING', wc: 'SUB_PROG', slots: 1 },
  { seq: 70, code: 'FA', name: 'Final assembly (FA)', fn: 'MANUFACTURING', wc: 'FA', slots: 1 },
  { seq: 80, code: 'EOL', name: 'Final assembly / EOL testing', fn: 'TESTING', wc: 'EOL_POS', slots: eolSlots, tag: 'EOL', testPlan: 'EOL-STD',
    phases: [{ name: 'EOL test (provisional conservative profile)', slots: eolSlots, resources: [['EOL_POS', 1], ['EOL_HV', 1]] }],
    gates: [{ dimension: 'SOFTWARE', component: 'SYS_SW', requirement: 'INSTALLED_VERIFIED', blocks: 'COMPLETE', title: 'System software approved, installed & checked' }] },
  { seq: 2010, code: 'PACK', name: 'Packaging', fn: 'MANUFACTURING', wc: 'PACK', slots: 2, stage: 'POST', tag: 'PACK',
    gates: [{ dimension: 'QUALITY', source: 'TEST_RELEASE', title: 'Validation passed & released for packaging', blocks: 'START' }] },
];

const systemSteps: StepRow[] = [
  { seq: 1010, code: 'VAL_SETUP', name: 'Validation setup & connection', fn: 'RND', wc: 'SKID', slots: 1, scope: 'SYSTEM',
    phases: [{ name: 'Setup & connection', slots: 1, resources: [['SKID', 1], ['RND_TECH', 1]] }],
    gates: [
      { dimension: 'CONFIGURATION', title: 'Site configuration & numbering ready (pre-validation)', blocks: 'START', owner: 'RND' },
      { dimension: 'QUALITY', source: 'TEST_RELEASE_EOL', title: 'EOL passed & released for all units', blocks: 'START' },
    ] },
  { seq: 1020, code: 'VAL', name: 'System validation', fn: 'RND', wc: 'SKID', slots: 4, scope: 'SYSTEM', testPlan: 'VAL-STD',
    phases: [{ name: 'System validation', slots: 4, resources: [['SKID', 1], ['SKID_SUPPLY', 1]] }], holdFrom: { seq: 1010, wc: 'SKID' } },
  { seq: 1030, code: 'VAL_REMOVE', name: 'Disconnection, removal & handover', fn: 'RND', wc: 'SKID', slots: 1, scope: 'SYSTEM',
    phases: [{ name: 'Disconnection & removal', slots: 1, resources: [['SKID', 1], ['HANDLING', 1]] }], holdFrom: { seq: 1020, wc: 'SKID' } },
  { seq: 1040, code: 'PRECOMM', name: 'Pre-commissioning (final)', fn: 'RND', wc: 'PRECOMM', slots: 1, scope: 'SYSTEM',
    phases: [{ name: 'Pre-commissioning', slots: 1, resources: [['PRECOMM', 1], ['RND_TECH', 1]] }] },
];

const shipmentSteps: StepRow[] = [
  { seq: 3010, code: 'OUT_PREP', name: 'Outbound preparation', fn: 'LOGISTICS', wc: 'LOG_PREP', slots: 1, scope: 'SHIPMENT',
    gates: [{ dimension: 'EXTERNAL', source: 'SHIPMENT_BOOKING', title: 'Transport booked', blocks: 'COMPLETE' }] },
  { seq: 3020, code: 'TRANSIT', name: 'Transit', fn: 'LOGISTICS', wc: null, slots: 6, scope: 'SHIPMENT', kind: 'transport',
    gates: [{ dimension: 'EXTERNAL', source: 'SHIPMENT_DOCS', title: 'Shipping documents ready', blocks: 'START' },
      { dimension: 'QUALITY', source: 'TECH_RELEASE', title: 'Units technically released (no quality holds)', blocks: 'START' }] },
  { seq: 3030, code: 'CUSTOMS', name: 'Customs allowance', fn: 'LOGISTICS', wc: null, slots: 0, scope: 'SHIPMENT', kind: 'calendar' },
  { seq: 3040, code: 'DELIVERY', name: 'Final delivery', fn: 'LOGISTICS', wc: null, slots: 0, scope: 'SHIPMENT', kind: 'external', dest: true },
];

const visitSteps: StepRow[] = [
  { seq: 4010, code: 'INSTALL', name: 'Installation (customer / contractor)', fn: 'SERVICE', wc: null, slots: 4, scope: 'SITE', kind: 'external', dest: true,
    gates: [{ dimension: 'EXTERNAL', source: 'SITE', title: 'Site access, foundation & utilities ready', blocks: 'START', owner: 'SERVICE' }] },
  { seq: 4020, code: 'COMM', name: 'In-field commissioning', fn: 'SERVICE', wc: 'COMM_EU', slots: 4, scope: 'SITE_SYSTEM', tag: 'COMM', dest: true,
    gates: [
      { dimension: 'EXTERNAL', source: 'SITE_RESPONSIBLE', title: 'Site work-responsible person named & confirmed', blocks: 'START', owner: 'SERVICE' },
      { dimension: 'RESOURCE', source: 'COMM_PERSONNEL', title: 'Commissioning personnel assigned (qualification confirmed)', blocks: 'START', owner: 'SERVICE' },
      { dimension: 'EXTERNAL', title: 'Connectivity / backend configuration ready', blocks: 'START', owner: 'SERVICE' },
    ] },
];

async function insertRouting(c: pg.PoolClient, wc: Record<string, number>, opts: { productTypeId: number | null; kind: string; code: string; steps: StepRow[]; notes?: string }) {
  const rv = (await c.query(`INSERT INTO routing_versions (product_type_id, template_kind, code, version, effective_from, status, notes)
    VALUES ($1,$2,$3,1,'2026-01-01','APPROVED',$4) RETURNING id`, [opts.productTypeId, opts.kind, opts.code, opts.notes ?? null])).rows[0].id;
  for (const s of opts.steps) {
    const phases = s.phases?.map((p) => ({ name: p.name, slots: p.slots, resources: p.resources.map(([code, units]) => ({ resourceId: wc[code], units })) })) ?? null;
    await c.query(`INSERT INTO routing_steps (routing_version_id, seq, code, name, function, work_center_id, duration_slots, scope, stage, kind, milestone_tag,
      use_destination_calendar, phases, hold_from, test_plan_code, gate_templates) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [rv, s.seq, s.code, s.name, s.fn, s.wc ? wc[s.wc] : null, s.slots, s.scope ?? 'UNIT', s.stage ?? 'PRE', s.kind ?? 'work', s.tag ?? null, s.dest ?? false,
      phases ? JSON.stringify(phases) : null, s.holdFrom ? JSON.stringify({ seq: s.holdFrom.seq, resourceId: wc[s.holdFrom.wc], units: 1 }) : null,
      s.testPlan ?? null, JSON.stringify(s.gates ?? [])]);
  }
  return rv;
}

export async function insertMasterData(c: pg.PoolClient) {
  for (const [k, v, d] of SETTINGS) await c.query('INSERT INTO settings (key, value, description) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, JSON.stringify(v), d]);
  await c.query(`INSERT INTO settings (key, value, description) VALUES ('schema_version', '4', 'Database schema version') ON CONFLICT (key) DO NOTHING`);
  for (const [a, r, d] of PERMISSIONS) await c.query('INSERT INTO permissions (action, roles, description) VALUES ($1,$2,$3)', [a, r, d]);
  const hash = await bcrypt.hash('demo', 8);
  const users: [string, string, string, string[]][] = [
    ['mfg', 'Marco Bianchi', 'MANUFACTURING', ['material.confirm']], ['test', 'Giulia Rossi', 'TESTING', ['quality.release']],
    ['rnd', 'Luca Ferri', 'RND', ['quality.release']], ['logistics', 'Sara Conti', 'LOGISTICS', []], ['commercial', 'Anna Weber', 'COMMERCIAL', []],
    ['service', 'Tom Becker', 'SERVICE', []], ['program', 'Paolo Ricci', 'MANAGEMENT', ['quality.disposition']], ['program2', 'Elena Gallo', 'MANAGEMENT', []],
    ['techauth', 'Dr. Irene Marchi (Technical Authority)', 'RND', ['release.approve', 'test_scope.approve', 'quality.release']],
    ['quality', 'Stefano Greco (Quality)', 'TESTING', ['quality.disposition', 'quality.release', 'gate.conditional_release']],
  ];
  const uid: Record<string, number> = {};
  for (const [u, n, r, caps] of users) {
    uid[u] = (await c.query('INSERT INTO users (username, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [u, n, r, hash])).rows[0].id;
    for (const cap of caps) await c.query('INSERT INTO user_capabilities (user_id, capability) VALUES ($1,$2)', [uid[u], cap]);
  }
  await c.query(`INSERT INTO regions (code, name) VALUES ('EU','Europe'), ('NA','North America'), ('APAC','Asia-Pacific')`);
  const cal: Record<string, number> = {};
  for (const country of Object.keys(COUNTRY_NAMES)) {
    cal[country] = (await c.query('INSERT INTO calendars (code, name, country) VALUES ($1,$2,$3) RETURNING id', [country === 'IT' ? 'IT-FAC' : country, COUNTRY_NAMES[country], country])).rows[0].id;
    for (const [d, n] of HOLIDAYS[country] ?? []) await c.query('INSERT INTO calendar_holidays (calendar_id, date, name) VALUES ($1,$2,$3)', [cal[country], d, n]);
  }
  await c.query(`INSERT INTO settings (key, value, description) VALUES ('default_calendar_id', $1, 'Facility working calendar') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(cal.IT)]);
  const wc: Record<string, number> = {};
  for (const [i, [code, name, fn, type, cap, region, notes, prov]] of RESOURCES.entries()) {
    wc[code] = (await c.query(`INSERT INTO work_centers (code, name, function, resource_type, capacity, calendar_id, region, route_order, notes, provisional)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [code, name, fn, type, cap, cal.IT, region, i + 1, notes, prov])).rows[0].id;
  }
  await c.query('UPDATE work_centers SET sizing_target_id = $1 WHERE code IN ($2, $3)', [wc.FA, 'SUB_TEST', 'SUB_PROG']);
  const region = async (code: string) => (await c.query('SELECT id FROM regions WHERE code = $1', [code])).rows[0].id;
  const eu = await region('EU'); const na = await region('NA'); const apac = await region('APAC');
  const routes: Record<string, number> = {};
  const rdefs: [string, string, string, number, number, number, number, boolean, boolean, string[], string][] = [
    ['IT-DE', 'Italy → Germany (road)', 'DE', eu, 3, 2, 3, true, false, ['DE', 'IT'], 'Sunday truck ban (DE); no transport on public holidays'],
    ['IT-FR', 'Italy → France (road)', 'FR', eu, 3, 2, 3, true, false, ['FR', 'IT'], 'Sunday/holiday HGV restrictions'],
    ['IT-NL', 'Italy → Netherlands (road)', 'NL', eu, 3, 2, 3, true, false, ['NL'], ''],
    ['IT-AT', 'Italy → Austria (road)', 'AT', eu, 2, 2, 3, true, false, ['AT', 'IT'], 'Weekend & holiday driving bans in Austria'],
    ['IT-CH', 'Italy → Switzerland (road)', 'CH', eu, 2, 2, 3, true, false, ['CH', 'IT'], 'Night and Sunday driving ban (CH); customs at border'],
    ['IT-ES', 'Italy → Spain (road)', 'ES', eu, 4, 3, 5, true, false, ['ES', 'IT'], ''],
    ['IT-SE', 'Italy → Sweden (road/ferry)', 'SE', eu, 5, 4, 6, true, false, ['SE'], ''],
    ['IT-FI', 'Italy → Finland (road/ferry)', 'FI', eu, 6, 5, 7, true, false, ['FI'], ''],
    ['IT-GB', 'Italy → United Kingdom (road/ferry)', 'GB', eu, 4, 3, 5, true, false, ['GB'], 'Customs clearance post-Brexit'],
    ['IT-GR', 'Italy → Greece (road/ferry)', 'GR', eu, 5, 4, 6, true, false, ['GR'], ''],
    ['IT-IT', 'Domestic Italy (road)', 'IT', eu, 1, 1, 2, true, false, ['IT'], ''],
    ['IT-US', 'Italy → United States', 'US', na, 10, 5, 21, true, true, ['US'], 'Air or sea; see service profiles'],
    ['IT-CA', 'Italy → Canada', 'CA', na, 10, 5, 21, true, true, ['CA'], 'Air or sea; see service profiles'],
    ['IT-AU', 'Italy → Australia', 'AU', apac, 60, 45, 70, true, true, ['AU'], 'Sea freight'],
  ];
  for (const [code, name, dest, reg, lead, min, max, sat, sun, hol, restr] of rdefs) {
    routes[code] = (await c.query(`INSERT INTO routes (code, name, origin_country, destination_country, region_id, lead_time_days, min_days, max_days,
      operates_saturday, operates_sunday, holiday_calendar_ids, restrictions) VALUES ($1,$2,'IT',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [code, name, dest, reg, lead, min, max, sat, sun, hol.map((h) => cal[h]), restr])).rows[0].id;
  }
  // [code, route, name, mode, level, prepSlots, transit, customs, finalDelivery, bookingLead, status, notes]
  const profiles: [string, string, string, string, string, number, number, number, number, number, string, string][] = [
    ['DE-ROAD-STD', 'IT-DE', 'Germany standard road', 'ROAD', 'STANDARD', 1, 3, 0, 0, 3, 'CONFIRMED', ''],
    ['DE-ROAD-DED', 'IT-DE', 'Germany dedicated truck', 'ROAD', 'DEDICATED', 1, 2, 0, 0, 2, 'CONFIRMED', 'Dedicated vehicle, direct delivery'],
    ['FR-ROAD-STD', 'IT-FR', 'France standard road', 'ROAD', 'STANDARD', 1, 3, 0, 0, 3, 'CONFIRMED', ''],
    ['NL-ROAD-STD', 'IT-NL', 'Netherlands standard road', 'ROAD', 'STANDARD', 1, 3, 0, 0, 3, 'CONFIRMED', ''],
    ['AT-ROAD-STD', 'IT-AT', 'Austria standard road', 'ROAD', 'STANDARD', 1, 2, 0, 0, 3, 'CONFIRMED', ''],
    ['CH-ROAD-STD', 'IT-CH', 'Switzerland road incl. customs', 'ROAD', 'STANDARD', 1, 2, 1, 0, 4, 'CONFIRMED', 'Customs declaration required'],
    ['ES-ROAD-STD', 'IT-ES', 'Spain standard road', 'ROAD', 'STANDARD', 1, 4, 0, 0, 3, 'ASSUMPTION', ''],
    ['SE-ROAD-STD', 'IT-SE', 'Sweden road/ferry', 'ROAD', 'STANDARD', 1, 5, 0, 0, 4, 'ASSUMPTION', ''],
    ['FI-ROAD-STD', 'IT-FI', 'Finland road/ferry', 'ROAD', 'STANDARD', 1, 6, 0, 0, 4, 'ASSUMPTION', ''],
    ['GB-ROAD-STD', 'IT-GB', 'United Kingdom road/ferry incl. customs', 'ROAD', 'STANDARD', 1, 4, 2, 0, 5, 'ASSUMPTION', ''],
    ['GR-ROAD-STD', 'IT-GR', 'Greece road/ferry', 'ROAD', 'STANDARD', 1, 5, 0, 0, 4, 'ASSUMPTION', ''],
    ['IT-ROAD-STD', 'IT-IT', 'Domestic road', 'ROAD', 'STANDARD', 1, 1, 0, 0, 2, 'CONFIRMED', ''],
    ['US-AIR', 'IT-US', 'United States air freight (min. 3 weeks door-to-door)', 'AIR', 'STANDARD', 2, 8, 7, 3, 7, 'ASSUMPTION', 'Case-specific planning input requiring Logistics confirmation; not a universal service level'],
    ['CA-AIR', 'IT-CA', 'Canada air freight', 'AIR', 'STANDARD', 2, 8, 7, 3, 7, 'ASSUMPTION', 'Requires Logistics confirmation'],
    ['AU-SEA', 'IT-AU', 'Australia sea freight (70 days)', 'SEA', 'STANDARD', 2, 60, 7, 3, 14, 'ASSUMPTION', 'Case-specific planning input requiring Logistics confirmation'],
  ];
  const sp: Record<string, number> = {};
  for (const [code, r, name, mode, level, prep, transit, customs, fin, lead, status, notes] of profiles) {
    sp[code] = (await c.query(`INSERT INTO service_profiles (route_id, code, name, mode, service_level, internal_prep_slots, transit_days, customs_days,
      final_delivery_days, booking_lead_days, confirmation_status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [routes[r], code, name, mode, level, prep, transit, customs, fin, lead, status, notes])).rows[0].id;
  }
  const products: Record<string, number> = {};
  for (const [code, name, family, items, hw] of PRODUCTS) {
    products[code] = (await c.query('INSERT INTO product_types (code, name, family, item_codes, default_hw_revision) VALUES ($1,$2,$3,$4,$5) RETURNING id', [code, name, family, items, hw])).rows[0].id;
    const eol = code === 'X1200' ? 3 : 2;
    await insertRouting(c, wc, { productTypeId: products[code], kind: 'UNIT', code: `UNIT-${code}`, steps: unitSteps(eol) });
  }
  await insertRouting(c, wc, { productTypeId: null, kind: 'SYSTEM', code: 'SYSTEM-STD', steps: systemSteps, notes: 'One validation per complete system (cabinet + outlets), not per unit' });
  await insertRouting(c, wc, { productTypeId: null, kind: 'SHIPMENT', code: 'SHIPMENT-STD', steps: shipmentSteps, notes: 'Durations come from the shipment service profile' });
  await insertRouting(c, wc, { productTypeId: null, kind: 'VISIT', code: 'VISIT-STD', steps: visitSteps, notes: 'Installation per site intervention, commissioning per system' });

  for (const [code, name, scope, version, slots, status, rationale] of [
    ['EOL-STD', 'EOL standard test', 'UNIT', 1, 2, 'APPROVED', 'Standard EOL test plan'],
    ['VAL-STD', 'System validation — standard (2 days)', 'SYSTEM', 1, 4, 'APPROVED', 'Planning default: 2 working days per system'],
    ['VAL-STD', 'System validation — 3-day near-term assumption', 'SYSTEM', 2, 6, 'DRAFT', 'Temporary near-term planning assumption; a different input from the 2-day default, not applied automatically'],
    ['VAL-RED', 'Reduced system validation (extended EOL coverage)', 'SYSTEM', 1, 2, 'PROPOSED', 'Proposed after improved EOL coverage; requires approved test scope'],
  ] as [string, string, string, number, number, string, string][]) {
    await c.query('INSERT INTO test_plans (code, name, scope, version, duration_slots, status, rationale) VALUES ($1,$2,$3,$4,$5,$6,$7)', [code, name, scope, version, slots, status, rationale]);
  }
  for (const [code, name] of DELAY_CATEGORIES) await c.query('INSERT INTO delay_categories (code, name) VALUES ($1,$2)', [code, name]);
  for (const [code, name, kind, fam] of [
    ['SYS_SW', 'System software (EAP release)', 'SOFTWARE', null], ['BOARD_FW', 'Board firmware package', 'FIRMWARE', null],
    ['DCC_FPGA', 'DC controller FPGA bitstream', 'FPGA', 'POWER_CABINET'], ['PROG_TOOL', 'Production programming tool', 'TOOL', null],
  ] as [string, string, string, string | null][]) {
    await c.query('INSERT INTO sw_components (code, name, kind, product_family) VALUES ($1,$2,$3,$4)', [code, name, kind, fam]);
  }
  for (const [pn, desc] of [
    ['K1-DC-CONT', 'DC contactor K1'], ['PYRO-CTRL', 'Pyrofuse control board'], ['CAB-COOLER', 'Cabinet cooler'], ['DCBOX-BYP', 'DC box bypass module'],
    ['FIB-ETH', 'Fiber-to-Ethernet converter'], ['BASE-PLATE', 'Foundation base plate'], ['INSTALL-JIG', 'Installation jig'], ['CC-CABLE', 'Charging cable with cooler'],
  ]) await c.query('INSERT INTO materials (part_number, description) VALUES ($1,$2)', [pn, desc]);
  const customers: Record<string, number> = {};
  for (const [name, country, reg] of [['Voltway GmbH', 'DE', eu], ['Charge&Go SAS', 'FR', eu], ['MetroFleet Transit Inc.', 'US', na], ['Sunrise Logistics B.V.', 'NL', eu],
    ['Alpine Energie AG', 'AT', eu], ['Lakeside Bus Authority', 'US', na], ['Autostrade Elettriche S.p.A.', 'IT', eu], ['Helvetia Bus AG', 'CH', eu]] as [string, string, number][]) {
    customers[name] = (await c.query('INSERT INTO customers (name, country, region_id) VALUES ($1,$2,$3) RETURNING id', [name, country, reg])).rows[0].id;
  }
  return { cal, wc, routes, products, customers, profiles: sp, users: uid };
}

export async function truncateAll(c: pg.PoolClient) {
  const r = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  await c.query(`TRUNCATE ${r.rows.map((x) => `"${x.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
