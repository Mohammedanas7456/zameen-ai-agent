/** Business rules for viewings. Every value is env-overridable; the defaults
 *  describe a Karachi estate agent's working week. */
export interface BookingConfig {
  /** Fixed offset, e.g. '+05:00'. Pakistan has had no DST since 2009. */
  tzOffset: string;
  dayStartHour: number;
  dayEndHour: number;
  /** How long one viewing lasts. */
  slotMinutes: number;
  /** How far apart slots start. The gap to slotMinutes is the travel buffer. */
  gridMinutes: number;
  /** Days of notice before the first bookable day. 1 = from tomorrow. */
  leadDays: number;
  windowDays: number;
  /** 0 = Sunday, matching Date#getUTCDay. */
  closedWeekdays: number[];
  calendarId: string;
}

type Env = Record<string, string | undefined>;

function intOr(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function textOr(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** An explicitly empty list means "open every day", so absence and emptiness
 *  must be distinguished — `?? fallback` would collapse them. */
function weekdaysOr(env: Env, name: string, fallback: number[]): number[] {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function readBookingConfig(env: Env): BookingConfig {
  return {
    tzOffset: textOr(env, 'BOOKING_TZ_OFFSET', '+05:00'),
    dayStartHour: intOr(env, 'BOOKING_DAY_START', 11),
    dayEndHour: intOr(env, 'BOOKING_DAY_END', 19),
    slotMinutes: intOr(env, 'BOOKING_SLOT_MINUTES', 45),
    gridMinutes: intOr(env, 'BOOKING_GRID_MINUTES', 60),
    leadDays: intOr(env, 'BOOKING_LEAD_DAYS', 1),
    windowDays: intOr(env, 'BOOKING_WINDOW_DAYS', 14),
    closedWeekdays: weekdaysOr(env, 'BOOKING_CLOSED_DAYS', [0]),
    calendarId: textOr(env, 'GOOGLE_CALENDAR_ID', 'primary'),
  };
}

export const bookingConfig = readBookingConfig(process.env);
