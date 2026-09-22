# Agent Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repeatable, scripted conversation eval that runs the real chat loop against the live Vectara agent and grades, per turn, the exact filters each search used, whether the intake asked the right question, and whether every price and area the agent mentions was actually in the listings it was given — so a prompt or model change becomes a measurement instead of a guess.

**Architecture:** The harness lives in `apps/server/src/eval/`. `check.ts` is pure: a price tokenizer that understands lakh, crore and ranges; an area-mention finder; a filter comparator; and `evaluateTurn`. `cases.ts` is a typed list of scripted conversations with expectations. `run.ts` is a thin `tsx` script that mints one Vectara session per case, calls `handleUserMessage` in-process with a wrapped `searchListings` to capture the `SearchFilters` of every real search, collects tokens and listings from the emitted events, grades each turn, prints a report and exits non-zero on failure. Nothing in the server's request path changes.

**Tech Stack:** Node 20, TypeScript 5.7, Vitest 2, tsx, Vectara Agents API v2 (through the existing `vectara.ts` client).

**Spec:** No spec file. Requirements are the phase 3 description agreed in this session: scripted conversations replayed against a real session, assertions on tool arguments, and a hallucination check that every price and area in the narration appears in the results message.

## Global Constraints

- **Run tests as** `VECTARA_API_KEY=test-key npm test`. One file: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/check.test.ts`.
- **Typecheck with** `npm run typecheck`, exit 0 with no output.
- **No new runtime dependencies.**
- **Tests are co-located** `*.test.ts`; Vitest `environment: 'node'`.
- **Do not call Vectara from tests or from implementer verification.** Only Task 4, run by the controller, talks to the live agent. Any test importing `run.ts`, `chat.ts` or `vectara.ts` sets `process.env['VECTARA_API_KEY'] ??= 'test-key'` before `await import(...)`.
- **The eval must not change the chat loop.** It observes `handleUserMessage` through its existing `ChatDeps` injection and `emit` events only.
- **Cost is deliberate.** The runner is sequential (one case at a time) and runs only when invoked. Each case costs one session and one to four model turns.
- **Commit messages** follow the repo's style: one imperative line, no prefix. End the body with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Code comments** explain *why*, in the voice of the existing files.

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/eval/check.ts` (new) | **Pure.** `extractPrices`, `findAreaMentions`, `compareFilters`, `checkGrounding`, `evaluateTurn`. |
| `apps/server/src/eval/check.test.ts` (new) | Their tests. |
| `apps/server/src/eval/cases.ts` (new) | The scripted conversations and their expectations. |
| `apps/server/src/eval/report.ts` (new) | **Pure.** CLI argument parsing and report formatting. |
| `apps/server/src/eval/report.test.ts` (new) | Their tests. |
| `apps/server/src/eval/run.ts` (new) | The runner: sessions, capture, grading, exit code. |
| `apps/server/package.json`, `package.json` | `eval` scripts. |
| `README.md` | "Evaluating the agent" section. |

---

### Task 1: The pure checks

**Files:**
- Create: `apps/server/src/eval/check.ts`
- Test: `apps/server/src/eval/check.test.ts`

**Interfaces:**
- Consumes: `Listing`, `SearchFilters` from `@zameen/shared`.
- Produces:
  - `export function extractPrices(text: string): number[]` — PKR amounts the text states, deduplicated, in order of appearance.
  - `export function findAreaMentions(text: string, knownAreas: readonly string[]): string[]` — known area names present as whole phrases, longest first, deduplicated.
  - `export interface FilterDiff { missing: string[]; different: string[]; extra: string[] }`
  - `export function compareFilters(expected: SearchFilters, actual: SearchFilters): FilterDiff`
  - `export interface GroundingResult { ungroundedPrices: number[]; ungroundedAreas: string[] }`
  - `export function checkGrounding(input: { narration: string; listings: Listing[]; knownAreas: readonly string[]; allowedText: string; tolerance?: number }): GroundingResult`
  - `export interface TurnExpectation { searches?: SearchFilters[]; narration?: RegExp; skipGrounding?: boolean }`
  - `export interface Observed { userMessage: string; searches: SearchFilters[]; listings: Listing[]; narration: string; errors: string[] }`
  - `export interface TurnVerdict { failures: string[]; warnings: string[] }`
  - `export function evaluateTurn(expect: TurnExpectation, observed: Observed, knownAreas: readonly string[]): TurnVerdict`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/eval/check.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Listing } from '@zameen/shared';
import {
  checkGrounding,
  compareFilters,
  evaluateTurn,
  extractPrices,
  findAreaMentions,
} from './check.js';

