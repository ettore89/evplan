/**
 * Parser for the OM Ramp-Up Tracker workbook (Excel). Pure: workbook → structured data, no database.
 *
 * The tracker is a hand-maintained spreadsheet, so parsing is deliberately conservative:
 * - colours are read as statuses only where the sheet has a legend (green = completed / ready,
 *   yellow = work in progress, red = delay / blocked, no fill = unknown);
 * - free-text dates are kept as text; only an unambiguous dd.mm.yyyy statement becomes an exact date,
 *   everything else (weeks, months, "tbc", "CHANGE: …", several statements) is indicative;
 * - nothing is guessed silently: every interpretation is reported so it can be reviewed before applying.
 */
import ExcelJS from 'exceljs';

export type CellState = 'READY' | 'PENDING' | 'BLOCKED' | 'UNKNOWN';
export interface DateVal { iso: string | null; exact: boolean; text: string | null; week?: number }
export interface TrackerLine { name: string | null; codes: string[]; quantity: number }
export interface TrackerProject {
  row: number; priority: number | null; wave: string | null; series: string | null; customer: string; rationale: string | null; scope: string | null;
  requiredCommissioning: DateVal; requiredExw: DateVal; customerSituation: string | null; sapOrderRef: string | null; o2cOwner: string | null;
  mitigations: string | null; lines: TrackerLine[]; foundationByAbb: string | null; basePlates: number | null; jigs: number | null; spoc: string | null;
  attributes: Record<string, string>;
}
export interface Span { from: string; to: string }
export interface TrackerUnit {
  row: number; name: string; mapping: string; itemCode: string | null; serial: string | null; maturity: string | null;
  installationDate: DateVal; requestedExw: DateVal; productionEnd: DateVal; confirmedExw: DateVal;
  componentAvailability: string | null; subassemblies: { name: string; state: CellState }[]; eolStatus: string | null;
  rowState: 'COMPLETED' | 'WIP' | 'CRITICAL' | 'NONE';
  production: Span | null; eol: Span | null; released: string | null; delayDays: number; labels: { text: string; from: string; to: string }[];
}
export interface TrackerVisit {
  row: number; project: string; batch: string | null; configuration: string | null; personnelStatus: string | null;
  dates: Record<string, { date: string; state: 'PLANNED' | 'ON_TIME' | 'LATE' } | null>;
  roles: { role: string; person: string }[];
}
export interface TrackerRelease { version: string; knownIssues: string[] }
export interface TrackerCoverage { family: string; module: string; requirements: string | null; scripts: string | null; config: string | null; testBench: string | null; handover: string | null; owner: string | null; remarks: string | null }
export interface TrackerTopic { row: number; topic: string; latest: string | null; responsible: string | null; status: string | null; followUp: string | null; open: boolean }
export interface ParsedTracker {
  asOf: string; sheets: string[]; warnings: string[];
  projects: TrackerProject[]; units: TrackerUnit[]; skippedRows: { sheet: string; row: number; text: string; reason: string }[];
  visits: TrackerVisit[]; releases: TrackerRelease[]; coverage: TrackerCoverage[]; topics: TrackerTopic[];
}

const GREEN = new Set(['FF92D050', 'FF00B050', 'FF00FF00']);
const YELLOW = new Set(['FFFFFF00', 'FFFFC000']);
const RED = new Set(['FFFF0000', 'FFC00000']);
const PINK = 'FFFF99FF';
const BLUE = 'FF00B0F0';

/** Plain value of a cell: rich text, hyperlinks and formula results are flattened. */
export function cellValue(cell: ExcelJS.Cell | undefined): string | number | Date | null {
  if (!cell) return null;
  const v: any = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v) return (v.richText as { text: string }[]).map((t) => t.text).join('');
    if ('result' in v) return v.result instanceof Date ? v.result : v.result ?? null;
    if ('text' in v) return typeof v.text === 'string' ? v.text : String(v.text ?? '');
    if ('error' in v) return null;
    return String(v);
  }
  return v;
}
const text = (cell: ExcelJS.Cell | undefined): string | null => {
  const v = cellValue(cell);
  if (v === null) return null;
  if (v instanceof Date) return isoOf(v);
  const s = String(v).replace(/\r/g, '').trim();
  return s.length ? s : null;
};
const num = (cell: ExcelJS.Cell | undefined): number | null => {
  const v = cellValue(cell);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
};
/** Solid fill colour as ARGB, or "theme:<n>:<tint>" for theme colours. */
export function fillOf(cell: ExcelJS.Cell | undefined): string | null {
  const f: any = cell?.fill;
  if (!f || f.type !== 'pattern' || !f.pattern || f.pattern === 'none') return null;
  const c = f.fgColor ?? {};
  if (c.argb) return String(c.argb).toUpperCase();
  if (c.theme !== undefined) return `theme:${c.theme}:${Number(c.tint ?? 0).toFixed(2)}`;
  if (c.indexed !== undefined) return `indexed:${c.indexed}`;
  return null;
}
const stateOfFill = (f: string | null): CellState => (f && GREEN.has(f) ? 'READY' : f && YELLOW.has(f) ? 'PENDING' : f && RED.has(f) ? 'BLOCKED' : 'UNKNOWN');

