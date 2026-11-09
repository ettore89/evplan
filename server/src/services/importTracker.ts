/**
 * Controlled import of the OM Ramp-Up Tracker: upload → preview (with reconciliation) → resolve names → apply.
 *
 * Rules (V4): nothing is overwritten silently; ambiguous or unmatched names must be confirmed by a person
 * and the decision is remembered as an alias; tracker progress only moves forward and never replaces
 * actuals recorded in the application; an older workbook cannot be applied over a newer one; tracker
 * colours become readiness states only where the sheet defines them, and an execution status from the
 * tracker never counts as a released test result.
 */
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { audit, bumpInputs, HttpError, requirePermission, todayDay, type AuthUser } from './common.js';
import { syncDerivedGates } from './gates.js';
import { createUnit, syncProjectGraph } from './graph.js';
import { createProject, planIndicative, planInitial } from './projects.js';
import { recalculate } from './recalc.js';
import { parseTrackerWorkbook, type ParsedTracker, type TrackerProject, type TrackerUnit, type TrackerVisit } from './trackerParse.js';

// ---------------------------------------------------------------- name normalisation & matching

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s: string) => norm(s).replace(/ /g, '');
/**
 * Matching rules. Only generic defaults live in code; organisation-specific vocabulary (customer and site names,
 * product code names, extra noise words) is configured in settings.import_rules by an administrator.
 */
export interface ImportRules { countryKeywords: [string, string][]; internalHint: string; productNamePatterns: [string, string][]; noiseWords: string[] }
export const DEFAULT_IMPORT_RULES: ImportRules = {
  countryKeywords: [
    ['spain|madrid|barcelona|valencia', 'ES'], ['austria|vienna|wien|graz|linz', 'AT'], ['switzerland|swiss|z(ü|u)rich|geneva|basel|bern', 'CH'], ['sweden|stockholm|gothenburg|malm(ö|o)', 'SE'],
    ['canada|toronto|montreal|quebec|vancouver|ontario', 'CA'], ['united states|\\busa\\b|california|texas|virginia|florida|tennessee|new york|san jose', 'US'],
    ['united kingdom|\\buk\\b|london|england|scotland', 'GB'], ['finland|helsinki', 'FI'], ['italy|milan|rome|turin|bologna', 'IT'],
    ['germany|berlin|hamburg|m(ü|u)nchen|munich|frankfurt|k(ö|o)ln|cologne|stuttgart|d(ü|u)sseldorf', 'DE'], ['netherlands|amsterdam|rotterdam', 'NL'],
    ['france|paris|lyon', 'FR'], ['australia|sydney|melbourne', 'AU'], ['greece|athens', 'GR'],
  ],
  internalHint: '\\br ?& ?d\\b|\\brnd\\b|dummy|spare|parking|\\btbd\\b|for sw|emulator|certification|internal|evaluation unit',
  productNamePatterns: [],
  noiseWords: [],
};
const BASE_NOISE = ['x', 'm', 'system', 'systems', 'eap', 'first', 'second', 'third', 'fourth', 'batch', 'fan', 'fuse', 'up', 'extra', 'cp', 'the', 'for', 'and', 'of', 'to',
  'in', 'with', 'currently', 'be', 'updated', 'project', 'order', 'sw', 'ip', 'lot'];
let NOISE = new Set(BASE_NOISE);
let INTERNAL_HINT = new RegExp(DEFAULT_IMPORT_RULES.internalHint, 'i');
let COUNTRY_KEYWORDS: [RegExp, string][] = DEFAULT_IMPORT_RULES.countryKeywords.map(([r, c]) => [new RegExp(r, 'i'), c]);
let PRODUCT_PATTERNS: [RegExp, string][] = [];

/** Load the configured rules (merged with the generic defaults) before a preview or an apply. */
export async function loadImportRules(db: Db) {
  const r = (await db.query(`SELECT value FROM settings WHERE key = 'import_rules'`)).rows[0]?.value ?? {};
  const words = [...BASE_NOISE, ...(r.noiseWords ?? []), ...((await db.query('SELECT name FROM product_types')).rows
    .flatMap((x: any) => String(x.name).toLowerCase().split(/[^a-z0-9]+/)).filter((w: string) => w.length >= 3 && !['power', 'cabinet', 'dispenser', 'charge'].includes(w)))];
  NOISE = new Set(words);
  INTERNAL_HINT = new RegExp([r.internalHint, DEFAULT_IMPORT_RULES.internalHint].filter(Boolean).join('|'), 'i');
  COUNTRY_KEYWORDS = [...(r.countryKeywords ?? []), ...DEFAULT_IMPORT_RULES.countryKeywords].map(([re, c]: [string, string]) => [new RegExp(re, 'i'), c] as [RegExp, string]);
  PRODUCT_PATTERNS = (r.productNamePatterns ?? []).map(([re, code]: [string, string]) => [new RegExp(re, 'i'), code] as [RegExp, string]);
}

const WEAK = new Set(['site', 'test', 'testing', 'pilot', 'truck', 'track', 'lab', 'additional', 'buffer', 'na', 'jv', 'related']);
const tokens = (s: string) => norm(s).split(' ').filter((t) => t.length >= 2 && !NOISE.has(t) && !/^\d+$/.test(t));

/** Grouping key for a unit's "mapping" text: unit-specific details (system numbers, outlet numbers, notes in brackets) are removed. */
export function groupKey(mapping: string) {
  const t = norm(mapping.replace(/\(.*?\)/g, ' ').replace(/-->.*$/, ' ').replace(/#\s*\d+/g, ' '));
  const k = t.split(' ').filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w) && !/^system\d+$/.test(w) && !/^[a-z]\d{1,2}$/.test(w)).join(' ');
  return k || norm(mapping.replace(/\(.*?\)/g, ' ')) || norm(mapping) || '(empty)';
}

interface Candidate { key: string; label: string; score: number }
export interface MatchResult { status: 'AUTO' | 'PROPOSED' | 'AMBIGUOUS' | 'UNMATCHED'; suggestion: { kind: 'PROJECT'; projectKey: string } | { kind: 'INTERNAL' } | null; candidates: Candidate[]; reason: string }

export function matchName(textRaw: string, projects: { key: string; label: string }[], aliasHit?: string | null): MatchResult {
  if (aliasHit) return { status: 'AUTO', suggestion: aliasHit === 'INTERNAL' ? { kind: 'INTERNAL' } : { kind: 'PROJECT', projectKey: aliasHit }, candidates: [], reason: 'Remembered decision (alias)' };
  const sq = squash(textRaw);
  const tt = new Set(norm(textRaw).split(' '));
  const scored = projects.map((p) => {
    const strong = squash(p.label).length >= 4 && sq.includes(squash(p.label));
    const pt = tokens(p.label).filter((t) => t.length >= 3 || /^[a-z]{2}$/.test(t));
    let score = 0;
    for (const t of pt) if (tt.has(t) || (t.length >= 5 && sq.includes(t))) score += WEAK.has(t) ? 0.5 : 1;
    return { key: p.key, label: p.label, score: strong ? score + 10 : score };
  }).filter((c) => c.score >= 1).sort((a, b) => b.score - a.score);
  const internal = INTERNAL_HINT.test(textRaw);
  if (!scored.length) {
    return internal
      ? { status: 'PROPOSED', suggestion: { kind: 'INTERNAL' }, candidates: [], reason: 'Looks like an internal / R&D unit (no customer project) — please confirm' }
      : { status: 'UNMATCHED', suggestion: null, candidates: [], reason: 'No project name matches — choose the project or mark as internal' };
  }
  const [top, second] = scored;
  const unique = !second || top.score > second.score;
  if (unique && top.score >= 10) return { status: 'AUTO', suggestion: { kind: 'PROJECT', projectKey: top.key }, candidates: scored.slice(0, 5), reason: `Name contains "${top.label}"` };
  if (unique && !internal && (top.score >= 2 || !second)) return { status: 'AUTO', suggestion: { kind: 'PROJECT', projectKey: top.key }, candidates: scored.slice(0, 5), reason: `Only "${top.label}" matches` };
  if (unique) return { status: 'PROPOSED', suggestion: { kind: 'PROJECT', projectKey: top.key }, candidates: scored.slice(0, 5), reason: `Best match "${top.label}" — please confirm` };
  return { status: 'AMBIGUOUS', suggestion: null, candidates: scored.slice(0, 6), reason: `Several projects match (${scored.filter((c) => c.score === top.score).map((c) => c.label).join(', ')})` };
}

// ---------------------------------------------------------------- products, countries, demand

interface ProductRow { id: number; code: string; name?: string; family: string; item_codes: string[] }
const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

/** Product from item-code patterns (master data), configured name patterns, then generic names. */
export function resolveProduct(products: ProductRow[], codes: string[], nameText: string, kind: 'ANY' | 'OUTLET' = 'ANY'): { code: string; source: 'ITEM_CODE' | 'NAME' } | null {
  for (const c of codes) for (const p of products) if ((p.item_codes ?? []).some((g) => globRe(g).test(c))) return { code: p.code, source: 'ITEM_CODE' };
  const t = nameText.toLowerCase();
  const ok = (code: string) => { const p = products.find((x) => x.code === code); return p && (kind === 'ANY' || p.family !== 'POWER_CABINET') ? { code, source: 'NAME' as const } : null; };
  if (/bess|site controller|battery|steel|\balu\b/.test(t)) return null;
  for (const [re, code] of PRODUCT_PATTERNS) if (re.test(t)) { const r = ok(code); if (r) return r; }
  const generic: [RegExp, string][] = [
    [/\bdock\b|charge ?dock/, 'CDOCK'], [/ultra|\bmcs\b/, 'ULTRA'], [/\bduo\b/, 'DUO'], [/\bsolo\b|pollux/, 'POLLUX'], [/\bvega\b/, 'VEGA'],
    [/x1200/, 'X1200'], [/x-?\s?system|\bx800\b|om ?800/, 'X800'], [/\bm200\b/, 'M200'], [/\bm-?\s?(400|800|1200)\b/, 'M400'],
  ];
  for (const [re, code] of generic) if (re.test(t)) { const r = ok(code); if (r) return r; }
  return null;
}

