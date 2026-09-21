# Agent Search Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one chat message drive up to three exact searches, build each search from the lambda's normalised criteria instead of the model's raw arguments, rank results by the user's own words, ground zero-result advice in measured counts, and make agent redeploys keep live sessions.

**Architecture:** The two-turn search (agent calls `search_properties`, the server runs the exact corpus query, the agent narrates the results on a second turn) becomes a bounded loop inside `handleUserMessage`. The server now reads Vectara's `tool_output` event for what the lambda made of the arguments, feeds warnings and relaxation-probe counts back to the agent, and a step reminder re-injects the "only describe returned listings" rule on every input. Upstream calls are injected into the loop so it is unit-tested against a scripted SSE stream. Provisioning replaces the agent with PUT instead of delete-and-recreate.

**Tech Stack:** Node 20, TypeScript 5.7, Express 4, Vitest 2, Vectara Agents API v2 (lambda tools, step reminders), Python 3.12 lambda.

**Spec:** No spec file exists. The requirements are the agent review delivered in this session, restated in the Goal above and in each task's description.

## Global Constraints

- **Run tests as** `VECTARA_API_KEY=test-key npm test`. This worktree has no `.env`, and `apps/server/src/config.ts` throws at import time without the key. One file: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/chat.test.ts`.
- **Typecheck with** `npm run typecheck`. It exits 0 with no output when clean. Run it before every commit that touches TypeScript.
- **No new runtime dependencies.** Node's global `fetch`, `Response` and `ReadableStream` cover everything.
- **Tests are co-located** as `*.test.ts` beside the file under test. Vitest runs with `environment: 'node'`; do not add jsdom.
- **Any test that imports `chat.ts` or `vectara.ts`** must set `process.env['VECTARA_API_KEY'] ??= 'test-key'` before `await import(...)`, exactly as `apps/server/src/routes/booking.test.ts` does. A static import would hoist above the assignment.
- **The lambda's `process()` signature is the tool's schema.** Keep it flat; `str` and `int` parameters only; `0` and `""` mean "not set".
- **Do not change anything under `apps/web`.** The user asked for agentic changes only.
- **Do not run `npm run setup:agent` before Task 8.** It writes to the shared Vectara account that the deployed service also uses.
- **Commit messages** follow the repo's style: one imperative line, no `feat:` prefix (see `git log --oneline`). End the body with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Code comments** explain *why*, in the voice of the existing files. No comments that restate the code.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/criteria.ts` | Model output → `SearchFilters`. Gains list-shaped areas and `semanticQuery`. |
| `apps/server/src/relax.ts` (new) | **Pure.** Relaxation candidates for an empty search, a probe runner with an injected counter, and the rendering for the agent. |
| `apps/server/src/chat.ts` | The bounded search loop. Consumes `tool_output`; upstream calls injected. |
| `apps/server/src/chat.test.ts` (new) | Loop tests against a scripted SSE stream. |
| `apps/server/src/vectara.ts` | `lexical_interpolation` on corpus search. |
| `vectara/search_properties.py` | Lambda. Gains `query`. |
| `vectara/agent-instructions.md` | Prompt. Documents `query`, multi-search, warnings. |
| `packages/ingest/src/setup-vectara.ts` | Provisioning. Detach → replace tool → PUT agent; adds the step reminder. |
| `README.md` | Chat search description. |

---

### Task 1: Criteria accepts the lambda's shapes

The lambda returns `area` as a string for one area and a **list** for several, and the server will start reading its output. It also gains a free-text `query` argument (Task 5) that ranks results but must never become a filter.

**Files:**
- Modify: `apps/server/src/criteria.ts:1-42`
- Test: `apps/server/src/criteria.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentCriteria.query?: unknown`; `criteriaToFilters` accepts `area: string[]`; `export function semanticQuery(criteria: AgentCriteria): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to the `criteriaToFilters` describe block in `apps/server/src/criteria.test.ts` (before its closing `});`), and add a new describe block after it:

```ts
  it('accepts the list of areas the lambda returns for a multi-area search', () => {
    expect(
      criteriaToFilters({ purpose: 'rent', area: ['Gulshan-e-Iqbal', 'Gulistan-e-Jauhar'] }),
    ).toEqual({ purpose: 'rent', areas: ['Gulshan-e-Iqbal', 'Gulistan-e-Jauhar'] });
  });

  it('treats a one-item area list like a plain area', () => {
    expect(criteriaToFilters({ purpose: 'rent', area: ['Clifton'] })).toEqual({
      purpose: 'rent',
      area: 'Clifton',
    });
  });

  it('never turns the ranking query into a filter', () => {
    expect(criteriaToFilters({ purpose: 'rent', query: 'sea facing' })).toEqual({ purpose: 'rent' });
  });
```

```ts
describe('semanticQuery', () => {
  it('returns the query with whitespace collapsed', () => {
    expect(semanticQuery({ query: '  sea   facing\nflat ' })).toBe('sea facing flat');
  });

  it('is undefined when absent, blank or not a string', () => {
    expect(semanticQuery({})).toBeUndefined();
    expect(semanticQuery({ query: '   ' })).toBeUndefined();
    expect(semanticQuery({ query: 42 })).toBeUndefined();
  });

  it('caps the length so a runaway argument cannot become a runaway query', () => {
    expect(semanticQuery({ query: 'x'.repeat(500) })).toHaveLength(300);
  });
});
```

Update the import line at the top of the test file to:

```ts
import { criteriaToFilters, describeFilters, listingsForAgent, semanticQuery } from './criteria.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/criteria.test.ts`
Expected: FAIL. The list-area test gets `{ purpose: 'rent' }` (arrays are not strings, so `text()` drops them), and `semanticQuery` is not exported.

- [ ] **Step 3: Implement**

In `apps/server/src/criteria.ts`, add the `query` field to `AgentCriteria`:

```ts
export interface AgentCriteria {
  purpose?: unknown;
  area?: unknown;
  min_bedrooms?: unknown;
  max_bedrooms?: unknown;
  min_price?: unknown;
  max_price?: unknown;
  property_type?: unknown;
  floor?: unknown;
  min_area_sqft?: unknown;
  /** The user's own words for ranking, e.g. "sea facing". Never a filter. */
  query?: unknown;
}
```

Replace the `areaNames` function with:

```ts
function areaNames(value: unknown): string[] {
  // The lambda returns one area as a string and several as a list; the raw
  // tool input is always the one comma-separated string it was told to send.
  const raw = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').join(',')
    : text(value);
  if (!raw) return [];
  return raw
    .split(AREA_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
```

Add after `criteriaToFilters` (before `describeFilters`):

```ts
/** Longest ranking query passed to the corpus. */
const MAX_QUERY_CHARS = 300;

/**
 * The user's own words for ranking, if the agent passed any.
 *
 * This is the one model-supplied value that reaches the corpus as free text
 * rather than as a validated filter, so it is bounded: a runaway argument
 * must not become a runaway query.
 */
export function semanticQuery(criteria: AgentCriteria): string | undefined {
  const raw = text(criteria.query);
  if (!raw) return undefined;
  return raw.replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/criteria.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0, no output.

```bash
git add apps/server/src/criteria.ts apps/server/src/criteria.test.ts
git commit -m "Accept the lambda's list of areas and expose its ranking query" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Relaxation probes for empty searches