export function isoOf(d: Date) {
  // Excel dates are stored as local midnight; read them as calendar dates.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (d.getUTCHours() >= 12 ? 1 : 0))).toISOString().slice(0, 10);
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Friday of ISO week `w`, in the year that puts it closest to `asOf`. */
export function fridayOfWeek(w: number, asOf: string): string {
  const ref = Date.parse(asOf);
  let best = '';
  let bestDist = Infinity;
  for (const y of [new Date(ref).getUTCFullYear() - 1, new Date(ref).getUTCFullYear(), new Date(ref).getUTCFullYear() + 1]) {
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (w - 1) * 7 * 86400000);
    const fri = new Date(monday.getTime() + 4 * 86400000);
    const dist = Math.abs(fri.getTime() - ref - 60 * 86400000); // trackers mostly look ahead
    if (dist < bestDist) { bestDist = dist; best = fri.toISOString().slice(0, 10); }
  }
  return best;
}

function monthDate(s: string, asOf: string): string | null {
  const m = s.toLowerCase().match(/\b(mid|early|end|late|beginning of|start of|end of)?[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d\d))?/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2]);
  const ref = new Date(Date.parse(asOf));
  let y = m[3] ? Number(m[3]) : ref.getUTCFullYear();
  if (!m[3] && mi < ref.getUTCMonth() - 2) y++;
  const last = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();
  const day = m[1]?.startsWith('mid') ? 15 : m[1] && /early|beginning|start/.test(m[1]) ? 10 : last;
  return new Date(Date.UTC(y, mi, day)).toISOString().slice(0, 10);
}

/** Interpret a tracker date cell. Exact only for a single, unqualified dd.mm.yyyy (or a real date cell). */
export function parseDateCell(cell: ExcelJS.Cell | undefined, asOf: string, opts: { weekNumbers?: boolean } = {}): DateVal {
  const v = cellValue(cell);
  if (v === null) return { iso: null, exact: false, text: null };
  if (v instanceof Date) return { iso: isoOf(v), exact: true, text: isoOf(v) };
  if (typeof v === 'number') {
    if (opts.weekNumbers !== false && v >= 1 && v <= 53 && Number.isInteger(v)) return { iso: fridayOfWeek(v, asOf), exact: false, text: `W${v}`, week: v };
    if (v > 30000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return { iso: d.toISOString().slice(0, 10), exact: true, text: null }; }
    return { iso: null, exact: false, text: String(v) };
  }
  return parseDateText(String(v), asOf);
}

export function parseDateText(raw: string, asOf: string): DateVal {
  const t = raw.replace(/\r/g, '').trim();
  if (!t) return { iso: null, exact: false, text: null };
  // A later "CHANGE:" statement supersedes the earlier one.
  const effective = t.includes('CHANGE:') ? t.slice(t.lastIndexOf('CHANGE:') + 7).trim() : t;
  const statements = effective.split(/\n|\s\/\s/).map((s) => s.trim()).filter(Boolean);
  // The last statement that carries a date wins (trackers append updates below the original value).
  for (let i = statements.length - 1; i >= 0; i--) {
    const d = statementDate(statements[i], asOf);
    if (!d) continue;
    const qualified = /tbc|tbd|expected|planning|ideally|approx|about|latest|earliest|\bor\b|\?/i.test(effective);
    return { iso: d.iso, exact: d.exact && statements.length === 1 && !t.includes('CHANGE:') && !qualified, text: t, week: d.week };
  }
  return { iso: null, exact: false, text: t };
}