export function inferCountry(texts: string[], series: string | null, lineNames: string[]): { country: string | null; source: 'KEYWORD' | 'ASSUMED' | null; evidence: string | null } {
  const all = texts.filter(Boolean).join(' | ');
  for (const [re, cc] of COUNTRY_KEYWORDS) { const m = all.match(re); if (m) return { country: cc, source: 'KEYWORD', evidence: m[0] }; }
  if (lineNames.some((n) => /\bNA\b|\bUL\b/.test(n ?? ''))) return { country: 'US', source: 'ASSUMED', evidence: 'North-American (NA/UL) product variant' };
  return { country: null, source: null, evidence: null };
}

export function proposeDemand(p: TrackerProject): { status: 'TENTATIVE' | 'APPROVED' | 'COMMITTED'; reason: string } {
  const sit = (p.customerSituation ?? '').toLowerCase();
  const uncertain = /pending|tbc|unclear|to be confirmed|open planning|requires|uncertain|not firm|delay/.test(sit);
  const firm = /stable|firm|ordered/.test(sit);
  const so = !!p.sapOrderRef && !/n\/a|tbd/i.test(p.sapOrderRef);
  if (p.requiredCommissioning.exact && so && firm && !uncertain) return { status: 'COMMITTED', reason: 'Sales order, firm customer situation and an exact required date' };
  if (so || firm) return { status: 'APPROVED', reason: p.requiredCommissioning.exact ? 'Order exists but customer situation is not firm' : 'Required date is indicative — cannot be committed yet' };
  return { status: 'TENTATIVE', reason: 'No sales order and no firm customer situation' };
}

const slug = (s: string) => norm(s).replace(/ /g, '-').toUpperCase();

// ---------------------------------------------------------------- report

export interface ImportDecisions {
  groups?: Record<string, { kind: 'PROJECT'; projectKey: string } | { kind: 'INTERNAL' } | { kind: 'SKIP' }>;
  visits?: Record<string, { kind: 'PROJECT'; projectKey: string } | { kind: 'SKIP' }>;
  projects?: Record<string, { include?: boolean; country?: string; demandStatus?: 'TENTATIVE' | 'APPROVED' | 'COMMITTED'; acceptUpdates?: boolean; matchProjectId?: number | 'NEW' }>;
  /** Per-row overrides of the group decision (e.g. split one customer's units across two orders). */
  units?: Record<string, { kind: 'PROJECT'; projectKey: string } | { kind: 'INTERNAL' } | { kind: 'SKIP' }>;
  replaceDemo?: boolean;
  /** Explicit choice: planned tracker dates that are already in the past count as actuals (flagged as assumed). */
  trustPastDates?: boolean;
}

/** Stable part of a customer / project name: account numbers, bracketed notes and trailing dashes are ignored. */
export const baseName = (s: string) => norm(s.replace(/\(.*?\)/g, ' ').replace(/\b\d{5,}\b\)?/g, ' ').replace(/[-–]\s*$/, ' '));

function projectKeys(parsed: ParsedTracker) {
  const seen = new Map<string, number>();
  return parsed.projects.map((p) => {
    const base = baseName(p.customer) || norm(p.customer);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} #${n}`;
  });
}

const projectLabel = (p: TrackerProject, key: string) => (key.includes(' #') ? `${p.customer} (${p.scope ?? 'row ' + p.row})` : p.customer);

/** Build the preview report: what would be created, matched, updated or skipped, and what needs a decision. */
export async function buildReport(db: Db, parsed: ParsedTracker, decisions: ImportDecisions = {}) {
  await loadImportRules(db);
  const products = (await db.query('SELECT id, code, name, family, item_codes FROM product_types')).rows as ProductRow[];
  const family = new Map(products.map((p) => [p.code, p.family]));
  const keys = projectKeys(parsed);
  const existing = (await db.query(`SELECT id, code, name, source_ref, demand_status, required_commissioning_date, required_commissioning_text, required_exw_text, customer_situation,
      mitigations, rationale, sap_order_ref, o2c_owner, spoc, wave, series, priority, status FROM projects WHERE source_ref LIKE 'OMT:%'`)).rows;
  const byRef = new Map(existing.map((e) => [e.source_ref, e]));
  // Match tracker projects to projects imported earlier: same key, else same stable name (account numbers or notes
  // added in the tracker), else a person confirms one of the similar names (a renamed project is never guessed).
  const matchOf = new Map<string, { status: 'MATCHED' | 'CANDIDATE' | 'NEW'; ex?: any; via?: string; candidates?: { projectId: number; code: string; label: string; score: number }[] }>();
  const used = new Set<number>();
  keys.forEach((k) => { const ex = byRef.get(`OMT:${k}`); if (ex) { matchOf.set(k, { status: 'MATCHED', ex, via: 'key' }); used.add(ex.id); } });
  parsed.projects.forEach((p, i) => {
    const k = keys[i];
    if (matchOf.has(k)) return;
    const dec = decisions.projects?.[k]?.matchProjectId;
    if (dec === 'NEW') { matchOf.set(k, { status: 'NEW' }); return; }
    if (typeof dec === 'number') { const ex = existing.find((e) => e.id === dec && !used.has(e.id)); if (ex) { matchOf.set(k, { status: 'MATCHED', ex, via: 'decision' }); used.add(ex.id); return; } }
    const free = existing.filter((e) => !used.has(e.id) && e.status === 'ACTIVE');
    const same = free.filter((e) => baseName(e.name) === k.split(' #')[0] || baseName(e.source_ref.slice(4)) === k.split(' #')[0]);
    if (same.length === 1 && !k.includes(' #')) { matchOf.set(k, { status: 'MATCHED', ex: same[0], via: 'name' }); used.add(same[0].id); return; }
    const m = matchName(p.customer, free.map((e) => ({ key: String(e.id), label: e.name })));
    const cands = m.candidates.filter((c) => c.score >= 1).map((c) => ({ projectId: Number(c.key), code: free.find((e) => e.id === Number(c.key))!.code, label: c.label, score: c.score }));
    matchOf.set(k, cands.length ? { status: 'CANDIDATE', candidates: cands } : { status: 'NEW' });
  });
  const idToKey = new Map([...matchOf.entries()].filter(([, v]) => v.ex).map(([k, v]) => [v.ex.id, k]));
  const aliases = (await db.query(`SELECT alias, target_id FROM name_aliases WHERE kind = 'PROJECT'`)).rows;
  const aliasOf = (text: string) => {
    const a = aliases.find((x) => x.alias === groupKey(text) || x.alias === norm(text));
    if (!a) return null;
    if (a.target_id === 0) return 'INTERNAL';
    return idToKey.get(a.target_id) ?? null;
  };
  const plist = parsed.projects.map((p, i) => ({ key: keys[i], label: projectLabel(p, keys[i]) }));

  // Unit groups
  const groups = new Map<string, { key: string; texts: Set<string>; rows: number[]; units: number }>();
  const unitInfo: { row: number; name: string; product: string | null; productSource: string | null; group: string; issues: string[] }[] = [];
  const serials = new Map<string, number>(); const names = new Map<string, number>();
  for (const u of parsed.units) { if (u.serial) serials.set(u.serial, (serials.get(u.serial) ?? 0) + 1); names.set(norm(u.name), (names.get(norm(u.name)) ?? 0) + 1); }
  for (const u of parsed.units) {
    const pr = resolveProduct(products, u.itemCode ? [u.itemCode] : [], u.name);
    const g = groupKey(u.mapping || u.name);
    const gr = groups.get(g) ?? { key: g, texts: new Set<string>(), rows: [], units: 0 };
    gr.texts.add(u.mapping || '(no mapping text)'); gr.rows.push(u.row); gr.units++;
    groups.set(g, gr);
    const issues: string[] = [];
    if (!pr) issues.push('Product not recognised from item code or name — row will be skipped');
    if (u.serial && (serials.get(u.serial) ?? 0) > 1) issues.push(`Serial ${u.serial} appears ${serials.get(u.serial)} times — serial left blank for review`);
    if ((names.get(norm(u.name)) ?? 0) > 1) issues.push(`Name "${u.name}" appears ${names.get(norm(u.name))} times in the sheet`);
    unitInfo.push({ row: u.row, name: u.name, product: pr?.code ?? null, productSource: pr?.source ?? null, group: g, issues });
  }
  const groupList = [...groups.values()].map((g) => {
    const sample = [...g.texts][0];
    const m = matchName([...g.texts].join(' | '), plist, aliasOf(sample));
    return { key: g.key, texts: [...g.texts].slice(0, 6), rows: g.rows, units: g.units, ...m };
  }).sort((a, b) => a.rows[0] - b.rows[0]);

  // Site plans
  const visitGroups = parsed.visits.map((v) => {
    const key = `${norm(v.project)}${v.batch ? ' / ' + norm(v.batch) : ''}`;
    const m = matchName(v.project, plist, aliasOf(v.project));
    return { key, project: v.project, batch: v.batch, row: v.row, ...m, suggestion: m.suggestion?.kind === 'INTERNAL' ? null : m.suggestion, status: m.suggestion?.kind === 'INTERNAL' ? 'UNMATCHED' as const : m.status };
  });

  // Projects
  const projects = parsed.projects.map((p, i) => {
    const key = keys[i];
    const mt = matchOf.get(key)!;
    const ex = mt.ex;
    const groupTexts = groupList.filter((g) => g.suggestion?.kind === 'PROJECT' && g.suggestion.projectKey === key).flatMap((g) => g.texts);
    const visitTexts = visitGroups.filter((v) => v.suggestion?.kind === 'PROJECT' && v.suggestion.projectKey === key).map((v) => v.project);
    const country = inferCountry([p.customer, p.scope ?? '', p.customerSituation ?? '', p.requiredExw.text ?? '', ...groupTexts, ...visitTexts], p.series, p.lines.map((l) => l.name ?? ''));
    const demand = proposeDemand(p);
    const lines = p.lines.map((l, li) => ({ l, li })).filter(({ l }) => l.quantity > 0).map(({ l, li }) => {
      const pr = resolveProduct(products, l.codes, `${l.name ?? ''} ${l.codes.length ? '' : p.scope ?? ''}`, li > 0 ? 'OUTLET' : 'ANY');
      return { name: l.name, codes: l.codes, quantity: l.quantity, product: pr?.code ?? null, family: pr ? family.get(pr.code) : null, source: pr?.source ?? null };
    });
    const warnings: string[] = [];
    if (ex && ex.status !== 'ACTIVE') warnings.push(`Cancelled in the application — tracker rows for this project are not applied (reactivate it first if it is back)`);
    if (!p.requiredCommissioning.exact) warnings.push(p.requiredCommissioning.text ? `Required commissioning "${p.requiredCommissioning.text.replace(/\n/g, ' / ')}" is not an exact date — planned indicatively${p.requiredCommissioning.iso ? ` (≈ ${p.requiredCommissioning.iso})` : ''}` : 'No required commissioning date — indicative plan only');
    for (const l of lines) if (!l.product) warnings.push(`Line "${l.name ?? l.codes.join(' ')}" (${l.quantity}) — product not recognised; not imported`);
    if (country.source === 'ASSUMED') warnings.push(`Destination country assumed ${country.country} (${country.evidence}) — confirm`);
    if (!country.country) warnings.push('Destination country unknown — choose it before applying');
    const diffs: { field: string; app: unknown; tracker: unknown }[] = [];
    if (ex) {
      const cmp = (field: string, app: unknown, tr: unknown) => { if ((app ?? null) !== (tr ?? null)) diffs.push({ field, app, tracker: tr }); };
      cmp('required_commissioning_text', ex.required_commissioning_text, p.requiredCommissioning.text);
      cmp('required_exw_text', ex.required_exw_text, p.requiredExw.text);
      cmp('customer_situation', ex.customer_situation, p.customerSituation);
      cmp('mitigations', ex.mitigations, p.mitigations);
      cmp('sap_order_ref', ex.sap_order_ref, p.sapOrderRef);
      cmp('o2c_owner', ex.o2c_owner, p.o2cOwner);
      const reqIso = ex.required_commissioning_date ? new Date(ex.required_commissioning_date).toISOString().slice(0, 10) : null;
      if (p.requiredCommissioning.exact && reqIso !== p.requiredCommissioning.iso) diffs.push({ field: 'required_commissioning_date', app: reqIso, tracker: p.requiredCommissioning.iso });
      if (ex.demand_status !== demand.status) diffs.push({ field: 'demand_status', app: ex.demand_status, tracker: demand.status });
    }
    return {
      key, row: p.row, customer: p.customer, label: projectLabel(p, key), priority: p.priority, wave: p.wave, series: p.series, scope: p.scope,
      match: ex ? { status: 'MATCHED' as const, projectId: ex.id, code: ex.code, name: ex.name, via: mt.via }
        : mt.status === 'CANDIDATE' ? { status: 'CANDIDATE' as const, candidates: mt.candidates } : { status: 'NEW' as const },
      proposed: {
        code: ex?.code ?? `OM-${slug(p.customer).slice(0, 22)}${key.includes(' #') ? '-' + key.split(' #')[1] : ''}`,
        country: country.country, countrySource: country.source, countryEvidence: country.evidence,
        demandStatus: demand.status, demandReason: demand.reason, requiredDate: p.requiredCommissioning.exact ? p.requiredCommissioning.iso : null,
        indicativeDate: p.requiredCommissioning.iso, requiredText: p.requiredCommissioning.text, requiredExwText: p.requiredExw.text,
        freightHint: /air/i.test(p.requiredExw.text ?? '') ? 'AIR' : /sea/i.test(p.requiredExw.text ?? '') ? 'SEA' : null,
      },
      lines, diffs, warnings,
      trackedUnits: groupList.filter((g) => g.suggestion?.kind === 'PROJECT' && g.suggestion.projectKey === key).reduce((s, g) => s + g.units, 0),
    };
  });

  const prevApplied = (await db.query(`SELECT max(as_of) AS as_of FROM import_batches WHERE kind = 'OM_TRACKER' AND status = 'APPLIED'`)).rows[0]?.as_of ?? null;
  const demo = Number((await db.query(`SELECT count(*) n FROM projects WHERE source = 'DEMO' AND status = 'ACTIVE'`)).rows[0].n);
  const openTopics = parsed.topics.filter((t) => t.open);
  return {
    asOf: parsed.asOf, previousAppliedAsOf: prevApplied ? new Date(prevApplied).toISOString() : null,
    olderThanApplied: prevApplied ? new Date(parsed.asOf) < new Date(prevApplied) : false,
    demoProjects: demo, warnings: parsed.warnings,
    summary: {
      projects: projects.length, newProjects: projects.filter((p) => p.match.status === 'NEW').length, matchedProjects: projects.filter((p) => p.match.status === 'MATCHED').length, projectsToConfirm: projects.filter((p) => p.match.status === 'CANDIDATE').length,
      units: parsed.units.length, unitsWithIssues: unitInfo.filter((u) => u.issues.length).length, skippedRows: parsed.skippedRows.length,
      groups: groupList.length, groupsNeedingDecision: groupList.filter((g) => g.status !== 'AUTO').length,
      sitePlans: visitGroups.length, releases: parsed.releases.length, testCoverage: parsed.coverage.length, openTopics: openTopics.length,
    },
    projects, groups: groupList, visitGroups, units: unitInfo, skippedRows: parsed.skippedRows,
    releases: parsed.releases.map((r) => ({ version: r.version, knownIssues: r.knownIssues.length })),
    openTopics: openTopics.map((t) => ({ row: t.row, topic: t.topic, status: t.status, responsible: t.responsible, followUp: t.followUp })),
  };
}
export type ImportReport = Awaited<ReturnType<typeof buildReport>>;

