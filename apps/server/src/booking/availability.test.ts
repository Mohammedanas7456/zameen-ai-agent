import { describe, it, expect } from 'vitest';
import type { AvailabilityDay } from '@zameen/shared';
import { readBookingConfig } from './config.js';
import {
  addDays,
  isSlotFree,
  isoFromMs,
  offsetToMs,
  slotsForWindow,
  weekdayOf,
} from './availability.js';

/** Wednesday 2026-09-16, 11:00 in Karachi. Every expectation below is
 *  anchored to this instant; the window it produces runs Thu 2026-09-17
 *  through Wed 2026-09-30, with Sundays on the 20th and the 27th. */
const NOW = Date.parse('2026-09-16T06:00:00Z');
const CFG = readBookingConfig({});

const busy = (startIso: string, endIso: string) => ({
  start: Date.parse(startIso),
  end: Date.parse(endIso),
});
const on = (days: AvailabilityDay[], date: string) => days.find((d) => d.date === date)!;
/** Available slot start times as 'HH:MM', read straight off the ISO string. */
const freeTimes = (d: AvailabilityDay) =>
  d.slots.filter((s) => s.available).map((s) => s.startIso.slice(11, 16));

describe('offsetToMs', () => {
  it('converts a positive offset', () => {
    expect(offsetToMs('+05:00')).toBe(5 * 3600 * 1000);
  });

  it('converts a negative offset', () => {
    expect(offsetToMs('-03:30')).toBe(-(3 * 3600 + 30 * 60) * 1000);
  });

  it('rejects an unparseable offset rather than silently returning zero', () => {
    expect(() => offsetToMs('PKT')).toThrow(/Unsupported timezone offset/);
  });
});

describe('date helpers', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
  });

  it('reads the weekday of a date string, 0 = Sunday', () => {
    expect(weekdayOf('2026-09-20')).toBe(0);
    expect(weekdayOf('2026-09-17')).toBe(4);
  });

  it('renders an instant as Karachi wall-clock time with an explicit offset', () => {
    expect(isoFromMs(Date.parse('2026-09-17T10:00:00Z'), '+05:00')).toBe(
      '2026-09-17T15:00:00+05:00',
    );
  });
});

describe('isSlotFree', () => {
  const slot = { start: Date.parse('2026-09-17T15:00:00+05:00'), end: Date.parse('2026-09-17T15:45:00+05:00') };

  it('is free against an empty calendar', () => {
    expect(isSlotFree(slot.start, slot.end, [])).toBe(true);
  });

  it('is blocked by an event that overlaps it', () => {
    expect(isSlotFree(slot.start, slot.end, [busy('2026-09-17T15:30:00+05:00', '2026-09-17T16:30:00+05:00')])).toBe(false);
  });

  it('is NOT blocked by an event that ends exactly when it starts', () => {
    expect(isSlotFree(slot.start, slot.end, [busy('2026-09-17T14:00:00+05:00', '2026-09-17T15:00:00+05:00')])).toBe(true);
  });

  it('is NOT blocked by an event that starts exactly when it ends', () => {
    expect(isSlotFree(slot.start, slot.end, [busy('2026-09-17T15:45:00+05:00', '2026-09-17T16:00:00+05:00')])).toBe(true);
  });

  it('is blocked by an event that entirely contains it', () => {
    expect(isSlotFree(slot.start, slot.end, [busy('2026-09-17T09:00:00+05:00', '2026-09-17T20:00:00+05:00')])).toBe(false);
  });
});

describe('slotsForWindow', () => {
  it('starts tomorrow and spans the configured window', () => {
    const days = slotsForWindow(NOW, [], CFG);
    expect(days).toHaveLength(14);
    expect(days[0]!.date).toBe('2026-09-17');
    expect(days[13]!.date).toBe('2026-09-30');
  });

  it('offers eight hourly slots on an open day, 11:00 to 18:00', () => {
    const days = slotsForWindow(NOW, [], CFG);
    expect(freeTimes(on(days, '2026-09-17'))).toEqual([
      '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00',
    ]);
  });

  it('ends the last slot before closing time', () => {
    const days = slotsForWindow(NOW, [], CFG);
    const last = on(days, '2026-09-17').slots.at(-1)!;
    expect(last.startIso).toBe('2026-09-17T18:00:00+05:00');
    expect(last.endIso).toBe('2026-09-17T18:45:00+05:00');
  });

  it('closes Sundays, with no slots at all', () => {
    const days = slotsForWindow(NOW, [], CFG);
    for (const date of ['2026-09-20', '2026-09-27']) {
      expect(on(days, date).open).toBe(false);
      expect(on(days, date).slots).toEqual([]);
      expect(on(days, date).weekday).toBe(0);
    }
  });

  it('lets one long event block every slot it spans', () => {
    const days = slotsForWindow(NOW, [busy('2026-09-17T12:00:00+05:00', '2026-09-17T17:00:00+05:00')], CFG);
    expect(freeTimes(on(days, '2026-09-17'))).toEqual(['11:00', '17:00', '18:00']);
  });

  it('leaves the day fully bookable when an event sits only in the travel buffer', () => {
    const days = slotsForWindow(NOW, [busy('2026-09-17T11:45:00+05:00', '2026-09-17T12:00:00+05:00')], CFG);
    expect(freeTimes(on(days, '2026-09-17'))).toHaveLength(8);
  });

  it('keeps a fully booked day open but offers nothing', () => {
    const days = slotsForWindow(NOW, [busy('2026-09-17T09:00:00+05:00', '2026-09-17T20:00:00+05:00')], CFG);
    const d = on(days, '2026-09-17');
    expect(d.open).toBe(true);
    expect(d.slots).toHaveLength(8);
    expect(freeTimes(d)).toEqual([]);
  });

  it('does not leak busy time from one day into another', () => {
    const days = slotsForWindow(NOW, [busy('2026-09-17T09:00:00+05:00', '2026-09-17T20:00:00+05:00')], CFG);
    expect(freeTimes(on(days, '2026-09-18'))).toHaveLength(8);
  });

  it('excludes slots already past when same-day booking is allowed', () => {
    // leadDays 0 puts today in the window; NOW is 11:00, so 11:00 has gone.
    const days = slotsForWindow(NOW, [], { ...CFG, leadDays: 0 });
    expect(days[0]!.date).toBe('2026-09-16');
    expect(freeTimes(days[0]!)).toEqual([
      '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00',
    ]);
  });

  it('honours an alternative slot length and grid', () => {
    const days = slotsForWindow(NOW, [], { ...CFG, dayStartHour: 9, dayEndHour: 11, slotMinutes: 30, gridMinutes: 30 });
    expect(freeTimes(on(days, '2026-09-17'))).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });

  it('opens every day when no weekday is closed', () => {
    const days = slotsForWindow(NOW, [], { ...CFG, closedWeekdays: [] });
    expect(days.every((d) => d.open)).toBe(true);
  });
});
