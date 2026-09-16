import type { Listing } from '@zameen/shared';

/** A Vectara "core" document: pre-chunked parts plus document-level metadata. */
export interface CoreDocument {
  id: string;
  type: 'core';
  document_parts: { text: string; metadata?: Record<string, unknown> }[];
  metadata: Record<string, unknown>;
}

const FLOOR_PHRASE: Record<string, string> = {
  ground: 'on the ground floor',
  lower: 'on a lower floor / lower portion',
  upper: 'on an upper floor / upper portion',
  top: 'on the top floor',
};

function floorPhrase(listing: Listing): string {
  if (listing.floor === 'numbered' && listing.floorNum !== null) {
    return `on floor ${listing.floorNum}`;
  }
  if (listing.floor && FLOOR_PHRASE[listing.floor]) return FLOOR_PHRASE[listing.floor]!;
  return 'floor not stated';
}

function priceSentence(listing: Listing): string {
  const per = listing.purpose === 'rent' ? ' per month' : '';
  return `${listing.priceLabel}${per} (PKR ${listing.pricePkr.toLocaleString('en-US')})`;
}

/**
 * Render a listing as natural-language search text.
 *
 * Semantic search matches against this, so it spells out in words what the
 * metadata holds as numbers — "3 bedroom", "ground floor", the full area path.
 * A user asking "3 bed flat in DHA with a sea view" should hit this text even
 * when they set no structured filters at all.
 */
export function toSearchText(listing: Listing): string {
  const where = listing.areaPath || listing.city;
  const action = listing.purpose === 'rent' ? 'for rent' : 'for sale';

  return [
    `${listing.bedrooms} bedroom ${listing.propertyType} ${action} in ${where}, ${listing.city}.`,
    listing.title,
    listing.description,
    `${listing.areaSqft.toLocaleString('en-US')} sq ft (${listing.areaSqyd} sq yards), ` +
      `${listing.bedrooms} bedrooms, ${listing.bathrooms} bathrooms, ${floorPhrase(listing)}.`,
    `Price: ${priceSentence(listing)}.`,
    listing.isVerified ? 'This listing is verified by Zameen.' : '',
    listing.agency ? `Listed by ${listing.agency}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the indexable document for one listing.
 *
 * Every field the agent is allowed to filter on is mirrored into metadata, with
 * `*_norm` lowercase twins so a case mismatch from the model can never cause a
 * silent zero-result search.
 */
export function toDocument(listing: Listing): CoreDocument {
  return {
    id: `${listing.purpose}-${listing.externalId}`,
    type: 'core',
    document_parts: [{ text: toSearchText(listing) }],
    metadata: {
      external_id: listing.externalId,
      title: listing.title,
      url: listing.url,
      purpose: listing.purpose,
      property_type: listing.propertyType,
      property_type_norm: listing.propertyType.toLowerCase(),
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      price_pkr: listing.pricePkr,
      price_label: listing.priceLabel,
      area_sqft: listing.areaSqft,
      area_sqyd: listing.areaSqyd,
      city: listing.city,
      area_l3: listing.areaL3,
      area_l3_norm: listing.areaL3.toLowerCase(),
      area_l4: listing.areaL4,
      area_l4_norm: listing.areaL4.toLowerCase(),
      area_l5: listing.areaL5,
      area_l5_norm: listing.areaL5.toLowerCase(),
      area_path: listing.areaPath,
      // Vectara filter attributes cannot be null, so "unknown" is its own value
      // and floor_num uses -1 as the sentinel for "not stated".
      floor: listing.floor ?? 'unknown',
      floor_num: listing.floorNum ?? -1,
      is_verified: listing.isVerified,
      listed_at: listing.listedAt,
      lat: listing.lat ?? 0,
      lng: listing.lng ?? 0,
      cover_photo: listing.coverPhoto ?? '',
      agency: listing.agency ?? '',
      photo_count: listing.photoCount,
      source_url: listing.sourceUrl || listing.url,
      first_seen_at: listing.firstSeenAt,
      last_seen_at: listing.lastSeenAt,
    },
  };
}

/** The corpus schema. `indexed: true` is what makes an attribute filterable. */
export const FILTER_ATTRIBUTES = [
  { name: 'purpose', type: 'text', description: "Either 'rent' or 'buy'." },
  { name: 'property_type', type: 'text', description: 'Houses, Flats, Upper Portions, ...' },
  { name: 'property_type_norm', type: 'text', description: 'Lowercase property_type.' },
  { name: 'bedrooms', type: 'integer', description: 'Number of bedrooms.' },
  { name: 'bathrooms', type: 'integer', description: 'Number of bathrooms.' },
  { name: 'price_pkr', type: 'integer', description: 'Price in PKR; monthly for rent.' },
  { name: 'area_sqft', type: 'integer', description: 'Covered area in square feet.' },
  { name: 'area_sqyd', type: 'integer', description: 'Covered area in square yards.' },
  { name: 'city', type: 'text', description: 'Always Karachi in this corpus.' },
  { name: 'area_l3', type: 'text', description: 'District, e.g. "DHA Defence".' },
  { name: 'area_l3_norm', type: 'text', description: 'Lowercase area_l3.' },
  { name: 'area_l4', type: 'text', description: 'Phase/sub-area, e.g. "DHA Phase 8".' },
  { name: 'area_l4_norm', type: 'text', description: 'Lowercase area_l4.' },
  { name: 'area_l5', type: 'text', description: 'Project/society, e.g. "Emaar Crescent Bay".' },
  { name: 'area_l5_norm', type: 'text', description: 'Lowercase area_l5.' },
  { name: 'floor', type: 'text', description: "ground|lower|upper|top|numbered|unknown." },
  { name: 'floor_num', type: 'integer', description: 'Floor number; 0 ground, -1 unknown.' },
  { name: 'is_verified', type: 'boolean', description: 'Verified by Zameen.' },
  { name: 'listed_at', type: 'integer', description: 'Unix timestamp of listing creation.' },
  { name: 'source_url', type: 'text', description: 'URL the listing was ingested from.' },
  { name: 'first_seen_at', type: 'integer', description: 'Unix seconds first ingested.' },
  { name: 'last_seen_at', type: 'integer', description: 'Unix seconds last seen published.' },
] as const;