/** Decisions still required before the batch can be applied. */
export function blockingIssues(report: ImportReport, d: ImportDecisions) {
  const out: { kind: string; key: string; message: string }[] = [];
  const included = new Set(report.projects.filter((p) => d.projects?.[p.key]?.include !== false).map((p) => p.key));
  for (const g of report.groups) {
    const dec = d.groups?.[g.key];
    if (dec) { if (dec.kind === 'PROJECT' && !report.projects.some((p) => p.key === dec.projectKey)) out.push({ kind: 'GROUP', key: g.key, message: `Unknown project for "${g.texts[0]}"` }); continue; }
    if (g.status === 'AUTO') continue;
    out.push({ kind: 'GROUP', key: g.key, message: `${g.units} unit(s) "${g.texts[0]}": ${g.reason}` });
  }
  for (const v of report.visitGroups) {
    if (d.visits?.[v.key] || v.status === 'AUTO') continue;
    out.push({ kind: 'VISIT', key: v.key, message: `Site plan "${v.project}${v.batch ? ' ' + v.batch : ''}": ${v.reason}` });
  }
  const claimed = new Map<number, string>();
  for (const p of report.projects) {
    const id = p.match.status === 'MATCHED' ? p.match.projectId : typeof d.projects?.[p.key]?.matchProjectId === 'number' ? d.projects[p.key].matchProjectId as number : null;
    if (id === null || id === undefined || !included.has(p.key)) continue;
    if (claimed.has(id)) out.push({ kind: 'PROJECT_MATCH', key: p.key, message: `${p.label} and ${claimed.get(id)} are both matched to the same existing project` });
    else claimed.set(id, p.label);
  }
  for (const p of report.projects) {
    if (included.has(p.key) && p.match.status === 'CANDIDATE' && d.projects?.[p.key]?.matchProjectId === undefined) {
      out.push({ kind: 'PROJECT_MATCH', key: p.key, message: `${p.label}: is this the existing project ${(p.match.candidates ?? []).map((c: any) => `${c.code} "${c.label}"`).join(' or ')}, or a new one?` });
      continue;
    }
    if (!included.has(p.key) || p.match.status === 'MATCHED' || typeof d.projects?.[p.key]?.matchProjectId === 'number') continue;
    const country = d.projects?.[p.key]?.country ?? p.proposed.country;
    if (!country) out.push({ kind: 'COUNTRY', key: p.key, message: `${p.label}: destination country unknown` });
    const ds = d.projects?.[p.key]?.demandStatus ?? p.proposed.demandStatus;
    if (ds === 'COMMITTED' && !p.proposed.requiredDate) out.push({ kind: 'DEMAND', key: p.key, message: `${p.label}: committed demand needs an exact required commissioning date` });
  }
  return out;
}

// ---------------------------------------------------------------- batches

export async function previewUpload(c: pg.PoolClient, user: AuthUser, buffer: Buffer, filename: string | null, opts: { asOf?: string } = {}) {
  await requirePermission(c, user, 'import.apply', 'Importing the ramp-up tracker requires the import.apply authority');
  if (!buffer?.length) throw new HttpError(400, 'Empty upload');
  let parsed: ParsedTracker;
  try { parsed = await parseTrackerWorkbook(buffer, opts); } catch (e) { throw new HttpError(422, `Not a readable Excel workbook: ${(e as Error).message}`); }
  if (!parsed.projects.length && !parsed.units.length) throw new HttpError(422, 'No projects or units found — is this the OM Ramp-Up Tracker?');
  const report = await buildReport(c, parsed);
  const b = (await c.query(`INSERT INTO import_batches (kind, filename, status, as_of, parsed, report, created_by) VALUES ('OM_TRACKER',$1,'PREVIEW',$2,$3,$4,$5) RETURNING id`,
    [filename, parsed.asOf, JSON.stringify(parsed), JSON.stringify(report), user.id])).rows[0];
  await audit(c, { userId: user.id, action: 'import.preview', changeClass: 'IMPORT', entityType: 'import_batch', entityId: b.id, after: { filename, asOf: parsed.asOf, summary: report.summary } });
  return { id: b.id, report, mapping: {}, blocking: blockingIssues(report, {}) };
}