const LISTING = {
  externalId: '1', title: 'Well kept 3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 125_000,
  priceLabel: 'PKR 1.25 Lakh', rentFrequency: null, areaSqft: 1269, areaSqyd: 141,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Clifton - Block 1', areaL5: 'Cliftonia',
  areaPath: 'Clifton > Clifton - Block 1 > Cliftonia',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

const listingAt = (pricePkr: number, areaPath = LISTING.areaPath): Listing => ({ ...LISTING, pricePkr, areaPath });

const AREAS = ['Clifton', 'Clifton - Block 1', 'DHA Phase 6', 'DHA Defence', 'North Nazimabad', 'Gulshan-e-Iqbal', 'Gulshan-e-Iqbal Town'];

describe('extractPrices', () => {
  it('reads lakh and crore with a PKR prefix or without', () => {
    expect(extractPrices('PKR 1.25 lakh and 2.5 crore')).toEqual([125_000, 25_000_000]);
  });

  it('applies a trailing unit to both ends of a range', () => {
    expect(extractPrices('rents run 1.25–1.6 lakh here')).toEqual([125_000, 160_000]);
  });

  it('keeps a comma-formatted first number in a mixed range as rupees', () => {
    expect(extractPrices('from 75,000–1.65 lakh')).toEqual([75_000, 165_000]);
  });

  it('reads comma-formatted rupee amounts and k', () => {
    expect(extractPrices('around 85k, or PKR 75,000, or Rs 45,000')).toEqual([85_000, 75_000, 45_000]);
  });

  it('ignores sizes, counts, ordinals and bare small numbers', () => {
    expect(extractPrices('a 2-bed, 1,269 sq ft flat on the 5th floor; 40 matches; 3 bedrooms in 2026')).toEqual([]);
  });

  it('ignores a difference, not a price', () => {
    expect(extractPrices('roughly 40–50k less per month than Clifton')).toEqual([]);
  });

  it('keeps a per-month price', () => {
    expect(extractPrices('1.6 lakh/month for the verified one')).toEqual([160_000]);
  });

  it('deduplicates', () => {
    expect(extractPrices('1.5 lakh … again 1.5 lakh')).toEqual([150_000]);
  });
});

describe('findAreaMentions', () => {
  it('finds known names as whole phrases, case-insensitively', () => {
    expect(findAreaMentions('Clifton is pricier than dha phase 6.', AREAS)).toEqual(['DHA Phase 6', 'Clifton']);
  });

  it('does not match inside a longer word', () => {
    expect(findAreaMentions('Cliftonia tower', AREAS)).toEqual([]);
  });

  it('returns each name once', () => {
    expect(findAreaMentions('Clifton, then Clifton again', AREAS)).toEqual(['Clifton']);
  });
});

describe('compareFilters', () => {
  it('is clean when the actual filters cover the expected ones exactly', () => {
    expect(
      compareFilters({ purpose: 'rent', area: 'Clifton', minBedrooms: 2 }, { purpose: 'rent', area: 'clifton', minBedrooms: 2 }),
    ).toEqual({ missing: [], different: [], extra: [] });
  });

  it('reports missing, different and extra keys', () => {
    expect(
      compareFilters(
        { purpose: 'rent', area: 'Clifton', minBedrooms: 2, propertyType: 'Flats' },
        { purpose: 'rent', minBedrooms: 3, floor: 'ground' },
      ),
    ).toEqual({
      missing: ['area', 'propertyType'],
      different: ['minBedrooms: expected 2, got 3'],
      extra: ['floor: ground'],
    });
  });

  it('treats area and areas as one set', () => {
    expect(
      compareFilters({ areas: ['North Nazimabad', 'Clifton'] }, { area: 'clifton', areas: ['north nazimabad'] }),
    ).toEqual({ missing: [], different: [], extra: [] });
    expect(compareFilters({ area: 'Clifton' }, { areas: ['Clifton', 'DHA Phase 6'] }).different).toEqual([
      'area: expected clifton, got clifton or dha phase 6',
    ]);
  });
});

describe('checkGrounding', () => {
  it('accepts prices within tolerance of a listing and areas in a listing path', () => {
    const result = checkGrounding({
      narration: 'The Clifton flat is about PKR 1.3 lakh in Clifton - Block 1.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('flags a price no listing has and an area no listing is in', () => {
    const result = checkGrounding({
      narration: 'There is a bargain at 90,000 in DHA Phase 6.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [90_000], ungroundedAreas: ['DHA Phase 6'] });
  });

  it('allows prices and areas the user themselves mentioned', () => {
    const result = checkGrounding({
      narration: 'Nothing under 50,000 in DHA Phase 6, but Clifton has one at 1.25 lakh.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: 'anything under 50,000 in DHA Phase 6?',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });
});

describe('evaluateTurn', () => {
  const observed = (over: Partial<Parameters<typeof evaluateTurn>[1]>) => ({
    userMessage: 'rent a 2 bed flat in Clifton',
    searches: [{ purpose: 'rent' as const, area: 'clifton', minBedrooms: 2 }],
    listings: [listingAt(125_000)],
    narration: 'One Clifton flat at 1.25 lakh.',
    errors: [],
    ...over,
  });

  it('passes a grounded turn whose search matches', () => {
    expect(evaluateTurn({ searches: [{ purpose: 'rent', area: 'Clifton', minBedrooms: 2 }] }, observed({}), AREAS)).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails on the wrong number of searches', () => {
    const v = evaluateTurn({ searches: [] }, observed({}), AREAS);
    expect(v.failures).toEqual(['expected 0 search(es), got 1']);
  });

  it('fails on a missing filter, warns on an extra one', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton', propertyType: 'Flats' }] },
      observed({ searches: [{ purpose: 'rent', area: 'clifton', minBedrooms: 2 }] }),
      AREAS,
    );
    expect(v.failures).toEqual(['search 1: missing propertyType']);
    expect(v.warnings).toEqual(['search 1: extra minBedrooms: 2']);
  });

  it('fails on an ungrounded price, an error event, and a narration mismatch', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent' }], narration: /DHA/ },
      observed({ narration: 'A flat at 2 lakh.', errors: ['Search failed: HTTP 503'] }),
      AREAS,
    );
    expect(v.failures).toEqual([
      'error event: Search failed: HTTP 503',
      'narration does not match /DHA/',
      'price not in results: PKR 200,000',
    ]);
  });

  it('skips grounding when told to, and when there were no listings', () => {
    expect(evaluateTurn({ skipGrounding: true }, observed({ narration: 'Try 3 lakh.' }), AREAS).failures).toEqual([]);
    expect(evaluateTurn({}, observed({ listings: [], narration: 'Nothing; try 3 lakh.' }), AREAS).failures).toEqual([]);
  });

  it('fails an empty narration', () => {
    expect(evaluateTurn({}, observed({ narration: '   ' }), AREAS).failures).toEqual(['empty narration']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/check.test.ts`
Expected: FAIL with "Failed to resolve import './check.js'".

- [ ] **Step 3: Implement**

Create `apps/server/src/eval/check.ts`:

```ts
import type { Listing, SearchFilters } from '@zameen/shared';

/**
 * Pure grading for the eval harness.
 *
 * Everything here works on text and plain data so it can be unit-tested
 * without a model in the loop. The runner feeds it what the chat loop
 * emitted; it says what was wrong.
 */

const UNIT_MULTIPLIER: Record<string, number> = {
  k: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
};

const UNIT = '(?:lakhs?|lac|crores?|cr|k)';

/** A number is not a price when the next word says what it counts. */
const NOT_A_PRICE = /^(?:sq|sqft|sq\.|bed|beds|bedroom|bedrooms|bath|baths|bathroom|bathrooms|floor|floors|listing|listings|match|matches|option|options|result|results|property|properties|flat|flats|house|houses|marla|kanal|yard|yards|km|min|mins|minute|minutes|hour|hours|day|days|%|of|more|further|search|searches)\b/i;

/** A price stated as a gap ("40k less") is not a price anything is listed at. */
const DIFFERENCE = /\b(?:less|more|cheaper|dearer|higher|lower|apart|difference|extra|saving|savings|off)\b/i;

function toNumber(raw: string): number {
  return Number.parseFloat(raw.replace(/,/g, ''));
}

/**
 * Prices the text states, in PKR.
 *
 * Handles the ways the agent writes money: `PKR 1.25 lakh`, `2.5 crore`,
 * `85k`, `Rs 45,000`, `75,000`, and ranges such as `1.25–1.6 lakh` where the
 * unit is written once. Bare numbers without a comma or unit are ignored —
 * they are bedrooms, floors and years far more often than rupees.
 */
export function extractPrices(text: string): number[] {
  // One dash style, then spread a range's trailing unit onto a unit-less
  // first number — but only a small one; `75,000–1.65 lakh` mixes forms.
  const normalised = text
    .replace(/[–—]/g, '-')
    .replace(
      // The lookbehind keeps the digits after a comma (`75,000`) from being
      // read as a small first number of their own.
      new RegExp(`(?<![\\d,])(\\d+(?:\\.\\d+)?)\\s*-\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT})\\b`, 'gi'),
      (whole, first: string, second: string, unit: string) =>
        toNumber(first) < 1000 ? `${first} ${unit} - ${second} ${unit}` : whole,
    );

  const found: number[] = [];
  const pattern = new RegExp(`(PKR|Rs\\.?)?\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT})?\\b`, 'gi');
  for (const match of normalised.matchAll(pattern)) {
    const [, currency, raw, unit] = match;
    if (!raw) continue;
    const after = normalised.slice((match.index ?? 0) + match[0].length).trimStart();
    // Six words is enough to see past the second half of a range
    // ("40k - 50k less per month"); a price followed by "more" within that
    // window is merely dropped from the check, never counted as wrong.
    const nextWords = after.split(/\s+/).slice(0, 6).join(' ');
    if (DIFFERENCE.test(nextWords)) continue;

    let value: number | null = null;
    if (unit) value = toNumber(raw) * (UNIT_MULTIPLIER[unit.toLowerCase()] ?? 1);
    else if (NOT_A_PRICE.test(after)) continue;
    else if (currency) value = toNumber(raw);
    else if (raw.includes(',') && toNumber(raw) >= 1000) value = toNumber(raw);

    if (value !== null && Number.isFinite(value) && !found.includes(value)) found.push(value);
  }
  return found;
}

/** Known area names present in the text as whole phrases, longest first. */
export function findAreaMentions(text: string, knownAreas: readonly string[]): string[] {
  const hay = text.toLowerCase();
  const found: string[] = [];
  for (const name of [...knownAreas].sort((a, b) => b.length - a.length)) {
    const needle = name.toLowerCase();
    let from = 0;
    while (from <= hay.length) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const before = at === 0 ? ' ' : hay[at - 1]!;
      const afterChar = hay[at + needle.length] ?? ' ';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(afterChar)) {
        if (!found.includes(name)) found.push(name);
        break;
      }
      from = at + 1;
    }
  }
  return found;
}

export interface FilterDiff {
  missing: string[];
  different: string[];
  extra: string[];
}

function areaSet(filters: SearchFilters): string[] {
  return [filters.area, ...(filters.areas ?? [])]
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((a) => a.toLowerCase())
    .sort();
}

/**
 * Compare the filters a search used against what a case expected.
 *
 * `area` and `areas` are one set; strings compare case-insensitively because
 * the lambda lowercases what it returns. Extra keys are reported separately —
 * the model adding a filter the user implied is a warning, not a failure.
 */
export function compareFilters(expected: SearchFilters, actual: SearchFilters): FilterDiff {
  const diff: FilterDiff = { missing: [], different: [], extra: [] };

  const wanted = areaSet(expected);
  const got = areaSet(actual);
  if (wanted.length > 0 && got.length === 0) diff.missing.push('area');
  else if (wanted.length > 0 && wanted.join('|') !== got.join('|')) {
    diff.different.push(`area: expected ${wanted.join(' or ')}, got ${got.join(' or ')}`);
  } else if (wanted.length === 0 && got.length > 0) diff.extra.push(`area: ${got.join(' or ')}`);

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)] as (keyof SearchFilters)[]);
  keys.delete('area');
  keys.delete('areas');
  const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  for (const key of [...keys].sort()) {
    const e = expected[key];
    const a = actual[key];
    if (e === undefined && a !== undefined) diff.extra.push(`${key}: ${String(a)}`);
    else if (e !== undefined && a === undefined) diff.missing.push(key);
    else if (norm(e) !== norm(a)) diff.different.push(`${key}: expected ${String(e)}, got ${String(a)}`);
  }
  return diff;
}

export interface GroundingResult {
  ungroundedPrices: number[];
  ungroundedAreas: string[];
}

/**
 * Every price and area the narration states must come from the listings the
 * agent was given, or from the user's own words. A price counts as grounded
 * when some listing is within `tolerance` of it, because the agent rounds.
 */
export function checkGrounding({
  narration,
  listings,
  knownAreas,
  allowedText,
  tolerance = 0.1,
}: {
  narration: string;
  listings: Listing[];
  knownAreas: readonly string[];
  allowedText: string;
  tolerance?: number;
}): GroundingResult {
  const near = (candidates: number[], price: number) =>
    candidates.some((c) => Math.abs(c - price) <= Math.max(c, price) * tolerance);
  const listingPrices = listings.map((l) => l.pricePkr);
  const allowedPrices = extractPrices(allowedText);
  const ungroundedPrices = extractPrices(narration).filter(
    (p) => !near(listingPrices, p) && !near(allowedPrices, p),
  );

  const paths = listings.map((l) => l.areaPath.toLowerCase());
  const allowedAreas = findAreaMentions(allowedText, knownAreas).map((a) => a.toLowerCase());
  const ungroundedAreas = findAreaMentions(narration, knownAreas).filter((name) => {
    const needle = name.toLowerCase();
    return !paths.some((p) => p.includes(needle)) && !allowedAreas.includes(needle);
  });

  return { ungroundedPrices, ungroundedAreas };
}

export interface TurnExpectation {
  /** Filters each real search must include, in order. `[]` means the turn must not search. */
  searches?: SearchFilters[];
  /** The narration must match. */
  narration?: RegExp;
  /** Skip the grounding check — a zero-result turn quotes probe figures, not listings. */
  skipGrounding?: boolean;
}

export interface Observed {
  userMessage: string;
  searches: SearchFilters[];
  listings: Listing[];
  narration: string;
  errors: string[];
}

export interface TurnVerdict {
  failures: string[];
  warnings: string[];
}

/** Grade one turn. Failures fail the case; warnings are reported only. */
export function evaluateTurn(
  expect: TurnExpectation,
  observed: Observed,
  knownAreas: readonly string[],
): TurnVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const message of observed.errors) failures.push(`error event: ${message}`);

  if (expect.searches) {
    if (observed.searches.length !== expect.searches.length) {
      failures.push(`expected ${expect.searches.length} search(es), got ${observed.searches.length}`);
    }
    expect.searches.forEach((wanted, i) => {
      const actual = observed.searches[i];
      if (!actual) return;
      const diff = compareFilters(wanted, actual);
      for (const m of diff.missing) failures.push(`search ${i + 1}: missing ${m}`);
      for (const m of diff.different) failures.push(`search ${i + 1}: ${m}`);
      for (const m of diff.extra) warnings.push(`search ${i + 1}: extra ${m}`);
    });
  }

  if (!observed.narration.trim()) failures.push('empty narration');
  else if (expect.narration && !expect.narration.test(observed.narration)) {
    failures.push(`narration does not match ${String(expect.narration)}`);
  }

  if (!expect.skipGrounding && observed.listings.length > 0) {
    const grounding = checkGrounding({
      narration: observed.narration,
      listings: observed.listings,
      knownAreas,
      allowedText: observed.userMessage,
    });
    for (const p of grounding.ungroundedPrices) failures.push(`price not in results: PKR ${p.toLocaleString('en-US')}`);
    for (const a of grounding.ungroundedAreas) failures.push(`area not in results: ${a}`);
  }

  return { failures, warnings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/check.test.ts`
Expected: PASS, 23 tests. If "ignores a difference" fails, check that `DIFFERENCE` is tested against the six words *after* the unit (`after` is sliced past the whole match, unit included). If the mixed range test yields `7,500,000`, the range replacement applied the unit to the `000` after the comma — the lookbehind `(?<![\d,])` on the first capture must be present.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — exit 0.

```bash
git add apps/server/src/eval/check.ts apps/server/src/eval/check.test.ts
git commit -m "Add the pure grading checks for the agent eval" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Cases, report formatting, and the runner

**Files:**
- Create: `apps/server/src/eval/cases.ts`
- Create: `apps/server/src/eval/report.ts`
- Test: `apps/server/src/eval/report.test.ts`
- Create: `apps/server/src/eval/run.ts`
- Modify: `apps/server/package.json` (scripts), `package.json` (scripts)

**Interfaces:**
- Consumes: everything Task 1 exports; `handleUserMessage` and `ChatDeps` from `../chat.js`; `createSession`, `searchListings` from `../vectara.js`; `getFacets` from `../facets.js`.
- Produces:
  - `cases.ts`: `export interface EvalTurn { user: string; expect: TurnExpectation }`, `export interface EvalCase { name: string; why: string; turns: EvalTurn[] }`, `export const CASES: EvalCase[]`.
  - `report.ts`: `export interface CliOptions { cases: string[]; json: string | null }`, `export function parseArgs(argv: string[]): CliOptions`, `export interface TurnReport { user: string; observed: Observed; verdict: TurnVerdict }`, `export interface CaseReport { name: string; why: string; passed: boolean; turns: TurnReport[] }`, `export function formatReport(reports: CaseReport[]): string`.
  - Scripts: `npm run eval` at the root → `npm run -w @zameen/server eval --`; `apps/server` `eval: tsx src/eval/run.ts`.

- [ ] **Step 1: Write the failing tests for the pure parts**

Create `apps/server/src/eval/report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatReport, parseArgs, type CaseReport } from './report.js';

describe('parseArgs', () => {
  it('defaults to every case and no JSON file', () => {
    expect(parseArgs([])).toEqual({ cases: [], json: null });
  });

  it('collects repeated --case flags and a --json path', () => {
    expect(parseArgs(['--case', 'a', '--json', 'out.json', '--case', 'b'])).toEqual({
      cases: ['a', 'b'],
      json: 'out.json',
    });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument: --bogus/);
  });
});

describe('formatReport', () => {
  const report = (over: Partial<CaseReport>): CaseReport => ({
    name: 'all-in-one',
    why: 'why',
    passed: true,
    turns: [
      {
        user: 'rent a flat',
        observed: { userMessage: 'rent a flat', searches: [{ purpose: 'rent' }], listings: [], narration: 'ok', errors: [] },
        verdict: { failures: [], warnings: [] },
      },
    ],
    ...over,
  });

  it('marks a passing case with a tick and counts the summary', () => {
    const text = formatReport([report({})]);
    expect(text).toContain('✓ all-in-one');
    expect(text).toContain('1/1 cases passed');
  });

  it('lists each failure and warning under the turn that produced it', () => {
    const text = formatReport([
      report({
        passed: false,
        turns: [
          {
            user: 'rent a flat in Clifton',
            observed: { userMessage: 'rent a flat in Clifton', searches: [], listings: [], narration: 'Which area?', errors: [] },
            verdict: { failures: ['expected 1 search(es), got 0'], warnings: ['search 1: extra floor: ground'] },
          },
        ],
      }),
    ]);
    expect(text).toContain('✗ all-in-one');
    expect(text).toContain('turn 1: "rent a flat in Clifton"');
    expect(text).toContain('  FAIL expected 1 search(es), got 0');
    expect(text).toContain('  warn search 1: extra floor: ground');
    expect(text).toContain('0/1 cases passed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/report.test.ts`
Expected: FAIL with "Failed to resolve import './report.js'".

- [ ] **Step 3: Implement `report.ts`**

```ts
import type { Observed, TurnVerdict } from './check.js';

export interface CliOptions {
  /** Case names to run; empty means all. */
  cases: string[];
  /** Where to write the full JSON report, if anywhere. */
  json: string | null;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { cases: [], json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--case' && value) {
      options.cases.push(value);
      i++;
    } else if (arg === '--json' && value) {
      options.json = value;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  return options;
}

export interface TurnReport {
  user: string;
  observed: Observed;
  verdict: TurnVerdict;
}

export interface CaseReport {
  name: string;
  why: string;
  passed: boolean;
  turns: TurnReport[];
}

/** One screen of results: a line per case, detail only where something went wrong. */
export function formatReport(reports: CaseReport[]): string {
  const lines: string[] = [];
  for (const c of reports) {
    lines.push(`${c.passed ? '✓' : '✗'} ${c.name} — ${c.why}`);
    c.turns.forEach((t, i) => {
      const noisy = t.verdict.failures.length > 0 || t.verdict.warnings.length > 0;
      if (!noisy) return;
      lines.push(`  turn ${i + 1}: "${t.user}"`);
      for (const f of t.verdict.failures) lines.push(`    FAIL ${f}`);
      for (const w of t.verdict.warnings) lines.push(`    warn ${w}`);
      if (t.verdict.failures.length > 0) {
        lines.push(`    searches: ${JSON.stringify(t.observed.searches)}`);
        lines.push(`    narration: ${t.observed.narration.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    });
  }
  const passed = reports.filter((r) => r.passed).length;
  lines.push('');
  lines.push(`${passed}/${reports.length} cases passed`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the report tests to verify they pass**

Run: `VECTARA_API_KEY=test-key npx vitest run apps/server/src/eval/report.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the cases**

Create `apps/server/src/eval/cases.ts`:

```ts
import type { TurnExpectation } from './check.js';

export interface EvalTurn {
  user: string;
  expect: TurnExpectation;
}

export interface EvalCase {
  name: string;
  /** What this case protects, so a failure reads as a regression, not a puzzle. */
  why: string;
  turns: EvalTurn[];
}

const ASKS_FOR_AREA = /area|town|where|location|neighbourhood|neighborhood/i;
const ASKS_RENT_OR_BUY = /rent|buy/i;

/**
 * The conversations the agent must get right.
 *
 * Every area name here is spelled exactly as it appears in the corpus facets,
 * so a failure is the agent's, not the case's. Expected filters are the
 * minimum the search must include; the agent adding a filter the user
 * implied is reported as a warning, not a failure.
 */
export const CASES: EvalCase[] = [
  {
    name: 'all-in-one',
    why: 'A message that answers all three intake questions searches at once.',
    turns: [
      {
        user: 'Rent a 2 bed flat in Clifton, something sea facing',
        expect: { searches: [{ purpose: 'rent', area: 'Clifton', propertyType: 'Flats', minBedrooms: 2 }] },
      },
    ],
  },
  {
    name: 'one-at-a-time',
    why: 'The intake asks one question at a time, area first, then rent or buy.',
    turns: [
      { user: "Hi, I'm looking for a place to live", expect: { searches: [], narration: ASKS_FOR_AREA } },
      { user: 'North Nazimabad', expect: { searches: [], narration: ASKS_RENT_OR_BUY } },
      {
        user: 'Renting, 3 bedrooms',
        expect: { searches: [{ purpose: 'rent', area: 'North Nazimabad', minBedrooms: 3 }] },
      },
    ],
  },
  {
    name: 'anywhere',
    why: '"Any area" counts as answered; the agent must not substitute one.',
    turns: [
      {
        user: 'Any area is fine. I want to buy a house with at least 4 bedrooms',
        expect: { searches: [{ purpose: 'buy', propertyType: 'Houses', minBedrooms: 4 }] },
      },
    ],
  },
  {
    name: 'unknown-area',
    why: 'An area that is not in the corpus is refused, not searched.',
    turns: [
      {
        user: 'Rent a flat in Atlantis Heights Phase 9',
        expect: { searches: [], narration: /not|don't|no |isn't|closest|instead|alternative|nearest/i },
      },
    ],
  },
  {
    name: 'roman-urdu',
    why: 'Roman Urdu intake maps to the same structured search.',
    turns: [
      {
        user: 'Mujhe DHA Phase 6 mein 3 bed ka flat kiraye pe chahiye',
        expect: { searches: [{ purpose: 'rent', area: 'DHA Phase 6', propertyType: 'Flats', minBedrooms: 3 }] },
      },
    ],
  },
  {
    name: 'crore-budget',
    why: 'Crore converts to PKR correctly.',
    turns: [
      {
        user: 'I want to buy a house in Bahria Town Karachi under 2.5 crore',
        expect: { searches: [{ purpose: 'buy', area: 'Bahria Town Karachi', propertyType: 'Houses', maxPrice: 25_000_000 }] },
      },
    ],
  },
  {
    name: 'multi-area',
    why: 'Two areas in one request search both, not just the first.',
    turns: [
      {
        user: '2 bed flats for rent in Gulistan-e-Jauhar or North Nazimabad',
        expect: {
          searches: [{ purpose: 'rent', areas: ['Gulistan-e-Jauhar', 'North Nazimabad'], propertyType: 'Flats', minBedrooms: 2 }],
        },
      },
    ],
  },
  {
    name: 'floor',
    why: 'A floor is filtered only when asked, and mapped to the right bucket.',
    turns: [
      {
        user: 'Ground floor portion for rent in PECHS',
        expect: { searches: [{ purpose: 'rent', area: 'PECHS', floor: 'ground' }] },
      },
    ],
  },
  {
    name: 'zero-results',
    why: 'Nothing matching produces grounded advice, never an invented listing.',
    turns: [
      {
        user: '10 bedroom penthouse in Clifton for rent under 50000',
        expect: {
          searches: [{ purpose: 'rent', area: 'Clifton', propertyType: 'Penthouse', minBedrooms: 10, maxPrice: 50_000 }],
          narration: /relax|widen|anywhere|budget|bedroom|nothing|no listings|none|didn't|did not/i,
          skipGrounding: true,
        },
      },
    ],
  },
  {
    name: 'compare',
    why: 'A comparison runs two searches in one message and reports both.',
    turns: [
      {
        user: 'Compare 2 bed flats for rent in Clifton against 2 bed flats for rent in DHA Phase 6, as two separate searches',
        expect: {
          searches: [
            { purpose: 'rent', area: 'Clifton', propertyType: 'Flats', minBedrooms: 2 },
            { purpose: 'rent', area: 'DHA Phase 6', propertyType: 'Flats', minBedrooms: 2 },
          ],
          narration: /Clifton[\s\S]*DHA Phase 6|DHA Phase 6[\s\S]*Clifton/,
        },
      },
    ],
  },
];
```

- [ ] **Step 6: Write the runner**

Create `apps/server/src/eval/run.ts`:

```ts
/**
 * Replay scripted conversations against the live agent and grade them.
 *
 *   npm run eval                         -- every case
 *   npm run eval -- --case all-in-one    -- one case (repeatable)
 *   npm run eval -- --json eval.json     -- also write the full report
 *
 * This runs the real chat loop in-process, so what it grades is exactly what
 * the server does: the filters each search used, the listings that came back,
 * and the narration. It costs one session and one to four model turns per
 * case, so it runs only when invoked, and one case at a time.
 */
import { writeFile } from 'node:fs/promises';
import type { Listing, SearchFilters } from '@zameen/shared';
import { handleUserMessage } from '../chat.js';
import { getFacets } from '../facets.js';
import { createSession, searchListings } from '../vectara.js';
import { CASES, type EvalCase } from './cases.js';
import { evaluateTurn, type Observed } from './check.js';
import { formatReport, parseArgs, type CaseReport, type TurnReport } from './report.js';

async function runCase(c: EvalCase, knownAreas: readonly string[]): Promise<CaseReport> {
  const sessionKey = await createSession(`eval-${c.name}-${Date.now()}`);
  const turns: TurnReport[] = [];

  for (const turn of c.turns) {
    const observed: Observed = { userMessage: turn.user, searches: [], listings: [], narration: '', errors: [] };

    // The loop calls searchListings for the real search *and* for the
    // relaxation probes after an empty one. Only a real search is followed
    // by a `listings` event, so the filters in hand when that event arrives
    // are the ones that search used; probe calls overwrite `pending` and
    // are never promoted.
    let pending: SearchFilters | null = null;

    await handleUserMessage(
      sessionKey,
      turn.user,
      (event) => {
        if (event.type === 'token') observed.narration += event.text;
        else if (event.type === 'listings') {
          observed.listings.push(...(event.listings as Listing[]));
          if (pending) observed.searches.push(pending);
        } else if (event.type === 'error') observed.errors.push(event.message);
      },
      () => false,
      {
        searchListings: (filters, query, limit) => {
          pending = filters;
          return searchListings(filters, query, limit);
        },
      },
    );

    turns.push({ user: turn.user, observed, verdict: evaluateTurn(turn.expect, observed, knownAreas) });
  }

  return { name: c.name, why: c.why, passed: turns.every((t) => t.verdict.failures.length === 0), turns };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.cases.length > 0 ? CASES.filter((c) => options.cases.includes(c.name)) : CASES;
  if (selected.length === 0) {
    throw new Error(`No such case. Known: ${CASES.map((c) => c.name).join(', ')}`);
  }

  // Area names come from the live corpus, the same source the sidebar uses,
  // so a mention of an area the pipeline added yesterday still counts.
  const knownAreas = (await getFacets()).areas.map((a) => a.name);

  const reports: CaseReport[] = [];
  for (const c of selected) {
    process.stdout.write(`running ${c.name}…\n`);
    reports.push(await runCase(c, knownAreas));
  }

  console.log(`\n${formatReport(reports)}`);
  if (options.json) {
    await writeFile(options.json, `${JSON.stringify(reports, null, 2)}\n`);
    console.log(`full report written to ${options.json}`);
  }
  process.exitCode = reports.every((r) => r.passed) ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 2;
});
```

- [ ] **Step 7: Add the scripts**

In `apps/server/package.json`, add to `scripts`: `"eval": "tsx src/eval/run.ts"`.
In the root `package.json`, add to `scripts` after `"connect:calendar"`: `"eval": "npm run -w @zameen/server eval --"`.

- [ ] **Step 8: Typecheck, full suite, a dry parse**

Run: `npm run typecheck` — exit 0.
Run: `VECTARA_API_KEY=test-key npm test` — all pass.
Run: `VECTARA_API_KEY=test-key npm run eval -- --bogus` — expected: prints `unknown argument: --bogus` and exits 2 without contacting Vectara (the argument parse fails before any network call). Confirm with `echo $?` → `2`.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/eval/cases.ts apps/server/src/eval/report.ts apps/server/src/eval/report.test.ts apps/server/src/eval/run.ts apps/server/package.json package.json
git commit -m "Add the scripted conversation eval runner and its ten cases" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the section**

Add this section immediately before `## Limits and recovery`:

```markdown
## Evaluating the agent

`npm run eval` replays ten scripted conversations against the live agent and grades each turn: did it search when it should (and only then), did every search carry the filters the message implied, did the intake ask the right question, and is every price and area in its reply actually in the listings it was shown. It runs the real chat loop in-process, so it grades exactly what the server does.

```bash
npm run eval                          # all cases, ~5 minutes, one session each
npm run eval -- --case compare        # one case; repeat --case for several
npm run eval -- --json eval.json      # keep the full transcript and verdicts
```

A non-zero exit means at least one case failed; the report names the turn, the failure, the filters actually used and the start of the reply. Cases live in `apps/server/src/eval/cases.ts`; each states *why* it exists, and its expected filters are a minimum, so the agent adding a filter the user implied is a warning rather than a failure. Run it before and after any change to the prompt, the lambda, or the model.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the agent eval" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Run it live

Run by the controller; it spends model turns on the shared Vectara account.

- [ ] **Step 1: Run every case with a JSON report**

```bash
npm run eval -- --json /tmp/eval-baseline.json
```

Record the summary line and each failing turn's report.

- [ ] **Step 2: Triage every failure**

For each failing case decide, and record in the ledger, which of these it is:
- **The agent is wrong** (a real regression or a prompt weakness): keep the case as it is; report it to the user as a finding. Do not weaken the case to make it pass.
- **The case is wrong** (an expectation the prompt never promised, an area name that is not in the facets, a regex that misses a legitimate phrasing): fix the case in `cases.ts`, commit as `Correct the <name> eval case`, and rerun that case with `--case`.
- **The checker is wrong** (a price or area false positive in `check.ts`): add the failing text as a unit test, fix `check.ts`, commit, and rerun the case.

- [ ] **Step 3: Rerun the full set once**

`npm run eval` must exit 0, or every remaining failure must be recorded as an agent finding for the user.

- [ ] **Step 4: Report**

The pass count, the wall-clock time, any agent findings, and any case or checker corrections made.
