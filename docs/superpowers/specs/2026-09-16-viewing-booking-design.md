# Viewing Booking — Design

**Date:** 2026-09-16
**Status:** Approved, not yet implemented

A buyer who has settled on a listing books a 1-on-1 viewing with the estate agent from a form on the property card. The form shows the estate agent's real free slots, taken from their Google Calendar, and the confirmed booking becomes a calendar event carrying the buyer's name, email and phone — with the buyer invited as an attendee, so Google emails them the invite.

## Decisions

| Decision | Choice |
|---|---|
| Calendar | **One** estate-agent calendar for all listings; connected once via OAuth |
| Entry point | "Book a viewing" button on `PropertyCard`, opening a modal form |
| Storage | **None added.** Google Calendar holds bookings; buyer identity is a signed cookie |
| Google client | Hand-rolled `fetch` against four REST endpoints — no `googleapis` SDK |
| Buyer identity | Google sign-in (`openid email profile`) fills name + email; phone always asked |
| Attendees | Buyer is added as an attendee with `sendUpdates: 'all'` |
| Audience | Demo scale. OAuth consent screen stays in **Testing** status |

### Why no datastore

Three things could have needed one, and none does:

- **Bookings** — Google Calendar is already the system of record, and it is the surface the estate agent actually uses. A second copy would only drift.
- **The estate agent's refresh token** — obtained once by a local CLI, written to a gitignored file for development and passed as an env var in production. Identical in shape to how `VECTARA_API_KEY` is already handled.
- **Buyer identity** — an HMAC-signed cookie is stateless, so it survives Cloud Run scaling to zero and works unchanged across multiple instances.

Firestore was considered and rejected: it buys reconnect-without-redeploy and a booking history, neither of which is worth a new GCP dependency at one calendar and a handful of users. SQLite was rejected outright — Cloud Run's filesystem is ephemeral and instances do not share it.

## Scope

**In:** estate-agent calendar connection, buyer Google sign-in, availability lookup, the booking form, event creation with attendee invite, and the disconnected-calendar state.

**Out, deliberately:** rescheduling and cancellation, per-listing or per-agent calendars, an agent-facing admin UI, SMS or WhatsApp confirmation, and any booking history page. The Vectara agent is **not** told that a booking happened (see Known limits).

## Architecture

```
Buyer clicks "Book a viewing" on a PropertyCard
      │
      ▼
BookingModal ──GET /api/me──► { buyer | null, bookingEnabled }
      │                            └─ name+email from the signed cookie, or empty
      ▼
 ──GET /api/availability──► ONE freeBusy call spanning the whole 14-day window
      │                            │
      │  ◄──── 14 days x 8 slots, each flagged free or taken ────┘
      ▼
Step 1: pick day + slot      (instant — no further network)
Step 2: name · email · phone (phone always required)
      ▼
POST /api/bookings
      ├─ re-fetch the listing from the corpus by id   (client input is not trusted)
      ├─ re-check freeBusy for that exact slot        (narrows the race)
      └─ events.insert + sendUpdates=all
              ├──► Google emails the buyer a real invite
              └──► event lands in the estate agent's calendar
```

Fetching the **entire window in one `freeBusy` call** rather than one call per date means the buyer can click through all fourteen days with zero latency, and a modal session costs exactly one Google API call.

## The two OAuth flows

They are genuinely different and share only the OAuth client.

### Estate agent — once, by hand, offline

`npm run connect:calendar` runs a standalone `tsx` script. It opens a loopback listener on `:5858`, prints the consent URL, captures the code, exchanges it, writes `.google-token.json` (gitignored, exactly like `.vectara-state.json`), and prints the `GOOGLE_REFRESH_TOKEN=` line to paste into `gcloud run deploy`.

- Scopes: `https://www.googleapis.com/auth/calendar.freebusy` and `https://www.googleapis.com/auth/calendar.events`, plus `openid email`.
- **Corrected from an original `calendar.events`-only design.** Live testing against a real Google token — the failure mode no mock can reproduce — showed that `freebusy.query` accepts only `calendar`, `calendar.readonly`, `calendar.freebusy` or `calendar.events.freebusy`, and never `calendar.events`. A token scoped for `calendar.events` alone can create the booking but gets `403 insufficientPermissions` the instant it checks whether a slot is free, so both scopes are required and neither implies the other.
- **`access_type=offline&prompt=consent` is mandatory.** Without `prompt=consent`, a *repeat* authorization of an already-authorized client returns no `refresh_token` at all, and the script silently produces nothing usable.
- This never runs on the deployed service. That is what keeps the private-Cloud-Run problem away from the estate-agent side entirely.