export async function getBatch(db: Db, id: number) {
  const b = (await db.query('SELECT id, kind, filename, status, as_of, report, mapping, created_at, applied_at, created_by, applied_by FROM import_batches WHERE id = $1', [id])).rows[0];
  if (!b) throw new HttpError(404, 'Import batch not found');
  return { ...b, blocking: b.status === 'PREVIEW' ? blockingIssues(b.report, b.mapping ?? {}) : [] };
}

export async function listBatches(db: Db) {
  return (await db.query(`SELECT b.id, b.kind, b.filename, b.status, b.as_of, b.created_at, b.applied_at, u.name created_by_name, b.report->'summary' summary,
      b.report->'applied' applied FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 50`)).rows;
}

export async function updateDecisions(c: pg.PoolClient, user: AuthUser, id: number, mapping: ImportDecisions) {
  await requirePermission(c, user, 'import.apply');
  const b = (await c.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!b) throw new HttpError(404, 'Import batch not found');
  if (b.status !== 'PREVIEW') throw new HttpError(409, `Batch is ${b.status.toLowerCase()}`);
  const merged: ImportDecisions = {
    ...b.mapping, ...mapping,
    groups: { ...(b.mapping?.groups ?? {}), ...(mapping.groups ?? {}) },
    visits: { ...(b.mapping?.visits ?? {}), ...(mapping.visits ?? {}) },
    projects: { ...(b.mapping?.projects ?? {}) },
  };
  for (const [k, v] of Object.entries(mapping.projects ?? {})) merged.projects![k] = { ...(merged.projects![k] ?? {}), ...v };
  await c.query('UPDATE import_batches SET mapping = $2 WHERE id = $1', [id, JSON.stringify(merged)]);
  return getBatch(c, id);
}

export async function discardBatch(c: pg.PoolClient, user: AuthUser, id: number) {
  await requirePermission(c, user, 'import.apply');
  await c.query(`UPDATE import_batches SET status = 'DISCARDED' WHERE id = $1 AND status = 'PREVIEW'`, [id]);
  return getBatch(c, id);
}

// ---------------------------------------------------------------- apply

const dayNo = (iso: string) => Math.floor(Date.parse(iso.slice(0, 10)) / 86400000);
const startSlot = (iso: string) => dayNo(iso) * 2;
const endSlot = (iso: string) => (dayNo(iso) + 1) * 2;

interface PlannedSystem { code: string; cabinet: TrackerUnit | null; units: TrackerUnit[]; placeholders: Map<string, number>; batch: number | null; exw: string | null; label: string | null }

function systemLabel(u: TrackerUnit) {
  const m = `${u.name} ${u.mapping}`.match(/\b(?:[xm][-\s]*)?system\s*(\d+)\b/i);
  return m ? m[1] : null;
}
const BATCH_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
function batchOf(u: TrackerUnit) {
  const m = u.mapping.match(/\b(first|second|third|fourth|fifth)\s+batch\b/i) ?? u.mapping.match(/\bbatch\s*(\d+)\b/i);
  if (!m) return null;
  return BATCH_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
}

/** Systems from tracked units in sheet order: a cabinet opens a system, outlets join the system they name, else the latest cabinet. */
function planSystems(units: { u: TrackerUnit; product: string; family: string }[], lines: { product: string; family: string; quantity: number }[]) {
  const systems: PlannedSystem[] = [];
  const labelToSys = new Map<string, PlannedSystem>();
  const orphans: TrackerUnit[] = [];
  for (const { u, family } of units) {
    if (family === 'POWER_CABINET') {
      const s: PlannedSystem = { code: `SYS-${systems.length + 1}`, cabinet: u, units: [u], placeholders: new Map(), batch: batchOf(u), exw: u.confirmedExw.exact ? u.confirmedExw.iso : null, label: systemLabel(u) };
      systems.push(s);
      if (s.label) labelToSys.set(s.label, s);
      if (orphans.length) { s.units.push(...orphans); orphans.length = 0; }
      continue;
    }
    const lbl = systemLabel(u);
    let target = lbl ? labelToSys.get(lbl) : undefined;
    if (!target && lbl) {
      // An outlet names a system the cabinets do not: give the label to the first cabinet that has no label and no outlets yet.
      target = systems.find((s) => ![...labelToSys.values()].includes(s) && s.units.length === 1);
      if (target) labelToSys.set(lbl, target);
    }
    target = target ?? systems[systems.length - 1];
    if (target) target.units.push(u); else orphans.push(u);
  }
  const trackedOf = (product: string) => units.filter((x) => x.product === product).length;
  // Remaining ordered quantities become planned (not yet tracked) units.
  for (const l of lines.filter((x) => x.family === 'POWER_CABINET')) {
    for (let rest = Math.max(0, l.quantity - trackedOf(l.product)); rest > 0; rest--) {
      systems.push({ code: `SYS-${systems.length + 1}`, cabinet: null, units: [], placeholders: new Map([[l.product, 1]]), batch: null, exw: null, label: null });
    }
  }
  const outlets = (s: PlannedSystem) => s.units.length - (s.cabinet ? 1 : 0) + [...s.placeholders.entries()].filter(([p]) => !lines.some((l) => l.product === p && l.family === 'POWER_CABINET')).reduce((t, [, q]) => t + q, 0);
  const looseExtra: { product: string; quantity: number }[] = [];
  for (const l of lines.filter((x) => x.family !== 'POWER_CABINET')) {
    let rest = Math.max(0, l.quantity - trackedOf(l.product));
    if (!systems.length) { if (rest) looseExtra.push({ product: l.product, quantity: rest }); continue; }
    for (; rest > 0; rest--) {
      const s = systems.reduce((a, b) => (outlets(b) < outlets(a) ? b : a));
      s.placeholders.set(l.product, (s.placeholders.get(l.product) ?? 0) + 1);
    }
  }
  return { systems, orphans, looseExtra };
}

function deliveriesOf(systems: PlannedSystem[]) {
  const groups = new Map<string, number[]>();
  systems.forEach((s, i) => {
    const b = s.batch ?? s.units.map(batchOf).find((x) => x !== null) ?? null;
    const k = b !== null ? `B${String(b).padStart(2, '0')}` : s.exw ? `D${s.exw}` : 'Z';
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, idx]) => ({ key: k, systems: idx }));
}

async function setActual(c: pg.PoolClient, user: AuthUser, actId: number, a: { status: 'COMPLETED' | 'IN_PROGRESS'; start: number; finish: number | null }, stats: { completed: number; started: number; conflicts: string[] }) {
  const cur = (await c.query('SELECT id, name, status, actual_start, actual_finish, source, updated_by FROM activities WHERE id = $1', [actId])).rows[0];
  if (!cur || cur.status === 'CANCELLED' || cur.status === 'COMPLETED') return;
  if (cur.status === 'IN_PROGRESS' && a.status === 'IN_PROGRESS') return;
  if (cur.actual_start !== null && cur.updated_by !== null && cur.actual_start !== a.start) {
    stats.conflicts.push(`${cur.name}: start recorded in the application kept (tracker says ${new Date(a.start * 43200000).toISOString().slice(0, 10)})`);
  }
  const start = cur.actual_start ?? a.start;
  const finish = a.status === 'COMPLETED' ? Math.max(a.finish ?? start + 1, start) : null;
  await c.query(`UPDATE activities SET status = $2, actual_start = $3, actual_finish = $4, pct_complete = $5, progress_slot = $6, flags = array_append(flags, 'IMPORTED_ACTUAL'), updated_by = $7, updated_at = now() WHERE id = $1`,
    [actId, a.status, start, finish, a.status === 'COMPLETED' ? 100 : 50, finish ?? start, user.id]);
  if (a.status === 'COMPLETED') stats.completed++; else stats.started++;
}

const SUB_CODES = new Set(['PCBA_MFG', 'PCBA_PROG', 'PCBA_TEST', 'SUB_MFG', 'SUB_TEST', 'SUB_PROG']);

