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

export interface WorkCenterDef {
  id: number;
  code: string;
  name: string;
  /** Effective capacity units available per half-day slot (e.g. 1.5 for EOL testing). */
  capacity: number;
  /** Maximum number of activities that may run simultaneously. */
  maxConcurrent: number;
  /** Minimum share of one system's work an activity must receive per slot to be allowed to run. */
  minRate: number;
  calendarId: number | null;
}

/** Authorized work on an otherwise non-working day, for a work center or one activity. */
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
}

export interface Pred {
  id: number;
  lag: number;
}

export interface ActivityDef {
  id: number;
  projectId: number;
  unitId: number | null;
  shipmentId: number | null;
  workCenterId: number | null;
  calendarId: number | null;
  routeId: number | null;
  kind: 'work' | 'transport';
  name: string;
  seq: number;
  unitSeq: number;
  milestoneTag: MilestoneTag;
  durationSlots: number;
  maxRate: number;
  pctComplete: number;
  status: ActivityStatus;
  actualStart: Slot | null;
  actualFinish: Slot | null;
  approvedStart: Slot | null;
  approvedFinish: Slot | null;
  /** User-reported expected completion (reported delay). */
  expectedFinish: Slot | null;
  locked: boolean;
  preds: Pred[];
}

export interface PlanState {
  now: Slot;
  calendars: CalendarDef[];
  defaultCalendarId: number;
  workCenters: WorkCenterDef[];
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
  | { type: 'capacity'; workCenterId: number; blockers: number[] }
  | { type: 'none' };

export interface ActResult {
  id: number;
  start: Slot;
  finish: Slot;
  es: Slot;
  bookings: [Slot, number][];
  driver: Driver;
  capacityWaitSlots: number;
  weekend: boolean;
  flags: string[];
}

export interface Violation {
  activityId: number;
  type: 'capacity' | 'dependency' | 'lock_broken' | 'overload';
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
  type: MilestoneType;
  forecast: Slot | null;
  actual: Slot | null;
  drivingActivityId: number | null;
  complete: boolean;
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
