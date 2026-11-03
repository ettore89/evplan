import { dayOf, type Slot } from './calendar.js';
import type { ActivityKind, MilestoneTag, PhaseDef, Scope } from './types.js';

/** Where in the flow a step sits. Unit steps before the system operations are PRE, after them POST. */
export type StepScope = 'UNIT' | 'SYSTEM' | 'SHIPMENT' | 'SITE' | 'SITE_SYSTEM';

export interface StepTemplate {
  seq: number;
  code: string;
  name: string;
  function: string;
  scope: StepScope;
  stage?: 'PRE' | 'POST';
  kind: ActivityKind;
  workCenterId: number | null;
  durationSlots: number;
  phases?: PhaseDef[] | null;
  predecessorSeqs?: number[] | null; // null => previous step in the same chain
  milestoneTag: MilestoneTag;
  useDestinationCalendar: boolean;
  /** Keep a resource held from the end of an earlier step in the same chain until this step starts. */
  holdFrom?: { seq: number; resourceId: number; units: number } | null;
  routingStepId?: number | null;
}

export interface UnitDef { key: string; seq: number; systemKey: string | null; shipmentKey: string | null; steps: StepTemplate[] }
export interface SystemDef { key: string; seq: number; unitKeys: string[]; steps: StepTemplate[] }
export interface ShipmentDef { key: string; routeId: number | null; steps: StepTemplate[] }
export interface VisitDef { key: string; systemKeys: string[]; shipmentKeys: string[]; steps: StepTemplate[]; calendarId: number | null }

export interface GeneratedActivity {
  key: string;
  scope: Scope;
  unitKey: string | null;
  systemKey: string | null;
  shipmentKey: string | null;
  visitKey: string | null;
  step: StepTemplate;
  durationSlots: number;
  phases: PhaseDef[] | null;
  unitSeq: number;
  calendarId: number | null;
  routeId: number | null;
}

export interface GeneratedDependency { predKey: string; succKey: string; lag: number }
export interface GeneratedHold { succKey: string; fromKey: string; resourceId: number; units: number }

function chain(steps: StepTemplate[], key: (s: StepTemplate) => string, deps: GeneratedDependency[], holds: GeneratedHold[]) {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const st = sorted[i];
    const preds = st.predecessorSeqs ?? (i > 0 ? [sorted[i - 1].seq] : []);
    for (const ps of preds) {
      const p = sorted.find((x) => x.seq === ps);
      if (p) deps.push({ predKey: key(p), succKey: key(st), lag: 0 });
    }
    if (st.holdFrom) {
      const src = sorted.find((x) => x.seq === st.holdFrom!.seq);
      if (src) holds.push({ succKey: key(st), fromKey: key(src), resourceId: st.holdFrom.resourceId, units: st.holdFrom.units });
    }
  }
  return { first: sorted[0], last: sorted[sorted.length - 1] };
}

const durationOf = (s: StepTemplate) => (s.phases?.length ? s.phases.reduce((t, p) => t + p.slots, 0) : s.durationSlots);

/**
 * Expand routings into one independent flow per physical unit, one operation per complete system
 * (linked to all its units, not duplicated per unit), one chain per shipment manifest and one per
 * site intervention. No quantity-based efficiencies are applied: every unit carries full standard work.
 */
