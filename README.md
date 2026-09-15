# Zameen AI Agent

Conversational property search over live Zameen.com Karachi listings, powered by a **Vectara agent**.

The assistant asks which area you want, whether you're renting or buying, and what else matters (bedrooms, budget, floor) — then searches 400 real listings and explains the matches, while a synced filter panel shows the property cards.

```
React + Vite  ──SSE──►  Node + Express  ──────►  Vectara Agent
(chat + filters)        (holds the API key)      │
                                                 ├─ tool: search_properties (corpora_search)
                                                 └─ corpus: 400 Karachi listings
     ▲                                                     ▲
     └──────── scrape → normalize → index ─────────────────┘
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
| `vectara/` | The agent's instruction template |
| `data/` | Scraped snapshot (`listings.json`, `facets.json`) |

## Scripts

| Command | Effect |
|---|---|
| `npm run scrape` | Fetch 200 rent + 200 buy listings from Zameen |
| `npm run normalize` | Build `data/listings.json` and `data/facets.json` |
| `npm run setup:vectara` | Create corpus, index all documents, create/update the agent |
| `npm run setup:agent` | Update **only** the agent (fast — skips re-indexing) |
| `npm run dev` | Run API and UI together |
| `npm test` | Run the test suite |

## How filtering stays exact

Two search paths share one filter builder, so both enforce constraints precisely:

- **Sidebar** → `POST /api/search` builds the metadata filter in TypeScript and queries the corpus directly. No LLM, no drift.
- **Chat** → the agent writes its own `metadata_filter` and Vectara enforces it. The filter it used is streamed to the browser, shown under the "Searching…" chip, and parsed back to sync the sidebar — so the panel always shows what was actually searched.

Every filterable attribute has a lowercase `*_norm` twin (`area_l3_norm`, `property_type_norm`) so a casing mistake by the model can't silently return zero results.

## Data notes

- **Source**: the `/Rentals/` and `/Homes/` listing index pages, which `robots.txt` permits. The disallowed `/Karachi*` relative-link paths are never touched. Requests are sequential with a 2s delay — 16 page fetches, once.
- **Floor is not a structured Zameen field.** It's parsed from listing text ("Ground Floor Portion", "1st Floor") and inferred from property type ("Upper Portions" → upper). About **20% of listings** state a floor; the rest are `unknown`. The UI says so, and the agent is told not to apply a floor filter unless asked.
- **The snapshot is static.** Re-run `npm run scrape && npm run normalize && npm run setup:vectara` to refresh.
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