### Buyer — in the browser, optional

`GET /api/auth/google` → consent → `GET /api/auth/google/callback` → signed cookie → `302 /`.

- Scopes: `openid email profile` and nothing else. These are **non-sensitive**, so buyers never see the "Google hasn't verified this app" warning — only the estate-agent flow requests a sensitive scope, and that is one person, once.
- CSRF: a random `state` nonce is stored in a short-lived signed cookie and compared on callback. A mismatch is a hard `400`.
- The profile is read from `GET https://www.googleapis.com/oauth2/v3/userinfo` with the bearer token, not by decoding the `id_token`. The token came straight from Google over TLS, so there is no JWT signature to verify and no library needed.

### Google endpoints used

Four, which is why the `googleapis` SDK is not worth ~20 MB in the image:

```
POST https://oauth2.googleapis.com/token                        code exchange + refresh
GET  https://www.googleapis.com/oauth2/v3/userinfo              buyer profile
POST https://www.googleapis.com/calendar/v3/freeBusy            availability
POST https://www.googleapis.com/calendar/v3/calendars/{id}/events   create booking
```

Access tokens are cached in memory until 60 s before expiry and refreshed on demand.

## Identity, and the phone-number constraint

**Google OAuth does not return a phone number.** `openid email profile` yields name, email and avatar. A phone would require the People API with `user.phonenumbers.read`, and it is empty for the large majority of accounts because almost nobody adds a phone to their Google profile.

So the requirement "fetch name, email and phone automatically when logged in" holds for two fields out of three:

| Field | Signed in with Google | Not signed in |
|---|---|---|
| Name | Pre-filled, editable | Asked |
| Email | Pre-filled, editable | Asked |
| Phone | **Asked** (remembered in the cookie after the first booking) | Asked |

After any successful booking the full set — including phone — is written back to the cookie, so a returning buyer's second booking is pre-filled in all three fields regardless of how they identified themselves.

### Cookie format

```
zameen_buyer = base64url(JSON) "." base64url(hmacSHA256(base64url(JSON), SESSION_SECRET))
```

Payload `{ name, email, phone, via: 'google' | 'manual' }`. Verified with `crypto.timingSafeEqual`.

Attributes: `HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`, plus `Secure` when `PUBLIC_BASE_URL` is https.

`SameSite=Lax` is load-bearing and must not be tightened to `Strict` — `Strict` withholds the cookie on the top-level redirect back from Google, so the buyer would land signed-out immediately after signing in.

### Validation

Every field is re-validated server-side even when it arrived from the signed cookie.

- **Name** — 2–80 characters after trimming.
- **Email** — `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`. No verification beyond that; a wrong address simply bounces the invite.
- **Phone** — separators stripped, then: `0` + 10 digits is normalised to `+92…` (Pakistani mobile and landline); a leading `+` with 8–15 digits is accepted as-is, which matters because overseas Pakistanis are a real share of Zameen buyers. Anything else is rejected.
- **Control characters and newlines are stripped from all three.** They are interpolated into the event description, and without this a buyer could inject convincing fake lines into what the estate agent reads.

## Availability engine

Pakistan is **UTC+5 all year** — DST was abolished in 2009 — so every timestamp is built with a literal `+05:00` offset rather than the server's local clock. This is not incidental: Cloud Run runs in UTC, where `new Date('2026-09-20T11:00')` would silently mean 16:00 Karachi.

Two library-free primitives carry the timezone work:

```ts
const PKT = 5 * 3600 * 1000;
// Calendar date in Karachi for an epoch instant: shift, then read UTC fields.
const pktDate    = (ms: number) => new Date(ms + PKT).toISOString().slice(0, 10);
const pktWeekday = (ms: number) => new Date(ms + PKT).getUTCDay();
// A Karachi wall-clock time as an instant:
const at = (date: string, hour: number) => Date.parse(`${date}T${pad(hour)}:00:00+05:00`);
```

