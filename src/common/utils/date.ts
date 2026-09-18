import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);

export { dayjs };

export function toUtcIso(value: dayjs.ConfigType): string {
  return dayjs(value).toISOString();
}

/** Canonical date-only serialization (UTC calendar day, YYYY-MM-DD). */
export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}

export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

/** True when the expiry instant is strictly in the past. */
export function isExpired(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() < now;
}
