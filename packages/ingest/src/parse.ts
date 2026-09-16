import { parseFloor, floorFromPropertyType } from '@zameen/shared';
import type { Listing, Purpose } from '@zameen/shared';

const SQM_TO_SQFT = 10.7639;
const SQFT_TO_SQYD = 1 / 9;

/** One entry of Zameen's location hierarchy (Pakistan -> ... -> project). */
interface RawLocation {
  level?: number;
  name?: string;
  slug?: string;
}

/** The subset of a Zameen listing record we rely on. */
export interface RawHit {
  externalID?: string;
  title?: string;
  shortDescription?: string;
  slug?: string;
  purpose?: string;
  rooms?: number;
  baths?: number;
  price?: number;
  area?: number;
  rentFrequency?: string | null;
  isVerified?: boolean;
  photoCount?: number;
  createdAt?: number;
  geography?: { lat?: number; lng?: number };
  location?: RawLocation[];
  category?: { name?: string }[];
  agency?: { name?: string } | null;
  coverPhoto?: { id?: number; url?: string } | null;
}

/**
 * Pull the `window.state` object out of a Zameen listing page.
 *
 * The payload is a ~235 KB JSON literal that contains braces, escaped quotes
 * and `</script>`-like strings, so a regex is not safe here — we brace-match
 * while tracking string state instead. Returns `null` (never throws) when the
 * marker is absent or the JSON is unparseable, so a blocked or changed page
 * degrades into "zero listings" rather than a crash mid-scrape.
 */
export function extractWindowState(html: string): Record<string, unknown> | null {
  const marker = 'window.state = ';
  const at = html.indexOf(marker);
  if (at === -1) return null;

  const start = at + marker.length;
  if (html[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null; // unbalanced braces: truncated page
}

/** The listing records live at `algolia.content.hits`. */
export function hitsFromState(state: Record<string, unknown>): RawHit[] {
  const algolia = state['algolia'] as { content?: { hits?: unknown } } | undefined;
  const hits = algolia?.content?.hits;
  return Array.isArray(hits) ? (hits as RawHit[]) : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function levelName(locations: RawLocation[] | undefined, level: number): string {
  return locations?.find((l) => l.level === level)?.name ?? '';
}

/**
 * Format a PKR amount the way Pakistani listings read: lakh (10^5) and
 * crore (10^7), trimming a trailing `.0`.
 */
export function formatPkr(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return 'Price on request';
  const unit = (value: number, suffix: string) =>
    `PKR ${Number.parseFloat(value.toFixed(2))} ${suffix}`;
  if (amount >= 1e7) return unit(amount / 1e7, 'Crore');
  if (amount >= 1e5) return unit(amount / 1e5, 'Lakh');
  if (amount >= 1e3) return unit(amount / 1e3, 'Thousand');
  return `PKR ${amount}`;
}

/**
 * Build a public image URL for a listing.
 *
 * The `coverPhoto.url` in the payload points at a private S3 bucket that
 * returns 403, so the displayable image is derived from the photo id via
 * Zameen's public thumbnail CDN instead.
 */
export function coverPhotoUrl(hit: RawHit): string | null {
  const id = hit.coverPhoto?.id;
  return typeof id === 'number' && Number.isFinite(id)
    ? `https://media.zameen.com/thumbnails/${id}-400x300.jpeg`
    : null;
}

/**
 * Convert one raw Zameen hit into our canonical `Listing`.
 *
 * `seenAt` is the ingestion timestamp; it defaults to now so the backfill path
 * stamps lifecycle fields the same way the pipeline does.
 */
export function normalizeHit(hit: RawHit, purpose: Purpose, seenAt = Math.floor(Date.now() / 1000)): Listing {
  const title = hit.title ?? '';
  const description = hit.shortDescription ?? '';
  const areaSqm = num(hit.area);
  const areaSqft = Math.round(areaSqm * SQM_TO_SQFT);
  const pricePkr = num(hit.price);

  const propertyType = hit.category?.at(-1)?.name ?? 'Property';
  // Prefer an explicit statement in the text; fall back to what the property
  // type implies ("Upper Portions" is an upper storey by definition).
  const textFloor = parseFloor(`${title} ${description}`);
  const floor = textFloor.floor ? textFloor : floorFromPropertyType(propertyType);

  const areaL3 = levelName(hit.location, 3);
  const areaL4 = levelName(hit.location, 4);
  const areaL5 = levelName(hit.location, 5);

  return {
    externalId: String(hit.externalID ?? ''),
    title,
    description,
    url: hit.slug ? `https://www.zameen.com/Property/${hit.slug}.html` : 'https://www.zameen.com',
    purpose,
    propertyType,
    bedrooms: num(hit.rooms),
    bathrooms: num(hit.baths),
    pricePkr,
    priceLabel: formatPkr(pricePkr),
    rentFrequency: hit.rentFrequency ?? null,
    areaSqft,
    areaSqyd: Math.round(areaSqft * SQFT_TO_SQYD),
    city: levelName(hit.location, 2) || 'Karachi',
    areaL3,
    areaL4,
    areaL5,
    areaPath: [areaL3, areaL4, areaL5].filter(Boolean).join(' > '),
    locationSlug: hit.location?.at(-1)?.slug ?? '',
    floor: floor.floor,
    floorNum: floor.floorNum,
    floorRaw: floor.floorRaw,
    lat: typeof hit.geography?.lat === 'number' ? hit.geography.lat : null,
    lng: typeof hit.geography?.lng === 'number' ? hit.geography.lng : null,
    isVerified: hit.isVerified === true,
    agency: hit.agency?.name ?? null,
    photoCount: num(hit.photoCount),
    coverPhoto: coverPhotoUrl(hit),
    listedAt: num(hit.createdAt),
    sourceUrl: hit.slug ? `https://www.zameen.com/Property/${hit.slug}.html` : '',
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}
