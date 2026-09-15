import type { Listing } from '@zameen/shared';

/** Render PKR the way Pakistani listings read: lakh and crore. */
export function formatPkr(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return 'Price on request';
  const trim = (v: number) => Number.parseFloat(v.toFixed(2)).toLocaleString('en-US');
  if (amount >= 1e7) return `PKR ${trim(amount / 1e7)} Crore`;
  if (amount >= 1e5) return `PKR ${trim(amount / 1e5)} Lakh`;
  return `PKR ${amount.toLocaleString('en-US')}`;
}

export function priceWithPeriod(listing: Listing): string {
  return listing.purpose === 'rent'
    ? `${formatPkr(listing.pricePkr)}/mo`
    : formatPkr(listing.pricePkr);
}

const FLOOR_LABEL: Record<string, string> = {
  ground: 'Ground floor',
  lower: 'Lower portion',
  upper: 'Upper portion',
  top: 'Top floor',
};

export function floorLabel(listing: Listing): string | null {
  if (listing.floor === 'numbered' && listing.floorNum !== null) {
    return listing.floorNum === 0 ? 'Ground floor' : `Floor ${listing.floorNum}`;
  }
  return listing.floor ? (FLOOR_LABEL[listing.floor] ?? null) : null;
}

export const compactArea = (sqft: number): string =>
  sqft > 0 ? `${sqft.toLocaleString('en-US')} sq ft` : '—';

/** Zameen slugs are long; the title is a better label but can run away. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
