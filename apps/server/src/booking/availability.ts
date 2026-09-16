import type { AvailabilityDay, Slot } from '@zameen/shared';
import type { BookingConfig } from './config.js';

/** A window the estate agent is not free, in epoch milliseconds. */
export interface BusyInterval {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;

export function offsetToMs(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!match) throw new Error(`Unsupported timezone offset: ${offset}`);
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3600 + Number(match[3]) * 60) * 1000;
}

/**
 * The calendar date at a fixed offset, for an instant.
 *
 * Shifting the instant and then reading UTC fields is what lets this work
 * without a timezone library — and it is only sound because Pakistan has had
 * no DST since 2009, so the offset is genuinely constant.
 */
export function pktDate(ms: number, offsetMs: number): string {
  return new Date(ms + offsetMs).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday, matching Date#getUTCDay. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Render an instant as wall-clock time with the offset spelled out, so the
 *  browser can display it without knowing anything about Karachi. */
export function isoFromMs(ms: number, offset: string): string {
  return new Date(ms + offsetToMs(offset)).toISOString().slice(0, 19) + offset;
}

/**
 * Strict inequalities on both sides, deliberately: an event ending at exactly
 * 15:00 must not block the 15:00 slot, and an event starting at 15:45 must not
 * block the slot that ends then.
 */
export function isSlotFree(start: number, end: number, busy: BusyInterval[]): boolean {
  return !busy.some((interval) => start < interval.end && interval.start < end);
}

function hhmm(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * The whole bookable window, one entry per day, each slot flagged free or not.
 *
 * `now` and `busy` are arguments rather than ambient state, which is what makes
 * every scheduling rule testable without a clock or a network.
 */
export function slotsForWindow(
  now: number,
  busy: BusyInterval[],
  cfg: BookingConfig,
): AvailabilityDay[] {
  const today = pktDate(now, offsetToMs(cfg.tzOffset));
  const lastStart = cfg.dayEndHour * 60 - cfg.slotMinutes;
  const days: AvailabilityDay[] = [];

  for (let i = 0; i < cfg.windowDays; i += 1) {
    const date = addDays(today, cfg.leadDays + i);
    const weekday = weekdayOf(date);
    const open = !cfg.closedWeekdays.includes(weekday);
    const slots: Slot[] = [];

    if (open) {
      for (let m = cfg.dayStartHour * 60; m <= lastStart; m += cfg.gridMinutes) {
        const start = Date.parse(`${date}T${hhmm(m)}:00${cfg.tzOffset}`);
        const end = start + cfg.slotMinutes * 60_000;
        slots.push({
          startIso: isoFromMs(start, cfg.tzOffset),
          endIso: isoFromMs(end, cfg.tzOffset),
          available: start > now && isSlotFree(start, end, busy),
        });
      }
    }

    days.push({ date, weekday, open, slots });
  }

  return days;
}
