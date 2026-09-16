# Viewing Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a buyer book a 1-on-1 property viewing from a listing card, into the estate agent's Google Calendar, with their name, email and phone on the event and an invite emailed to them.

**Architecture:** No datastore is added. Google Calendar is the system of record for bookings; the estate agent's refresh token is produced once by a local CLI and held in an env var; buyer identity is an HMAC-signed cookie. Google is reached over plain `fetch` against four REST endpoints. All scheduling logic lives in pure functions that take `now` and `busy` as arguments, so it is testable without a network or a clock.

**Tech Stack:** Node 20 + TypeScript + Express 4 (server), React 18 + Vite + Tailwind v4 (web), Vitest, Google Calendar API v3, Google OAuth 2.0.

**Spec:** `docs/superpowers/specs/2026-09-16-viewing-booking-design.md`

## Global Constraints

- **No new runtime dependencies.** Google is called with `fetch`; do not add `googleapis`, `google-auth-library`, `cookie-parser`, `jsonwebtoken`, or a timezone library. `node:crypto` and `node:http` cover everything needed.
- **No React testing stack.** Vitest is `environment: 'node'` and `include` matches only `**/*.test.ts`. Do not add jsdom or @testing-library, and do not change either of those two settings. Pure helpers get unit tests; components are verified in the browser.
- **`config.ts` throws at import time** without `VECTARA_API_KEY`, and reads every Google value once. Any test that reaches it must set the environment first and then `await import(...)` — a static import would hoist above the assignment.
- **Pakistan is UTC+5 all year.** Never build a timestamp from the server's local clock. Every wall-clock time is written with a literal `+05:00` offset.
- **Every Google env var is optional.** `apps/server/src/config.ts` must keep booting with none of them set; only `VECTARA_API_KEY` stays `required()`.
- **The client is never trusted.** The listing is re-fetched from the corpus by id, the slot is re-checked against the live calendar, and buyer fields are re-validated even when they came from the signed cookie.
- **Tests are co-located** as `*.test.ts` beside the file under test, matching `criteria.test.ts`, `filter.test.ts`, `floor.test.ts`.
- **Run tests with** `npm test` (all) or `npx vitest run <path>` (one file). `npm run typecheck` must stay clean.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/booking.ts` | Types crossing the server/web boundary |
| `apps/server/src/booking/config.ts` | Business-hours config, parsed from env |
| `apps/server/src/booking/availability.ts` | **Pure.** Busy intervals + config + now → slot grid |
| `apps/server/src/booking/event.ts` | **Pure.** Listing + buyer + slot → Google event body |
| `apps/server/src/booking/calendar.ts` | Thin `fetch` wrapper: freeBusy, events.insert |
| `apps/server/src/google/oauth.ts` | **Pure-ish.** Auth URLs, code exchange, token refresh, userinfo |
| `apps/server/src/google/tokens.ts` | Refresh-token source (env or file) + access-token cache |
| `apps/server/src/buyer.ts` | **Pure.** Validation, normalisation, signed cookies |
| `apps/server/src/routes/auth.ts` | `/api/me`, `/api/auth/*` |
| `apps/server/src/routes/booking.ts` | `/api/availability`, `/api/bookings` |
| `apps/server/src/connect-calendar.ts` | One-time CLI that mints the refresh token |
| `apps/web/src/lib/booking.ts` | API client + pure date/time label helpers |
| `apps/web/src/components/AccountChip.tsx` | Header sign-in / signed-in chip |
| `apps/web/src/components/BookingModal.tsx` | Three-step booking form |

---

### Task 1: Shared types and booking configuration

**Files:**
- Create: `packages/shared/src/booking.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/booking/config.ts`
- Test: `apps/server/src/booking/config.test.ts`

**Interfaces:**
- Consumes: `Purpose` from `packages/shared/src/types.ts`.
- Produces: `BuyerDetails`, `Slot`, `AvailabilityDay`, `Availability`, `BookingRequest`, `Booking` (shared); `BookingConfig`, `readBookingConfig(env)`, `bookingConfig` (server).

- [ ] **Step 1: Write the shared types**

Create `packages/shared/src/booking.ts`:

```ts
import type { Purpose } from './types.js';

/** The three fields that identify a buyer on a viewing. */
export interface BuyerDetails {
  name: string;
  email: string;
  phone: string;
}

/** One bookable slot. Times carry an explicit +05:00 offset, never local time. */
export interface Slot {
  startIso: string;
  endIso: string;
  available: boolean;
}

export interface AvailabilityDay {
  /** YYYY-MM-DD as it reads in Karachi. */
  date: string;
  /** 0 = Sunday, matching Date#getUTCDay. */
  weekday: number;
  /** False on a closed day; `slots` is then empty. */
  open: boolean;
  slots: Slot[];
}

export interface Availability {
  tz: string;
  slotMinutes: number;
  days: AvailabilityDay[];
}

/** What the browser posts. The listing itself is deliberately NOT included —
 *  the server re-reads it from the corpus so the client cannot dictate what
 *  lands in the estate agent's calendar. */
export interface BookingRequest {
  purpose: Purpose;
  externalId: string;
  startIso: string;
  buyer: BuyerDetails;
}

export interface Booking {
  eventId: string;
  htmlLink: string;
  startIso: string;
  endIso: string;
  listingTitle: string;
  buyerEmail: string;
}
```

Add to `packages/shared/src/index.ts`, after the existing exports:

```ts
export * from './booking.js';
```

- [ ] **Step 2: Write the failing config test**

Create `apps/server/src/booking/config.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/booking/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 4: Implement the config**

Create `apps/server/src/booking/config.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/booking/config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/shared/src/booking.ts packages/shared/src/index.ts apps/server/src/booking/
git commit -m "Add booking types and business-hours configuration"
```

---

### Task 2: Availability engine

The scheduling brain, and the only place timezone arithmetic happens. Entirely pure: `now` and `busy` are arguments, so there is no clock and no network in any test.

**Files:**
- Create: `apps/server/src/booking/availability.ts`
- Test: `apps/server/src/booking/availability.test.ts`

**Interfaces:**
- Consumes: `BookingConfig`, `readBookingConfig` (Task 1); `AvailabilityDay`, `Slot` from `@zameen/shared`.
- Produces:
  - `interface BusyInterval { start: number; end: number }` — epoch ms
  - `offsetToMs(offset: string): number`
  - `addDays(date: string, n: number): string`
  - `weekdayOf(date: string): number`
  - `isoFromMs(ms: number, offset: string): string`
  - `isSlotFree(start: number, end: number, busy: BusyInterval[]): boolean`
  - `slotsForWindow(now: number, busy: BusyInterval[], cfg: BookingConfig): AvailabilityDay[]`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/booking/availability.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/booking/availability.test.ts`
Expected: FAIL — cannot resolve `./availability.js`.

- [ ] **Step 3: Implement the engine**

Create `apps/server/src/booking/availability.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/booking/availability.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/booking/availability.ts apps/server/src/booking/availability.test.ts
git commit -m "Add the pure availability engine"
```

---

### Task 3: Buyer validation and signed cookies

**Files:**
- Create: `apps/server/src/buyer.ts`
- Test: `apps/server/src/buyer.test.ts`

**Interfaces:**
- Consumes: `BuyerDetails` from `@zameen/shared`.
- Produces:
  - `BUYER_COOKIE = 'zameen_buyer'`, `STATE_COOKIE = 'zameen_oauth_state'`
  - `interface StoredBuyer extends BuyerDetails { via: 'google' | 'manual' }`
  - `type ValidationResult = { ok: true; buyer: BuyerDetails } | { ok: false; field: 'name'|'email'|'phone'; message: string }`
  - `sanitizeText(value: unknown, max: number): string`
  - `isValidEmail(email: string): boolean`
  - `normalizePhone(raw: unknown): string | null`
  - `validateBuyer(input: unknown): ValidationResult`
  - `sign(payload: object, secret: string): string`
  - `verify<T>(token: string | undefined, secret: string): T | null`
  - `parseCookies(header: string | undefined): Record<string, string>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/buyer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  normalizePhone,
  parseCookies,
  sanitizeText,
  sign,
  validateBuyer,
  verify,
  type StoredBuyer,
} from './buyer.js';

const SECRET = 'test-secret-do-not-use';

