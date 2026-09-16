# Zameen AI Agent

Conversational property search over live Zameen.com Karachi listings, powered by a **Vectara agent**.

The assistant asks which area you want, whether you're renting or buying, and what else matters (bedrooms, budget, floor) — then searches 400 real listings and explains the matches, while a synced filter panel shows the property cards.

```
React + Vite  ──SSE──►  Node + Express  ──────►  Vectara Agent
(chat + filters)        (holds the API key)      │
                             │                   └─ tool: search_properties (lambda)
                             │                          captures structured criteria
                             ▼
                        exact metadata filter ──► corpus: 400 Karachi listings
                             │
                             └─ listings fed back to the agent to describe
```

## Quick start

```bash
npm install
cp .env.example .env    # add your VECTARA_API_KEY
npm run bootstrap       # scrape 400 listings, normalize, provision Vectara
npm run dev             # API on :8787, UI on :5173
```

Open <http://localhost:5173>.

## Layout

| Path | What it is |
|---|---|
| `packages/shared` | `Listing`/`SearchFilters` types, the metadata-filter builder, floor parsing |
| `packages/ingest` | Scraper, normalizer, and the Vectara provisioning script |
| `apps/server` | Express API: session, SSE chat proxy, deterministic search, facets |
| `apps/web` | React + Tailwind UI: chat pane, filter bar, result grid |
| `vectara/` | Agent instruction template and the `search_properties` lambda source |
| `data/` | Scraped snapshot (`listings.json`, `facets.json`) |
| `Dockerfile` | Multi-stage image serving API + client from one origin |

## Scripts

| Command | Effect |
|---|---|
| `npm run scrape` | Backfill: fetch 200 rent + 200 buy listings from Zameen |
| `npm run normalize` | Build `data/listings.json` from the backfill |
| `npm run setup:vectara` | Create corpus, index the backfill, create/update the chat agent |
| `npm run setup:agent` | Update **only** the chat agent (fast — skips re-indexing) |
| `npm run setup:pipeline` | Create/update the daily ingestion pipeline, its transform agent and validator |
| `npm run pipeline:run` | Trigger an ingestion run now and follow it |
| `npm run pipeline:status` | Show recent ingestion runs |
| `npm run pipeline:failures` | Show dead-lettered records, grouped by cause |
| `npm run dev` | Run API and UI together |
| `npm test` | Run the test suite |
| `npm run connect:calendar` | One-time: mint the estate agent's Google Calendar refresh token |

## Keeping the corpus fresh

Two paths write to the corpus, deliberately:

**Backfill (`npm run bootstrap`)** — parses `window.state` out of 16 listing index pages and indexes 400 properties with *deterministic* metadata. Fast, free, exact. Use it to seed a new corpus.

**Daily pipeline (`zameen_karachi_daily`)** — a native Vectara ingestion pipeline. Vectara's own crawler fetches pages (honouring `robots.txt`, 1 req/s), hands each to the `zameen_ingest_agent` transform, and the agent extracts fields, validates them and indexes one document per property.

```
trigger:    cron "0 3 * * *"   (08:00 Pakistan time)
sync_mode:  incremental
source:     web / crawl, seeded from the 16 index pages, max_pages 400
transform:  agent -> validate_listing -> core_document_index (reindex: true)
```

Runs are **additive**: the agent checks `get_document` for `rent-<id>` / `buy-<id>` first and skips anything already in the corpus, so only genuinely new listings cost an extraction and existing documents are never overwritten. `first_seen_at` / `last_seen_at` keep stale listings identifiable for a later prune.

Two things about crawl mode worth knowing before you tune it:

- **`max_pages` is a soft hint**, not a cap — a run configured with 40 fetched 713. The real bound is `max_depth: 1`, which works out to roughly one index page's worth of links per seed. To shrink a run, use fewer seeds rather than a lower `max_pages`.
- **`pos_regex` gates link *expansion*, not just what is kept.** Setting it to `/Property/` stops the `/Rentals/` and `/Homes/` seeds from ever being expanded, and the crawl never leaves depth 0. It is deliberately unset; `neg_regex` keeps the budget on listings instead — and those patterns must not carry trailing slashes, because the real nav links are `/tools` and `/plots.html`.

**Metadata from the pipeline is LLM-extracted, not parsed**, so it is less reliable than the backfill. `validate_listing` is the guard — it range-checks prices against plausible Karachi bounds, rejects impossible bedroom counts and areas, and constrains every enum. The pipeline's `transform.verification` keys off its `success` flag, so a bad extraction **fails the record instead of entering the corpus**.

Why not parse deterministically inside the pipeline? Every route is closed: `window.state` is a single ~700 KB line (too large for a model turn), `artifact_grep` is positionless and returns 432 ambiguous matches on a page that embeds "similar properties", `artifact_jq` needs JSON rather than HTML, and lambda tools can neither read artifacts nor accept 700 KB arguments.
| `npm run build` | Build shared, server, and the client bundle |

## Deploying

The API and the built client ship as a single Cloud Run service, so the
browser's relative `/api` paths and the SSE chat stream stay same-origin.
See [DEPLOY.md](DEPLOY.md).

## How filtering stays exact

Both search paths run through the same `buildMetadataFilter`, in TypeScript, so neither depends on the model getting filter syntax right:

- **Sidebar** → `POST /api/search` builds the filter and queries the corpus directly. No LLM in the path.
- **Chat** → the agent calls the `search_properties` tool with *structured arguments* (`purpose`, `area`, `min_bedrooms`, …). The server validates them, builds the same filter, runs the query, and hands the results back to the agent to describe.

