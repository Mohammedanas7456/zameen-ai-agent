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
// Anchored on word boundaries: an unanchored /rent|buy/ also matches "current"
// and "buyer's market", so it would pass a turn that never asked the question.
const ASKS_RENT_OR_BUY = /\b(?:rent|renting|buy|buying|purchase)\b/i;

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
        expect: {
          searches: [{ purpose: 'rent', area: 'Clifton', propertyType: 'Flats', minBedrooms: 2 }],
          // "Sea facing" is a ranking phrase, not a constraint: a floor or a
          // budget invented out of it would quietly hide listings the user
          // asked to see.
          forbidden: ['floor', 'maxPrice', 'minPrice'],
        },
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
        // Anchored, so "another" and "notice" can't stand in for a refusal.
        expect: {
          searches: [],
          narration: /\b(?:not|don't|isn't|no listings|closest|instead|alternative|nearest)\b/i,
        },
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
          // Nothing matched, and the prompt invites a relaxation — running the
          // relaxed search itself is good behaviour, not a regression.
          allowExtraSearches: true,
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