/** Apply tracker progress for one physical unit (forward-only). */
async function applyUnitProgress(c: pg.PoolClient, user: AuthUser, unitId: number, u: TrackerUnit, asOfDay: string, stats: any) {
  const acts = (await c.query(`SELECT id, code, stage, status FROM activities WHERE unit_id = $1 AND scope = 'UNIT' AND status <> 'CANCELLED' ORDER BY seq`, [unitId])).rows;
  const past = (iso: string | null | undefined) => !!iso && iso < asOfDay;
  const reached = (iso: string | null | undefined) => !!iso && iso <= asOfDay;
  const eolDone = u.rowState === 'COMPLETED' || (u.eol && past(u.eol.to));
  const eolStarted = !eolDone && u.eol && reached(u.eol.from);
  const faDone = eolDone || eolStarted || (u.production && past(u.production.to));
  const faStarted = !faDone && u.production && reached(u.production.from);
  const fallback = u.eol?.to ?? u.production?.to ?? (u.confirmedExw.exact ? u.confirmedExw.iso : null) ?? u.productionEnd.iso ?? asOfDay;
  const faStart = u.production?.from ?? u.eol?.from ?? fallback;
  for (const a of acts) {
    if (SUB_CODES.has(a.code) && (faDone || faStarted)) await setActual(c, user, a.id, { status: 'COMPLETED', start: startSlot(faStart), finish: startSlot(faStart) + 1 }, stats);
    else if (a.code === 'FA' && faDone) await setActual(c, user, a.id, { status: 'COMPLETED', start: startSlot(u.production?.from ?? faStart), finish: endSlot(u.production?.to ?? faStart) }, stats);
    else if (a.code === 'FA' && faStarted) await setActual(c, user, a.id, { status: 'IN_PROGRESS', start: startSlot(u.production!.from), finish: null }, stats);
    else if (a.code === 'EOL' && eolDone) await setActual(c, user, a.id, { status: 'COMPLETED', start: startSlot(u.eol?.from ?? fallback), finish: endSlot(u.eol?.to ?? fallback) }, stats);
    else if (a.code === 'EOL' && eolStarted) await setActual(c, user, a.id, { status: 'IN_PROGRESS', start: startSlot(u.eol!.from), finish: null }, stats);
  }
  // Execution status is not a test result: record what the tracker says, never as released.
  if (eolDone && u.eolStatus) {
    const eolAct = acts.find((a) => a.code === 'EOL');
    const has = eolAct ? (await c.query('SELECT 1 FROM test_records WHERE activity_id = $1', [eolAct.id])).rows.length : 1;
    if (!has) {
      const plain = /^comp(le|el)ted$/i.test(u.eolStatus.trim());
      const outcome = plain ? 'PASS' : /fail|issue|not ok/i.test(u.eolStatus) ? 'FAIL' : 'INCONCLUSIVE';
      const tp = (await c.query(`SELECT id FROM test_plans WHERE code = 'EOL-STD' ORDER BY version DESC LIMIT 1`)).rows[0]?.id ?? null;
      await c.query(`INSERT INTO test_records (unit_id, activity_id, test_plan_id, outcome, evidence_ref, executed_at, recorded_by, status, review_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'VALID',NULL)`, [unitId, eolAct.id, tp, outcome, `Ramp-up tracker: "${u.eolStatus}"`, new Date(Date.parse(u.eol?.to ?? fallback)), user.id]);
      stats.testRecords++;
    }
  }
  // Readiness from the tracker's sub-assembly and component columns, only where final assembly is still ahead.
  const fa = acts.find((a) => a.code === 'FA');
  if (fa && !faDone && !faStarted) {
    const want: { title: string; status: string; notes: string | null }[] = u.subassemblies.map((s) => ({ title: `Sub-assembly ready: ${s.name}`, status: s.state, notes: 'Ramp-up tracker sub-assembly readiness' }));
    if (u.componentAvailability) {
      const t = u.componentAvailability;
      want.push({ title: 'Component availability', status: /^ok\b/i.test(t) ? 'READY' : /missing|to be ordered|not available|shortage/i.test(t) ? 'BLOCKED' : /waiting|pending|late|eta|expected/i.test(t) ? 'PENDING' : 'UNKNOWN', notes: t });
    }
    for (const g of want) {
      const ex = (await c.query(`SELECT * FROM readiness_gates WHERE activity_id = $1 AND source_type = 'IMPORT' AND title = $2`, [fa.id, g.title])).rows[0];
      if (!ex) {
        await c.query(`INSERT INTO readiness_gates (project_id, activity_id, unit_id, dimension, title, status, blocks, owner_role, source_type, notes, spec, last_confirmed_at, created_by)
          SELECT project_id, id, unit_id, 'MATERIAL', $2, $3, 'START', 'MANUFACTURING', 'IMPORT', $4, $6, now(), $5 FROM activities WHERE id = $1`,
        [fa.id, g.title, g.status, g.notes, user.id, JSON.stringify({ importedStatus: g.status })]);
        stats.gates++;
      } else if (ex.status !== g.status) {
        // A status changed in the application since the last import wins over the tracker.
        const changedInApp = (ex.spec?.importedStatus ?? ex.status) !== ex.status;
        if (changedInApp) stats.conflicts.push(`${g.title}: status ${ex.status} set in the application kept (tracker: ${g.status})`);
        else {
          await c.query(`UPDATE readiness_gates SET status = $2, notes = $3, spec = spec || $4, last_confirmed_at = now(), updated_at = now() WHERE id = $1`, [ex.id, g.status, g.notes, JSON.stringify({ importedStatus: g.status })]);
          stats.gatesUpdated++;
        }
      }
    }
  }
}

/**
 * Only on explicit request (trustPastDates): timeline labels of the production plan whose span is already
 * in the past ("Validation", "Finishing / Packaging / Shipping", "Installation", "Commissioning") close the
 * corresponding system, shipment and site activities. Each such actual is flagged as assumed.
 */
async function applyLabelProgress(c: pg.PoolClient, user: AuthUser, unitId: number, u: TrackerUnit, asOfDay: string, stats: any) {
  const unit = (await c.query('SELECT project_id, system_id, shipment_id FROM units WHERE id = $1', [unitId])).rows[0];
  if (!unit) return;
  const visitId = unit.system_id ? (await c.query('SELECT visit_id FROM systems WHERE id = $1', [unit.system_id])).rows[0]?.visit_id ?? null : null;
  const steps: [RegExp, string, unknown[]][] = [
    [/valid/i, `system_id = $2 AND scope = 'SYSTEM'`, [unit.system_id]],
    [/pack|finish/i, `unit_id = $2 AND code = 'PACK'`, [unitId]],
    [/ship/i, `shipment_id = $2 AND scope = 'SHIPMENT' AND code IN ('OUT_PREP')`, [unit.shipment_id]],
    [/install/i, `visit_id = $2 AND code = 'INSTALL'`, [visitId]],
    [/com+is+ion/i, `visit_id = $2 AND code = 'COMM' AND system_id = $3`, [visitId, unit.system_id]],
  ];
  for (const l of u.labels) {
    if (l.to >= asOfDay) continue;
    for (const [re, where, params] of steps) {
      if (!re.test(l.text) || params.some((x) => x === null || x === undefined)) continue;
      const acts = (await c.query(`SELECT id FROM activities WHERE project_id = $1 AND status NOT IN ('COMPLETED','CANCELLED') AND ${where}`, [unit.project_id, ...params])).rows;
      for (const a of acts) {
        // Close predecessors first so the recorded sequence stays consistent.
        await c.query(`UPDATE activities p SET status = 'COMPLETED', actual_start = COALESCE(p.actual_start, $2), actual_finish = COALESCE(p.actual_finish, $2), pct_complete = 100,
            flags = array_append(p.flags, 'IMPORTED_ASSUMED_ACTUAL'), updated_by = $3, updated_at = now()
          FROM dependencies d WHERE d.pred_id = p.id AND d.succ_id = $1 AND p.status NOT IN ('COMPLETED','CANCELLED') AND p.scope = 'UNIT'`, [a.id, startSlot(l.from), user.id]);
        await setActual(c, user, a.id, { status: 'COMPLETED', start: startSlot(l.from), finish: endSlot(l.to) }, stats);
        await c.query(`UPDATE activities SET flags = array_append(flags, 'IMPORTED_ASSUMED_ACTUAL') WHERE id = $1`, [a.id]);
        stats.assumedActuals++;
      }
    }
  }
}

/** Effective dates from the on-site plan close the outbound and site activities they prove. */
async function applyVisitProgress(c: pg.PoolClient, user: AuthUser, projectId: number, shipmentId: number | null, visitId: number | null, v: TrackerVisit, stats: any) {
  const eff = (k: string) => {
    const x = v.dates[k];
    if (!x) return null;
    if (x.state !== 'PLANNED') return x.date;
    if (stats.trustPastDates && x.date < stats.asOfDay) { stats.assumedActuals++; return x.date; }
    return null;
  };
  const exw = eff('exw'); const arrival = eff('chargerArrival'); const instEnd = eff('installEnd'); const commEnd = eff('commEnd');
  const shipmentUnits = shipmentId ? (await c.query('SELECT id FROM units WHERE shipment_id = $1', [shipmentId])).rows.map((r) => r.id) : [];
  const systems = shipmentId ? (await c.query('SELECT DISTINCT system_id FROM units WHERE shipment_id = $1 AND system_id IS NOT NULL', [shipmentId])).rows.map((r) => r.system_id) : [];
  const close = async (where: string, params: unknown[], start: string, finish: string) => {
    for (const a of (await c.query(`SELECT id FROM activities WHERE project_id = $1 AND status NOT IN ('COMPLETED','CANCELLED') AND ${where}`, [projectId, ...params])).rows) {
      await setActual(c, user, a.id, { status: 'COMPLETED', start: startSlot(start), finish: endSlot(finish) }, stats);
    }
  };
  const ready = exw ?? arrival ?? instEnd ?? commEnd;
  if (ready) {
    await close(`unit_id = ANY($2)`, [shipmentUnits], ready, ready);
    await close(`system_id = ANY($2) AND scope = 'SYSTEM'`, [systems], ready, ready);
  }
  if (arrival ?? instEnd ?? commEnd) await close(`shipment_id = $2 AND scope = 'SHIPMENT'`, [shipmentId], exw ?? (arrival ?? instEnd ?? commEnd)!, (arrival ?? instEnd ?? commEnd)!);
  if (instEnd ?? commEnd) await close(`visit_id = $2 AND code = 'INSTALL'`, [visitId], v.dates.installStart?.date ?? (instEnd ?? commEnd)!, (instEnd ?? commEnd)!);
  if (commEnd) await close(`visit_id = $2 AND code = 'COMM'`, [visitId], v.dates.commStart?.date ?? commEnd, commEnd);
  const pastPlanned = stats.trustPastDates ? [] : Object.entries(v.dates).filter(([, d]) => d && d.state === 'PLANNED' && d.date < stats.asOfDay).map(([k, d]) => `${k} ${d!.date}`);
  return pastPlanned;
}

/**
 * A tracker row for project A naming a unit the application holds elsewhere (another project, or an internal / spare
 * unit) is a physical move. It is not applied silently: it is reported and an action asks for a reassignment scenario.
 */