describe('sanitizeText', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeText('  Asad   Khan  ', 80)).toBe('Asad Khan');
  });

  it('strips newlines so a buyer cannot forge extra lines in the event description', () => {
    expect(sanitizeText('Asad\nBuyer: Someone Else\nPhone: 000', 80))
      .toBe('Asad Buyer: Someone Else Phone: 000');
  });

  it('strips other control characters', () => {
    expect(sanitizeText('Asad\u0007Khan', 80)).toBe('Asad Khan');
  });

  it('clamps to the maximum length', () => {
    expect(sanitizeText('x'.repeat(200), 80)).toHaveLength(80);
  });

  it('returns empty for a non-string', () => {
    expect(sanitizeText(42, 80)).toBe('');
    expect(sanitizeText(null, 80)).toBe('');
  });
});

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('asad@example.com')).toBe(true);
  });

  it('rejects addresses without a dotted domain or with spaces', () => {
    expect(isValidEmail('asad@example')).toBe(false);
    expect(isValidEmail('asad example@x.com')).toBe(false);
    expect(isValidEmail('@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('converts a Pakistani mobile in local form to E.164', () => {
    expect(normalizePhone('0300 1234567')).toBe('+923001234567');
  });

  it('converts a Karachi landline in local form', () => {
    expect(normalizePhone('021-34567890')).toBe('+922134567890');
  });

  it('keeps an already-international number', () => {
    expect(normalizePhone('+92 300 1234567')).toBe('+923001234567');
  });

  it('accepts an overseas number, since overseas buyers are common on Zameen', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
  });

  it('adds the missing plus to a bare country-code number', () => {
    expect(normalizePhone('923001234567')).toBe('+923001234567');
  });

  it('rejects anything too short, too long, or not a number', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456789')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('validateBuyer', () => {
  it('accepts and normalises a complete buyer', () => {
    const result = validateBuyer({ name: ' Asad Khan ', email: 'Asad@Example.com', phone: '0300 1234567' });
    expect(result).toEqual({
      ok: true,
      buyer: { name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567' },
    });
  });

  it('reports which field failed, so the modal can highlight it', () => {
    expect(validateBuyer({ name: 'A', email: 'a@b.com', phone: '03001234567' }))
      .toMatchObject({ ok: false, field: 'name' });
    expect(validateBuyer({ name: 'Asad Khan', email: 'nope', phone: '03001234567' }))
      .toMatchObject({ ok: false, field: 'email' });
    expect(validateBuyer({ name: 'Asad Khan', email: 'a@b.com', phone: 'nope' }))
      .toMatchObject({ ok: false, field: 'phone' });
  });

  it('rejects a missing body outright', () => {
    expect(validateBuyer(undefined)).toMatchObject({ ok: false, field: 'name' });
  });
});

describe('sign / verify', () => {
  const buyer: StoredBuyer = {
    name: 'Asad Khan',
    email: 'asad@example.com',
    phone: '+923001234567',
    via: 'google',
  };

  it('round-trips a payload', () => {
    expect(verify<StoredBuyer>(sign(buyer, SECRET), SECRET)).toEqual(buyer);
  });

  it('rejects a payload whose body was edited', () => {
    const mac = sign(buyer, SECRET).split('.')[1];
    const forged = Buffer.from(
      JSON.stringify({ ...buyer, email: 'attacker@evil.com' }),
    ).toString('base64url');
    expect(verify(`${forged}.${mac}`, SECRET)).toBeNull();
  });

  it('rejects a signature made with a different secret', () => {
    expect(verify(sign(buyer, 'other-secret'), SECRET)).toBeNull();
  });

  it('rejects a truncated signature without throwing', () => {
    const body = sign(buyer, SECRET).split('.')[0];
    expect(verify(`${body}.abc`, SECRET)).toBeNull();
  });

  it('rejects malformed and missing tokens', () => {
    expect(verify('no-dot-here', SECRET)).toBeNull();
    expect(verify(undefined, SECRET)).toBeNull();
    expect(verify('', SECRET)).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses several cookies', () => {
    expect(parseCookies('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('url-decodes values', () => {
    expect(parseCookies('n=Asad%20Khan')).toEqual({ n: 'Asad Khan' });
  });

  it('keeps a malformed percent-encoding verbatim instead of throwing', () => {
    expect(parseCookies('n=100%')).toEqual({ n: '100%' });
  });

  it('returns empty for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/buyer.test.ts`
Expected: FAIL — cannot resolve `./buyer.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/buyer.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BuyerDetails } from '@zameen/shared';

export const BUYER_COOKIE = 'zameen_buyer';
export const STATE_COOKIE = 'zameen_oauth_state';

export interface StoredBuyer extends BuyerDetails {
  via: 'google' | 'manual';
}

export type ValidationResult =
  | { ok: true; buyer: BuyerDetails }
  | { ok: false; field: 'name' | 'email' | 'phone'; message: string };

/**
 * Flatten a free-text field to a single safe line.
 *
 * Control characters are stripped rather than escaped because these values are
 * interpolated into the calendar event description: without this, a buyer could
 * type a newline and forge convincing extra lines for the estate agent to read.
 */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Normalise a phone number to E.164, or reject it.
 *
 * Pakistani local form (leading 0) becomes +92. A number that already carries a
 * country code is kept as-is, because overseas Pakistanis are a real share of
 * Zameen's buyers and must not be locked out.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s\-().]/g, '');
  if (/^0\d{10}$/.test(cleaned)) return `+92${cleaned.slice(1)}`;
  if (/^92\d{9,11}$/.test(cleaned)) return `+${cleaned}`;
  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
  return null;
}

export function validateBuyer(input: unknown): ValidationResult {
  const raw = (input ?? {}) as Record<string, unknown>;

  const name = sanitizeText(raw['name'], 80);
  if (name.length < 2) {
    return { ok: false, field: 'name', message: 'Please enter your full name.' };
  }

  const email = sanitizeText(raw['email'], 200).toLowerCase();
  if (!isValidEmail(email)) {
    return { ok: false, field: 'email', message: 'Please enter a valid email address.' };
  }

  const phone = normalizePhone(raw['phone']);
  if (!phone) {
    return {
      ok: false,
      field: 'phone',
      message: 'Please enter a valid phone number, for example 0300 1234567.',
    };
  }

  return { ok: true, buyer: { name, email, phone } };
}

/** `base64url(json).base64url(hmac)`. No JWT library, no claims, no expiry
 *  beyond the cookie's own Max-Age. */
export function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));

  // timingSafeEqual throws on a length mismatch, so guard before comparing.
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** Express has res.cookie() but no reader without cookie-parser, and one small
 *  loop is cheaper than the dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/buyer.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/buyer.ts apps/server/src/buyer.test.ts
git commit -m "Add buyer validation and HMAC-signed identity cookies"
```

---

### Task 4: Google OAuth helpers

**Files:**
- Create: `apps/server/src/google/oauth.ts`
- Test: `apps/server/src/google/oauth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `BUYER_SCOPES: string[]`, `AGENT_SCOPES: string[]`
  - `class CalendarDisconnectedError extends Error`
  - `class GoogleError extends Error { status: number }`
  - `authUrl(o: { clientId: string; redirectUri: string; scopes: string[]; state: string; offline: boolean }): string`
  - `exchangeCode(o: { code, clientId, clientSecret, redirectUri }): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }>`
  - `refreshAccessToken(o: { refreshToken, clientId, clientSecret }): Promise<{ accessToken: string; expiresIn: number }>`
  - `fetchUserInfo(accessToken: string): Promise<{ name: string; email: string }>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/google/oauth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_SCOPES,
  BUYER_SCOPES,
  CalendarDisconnectedError,
  authUrl,
  exchangeCode,
  fetchUserInfo,
  refreshAccessToken,
} from './oauth.js';

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with one canned response. Returns the spy so the call can be asserted. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('authUrl', () => {
  it('builds a buyer sign-in URL with only the identity scopes', () => {
    const url = new URL(
      authUrl({
        clientId: 'cid',
        redirectUri: 'http://localhost:5173/api/auth/google/callback',
        scopes: BUYER_SCOPES,
        state: 'nonce123',
        offline: false,
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('nonce123');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/auth/google/callback');
  });

  it('omits offline parameters for the buyer flow, which needs no refresh token', () => {
    const url = new URL(authUrl({ clientId: 'c', redirectUri: 'r', scopes: BUYER_SCOPES, state: 's', offline: false }));
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('forces consent on the estate-agent flow, or Google returns no refresh token on a repeat authorization', () => {
    const url = new URL(authUrl({ clientId: 'c', redirectUri: 'r', scopes: AGENT_SCOPES, state: 's', offline: true }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
  });
});

describe('exchangeCode', () => {
  it('posts form-encoded parameters to the token endpoint', async () => {
    const spy = stubFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 });
    const result = await exchangeCode({ code: 'abc', clientId: 'cid', clientSecret: 'sec', redirectUri: 'uri' });

    expect(result).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3599 });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('abc');
    expect(sent.get('client_secret')).toBe('sec');
  });

  it('reports a null refresh token rather than inventing one', async () => {
    stubFetch({ access_token: 'at', expires_in: 3599 });
    const result = await exchangeCode({ code: 'a', clientId: 'c', clientSecret: 's', redirectUri: 'u' });
    expect(result.refreshToken).toBeNull();
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for an access token', async () => {
    const spy = stubFetch({ access_token: 'fresh', expires_in: 3599 });
    const result = await refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's' });

    expect(result).toEqual({ accessToken: 'fresh', expiresIn: 3599 });
    const sent = new URLSearchParams((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
  });

  it('raises CalendarDisconnectedError on invalid_grant, which is what a dead token looks like', async () => {
    stubFetch({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { ok: false, status: 400 });
    await expect(refreshAccessToken({ refreshToken: 'dead', clientId: 'c', clientSecret: 's' }))
      .rejects.toBeInstanceOf(CalendarDisconnectedError);
  });

  it('raises a plain GoogleError for other failures, so they are not mistaken for a dead token', async () => {
    stubFetch({ error: 'internal_failure' }, { ok: false, status: 500 });
    const err = await refreshAccessToken({ refreshToken: 'rt', clientId: 'c', clientSecret: 's' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CalendarDisconnectedError);
    expect(err.status).toBe(500);
  });
});

describe('fetchUserInfo', () => {
  it('reads the name and email from the userinfo endpoint', async () => {
    const spy = stubFetch({ sub: '1', name: 'Asad Khan', email: 'asad@example.com', email_verified: true });
    await expect(fetchUserInfo('at')).resolves.toEqual({ name: 'Asad Khan', email: 'asad@example.com' });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/oauth2/v3/userinfo');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer at');
  });

  it('falls back to an empty name when Google supplies none', async () => {
    stubFetch({ sub: '1', email: 'asad@example.com' });
    await expect(fetchUserInfo('at')).resolves.toEqual({ name: '', email: 'asad@example.com' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/google/oauth.test.ts`
Expected: FAIL — cannot resolve `./oauth.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/google/oauth.ts`:

```ts
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Identity only. These are non-sensitive, so buyers never meet the
 *  "Google hasn't verified this app" screen. */
export const BUYER_SCOPES = ['openid', 'email', 'profile'];

/** The estate agent's one-time connection. `calendar.events` is a sensitive
 *  scope, which is why only one person ever runs this flow. */
export const AGENT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
];

/** The refresh token is gone — revoked, or expired after 7 days because the
 *  OAuth consent screen is still in Testing status. Distinct from a transient
 *  Google failure because the fix is different: reconnect, don't retry. */
export class CalendarDisconnectedError extends Error {
  constructor(message = 'The estate agent calendar is not connected.') {
    super(message);
    this.name = 'CalendarDisconnectedError';
  }
}

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GoogleError';
  }
}

export function authUrl(o: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  offline: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    state: o.state,
  });

  // Without BOTH of these, a *repeat* authorization of an already-approved
  // client returns no refresh_token at all and the connect script silently
  // produces nothing usable.
  if (o.offline) {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return data;

  if (data['error'] === 'invalid_grant') throw new CalendarDisconnectedError();
  throw new GoogleError(`Google token request failed: ${String(data['error'] ?? res.status)}`, res.status);
}

export async function exchangeCode(o: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
    }),
  );

  return {
    accessToken: String(data['access_token'] ?? ''),
    refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : null,
    expiresIn: Number(data['expires_in'] ?? 0),
  };
}

export async function refreshAccessToken(o: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: o.refreshToken,
      client_id: o.clientId,
      client_secret: o.clientSecret,
    }),
  );

  return {
    accessToken: String(data['access_token'] ?? ''),
    expiresIn: Number(data['expires_in'] ?? 0),
  };
}

/**
 * Read the signed-in buyer's profile.
 *
 * The userinfo endpoint is used rather than decoding the id_token: the token
 * came straight from Google over TLS, so there is no signature to verify and
 * no JWT library to add.
 */
export async function fetchUserInfo(accessToken: string): Promise<{ name: string; email: string }> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new GoogleError(`Could not read the Google profile (HTTP ${res.status})`, res.status);

  const data = (await res.json()) as Record<string, unknown>;
  return {
    name: typeof data['name'] === 'string' ? data['name'] : '',
    email: typeof data['email'] === 'string' ? data['email'] : '',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/google/oauth.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/google/
git commit -m "Add Google OAuth helpers over plain fetch"
```

---

### Task 5: Server configuration and the access-token cache

**Files:**
- Modify: `apps/server/src/config.ts` (add to the exported `config` object; leave `required('VECTARA_API_KEY')` alone)
- Create: `apps/server/src/google/tokens.ts`
- Test: `apps/server/src/google/tokens.test.ts`

**Interfaces:**
- Consumes: `refreshAccessToken`, `CalendarDisconnectedError` (Task 4); `ROOT` from `apps/server/src/config.ts`.
- Produces:
  - `interface GoogleCreds { clientId: string; clientSecret: string; refreshToken: string }`
  - `interface TokenProvider { get(now?: number): Promise<string> }`
  - `createTokenProvider(creds: () => GoogleCreds): TokenProvider`
  - `TOKEN_FILE: string`, `readRefreshToken(): string`, `writeRefreshToken(token: string): void`
  - `googleCredentials(): GoogleCreds`, `isBookingEnabled(): boolean`, `tokens: TokenProvider`
  - On `config`: `publicBaseUrl`, `sessionSecret`, `google.{clientId,clientSecret,refreshToken}`

- [ ] **Step 1: Extend the server config**

In `apps/server/src/config.ts`, add the import and the new keys. Everything Google-related is optional — the app must still boot and search with none of it set.

```ts
import { randomBytes } from 'node:crypto';
```

Inside the exported `config` object, after `corsOrigins`:

```ts
  /** Origin the browser reaches this app on. Used to build OAuth redirect
   *  URIs, so it must match what is registered in the Google console. */
  publicBaseUrl: (process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:5173').replace(/\/+$/, ''),
  /** Signs the buyer identity cookie. A generated secret is fine to run with —
   *  it just means cookies do not survive a restart. */
  sessionSecret: process.env['SESSION_SECRET'] ?? randomBytes(32).toString('hex'),
  google: {
    clientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
    clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
    refreshToken: process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
  },
```

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/google/tokens.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CalendarDisconnectedError } from './oauth.js';
import { createTokenProvider, type GoogleCreds } from './tokens.js';

afterEach(() => vi.unstubAllGlobals());

const CREDS: GoogleCreds = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' };

/** One canned token response per call, so call counts are meaningful. */
function stubRefresh(token = 'at', expiresIn = 3600) {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('createTokenProvider', () => {
  it('fetches an access token on first use', async () => {
    const spy = stubRefresh('first');
    const provider = createTokenProvider(() => CREDS);
    await expect(provider.get(0)).resolves.toBe('first');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves a cached token without touching the network', async () => {
    const spy = stubRefresh('cached');
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await expect(provider.get(60_000)).resolves.toBe('cached');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the token has expired', async () => {
    const spy = stubRefresh('t', 3600);
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await provider.get(3_600_001);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refreshes inside the 60-second skew, so a token never expires mid-request', async () => {
    const spy = stubRefresh('t', 3600);
    const provider = createTokenProvider(() => CREDS);
    await provider.get(0);
    await provider.get(3_600_000 - 30_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reports a disconnected calendar when any credential is missing, without calling Google', async () => {
    const spy = stubRefresh();
    const provider = createTokenProvider(() => ({ ...CREDS, refreshToken: '' }));
    await expect(provider.get(0)).rejects.toBeInstanceOf(CalendarDisconnectedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-reads credentials each time, so a token written after boot is picked up', async () => {
    stubRefresh('late');
    let creds: GoogleCreds = { ...CREDS, refreshToken: '' };
    const provider = createTokenProvider(() => creds);
    await expect(provider.get(0)).rejects.toBeInstanceOf(CalendarDisconnectedError);
    creds = CREDS;
    await expect(provider.get(0)).resolves.toBe('late');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/google/tokens.test.ts`
Expected: FAIL — cannot resolve `./tokens.js`.

- [ ] **Step 4: Implement it**

Create `apps/server/src/google/tokens.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../config.js';
import { CalendarDisconnectedError, refreshAccessToken } from './oauth.js';

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenProvider {
  get(now?: number): Promise<string>;
}

/** Where `npm run connect:calendar` writes the token in development.
 *  Gitignored, alongside `.vectara-state.json`. */
export const TOKEN_FILE = join(ROOT, '.google-token.json');

/**
 * Cache access tokens in memory, refreshing from the refresh token on demand.
 *
 * Credentials arrive through a getter rather than a value so a token written
 * to disk after boot is still picked up, and so tests can swap them.
 */
export function createTokenProvider(creds: () => GoogleCreds): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async get(now = Date.now()): Promise<string> {
      const { clientId, clientSecret, refreshToken } = creds();
      if (!clientId || !clientSecret || !refreshToken) throw new CalendarDisconnectedError();

      // Refresh a minute early so a token can never expire mid-request.
      if (cached && now < cached.expiresAt - 60_000) return cached.token;

      const { accessToken, expiresIn } = await refreshAccessToken({ refreshToken, clientId, clientSecret });
      cached = { token: accessToken, expiresAt: now + expiresIn * 1000 };
      return accessToken;
    },
  };
}

/** Production passes the token as an env var; development reads the file the
 *  connect script wrote. */
export function readRefreshToken(): string {
  if (config.google.refreshToken) return config.google.refreshToken;
  try {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as { refresh_token?: string };
    return parsed.refresh_token ?? '';
  } catch {
    return '';
  }
}

export function writeRefreshToken(token: string): void {
  writeFileSync(TOKEN_FILE, `${JSON.stringify({ refresh_token: token }, null, 2)}\n`, { mode: 0o600 });
}

export function googleCredentials(): GoogleCreds {
  return {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    refreshToken: readRefreshToken(),
  };
}

export function isBookingEnabled(): boolean {
  const { clientId, clientSecret, refreshToken } = googleCredentials();
  return Boolean(clientId && clientSecret && refreshToken);
}

export const tokens = createTokenProvider(googleCredentials);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/google/tokens.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add apps/server/src/config.ts apps/server/src/google/tokens.ts apps/server/src/google/tokens.test.ts
git commit -m "Add optional Google config and an access-token cache"
```

---

### Task 6: Calendar event builder

Pure: listing plus buyer plus slot in, Google event body out. No network, so every field is asserted directly.

**Files:**
- Create: `apps/server/src/booking/event.ts`
- Test: `apps/server/src/booking/event.test.ts`

**Interfaces:**
- Consumes: `Listing`, `BuyerDetails` from `@zameen/shared`.
- Produces: `CALENDAR_TIMEZONE = 'Asia/Karachi'`, `interface GoogleEventBody`, `buildEvent(listing, buyer, slot, timeZone?): GoogleEventBody`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/booking/event.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { BuyerDetails, Listing } from '@zameen/shared';
import { buildEvent } from './event.js';

const LISTING: Listing = {
  externalId: '12345', title: 'Well maintained 3 bed flat with sea view',
  description: '', url: 'https://www.zameen.com/Property/clifton-12345.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2,
  pricePkr: 250_000, priceLabel: 'PKR 2.5 Lakh', rentFrequency: 'monthly',
  areaSqft: 1800, areaSqyd: 200, city: 'Karachi',
  areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Karachi > Clifton > Block 2',
  locationSlug: '', floor: 'upper', floorNum: null, floorRaw: null,
  lat: null, lng: null, isVerified: true, agency: 'Rayon Estates',
  photoCount: 8, coverPhoto: null, listedAt: 0, sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
};

const BUYER: BuyerDetails = { name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567' };
const SLOT = { startIso: '2026-09-17T15:00:00+05:00', endIso: '2026-09-17T15:45:00+05:00' };

describe('buildEvent', () => {
  const event = buildEvent(LISTING, BUYER, SLOT);

  it('names the property in the summary, with a singular property type', () => {
    expect(event.summary).toBe('Property viewing — 3 bed Flat, Block 2');
  });

  it('carries the slot times verbatim, offset included', () => {
    expect(event.start).toEqual({ dateTime: '2026-09-17T15:00:00+05:00', timeZone: 'Asia/Karachi' });
    expect(event.end).toEqual({ dateTime: '2026-09-17T15:45:00+05:00', timeZone: 'Asia/Karachi' });
  });

  it('invites the buyer, which is what makes Google email them', () => {
    expect(event.attendees).toEqual([{ email: 'asad@example.com', displayName: 'Asad Khan' }]);
  });

  it('puts all three buyer fields in the description, since Google never shows extendedProperties', () => {
    expect(event.description).toContain('Asad Khan');
    expect(event.description).toContain('asad@example.com');
    expect(event.description).toContain('+923001234567');
  });

  it('includes the listing price, size and link in the description', () => {
    expect(event.description).toContain('PKR 2.5 Lakh');
    expect(event.description).toContain('1,800 sq ft');
    expect(event.description).toContain('https://www.zameen.com/Property/clifton-12345.html');
  });

  it('marks a rental price as monthly but leaves a sale price alone', () => {
    expect(buildEvent(LISTING, BUYER, SLOT).description).toContain('PKR 2.5 Lakh per month');
    const sale = buildEvent({ ...LISTING, purpose: 'buy', priceLabel: 'PKR 4.5 Crore' }, BUYER, SLOT);
    expect(sale.description).toContain('PKR 4.5 Crore');
    expect(sale.description).not.toContain('per month');
  });

  it('mirrors the booking into extendedProperties for machine reads', () => {
    expect(event.extendedProperties.private).toEqual({
      listingId: '12345',
      purpose: 'rent',
      buyerName: 'Asad Khan',
      buyerEmail: 'asad@example.com',
      buyerPhone: '+923001234567',
      bookedVia: 'zameen-ai-agent',
    });
  });

  it('uses the area path as the location, falling back to the city', () => {
    expect(event.location).toBe('Karachi > Clifton > Block 2');
    expect(buildEvent({ ...LISTING, areaPath: '' }, BUYER, SLOT).location).toBe('Karachi');
  });

  it('falls back through the area levels when the block is unknown', () => {
    expect(buildEvent({ ...LISTING, areaL4: '' }, BUYER, SLOT).summary)
      .toBe('Property viewing — 3 bed Flat, Clifton');
  });

  it('leaves an unmapped property type as written', () => {
    expect(buildEvent({ ...LISTING, propertyType: 'Farm Houses' }, BUYER, SLOT).summary)
      .toBe('Property viewing — 3 bed Farm Houses, Block 2');
  });

  it('sets explicit reminders rather than inheriting the calendar default', () => {
    expect(event.reminders.useDefault).toBe(false);
    expect(event.reminders.overrides).toEqual([
      { method: 'popup', minutes: 60 },
      { method: 'email', minutes: 1440 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/booking/event.test.ts`
Expected: FAIL — cannot resolve `./event.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/booking/event.ts`:

```ts
import type { BuyerDetails, Listing } from '@zameen/shared';

/** Paired with BookingConfig.tzOffset. The dateTime strings already carry the
 *  offset, which is what Google actually uses; this is for display. */
export const CALENDAR_TIMEZONE = 'Asia/Karachi';

export interface GoogleEventBody {
  summary: string;
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: { email: string; displayName: string }[];
  extendedProperties: { private: Record<string, string> };
  reminders: { useDefault: false; overrides: { method: string; minutes: number }[] };
}

/** Zameen's property types are plural category names; an event title reads
 *  better singular. Unmapped values are left exactly as written. */
const SINGULAR: Record<string, string> = {
  Houses: 'House',
  Flats: 'Flat',
  'Upper Portions': 'Upper Portion',
  'Lower Portions': 'Lower Portion',
  Penthouse: 'Penthouse',
};

function place(listing: Listing): string {
  return listing.areaL4 || listing.areaL3 || listing.areaL5 || listing.city;
}

export function buildEvent(
  listing: Listing,
  buyer: BuyerDetails,
  slot: { startIso: string; endIso: string },
  timeZone: string = CALENDAR_TIMEZONE,
): GoogleEventBody {
  const type = SINGULAR[listing.propertyType] ?? listing.propertyType;
  const price = listing.purpose === 'rent' ? `${listing.priceLabel} per month` : listing.priceLabel;

  const description = [
    `Buyer: ${buyer.name} · ${buyer.email} · ${buyer.phone}`,
    `Property: ${price} · ${listing.bedrooms} bed · ${listing.areaSqft.toLocaleString('en-US')} sq ft · ${listing.propertyType}`,
    `Where: ${listing.areaPath || listing.city}`,
    `Listing: ${listing.url}`,
    '',
    'Booked through Zameen AI.',
  ].join('\n');

  return {
    summary: `Property viewing — ${listing.bedrooms} bed ${type}, ${place(listing)}`,
    location: listing.areaPath || listing.city,
    description,
    start: { dateTime: slot.startIso, timeZone },
    end: { dateTime: slot.endIso, timeZone },
    // Adding the buyer as an attendee is what makes Google email them an invite
    // once the event is created with sendUpdates=all.
    attendees: [{ email: buyer.email, displayName: buyer.name }],
    // Structured twin of the description. Google's UI never displays this, so
    // the description above stays the copy a human actually reads.
    extendedProperties: {
      private: {
        listingId: listing.externalId,
        purpose: listing.purpose,
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        buyerPhone: buyer.phone,
        bookedVia: 'zameen-ai-agent',
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 },
      ],
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/booking/event.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/booking/event.ts apps/server/src/booking/event.test.ts
git commit -m "Add the pure calendar event builder"
```

---

### Task 7: Google Calendar client

**Files:**
- Create: `apps/server/src/booking/calendar.ts`
- Test: `apps/server/src/booking/calendar.test.ts`

**Interfaces:**
- Consumes: `BusyInterval` (Task 2), `bookingConfig` (Task 1), `GoogleError` (Task 4), `tokens` (Task 5), `GoogleEventBody` (Task 6).
- Produces: `fetchBusy(timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]>`, `insertEvent(body: GoogleEventBody): Promise<{ id: string; htmlLink: string }>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/booking/calendar.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// The token provider is a module singleton built from real config; stub it so
// these tests exercise only the Calendar calls.
vi.mock('../google/tokens.js', () => ({ tokens: { get: async () => 'test-access-token' } }));

const { fetchBusy, insertEvent } = await import('./calendar.js');
const { GoogleError } = await import('../google/oauth.js');

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('fetchBusy', () => {
  it('asks for the configured calendar over the requested range', async () => {
    const spy = stubFetch({ calendars: { primary: { busy: [] } } });
    await fetchBusy('2026-09-17T00:00:00+05:00', '2026-10-01T00:00:00+05:00');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-access-token');
    expect(JSON.parse(init.body as string)).toEqual({
      timeMin: '2026-09-17T00:00:00+05:00',
      timeMax: '2026-10-01T00:00:00+05:00',
      items: [{ id: 'primary' }],
    });
  });

  it('converts busy windows to epoch milliseconds', async () => {
    stubFetch({
      calendars: { primary: { busy: [{ start: '2026-09-17T12:00:00+05:00', end: '2026-09-17T13:00:00+05:00' }] } },
    });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([
      { start: Date.parse('2026-09-17T12:00:00+05:00'), end: Date.parse('2026-09-17T13:00:00+05:00') },
    ]);
  });

  it('treats a calendar with no busy list as fully free', async () => {
    stubFetch({ calendars: { primary: {} } });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([]);
  });

  it('drops an unparseable interval rather than producing NaN bounds', async () => {
    stubFetch({ calendars: { primary: { busy: [{ start: 'not-a-date', end: 'nor-this' }] } } });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([]);
  });

  it('fails loudly when Google reports the calendar is not readable', async () => {
    stubFetch({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } });
    await expect(fetchBusy('a', 'b')).rejects.toBeInstanceOf(GoogleError);
  });

  it('fails on a non-OK response', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(fetchBusy('a', 'b')).rejects.toBeInstanceOf(GoogleError);
  });
});

describe('insertEvent', () => {
  const body = { summary: 'Property viewing' } as never;

  it('posts to the configured calendar with sendUpdates=all so the buyer is emailed', async () => {
    const spy = stubFetch({ id: 'evt_1', htmlLink: 'https://calendar.google.com/event?eid=1' });
    await expect(insertEvent(body)).resolves.toEqual({
      id: 'evt_1',
      htmlLink: 'https://calendar.google.com/event?eid=1',
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
    expect(init.method).toBe('POST');
  });

  it('fails on a non-OK response', async () => {
    stubFetch({ error: 'nope' }, { ok: false, status: 403 });
    await expect(insertEvent(body)).rejects.toBeInstanceOf(GoogleError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/booking/calendar.test.ts`
Expected: FAIL — cannot resolve `./calendar.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/booking/calendar.ts`:

```ts
import { GoogleError } from '../google/oauth.js';
import { tokens } from '../google/tokens.js';
import type { BusyInterval } from './availability.js';
import { bookingConfig } from './config.js';
import type { GoogleEventBody } from './event.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

async function authHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokens.get()}`,
    'Content-Type': 'application/json',
  };
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
}

/**
 * Busy windows for the whole booking window in one call.
 *
 * One request per modal session rather than one per date is what lets the
 * buyer click through all fourteen days with no further latency.
 */
export async function fetchBusy(timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]> {
  const res = await fetch(`${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: bookingConfig.calendarId }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new GoogleError(`freeBusy failed (HTTP ${res.status})`, res.status);

  const data = (await res.json()) as FreeBusyResponse;
  const calendar = data.calendars?.[bookingConfig.calendarId];

  // A per-calendar error is reported inside a 200 response, so this is the
  // only place a wrong GOOGLE_CALENDAR_ID surfaces. Silently treating it as
  // "no busy time" would let every slot look free.
  if (calendar?.errors?.length) {
    const reasons = calendar.errors.map((e) => e.reason).join(', ');
    throw new GoogleError(`Calendar '${bookingConfig.calendarId}' is not readable: ${reasons}`, 502);
  }

  return (calendar?.busy ?? [])
    .map((window) => ({ start: Date.parse(window.start), end: Date.parse(window.end) }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end));
}

export async function insertEvent(body: GoogleEventBody): Promise<{ id: string; htmlLink: string }> {
  // sendUpdates=all is what makes Google email the invite to the attendee.
  const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(bookingConfig.calendarId)}/events?sendUpdates=all`;

  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GoogleError(`Could not create the event (HTTP ${res.status}): ${detail.slice(0, 200)}`, res.status);
  }

  const data = (await res.json()) as { id?: string; htmlLink?: string };
  return { id: String(data.id ?? ''), htmlLink: String(data.htmlLink ?? '') };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/booking/calendar.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/booking/calendar.ts apps/server/src/booking/calendar.test.ts
git commit -m "Add the Google Calendar freeBusy and event-insert client"
```

---

### Task 8: Authoritative listing lookup

The booking route must never take listing content from the browser. This adds the one-document read it uses instead, reusing the existing `listingFromMetadata`.

**Files:**
- Modify: `apps/server/src/vectara.ts` (add one exported function)
- Test: `apps/server/src/vectara.test.ts` (new file)

**Interfaces:**
- Consumes: `listingFromMetadata` from `apps/server/src/listings.ts`; `config`, `UpstreamError` from the same module.
- Produces: `getListingById(purpose: Purpose, externalId: string): Promise<Listing | null>`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/vectara.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getListingById } from './vectara.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const METADATA = {
  external_id: '12345', title: 'Well maintained 3 bed flat', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', property_type: 'Flats', bedrooms: 3, bathrooms: 2,
  price_pkr: 250000, price_label: 'PKR 2.5 Lakh', area_sqft: 1800, area_sqyd: 200,
  city: 'Karachi', area_l3: 'Clifton', area_l4: 'Block 2', area_l5: '',
  area_path: 'Karachi > Clifton > Block 2', floor: 'upper', floor_num: -1, is_verified: true,
};

describe('getListingById', () => {
  it('reads the document whose id is purpose-externalId', async () => {
    const spy = stubFetch({ id: 'rent-12345', metadata: METADATA });
    const listing = await getListingById('rent', '12345');

    expect(listing?.externalId).toBe('12345');
    expect(listing?.priceLabel).toBe('PKR 2.5 Lakh');
    expect(spy.mock.calls[0]![0]).toContain('/documents/rent-12345');
  });

  it('returns null for a document that no longer exists', async () => {
    stubFetch({ error: 'not found' }, { ok: false, status: 404 });
    await expect(getListingById('buy', '99999')).resolves.toBeNull();
  });

  it('returns null when the document carries no metadata', async () => {
    stubFetch({ id: 'rent-12345' });
    await expect(getListingById('rent', '12345')).resolves.toBeNull();
  });

  it('rejects an id containing path characters without calling the API', async () => {
    const spy = stubFetch({});
    await expect(getListingById('rent', '../../secrets')).resolves.toBeNull();
    await expect(getListingById('rent', '')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('raises on an unexpected upstream failure rather than pretending the listing is gone', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(getListingById('rent', '12345')).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/vectara.test.ts`
Expected: FAIL — `getListingById` is not exported.

- [ ] **Step 3: Implement it**

In `apps/server/src/vectara.ts`, extend the `@zameen/shared` type import to include `Purpose`, add `listingFromMetadata` to the existing `./listings.js` import, and append:

```ts
/** Vectara document ids are `${purpose}-${externalId}`; anything outside this
 *  alphabet cannot be one, and would otherwise be interpolated into a URL path. */
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read one listing straight from the corpus.
 *
 * The booking route uses this instead of trusting the browser's copy: without
 * it, anyone could POST arbitrary text and have it land in the estate agent's
 * calendar.
 */
export async function getListingById(purpose: Purpose, externalId: string): Promise<Listing | null> {
  if (!SAFE_EXTERNAL_ID.test(externalId)) return null;

  const documentId = `${purpose}-${externalId}`;
  const res = await fetch(
    `${config.baseUrl}/corpora/${config.corpusKey}/documents/${encodeURIComponent(documentId)}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new UpstreamError(`Could not read listing ${documentId} (HTTP ${res.status})`, res.status);
  }

  const data = (await res.json()) as { metadata?: Record<string, unknown> };
  return data.metadata ? listingFromMetadata(data.metadata) : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/vectara.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/vectara.ts apps/server/src/vectara.test.ts
git commit -m "Read a single listing from the corpus by id"
```

---

### Task 9: Identity routes

Route tests start a real Express app on an ephemeral port and use `fetch`. That keeps the no-new-dependency rule and exercises real middleware, cookies and redirects.

**Files:**
- Create: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `config` (Task 5), buyer helpers (Task 3), oauth helpers (Task 4), `isBookingEnabled` (Task 5).
- Produces:
  - `buyerFromRequest(req: Request): StoredBuyer | null`
  - `setBuyerCookie(res: Response, buyer: StoredBuyer): void`
  - `buyerRedirectUri(): string`
  - `mountAuthRoutes(app: Express): void`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/routes/auth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// config.ts calls required('VECTARA_API_KEY') at import time and reads every
// Google value once, so the environment must be set before it is loaded.
// Static imports hoist above assignments, hence the dynamic imports below.
process.env['VECTARA_API_KEY'] ??= 'test-key';
process.env['GOOGLE_CLIENT_ID'] = 'test-client-id';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-secret';

const { config } = await import('../config.js');
const { BUYER_COOKIE, sign } = await import('../buyer.js');
const { mountAuthRoutes } = await import('./auth.js');
type StoredBuyer = import('../buyer.js').StoredBuyer;

afterEach(() => vi.unstubAllGlobals());

/** Run one request against a real server on an ephemeral port. */
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  mountAuthRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const BUYER: StoredBuyer = {
  name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567', via: 'google',
};
const cookieFor = (b: StoredBuyer) => `${BUYER_COOKIE}=${encodeURIComponent(sign(b, config.sessionSecret))}`;

describe('GET /api/me', () => {
  it('reports no buyer when there is no cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`);
      expect(res.status).toBe(200);
      expect((await res.json()).buyer).toBeNull();
    });
  });

  it('returns the buyer from a valid cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`, { headers: { Cookie: cookieFor(BUYER) } });
      expect((await res.json()).buyer).toEqual(BUYER);
    });
  });

  it('ignores a cookie whose signature does not check out', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/me`, { headers: { Cookie: `${BUYER_COOKIE}=forged.value` } });
      expect((await res.json()).buyer).toBeNull();
    });
  });
});

describe('GET /api/auth/google', () => {
  it('redirects to Google and remembers the state nonce in a cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
      expect(res.status).toBe(302);

      const target = new URL(res.headers.get('location')!);
      expect(target.origin).toBe('https://accounts.google.com');
      expect(target.searchParams.get('scope')).toBe('openid email profile');
      const state = target.searchParams.get('state')!;
      expect(state).toMatch(/^[a-f0-9]{32}$/);
      expect(res.headers.get('set-cookie')).toContain('zameen_oauth_state=');
    });
  });
});

describe('GET /api/auth/google/callback', () => {
  it('rejects a callback whose state does not match the cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/google/callback?code=x&state=attacker`, { redirect: 'manual' });
      expect(res.status).toBe(400);
    });
  });

  it('signs the buyer in and keeps a phone number they had already given', async () => {
    // Captured before stubbing: the test's own request to the local server
    // must not be intercepted by the stub meant for Google's endpoints.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.includes('userinfo')
              ? { name: 'Asad Khan', email: 'asad@example.com' }
              : { access_token: 'at', expires_in: 3599 },
          text: async () => '',
        };
      }),
    );

    await withServer(async (base) => {
      const nonce = 'a'.repeat(32);
      const stateCookie = `zameen_oauth_state=${encodeURIComponent(sign({ n: nonce }, config.sessionSecret))}`;
      const prior = cookieFor({ ...BUYER, name: 'Old Name', via: 'manual' });

      const res = await fetch(`${base}/api/auth/google/callback?code=abc&state=${nonce}`, {
        redirect: 'manual',
        headers: { Cookie: `${stateCookie}; ${prior}` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');

      const setCookies = res.headers.getSetCookie().join('\n');
      const value = /zameen_buyer=([^;]+)/.exec(setCookies)![1]!;
      const body = JSON.parse(
        Buffer.from(decodeURIComponent(value).split('.')[0]!, 'base64url').toString(),
      );
      // The Google profile wins for name and email; the phone survives, because
      // Google never supplies one.
      expect(body).toMatchObject({
        name: 'Asad Khan',
        email: 'asad@example.com',
        phone: '+923001234567',
        via: 'google',
      });
    });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the buyer cookie', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookieFor(BUYER) } });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toMatch(/zameen_buyer=;/);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/routes/auth.test.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/routes/auth.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  BUYER_COOKIE,
  STATE_COOKIE,
  parseCookies,
  sign,
  verify,
  type StoredBuyer,
} from '../buyer.js';
import { config } from '../config.js';
import { BUYER_SCOPES, authUrl, exchangeCode, fetchUserInfo } from '../google/oauth.js';
import { isBookingEnabled } from '../google/tokens.js';

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

export function buyerRedirectUri(): string {
  return `${config.publicBaseUrl}/api/auth/google/callback`;
}

export function buyerFromRequest(req: Request): StoredBuyer | null {
  const token = parseCookies(req.headers.cookie)[BUYER_COOKIE];
  return verify<StoredBuyer>(token, config.sessionSecret);
}

export function setBuyerCookie(res: Response, buyer: StoredBuyer): void {
  res.cookie(BUYER_COOKIE, sign(buyer, config.sessionSecret), {
    httpOnly: true,
    // Must stay 'lax'. 'strict' withholds the cookie on the top-level redirect
    // back from Google, so the buyer would land signed out immediately.
    sameSite: 'lax',
    secure: config.publicBaseUrl.startsWith('https://'),
    path: '/',
    maxAge: THIRTY_DAYS_MS,
  });
}

export function mountAuthRoutes(app: Express): void {
  app.get('/api/me', (req, res) => {
    res.json({ buyer: buyerFromRequest(req), bookingEnabled: isBookingEnabled() });
  });

  app.get('/api/auth/google', (_req, res) => {
    if (!config.google.clientId) {
      res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
      return;
    }

    const nonce = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, sign({ n: nonce }, config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicBaseUrl.startsWith('https://'),
      path: '/',
      maxAge: 600_000,
    });

    res.redirect(
      authUrl({
        clientId: config.google.clientId,
        redirectUri: buyerRedirectUri(),
        scopes: BUYER_SCOPES,
        state: nonce,
        // The buyer flow needs no refresh token, so it stays online-only.
        offline: false,
      }),
    );
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : '';
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
    const stored = verify<{ n: string }>(parseCookies(req.headers.cookie)[STATE_COOKIE], config.sessionSecret);

    res.clearCookie(STATE_COOKIE, { path: '/' });

    if (!code || !state || !stored || stored.n !== state) {
      res.status(400).json({ error: 'Sign-in could not be verified. Please try again.' });
      return;
    }

    try {
      const { accessToken } = await exchangeCode({
        code,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: buyerRedirectUri(),
      });
      const profile = await fetchUserInfo(accessToken);

      // Google never returns a phone number, so carry over anything the buyer
      // has already given us rather than wiping it on sign-in.
      const existing = buyerFromRequest(req);
      setBuyerCookie(res, {
        name: profile.name || existing?.name || '',
        email: profile.email || existing?.email || '',
        phone: existing?.phone ?? '',
        via: 'google',
      });
      res.redirect('/');
    } catch {
      res.status(502).json({ error: 'Google sign-in failed. Please try again.' });
    }
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(BUYER_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/server/src/routes/auth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add apps/server/src/routes/auth.ts apps/server/src/routes/auth.test.ts
git commit -m "Add buyer sign-in, sign-out and /api/me"
```

---

### Task 10: Booking routes

**Files:**
- Create: `apps/server/src/routes/booking.ts`
- Test: `apps/server/src/routes/booking.test.ts`
- Modify: `apps/server/src/index.ts` (mount both route modules)

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: `mountBookingRoutes(app: Express): void`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/routes/booking.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Listing } from '@zameen/shared';

// routes/booking.ts reaches config.ts through routes/auth.ts, and config.ts
// calls required('VECTARA_API_KEY') at import time.
process.env['VECTARA_API_KEY'] ??= 'test-key';

const fetchBusy = vi.fn();
const insertEvent = vi.fn();
const getListingById = vi.fn();

vi.mock('../booking/calendar.js', () => ({
  fetchBusy: (...a: unknown[]) => fetchBusy(...a),
  insertEvent: (...a: unknown[]) => insertEvent(...a),
}));

// Mocked outright rather than with importActual: the real module imports
// config.ts, and the route only needs these two exports.
vi.mock('../vectara.js', () => ({
  getListingById: (...a: unknown[]) => getListingById(...a),
  UpstreamError: class UpstreamError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));

vi.mock('../google/tokens.js', () => ({
  isBookingEnabled: () => true,
  tokens: { get: async () => 'access-token' },
}));

const { mountBookingRoutes } = await import('./booking.js');
const { CalendarDisconnectedError, GoogleError } = await import('../google/oauth.js');

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  mountBookingRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const LISTING = {
  externalId: '12345', title: '3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 250_000,
  priceLabel: 'PKR 2.5 Lakh', rentFrequency: 'monthly', areaSqft: 1800, areaSqyd: 200,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Karachi > Clifton',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

const BUYER = { name: 'Asad Khan', email: 'asad@example.com', phone: '0300 1234567' };

/** The first available slot in the live window, so tests never go stale. */
async function firstSlot(base: string): Promise<string> {
  fetchBusy.mockResolvedValueOnce([]);
  const body = await (await fetch(`${base}/api/availability`)).json();
  return body.days.flatMap((d: { slots: { startIso: string; available: boolean }[] }) => d.slots)
    .find((s: { available: boolean }) => s.available)!.startIso;
}

beforeEach(() => {
  fetchBusy.mockReset();
  insertEvent.mockReset();
  getListingById.mockReset();
});

describe('GET /api/availability', () => {
  it('returns the whole window from a single freeBusy call', async () => {
    fetchBusy.mockResolvedValueOnce([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/availability`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.tz).toBe('Asia/Karachi');
      expect(body.slotMinutes).toBe(45);
      expect(body.days).toHaveLength(14);
      expect(fetchBusy).toHaveBeenCalledTimes(1);
    });
  });

  it('reports a disconnected calendar as 503, not a generic failure', async () => {
    fetchBusy.mockRejectedValueOnce(new CalendarDisconnectedError());
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/availability`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('connect:calendar');
    });
  });

  it('reports any other Google failure as 502', async () => {
    fetchBusy.mockRejectedValueOnce(new GoogleError('boom', 500));
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/availability`)).status).toBe(502);
    });
  });
});

describe('POST /api/bookings', () => {
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates the event and returns the booking', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'evt_1', htmlLink: 'https://calendar.google.com/e/1' });

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.status).toBe(200);
      expect((await res.json()).booking).toMatchObject({
        eventId: 'evt_1', startIso, listingTitle: '3 bed flat', buyerEmail: 'asad@example.com',
      });
    });
  });

  it('remembers the buyer so their next booking is pre-filled', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.headers.get('set-cookie')).toContain('zameen_buyer=');
    });
  });

  it('normalises the phone number before it reaches the calendar', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      const event = insertEvent.mock.calls[0]![0] as { description: string };
      expect(event.description).toContain('+923001234567');
    });
  });

  it('ignores a listing payload sent by the client and uses the corpus copy', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      await post(base, {
        purpose: 'rent', externalId: '12345', startIso, buyer: BUYER,
        listing: { title: 'CALL 0300-EVIL NOW', url: 'https://evil.example' },
      });

      const event = insertEvent.mock.calls[0]![0] as { summary: string; description: string };
      expect(event.summary).not.toContain('EVIL');
      expect(event.description).not.toContain('evil.example');
      expect(event.description).toContain('https://www.zameen.com/Property/x.html');
    });
  });

  it('rejects an invalid phone number with 422 and names the field', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      const res = await post(base, {
        purpose: 'rent', externalId: '12345', startIso, buyer: { ...BUYER, phone: 'call me' },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).field).toBe('phone');
      expect(insertEvent).not.toHaveBeenCalled();
    });
  });

  it('rejects a time that is not one of the offered slots', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        purpose: 'rent', externalId: '12345', startIso: '2030-01-01T03:17:00+05:00', buyer: BUYER,
      });
      expect(res.status).toBe(409);
    });
  });

  it('returns 409 when the slot was taken between loading and submitting', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([
        { start: Date.parse(startIso) - 60_000, end: Date.parse(startIso) + 60_000 },
      ]);

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.status).toBe(409);
      expect(insertEvent).not.toHaveBeenCalled();
    });
  });

  it('returns 404 when the listing has left the corpus', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(null);
      const res = await post(base, { purpose: 'rent', externalId: '99999', startIso, buyer: BUYER });
      expect(res.status).toBe(404);
    });
  });

  it('rejects a malformed body with 400', async () => {
    await withServer(async (base) => {
      expect((await post(base, { buyer: BUYER })).status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/routes/booking.test.ts`
Expected: FAIL — cannot resolve `./booking.js`.

- [ ] **Step 3: Implement it**

Create `apps/server/src/routes/booking.ts`:

```ts
import type { Express, Response } from 'express';
import type { Booking, BookingRequest, Purpose } from '@zameen/shared';
import { validateBuyer } from '../buyer.js';
import { addDays, isSlotFree, offsetToMs, pktDate, slotsForWindow } from '../booking/availability.js';
import { fetchBusy, insertEvent } from '../booking/calendar.js';
import { bookingConfig } from '../booking/config.js';
import { CALENDAR_TIMEZONE, buildEvent } from '../booking/event.js';
import { CalendarDisconnectedError, GoogleError } from '../google/oauth.js';
import { isBookingEnabled } from '../google/tokens.js';
import { UpstreamError, getListingById } from '../vectara.js';
import { buyerFromRequest, setBuyerCookie } from './auth.js';

const NOT_CONNECTED =
  "The estate agent's calendar isn't connected. Run `npm run connect:calendar` to reconnect it.";

function windowBounds(now: number): { timeMin: string; timeMax: string } {
  const cfg = bookingConfig;
  const first = addDays(pktDate(now, offsetToMs(cfg.tzOffset)), cfg.leadDays);
  return {
    timeMin: `${first}T00:00:00${cfg.tzOffset}`,
    timeMax: `${addDays(first, cfg.windowDays)}T00:00:00${cfg.tzOffset}`,
  };
}

/** A dead refresh token and a flaky Google are different problems with
 *  different fixes, so they must not collapse into one status. */
function failure(res: Response, err: unknown): void {
  if (err instanceof CalendarDisconnectedError) {
    res.status(503).json({ error: NOT_CONNECTED });
  } else if (err instanceof GoogleError) {
    res.status(502).json({ error: 'Google Calendar is not responding. Please try again.' });
  } else if (err instanceof UpstreamError) {
    res.status(err.status).json({ error: err.message });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}

export function mountBookingRoutes(app: Express): void {
  app.get('/api/availability', async (_req, res) => {
    if (!isBookingEnabled()) {
      res.status(503).json({ error: NOT_CONNECTED });
      return;
    }

    try {
      const now = Date.now();
      const { timeMin, timeMax } = windowBounds(now);
      const busy = await fetchBusy(timeMin, timeMax);
      res.json({
        tz: CALENDAR_TIMEZONE,
        slotMinutes: bookingConfig.slotMinutes,
        days: slotsForWindow(now, busy, bookingConfig),
      });
    } catch (err) {
      failure(res, err);
    }
  });

  app.post('/api/bookings', async (req, res) => {
    if (!isBookingEnabled()) {
      res.status(503).json({ error: NOT_CONNECTED });
      return;
    }

    const body = (req.body ?? {}) as Partial<BookingRequest>;
    const purpose: Purpose | null =
      body.purpose === 'rent' || body.purpose === 'buy' ? body.purpose : null;
    const externalId = typeof body.externalId === 'string' ? body.externalId : '';
    const startIso = typeof body.startIso === 'string' ? body.startIso : '';

    if (!purpose || !externalId || !startIso) {
      res.status(400).json({ error: 'purpose, externalId and startIso are required.' });
      return;
    }

    const validated = validateBuyer(body.buyer);
    if (!validated.ok) {
      res.status(422).json({ error: validated.message, field: validated.field });
      return;
    }

    try {
      const now = Date.now();

      // The requested time must be one of the slots we actually offer, not an
      // arbitrary instant the client invented.
      const slot = slotsForWindow(now, [], bookingConfig)
        .flatMap((day) => day.slots)
        .find((candidate) => candidate.startIso === startIso);

      if (!slot?.available) {
        res.status(409).json({ error: 'That time is no longer available. Please pick another slot.' });
        return;
      }

      const listing = await getListingById(purpose, externalId);
      if (!listing) {
        res.status(404).json({ error: 'That listing is no longer available.' });
        return;
      }

      // Re-check the live calendar immediately before inserting. This narrows
      // the double-booking race to milliseconds; it cannot close it, because
      // Google Calendar does not enforce slot exclusivity.
      const busy = await fetchBusy(slot.startIso, slot.endIso);
      if (!isSlotFree(Date.parse(slot.startIso), Date.parse(slot.endIso), busy)) {
        res.status(409).json({ error: 'Someone just booked that slot. Please pick another.' });
        return;
      }

      const created = await insertEvent(buildEvent(listing, validated.buyer, slot));

      // Remember the buyer — including the phone Google will never supply — so
      // a second booking is pre-filled in all three fields.
      setBuyerCookie(res, { ...validated.buyer, via: buyerFromRequest(req)?.via ?? 'manual' });

      const booking: Booking = {
        eventId: created.id,
        htmlLink: created.htmlLink,
        startIso: slot.startIso,
        endIso: slot.endIso,
        listingTitle: listing.title,
        buyerEmail: validated.buyer.email,
      };
      res.json({ booking });
    } catch (err) {
      failure(res, err);
    }
  });
}
```

- [ ] **Step 4: Mount both route modules**

In `apps/server/src/index.ts`, add the imports:

```ts
import { mountAuthRoutes } from './routes/auth.js';
import { mountBookingRoutes } from './routes/booking.js';
```

and call them immediately after the `/api/chat` handler, before `mountWebClient` — the existing comment there warns that `/api` routes must never be shadowed by the SPA fallback:

```ts
mountAuthRoutes(app);
mountBookingRoutes(app);
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — the new booking route tests plus every pre-existing test.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add apps/server/src/routes/booking.ts apps/server/src/routes/booking.test.ts apps/server/src/index.ts
git commit -m "Add availability and booking endpoints"
```

---

### Task 11: The connect-calendar CLI, configuration and documentation

This is the one piece with no automated test — it is an interactive OAuth flow. Verification is a real run against a real Google project.

**Files:**
- Create: `apps/server/src/connect-calendar.ts`
- Modify: `package.json`, `apps/server/package.json`, `.env.example`, `.gitignore`, `README.md`, `DEPLOY.md`

**Interfaces:**
- Consumes: `config` (Task 5), `AGENT_SCOPES`/`authUrl`/`exchangeCode` (Task 4), `TOKEN_FILE`/`writeRefreshToken` (Task 5).
- Produces: a `.google-token.json` file and a printed `GOOGLE_REFRESH_TOKEN=` line. No exports.

- [ ] **Step 1: Write the CLI**

Create `apps/server/src/connect-calendar.ts`:

```ts
/**
 * One-time connection of the estate agent's Google Calendar.
 *
 * Runs locally and never on the deployed service, which is what keeps the
 * private-Cloud-Run problem away from the estate-agent side entirely: the
 * deployed app only ever receives the resulting refresh token as an env var.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.js';
import { AGENT_SCOPES, authUrl, exchangeCode } from './google/oauth.js';
import { TOKEN_FILE, writeRefreshToken } from './google/tokens.js';

const PORT = 5858;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

/** Serve one request, capture the code, then shut the listener down. */
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const done = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font:16px system-ui;padding:3rem">${message}</body></html>`);
        server.close();
      };

      if (error) {
        done('Connection refused. You can close this tab.');
        reject(new Error(`Google returned an error: ${error}`));
      } else if (!code || state !== expectedState) {
        done('Could not verify that response. You can close this tab.');
        reject(new Error('State mismatch or missing code.'));
      } else {
        done('Calendar connected. You can close this tab and return to the terminal.');
        resolve(code);
      }
    });

    server.on('error', reject);
    server.listen(PORT);
  });
}

