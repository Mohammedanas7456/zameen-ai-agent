import { describe, it, expect } from 'vitest';
import { dayLabel, slotLabel, slotRangeLabel } from './booking.js';

describe('slotLabel', () => {
  // Read straight off the ISO string rather than via Date, so a buyer in
  // London sees the Karachi time the estate agent will actually be there.
  it('renders an afternoon slot in 12-hour time', () => {
    expect(slotLabel('2026-09-17T15:00:00+05:00')).toBe('3:00 PM');
  });

  it('renders a morning slot', () => {
    expect(slotLabel('2026-09-17T11:00:00+05:00')).toBe('11:00 AM');
  });

  it('renders noon and midnight without a zero hour', () => {
    expect(slotLabel('2026-09-17T12:00:00+05:00')).toBe('12:00 PM');
    expect(slotLabel('2026-09-17T00:30:00+05:00')).toBe('12:30 AM');
  });

  it('keeps the minutes', () => {
    expect(slotLabel('2026-09-17T18:45:00+05:00')).toBe('6:45 PM');
  });
});

describe('dayLabel', () => {
  it('renders a short weekday, day and month', () => {
    expect(dayLabel('2026-09-17')).toBe('Thu 17 Sep');
    expect(dayLabel('2026-09-20')).toBe('Sun 20 Sep');
    expect(dayLabel('2026-10-01')).toBe('Thu 1 Oct');
  });
});

describe('slotRangeLabel', () => {
  it('reads as one line a person can check against their own diary', () => {
    expect(slotRangeLabel('2026-09-17T15:00:00+05:00', '2026-09-17T15:45:00+05:00'))
      .toBe('Thu 17 Sep, 3:00 PM – 3:45 PM');
  });
});
