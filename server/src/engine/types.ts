import type { CalendarDef, Slot } from './calendar.js';

export type ActivityStatus =
  | 'NOT_STARTED'
  | 'READY'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELLED';

export type MilestoneType = 'EOL' | 'EXW' | 'COMM';
export type MilestoneTag = 'EOL' | 'PACK' | 'COMM' | null;

/** What an activity applies to: one physical unit, a complete system, a shipment, or a site intervention. */
export type Scope = 'UNIT' | 'SYSTEM' | 'SHIPMENT' | 'SITE';

/**
 * work      – working calendar, consumes resources
 * transport – route/transport calendar (weekends per route), no resources
 * calendar  – calendar days (e.g. customs allowance), no resources
 * external  – working days of the activity calendar, performed by others (e.g. customer installation)
 */
export type ActivityKind = 'work' | 'transport' | 'calendar' | 'external';

export type Confidence = 'FIRM' | 'CONDITIONAL' | 'OPEN';
export const CONFIDENCE_RANK: Record<Confidence, number> = { FIRM: 0, CONDITIONAL: 1, OPEN: 2 };
export const worstConfidence = (a: Confidence, b: Confidence): Confidence => (CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b);

/** A schedulable resource: station positions, skids, crews, shared infrastructure, field teams. */
export interface WorkCenterDef {
  id: number;
  code: string;
  name: string;
  /** Units available per half-day slot (integer for physical positions/people). */
  capacity: number;
  calendarId: number | null;
}

/** Effective-dated capacity. Only changes that are actually implemented feed the executable plan. */
export interface CapacityChangeDef {
  resourceId: number;
  fromDay: number;
  capacity: number;
}

/** Non-production occupancy: troubleshooting, regression testing, maintenance, test-equipment development… */
export interface ReservationDef {
  id: number;
  resourceId: number;
  start: Slot;
  finish: Slot;
  units: number;
  kind: string;
}

/** Authorized work on an otherwise non-working day, for a resource (or a single activity). */
export interface WeekendAuthDef {
  id?: number;
  workCenterId: number | null;
  activityId: number | null;
  day: number;
  capacity: number | null;
}

export interface RouteDef {
  id: number;
  operatesSaturday: boolean;
  operatesSunday: boolean;
  holidayCalendarIds: number[];
}

export interface ProjectDef {
  id: number;
  code: string;
  priority: number;
  /** Exclusive slot: end of the customer-required commissioning completion day. */
  requiredFinish: Slot | null;
  /** 0 = committed / in execution, 1 = approved demand awaiting scheduling, 2 = tentative. Lower ranks are served first. */
  demandRank?: number;
}

export interface Pred {
  id: number;
  lag: number;
}

export interface ResourceReq {
  resourceId: number;
  units: number;
}

/** A contiguous part of an activity with its own resource needs (e.g. EOL power test needing the shared tester). */
export interface PhaseDef {
  name: string;
  slots: number;
  resources: ResourceReq[];
}

export type GateStatus = 'UNKNOWN' | 'PENDING' | 'READY' | 'BLOCKED';

/** A readiness prerequisite (material, software, configuration, quality, resource, external). */
export interface GateDef {
  id: number;
  dimension: string;
  title: string;
  status: GateStatus;
  /** START: the activity cannot start; COMPLETE: it may progress but cannot complete. */
  blocks: 'START' | 'COMPLETE';
  /** Forecast resolution (exclusive slot), when known. */
  forecast: Slot | null;
  /** An approved conditional release currently lets work proceed despite the gate. */
  conditional: boolean;
}

/**
 * The activity keeps a resource occupied from the end of an earlier activity until it starts
 * (e.g. a validation skid stays occupied until the system is disconnected and removed).
 */
export interface HoldDef {
  fromActivityId: number;
  resourceId: number;
  units: number;
}

export interface ActivityDef {
  id: number;
  projectId: number;
  unitId: number | null;
  systemId?: number | null;
  shipmentId: number | null;
  visitId?: number | null;
  scope?: Scope;
  /** Primary resource (for display, calendars and weekend authorizations). */
  workCenterId: number | null;
  calendarId: number | null;
  routeId: number | null;
  kind: ActivityKind;
  name: string;
  code?: string;
  seq: number;
  unitSeq: number;
  milestoneTag: MilestoneTag;
  durationSlots: number;
  /** Resource profile. Empty means a single phase on the primary resource (or no resources). */
  phases?: PhaseDef[];
  pctComplete: number;
  /** Slot at which pctComplete was last reported (remaining work counts from there). */
  progressSlot?: Slot | null;
  status: ActivityStatus;
  actualStart: Slot | null;
  actualFinish: Slot | null;
  approvedStart: Slot | null;
  approvedFinish: Slot | null;
  /** User-reported expected completion (reported delay). */
  expectedFinish: Slot | null;
  locked: boolean;
  preds: Pred[];
  gates?: GateDef[];
  holds?: HoldDef[];
  /** Kept for compatibility with V3 data; ignored by the V4 allocator. */
  maxRate?: number;
}

export interface PlanState {
  now: Slot;
  calendars: CalendarDef[];
  defaultCalendarId: number;
  workCenters: WorkCenterDef[];
  capacityChanges?: CapacityChangeDef[];
  reservations?: ReservationDef[];
  weekendAuths: WeekendAuthDef[];
  routes: RouteDef[];
  projects: ProjectDef[];
  activities: ActivityDef[];
  /** Projects for which approved start dates are not used as release floors (explicit recovery). */
  pullIn: number[];
  /** Activities placed by an explicit manual move: must land exactly on approvedStart or be reported invalid. */
  pinned: number[];
}

export type Driver =
  | { type: 'actual' }
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'predecessor'; ref: number }
  | { type: 'approved' }
  | { type: 'now' }
  | { type: 'reported' }
  | { type: 'blocked' }
  | { type: 'overdue' }
  | { type: 'locked' }
  | { type: 'gate'; gateId: number; dimension: string; open: boolean }
  | { type: 'hold'; ref: number; resourceId: number }
  | { type: 'capacity'; workCenterId: number; blockers: number[] }
  | { type: 'none' };

/** [slot, resourceId, units] */
export type Booking = [Slot, number, number];

export interface ActResult {
  id: number;
  start: Slot;
  finish: Slot;
  es: Slot;
  bookings: Booking[];
  driver: Driver;
  capacityWaitSlots: number;
  weekend: boolean;
  flags: string[];
  confidence: Confidence;
  /** Gates (own or inherited through predecessors) that make the date conditional or open. */
  confidenceGates: number[];
}

export interface Violation {
  activityId: number;
  type: 'capacity' | 'dependency' | 'lock_broken' | 'overload' | 'readiness';
  message: string;
}

export interface Overload {
  workCenterId: number;
  slot: Slot;
  load: number;
  capacity: number;
  activities: number[];
}

export interface MilestoneResult {
  projectId: number;
  shipmentId: number | null;
  visitId?: number | null;
  type: MilestoneType;
  forecast: Slot | null;
  actual: Slot | null;
  drivingActivityId: number | null;
  complete: boolean;
  confidence: Confidence;
  done: number;
  total: number;
}

export interface ScheduleResult {
  acts: Map<number, ActResult>;
  overloads: Overload[];
  violations: Violation[];
  milestones: MilestoneResult[];
  critical: Set<number>;
  ledger: LedgerView;
}

export interface LedgerView {
  cell(wcId: number, slot: Slot): { load: number; acts: number[] } | undefined;
  capacityAt(wcId: number, slot: Slot): number;
  entries(): IterableIterator<[number, Map<Slot, { load: number; acts: number[] }>]>;
}
