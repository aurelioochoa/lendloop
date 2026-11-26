import { invalid } from "./auth";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_LOAN_DAYS = 30;

/** Today's calendar date in UTC as YYYY-MM-DD. */
export function todayUtc(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) invalid(`${field} must be YYYY-MM-DD.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    invalid(`${field} is not a real date.`);
  }
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Inclusive ranges [aStart, aEnd] and [bStart, bEnd] overlap. ISO dates sort as strings. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function validateLoanRange(startDate: string, endDate: string, today: string): void {
  assertIsoDate(startDate, "Start date");
  assertIsoDate(endDate, "End date");
  if (startDate < today) invalid("Start date can't be in the past.");
  if (endDate < startDate) invalid("End date must be on or after the start date.");
  if (daysBetween(startDate, endDate) + 1 > MAX_LOAN_DAYS) {
    invalid(`Loans can last at most ${MAX_LOAN_DAYS} days.`);
  }
}