function statementDate(s: string, asOf: string): { iso: string; exact: boolean; week?: number } | null {
  const dm = [...s.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/g)].map((m) => {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) || y < 2000 ? null : d.toISOString().slice(0, 10);
  }).filter((x): x is string => !!x);
  if (dm.length) return { iso: dm[dm.length - 1], exact: dm.length === 1 };
  const wk = s.match(/\b(?:k?w|week)\s*(\d{1,2})\b/i);
  if (wk) return { iso: fridayOfWeek(Number(wk[1]), asOf), exact: false, week: Number(wk[1]) };
  const q = s.match(/\bq([1-4])\s*(20\d\d)/i);
  if (q) return { iso: new Date(Date.UTC(Number(q[2]), Number(q[1]) * 3, 0)).toISOString().slice(0, 10), exact: false };
  const md = monthDate(s, asOf);
  if (md) return { iso: md, exact: false };
  return null;
}

function findSheet(wb: ExcelJS.Workbook, re: RegExp) {
  return wb.worksheets.find((w) => re.test(w.name.trim()));
}

/** Locate the row whose cells contain all labels (case-insensitive), searching the first rows. */
function headerRow(ws: ExcelJS.Worksheet, labels: RegExp[], maxRow = 15): { row: number; cols: number[] } | null {
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount); r++) {
    const row = ws.getRow(r);
    const cols = labels.map((re) => {
      for (let c = 1; c <= Math.min(ws.columnCount, 80); c++) { const t = text(row.getCell(c)); if (t && re.test(t)) return c; }
      return -1;
    });
    if (cols.every((c) => c > 0)) return { row: r, cols };
  }
  return null;
}

function parsePriority(ws: ExcelJS.Worksheet, asOf: string, out: ParsedTracker) {
  const h = headerRow(ws, [/^prio$/i, /^customer$/i, /required commissioning/i, /required exw/i]);
  if (!h) { out.warnings.push(`Sheet "${ws.name}": header row (Prio / Customer / Required Commissioning / Required EXW) not found`); return; }
  const hdr = ws.getRow(h.row);
  const col = (re: RegExp) => { for (let c = 1; c <= ws.columnCount; c++) { const t = text(hdr.getCell(c)); if (t && re.test(t)) return c; } return -1; };
  const C = {
    prio: h.cols[0], customer: h.cols[1], reqComm: h.cols[2], reqExw: h.cols[3], wave: col(/^eap$/i), series: col(/^series$/i), rationale: col(/^rational/i),
    scope: col(/^scope$/i), situation: col(/customer situation/i), sap: col(/SO Number/i), o2c: col(/O2C/i), mitig: col(/mitigation/i),
    cabName: col(/cabinet name/i), cabCode: col(/cabinet code/i), cabQty: col(/cabinet count/i),
    aName: col(/dispenser a name/i), aCode: col(/dispenser a code/i), aRight: col(/right code/i), aQty: col(/dispenser a count/i),
    bName: col(/dispenser b name/i), bCode: col(/dispenser b code/i), bQty: col(/dispenser b count/i),
    foundation: col(/foundation by abb/i), plate: col(/base plate count/i), jig: col(/jig count/i), spoc: col(/^spoc$/i),
  };
  const attrCols: [string, number][] = [['OCPP backend', col(/OCPP/i)], ['Energy management', col(/energy mgmt/i)], ['Payment terminal', col(/payment terminal/i)],
    ['Internet connectivity', col(/internet connectivity/i)], ['Single line diagram', col(/single line diagram/i)]];
  const codesOf = (...cells: (ExcelJS.Cell | undefined)[]) => [...new Set(cells.flatMap((c) => (text(c) ?? '').match(/\b[A-Z]{3}\.[A-Z0-9]{5}\.\d\b|\b[A-Z]{3}\.[A-Z0-9]{4,5}\b/g) ?? []))];
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cust = text(row.getCell(C.customer));
    if (!cust) continue;
    const g = (c: number) => (c > 0 ? text(row.getCell(c)) : null);
    const n = (c: number) => (c > 0 ? num(row.getCell(c)) : null);
    const lines: TrackerLine[] = [];
    const push = (name: string | null, codes: string[], qty: number | null) => { if ((qty ?? 0) > 0 || codes.length || name) lines.push({ name, codes, quantity: qty ?? 0 }); };
    push(g(C.cabName), codesOf(row.getCell(C.cabCode)), n(C.cabQty));
    push(g(C.aName), codesOf(row.getCell(C.aCode), C.aRight > 0 ? row.getCell(C.aRight) : undefined), n(C.aQty));
    if (C.bQty > 0) push(g(C.bName), codesOf(C.bCode > 0 ? row.getCell(C.bCode) : undefined), n(C.bQty));
    const attributes: Record<string, string> = {};
    for (const [k, c] of attrCols) { const v = g(c); if (v) attributes[k] = v; }
    out.projects.push({
      row: r, priority: n(C.prio), wave: g(C.wave), series: g(C.series), customer: cust.replace(/\s+/g, ' ').trim(), rationale: g(C.rationale), scope: g(C.scope),
      requiredCommissioning: parseDateCell(row.getCell(C.reqComm), asOf, { weekNumbers: false }), requiredExw: parseDateCell(row.getCell(C.reqExw), asOf, { weekNumbers: false }),
      customerSituation: g(C.situation), sapOrderRef: g(C.sap), o2cOwner: g(C.o2c), mitigations: g(C.mitig), lines,
      foundationByAbb: g(C.foundation), basePlates: n(C.plate), jigs: n(C.jig), spoc: g(C.spoc), attributes,
    });
  }
}

