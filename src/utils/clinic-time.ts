import getEnv from "../config/env";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for real calendar dates ("2027-02-31" is rejected, not rolled over). */
export function isValidCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function tzParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = tzParts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Today's calendar date (YYYY-MM-DD) in the clinic's timezone. */
export function clinicToday(now: Date = new Date()): string {
  const p = tzParts(now, getEnv().CLINIC_TIMEZONE);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The real instant for a slot expressed as clinic-local date + "HH:mm".
 * (Slot times are wall-clock times at the clinic, not UTC.)
 */
export function clinicDateTimeToUtc(dateStr: string, time: string): Date {
  const timeZone = getEnv().CLINIC_TIMEZONE;
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  // Two passes handle offsets that differ around DST transitions
  let guess = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), timeZone);
  guess = wallAsUtc - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** YYYY-MM-DD for a Date that represents a stored calendar date (UTC midnight). */
export function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}