When a search matches nothing, the agent currently guesses which filter to loosen. This module lists a few candidate relaxations, counts each one with an injected search function, and renders the counts for the agent. Pure, so it is tested without a network.

**Files:**
- Create: `apps/server/src/relax.ts`
- Test: `apps/server/src/relax.test.ts`

**Interfaces:**
- Consumes: `SearchFilters` from `@zameen/shared`.
- Produces:
  - `export interface Relaxation { label: string; filters: SearchFilters }`
  - `export interface ProbeResult { label: string; count: number }`
  - `export function relaxations(filters: SearchFilters): Relaxation[]`
  - `export async function probeRelaxations(filters: SearchFilters, count: (filters: SearchFilters) => Promise<number>): Promise<ProbeResult[]>`
  - `export function describeProbes(probes: ProbeResult[], limit: number): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/relax.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { SearchFilters } from '@zameen/shared';
import { describeProbes, probeRelaxations, relaxations } from './relax.js';

describe('relaxations', () => {
  it('returns nothing for a search with nothing to relax', () => {
    expect(relaxations({ purpose: 'rent' })).toEqual([]);
  });

  it('offers one relaxation per set filter, most conservative first', () => {
    const labels = relaxations({ purpose: 'rent', floor: 'ground', maxPrice: 100_000 }).map((r) => r.label);
    expect(labels).toEqual(['without the floor filter', 'with the budget raised to PKR 125,000']);
  });

  it('raises the budget by a quarter and keeps everything else', () => {
    expect(relaxations({ purpose: 'buy', maxPrice: 20_000_000, minBedrooms: 3 })).toContainEqual({
      label: 'with the budget raised to PKR 25,000,000',
      filters: { purpose: 'buy', maxPrice: 25_000_000, minBedrooms: 3 },
    });
  });

  it('never relaxes purpose', () => {
    for (const r of relaxations({ purpose: 'buy', maxPrice: 1, floor: 'top', minBedrooms: 2 })) {
      expect(r.filters.purpose).toBe('buy');
    }
  });

  it('goes down one bedroom but never below one', () => {
    expect(relaxations({ purpose: 'rent', minBedrooms: 3 })).toEqual([
      { label: 'with 2+ bedrooms', filters: { purpose: 'rent', minBedrooms: 2 } },
    ]);
    expect(relaxations({ purpose: 'rent', minBedrooms: 1 })).toEqual([]);
  });

  it('drops the area last and always keeps that probe when an area was set', () => {
    const rs = relaxations({
      purpose: 'rent',
      area: 'Clifton',
      floor: 'ground',
      maxPrice: 100_000,
      minBedrooms: 3,
      propertyType: 'Flats',
    });
    expect(rs).toHaveLength(3);
    expect(rs[2]).toEqual({
      label: 'anywhere in Karachi',
      filters: { purpose: 'rent', floor: 'ground', maxPrice: 100_000, minBedrooms: 3, propertyType: 'Flats' },
    });
  });

  it('drops several areas together', () => {
    expect(relaxations({ purpose: 'rent', areas: ['Gulshan-e-Iqbal', 'Gulistan-e-Jauhar'] })).toEqual([
      { label: 'anywhere in Karachi', filters: { purpose: 'rent' } },
    ]);
  });

  it('caps the number of probes', () => {
    expect(
      relaxations({ purpose: 'rent', floor: 'top', maxPrice: 5, minBedrooms: 4, propertyType: 'Houses' }),
    ).toHaveLength(3);
  });
});

describe('probeRelaxations', () => {
  it('counts each candidate and drops the ones whose query failed', async () => {
    const count = vi.fn(async (f: SearchFilters) => {
      if (f.floor === undefined) throw new Error('boom');
      return 7;
    });
    const probes = await probeRelaxations({ purpose: 'rent', floor: 'ground', maxPrice: 100_000 }, count);
    expect(count).toHaveBeenCalledTimes(2);
    expect(probes).toEqual([{ label: 'with the budget raised to PKR 125,000', count: 7 }]);
  });

  it('is empty when there is nothing to relax, without calling the counter', async () => {
    const count = vi.fn(async () => 1);
    expect(await probeRelaxations({ purpose: 'rent' }, count)).toEqual([]);
    expect(count).not.toHaveBeenCalled();
  });
});

describe('describeProbes', () => {
  it('is empty with no probes', () => {
    expect(describeProbes([], 40)).toBe('');
  });

  it('lists counts, saying "40+" when a probe filled the page', () => {
    expect(
      describeProbes(
        [
          { label: 'anywhere in Karachi', count: 40 },
          { label: 'with 2+ bedrooms', count: 1 },
          { label: 'without the floor filter', count: 0 },
        ],
        40,
      ),
    ).toBe(
      'The system checked these relaxations (counts only; the user has not seen them):\n' +
        '- anywhere in Karachi: 40+ listings\n' +
        '- with 2+ bedrooms: 1 listing\n' +
        '- without the floor filter: 0 listings',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/relax.test.ts`
Expected: FAIL with "Failed to resolve import './relax.js'".

- [ ] **Step 3: Implement**

Create `apps/server/src/relax.ts`:

```ts
import type { SearchFilters } from '@zameen/shared';

export interface Relaxation {
  label: string;
  filters: SearchFilters;
}

export interface ProbeResult {
  label: string;
  count: number;
}

/** Probes run per empty search. Each one is a corpus query, so this is a cost cap. */
const MAX_PROBES = 3;

/** How far to raise a budget in one step. */
const PRICE_STEP = 1.25;

function without(filters: SearchFilters, ...keys: (keyof SearchFilters)[]): SearchFilters {
  const copy: SearchFilters = { ...filters };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Ways to loosen a search that returned nothing, so the agent's "try widening
 * X" is grounded in a count rather than a guess.
 *
 * Single-filter relaxations come first, only for filters actually set.
 * "Anywhere in Karachi" is always last and always kept when an area was
 * given: the prompt forbids the agent from switching area on its own, and a
 * count is what lets it *ask* about that with something concrete to offer.
 */
export function relaxations(filters: SearchFilters): Relaxation[] {
  const single: Relaxation[] = [];

  if (filters.floor) {
    single.push({ label: 'without the floor filter', filters: without(filters, 'floor') });
  }
  if (filters.maxPrice) {
    const raised = Math.round(filters.maxPrice * PRICE_STEP);
    single.push({
      label: `with the budget raised to PKR ${raised.toLocaleString('en-US')}`,
      filters: { ...filters, maxPrice: raised },
    });
  }
  if (filters.minBedrooms && filters.minBedrooms > 1) {
    const fewer = filters.minBedrooms - 1;
    single.push({ label: `with ${fewer}+ bedrooms`, filters: { ...filters, minBedrooms: fewer } });
  }
  if (filters.propertyType) {
    single.push({ label: 'with any property type', filters: without(filters, 'propertyType') });
  }

  const hasArea = Boolean(filters.area) || Boolean(filters.areas?.length);
  if (!hasArea) return single.slice(0, MAX_PROBES);

  return [
    ...single.slice(0, MAX_PROBES - 1),
    { label: 'anywhere in Karachi', filters: without(filters, 'area', 'areas') },
  ];
}

/**
 * Count matches for each relaxation.
 *
 * Probes run concurrently, and a failed probe is dropped rather than failing
 * the turn — this is advice attached to an answer, not the answer.
 */
export async function probeRelaxations(
  filters: SearchFilters,
  count: (filters: SearchFilters) => Promise<number>,
): Promise<ProbeResult[]> {
  const candidates = relaxations(filters);
  const counts = await Promise.all(candidates.map((c) => count(c.filters).catch(() => -1)));
  return candidates
    .map((c, i) => ({ label: c.label, count: counts[i] ?? -1 }))
    .filter((p) => p.count >= 0);
}

/**
 * Render probe counts for the agent's results message.
 *
 * `limit` is the search page size: a probe that filled the page is reported
 * as "limit+" because the true count is unknown beyond that.
 */
export function describeProbes(probes: ProbeResult[], limit: number): string {
  if (probes.length === 0) return '';
  const lines = probes.map((p) => {
    const n = p.count >= limit ? `${limit}+` : String(p.count);
    return `- ${p.label}: ${n} listing${p.count === 1 ? '' : 's'}`;
  });
  return `The system checked these relaxations (counts only; the user has not seen them):\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/relax.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add apps/server/src/relax.ts apps/server/src/relax.test.ts