function parseProductionPlan(ws: ExcelJS.Worksheet, asOf: string, out: ParsedTracker) {
  const h = headerRow(ws, [/^name$/i, /item code/i, /^serial$/i]);
  if (!h) { out.warnings.push(`Sheet "${ws.name}": header row (Name / Item Code / Serial) not found`); return; }
  const hdr = ws.getRow(h.row);
  const col = (re: RegExp) => { for (let c = 1; c <= Math.min(ws.columnCount, 60); c++) { const t = text(hdr.getCell(c)); if (t && re.test(t)) return c; } return -1; };
  const C = {
    name: h.cols[0], item: h.cols[1], serial: h.cols[2], mapping: col(/mapping/i), maturity: col(/maturity/i), install: col(/installation date/i),
    reqExw: col(/requested exw/i), prodEnd: col(/production end/i), confExw: col(/confirmed/i), comp: col(/component/i), sub: col(/sub ?assembly/i), eol: col(/eol status/i),
  };
  // Timeline: a row above the header holds the calendar dates.
  const dateCols = new Map<number, string>();
  for (let r = 1; r < h.row; r++) {
    const row = ws.getRow(r);
    for (let c = Math.max(C.eol, C.sub) + 1; c <= ws.columnCount; c++) { const v = cellValue(row.getCell(c)); if (v instanceof Date) dateCols.set(c, isoOf(v)); }
    if (dateCols.size > 20) break;
  }
  const tlCols = [...dateCols.keys()].sort((a, b) => a - b);
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = text(row.getCell(C.name));
    if (!name) continue;
    const itemRaw = text(row.getCell(C.item));
    const mapping = (C.mapping > 0 ? text(row.getCell(C.mapping)) : null) ?? '';
    if (itemRaw && /^\d+$/.test(itemRaw)) { out.skippedRows.push({ sheet: ws.name, row: r, text: name, reason: 'Component quantity line, not a physical unit' }); continue; }
    const subs: { name: string; state: CellState }[] = [];
    if (C.sub > 0) for (let c = C.sub; c < (C.eol > 0 ? C.eol : C.sub + 13); c++) { const t = text(row.getCell(c)); if (t) subs.push({ name: t.replace(/\s+/g, ' '), state: stateOfFill(fillOf(row.getCell(c))) }); }
    const rowFill = fillOf(row.getCell(C.name));
    const rowState = rowFill && GREEN.has(rowFill) ? 'COMPLETED' : rowFill && YELLOW.has(rowFill) ? 'WIP' : rowFill && RED.has(rowFill) ? 'CRITICAL' : 'NONE';
    let production: Span | null = null; let eol: Span | null = null; let released: string | null = null; let delayDays = 0;
    const labels: { text: string; from: string; to: string }[] = [];
    for (const c of tlCols) {
      const cell = row.getCell(c); const d = dateCols.get(c)!; const f = fillOf(cell); const t = text(cell);
      const tok = (t ?? '').trim();
      if (/^eol$/i.test(tok) || (!tok && f === BLUE && eol)) { eol = eol ? { from: eol.from, to: d } : { from: d, to: d }; continue; }
      if (/^p$/i.test(tok) || /^production$/i.test(tok)) { production = production ? { from: production.from, to: d } : { from: d, to: d }; continue; }
      if (/^r$/i.test(tok)) { released = d; continue; }
      if (!tok && f && RED.has(f)) { delayDays++; continue; }
      if (tok) {
        const last = labels[labels.length - 1];
        if (last && last.text === tok) last.to = d; else labels.push({ text: tok.replace(/\s+/g, ' '), from: d, to: d });
      } else if (f === PINK && production) production = { from: production.from, to: d };
    }
    out.units.push({
      row: r, name: name.replace(/\s+/g, ' '), mapping: mapping.replace(/\s+/g, ' '), itemCode: itemRaw && /^[A-Z]{3}\./.test(itemRaw) ? itemRaw : null,
      serial: text(row.getCell(C.serial)), maturity: C.maturity > 0 ? text(row.getCell(C.maturity)) : null,
      installationDate: C.install > 0 ? parseDateCell(row.getCell(C.install), asOf) : { iso: null, exact: false, text: null },
      requestedExw: C.reqExw > 0 ? parseDateCell(row.getCell(C.reqExw), asOf) : { iso: null, exact: false, text: null },
      productionEnd: C.prodEnd > 0 ? parseDateCell(row.getCell(C.prodEnd), asOf) : { iso: null, exact: false, text: null },
      confirmedExw: C.confExw > 0 ? parseDateCell(row.getCell(C.confExw), asOf) : { iso: null, exact: false, text: null },
      componentAvailability: C.comp > 0 ? text(row.getCell(C.comp)) : null, subassemblies: subs, eolStatus: C.eol > 0 ? text(row.getCell(C.eol)) : null,
      rowState, production, eol, released, delayDays, labels,
    });
  }
}

