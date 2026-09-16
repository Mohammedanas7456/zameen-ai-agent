import { describe, it, expect } from 'vitest';
import { readBookingConfig } from './config.js';

describe('readBookingConfig', () => {
  it('uses Karachi business-hours defaults when nothing is set', () => {
    expect(readBookingConfig({})).toEqual({
      tzOffset: '+05:00',
      dayStartHour: 11,
      dayEndHour: 19,
      slotMinutes: 45,
      gridMinutes: 60,
      leadDays: 1,
      windowDays: 14,
      closedWeekdays: [0],
      calendarId: 'primary',
    });
  });

  it('reads overrides from the environment', () => {
    const cfg = readBookingConfig({
      BOOKING_DAY_START: '9',
      BOOKING_DAY_END: '17',
      BOOKING_SLOT_MINUTES: '30',
      BOOKING_WINDOW_DAYS: '7',
      GOOGLE_CALENDAR_ID: 'viewings@example.com',
    });
    expect(cfg.dayStartHour).toBe(9);
    expect(cfg.dayEndHour).toBe(17);
    expect(cfg.slotMinutes).toBe(30);
    expect(cfg.windowDays).toBe(7);
    expect(cfg.calendarId).toBe('viewings@example.com');
  });

  it('parses a comma-separated closed-days list', () => {
    expect(readBookingConfig({ BOOKING_CLOSED_DAYS: '0,5' }).closedWeekdays).toEqual([0, 5]);
  });

  it('treats an explicitly empty closed-days list as open every day', () => {
    expect(readBookingConfig({ BOOKING_CLOSED_DAYS: '' }).closedWeekdays).toEqual([]);
  });

  it('ignores a non-numeric override rather than producing NaN', () => {
    expect(readBookingConfig({ BOOKING_SLOT_MINUTES: 'soon' }).slotMinutes).toBe(45);
  });

  it('drops weekday values outside 0-6', () => {
    expect(readBookingConfig({ BOOKING_CLOSED_DAYS: '0,9,-2,6' }).closedWeekdays).toEqual([0, 6]);
  });

  it('clamps a zero grid or slot size to 1 minute rather than letting the slot loop spin forever', () => {
    const cfg = readBookingConfig({ BOOKING_GRID_MINUTES: '0', BOOKING_SLOT_MINUTES: '0' });
    expect(cfg.gridMinutes).toBe(1);
    expect(cfg.slotMinutes).toBe(1);
  });

  it('clamps a negative grid or slot size to 1 minute', () => {
    const cfg = readBookingConfig({ BOOKING_GRID_MINUTES: '-30', BOOKING_SLOT_MINUTES: '-5' });
    expect(cfg.gridMinutes).toBe(1);
    expect(cfg.slotMinutes).toBe(1);
  });

  it('clamps an excessive booking window to a sane ceiling', () => {
    expect(readBookingConfig({ BOOKING_WINDOW_DAYS: '9999' }).windowDays).toBe(60);
  });
});