git commit -m "Add relaxation probes for searches that match nothing" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The bounded search loop

This is the core change. `handleUserMessage` today runs one search per message and throws away any tool call the agent makes on the results turn. It also builds the search from the model's raw `tool_input`, so a value the lambda dropped (an unknown property type) is still applied as an exact filter and returns nothing. Both are fixed here.

Vectara streams `tool_input` (the model's arguments) and then `tool_output` (the lambda's return value: `{status, criteria, warnings, note}`). The loop reads the output, falls back to the input only if the lambda itself crashed (`error: true`), and does not search at all when the lambda rejected the call (`status: 'error'`) — the model has the error text and will ask the user.

**Files:**
- Modify: `apps/server/src/chat.ts` (whole file)
- Test: `apps/server/src/chat.test.ts` (new)

**Interfaces:**
- Consumes: `criteriaToFilters`, `describeFilters`, `listingsForAgent`, `semanticQuery`, `AgentCriteria` from `./criteria.js` (Task 1); `describeProbes`, `probeRelaxations` from `./relax.js` (Task 2); `SseParser`, `ClientEvent` from `./sse.js`; `searchListings`, `streamAgentTurn` from `./vectara.js`.
- Produces:
  - `export interface ChatDeps { streamAgentTurn: (sessionKey: string, message: string) => Promise<Response>; searchListings: (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]> }`
  - `export const MAX_SEARCHES_PER_MESSAGE = 3`
  - `export async function handleUserMessage(sessionKey: string, message: string, emit: Emit, isAborted: () => boolean, deps?: ChatDeps): Promise<void>` — the fifth parameter is new and optional; `index.ts` keeps calling it with four.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/chat.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Listing, SearchFilters } from '@zameen/shared';
import type { ClientEvent } from './sse.js';

// chat.ts imports vectara.ts for its default dependencies, and vectara.ts
// reaches config.ts, which calls required('VECTARA_API_KEY') at import time.
process.env['VECTARA_API_KEY'] ??= 'test-key';

const { handleUserMessage, MAX_SEARCHES_PER_MESSAGE } = await import('./chat.js');