A chat search therefore runs as two agent turns with our own exact query in between. The agent never sees unfiltered data and only ever describes listings that genuinely matched.

### Why not let the agent write the filter?

The built-in `corpora_search` tool does expose `metadata_filter` in its schema, but the surrounding `search` object is not model-fillable — across two experiments the model only ever emitted `query`, even when the tool returned `corpora should have at least 1 items` 17 times in a row. Its `corpora` array can only be set via `argument_override`, and setting that satisfies the schema's required `search` property, at which point the model stops sending one at all and searches run **silently unfiltered**.

A lambda tool's input schema is generated from its Python signature and is therefore flat, which the model fills reliably. The lambda itself cannot search — the sandbox has no network access and cannot invoke other tools — so it validates the criteria and the server does the query.

Every filterable attribute also has a lowercase `*_norm` twin (`area_l3_norm`, `property_type_norm`) so a casing mistake can't silently return zero results.

## Booking a viewing

A buyer can book a viewing on any listing, checked live against the estate agent's Google Calendar. Getting there takes two one-time setup steps; day-to-day booking needs none.

**Connect the calendar once** — `npm run connect:calendar` runs a short local OAuth flow: it prints a consent URL, listens on `localhost:5858` for the callback, and once you grant the two scopes it asks for — `calendar.freebusy` and `calendar.events` — it writes `.google-token.json` (gitignored) and prints a `GOOGLE_REFRESH_TOKEN=` line to carry into the Cloud Run deploy command. Both scopes are required: `calendar.events` creates the booking, but Google's `freebusy.query` does not accept it, so checking whether a slot is free needs `calendar.freebusy` too. It only ever runs on a developer's machine, never on the deployed service — see [DEPLOY.md](DEPLOY.md) for why. Until it has run once, `/api/availability` and `/api/bookings` respond `503` and the UI disables "Book a viewing". **Already connected before `calendar.freebusy` existed?** Adding a scope to the code does not upgrade a refresh token that was already issued — re-run `npm run connect:calendar` or booking keeps failing the same way.

**Google sign-in still asks for a phone number** — signing in fills in name and email, but Google's identity scopes never return a phone number, so the booking form always asks for one; the agent needs a way to reach a buyer who never replies in chat. A returning buyer's phone is carried over from their last booking (in the same signed cookie as their identity) so it isn't retyped.

**Slots default to Karachi business hours** — 11:00–19:00, Monday–Saturday (Sunday closed), in 45-minute viewings on a 60-minute grid, the 15-minute gap being travel time between showings. Booking opens 1 day out and stays open on a rolling 14-day window; every one of those numbers is `BOOKING_*`-overridable (see the table below) if the agent's hours differ. The `+05:00` offset is fixed rather than computed, because Pakistan has had no DST since 2009.

**A `503` from booking means the connection dropped, not that something broke** — most often because the OAuth consent screen is still in *Testing* status, which caps a refresh token at 7 days; a revoked connection looks identical. Either way the fix is the same: re-run `npm run connect:calendar`.

## Data notes

- **Source**: the `/Rentals/` and `/Homes/` listing index pages, which `robots.txt` permits. The disallowed `/Karachi*` relative-link paths are never touched. Requests are sequential with a 2s delay — 16 page fetches, once.
- **Floor is not a structured Zameen field.** It's parsed from listing text ("Ground Floor Portion", "1st Floor") and inferred from property type ("Upper Portions" → upper). About **20% of listings** state a floor; the rest are `unknown`. The UI says so, and the agent is told not to apply a floor filter unless asked.
- **The backfill snapshot is static**; the daily pipeline is what keeps the corpus current.
- **Facets come from the corpus**, not from a file, cached for an hour — so the area list and counts track ingestion instead of drifting.
- Listing photos come from `media.zameen.com` thumbnails derived from the photo id — the `coverPhoto.url` in the page payload points at a private bucket that returns 403.

## Configuration

| Variable | Default |
|---|---|
| `VECTARA_API_KEY` | *(required)* |
| `VECTARA_BASE_URL` | `https://api.vectara.io/v2` |
| `VECTARA_CORPUS_KEY` | `zameen-karachi-properties` |
| `VECTARA_AGENT_KEY` | `zameen_property_assistant` |
| `VECTARA_AGENT_MODEL` | `gpt-5.5` |
| `PORT` | `8787` |
| `GOOGLE_CLIENT_ID` | *(empty — "Book a viewing" disabled)* |
| `GOOGLE_CLIENT_SECRET` | *(empty)* |
| `GOOGLE_REFRESH_TOKEN` | *(empty — read from `.google-token.json` locally)* |
| `GOOGLE_CALENDAR_ID` | `primary` |
| `PUBLIC_BASE_URL` | `http://localhost:5173` |
| `SESSION_SECRET` | *(random per boot — set explicitly outside local dev)* |
| `BOOKING_SLOT_MINUTES` | `45` |
| `BOOKING_GRID_MINUTES` | `60` |
| `BOOKING_DAY_START` | `11` |
| `BOOKING_DAY_END` | `19` |
| `BOOKING_LEAD_DAYS` | `1` |
| `BOOKING_WINDOW_DAYS` | `14` |
| `BOOKING_CLOSED_DAYS` | `0` (Sunday) |
| `BOOKING_TZ_OFFSET` | `+05:00` |

The API key is read only by the server and the ingest scripts — it never reaches the browser.

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` are all optional — the app runs without them, just with booking turned off. See [Booking a viewing](#booking-a-viewing) for how to set them, and DEPLOY.md for why `SESSION_SECRET` must not be left unset once the app is deployed.