async function main(): Promise<void> {
  const { clientId, clientSecret } = config.google;
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    console.error(`Register ${REDIRECT_URI} as an authorised redirect URI on that OAuth client.`);
    process.exit(1);
  }

  const state = randomBytes(16).toString('hex');
  const url = authUrl({
    clientId,
    redirectUri: REDIRECT_URI,
    scopes: AGENT_SCOPES,
    state,
    // Both access_type=offline and prompt=consent, or a repeat authorization
    // silently returns no refresh token at all.
    offline: true,
  });

  console.log('\nOpen this URL and grant calendar access:\n');
  console.log(`  ${url}\n`);
  console.log(`Waiting on ${REDIRECT_URI} ...\n`);

  const code = await waitForCode(state);
  const { refreshToken } = await exchangeCode({ code, clientId, clientSecret, redirectUri: REDIRECT_URI });

  if (!refreshToken) {
    console.error('Google returned no refresh token. This happens when the client was already');
    console.error('authorised and prompt=consent was not sent. Revoke access at');
    console.error('https://myaccount.google.com/permissions and run this again.');
    process.exit(1);
  }

  writeRefreshToken(refreshToken);
  console.log(`Wrote ${TOKEN_FILE} — local development is ready.\n`);
  console.log('For Cloud Run, add this to the deploy command:\n');
  console.log(`  GOOGLE_REFRESH_TOKEN=${refreshToken}\n`);
  console.log('Note: while the OAuth consent screen is in Testing status this token');
  console.log('expires after 7 days. Re-run this command when booking returns a 503.\n');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm scripts**