function parseOnSite(ws: ExcelJS.Worksheet, out: ParsedTracker) {
  const h = headerRow(ws, [/project name/i, /^role$/i, /^person$/i]);
  if (!h) { out.warnings.push(`Sheet "${ws.name}": header row (Project Name / Role / Person) not found`); return; }
  const hdr = ws.getRow(h.row);
  const col = (re: RegExp) => { for (let c = 1; c <= 30; c++) { const t = text(hdr.getCell(c)); if (t && re.test(t.replace(/\s+/g, ' '))) return c; } return -1; };
  const C = {
    project: h.cols[0], role: h.cols[1], person: h.cols[2], config: col(/system configuration/i), status: col(/planning status/i),
    exw: col(/exw/i), plate: col(/base plate/i), charger: col(/charger/i), instStart: col(/start of installation/i), instEnd: col(/end of installation/i),
    commStart: col(/start of commis/i), commEnd: col(/end of commis/i), operation: col(/start of operation/i),
  };
  const dateState = (cell: ExcelJS.Cell): 'PLANNED' | 'ON_TIME' | 'LATE' => {
    const f = fillOf(cell);
    if (f && GREEN.has(f)) return 'ON_TIME';
    if (f && (f.startsWith('theme:') || RED.has(f)) && !/theme:0:0\.00|theme:1:/.test(f)) return 'LATE';
    return 'PLANNED';
  };
  let current: TrackerVisit | null = null;
  let lastProject: string | null = null;
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const proj = text(row.getCell(C.project));
    const role = text(row.getCell(C.role));
    const person = text(row.getCell(C.person));
    const isBatch = !proj && !role && person && /^batch\s*\d+/i.test(person) && lastProject;
    if (proj || isBatch) {
      lastProject = proj ?? lastProject;
      const dates: TrackerVisit['dates'] = {};
      for (const [k, c] of Object.entries({ exw: C.exw, baseplateArrival: C.plate, chargerArrival: C.charger, installStart: C.instStart, installEnd: C.instEnd, commStart: C.commStart, commEnd: C.commEnd, operationStart: C.operation })) {
        if (c < 0) continue;
        const v = cellValue(row.getCell(c));
        dates[k] = v instanceof Date ? { date: isoOf(v), state: dateState(row.getCell(c)) } : null;
      }
      current = { row: r, project: lastProject!.replace(/\s+/g, ' ').trim(), batch: isBatch ? person!.trim() : null, configuration: C.config > 0 ? text(row.getCell(C.config)) : null,
        personnelStatus: C.status > 0 ? text(row.getCell(C.status)) : null, dates, roles: [] };
      out.visits.push(current);
      continue;
    }
    if (current && role) {
      // Roles belong to every batch of the same project.
      for (const v of out.visits.filter((x) => x.project === current!.project)) if (person) v.roles.push({ role: role.replace(/\s+/g, ' '), person });
    }
  }
}

