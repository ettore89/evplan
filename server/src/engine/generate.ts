import { dayOf, type Slot } from './calendar.js';
import type { MilestoneTag } from './types.js';

export interface RoutingStepDef {
  seq: number;
  code: string;
  name: string;
  function: string;
  workCenterId: number | null;
  durationSlots: number;
  scope: 'unit' | 'shipment';
  kind: 'work' | 'transport';
  predecessorSeqs: number[] | null; // null => previous step
  milestoneTag: MilestoneTag;
  useDestinationCalendar: boolean;
}

export interface UnitDef {
  key: string;
  seq: number;
  shipmentKey: string;
  steps: RoutingStepDef[];
}

export interface ShipmentDef {
  key: string;
  routeId: number;
  transportSlots: number;
  releaseLagSlots: number;
}

export interface GeneratedActivity {
  key: string;
  unitKey: string | null;
  shipmentKey: string | null;
  step: RoutingStepDef;
  durationSlots: number;
  unitSeq: number;
  calendarId: number | null;
  routeId: number | null;
}

export interface GeneratedDependency {
  predKey: string;
  succKey: string;
  lag: number;
}

/**
 * Expand product routings into one independent activity chain per physical unit,
 * plus shipment-level activities shared by the units of a consolidated delivery.
 * No quantity-based efficiencies are applied: every unit carries the full standard work.
 */
export function generateActivities(units: UnitDef[], shipments: ShipmentDef[], destinationCalendarId: number | null) {
  const acts: GeneratedActivity[] = [];
  const deps: GeneratedDependency[] = [];
  const shipmentSteps = new Map<string, Map<number, GeneratedActivity>>();
  const shipById = new Map(shipments.map((s) => [s.key, s]));

  // Shipment-level steps are taken from the first unit routing that defines them.
  for (const sh of shipments) {
    const m = new Map<number, GeneratedActivity>();
    const shipUnits = units.filter((u) => u.shipmentKey === sh.key);
    const steps = new Map<number, RoutingStepDef>();
    for (const u of shipUnits) for (const st of u.steps) if (st.scope === 'shipment' && !steps.has(st.seq)) steps.set(st.seq, st);
    for (const st of steps.values()) {
      const g: GeneratedActivity = {
        key: `S:${sh.key}:${st.seq}`, unitKey: null, shipmentKey: sh.key, step: st,
        durationSlots: st.kind === 'transport' ? sh.transportSlots : st.durationSlots,
        unitSeq: 0, calendarId: st.useDestinationCalendar ? destinationCalendarId : null,
        routeId: st.kind === 'transport' ? sh.routeId : null,
      };
      acts.push(g);
      m.set(st.seq, g);
    }
    shipmentSteps.set(sh.key, m);
  }

  for (const u of units) {
    const mine = new Map<number, GeneratedActivity>();
    const sorted = [...u.steps].sort((a, b) => a.seq - b.seq);
    for (const st of sorted) {
      if (st.scope !== 'unit') continue;
      const g: GeneratedActivity = {
        key: `U:${u.key}:${st.seq}`, unitKey: u.key, shipmentKey: u.shipmentKey, step: st,
        durationSlots: st.durationSlots, unitSeq: u.seq,
        calendarId: st.useDestinationCalendar ? destinationCalendarId : null, routeId: null,
      };
      acts.push(g);
      mine.set(st.seq, g);
    }
    const shipActs = shipmentSteps.get(u.shipmentKey) ?? new Map();
    const lookup = (seq: number) => mine.get(seq) ?? shipActs.get(seq);
    for (let i = 0; i < sorted.length; i++) {
      const st = sorted[i];
      const preds = st.predecessorSeqs ?? (i > 0 ? [sorted[i - 1].seq] : []);
      const target = lookup(st.seq);
      if (!target) continue;
      for (const ps of preds) {
        const p = lookup(ps);
        if (!p) continue;
        const lag = target.step.kind === 'transport' ? shipById.get(u.shipmentKey)?.releaseLagSlots ?? 0 : 0;
        if (!deps.some((d) => d.predKey === p.key && d.succKey === target.key)) deps.push({ predKey: p.key, succKey: target.key, lag });
      }
    }
  }
  return { acts, deps };
}

export function freezeStatus(exwForecast: Slot | null, exwActual: Slot | null, todayDay: number, freezeDays: number) {
  if (exwForecast === null) return { frozen: false, freezeStartDay: null as number | null, exworksDay: null as number | null };
  const exworksDay = dayOf(exwForecast - 1);
  const freezeStartDay = exworksDay - freezeDays;
  return { frozen: exwActual === null && todayDay >= freezeStartDay, freezeStartDay, exworksDay };
}
