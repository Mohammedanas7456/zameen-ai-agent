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
  thousand: 1_000,
  thousands: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
  cr: 10_000_000,
};

const UNIT = '(?:lakhs?|lac|crores?|cr|k|thousands?)';

/**
 * A number is not a price when the next word says what it counts. A leading
 * hyphen is allowed because a unit-less range's second number is stripped
 * before this runs (see the classification note in `extractPrices`), leaving
 * `-1,600 sq ft` behind for a moment on the way there.
 */
const NOT_A_PRICE = /^-?(?:sq|sqft|sq\.|sqm|square|feet|ft|bed|beds|bedroom|bedrooms|bath|baths|bathroom|bathrooms|floor|floors|storey|storeys|story|stories|listing|listings|match|matches|option|options|result|results|property|properties|flat|flats|house|houses|marla|kanal|acres|yard|yards|unit|units|km|min|mins|minute|minutes|hour|hours|day|days|month|months|year|years|people|persons|residents|families|%|of|more|further|search|searches)\b/i;

/** A price stated as a gap ("40k less") is not a price anything is listed at. */
const DIFFERENCE = /\b(?:less|more|cheaper|dearer|higher|lower|apart|difference|extra|saving|savings|off)\b/i;

/**
 * A price the reply is filtering *by* ("everything under 2 lakh", "nothing
 * below 90,000") is a restatement of the constraint, not a claim that any
 * listing costs that — grading it as one fails correct replies. Matched
 * against the few words in front of the number, so only the threshold word
 * nearest it counts.
 */
const THRESHOLD = /\b(?:under|below|over|above|up to|less than|more than|at most|at least|within)$/i;

/**
 * Words that put a bare number in a price frame. "thousand" is an ordinary
 * English word, so a unit-less "3 thousand people" must not become a price;
 * but "at 95 thousand" is money as surely as "PKR 95 thousand" is, and the
 * agent writes it that way often enough that letting it through unchecked
 * would leave an invented price ungraded.
 */
const MONEY_PREPOSITION = /\b(?:at|for)\s*$/i;

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

    // Three words is enough to see a threshold phrase ("up to", "at least")
    // whole without reaching back into the previous clause.
    const before = normalised.slice(0, match.index ?? 0);
    const prevWords = before.trim().split(/\s+/).slice(-3).join(' ');
    if (THRESHOLD.test(prevWords)) continue;

    let value: number | null = null;
    if (unit) {
      const lowerUnit = unit.toLowerCase();
      const multiplier = UNIT_MULTIPLIER[lowerUnit] ?? 1;
      if (lowerUnit !== 'thousand' && lowerUnit !== 'thousands') {
        value = toNumber(raw) * multiplier;
      } else {
        // "thousand" is an ordinary English word ("3 thousand people"), not a
        // price marker like "lakh"/"crore"/"k", so it doesn't get a free pass
        // from the size-word veto: run it through the same classify-and-veto
        // (and, absent a currency, the same comma requirement) a bare number
        // would get, then apply the unit's multiplier if it survives.
        const classify = currency ? after : after.replace(/^-\s*\d[\d,]*(?:\.\d+)?\s*/, '');
        if (NOT_A_PRICE.test(classify)) continue;
        else if (currency) value = toNumber(raw) * multiplier;
        else if (raw.includes(',') && toNumber(raw) >= 1000) value = toNumber(raw) * multiplier;
        else if (MONEY_PREPOSITION.test(prevWords)) value = toNumber(raw) * multiplier;
      }
    } else {
      // A number with neither unit nor currency, sat in front of "- <number>",
      // is the low end of a range ("1,500-1,600 sq ft"): the word that says
      // what it counts sits after the *second* number, not this one, so drop
      // that number before asking NOT_A_PRICE what follows it.
      const classify = currency ? after : after.replace(/^-\s*\d[\d,]*(?:\.\d+)?\s*/, '');
      if (NOT_A_PRICE.test(classify)) continue;
      else if (currency) value = toNumber(raw);
      else if (raw.includes(',') && toNumber(raw) >= 1000) value = toNumber(raw);
    }

    // Rounded because a unit multiplier goes through floating point ("1.15
    // lakh" lands a fraction under 115,000), and a report line reading
    // "PKR 114,999.99999999999" would send the reader hunting a bug in the
    // agent that is really one in this arithmetic.
    if (value !== null && Number.isFinite(value)) {
      const rounded = Math.round(value);
      if (!found.includes(rounded)) found.push(rounded);
    }
  }
  return found;
}