In `apps/server/package.json`, add to `scripts`:

```json
    "connect:calendar": "tsx src/connect-calendar.ts"
```

In the root `package.json`, add to `scripts`:

```json
    "connect:calendar": "npm run -w @zameen/server connect:calendar"
```

- [ ] **Step 3: Extend .env.example and .gitignore**

Append to `.env.example`:

```
# Viewing bookings. All optional — the app runs without them, with the
# "Book a viewing" button disabled.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Produced by `npm run connect:calendar`. Locally it is read from
# .google-token.json instead, so this can stay empty in development.
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=primary
# Origin the browser reaches this app on; must match the redirect URI
# registered in the Google console.
PUBLIC_BASE_URL=http://localhost:5173
# Signs the buyer identity cookie. Generated per boot if unset, which means
# cookies do not survive a restart.
SESSION_SECRET=
# Karachi working week. 0 = Sunday.
BOOKING_SLOT_MINUTES=45
BOOKING_GRID_MINUTES=60
BOOKING_DAY_START=11
BOOKING_DAY_END=19
BOOKING_LEAD_DAYS=1
BOOKING_WINDOW_DAYS=14
BOOKING_CLOSED_DAYS=0
BOOKING_TZ_OFFSET=+05:00
```

Append to `.gitignore`, beside the existing `.vectara-state.json`:

