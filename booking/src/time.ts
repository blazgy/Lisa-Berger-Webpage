/** Time helpers. The practice operates in Europe/Vienna; storage is UTC epoch ms. */

export const TZ = "Europe/Vienna";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function viennaParts(utcMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of partsFormatter.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of Vienna local time from UTC (ms) at the given instant. */
function offsetMs(utcMs: number): number {
  const p = viennaParts(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Convert a Vienna wall-clock date ("YYYY-MM-DD") and time ("HH:MM") to UTC epoch ms. */
export function viennaToUtc(date: string, time: string): number {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) throw new Error("Invalid date/time");
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(naive).getUTCDate() !== d) throw new Error("Invalid calendar date");
  // Two passes handle the DST transitions correctly.
  let guess = naive - offsetMs(naive);
  guess = naive - offsetMs(guess);
  return guess;
}

/** Vienna local calendar date ("YYYY-MM-DD") of an instant. */
export function viennaDate(utcMs: number): string {
  const p = viennaParts(utcMs);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Vienna local time ("HH:MM") of an instant. */
export function viennaTime(utcMs: number): string {
  const p = viennaParts(utcMs);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date string. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Add whole days to a calendar date string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week containing the given date. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

const longDate = new Intl.DateTimeFormat("de-AT", {
  timeZone: TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** e.g. "Dienstag, 12. Jänner 2027, 10:00 Uhr" */
export function formatViennaLong(utcMs: number): string {
  return `${longDate.format(new Date(utcMs))}, ${viennaTime(utcMs)} Uhr`;
}