Defaults, all env-overridable:

| | |
|---|---|
| Viewing length | 45 min (`BOOKING_SLOT_MINUTES`) |
| Grid | every 60 min (`BOOKING_GRID_MINUTES`) |
| Day | 11:00 → 19:00 PKT — 8 slots, 11:00 through 18:00, last ending 18:45 |
| Open days | Mon–Sat; Sunday closed (`BOOKING_CLOSED_DAYS=0`) |
| Window | tomorrow through 14 days out (`BOOKING_LEAD_DAYS=1`, `BOOKING_WINDOW_DAYS=14`) |

The 15-minute gap between a 45-minute viewing and the next hourly slot is the travel buffer, and it comes free from the grid rather than from separate buffer logic.

The engine is **one pure function** — no network, no ambient clock, no timezone library, with `now` and `busy` injected:

```ts
slotsForWindow(now: number, busy: BusyInterval[], cfg: BookingConfig): AvailabilityDay[]
```

Overlap is `slot.start < busy.end && busy.start < slot.end`. Strict inequalities matter: an event ending at exactly 15:00 must **not** block the 15:00 slot. A single long event correctly blocks every slot it spans.

`freeBusy` excludes events marked transparent ("free") and reports all-day events as busy for the whole day — both the behaviour we want. How it treats events the estate agent has *declined* is not something this design relies on; if declined events turn out to block slots, the fix is to mark them free, not to change this code.

## The calendar event

```
summary      Property viewing — 3 bed Flat, Clifton
location     Karachi › Clifton › Block 2
start/end    2026-09-20T15:00:00+05:00 → 15:45   (timeZone: Asia/Karachi)
attendees    [ { email: buyer.email, displayName: buyer.name } ]
description  Buyer: Asad Khan · asad@example.com · +923001234567
             Listing: PKR 2.5 lakh/month · 3 bed · 1,800 sq ft
             https://www.zameen.com/Property/...
extendedProperties.private
             { listingId, purpose, buyerName, buyerEmail, buyerPhone, bookedVia }
reminders    popup 60 min · email 1 day
sendUpdates  all
```

The buyer's details are written **twice, on purpose**: `extendedProperties.private` is structured and reads back out cleanly, but Google's UI never displays it — the description is what the estate agent actually sees on their phone.

`sendUpdates: 'all'` is what makes Google email the invite. It is an outbound message on the buyer's behalf, chosen deliberately: the buyer submitted the form, and the invite is what makes the meeting exist on both sides.

The event body is produced by a **pure function** of `(listing, buyer, slot, cfg)`, so it is testable without touching the network.

## API surface

Mounted before `mountWebClient`, per the existing warning in `apps/server/src/index.ts` that `/api` routes must never be shadowed by the SPA fallback.

```
GET  /api/me                    → { buyer: BuyerDetails | null, bookingEnabled: boolean }
GET  /api/auth/google           → 302 to Google  (openid email profile)
GET  /api/auth/google/callback  → verify state → exchange → set cookie → 302 /
POST /api/auth/logout           → clear cookie
GET  /api/availability          → { tz, slotMinutes, days: AvailabilityDay[] }
POST /api/bookings              → { purpose, externalId, startIso, buyer } → { booking }
```

Status codes are part of the contract, because the modal reacts differently to each:

| Code | Cause | Modal behaviour |
|---|---|---|
| `409` | Slot taken between load and submit | Refresh the grid, keep the typed details, return to step 1 |
| `422` | Invalid name / email / phone | Inline field error |
| `503` | Not configured, **or Google returned `invalid_grant`** | "The agent's calendar isn't connected" |
| `502` | Any other Google upstream failure | Retry affordance |

The `invalid_grant` → `503` mapping is the one that matters most in practice: it is exactly what the 7-day Testing-mode token expiry looks like on the wire, and it is the failure this deployment will hit most often. Its message names `npm run connect:calendar` explicitly rather than failing generically.

### Shared types

```ts
// packages/shared/src/booking.ts
export interface BuyerDetails { name: string; email: string; phone: string }
export interface Slot { startIso: string; endIso: string; available: boolean }
export interface AvailabilityDay { date: string; weekday: number; open: boolean; slots: Slot[] }
export interface BookingRequest { purpose: Purpose; externalId: string; startIso: string; buyer: BuyerDetails }
export interface Booking { eventId: string; htmlLink: string; startIso: string; endIso: string; listingTitle: string; buyerEmail: string }
```