async function reportMovedUnit(c: pg.PoolClient, user: AuthUser, u: TrackerUnit, projectId: number, label: string, serialOk: boolean | '' | null, batchId: number, stats: any) {
  const other = (await c.query(`SELECT un.id, un.internal_id, un.name, un.status, p.code project FROM units un LEFT JOIN projects p ON p.id = un.project_id
    WHERE (un.project_id IS DISTINCT FROM $1) AND un.status <> 'OBSOLETE' AND un.created_at < (SELECT created_at FROM import_batches WHERE id = $4)
      AND ((($2::text) IS NOT NULL AND un.serial = $2) OR (un.source = 'IMPORT' AND lower(un.name) = lower($3))) LIMIT 1`,
  [projectId, serialOk ? u.serial : null, u.name, batchId])).rows[0];
  if (!other) return false;
  const where = other.project ? `project ${other.project}` : 'the internal / spare units';
  stats.conflicts.push(`${u.name}: the tracker lists it under ${label}, the application has it in ${where} — not moved; reassign it through a scenario if it really moved`);
  await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, source, created_by, related) VALUES ('RECONCILIATION',$1,$2,$3,'MANAGEMENT','IMPORT',$4,$5)`,
    [`Unit ${u.name} moved in the tracker`, `The tracker (row ${u.row}) lists ${u.name} under ${label}; the application holds ${other.internal_id} in ${where}. Use "Reassign / borrow unit" in a scenario so donor and recipient impacts are simulated and traceability is kept.`,
      projectId, user.id, JSON.stringify({ batch: batchId, unitId: other.id, row: u.row })]);
  stats.actions++;
  return true;
}

export async function applyBatch(c: pg.PoolClient, user: AuthUser, id: number, opts: { allowOlder?: boolean; reason?: string } = {}) {
  await requirePermission(c, user, 'import.apply', 'Applying an import requires the import.apply authority');
  const b = (await c.query('SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!b) throw new HttpError(404, 'Import batch not found');
  if (b.status !== 'PREVIEW') throw new HttpError(409, `Batch is already ${b.status.toLowerCase()}`);
  const parsed = b.parsed as ParsedTracker;
  const d = (b.mapping ?? {}) as ImportDecisions;
  // Re-evaluate against the current database: other imports or edits may have happened since the preview.
  const report = await buildReport(c, parsed, d);
  const blocking = blockingIssues(report, d);
  if (blocking.length) throw new HttpError(422, `${blocking.length} decision(s) still needed before applying`, 'DECISIONS_REQUIRED', { blocking });
  if (report.olderThanApplied && !(opts.allowOlder && opts.reason)) {
    throw new HttpError(409, `This workbook (as of ${parsed.asOf}) is older than the last applied tracker (${report.previousAppliedAsOf}). Applying it requires an explicit reason.`, 'STALE_IMPORT');
  }
  const asOfDay = parsed.asOf.slice(0, 10);
  const stats: any = { asOfDay, trustPastDates: !!d.trustPastDates, assumedActuals: 0, projectsCreated: 0, projectsUpdated: 0, unitsImported: 0, unitsFilled: 0, internalUnits: 0, completed: 0, started: 0, gates: 0, gatesUpdated: 0,
    testRecords: 0, visitsUpdated: 0, releases: 0, coverage: 0, actions: 0, conflicts: [] as string[], skipped: [] as string[], reconciliation: [] as string[], demoRemoved: 0 };

  if (d.replaceDemo) {
    const r = await c.query(`DELETE FROM projects WHERE source = 'DEMO' RETURNING id`);
    stats.demoRemoved = r.rowCount;
    await c.query(`DELETE FROM units WHERE project_id IS NULL AND source = 'DEMO'`);
    await c.query(`DELETE FROM scenarios WHERE status IN ('DRAFT','SUBMITTED')`);
  }

  await loadImportRules(c);
  const products = (await c.query('SELECT id, code, name, family, item_codes FROM product_types')).rows as ProductRow[];
  const pid = new Map(products.map((p) => [p.code, p]));
  const keys = projectKeys(parsed);
  const decideGroup = (g: ImportReport['groups'][number]) => d.groups?.[g.key] ?? g.suggestion ?? { kind: 'SKIP' as const };
  const unitGroup = new Map<number, string>(report.units.map((u) => [u.row, u.group]));
  const groupDecision = new Map(report.groups.map((g) => [g.key, decideGroup(g)]));
  const included = (key: string) => d.projects?.[key]?.include !== false;
  const unitDecision = (u: TrackerUnit) => d.units?.[String(u.row)] ?? groupDecision.get(unitGroup.get(u.row)!);
  const unitsFor = (key: string) => parsed.units.filter((u) => { const g = unitDecision(u); return g?.kind === 'PROJECT' && g.projectKey === key; });
  const visitsFor = (key: string) => parsed.visits.filter((v) => {
    const vg = report.visitGroups.find((x) => x.row === v.row)!;
    const dec = d.visits?.[vg.key] ?? vg.suggestion;
    return dec?.kind === 'PROJECT' && dec.projectKey === key;
  });

  // Priorities: tracker order, after projects that are not from the tracker.
  const nonTracker = Number((await c.query(`SELECT COALESCE(max(priority), 0) m FROM projects WHERE status = 'ACTIVE' AND (source_ref IS NULL OR source_ref NOT LIKE 'OMT:%')`)).rows[0].m);
  const ordered = parsed.projects.map((p, i) => ({ p, key: keys[i] })).filter((x) => included(x.key))
    .sort((a, b) => (a.p.priority ?? 999) - (b.p.priority ?? 999) || a.p.row - b.p.row);
  const created: number[] = [];
  const serialCount = new Map<string, number>();
  for (const u of parsed.units) if (u.serial) serialCount.set(u.serial, (serialCount.get(u.serial) ?? 0) + 1);

  for (const [rank, { p, key }] of ordered.entries()) {
    const rp = report.projects.find((x) => x.key === key)!;
    const pd = d.projects?.[key] ?? {};
    const tracked = unitsFor(key).map((u) => {
      const pr = resolveProduct(products, u.itemCode ? [u.itemCode] : [], u.name);
      return pr ? { u, product: pr.code, family: pid.get(pr.code)!.family } : null;
    }).filter((x): x is { u: TrackerUnit; product: string; family: string } => !!x);
    const lines: { product: string; family: string; quantity: number }[] = [];
    for (const l of rp.lines.filter((x) => x.product)) {
      const ex = lines.find((x) => x.product === l.product);
      if (ex) ex.quantity += l.quantity; else lines.push({ product: l.product!, family: pid.get(l.product!)!.family, quantity: l.quantity });
    }
    for (const t of tracked) if (!lines.some((l) => l.product === t.product)) lines.push({ product: t.product, family: t.family, quantity: 0 });
    for (const l of lines) {
      const n = tracked.filter((t) => t.product === l.product).length;
      if (n > l.quantity) stats.reconciliation.push(`${rp.label}: tracker lists ${n}× ${l.product} but the order quantity is ${l.quantity}`);
    }
    if (rp.match.status === 'MATCHED') {
      // Existing imported project: descriptive fields only when accepted; dates and demand are never changed silently.
      const ex = (await c.query('SELECT * FROM projects WHERE id = $1', [rp.match.projectId])).rows[0];
      if (ex.status !== 'ACTIVE') { stats.skipped.push(`${rp.label}: cancelled in the application — not updated`); continue; }
      if (ex.source_ref !== `OMT:${key}`) {
        await c.query('UPDATE projects SET source_ref = $2 WHERE id = $1', [ex.id, `OMT:${key}`]);
        await audit(c, { userId: user.id, action: 'import.project.rename', changeClass: 'IMPORT', entityType: 'project', entityId: ex.id, projectId: ex.id,
          before: { trackerName: ex.source_ref.slice(4) }, after: { trackerName: p.customer }, reason: rp.match.via === 'decision' ? 'Confirmed as the same project in the import preview' : 'Same project name without account numbers / notes' });
      }
      const accept = pd.acceptUpdates !== false;
      const safe = rp.diffs.filter((x) => !['required_commissioning_date', 'demand_status'].includes(x.field));
      if (accept && safe.length) {
        for (const x of safe) await c.query(`UPDATE projects SET ${x.field} = $2 WHERE id = $1`, [ex.id, x.tracker]);
        stats.projectsUpdated++;
        await audit(c, { userId: user.id, action: 'import.project.update', changeClass: 'IMPORT', entityType: 'project', entityId: ex.id, projectId: ex.id, before: Object.fromEntries(safe.map((x) => [x.field, x.app])), after: Object.fromEntries(safe.map((x) => [x.field, x.tracker])) });
      }
      for (const x of rp.diffs.filter((y) => ['required_commissioning_date', 'demand_status'].includes(y.field))) {
        await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, source, created_by, related) VALUES ('RECONCILIATION',$1,$2,$3,'COMMERCIAL','IMPORT',$4,$5)`,
          [`Tracker differs: ${x.field.replace(/_/g, ' ')}`, `Application: ${x.app ?? '—'} · Tracker: ${x.tracker ?? '—'}. Change it through a scenario if the tracker is right.`, ex.id, user.id, JSON.stringify({ batch: id, field: x.field })]);
        stats.actions++;
      }
      // Units are matched by serial, then by name, then by a renamed name of the same product ("Cab-4" → "Cab-4 R2").
      // A unit that the application holds in another project is never duplicated: the move is reported for a reassignment.
      // New tracked units fill planned (untracked) units of the same product, else are added.
      const known = (await c.query(`SELECT id, name, serial, product_type_id, source, hw_revision FROM units WHERE project_id = $1`, [ex.id])).rows;
      const currentNames = new Set(tracked.map((t) => norm(t.u.name)));
      const currentSerials = new Set(tracked.map((t) => t.u.serial).filter(Boolean));
      const taken = new Set<number>();
      for (const t of tracked) {
        const serialOk = t.u.serial && (serialCount.get(t.u.serial) ?? 0) === 1;
        let hit = known.find((k) => !taken.has(k.id) && ((serialOk && k.serial === t.u.serial) || (k.name && norm(k.name) === norm(t.u.name))));
        if (!hit) {
          const tn = new Set(norm(t.u.name).split(' '));
          const renamed = known.filter((k) => !taken.has(k.id) && k.source === 'IMPORT' && k.name && k.product_type_id === pid.get(t.product)!.id
            && !currentNames.has(norm(k.name)) && !(k.serial && currentSerials.has(k.serial)) && (!k.serial || !t.u.serial || k.serial === t.u.serial)
            && (() => { const kn = norm(k.name).split(' '); return kn.length >= 2 && kn.every((w: string) => tn.has(w)); })());
          if (renamed.length === 1) {
            hit = renamed[0];
            await c.query('UPDATE units SET name = $2 WHERE id = $1', [hit.id, t.u.name]);
            await c.query(`INSERT INTO unit_history (unit_id, event, from_value, to_value, reason, user_id) VALUES ($1,'RENAMED',$2,$3,'Name changed in the ramp-up tracker',$4)`,
              [hit.id, JSON.stringify({ name: hit.name }), JSON.stringify({ name: t.u.name, row: t.u.row, batch: id }), user.id]);
            (stats.renamed ??= []).push(`${hit.name} → ${t.u.name}`);
          }
        }
        if (hit) {
          taken.add(hit.id);
          await c.query(`UPDATE units SET serial = COALESCE(serial, $2), item_code = COALESCE(item_code, $3), hw_revision = COALESCE($4, hw_revision) WHERE id = $1`,
            [hit.id, serialOk ? t.u.serial : null, t.u.itemCode, t.u.maturity]);
          if (t.u.maturity && hit.hw_revision && hit.hw_revision !== t.u.maturity) stats.conflicts.push(`${t.u.name}: hardware revision ${hit.hw_revision} in the application kept (tracker ${t.u.maturity})`);
          await applyUnitProgress(c, user, hit.id, t.u, asOfDay, stats);
          continue;
        }
        if (await reportMovedUnit(c, user, t.u, ex.id, rp.label, serialOk, id, stats)) continue;
        const ph = known.find((k) => !taken.has(k.id) && k.source === 'PLAN' && k.product_type_id === pid.get(t.product)!.id && !k.serial);
        let unitId: number;
        if (ph) {
          taken.add(ph.id);
          await c.query(`UPDATE units SET name = $2, serial = $3, item_code = $4, hw_revision = COALESCE($5, hw_revision), source = 'IMPORT', notes = $6 WHERE id = $1`,
            [ph.id, t.u.name, serialOk ? t.u.serial : null, t.u.itemCode, t.u.maturity, t.u.mapping || null]);
          unitId = ph.id; stats.unitsFilled++;
        } else {
          const sh = (await c.query('SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq DESC LIMIT 1', [ex.id])).rows[0]?.id ?? null;
          unitId = (await createUnit(c, { projectId: ex.id, productTypeId: pid.get(t.product)!.id, shipmentId: sh, name: t.u.name, serial: serialOk ? t.u.serial : null,
            itemCode: t.u.itemCode, hwRevision: t.u.maturity, seq: 900 + t.u.row, source: 'IMPORT', userId: user.id })).id;
          stats.reconciliation.push(`${rp.label}: ${t.u.name} is new in the tracker and was added without a system — assign it in the project`);
          await syncProjectGraph(c, ex.id, 'Unit added from tracker');
        }
        stats.unitsImported++;
        await applyUnitProgress(c, user, unitId, t.u, asOfDay, stats);
      }
      continue;
    }

    // New project
    const country = pd.country ?? rp.proposed.country!;
    const route = (await c.query(`SELECT id FROM routes WHERE origin_country = 'IT' AND destination_country = $1 ORDER BY id LIMIT 1`, [country])).rows[0];
    if (!route) throw new HttpError(422, `${rp.label}: no transport route to ${country} is configured`);
    const profile = rp.proposed.freightHint
      ? (await c.query(`SELECT id FROM service_profiles WHERE route_id = $1 AND mode = $2 ORDER BY id LIMIT 1`, [route.id, rp.proposed.freightHint])).rows[0]?.id ?? null
      : null;
    const regionId = (await c.query(`SELECT region_id FROM routes WHERE id = $1`, [route.id])).rows[0]?.region_id ?? null;
    const customerId = (await c.query('SELECT id FROM customers WHERE lower(name) = lower($1)', [p.customer])).rows[0]?.id
      ?? (await c.query('INSERT INTO customers (name, country, region_id) VALUES ($1,$2,$3) RETURNING id', [p.customer, country, regionId])).rows[0].id;
    const { systems, looseExtra } = planSystems(tracked, lines);
    const deliveries = deliveriesOf(systems);
    const sysInput = systems.map((s) => {
      const comp = new Map<number, number>();
      for (const u of s.units) { const t = tracked.find((x) => x.u === u)!; comp.set(pid.get(t.product)!.id, (comp.get(pid.get(t.product)!.id) ?? 0) + 1); }
      for (const [prod, q] of s.placeholders) comp.set(pid.get(prod)!.id, (comp.get(pid.get(prod)!.id) ?? 0) + q);
      return { code: s.code, composition: [...comp.entries()].map(([productTypeId, quantity]) => ({ productTypeId, quantity })) };
    });
    const looseTracked = tracked.filter((t) => !systems.some((s) => s.units.includes(t.u)));
    const looseComp = new Map<number, number>();
    for (const t of looseTracked) looseComp.set(pid.get(t.product)!.id, (looseComp.get(pid.get(t.product)!.id) ?? 0) + 1);
    for (const l of looseExtra) if (l.quantity > 0) looseComp.set(pid.get(l.product)!.id, (looseComp.get(pid.get(l.product)!.id) ?? 0) + l.quantity);
    const visitPlans = visitsFor(key);
    const demand = pd.demandStatus ?? rp.proposed.demandStatus;
    const site = visitPlans[0]?.project ?? p.customer;
    let code = rp.proposed.code;
    for (let n = 2; (await c.query('SELECT 1 FROM projects WHERE code = $1', [code])).rows.length; n++) code = `${rp.proposed.code.slice(0, 36)}-${n}`;
    const out = await createProject(c, user, {
      code, name: projectLabel(p, key), customerId, siteLocation: site, country, routeId: route.id, serviceProfileId: profile,
      requiredDate: rp.proposed.requiredDate, demandStatus: demand,
      notes: [p.scope ? `Scope (tracker): ${p.scope}` : null, p.foundationByAbb ? `Foundation by ABB: ${p.foundationByAbb}` : null,
        p.basePlates ? `Base plates: ${p.basePlates}` : null, p.jigs ? `Installation jigs: ${p.jigs}` : null,
        ...Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n') || undefined,
      systems: sysInput.length ? sysInput : undefined, lines: sysInput.length ? undefined : lines.map((l) => ({ productTypeId: pid.get(l.product)!.id, quantity: l.quantity })),
      loose: sysInput.length ? [...looseComp.entries()].map(([productTypeId, quantity]) => ({ productTypeId, quantity })) : undefined,
      deliveries: sysInput.length ? deliveries.map((x) => ({ systems: x.systems, serviceProfileId: profile })) : undefined,
      priority: nonTracker + rank + 1,
      meta: { requiredCommissioningText: p.requiredCommissioning.text, requiredExwText: p.requiredExw.text, wave: p.wave, series: p.series, sapOrderRef: p.sapOrderRef,
        o2cOwner: p.o2cOwner, spoc: p.spoc, rationale: p.rationale, customerSituation: p.customerSituation, mitigations: p.mitigations, sourceRef: `OMT:${key}`, scopeText: p.scope },
    }, { skipPlan: true, source: 'IMPORT' });
    const projectId = out.projectId;
    created.push(projectId);
    stats.projectsCreated++;

    // Give the created units the identities of the tracked physical units.
    const sysRows = (await c.query('SELECT id, code FROM systems WHERE project_id = $1', [projectId])).rows;
    const unitRows = (await c.query('SELECT id, system_id, product_type_id FROM units WHERE project_id = $1 ORDER BY seq', [projectId])).rows;
    const taken = new Set<number>();
    const assign = async (t: { u: TrackerUnit; product: string }, systemId: number | null) => {
      if (await reportMovedUnit(c, user, t.u, projectId, rp.label, t.u.serial && (serialCount.get(t.u.serial) ?? 0) === 1, id, stats)) return;
      const row = unitRows.find((r) => !taken.has(r.id) && r.system_id === systemId && r.product_type_id === pid.get(t.product)!.id);
      if (!row) { stats.skipped.push(`${t.u.name}: no matching unit slot`); return; }
      taken.add(row.id);
      const dupSerial = (serialCount.get(t.u.serial ?? '') ?? 0) > 1;
      await c.query(`UPDATE units SET name = $2, serial = $3, item_code = $4, hw_revision = COALESCE($5, hw_revision), source = 'IMPORT', notes = $6 WHERE id = $1`,
        [row.id, t.u.name, dupSerial ? null : t.u.serial, t.u.itemCode, t.u.maturity, [t.u.mapping, t.u.eolStatus ? `EOL status: ${t.u.eolStatus}` : null, dupSerial ? `Tracker serial ${t.u.serial} is duplicated — verify` : null].filter(Boolean).join(' · ') || null]);
      await c.query(`INSERT INTO unit_history (unit_id, event, to_value, reason, user_id) VALUES ($1,'IMPORTED',$2,'Ramp-up tracker',$3)`, [row.id, JSON.stringify({ name: t.u.name, serial: t.u.serial, row: t.u.row, batch: id }), user.id]);
      stats.unitsImported++;
      await applyUnitProgress(c, user, row.id, t.u, asOfDay, stats);
      if (d.trustPastDates) await applyLabelProgress(c, user, row.id, t.u, asOfDay, stats);
    };
    for (const s of systems) {
      const sid = sysRows.find((r) => r.code === s.code)?.id ?? null;
      for (const u of s.units) await assign(tracked.find((x) => x.u === u)!, sid);
    }
    for (const t of looseTracked) await assign(t, null);

    // Site plans → visits (batch k → k-th delivery).
    const visits = (await c.query('SELECT id, code FROM commissioning_visits WHERE project_id = $1 ORDER BY id', [projectId])).rows;
    const ships = (await c.query('SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq', [projectId])).rows;
    for (const [i, v] of visitPlans.entries()) {
      const bi = v.batch ? Number(v.batch.match(/\d+/)?.[0] ?? i + 1) - 1 : i;
      const visit = visits[Math.min(bi, visits.length - 1)];
      const ship = ships[Math.min(bi, ships.length - 1)];
      if (!visit) continue;
      const roles = v.roles.map((r) => ({ role: r.role, person: r.person }));
      const partner = v.roles.find((r) => /installation partner/i.test(r.role))?.person ?? null;
      const specialists = v.roles.filter((r) => /commissioning (engineer|partner)|r&d/i.test(r.role)).map((r) => `${r.role}: ${r.person}`).join('; ') || null;
      await c.query(`UPDATE commissioning_visits SET roles = $2, planned_dates = $3, installation_responsibility = COALESCE($4, installation_responsibility), specialists = $5,
          personnel_confirmed = $6, notes = $7 WHERE id = $1`,
      [visit.id, JSON.stringify(roles), JSON.stringify(v.dates), partner, specialists, /confi?rm/i.test(v.personnelStatus ?? ''),
        `Imported from the on-site plan${v.configuration ? ` (${v.configuration})` : ''}. Site work responsible is not inferred from job titles — confirm it explicitly.`]);
      stats.visitsUpdated++;
      const pastPlanned = await applyVisitProgress(c, user, projectId, ship?.id ?? null, visit.id, v, stats);
      if (pastPlanned.length) {
        await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, source, created_by, related) VALUES ('EXPLANATION_REQUIRED',$1,$2,$3,'SERVICE','IMPORT',$4,$5)`,
          [`Confirm actuals: tracker dates in the past are not marked effective (${visit.code})`, `Planned dates already passed without an effective date: ${pastPlanned.join(', ')}. Record the actual or explain the delay.`, projectId, user.id, JSON.stringify({ batch: id, visitId: visit.id })]);
        stats.actions++;
      }
    }
    for (const r of stats.reconciliation.filter((x: string) => x.startsWith(rp.label + ':'))) {
      await c.query(`INSERT INTO action_items (kind, title, details, project_id, owner_role, source, created_by, related) VALUES ('RECONCILIATION',$1,$2,$3,'COMMERCIAL','IMPORT',$4,$5)`,
        ['Order quantity differs from tracked units', r, projectId, user.id, JSON.stringify({ batch: id })]);
      stats.actions++;
    }
    // Confirmed ExWorks dates in the tracker are recorded as imported commitments per shipment, once planned.
    (stats.exwCommitments ??= []).push({ projectId, deliveries: deliveries.map((dl) => ({ key: dl.key, exw: dl.key.startsWith('D') ? dl.key.slice(1) : null })) });
  }

  // Internal / R&D units: registered as physical units without a customer project (they can be borrowed later via reassignment).
  for (const u of parsed.units) {
    const g = unitDecision(u);
    if (g?.kind !== 'INTERNAL') continue;
    const pr = resolveProduct(products, u.itemCode ? [u.itemCode] : [], u.name);
    if (!pr) continue;
    const ex = (await c.query(`SELECT id FROM units WHERE project_id IS NULL AND ((serial IS NOT NULL AND serial = $1) OR lower(name) = lower($2))`, [u.serial, u.name])).rows[0];
    if (ex) continue;
    const nu = await createUnit(c, { projectId: null, productTypeId: pid.get(pr.code)!.id, name: u.name, serial: (serialCount.get(u.serial ?? '') ?? 0) > 1 ? null : u.serial, itemCode: u.itemCode,
      hwRevision: u.maturity, seq: u.row, source: 'IMPORT', status: 'SPARE', evaluation: true, location: u.mapping.match(/\bin ([A-Z][\w-]+)/)?.[1] ?? 'R&D / internal', userId: user.id });
    await c.query(`UPDATE units SET notes = $2 WHERE id = $1`, [nu.id, [u.mapping, u.eolStatus ? `EOL status: ${u.eolStatus}` : null].filter(Boolean).join(' · ') || null]);
    stats.internalUnits++;
  }

  // Software releases (EAP): recorded as candidates — an entry in the tracker is not an approval for a defined use.
  const sysSw = (await c.query(`SELECT id FROM sw_components WHERE code = 'SYS_SW'`)).rows[0]?.id;
  if (sysSw) for (const r of parsed.releases) {
    const ex = (await c.query('SELECT id, known_issues FROM sw_releases WHERE component_id = $1 AND version = $2', [sysSw, r.version])).rows[0];
    if (!ex) {
      await c.query(`INSERT INTO sw_releases (component_id, version, stage, known_issues, notes, created_by) VALUES ($1,$2,'CANDIDATE',$3,$4,$5)`,
        [sysSw, r.version, JSON.stringify(r.knownIssues), 'Imported from the ramp-up tracker (EAP release list). Record approval scope and artifact availability before it can satisfy a gate.', user.id]);
      stats.releases++;
    } else if (JSON.stringify(ex.known_issues) !== JSON.stringify(r.knownIssues)) {
      await c.query('UPDATE sw_releases SET known_issues = $2 WHERE id = $1', [ex.id, JSON.stringify(r.knownIssues)]);
    }
  }
  // Test coverage readiness per product module.
  for (const t of parsed.coverage) {
    await c.query(`INSERT INTO test_coverage (product_family, module, requirements, scripts, config, test_bench, handover, owner, remarks, source, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IMPORT',now()) ON CONFLICT (product_family, module) DO UPDATE SET requirements = EXCLUDED.requirements, scripts = EXCLUDED.scripts,
      config = EXCLUDED.config, test_bench = EXCLUDED.test_bench, handover = EXCLUDED.handover, owner = EXCLUDED.owner, remarks = EXCLUDED.remarks, updated_at = now()
      WHERE test_coverage.source = 'IMPORT'`, [t.family, t.module, t.requirements, t.scripts, t.config, t.testBench, t.handover, t.owner, t.remarks]);
    stats.coverage++;
  }
  // Open tracker topics → action items (deduplicated by topic); closed in the tracker → closed here unless already handled.
  const topicKey = (t: string) => norm(t).slice(0, 120);
  for (const t of parsed.topics) {
    const ex = (await c.query(`SELECT id, status FROM action_items WHERE source = 'IMPORT' AND kind = 'GENERAL' AND related->>'trackerTopic' = $1 AND related->>'row' = $2`, [topicKey(t.topic), String(t.row)])).rows[0];
    if (!ex && t.open) {
      const due = t.followUp?.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
      await c.query(`INSERT INTO action_items (kind, title, details, owner_name, status, due_date, related, source, created_by) VALUES ('GENERAL',$1,$2,$3,'OPEN',$4,$5,'IMPORT',$6)`,
        [t.topic, [t.status ? `Tracker status: ${t.status}` : null, t.latest].filter(Boolean).join(' — '), t.responsible,
          due ? `${due[3]}-${due[2].padStart(2, '0')}-${due[1].padStart(2, '0')}` : null, JSON.stringify({ trackerTopic: topicKey(t.topic), row: String(t.row), batch: id }), user.id]);
      stats.actions++;
    } else if (ex && !t.open && ex.status === 'OPEN') {
      await c.query(`UPDATE action_items SET status = 'DONE', closed_by = $2, closed_at = now(), details = details || $3 WHERE id = $1`, [ex.id, user.id, ` — closed in tracker (${t.status})`]);
    }
  }
  // Remember the name decisions as aliases (so the next import resolves them automatically).
  const refToId = new Map((await c.query(`SELECT id, source_ref FROM projects WHERE source_ref LIKE 'OMT:%'`)).rows.map((r) => [r.source_ref.slice(4), r.id]));
  const remember = async (alias: string, dec: { kind: string; projectKey?: string } | undefined) => {
    if (!dec || dec.kind === 'SKIP') return;
    const target = dec.kind === 'INTERNAL' ? 0 : refToId.get(dec.projectKey!);
    if (target === undefined) return;
    await c.query(`INSERT INTO name_aliases (kind, alias, target_id, created_by) VALUES ('PROJECT',$1,$2,$3) ON CONFLICT (kind, alias) DO UPDATE SET target_id = EXCLUDED.target_id`, [alias, target, user.id]);
  };
  for (const g of report.groups) if (d.groups?.[g.key] || g.status !== 'AUTO') await remember(g.key, d.groups?.[g.key] ?? g.suggestion ?? undefined);
  for (const v of report.visitGroups) if (d.visits?.[v.key] || v.status !== 'AUTO') await remember(norm(v.project), d.visits?.[v.key] ?? v.suggestion ?? undefined);

  // Plan: committed demand backward from the required date, everything else indicatively; then one recalculation.
  await syncDerivedGates(c);
  for (const projectId of created) {
    const p = (await c.query('SELECT demand_status FROM projects WHERE id = $1', [projectId])).rows[0];
    if (p.demand_status === 'COMMITTED') await planInitial(c, user, projectId, 'Initial plan (imported from ramp-up tracker)');
  }
  await c.query(`UPDATE projects SET plan_status = 'INDICATIVE' WHERE id = ANY($1) AND demand_status <> 'COMMITTED'`, [created]);
  const rec = await recalculate(c, { userId: user.id, kind: 'IMPORT', summary: `Ramp-up tracker import (${b.filename ?? 'workbook'}, as of ${asOfDay})` });
  // Confirmed ExWorks dates from the tracker become imported commitments on the shipment milestones.
  for (const x of stats.exwCommitments ?? []) {
    const ships = (await c.query('SELECT id FROM shipments WHERE project_id = $1 ORDER BY seq', [x.projectId])).rows;
    for (const [i, dl] of x.deliveries.entries()) {
      if (!dl.exw || !ships[i]) continue;
      const m = (await c.query(`SELECT id, approved_slot FROM milestones WHERE shipment_id = $1 AND type = 'EXW'`, [ships[i].id])).rows[0];
      if (!m) continue;
      const slot = endSlot(dl.exw);
      if (m.approved_slot === slot) continue;
      await c.query('UPDATE milestones SET approved_slot = $2, baseline_slot = COALESCE(baseline_slot, $2) WHERE id = $1', [m.id, slot]);
      await c.query(`INSERT INTO milestone_commitments (milestone_id, committed_slot, previous_slot, kind, confidence, reason, user_id) VALUES ($1,$2,$3,'IMPORTED','CONDITIONAL',$4,$5)`,
        [m.id, slot, m.approved_slot, `Confirmed ExWorks date in the ramp-up tracker (${dl.exw})`, user.id]);
    }
  }
  delete stats.exwCommitments;
  await bumpInputs(c, created);
  await c.query(`UPDATE import_batches SET status = 'APPLIED', applied_by = $2, applied_at = now(), report = report || $3 WHERE id = $1`,
    [id, user.id, JSON.stringify({ applied: stats, appliedReason: opts.reason ?? null })]);
  await audit(c, { userId: user.id, action: 'import.apply', changeClass: 'IMPORT', entityType: 'import_batch', entityId: id, planVersion: rec.version, after: stats, reason: opts.reason ?? null });
  return { id, status: 'APPLIED', stats, version: rec.version, today: await todayDay(c) };
}