/** One Vectara SSE stream, framed the way the events endpoint sends it. */
function stream(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

const prose = (content: string) => ({ type: 'streaming_agent_output', content });

const toolInput = (tool_input: object) => ({
  type: 'tool_input',
  tool_call_id: 'call-1',
  tool_configuration_name: 'search_properties',
  tool_name: 'search_properties',
  tool_input,
});

const toolOutput = (tool_output: object, error = false) => ({
  type: 'tool_output',
  tool_call_id: 'call-1',
  tool_configuration_name: 'search_properties',
  tool_name: 'search_properties',
  tool_output,
  error,
});

/** A lambda reply that accepted the call with the given normalised criteria. */
const accepted = (criteria: object, warnings: string[] = []) =>
  toolOutput({ status: 'searching', criteria, warnings, note: 'listings follow' });

const LISTING = {
  externalId: '12345', title: 'Well kept 3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 250_000,
  priceLabel: 'PKR 2.5 Lakh', rentFrequency: null, areaSqft: 1800, areaSqyd: 200,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Clifton > Block 2',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

type Search = (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]>;

/**
 * Wire the loop to scripted agent turns. Each entry in `turns` is the stream
 * one call to streamAgentTurn returns, in order.
 */
function harness(turns: object[][], results: Listing[] | Error = [LISTING]) {
  const events: ClientEvent[] = [];
  const streamAgentTurn = vi.fn<(sessionKey: string, message: string) => Promise<Response>>();
  for (const t of turns) streamAgentTurn.mockResolvedValueOnce(stream(t));
  const searchListings = vi.fn<Search>(async () => {
    if (results instanceof Error) throw results;
    return results;
  });
  return {
    events,
    streamAgentTurn,
    searchListings,
    run: (message = 'hello', isAborted: () => boolean = () => false) =>
      handleUserMessage('sess', message, (e) => events.push(e), isAborted, { streamAgentTurn, searchListings }),
    /** Every message sent to the agent, in order. Index 0 is the user's. */
    sent: () => streamAgentTurn.mock.calls.map((c) => c[1]),
  };
}

const tokens = (events: ClientEvent[]) =>
  events.filter((e): e is { type: 'token'; text: string } => e.type === 'token').map((e) => e.text).join('');

describe('handleUserMessage', () => {
  it('forwards prose and searches nothing when the agent only talks', async () => {
    const h = harness([[prose('Which area '), prose('are you looking in?')]]);
    await h.run();
    expect(tokens(h.events)).toBe('Which area are you looking in?');
    expect(h.searchListings).not.toHaveBeenCalled();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("builds the search from the lambda's normalised criteria, not the raw arguments", async () => {
    const h = harness([
      [
        toolInput({ purpose: 'rent', area: 'DHA Phase 6', min_bedrooms: 3, property_type: 'apartment' }),
        accepted({ purpose: 'rent', area: 'DHA Phase 6', min_bedrooms: 3 }, [
          "'apartment' is not a known property type and was ignored",
        ]),
        prose('Searching now.'),
      ],
      [prose('One listing matched.')],
    ]);
    await h.run('3 bed apartment in DHA Phase 6');

    expect(h.searchListings).toHaveBeenCalledTimes(1);
    expect(h.searchListings.mock.calls[0]?.[0]).toEqual({ purpose: 'rent', area: 'DHA Phase 6', minBedrooms: 3 });

    const start = h.events.find((e) => e.type === 'tool_start') as { filter: string };
    expect(start.filter).not.toContain('property_type');
    expect(h.events.some((e) => e.type === 'listings')).toBe(true);

    // The throwaway acknowledgement is dropped; the narration is forwarded.
    expect(tokens(h.events)).toBe('One listing matched.');

    const results = h.sent()[1]!;
    expect(results).toContain('SEARCH RESULTS');
    expect(results).toContain("Ignored: 'apartment' is not a known property type and was ignored.");
    expect(results).toContain('Well kept 3 bed flat');
    expect(results).toContain(`Searches remaining for this message: ${MAX_SEARCHES_PER_MESSAGE - 1}.`);
  });

  it('falls back to the raw arguments when the lambda itself failed', async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', area: 'Clifton' }), toolOutput({ message: 'sandbox timeout' }, true), prose('ok')],
      [prose('done')],
    ]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[0]).toEqual({ purpose: 'rent', area: 'Clifton' });
  });

  it('does not search when the lambda rejected the call, and lets the agent answer', async () => {
    const h = harness([
      [
        toolInput({ purpose: 'lease' }),
        toolOutput({ status: 'error', error: "purpose must be either 'rent' or 'buy'", criteria: {} }),
        prose('Do you want to rent or buy?'),
      ],
    ]);
    await h.run();
    expect(h.searchListings).not.toHaveBeenCalled();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
    expect(tokens(h.events)).toBe('Do you want to rent or buy?');
  });

  it("ranks by the user's own words when the agent passes a query", async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', query: 'sea facing' }), accepted({ purpose: 'rent', query: 'sea facing' })],
      [prose('x')],
    ]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[1]).toBe('sea facing');
    expect(h.sent()[1]).toContain('Ranked by: "sea facing".');
  });

  it('falls back to describing the filters as the query when none was given', async () => {
    const h = harness([[toolInput({ purpose: 'rent', area: 'Clifton' }), accepted({ purpose: 'rent', area: 'Clifton' })], [prose('x')]]);
    await h.run();
    expect(h.searchListings.mock.calls[0]?.[1]).toBe('for rent, in Clifton');
    expect(h.sent()[1]).not.toContain('Ranked by');
  });

  it('reports a failed search to the client and still gives the agent a turn', async () => {
    const h = harness(
      [[toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })], [prose('Sorry, please try again.')]],
      new Error('HTTP 503'),
    );
    await h.run();
    expect(h.events).toContainEqual({ type: 'error', message: 'Search failed: HTTP 503' });
    expect(h.sent()[1]).toContain('could not be completed');
    expect(tokens(h.events)).toBe('Sorry, please try again.');
  });

  it('honours a second search the agent runs to relax a filter', async () => {
    const h = harness([
      [toolInput({ purpose: 'rent', max_price: 100_000 }), accepted({ purpose: 'rent', max_price: 100_000 })],
      [
        toolInput({ purpose: 'rent', max_price: 150_000 }),
        accepted({ purpose: 'rent', max_price: 150_000 }),
        prose('Nothing under 1 lakh, widening.'),
      ],
      [prose('Here is one under 1.5 lakh.')],
    ]);
    await h.run();
    expect(h.searchListings).toHaveBeenCalledTimes(2);
    expect(h.searchListings.mock.calls[1]?.[0]).toEqual({ purpose: 'rent', maxPrice: 150_000 });
    expect(tokens(h.events)).toBe('Here is one under 1.5 lakh.');
    expect(h.sent()[2]).toContain(`Searches remaining for this message: ${MAX_SEARCHES_PER_MESSAGE - 2}.`);
    expect(h.events.filter((e) => e.type === 'listings')).toHaveLength(2);
  });

  it('stops at the search limit and gives the agent one text-only turn to answer', async () => {
    const call = () => [toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' }), prose('Searching…')];
    const h = harness([call(), call(), call(), call(), [prose('Here is what I found.')]]);
    await h.run();
    expect(h.searchListings).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE);
    // The user's turn, one results turn per search, and the text-only turn.
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE + 2);
    expect(h.sent()[MAX_SEARCHES_PER_MESSAGE]).toContain('Do not call search_properties again');
    expect(h.sent()[MAX_SEARCHES_PER_MESSAGE + 1]).toContain('SEARCH LIMIT');
    expect(tokens(h.events)).toBe('Here is what I found.');
  });

  it('needs no extra turn when the agent respects the limit', async () => {
    const call = () => [toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })];
    const h = harness([call(), call(), call(), [prose('Final answer.')]]);
    await h.run();
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(MAX_SEARCHES_PER_MESSAGE + 1);
    expect(tokens(h.events)).toBe('Final answer.');
  });

  it('probes relaxations when nothing matched and reports the counts', async () => {
    const h = harness([
      [
        toolInput({ purpose: 'rent', area: 'Clifton', max_price: 100_000 }),
        accepted({ purpose: 'rent', area: 'Clifton', max_price: 100_000 }),
      ],
      [prose('Nothing matched.')],
    ]);
    h.searchListings.mockImplementation(async (f) => (f.area ? [] : [LISTING, LISTING]));
    await h.run();
    const results = h.sent()[1]!;
    expect(results).toContain('No listings matched those criteria.');
    expect(results).toContain('with the budget raised to PKR 125,000: 0 listings');
    expect(results).toContain('anywhere in Karachi: 2 listings');
    expect(results).toContain('suggest the most useful relaxation');
  });

  it('stops doing work once the client has gone away', async () => {
    let aborted = false;
    const h = harness([[toolInput({ purpose: 'rent' }), accepted({ purpose: 'rent' })], [prose('never sent')]]);
    h.searchListings.mockImplementation(async () => {
      aborted = true;
      return [LISTING];
    });
    await h.run('hello', () => aborted);
    expect(h.streamAgentTurn).toHaveBeenCalledTimes(1);
    expect(h.events.some((e) => e.type === 'listings')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/chat.test.ts`
Expected: FAIL. `MAX_SEARCHES_PER_MESSAGE` is undefined, and `handleUserMessage` ignores the fifth argument and calls the real `streamAgentTurn`, which fails on `fetch`.

- [ ] **Step 3: Implement**

Replace the whole of `apps/server/src/chat.ts` with:

```ts
import type { Listing, SearchFilters } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { searchListings, streamAgentTurn } from './vectara.js';
import {
  criteriaToFilters,
  describeFilters,
  listingsForAgent,
  semanticQuery,
  type AgentCriteria,
} from './criteria.js';
import { describeProbes, probeRelaxations } from './relax.js';
import { SseParser, type ClientEvent } from './sse.js';

export type Emit = (event: ClientEvent) => void;

/**
 * The upstream calls the loop makes. Injectable so the loop can be tested
 * against a scripted stream instead of a live agent.
 */
export interface ChatDeps {
  streamAgentTurn: (sessionKey: string, message: string) => Promise<Response>;
  searchListings: (filters: SearchFilters, query: string, limit?: number) => Promise<Listing[]>;
}

const defaultDeps: ChatDeps = { streamAgentTurn, searchListings };

/**
 * Searches one user message may trigger. Enough for the agent to relax a
 * filter once or twice after an empty result; low enough that a confused
 * model cannot loop on our bill.
 */
export const MAX_SEARCHES_PER_MESSAGE = 3;

/** Listings per search. Relaxation probes count up to this many. */
const SEARCH_LIMIT = 40;

const SEARCH_LIMIT_MESSAGE =
  'SEARCH LIMIT (system data, not from the user): the search you just requested was not run, ' +
  'because this message has used all of its searches. Reply to the user now with what you ' +
  'already have, and offer to continue in their next message.';

/** How a turn treats a search_properties call. */
interface TurnMode {
  /** Act on a tool call. When false the call is ignored and no results turn follows it. */
  honourSearch: boolean;
  /**
   * Keep forwarding prose after a tool call. Off when a later turn will carry
   * the real answer, so the model's "searching now…" line is dropped. Vectara
   * emits `tool_input` before the model's accompanying text, which is what
   * makes this reliable.
   */
  forwardAfterToolCall: boolean;
}

const SEARCH_TURN: TurnMode = { honourSearch: true, forwardAfterToolCall: false };
/** The last results turn: a further call is ignored, and a text-only turn follows. */
const LAST_RESULTS_TURN: TurnMode = { honourSearch: false, forwardAfterToolCall: false };
/** Nothing follows this turn, so whatever the model says is the reply. */
const FINAL_TURN: TurnMode = { honourSearch: false, forwardAfterToolCall: true };

/** What the agent asked to search for, once the lambda has had its say. */
interface SearchRequest {
  criteria: AgentCriteria;
  warnings: string[];
}

interface TurnResult {
  search: SearchRequest | null;
  /** The agent called the tool in a turn that was not allowed to search. */
  ignoredSearch: boolean;
}

/** Stream one agent turn, forwarding its prose to the client. */
async function runTurn(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps,
  mode: TurnMode,
): Promise<TurnResult> {
  const response = await deps.streamAgentTurn(sessionKey, message);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();

  // Vectara emits `tool_input` (the model's raw arguments) and then
  // `tool_output` (what the lambda made of them). The lambda drops values it
  // does not recognise, so its output is what the search must be built from;
  // the raw arguments are only a fallback for when the lambda itself failed.
  let requested: AgentCriteria | null = null;
  let normalised: AgentCriteria | null = null;
  let warnings: string[] = [];
  let toolName = 'search_properties';
  let ignoredSearch = false;
  let streamedProse = false;
  let forwardProse = true;

  while (!isAborted()) {
    const { done, value } = await reader.read();
    if (done) break;

    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue; // keep-alives and non-JSON frames
      }

      const content = typeof event['content'] === 'string' ? event['content'] : '';

      switch (event['type']) {
        case 'streaming_agent_output':
          if (content) {
            streamedProse = true;
            if (forwardProse) emit({ type: 'token', text: content });
          }
          break;

        case 'agent_output':
          // Non-streamed fallback; only used when nothing streamed, or the
          // whole reply would appear twice.
          if (content && !streamedProse) {
            streamedProse = true;
            if (forwardProse) emit({ type: 'token', text: content });
          }
          break;

        case 'tool_input': {
          const input = event['tool_input'];
          if (!input || typeof input !== 'object') break;
          forwardProse = mode.forwardAfterToolCall;
          if (!mode.honourSearch) {
            ignoredSearch = true;
            break;
          }
          requested = input as AgentCriteria;
          toolName = String(event['tool_configuration_name'] ?? toolName);
          break;
        }

        case 'tool_output': {
          if (!requested) break;
          const output = event['tool_output'];
          if (event['error'] === true || !output || typeof output !== 'object') break;
          const out = output as Record<string, unknown>;
          if (out['status'] === 'error') {
            // The lambda refused the call (no purpose, say). The model has its
            // error text and will ask the user, so its prose *is* the reply.
            requested = null;
            forwardProse = true;
            break;
          }
          const criteria = out['criteria'];
          if (criteria && typeof criteria === 'object') normalised = criteria as AgentCriteria;
          if (Array.isArray(out['warnings'])) {
            warnings = out['warnings'].filter((w): w is string => typeof w === 'string');
          }
          break;
        }

        default:
          break;
      }
    }
  }

  await reader.cancel().catch(() => {});

  const criteria = normalised ?? requested;
  if (!criteria) return { search: null, ignoredSearch };

  const filters = criteriaToFilters(criteria);
  emit({
    type: 'tool_start',
    tool: toolName,
    query: describeFilters(filters),
    filter: buildMetadataFilter(filters),
  });
  return { search: { criteria, warnings }, ignoredSearch };
}

/**
 * Run one exact search and render its outcome as the agent's next input.
 *
 * The agent never sees raw search output: this message is the only account
 * of the results it gets, so it carries what was ignored, what was ranked by,
 * and — when nothing matched — what relaxing each filter would have found.
 */
async function performSearch(
  request: SearchRequest,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps,
): Promise<string> {
  const filters = criteriaToFilters(request.criteria);
  const description = describeFilters(filters);
  const query = semanticQuery(request.criteria) ?? description;

  let listings: Listing[];
  try {
    listings = await deps.searchListings(filters, query, SEARCH_LIMIT);
  } catch (err) {
    emit({ type: 'error', message: `Search failed: ${(err as Error).message}` });
    return (
      'SEARCH RESULTS (system data, not from the user): the search could not be completed ' +
      'because of a temporary error. Apologise briefly and invite them to try again.'
    );
  }

  // The client may have gone while the query ran; nothing below is worth doing for nobody.
  if (isAborted()) return '';

  emit({ type: 'listings', listings, filter: buildMetadataFilter(filters) });

  const parts = [
    `SEARCH RESULTS (system data, not a message from the user). Criteria: ${description}.` +
      (query !== description ? ` Ranked by: "${query}".` : ''),
    request.warnings.length > 0 ? `Ignored: ${request.warnings.join('; ')}.` : '',
    listingsForAgent(listings),
  ];

  if (listings.length === 0) {
    const probes = await probeRelaxations(
      filters,
      async (relaxed) => (await deps.searchListings(relaxed, query, SEARCH_LIMIT)).length,
    );
    parts.push(describeProbes(probes, SEARCH_LIMIT));
    parts.push('Tell the user nothing matched and suggest the most useful relaxation above.');
  } else {
    parts.push('Describe these to the user now, following your presentation rules. Mention only the listings above.');
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * Handle one user message end to end.
 *
 * Each time the agent calls the search tool, the server performs the actual
 * query — so the filters are enforced by our own code rather than by the
 * model — and hands the results back on a further turn for the agent to
 * describe. That can repeat, up to `MAX_SEARCHES_PER_MESSAGE` times, so the
 * agent can relax a filter after an empty result without waiting for the
 * user. It therefore only ever talks about listings that really matched.
 */
export async function handleUserMessage(
  sessionKey: string,
  message: string,
  emit: Emit,
  isAborted: () => boolean,
  deps: ChatDeps = defaultDeps,
): Promise<void> {
  let turn = await runTurn(sessionKey, message, emit, isAborted, deps, SEARCH_TURN);

  for (let used = 0; turn.search && !isAborted(); ) {
    used += 1;
    const remaining = MAX_SEARCHES_PER_MESSAGE - used;
    const results = await performSearch(turn.search, emit, isAborted, deps);
    if (isAborted()) return;

    const budget =
      remaining > 0
        ? `Searches remaining for this message: ${remaining}.`
        : 'Searches remaining for this message: 0. Do not call search_properties again; answer with what you have.';
    turn = await runTurn(
      sessionKey,
      `${results}\n\n${budget}`,
      emit,
      isAborted,
      deps,
      remaining > 0 ? SEARCH_TURN : LAST_RESULTS_TURN,
    );
  }

  // The model asked for a search it was told it could not have. Its
  // acknowledgement was dropped, so give it one text-only turn to answer.
  if (turn.ignoredSearch && !isAborted()) {
    await runTurn(sessionKey, SEARCH_LIMIT_MESSAGE, emit, isAborted, deps, FINAL_TURN);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/chat.test.ts`
Expected: PASS, 12 tests.

If "does not search when the lambda rejected the call" fails on the token text, check that `forwardProse` is set back to `true` in the `status === 'error'` branch. If the abort test still emits `listings`, check that `performSearch` is not called after `isAborted()` turns true — the loop condition covers it.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `VECTARA_API_KEY=test-key npm test`
Expected: PASS, every file.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/chat.ts apps/server/src/chat.test.ts
git commit -m "Let one message run up to three searches, built from the lambda's normalised criteria" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Keyword blend on corpus search

The corpus query is pure neural today. With the user's own words now reaching it as the query (Task 3), a small lexical component makes exact tokens like a tower name or "furnished" count. Vectara's documented starting point is 0.025. The sidebar path shares this function; its query is the constant fallback, so its results are unaffected.

**Files:**
- Modify: `apps/server/src/vectara.ts:43-71`
- Test: `apps/server/src/vectara.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. The request body gains `search.lexical_interpolation`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/vectara.test.ts`. Change the import line to:

```ts
import { getListingById, searchListings } from './vectara.js';
```

Append a new describe block at the end of the file:

```ts
describe('searchListings', () => {
  it('sends the exact filter, the ranking query, and a small keyword blend', async () => {
    const spy = stubFetch({ search_results: [{ document_metadata: METADATA }] });
    const listings = await searchListings({ purpose: 'rent', area: 'Clifton' }, 'sea facing');

    expect(listings.map((l) => l.externalId)).toEqual(['12345']);
    const init = (spy.mock.calls[0] as unknown[] | undefined)?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      query: string;
      search: { metadata_filter?: string; lexical_interpolation: number; limit: number };
    };
    expect(body.query).toBe('sea facing');
    expect(body.search.metadata_filter).toBe("doc.purpose = 'rent' AND (doc.area_l3_norm = 'clifton' OR doc.area_l4_norm = 'clifton' OR doc.area_l5_norm = 'clifton')");
    expect(body.search.lexical_interpolation).toBe(0.025);
    expect(body.search.limit).toBe(40);
  });

  it('falls back to a broad query rather than sending an empty one', async () => {
    const spy = stubFetch({ search_results: [] });
    await searchListings({}, '   ');
    const init = (spy.mock.calls[0] as unknown[] | undefined)?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { query: string; search: Record<string, unknown> };
    expect(body.query).toBe('property in Karachi');
    expect(body.search).not.toHaveProperty('metadata_filter');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/vectara.test.ts`
Expected: FAIL on `lexical_interpolation` being `undefined`.

- [ ] **Step 3: Implement**

In `apps/server/src/vectara.ts`, add above `searchListings`:

```ts
/**
 * Weight of keyword matching in corpus search, 0 = pure neural. Vectara's
 * suggested starting point; enough for an exact token like a tower name or
 * "furnished" to count without letting keywords dominate.
 */
const LEXICAL_INTERPOLATION = 0.025;
```

and change the `search` object in the request body to:

```ts
      search: {
        ...(metadataFilter ? { metadata_filter: metadataFilter } : {}),
        lexical_interpolation: LEXICAL_INTERPOLATION,
        limit,
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/vectara.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add apps/server/src/vectara.ts apps/server/src/vectara.test.ts
git commit -m "Blend a little keyword matching into corpus search" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The lambda's `query` argument and the prompt

The lambda's Python signature *is* the tool schema the model fills. Add `query`, and teach the prompt when to use it, that it may search up to three times, and what to do with warnings. There is no Python test runner in the repo; the lambda is checked by calling it locally and, in Task 8, by Vectara's validation on upload.

**Files:**
- Modify: `vectara/search_properties.py`
- Modify: `vectara/agent-instructions.md`

**Interfaces:**
- Produces: `process(..., query: str = "")`; the returned `criteria` dict gains `query` when given.

- [ ] **Step 1: Record the lambda's current behaviour**

Run from the repo root:

```bash
cd vectara && python3 -c "import search_properties as s; print(s.process('rent', area='Clifton', query='sea facing'))"
```

Expected: `TypeError: process() got an unexpected keyword argument 'query'`.

- [ ] **Step 2: Add the argument**

In `vectara/search_properties.py`, change the signature to end with:

```python
    floor: str = "",
    min_area_sqft: int = 0,
    query: str = "",
) -> dict:
```

Add to the docstring's `Args:` block, after `min_area_sqft`:

```python
        query: The user's own words beyond the filters, e.g. 'sea facing
            furnished', 'near a school', 'corner'. Used only to rank results
            within the filters. Leave empty when they said nothing beyond the
            structured criteria. Never put an area, a price or a bedroom count
            here; those have their own arguments.
```

Add before the `return {` at the end of `process`:

```python
    if query and query.strip():
        # Ranking text only; the server bounds it again before it reaches the corpus.
        criteria["query"] = " ".join(query.split())[:300]
```

- [ ] **Step 3: Verify the lambda locally**

```bash
cd vectara && python3 -c "
import search_properties as s
out = s.process('rent', area='Clifton', query='  sea   facing ')
assert out['criteria'] == {'purpose': 'rent', 'area': 'Clifton', 'query': 'sea facing'}, out
assert 'query' not in s.process('buy')['criteria']
assert s.process('rent', area='Gulshan, Johar')['criteria']['area'] == ['Gulshan', 'Johar']
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 4: Update the prompt**

In `vectara/agent-instructions.md`, add a row to the arguments table directly after the `min_area_sqft` row:

```markdown
| `query` | string | The user's own words beyond the filters, e.g. `sea facing furnished`, `near a school`, `corner`. Ranks results within the filters. Leave empty if they said nothing beyond the structured criteria. Never put an area, a price or a bedroom count here — those have their own arguments |
```

Replace the paragraph that begins `**The tool does not return the properties itself.**` and its numbered list and the line `Never describe, price, or name a property before that listings message arrives.` with:

```markdown
**The tool does not return the properties itself.** It confirms the criteria, and the matching listings are then given to you in the very next message. So:

1. Call `search_properties`.
2. When it returns, reply with a **very short acknowledgement only** — at most eight words. Do not describe any property yet.
3. The next message will contain the real listings. **That** is when you describe them.

Never describe, price, or name a property before that listings message arrives.

If the tool result lists **warnings**, those values were ignored for the search. Tell the user what was ignored and how to say it instead (for example, "apartment" is not a property type here — the closest is `Flats`).

## Searching more than once

You may call `search_properties` up to **three times** for one user message. Each SEARCH RESULTS message says how many searches remain; when it says none remain, do not search again — answer with what you have and offer to continue in their next message.

Search again without asking when you are loosening a price, bedroom, floor or property-type filter after nothing matched — but say what you changed. **Never** change or drop the area on your own: if the results show an "anywhere in Karachi" count, offer it and wait for a yes.

When a SEARCH RESULTS message lists relaxations the system checked, those are counts only — the user has not seen those listings. Suggest the most useful one.
```

- [ ] **Step 5: Check the rendered prompt still has every placeholder**

```bash
grep -o '{{[A-Z_]*}}' vectara/agent-instructions.md | sort | uniq -c
```

Expected: one line each for `{{AREAS}}`, `{{BUY_COUNT}}`, `{{RENT_COUNT}}` and `{{TOTAL}}`, each with count `1`.

- [ ] **Step 6: Commit**

```bash
git add vectara/search_properties.py vectara/agent-instructions.md
git commit -m "Let the agent pass the user's own words as a ranking query and search up to three times" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Replace the agent in place, and remind it every turn

`npm run setup:agent` today deletes the agent before replacing its tool, which kills every live session — including the deployed service's — on every prompt change. `setup-pipeline.ts` already solves the same problem for the ingest agent: replace the agent *without* the tool, delete the tool, create the new one, then replace the agent again with it. Mirror that. While here, add a step reminder so the "only describe returned listings" rule is re-injected on every input, which is what keeps it effective in long sessions.

**Files:**
- Modify: `packages/ingest/src/setup-vectara.ts:129-275`

**Interfaces:**
- Produces: `ensureSearchTool(client, listings, facets): Promise<string>`; `ensureAgent(client, listings, facets, searchToolId: string): Promise<void>`. `main()` no longer deletes the agent.

- [ ] **Step 1: Replace the tool and agent functions**

In `packages/ingest/src/setup-vectara.ts`, add after the `ToolSummary` interface (line ~132):

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-injected on every input — including the SEARCH RESULTS messages the
 * server sends — so the rule survives long sessions where the system prompt
 * has scrolled out of the model's effective attention.
 */
const RESULTS_REMINDER =
  'Reminder: only describe listings that appear in a SEARCH RESULTS message. Never invent ' +
  'a property, price, area or phone number. If nothing matched, say so and suggest one ' +
  'relaxation rather than inventing a match.';

/** Every tool with our name, paged through the full list: the account has
 *  several hundred built-in tools, so a single page never reaches our own. */
async function findSearchTools(client: VectaraClient): Promise<ToolSummary[]> {
  let pageKey: string | undefined;
  const found: ToolSummary[] = [];
  do {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const { data } = await client.request<{
      tools?: ToolSummary[];
      metadata?: { page_key?: string };
    }>('GET', `/tools?${query}`);

    for (const tool of data.tools ?? []) {
      if (tool.name === SEARCH_TOOL_NAME) found.push(tool);
    }
    pageKey = data.metadata?.page_key || undefined;
  } while (pageKey);
  return found;
}

/**
 * The agent's full definition. With `searchToolId` null it is built without
 * the search tool, which is how the tool is freed for replacement.
 */
async function agentConfig(
  listings: Listing[],
  facets: Facets,
  searchToolId: string | null,
): Promise<Record<string, unknown>> {
  const template = await readFile(join(ROOT, 'vectara', 'agent-instructions.md'), 'utf8');
  const instructions = template
    .replace('{{TOTAL}}', String(listings.length))
    .replace('{{RENT_COUNT}}', String(listings.filter((l) => l.purpose === 'rent').length))
    .replace('{{BUY_COUNT}}', String(listings.filter((l) => l.purpose === 'buy').length))
    .replaceAll('{{CORPUS_KEY}}', CORPUS_KEY)
    .replace('{{AREAS}}', renderAreaList(facets));

  return {
    key: AGENT_KEY,
    name: 'Zameen Property Assistant',
    description: 'Conversational property search over Zameen.com Karachi listings.',
    model: { name: AGENT_MODEL, parameters: { max_tokens: 1500 } },
    first_step_name: 'main',
    steps: {
      main: {
        type: 'conversational',
        instructions: [
          {
            type: 'inline',
            name: 'zameen_property_assistant',
            template: instructions,
            // The instructions contain `$` and `#` characters that Velocity
            // would try to interpret; plain text avoids that entirely.
            template_type: 'text',
          },
        ],
        reminders: [
          {
            type: 'templated',
            template_type: 'text',
            template: RESULTS_REMINDER,
            hooks: ['input_message'],
          },
        ],
        output_parser: { type: 'default' },
      },
    },
    tool_configurations: searchToolId
      ? { [SEARCH_TOOL_NAME]: { type: 'lambda', tool_id: searchToolId } }
      : {},
  };
}

/**
 * Create the agent, or replace it in place. PUT keeps the agent's sessions;
 * the delete-and-recreate this used to do ended every live conversation on
 * each prompt change. Returns true when the agent was newly created.
 */
async function putAgent(client: VectaraClient, config: Record<string, unknown>): Promise<boolean> {
  const created = await client.request('POST', '/agents', config, { allowStatuses: [409] });
  if (created.status !== 409) return true;
  // PUT replaces; PATCH merges, which cannot remove a tool reference.
  await client.request('PUT', `/agents/${AGENT_KEY}`, config);
  return false;
}
```

Replace the existing `ensureSearchTool` function entirely with:

```ts
/**
 * Create (or replace) the agent's search tool.
 *
 * It is a lambda because a lambda's input schema is generated from its Python
 * signature and is therefore flat — which is the part a model can actually
 * fill. The built-in corpora_search tool takes a nested `search` object that
 * the model never emits, and whose `corpora` array can only be set through
 * `argument_override`, making a per-call metadata filter impossible.
 *
 * The lambda only validates criteria; the server performs the real search.
 *
 * Vectara refuses to delete a tool an agent references, so the agent is first
 * replaced *without* the tool, and reattached in `ensureAgent`. Deletion is
 * asynchronous, hence the wait before recreating under the same name.
 */
async function ensureSearchTool(client: VectaraClient, listings: Listing[], facets: Facets): Promise<string> {
  console.log(`\n[3/4] Tool "${SEARCH_TOOL_NAME}"`);

  const existing = await findSearchTools(client);
  if (existing.length > 0) {
    await putAgent(client, await agentConfig(listings, facets, null));
    console.log('      detached from the agent');

    for (const tool of existing) {
      await client.request('DELETE', `/tools/${tool.id}`, undefined, { allowStatuses: [404] });
    }

    let remaining = existing.length;
    for (let i = 0; i < 20 && remaining > 0; i++) {
      await sleep(1500);
      remaining = (await findSearchTools(client)).length;
    }
    if (remaining > 0) {
      throw new Error(
        `${remaining} old "${SEARCH_TOOL_NAME}" tool(s) could not be deleted — ` +
          'another agent still references them.',
      );
    }
    console.log(`      removed ${existing.length} previous version(s)`);
  }

  const code = await readFile(join(ROOT, 'vectara', 'search_properties.py'), 'utf8');
  const created = await client.request<{ id?: string; function_definition?: { validation_status?: string } }>(
    'POST',
    '/tools',
    {
      type: 'lambda',
      language: 'python',
      name: SEARCH_TOOL_NAME,
      title: 'Search Karachi Properties',
      description:
        'Search Karachi property listings by structured criteria (purpose, area, bedrooms, ' +
        'price, property type, floor) plus the user\'s own words for ranking. Returns the ' +
        'normalised criteria; the matching listings are delivered in the following message.',
      code,
    },
  );

  const id = created.data.id;
  if (!id) throw new Error('Tool creation returned no id');
  console.log(`      created ${id} (${created.data.function_definition?.validation_status ?? 'unknown'})`);
  return id;
}
```

Replace the existing `ensureAgent` function entirely with:

```ts
async function ensureAgent(
  client: VectaraClient,
  listings: Listing[],
  facets: Facets,
  searchToolId: string,
): Promise<void> {
  console.log(`\n[4/4] Agent "${AGENT_KEY}"`);
  const created = await putAgent(client, await agentConfig(listings, facets, searchToolId));
  console.log(created ? '      created' : '      updated in place');
}
```

In `main()`, replace these three lines:

```ts
  // The agent must be deleted before its tool can be replaced, then recreated
  // pointing at the new tool id.
  await client.request('DELETE', `/agents/${AGENT_KEY}`, undefined, { allowStatuses: [404] });
  const searchToolId = await ensureSearchTool(client);
```

with:

```ts
  const searchToolId = await ensureSearchTool(client, listings, facets);
```

Also update the file's header comment: change the line

```ts
 * and the tool and agent are recreated (the agent is torn down first, since an
 * agent referencing a tool blocks that tool's deletion).
```

to

```ts
 * the tool is replaced, and the agent is updated in place (detached from the
 * old tool first, since an agent referencing a tool blocks its deletion) so
 * its sessions survive.
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If it reports `Facets` or `Listing` unused or missing, check the import on line 16 still reads `import type { Facets, Listing } from '@zameen/shared';`.

- [ ] **Step 3: Confirm nothing else calls the old signatures**

```bash
grep -rn "ensureSearchTool\|ensureAgent\|DELETE', \`/agents" packages/ingest/src
```

Expected: only the definitions and the two calls in `main()`; no `DELETE` of `/agents/`.

- [ ] **Step 4: Commit**

```bash
git add packages/ingest/src/setup-vectara.ts
git commit -m "Replace the agent in place on setup and remind it every turn to stick to real listings" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README

**Files:**
- Modify: `README.md` — the "How filtering stays exact" section.

- [ ] **Step 1: Update the chat bullet**

In `README.md`, replace the bullet that begins `- **Chat** → the agent calls the` with:

```markdown
- **Chat** → the agent calls the `search_properties` tool with *structured arguments* (`purpose`, `area`, `min_bedrooms`, …) plus a free-text `query` carrying the user's own words ("sea facing", "furnished") for ranking. The server takes the lambda's *normalised* criteria — so a value the lambda dropped is never applied as a filter — builds the same filter, runs the query, and hands the results back to the agent to describe. One message may do this up to three times, so the agent can relax a filter after an empty result without asking. When nothing matches, the server also counts a few relaxations (a wider budget, one fewer bedroom, anywhere in Karachi) and gives the agent the counts, so its suggestion is measured rather than guessed.
```

Replace the sentence `A chat search therefore runs as two agent turns with our own exact query in between. The agent never sees unfiltered data and only ever describes listings that genuinely matched.` with:

```markdown
Each chat search therefore runs as two agent turns with our own exact query in between. The agent never sees unfiltered data and only ever describes listings that genuinely matched.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the ranking query and multi-search in the README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Deploy the agent and verify live

This task writes to the Vectara account and spends a few model turns. Everything before it is local.

**Files:** none changed. Creates a gitignored `.env` symlink in the worktree.

- [ ] **Step 1: Point the worktree at the main checkout's `.env`**

```bash
ln -s ../../../.env .env && test -f .env && grep -c '^VECTARA_API_KEY=' .env
```

Expected: `1`. (`.env` is gitignored; the symlink stays local.)

- [ ] **Step 2: Open a session on the current agent, to prove sessions survive**

```bash
KEY=$(grep '^VECTARA_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n'); curl -s -X POST https://api.vectara.io/v2/agents/zameen_property_assistant/sessions -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{"name":"survive-check"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["key"])'
```

Expected: a session key. Save it as `SURVIVE`.

- [ ] **Step 3: Redeploy the tool and the agent**

```bash
npm run setup:agent
```

Expected output includes:

```
[3/4] Tool "search_properties"
      detached from the agent
      removed 1 previous version(s)
      created tol_... (valid)
[4/4] Agent "zameen_property_assistant"
      updated in place
```

If the detach step fails with HTTP 400, the platform rejected an agent with no tools. Stop and report; do not fall back to deleting the agent.

- [ ] **Step 4: Confirm the agent config and the surviving session**

```bash
KEY=$(grep '^VECTARA_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n'); curl -s https://api.vectara.io/v2/agents/zameen_property_assistant -H "x-api-key: $KEY" | python3 -c 'import sys,json; a=json.load(sys.stdin); s=a["steps"]["main"]; print("reminders:", [r["hooks"] for r in s.get("reminders",[])]); print("tool:", a["tool_configurations"]["search_properties"]["tool_id"])'
```

Expected: `reminders: [['input_message']]` and a `tol_` id matching Step 3.

```bash
KEY=$(grep '^VECTARA_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n'); curl -s -o /dev/null -w '%{http_code}\n' https://api.vectara.io/v2/agents/zameen_property_assistant/sessions/$SURVIVE -H "x-api-key: $KEY"
```

Expected: `200`. The pre-existing session is still there after the redeploy.

- [ ] **Step 5: Confirm the lambda's schema has `query`**

```bash
KEY=$(grep '^VECTARA_API_KEY=' .env | cut -d= -f2- | tr -d '\r\n'); TOOL=$(curl -s https://api.vectara.io/v2/agents/zameen_property_assistant -H "x-api-key: $KEY" | python3 -c 'import sys,json; print(json.load(sys.stdin)["tool_configurations"]["search_properties"]["tool_id"])'); curl -s https://api.vectara.io/v2/tools/$TOOL -H "x-api-key: $KEY" | python3 -c 'import sys,json; t=json.load(sys.stdin); print(sorted(t["function_definition"]["input_schema"]["properties"].keys()))'
```

Expected: a list containing `'query'` alongside `'purpose'`, `'area'`, and the rest. (If the schema lives under a different key in the response, print the whole `function_definition` and locate it; the point is that `query` is present.)

- [ ] **Step 6: Smoke-test the loop through the local server**

Start the dev server (API on 8787, UI on 5173) with the Browser pane's `preview_start` using the `dev` configuration from `.claude/launch.json`, then from a shell:

```bash
SK=$(curl -s -X POST http://localhost:8787/api/session -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionKey"])'); echo "session $SK"; curl -sN -X POST http://localhost:8787/api/chat -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$SK\",\"message\":\"I want to rent a 2 bed flat in Clifton, something sea facing\"}" | grep -o '"type":"[a-z_]*"' | sort | uniq -c
```

Expected: counts for `tool_start`, `listings`, `token` and one `done`; no `error`. The single message contained area, purpose and a filter, so the agent searched at once.

Then a search that matches nothing, to exercise the probes:

```bash
curl -sN -X POST http://localhost:8787/api/chat -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$SK\",\"message\":\"Actually make that a 10 bedroom penthouse in Clifton under 50000\"}" | grep -o '"type":"[a-z_]*"' | sort | uniq -c
```

Expected: at least one `tool_start` and `listings`; the streamed tokens should say nothing matched and name a relaxation with a count (read the raw output to confirm). Two `tool_start` events means the agent relaxed a filter itself, which is also correct.

- [ ] **Step 7: Check the server log**

Read the dev server's output (`preview_logs`). Expected: no stack traces. An `Ignored:` line will not appear here — it is inside the message to the agent — so nothing about warnings is expected in the log.

- [ ] **Step 8: Report**

No commit. Report: the tool id, that the pre-existing session survived, the event counts from both smoke tests, and the agent's narration for the empty search. Leave the dev server running for the user.
