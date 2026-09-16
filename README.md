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

The API key is read only by the server and the ingest scripts — it never reaches the browser.
