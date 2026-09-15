import type { FloorBucket } from './types.js';

export interface ParsedFloor {
  floor: FloorBucket | null;
  floorNum: number | null;
  /** The matched snippet, kept so the UI can show why we inferred a floor. */
  floorRaw: string | null;
}

const NONE: ParsedFloor = { floor: null, floorNum: null, floorRaw: null };

const WORD_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12,
};

/** Karachi's tallest towers are ~60 floors; anything beyond is a parse error. */
const MAX_PLAUSIBLE_FLOOR = 60;

/**
 * Infer a floor from listing free text.
 *
 * Zameen exposes no structured floor field, so this reads the title and
 * description. Only a minority of listings state a floor at all — callers must
 * treat `null` as "unknown", never as "ground".
 *
 * An explicit ordinal always wins over a vague bucket word, because
 * "Upper portion, 2nd floor" is more precisely a 2nd floor than an "upper".
 */
export function parseFloor(text: string): ParsedFloor {
  if (!text) return NONE;
  const haystack = text.toLowerCase();

  // 1. Numeric ordinal: "1st floor", "12th Floor"
  const ordinal = haystack.match(/\b(\d{1,3})\s*(?:st|nd|rd|th)?\s+floor\b/);
  if (ordinal?.[1]) {
    const n = Number.parseInt(ordinal[1], 10);
    if (n >= 0 && n <= MAX_PLAUSIBLE_FLOOR) {
      return { floor: 'numbered', floorNum: n, floorRaw: ordinal[0].trim() };
    }
    // An implausible number means we misread the text — claim nothing.
    return NONE;
  }

  // 2. Reversed word order: "floor 7"
  const reversed = haystack.match(/\bfloor\s+(\d{1,3})\b/);
  if (reversed?.[1]) {
    const n = Number.parseInt(reversed[1], 10);
    if (n >= 0 && n <= MAX_PLAUSIBLE_FLOOR) {
      return { floor: 'numbered', floorNum: n, floorRaw: reversed[0].trim() };
    }
    return NONE;
  }

  // 3. Spelled-out ordinal: "second floor"
  const word = haystack.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+floor\b/,
  );
  if (word?.[1]) {
    const n = WORD_ORDINALS[word[1]];
    if (n !== undefined) return { floor: 'numbered', floorNum: n, floorRaw: word[0].trim() };
  }

  // 4. Buckets. `\bfloor\b` avoids matching "flooring".
  const ground = haystack.match(/\bground\s+floor\b/);
  if (ground) return { floor: 'ground', floorNum: 0, floorRaw: ground[0].trim() };

  const top = haystack.match(/\b(?:top\s+floor|penthouse)\b/);
  if (top) return { floor: 'top', floorNum: null, floorRaw: top[0].trim() };

  const upper = haystack.match(/\b(?:higher\s+floor|upper\s+(?:floor|portion)|upper\s+storey)\b/);
  if (upper) return { floor: 'upper', floorNum: null, floorRaw: upper[0].trim() };

  const lower = haystack.match(/\b(?:lower\s+(?:floor|portion)|lower\s+storey)\b/);
  if (lower) return { floor: 'lower', floorNum: null, floorRaw: lower[0].trim() };

  return NONE;
}

/**
 * Some Zameen property *types* are themselves floor statements: an
 * "Upper Portion" is by definition an upper storey. Used as a fallback when
 * the listing text says nothing, this lifts floor coverage appreciably.
 */
export function floorFromPropertyType(propertyType: string): ParsedFloor {
  const t = (propertyType || '').toLowerCase();
  if (t.includes('upper portion')) return { floor: 'upper', floorNum: null, floorRaw: propertyType };
  if (t.includes('lower portion')) return { floor: 'lower', floorNum: null, floorRaw: propertyType };
  if (t.includes('penthouse')) return { floor: 'top', floorNum: null, floorRaw: propertyType };
  return NONE;
}
