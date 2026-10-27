/** Mirror of the server's half-day slot model: slot = days since 1970-01-01 * 2 + (0 AM | 1 PM). */
export const dayOf = (s: number) => Math.floor(s / 2);
export const dayToIso = (d: number) => new Date(d * 86400000).toISOString().slice(0, 10);
export const isoToDay = (iso: string) => Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / 86400000);
export const weekday = (d: number) => (((d + 4) % 7) + 7) % 7;
export function slotLabel(s?: number | null) {
  if (s === null || s === undefined) return '—';
  return `${fmtDay(dayOf(s))} ${s % 2 ? 'PM' : 'AM'}`;
}
export function finishLabel(f?: number | null) {
  if (f === null || f === undefined) return '—';
  return slotLabel(f - 1);
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(d: number, withYear = false) {
  const dt = new Date(d * 86400000);
  return `${DOW[dt.getUTCDay()]} ${dt.getUTCDate()} ${MON[dt.getUTCMonth()]}${withYear ? ' ' + dt.getUTCFullYear() : ''}`;
}
export function fmtIso(iso?: string | null) {
  if (!iso) return '—';
  return fmtDay(isoToDay(iso), true);
}
export function monthLabel(d: number) {
  const dt = new Date(d * 86400000);
  return `${MON[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
export function weekNo(d: number) {
  const dt = new Date(d * 86400000);
  const t = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
export const fmtTs = (ts?: string | null) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');