```
.google-token.json
```

- [ ] **Step 4: Verify against a real Google project**

This is the manual gate for this task. In the Google Cloud console for the project:

1. Enable the **Google Calendar API**.
2. Create an OAuth client, type **Web application**.
3. Add authorised redirect URIs: `http://localhost:5858/callback`, `http://localhost:5173/api/auth/google/callback`, and the production `<PUBLIC_BASE_URL>/api/auth/google/callback`.
4. On the consent screen, add the `.../auth/calendar.events` scope and add yourself as a test user.
5. Put the client id and secret in `.env`.

Then:

```bash
npm run connect:calendar
```

Expected: the URL prints, consent completes in the browser, the tab says the calendar is connected, `.google-token.json` appears at the repo root, and a `GOOGLE_REFRESH_TOKEN=` line is printed. Confirm the file is ignored by git:

```bash
git status --porcelain .google-token.json
```

Expected: no output.

- [ ] **Step 5: Document it**

In `README.md`, add a `Booking a viewing` section after `How filtering stays exact`, covering: the one-time `npm run connect:calendar` step; that buyers may sign in with Google but always supply a phone number, because Google does not return one; the Karachi business-hours defaults; and that a `503` from booking means the refresh token has expired and the fix is to re-run the connect command. Add `npm run connect:calendar` to the Scripts table, and the new variables to the Configuration table.

