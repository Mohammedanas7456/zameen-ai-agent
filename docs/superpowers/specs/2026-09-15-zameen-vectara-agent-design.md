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
React/Vite  ──SSE──►  Express  ──────────►  Vectara Agent (gpt-5.5)
                      (API key)  │            └─ search_properties (lambda)
                                 │                 captures structured criteria
                                 ▼
                     exact metadata filter ──►  corpus: zameen-karachi-properties
                                 │
                                 └─ listings returned to the agent to describe
     ▲
     └──── scrape → normalize → index
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

## Four experiments that determined the design

The approved design routed search through a **Vectara lambda tool** that would build the filter and call the corpus. Getting to something that actually works took four experiments:

1. **Lambda → other tools: unavailable.** A lambda declaring `tool_configurations` and calling `tool.corpora_search(...)` fails with *"tool invocation is not available in this sandbox: no owner callback environment was injected"* — both in `POST /v2/tools/{id}/test` and inside a real agent session.
2. **Lambda → network: unavailable.** An outbound HTTPS call hangs to the 30s execution timeout, and `requests` is not installed. The lambda cannot reach the Query API either.
3. **Built-in `corpora_search_20260608`: filter not model-fillable.** Its schema does expose `search.corpora[].metadata_filter`, so this looked like the answer. It is not. With `argument_override.search` set, the override satisfies the schema's required `search` property and the model stops emitting one — it wrote its filter into `query` as prose and searches ran **silently unfiltered**. With the override removed, calls fail: `Field 'arg.corpora': corpora should have at least 1 items`. Across 17 consecutive retries showing it that exact error, the model never once added `corpora`. Only `query` is model-fillable; `search` can come only from `argument_override`.
4. **Lambda with a flat signature: works.** A lambda's input schema is generated from its Python signature, so it is flat — and the model fills it precisely: `{"purpose":"rent","area":"DHA Phase 6","min_bedrooms":3,"max_price":300000}`.

**Resolution:** the agent calls a flat-signature lambda that validates criteria but does not search. The server observes the `tool_input` event, builds the exact filter with the same `buildMetadataFilter` the sidebar uses, runs the query, and feeds the listings back on a second agent turn for narration.

This costs two agent turns per search and buys two things: filters enforced by our code rather than by a model, and an agent that can only ever describe listings that really matched.

## Filter enforcement

Both paths share `buildMetadataFilter`:

- **Sidebar** → `POST /api/search` builds the filter and queries the corpus directly. No LLM.
- **Chat** → the agent supplies structured criteria; `criteriaToFilters` re-validates them (rejecting unknown purposes and floors, treating 0 as unset, repairing inverted ranges) and the same builder produces the filter.

The generated filter is streamed to the browser and shown under the activity chip, and parsed back into sidebar state so the panel reflects what was actually searched.

Values are escaped before interpolation — they originate from a model or a user, so a crafted area name must not become filter syntax.

### Node gotcha worth remembering

`req.on('close')` fires when the **request body** finishes being read, not when the client disconnects. Using it to detect abort killed every streaming turn before its first iteration. The disconnect signal is `res.on('close')`.

## Testing

105 Vitest unit tests over the pieces that can silently produce wrong results: `window.state` extraction (against a fixture carrying a decoy brace and a `</script>`-like string), floor parsing, the metadata-filter builder including injection and `NaN` cases, the agent-criteria validator, listing reconstruction from metadata, incremental SSE parsing, and a round-trip test asserting that anything `buildMetadataFilter` emits parses back to the same filters (which is what keeps the sidebar honest).

## Known limits

- The snapshot is static; refreshing means re-running the pipeline.
- Floor coverage is ~20% by nature of the source data.
- Listing photos come from `media.zameen.com` thumbnails derived from the photo id; the `coverPhoto.url` in the payload is a private bucket returning 403.
