/**
 * Time model: the plan is expressed in half-day "slots".
 *   slot = dayNumber * 2 + half   (half: 0 = AM, 1 = PM)
 * dayNumber counts calendar days since 1970-01-01 (UTC date arithmetic, no time zone).
 * Activities occupy [start, finish) — finish is exclusive.
 */
export type Slot = number;

export const SLOTS_PER_DAY = 2;

export function dayOf(slot: Slot): number {
  return Math.floor(slot / 2);
}

export function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayToIso(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

export function slotOf(isoDate: string, half: 0 | 1 = 0): Slot {
  return dayNumber(isoDate) * 2 + half;
}

/** End of the given calendar day (exclusive slot). */
export function endOfDaySlot(isoDate: string): Slot {
  return (dayNumber(isoDate) + 1) * 2;
}

export function slotToLabel(slot: Slot | null | undefined): string {
  if (slot === null || slot === undefined) return '';
  return `${dayToIso(dayOf(slot))} ${slot % 2 === 0 ? 'AM' : 'PM'}`;
}

/** Human label for an exclusive finish slot: the last occupied half-day. */
export function finishLabel(finish: Slot | null | undefined): string {
  if (finish === null || finish === undefined) return '';
  return slotToLabel(finish - 1);
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** Current slot in the given IANA time zone. */
export function nowSlot(date: Date = new Date(), timeZone = 'Europe/Rome'): Slot {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = dayNumber(`${get('year')}-${get('month')}-${get('day')}`);
  return day * 2 + (Number(get('hour')) >= 12 ? 1 : 0);
}

export interface CalendarDef {
  id: number;
  workingWeekdays: number[];
  holidays: number[]; // day numbers
}

export class CalendarSet {
  private cals = new Map<number, { weekdays: Set<number>; holidays: Set<number> }>();

  constructor(defs: CalendarDef[], readonly defaultId: number) {
    for (const d of defs) {
      this.cals.set(d.id, { weekdays: new Set(d.workingWeekdays), holidays: new Set(d.holidays) });
    }
  }

  has(id: number) {
    return this.cals.has(id);
  }

  isWorkingDay(calendarId: number | null | undefined, day: number): boolean {
    const c = this.cals.get(calendarId ?? this.defaultId) ?? this.cals.get(this.defaultId);
    if (!c) return weekday(day) >= 1 && weekday(day) <= 5;
    return c.weekdays.has(weekday(day)) && !c.holidays.has(day);
  }

  isHoliday(calendarId: number, day: number): boolean {
    return this.cals.get(calendarId)?.holidays.has(day) ?? false;
  }

  /** Signed number of working days between two slots on a calendar (half-day precision). */
  workingDaysBetween(a: Slot, b: Slot, calendarId?: number): number {
    if (a === b) return 0;
    const [lo, hi, sign] = a < b ? [a, b, 1] : [b, a, -1];
    let n = 0;
    for (let s = lo; s < hi; s++) if (this.isWorkingDay(calendarId ?? this.defaultId, dayOf(s))) n++;
    return (sign * n) / 2;
  }

  /** Advance `slots` working slots from `start`; returns exclusive finish. */
  addWorkingSlots(start: Slot, slots: number, calendarId?: number): Slot {
    let t = start;
    let left = slots;
    let guard = 0;
    while (left > 0 && guard++ < 5000) {
      if (this.isWorkingDay(calendarId ?? this.defaultId, dayOf(t))) left--;
      t++;
    }
    return t;
  }
}