In `DEPLOY.md`, add a `Google Calendar` section before `Verify the deployment`, covering the console setup above, passing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `PUBLIC_BASE_URL` and `SESSION_SECRET` through `--set-env-vars`, and this warning:

> Buyer sign-in cannot work while the service is private. Google redirects the browser to the callback with no identity token, so the request is rejected before it reaches Express. Until an owner runs the `run.invoker` binding above, sign-in works in local development only. The estate-agent connection is unaffected, because `connect:calendar` never runs on the deployed service.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/connect-calendar.ts package.json apps/server/package.json .env.example .gitignore README.md DEPLOY.md
git commit -m "Add the one-time calendar connect CLI and its documentation"
```

---

### Task 12: Web API client and the account chip

**Files:**
- Create: `apps/web/src/lib/booking.ts`
- Test: `apps/web/src/lib/booking.test.ts`
- Create: `apps/web/src/components/AccountChip.tsx`
- Modify: `apps/web/src/App.tsx` (load `/api/me`, render the chip in the header)

**Interfaces:**
- Consumes: `Availability`, `Booking`, `BookingRequest`, `BuyerDetails` from `@zameen/shared`.
- Produces:
  - `interface Me { buyer: (BuyerDetails & { via: string }) | null; bookingEnabled: boolean }`
  - `class BookingError extends Error { status: number; field?: string }`
  - `getMe(): Promise<Me>`, `getAvailability(): Promise<Availability>`, `createBooking(req: BookingRequest): Promise<Booking>`, `signOut(): Promise<void>`
  - `SIGN_IN_URL = '/api/auth/google'`
  - `dayLabel(date: string): string`, `slotLabel(startIso: string): string`, `slotRangeLabel(startIso: string, endIso: string): string`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/booking.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/src/lib/booking.test.ts`