function parseReleases(ws: ExcelJS.Worksheet, out: ParsedTracker) {
  let cur: TrackerRelease | null = null;
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const a = text(row.getCell(1)); const b = text(row.getCell(2));
    const m = a?.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
    if (m) { cur = { version: m[1], knownIssues: [] }; out.releases.push(cur); }
    if (b && cur) cur.knownIssues.push(b.replace(/\s+/g, ' '));
  });
}

function parseCoverage(ws: ExcelJS.Worksheet, out: ParsedTracker) {
  const h = headerRow(ws, [/test requirements/i, /handover/i, /owner/i]);
  if (!h) { out.warnings.push(`Sheet "${ws.name}": header not found`); return; }
  let family: string | null = null;
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    family = text(row.getCell(1)) ?? family;
    const module = text(row.getCell(2));
    if (!module || !family) continue;
    const g = (c: number) => text(row.getCell(c));
    out.coverage.push({ family, module: module.replace(/\s+/g, ' '), requirements: g(3), scripts: g(4), config: g(5), testBench: g(6), handover: g(7), owner: g(8), remarks: g(9) });
  }
}

const CLOSED = /^(closed|solved|completed|done|duplicated|closed \(duplicated\))\b/i;
function parseTopics(ws: ExcelJS.Worksheet, out: ParsedTracker) {
  const h = headerRow(ws, [/^topic$/i, /^actions?$/i, /^status$/i]);
  if (!h) { out.warnings.push(`Sheet "${ws.name}": header not found`); return; }
  const hdr = ws.getRow(h.row);
  const col = (re: RegExp) => { for (let c = 1; c <= 15; c++) { const t = text(hdr.getCell(c)); if (t && re.test(t)) return c; } return -1; };
  const C = { topic: h.cols[0], actions: h.cols[1], status: h.cols[2], resp: col(/responsible/i), follow: col(/follow/i) };
  for (let r = h.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const topic = text(row.getCell(C.topic));
    if (!topic) continue;
    const status = text(row.getCell(C.status));
    const actions = text(row.getCell(C.actions));
    out.topics.push({
      row: r, topic: topic.replace(/\s+/g, ' '), latest: actions ? actions.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null : null,
      responsible: C.resp > 0 ? text(row.getCell(C.resp)) : null, status, followUp: C.follow > 0 ? text(row.getCell(C.follow)) : null,
      open: !status || !CLOSED.test(status.trim()),
    });
  }
}

export async function parseTrackerWorkbook(buffer: Buffer | ArrayBuffer, opts: { asOf?: string } = {}): Promise<ParsedTracker> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const modified = wb.modified instanceof Date && !Number.isNaN(wb.modified.getTime()) ? wb.modified : null;
  const asOf = opts.asOf ?? (modified ? modified.toISOString() : new Date().toISOString());
  const out: ParsedTracker = { asOf, sheets: wb.worksheets.map((w) => w.name), warnings: [], projects: [], units: [], skippedRows: [], visits: [], releases: [], coverage: [], topics: [] };
  if (!modified && !opts.asOf) out.warnings.push('Workbook has no "last modified" property; the upload time is used as the as-of time');
  const day = asOf.slice(0, 10);
  const pr = findSheet(wb, /^priority/i);
  if (pr) parsePriority(pr, day, out); else out.warnings.push('No "Priority…" sheet found: projects cannot be imported');
  const pp = findSheet(wb, /^production plan$/i);
  if (pp) parseProductionPlan(pp, day, out); else out.warnings.push('No "Production Plan" sheet found: units cannot be imported');
  const os = findSheet(wb, /^on site plan$/i);
  if (os) parseOnSite(os, out);
  const sw = findSheet(wb, /sw versions/i);
  if (sw) parseReleases(sw, out);
  const ts = findSheet(wb, /^test status$/i);
  if (ts) parseCoverage(ts, out);
  const tr = findSheet(wb, /^tracker$/i);
  if (tr) parseTopics(tr, out);
  for (const w of wb.worksheets) {
    if (![pr, pp, os, sw, ts, tr].includes(w)) out.warnings.push(`Sheet "${w.name}" is not imported (no mapping defined)`);
  }
  return out;
}