/**
 * Lowercase and collapse every run of whitespace and hyphen-family dashes to
 * one space, so "Gulistan-e-Jauhar" and "Gulistan e Jauhar" — or a listing
 * path that spells the same area with an en dash — compare equal. The corpus
 * and the agent don't agree on which separator to use.
 */
function normaliseArea(s: string): string {
  return s.toLowerCase().replace(/[\s\-–—]+/g, ' ').trim();
}

/** A character that isn't a letter or digit — or off the end of the string — breaks a phrase match. */
function isWordBreak(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/.test(ch);
}

/**
 * Whether `needle` occurs in `hay` as a whole phrase, not merely as a
 * substring of a longer word ("Clifton" inside "Cliftonia" doesn't count).
 * Both arguments must already be normalised (see `normaliseArea`).
 */
function containsPhrase(hay: string, needle: string): boolean {
  let from = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const end = at + needle.length;
    if (isWordBreak(hay[at - 1]) && isWordBreak(hay[end])) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Known area names present in the text as whole phrases, longest first.
 * Separators are normalised on both sides before matching, and a name is
 * deduplicated by its normalised form — "Clifton - Block 9" and "Clifton
 * Block 9" are the same area under two spellings, so only the one found
 * first (the longer one, since it's tried first) is returned.
 *
 * The live facets include generic names like "Block 6" that also occur as
 * the tail of a longer name ("PECHS Block 6"). Once a name claims a span of
 * the text, a shorter name is not allowed to match anywhere that overlaps it
 * — it would just be re-reporting the same mention under a vaguer name — so
 * a candidate occurrence that overlaps an already-claimed range is skipped in
 * favour of another occurrence of that same name elsewhere in the text. A
 * shorter match doesn't have to sit fully inside the longer one to be the
 * same mention: "Nazimabad 3" starting inside "North Nazimabad" and running
 * past its end is still just that one mention read under a second name, not
 * a distinct area next to it.
 *
 * A name claims *every* one of its occurrences, not only the first: the agent
 * repeats an area name across a reply ("Two in PECHS Block 6; the PECHS Block
 * 6 one is verified"), and leaving the later ones unclaimed would let "Block
 * 6" match inside the second mention and report the same area twice.
 */
export function findAreaMentions(text: string, knownAreas: readonly string[]): string[] {
  const hay = normaliseArea(text);
  const found: string[] = [];
  const seen = new Set<string>();
  const claimed: Array<[number, number]> = [];
  for (const name of [...knownAreas].sort((a, b) => b.length - a.length)) {
    const needle = normaliseArea(name);
    if (seen.has(needle)) continue;
    let from = 0;
    while (from <= hay.length) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      const end = at + needle.length;
      // Overlap, not containment: a shorter match that only partly sits inside
      // a claimed span ("nazimabad 3" starting inside "north nazimabad" and
      // running past it) is still the same mention re-read under a vaguer
      // name, so it must be skipped too, not just the fully-contained case.
      const overlapsClaimedSpan = claimed.some(([start, stop]) => at < stop && end > start);
      if (!overlapsClaimedSpan && isWordBreak(hay[at - 1]) && isWordBreak(hay[end])) {
        if (!seen.has(needle)) {
          found.push(name);
          seen.add(needle);
        }
        claimed.push([at, end]);
        from = end;
      } else {
        from = at + 1;
      }
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
 * An offer of a next step, however it's phrased — its figures are options,
 * not claims. The verb after "I can"/"I could" is a closed list of the ones
 * the agent actually reaches for when proposing another search ("pull up",
 * "widen", "rerun"), not `\w+` — that was loose enough to also swallow "I can
 * see one at 3 lakh in DHA Phase 6", an ordinary claim that merely opens with
 * "I can". The conditional tails ("if you like", "let me know") mark an offer
 * on their own.
 */
const OFFER_VERB = '(?:check|search|look|pull|widen|rerun|re-run|try|show|run|narrow|filter)';
const OFFER = new RegExp(
  `\\b(?:want me to|shall i|should i|would you like|could (?:also )?(?:check|try|look)|happy to|i can (?:also )?${OFFER_VERB}|i could (?:also )?${OFFER_VERB}|if you(?:'d)? like|if you want|let me know)\\b`,
  'i',
);

/**
 * A clause boundary: a stop mark, a semicolon, or a spaced dash.
 *
 * The stop mark only ends a clause when whitespace or the end of the text
 * follows, so a decimal price like "1.4 lakh" is never mistaken for one. The
 * dash match is zero-width — it splits *before* the dash rather than eating
 * it — so a range written "1.25 – 1.6 lakh" survives being taken apart and
 * put back together with its dash still in place.
 */
const CLAUSE_BREAK = /(?<=[.!?;])(?=\s|$)|(?=\s[–—]\s)/;

/**
 * The claims in `text`, with every offer of a next step removed.
 *
 * The agent always ends a reply by proposing what to try next ("Want me to
 * also check nearby PECHS Block 6 …?") and that proposal's prices and areas
 * are options being floated, not statements about the listings shown — so
 * grounding must never see them. But it just as often tacks the offer onto
 * the end of a claim ("…a 3-bed in DHA Phase 6 at 95 thousand — want me to
 * pull it up?"), and dropping that whole sentence would take the invented
 * listing with it. So each clause is cut at its *earliest* offer marker and
 * only the text in front of it is kept; a clause that is purely a question,
 * with no marker at all, is an offer too and goes entirely.
 */
export function claimSentences(text: string): string {
  return text
    .split(CLAUSE_BREAK)
    .map((clause) => {
      const trimmed = clause.trim();
      const offer = OFFER.exec(trimmed);
      // The dash that introduced the offer is left behind by the cut; it
      // would otherwise glue two kept clauses into a range that isn't there.
      if (offer) return trimmed.slice(0, offer.index).replace(/[\s–—-]+$/, '');
      return trimmed.endsWith('?') ? '' : trimmed;
    })
    .filter((clause) => clause.length > 0)
    .join(' ');
}

/**
 * Every price and area the narration states must come from the listings the
 * agent was given, or from the user's own words. A price counts as grounded
 * when some listing is within `tolerance` of it, because the agent rounds.
 *
 * Known gap: an area named as advice rather than as a claim ("Bahria Town is
 * usually cheaper than Clifton") is still graded as ungrounded, because an
 * offer marker is the only advisory phrasing `claimSentences` knows. Widening
 * that to general advice needs the prompt to mark it, so it is left for a
 * later pass rather than guessed at here.
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
  const claims = claimSentences(narration);
  const listingPrices = listings.map((l) => l.pricePkr);
  const allowedPrices = extractPrices(allowedText);
  const ungroundedPrices = extractPrices(claims).filter(
    (p) => !near(listingPrices, p) && !near(allowedPrices, p),
  );

  const paths = listings.map((l) => normaliseArea(l.areaPath));
  // The model is shown each listing's title as well as its path, so a
  // sub-area named only in the title (not broken out in the path) still
  // counts as something the model could have read, not invented.
  const titles = listings.map((l) => normaliseArea(l.title));
  const allowedAreas = findAreaMentions(allowedText, knownAreas).map((a) => normaliseArea(a));
  // Whole-phrase, not a bare substring: a title's "Cliftonia Tower" must not
  // ground a claim about "Clifton" just because one word contains the other.
  const ungroundedAreas = findAreaMentions(claims, knownAreas).filter((name) => {
    const needle = normaliseArea(name);
    return (
      !paths.some((p) => containsPhrase(p, needle)) &&
      !titles.some((t) => containsPhrase(t, needle)) &&
      !allowedAreas.includes(needle)
    );
  });

  return { ungroundedPrices, ungroundedAreas };
}

export interface TurnExpectation {
  /** Filters each real search must include, in order. `[]` means the turn must not search. */
  searches?: SearchFilters[];
  /**
   * Treat `searches` as a floor rather than an exact count. A turn the prompt
   * invites to search again — a zero-result one, which is told to suggest a
   * relaxation — may legitimately run more; each extra is warned about so it
   * still shows up in the report.
   */
  allowExtraSearches?: boolean;
  /**
   * Filter keys no search in this turn may carry. What a case leaves out of
   * `searches` is only a minimum, so this is the one way to assert that the
   * agent did *not* invent a constraint the user never gave.
   */
  forbidden?: (keyof SearchFilters)[];
  /** The narration must match. */
  narration?: RegExp;
  /** Skip the grounding check — a zero-result turn quotes probe figures, not listings. */
  skipGrounding?: boolean;
}

export interface Observed {
  /** This turn's message, for the report. */
  userMessage: string;
  /**
   * Every user message in the case so far, newline-joined, including this
   * turn's. Grounding allows what the *conversation* supplied, not only what
   * the latest message did: a budget or an area named two turns ago is still
   * the user's own word, and failing the agent for repeating it back would be
   * grading it on the harness's forgetfulness.
   */
  allowedText: string;
  searches: SearchFilters[];
  /**
   * The listings the agent was *shown*, not every listing the search returned
   * — `listingsForAgent` renders only the first `LISTINGS_SHOWN_TO_AGENT` of
   * them. A price out of the ninth result is as invented, from where the
   * agent sits, as one out of thin air, so the runner slices before it fills
   * this in.
   */
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

  if (expect.forbidden) {
    observed.searches.forEach((actual, i) => {
      for (const key of expect.forbidden ?? []) {
        const value = actual[key];
        if (value !== undefined) failures.push(`search ${i + 1}: forbidden ${key}: ${String(value)}`);
      }
    });
  }

  if (expect.searches) {
    const enough = expect.allowExtraSearches
      ? observed.searches.length >= expect.searches.length
      : observed.searches.length === expect.searches.length;
    if (!enough) {
      const how = expect.allowExtraSearches ? 'at least ' : '';
      failures.push(`expected ${how}${expect.searches.length} search(es), got ${observed.searches.length}`);
    }
    // An allowed extra is still worth seeing: a second search the case didn't
    // ask for is how a relaxation loop starts running away.
    if (expect.allowExtraSearches) {
      for (let i = expect.searches.length; i < observed.searches.length; i++) {
        warnings.push(`search ${i + 1}: unexpected extra search`);
      }
    }
    expect.searches.forEach((wanted, i) => {
      const actual = observed.searches[i];
      if (!actual) return;
      const diff = compareFilters(wanted, actual);
      for (const m of diff.missing) failures.push(`search ${i + 1}: missing ${m}`);
      for (const m of diff.different) failures.push(`search ${i + 1}: ${m}`);
      for (const m of diff.extra) {
        // The prompt tells the agent never to substitute an area of its own;
        // an extra area is that rule broken, not a helpful addition, so it
        // fails the turn instead of just being noted.
        if (m.startsWith('area:')) failures.push(`search ${i + 1}: unexpected ${m}`);
        // A budget the user never gave is the same kind of invention: it
        // silently hides listings the user asked to see.
        else if (m.startsWith('minPrice:') || m.startsWith('maxPrice:')) {
          failures.push(`search ${i + 1}: unexpected budget: ${m}`);
        } else warnings.push(`search ${i + 1}: extra ${m}`);
      }
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
      allowedText: observed.allowedText,
    });
    for (const p of grounding.ungroundedPrices) failures.push(`price not in results: PKR ${p.toLocaleString('en-US')}`);
    for (const a of grounding.ungroundedAreas) failures.push(`area not in results: ${a}`);
  }

  return { failures, warnings };
}
