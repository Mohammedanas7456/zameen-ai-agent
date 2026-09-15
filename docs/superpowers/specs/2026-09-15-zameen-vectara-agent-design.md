# Zameen AI Agent — Design

**Date:** 2026-09-15
**Status:** Implemented

A conversational property-search agent over Zameen.com Karachi listings, built on Vectara. The user is asked for location, then rent-vs-buy, then at least one more filter; the agent searches 400 indexed listings and explains the matches while a synced panel renders property cards.

## Decisions

| Decision | Choice |
|---|---|
| Repo | npm-workspaces monorepo (`packages/*`, `apps/*`) |
| Backend | Node + TypeScript (Express) |
| Frontend | React + Vite + Tailwind v4 |
| Agent | Native Vectara agent with sessions and SSE streaming |
| UX | Chat pane plus a live filter sidebar, synced both ways |

## Architecture

```
React/Vite  ──SSE──►  Express  ──────►  Vectara Agent (gpt-5.5)
                      (API key)         ├─ search_properties → corpora_search
                                        └─ corpus: zameen-karachi-properties
     ▲                                             ▲
     └──── scrape → normalize → index ─────────────┘
```

The API key lives only in the server and the ingest scripts.

## Data pipeline

Zameen's listing index pages embed a `window.state` JSON blob containing 25 fully structured listings each, so no HTML scraping is needed — 16 page fetches yield 200 rent + 200 buy.

- **Robots compliance:** only `/Rentals/` and `/Homes/` are used. `robots.txt` disallows `/Karachi*` (the relative-link browse paths); those are never requested. Sequential fetches, 2s apart.
- **Deliberately not used:** the page source also exposes Zameen's internal Elasticsearch credentials. We query only public pages.
- **Extraction** uses brace-matching with string-state tracking, not a regex — the payload contains braces, escaped quotes and `</script>`-like strings.

### Floor

Zameen has no structured floor field. It is derived two ways:

1. Parsed from title + description (`Ground Floor`, `1st Floor`, `Higher Floor`, `second floor`, `floor 7`).
2. Inferred from property type — `Upper Portions` → upper, `Lower Portions` → lower, `Penthouse` → top.

Together these cover **~20%** of listings; the rest are `unknown`. The UI labels the filter "where stated" and the agent is instructed not to apply it unprompted.

## Vectara

- **Corpus** `zameen-karachi-properties`, encoder `boomerang-2023-q3`, 19 indexed filter attributes.
- **Documents** are `core` type: one natural-language part for semantic matching, plus document metadata carrying every filterable value.
- **Sentinels:** filter attributes cannot be null, so floor uses `'unknown'` and `floor_num` uses `-1`.
- **Lowercase twins** (`area_l3_norm`, `property_type_norm`) exist so a casing mistake by the model cannot silently return nothing.

## Two spikes that changed the design

The approved design routed search through a **Vectara lambda tool** that would build the filter and call the corpus. Both mechanisms it needed turned out to be unavailable on this account:

1. **Lambda → other tools.** A lambda declaring `tool_configurations` and calling `tool.corpora_search(...)` fails at runtime with *"tool invocation is not available in this sandbox: no owner callback environment was injected"* — both in `POST /v2/tools/{id}/test` and inside a real agent session.
2. **Lambda → network.** An outbound HTTPS call from the sandbox hangs to the 30s execution timeout, and `requests` is not installed. So the lambda cannot reach the Query API either.

**Resolution:** attach the system tool `tol_vectara_corpora_search_20260608` directly. Unlike the older `corpora_search`, its input schema exposes `search.corpora[].metadata_filter` to the model, so dynamic filters are natively supported — which is what the lambda was going to provide anyway, with one less moving part.

### A second bug this surfaced

Pinning `corpus_key` through `argument_override.search` **satisfied the schema's required `search` property**, so the model stopped emitting one and wrote its filter into the `query` string as prose instead — searches silently ran unfiltered.

Fix: no `search` override at all. The corpus key is pinned in the instructions, which spell out the exact call shape and state that a call without `search` is wrong.

## Filter enforcement

Two paths share `buildMetadataFilter`:

- **Sidebar** → `POST /api/search` builds the filter in TypeScript and queries the corpus directly. No LLM.
- **Chat** → the agent writes the filter; Vectara enforces it. The emitted filter is streamed to the browser, shown under the activity chip, and parsed back into sidebar state so the panel reflects what was actually searched.

Values are escaped before interpolation — they originate from a model or a user, so a crafted area name must not become filter syntax.

## Testing

Vitest, unit-level, over the pieces that can silently produce wrong results: `window.state` extraction (against a fixture carrying a decoy brace and a `</script>`-like string), floor parsing, the metadata-filter builder including injection and `NaN` cases, listing reconstruction from metadata, and incremental SSE parsing.

## Known limits

- The snapshot is static; refreshing means re-running the pipeline.
- Floor coverage is ~20% by nature of the source data.
- Listing photos come from `media.zameen.com` thumbnails derived from the photo id; the `coverPhoto.url` in the payload is a private bucket returning 403.
