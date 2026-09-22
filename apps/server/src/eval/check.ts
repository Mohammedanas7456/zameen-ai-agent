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