Expected: FAIL — cannot resolve `./booking.js`.

- [ ] **Step 3: Implement the client**

Create `apps/web/src/lib/booking.ts`:

```ts
import type { Availability, Booking, BookingRequest, BuyerDetails } from '@zameen/shared';

export interface Me {
  buyer: (BuyerDetails & { via: string }) | null;
  bookingEnabled: boolean;
}

/** Carries the status so the modal can tell a taken slot (409) from a
 *  disconnected calendar (503) from a bad field (422). */
export class BookingError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string) {
    super(message);
    this.name = 'BookingError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new BookingError(body.error ?? `Request failed (${res.status})`, res.status, body.field);
  }

  return (await res.json()) as T;
}

export const SIGN_IN_URL = '/api/auth/google';

export const getMe = () => request<Me>('/api/me');
export const getAvailability = () => request<Availability>('/api/availability');
export const signOut = () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }).then(() => undefined);

export const createBooking = (body: BookingRequest) =>
  request<{ booking: Booking }>('/api/bookings', { method: 'POST', body: JSON.stringify(body) })
    .then((r) => r.booking);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parsed as UTC and read with UTC getters, so the viewer's own timezone
 *  cannot shift the date by a day. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The Karachi wall-clock time, taken from the ISO string itself.
 *
 * Deliberately not `new Date(...)`: that would render in the viewer's own
 * timezone, so an overseas buyer would be shown a time the estate agent is
 * not expecting them.
 */
export function slotLabel(startIso: string): string {
  const hour24 = Number(startIso.slice(11, 13));
  const minutes = startIso.slice(14, 16);
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

export function slotRangeLabel(startIso: string, endIso: string): string {
  return `${dayLabel(startIso.slice(0, 10))}, ${slotLabel(startIso)} – ${slotLabel(endIso)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/web/src/lib/booking.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the account chip**

Create `apps/web/src/components/AccountChip.tsx`:

```tsx
import { SIGN_IN_URL, type Me } from '../lib/booking.js';

/**
 * Deliberately quiet when signed out: while the OAuth consent screen is in
 * Testing status only listed test users can sign in at all, so entering
 * details by hand is the primary path and the UI must not imply otherwise.
 */
export function AccountChip({ me, onSignOut }: { me: Me | null; onSignOut: () => void }) {
  if (!me) return null;

  if (!me.buyer) {
    return (
      <a
        href={SIGN_IN_URL}
        className="rounded-lg border px-2.5 py-1.5 text-xs font-medium transition hover:shadow-sm
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        style={{ borderColor: 'var(--border)' }}
      >
        Sign in with Google
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="text-right">
        <p className="text-xs font-semibold leading-tight">{me.buyer.name || me.buyer.email}</p>
        <p className="text-[10px] leading-tight" style={{ color: 'var(--muted)' }}>
          {me.buyer.email}
        </p>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="rounded-lg border px-2 py-1 text-[11px] transition hover:shadow-sm
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        style={{ borderColor: 'var(--border)' }}
      >
        Sign out
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Wire it into the header**

In `apps/web/src/App.tsx`:

Add the imports:

```tsx
import { AccountChip } from './components/AccountChip.js';
import { getMe, signOut, type Me } from './lib/booking.js';
```

Add state beside the existing `useState` calls:

```tsx
const [me, setMe] = useState<Me | null>(null);
```

Load it in the existing mount effect, alongside `getFacets` and `createSession`:

```tsx
getMe().then(setMe).catch(() => setMe({ buyer: null, bookingEnabled: false }));
```

Add the handler beside the other callbacks:

```tsx
const handleSignOut = useCallback(async () => {
  await signOut().catch(() => {});
  setMe((prev) => (prev ? { ...prev, buyer: null } : prev));
}, []);
```

Render it in the header as the last child, after the stats block:

```tsx
<AccountChip me={me} onSignOut={handleSignOut} />
```

- [ ] **Step 7: Verify in the browser**

Start the dev server and check the header. Expected: a quiet "Sign in with Google" chip when signed out. With `GOOGLE_CLIENT_ID` set, clicking it reaches Google's consent screen; after consent the header shows the name and email and a "Sign out" button that returns it to the signed-out state. Confirm `GET /api/me` returns `bookingEnabled: true` once `connect:calendar` has run.

- [ ] **Step 8: Commit**

```bash
npm run typecheck
git add apps/web/src/lib/booking.ts apps/web/src/lib/booking.test.ts apps/web/src/components/AccountChip.tsx apps/web/src/App.tsx
git commit -m "Add the booking API client and the header account chip"
```

---

### Task 13: The booking button and modal

**Files:**
- Modify: `apps/web/src/components/PropertyCard.tsx` (restructure — see Step 1)
- Modify: `apps/web/src/components/ResultsGrid.tsx` (pass the handler through)
- Modify: `apps/web/src/components/ChatPanel.tsx` (allow a `system` message role)
- Create: `apps/web/src/components/BookingModal.tsx`
- Modify: `apps/web/src/App.tsx` (modal state, confirmation note)

**Interfaces:**
- Consumes: everything from Task 12, plus `Listing`, `Availability`, `Booking` from `@zameen/shared`.
- Produces: `BookingModal({ listing, me, onClose, onBooked })`; `PropertyCard` gains `onBook?: (listing: Listing) => void` and `bookingEnabled?: boolean`; `ResultsGrid` gains the same two props; `ChatMessage.role` widens to include `'system'`.

- [ ] **Step 1: Restructure PropertyCard**

The card is currently one big `<a>`. A `<button>` nested inside an `<a>` is invalid HTML, and the click bubbles and navigates away instead of opening the modal — so the anchor has to shrink to cover only the media and body, with the button as its sibling.

Replace `apps/web/src/components/PropertyCard.tsx` with:

```tsx
import type { Listing } from '@zameen/shared';
import { compactArea, floorLabel, priceWithPeriod, truncate } from '../lib/format.js';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

interface Props {
  listing: Listing;
  index: number;
  onBook?: (listing: Listing) => void;
  bookingEnabled?: boolean;
}

/**
 * The outer element is a div, not an anchor: the card carries two actions now,
 * and a <button> inside an <a> is invalid HTML whose click would navigate to
 * Zameen instead of opening the booking modal. The anchor covers the media and
 * body; the button is its sibling in the footer.
 */
export function PropertyCard({ listing, index, onBook, bookingEnabled = false }: Props) {
  const floor = floorLabel(listing);

  return (
    <div
      className="group animate-rise flex flex-col overflow-hidden rounded-xl border transition
                 hover:-translate-y-0.5 hover:shadow-lg focus-within:ring-2 focus-within:ring-brand-500"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--border)',
        // Stagger the entrance so a grid of results cascades in.
        animationDelay: `${Math.min(index, 12) * 30}ms`,
      }}
    >
      <a
        href={listing.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-1 flex-col focus:outline-none"
      >
        <div className="relative h-40 overflow-hidden bg-slate-200 dark:bg-slate-800">
          {listing.coverPhoto ? (
            <img
              src={listing.coverPhoto}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <div
              className="flex h-full items-center justify-center text-xs"
              style={{ color: 'var(--muted)' }}
            >
              No photo
            </div>
          )}

          <div className="absolute left-2 top-2 flex gap-1.5">
            <span
              className={`rounded-md px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur ${
                listing.purpose === 'rent' ? 'bg-sky-600/90' : 'bg-brand-600/90'
              }`}
            >
              {listing.purpose === 'rent' ? 'For Rent' : 'For Sale'}
            </span>
            {listing.isVerified && (
              <span className="rounded-md bg-amber-500/90 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                Verified
              </span>
            )}
          </div>

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2 pt-6">
            <p className="text-base font-bold text-white">{priceWithPeriod(listing)}</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-3 p-3">
          <div>
            <h3 className="text-sm font-semibold leading-snug">{truncate(listing.title, 64)}</h3>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {listing.areaPath || listing.city}
            </p>
          </div>

          <div className="mt-auto grid grid-cols-3 gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border)' }}>
            <Stat label="Beds" value={listing.bedrooms > 0 ? String(listing.bedrooms) : '—'} />
            <Stat label="Baths" value={listing.bathrooms > 0 ? String(listing.bathrooms) : '—'} />
            <Stat label="Area" value={compactArea(listing.areaSqft)} />
          </div>

          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--muted)' }}>
            <span>{listing.propertyType}</span>
            {floor && (
              <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border)' }}>
                {floor}
              </span>
            )}
          </div>
        </div>
      </a>

      {onBook && (
        <div className="border-t p-3 pt-2.5" style={{ borderColor: 'var(--border)' }}>
          <button
            type="button"
            disabled={!bookingEnabled}
            onClick={() => onBook(listing)}
            title={bookingEnabled ? undefined : 'Viewing bookings are not configured on this server.'}
            className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white transition
                       hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Book a viewing
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Pass the handler through ResultsGrid**

In `apps/web/src/components/ResultsGrid.tsx`, add to `Props`:

```tsx
  onBook?: (listing: Listing) => void;
  bookingEnabled?: boolean;
```

Take them in the signature — `export function ResultsGrid({ listings, busy, source, onBook, bookingEnabled }: Props)` — and forward them on the card:

```tsx
        <PropertyCard
          key={`${listing.purpose}-${listing.externalId}`}
          listing={listing}
          index={i}
          {...(onBook ? { onBook } : {})}
          bookingEnabled={bookingEnabled ?? false}
        />
```

- [ ] **Step 3: Allow a system note in the chat**

In `apps/web/src/components/ChatPanel.tsx`, widen the role on line 5:

```tsx
  role: 'user' | 'assistant' | 'system';
```

In the message map (around line 113), return a centred note before the existing user/assistant branch:

```tsx
          if (m.role === 'system') {
            return (
              <div key={m.id} className="flex justify-center">
                <p
                  className="rounded-lg border px-2.5 py-1.5 text-center text-[11px]"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  {m.content}
                </p>
              </div>
            );
          }
```

- [ ] **Step 4: Write the modal**

Create `apps/web/src/components/BookingModal.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Availability, Booking, Listing, Slot } from '@zameen/shared';
import {
  BookingError,
  createBooking,
  dayLabel,
  getAvailability,
  slotLabel,
  slotRangeLabel,
  type Me,
} from '../lib/booking.js';

interface Props {
  listing: Listing;
  me: Me | null;
  onClose: () => void;
  onBooked: (booking: Booking) => void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea';

export function BookingModal({ listing, me, onClose, onBooked }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [step, setStep] = useState<'slot' | 'details' | 'done'>('slot');
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [failure, setFailure] = useState<{ field?: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState<Booking | null>(null);

  // Google supplies name and email; phone is whatever we remembered from a
  // previous booking, because Google never returns one.
  useEffect(() => {
    if (me?.buyer) setForm({ name: me.buyer.name, email: me.buyer.email, phone: me.buyer.phone });
  }, [me]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getAvailability();
      setAvailability(data);
      const firstOpen = data.days.findIndex((d) => d.slots.some((s) => s.available));
      setDayIndex(firstOpen >= 0 ? firstOpen : 0);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Trap focus inside the dialog, close on Escape, and hand focus back to the
  // button that opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [onClose]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;

    setSubmitting(true);
    setFailure(null);
    try {
      const created = await createBooking({
        purpose: listing.purpose,
        externalId: listing.externalId,
        startIso: selected.startIso,
        buyer: form,
      });
      setBooking(created);
      setStep('done');
      onBooked(created);
    } catch (err) {
      const error = err as BookingError;
      setFailure({ ...(error.field ? { field: error.field } : {}), message: error.message });
      // Someone took the slot while this form was open: go back and refresh the
      // grid, but keep everything they typed.
      if (error.status === 409) {
        setSelected(null);
        setStep('slot');
        void load();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const day = availability?.days[dayIndex];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Book a viewing for ${listing.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="scroll-slim max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border p-5 shadow-xl focus:outline-none"
        style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold leading-tight">Book a viewing</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              {listing.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg border px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            style={{ borderColor: 'var(--border)' }}
          >
            ✕
          </button>
        </div>

        {step === 'done' && booking ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold">You're booked in.</p>
            <p className="text-sm">{slotRangeLabel(booking.startIso, booking.endIso)}</p>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              An invite is on its way to {booking.buyerEmail}.
            </p>
            {booking.htmlLink && (
              <a
                href={booking.htmlLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs underline"
              >
                View it in Google Calendar
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white hover:bg-brand-700"
            >
              Done
            </button>
          </div>
        ) : null}

        {step === 'slot' ? (
          <div className="space-y-3">
            {failure && (
              <p className="rounded-lg border border-amber-500/50 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                {failure.message}
              </p>
            )}

            {loadError && (
              <div className="space-y-2">
                <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
                <button type="button" onClick={() => void load()} className="text-xs underline">
                  Try again
                </button>
              </div>
            )}

            {!availability && !loadError && (
              <div className="h-40 animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
            )}

            {availability && (
              <>
                <p className="text-xs font-medium">Pick a day</p>
                <div className="scroll-slim flex gap-1.5 overflow-x-auto pb-1">
                  {availability.days.map((d, i) => (
                    <button
                      key={d.date}
                      type="button"
                      disabled={!d.open}
                      onClick={() => setDayIndex(i)}
                      className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px] transition
                        disabled:cursor-not-allowed disabled:opacity-35
                        focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                        ${i === dayIndex ? 'bg-brand-600 text-white' : ''}`}
                      style={i === dayIndex ? {} : { borderColor: 'var(--border)' }}
                    >
                      {dayLabel(d.date)}
                    </button>
                  ))}
                </div>

                <p className="text-xs font-medium">
                  Pick a time{availability.slotMinutes ? ` (${availability.slotMinutes} minutes)` : ''}
                </p>
                {day?.open ? (
                  <div className="grid grid-cols-4 gap-1.5">
                    {day.slots.map((slot) => (
                      <button
                        key={slot.startIso}
                        type="button"
                        disabled={!slot.available}
                        onClick={() => {
                          setSelected(slot);
                          setStep('details');
                          setFailure(null);
                        }}
                        className="rounded-lg border px-2 py-1.5 text-[11px] transition
                                   enabled:hover:shadow-sm disabled:cursor-not-allowed
                                   disabled:line-through disabled:opacity-35
                                   focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        {slotLabel(slot.startIso)}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    Closed that day — pick another.
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}

        {step === 'details' && selected ? (
          <form className="space-y-3" onSubmit={submit}>
            <div
              className="flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              <span>{slotRangeLabel(selected.startIso, selected.endIso)}</span>
              <button type="button" onClick={() => setStep('slot')} className="underline">
                Change
              </button>
            </div>

            {(['name', 'email', 'phone'] as const).map((field) => (
              <label key={field} className="block">
                <span className="text-xs font-medium capitalize">
                  {field === 'phone' ? 'Phone number' : field}
                </span>
                <input
                  required
                  type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
                  value={form[field]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field]: e.target.value }))}
                  placeholder={field === 'phone' ? '0300 1234567' : undefined}
                  className="mt-1 w-full rounded-lg border px-2.5 py-1.5 text-sm
                             focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  style={{ background: 'transparent', borderColor: 'var(--border)' }}
                />
                {failure?.field === field && (
                  <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                    {failure.message}
                  </span>
                )}
              </label>
            ))}

            {failure && !failure.field && (
              <p className="text-[11px] text-red-600 dark:text-red-400">{failure.message}</p>
            )}

            <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
              The agent needs your phone number to confirm — Google never shares one.
            </p>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white
                         transition hover:bg-brand-700 disabled:opacity-50
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {submitting ? 'Booking…' : 'Confirm viewing'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the modal into App**

In `apps/web/src/App.tsx`:

```tsx
import { BookingModal } from './components/BookingModal.js';
import type { Booking } from '@zameen/shared';
```

State:

```tsx
const [booking, setBooking] = useState<Listing | null>(null);
```

Handlers:

```tsx
const handleBooked = useCallback((made: Booking) => {
  setMessages((prev) => [
    ...prev,
    {
      id: `sys-${made.eventId}`,
      role: 'system',
      content: `Viewing booked for ${slotRangeLabel(made.startIso, made.endIso)}. An invite is on its way to ${made.buyerEmail}.`,
    },
  ]);
}, []);
```

Import `slotRangeLabel` alongside the other `./lib/booking.js` imports. Pass the handler into the grid:

```tsx
<ResultsGrid
  listings={listings}
  busy={searchBusy}
  source={source}
  onBook={setBooking}
  bookingEnabled={me?.bookingEnabled ?? false}
/>
```

And render the modal as the last child of the outer `div`, so it overlays everything:

```tsx
{booking && (
  <BookingModal
    listing={booking}
    me={me}
    onClose={() => setBooking(null)}
    onBooked={handleBooked}
  />
)}
```

- [ ] **Step 6: Verify in the browser**

Run the dev server, search for anything, and check each of these:

1. Clicking the card body still opens the Zameen listing in a new tab.
2. Clicking **Book a viewing** opens the modal and does **not** navigate.
3. The day strip shows 14 days with Sundays greyed out; times load from one `/api/availability` request (confirm in the network panel).
4. Picking a time moves to the details step, pre-filled if signed in, with phone always editable.
5. Submitting creates the event — check it in Google Calendar, and confirm the description carries name, email and phone.
6. The buyer receives the invite email.
7. A booked slot shows struck through the next time the modal opens.
8. `Escape` closes the modal and focus returns to the **Book a viewing** button.
9. With `GOOGLE_CLIENT_ID` unset, the button is disabled and its tooltip explains why.

- [ ] **Step 7: Run everything and commit**

```bash
npm test
npm run typecheck
git add apps/web/src/
git commit -m "Add the viewing booking button and modal"
```