## Trust boundaries

The model's output is already treated as untrusted in `criteria.ts`; the client's is treated the same way here.

- **The listing never comes from the client.** The request carries only `{ purpose, externalId }`; the server re-reads the document at `GET /v2/corpora/{key}/documents/{purpose}-{externalId}` and rebuilds it with the existing `listingFromMetadata`. Without this, anyone could `POST` arbitrary text straight into the estate agent's calendar.
- **The slot is re-checked** against the live calendar, never trusted from the grid the client was shown.
- **Buyer fields are re-validated and stripped** of control characters even when they arrived from the signed cookie.
- **The `state` nonce** is verified on every OAuth callback.

## UI

### PropertyCard needs restructuring, not just a button

The whole card is currently a single `<a>`. A `<button>` nested inside an `<a>` is invalid HTML — nested interactive content — and the click bubbles, navigating to zameen.com instead of opening the modal.

The card becomes a `<div>` with the existing styling; the image, title and stats region stays an `<a>`; and a footer action row holds **Book a viewing** as a sibling `<button>`. The `group` hover class moves to the wrapper and the focus ring is applied to both children.

### BookingModal

1. **Pick a slot** — 14 day chips with Sundays greyed out, 8 hourly slots, taken ones disabled and struck through. Skeleton while the single availability call resolves.
2. **Your details** — name, email, phone, pre-filled where known. Phone is always required.
3. **Confirmed** — the time, the property, "an invite is on its way to *email*", and a link to the event.

Focus trap, `Escape` to close, `aria-modal`, and focus returned to the triggering button.

### Header

A quiet "Sign in with Google" chip, becoming name + sign out once signed in. Quiet deliberately: in Testing status only listed test users can sign in at all, so the manual details path is the **primary** route and the UI must not imply otherwise.

### After a successful booking

A confirmation line is appended to the chat transcript as a system note, styled distinctly from assistant prose. No LLM call.

## Configuration

Every new variable is optional. This matters — `apps/server/src/config.ts` currently calls `required()` for the Vectara key and throws at import time, and the app must still boot and search normally with no Google configuration at all.

```
GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · GOOGLE_REFRESH_TOKEN
GOOGLE_CALENDAR_ID=primary
PUBLIC_BASE_URL=http://localhost:5173
SESSION_SECRET                 # random at boot if unset → cookies do not survive a restart
BOOKING_SLOT_MINUTES=45 · BOOKING_GRID_MINUTES=60
BOOKING_DAY_START=11 · BOOKING_DAY_END=19
BOOKING_LEAD_DAYS=1 · BOOKING_WINDOW_DAYS=14
BOOKING_CLOSED_DAYS=0 · BOOKING_TZ_OFFSET=+05:00
```

`bookingEnabled` is false when any of the three Google values is missing. The button then renders **disabled with an explanatory tooltip** rather than disappearing — visible and explicable beats silently absent.

The refresh token is read from `GOOGLE_REFRESH_TOKEN` if set, otherwise from `.google-token.json`. Production uses the env var; development uses the file.

### Google Cloud console prerequisites

Done once, by hand, and written into `DEPLOY.md`:

1. Enable the Google Calendar API on the project.
2. Create an OAuth client of type **Web application**.
3. Register redirect URIs: `http://localhost:5858/callback` (the connect script), `http://localhost:5173/api/auth/google/callback` (dev), and `<PUBLIC_BASE_URL>/api/auth/google/callback` (production).
4. Configure the consent screen with **both** the `calendar.freebusy` and `calendar.events` scopes — `calendar.events` alone cannot call `freebusy.query` — and add yourself — plus any buyer testers — as test users.

## Testing

Pure units first, TDD, co-located `*.test.ts` as the repo already does.

**`availability.test.ts`** — empty calendar; one long event swallowing five slots; back-to-back events; Sunday skipped; past slots excluded; the lead-day and window-end boundaries; a fully booked day; and an event ending exactly when a slot starts, which must **not** block it.