export function generateActivities(input: { units: UnitDef[]; systems: SystemDef[]; shipments: ShipmentDef[]; visits: VisitDef[]; destinationCalendarId: number | null }) {
  const acts: GeneratedActivity[] = [];
  const deps: GeneratedDependency[] = [];
  const holds: GeneratedHold[] = [];
  const unitOf = new Map(input.units.map((u) => [u.key, u]));
  const add = (g: Omit<GeneratedActivity, 'durationSlots' | 'phases'>) => {
    acts.push({ ...g, durationSlots: durationOf(g.step), phases: g.step.phases?.length ? g.step.phases : null });
  };

  const unitLast = new Map<string, string>(); // unit key -> key of its last activity
  const unitPreLast = new Map<string, string>();
  const unitPostFirst = new Map<string, string>();
  for (const u of input.units) {
    const pre = u.steps.filter((s) => s.scope === 'UNIT' && (s.stage ?? 'PRE') === 'PRE');
    const post = u.steps.filter((s) => s.scope === 'UNIT' && s.stage === 'POST');
    const k = (s: StepTemplate) => `U:${u.key}:${s.seq}`;
    for (const s of [...pre, ...post]) add({ key: k(s), scope: 'UNIT', unitKey: u.key, systemKey: u.systemKey, shipmentKey: u.shipmentKey, visitKey: null, step: s, unitSeq: u.seq, calendarId: s.useDestinationCalendar ? input.destinationCalendarId : null, routeId: null });
    const a = pre.length ? chain(pre, k, deps, holds) : null;
    const b = post.length ? chain(post, k, deps, holds) : null;
    if (a) unitPreLast.set(u.key, k(a.last));
    if (b) unitPostFirst.set(u.key, k(b.first));
    if (a && b && !u.systemKey) deps.push({ predKey: k(a.last), succKey: k(b.first), lag: 0 });
    const last = b ? b.last : a?.last;
    if (last) unitLast.set(u.key, k(last));
  }

  const systemLast = new Map<string, string>();
  for (const sy of input.systems) {
    const steps = sy.steps.filter((s) => s.scope === 'SYSTEM');
    const k = (s: StepTemplate) => `Y:${sy.key}:${s.seq}`;
    const firstUnit = Math.min(...sy.unitKeys.map((u) => unitOf.get(u)?.seq ?? 0));
    for (const s of steps) add({ key: k(s), scope: 'SYSTEM', unitKey: null, systemKey: sy.key, shipmentKey: null, visitKey: null, step: s, unitSeq: 1000 + (Number.isFinite(firstUnit) ? firstUnit : sy.seq), calendarId: null, routeId: null });
    const c = steps.length ? chain(steps, k, deps, holds) : null;
    for (const uk of sy.unitKeys) {
      const pl = unitPreLast.get(uk);
      const pf = unitPostFirst.get(uk);
      if (c && pl) deps.push({ predKey: pl, succKey: k(c.first), lag: 0 });
      if (c && pf) deps.push({ predKey: k(c.last), succKey: pf, lag: 0 });
      if (!c && pl && pf) deps.push({ predKey: pl, succKey: pf, lag: 0 });
    }
    if (c) systemLast.set(sy.key, k(c.last));
  }

  const shipmentLast = new Map<string, string>();
  for (const sh of input.shipments) {
    const k = (s: StepTemplate) => `S:${sh.key}:${s.seq}`;
    for (const s of sh.steps) add({ key: k(s), scope: 'SHIPMENT', unitKey: null, systemKey: null, shipmentKey: sh.key, visitKey: null, step: s, unitSeq: 2000, calendarId: s.useDestinationCalendar ? input.destinationCalendarId : null, routeId: s.kind === 'transport' ? sh.routeId : null });
    if (!sh.steps.length) continue;
    const c = chain(sh.steps, k, deps, holds);
    for (const u of input.units.filter((x) => x.shipmentKey === sh.key)) {
      const ul = unitLast.get(u.key);
      if (ul) deps.push({ predKey: ul, succKey: k(c.first), lag: 0 });
    }
    shipmentLast.set(sh.key, k(c.last));
  }

  for (const v of input.visits) {
    const site = v.steps.filter((s) => s.scope === 'SITE');
    const perSystem = v.steps.filter((s) => s.scope === 'SITE_SYSTEM');
    const k = (s: StepTemplate) => `V:${v.key}:${s.seq}`;
    for (const s of site) add({ key: k(s), scope: 'SITE', unitKey: null, systemKey: null, shipmentKey: null, visitKey: v.key, step: s, unitSeq: 3000, calendarId: v.calendarId ?? input.destinationCalendarId, routeId: null });
    const c = site.length ? chain(site, k, deps, holds) : null;
    if (c) for (const sk of v.shipmentKeys) {
      const sl = shipmentLast.get(sk);
      if (sl) deps.push({ predKey: sl, succKey: k(c.first), lag: 0 });
    }
    for (const [i, sysKey] of v.systemKeys.entries()) {
      const kk = (s: StepTemplate) => `W:${v.key}:${sysKey}:${s.seq}`;
      for (const s of perSystem) add({ key: kk(s), scope: 'SITE', unitKey: null, systemKey: sysKey, shipmentKey: null, visitKey: v.key, step: s, unitSeq: 3100 + i, calendarId: v.calendarId ?? input.destinationCalendarId, routeId: null });
      if (!perSystem.length) continue;
      const cc = chain(perSystem, kk, deps, holds);
      if (c) deps.push({ predKey: k(c.last), succKey: kk(cc.first), lag: 0 });
      else for (const sk of v.shipmentKeys) {
        const sl = shipmentLast.get(sk);
        if (sl) deps.push({ predKey: sl, succKey: kk(cc.first), lag: 0 });
      }
    }
  }
  // de-duplicate dependencies
  const seen = new Set<string>();
  const uniq = deps.filter((d) => { const s = `${d.predKey}>${d.succKey}`; if (seen.has(s)) return false; seen.add(s); return true; });
  return { acts, deps: uniq, holds };
}

export interface FreezePolicy {
  days: number;
  /** Day ExWorks − days is itself frozen (recommended: inclusive). */
  inclusive: boolean;
  /** Once frozen, a project/shipment stays frozen even if its forecast later slips. */
  persistent: boolean;
  /** SHIPMENT: each delivery freezes on its own ExWorks; PROJECT: the earliest open delivery freezes the project. */
  scope: 'SHIPMENT' | 'PROJECT';
}

export function freezeStatus(exwForecast: Slot | null, exwActual: Slot | null, todayDay: number, freezeDays: number, inclusive = true) {
  if (exwForecast === null) return { frozen: false, freezeStartDay: null as number | null, exworksDay: null as number | null };
  const exworksDay = dayOf(exwForecast - 1);
  const freezeStartDay = exworksDay - freezeDays;
  const inWindow = inclusive ? todayDay >= freezeStartDay : todayDay > freezeStartDay;
  return { frozen: exwActual === null && inWindow, freezeStartDay, exworksDay };
}