**`buyer.test.ts`** — sign/verify round trip; tampered payload rejected; truncated signature rejected; email and name validation; Pakistani phone formats (`+92 3xx…`, `03xx…`, landline) and an international number; newline stripping.

**`event.test.ts`** — the offset is always `+05:00`; all three buyer fields appear in the description; `extendedProperties` is populated; the summary is built from the listing.

**`oauth.test.ts`** — auth URL scopes and parameters, including `access_type=offline&prompt=consent` on the estate-agent flow; state mismatch rejected.

**Route tests** with `fetch` mocked — `409` on a taken slot, `503` on `invalid_grant`, `422` on a bad phone, and the security case: a forged listing payload in the request body is ignored in favour of the corpus re-fetch.

Network-touching code (`calendar.ts`, token refresh) stays deliberately thin, so the mocked route tests are sufficient coverage for it.

## File plan

| New | Changed |
|---|---|
| `packages/shared/src/booking.ts` | `apps/server/src/config.ts` |
| `apps/server/src/booking/config.ts` | `apps/server/src/index.ts` |
| `apps/server/src/booking/availability.ts` + test | `apps/web/src/components/PropertyCard.tsx` |
| `apps/server/src/booking/event.ts` + test | `apps/web/src/components/ResultsGrid.tsx` |
| `apps/server/src/booking/calendar.ts` | `apps/web/src/App.tsx` |
| `apps/server/src/google/oauth.ts` + test | `package.json` |
| `apps/server/src/google/tokens.ts` | `.env.example` · `.gitignore` |
| `apps/server/src/buyer.ts` + test | `README.md` · `DEPLOY.md` |
| `apps/server/src/routes/auth.ts` · `routes/booking.ts` | |
| `apps/server/src/connect-calendar.ts` | |
| `apps/web/src/components/BookingModal.tsx` · `AccountChip.tsx` | |
| `apps/web/src/lib/booking.ts` | |

The booking logic splits into a pure engine, a pure event builder, a thin network wrapper and routes, so each file stays small enough to reason about whole.

## Known limits

- **The double-booking race is narrowed, not eliminated.** Google Calendar does not enforce slot exclusivity. Two buyers who both load the modal, both see 15:00 free and both submit will both get the event. Re-checking `freeBusy` immediately before `events.insert` shrinks the window to milliseconds; a genuine fix needs a lock, and a lock needs the datastore this design deliberately avoids.
- **`POST /api/bookings` requires no authentication and is not rate-limited.** Anyone who can reach it can fill all 112 bookable slots in the 14-day window (14 days × 8 slots/day) in seconds, and every accepted booking makes Google send a real calendar invite from the estate agent to whatever address the caller supplies. An in-memory per-IP counter would not fix this on Cloud Run — every instance keeps its own count and the service scales to zero, so it is trivial to evade — which is why no rate limiter is implemented; the de facto mitigation today is that the Cloud Run service itself is private.
- **Refresh tokens expire after 7 days** while the OAuth consent screen is in Testing status. `npm run connect:calendar` is the fix, and the `503` state makes it visible rather than mysterious. Publishing the consent screen to Production removes the expiry but requires Google verification for the sensitive `calendar.events` scope.
- **Buyer Google sign-in works only for listed test users** (max 100), for the same reason. Everyone else uses the manual path, which is why that path is treated as primary rather than as a fallback.
- **OAuth cannot work on the current deployment.** The Cloud Run service is private — `--allow-unauthenticated` was blocked by holding only `roles/editor` — and Google redirects the browser with no auth header. Buyer sign-in therefore works locally but not in production until an owner runs the `run.invoker` binding in `DEPLOY.md`, or the service moves to the `zameen-ai-agent` project. The estate-agent connection is unaffected, because it never runs on the deployed service.
- **The Google client secret and refresh token will sit in plain env vars** on that project, alongside the Vectara key, since `roles/editor` cannot read Secret Manager versions. They are readable by anyone with view access on the project.
- **The Vectara agent does not know a booking happened.** A buyer who asks the assistant "when is my viewing?" gets nothing useful. Telling it would cost an extra LLM turn on the success path and add a failure mode there; the local confirmation note covers the user-visible need.
- **No rescheduling or cancellation.** The buyer manages the meeting from the Google invite they receive; the estate agent manages it from their calendar.
