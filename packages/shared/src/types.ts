/** Canonical shape of one Zameen listing after normalization. */
export type Purpose = 'rent' | 'buy';

/** Coarse floor bucket parsed from listing free text. `null` when unstated. */
export type FloorBucket = 'ground' | 'lower' | 'upper' | 'top' | 'numbered';

export interface Listing {
  externalId: string;
  title: string;
  description: string;
  url: string;
  purpose: Purpose;
  propertyType: string;
  bedrooms: number;
  bathrooms: number;
  pricePkr: number;
  priceLabel: string;
  rentFrequency: string | null;
  areaSqft: number;
  areaSqyd: number;
  city: string;
  areaL3: string;
  areaL4: string;
  areaL5: string;
  areaPath: string;
  locationSlug: string;
  floor: FloorBucket | null;
  floorNum: number | null;
  floorRaw: string | null;
  lat: number | null;
  lng: number | null;
  isVerified: boolean;
  agency: string | null;
  photoCount: number;
  coverPhoto: string | null;
  listedAt: number;
}

/** Structured search request. Every field is optional except nothing — an
 *  empty object is a valid "everything" search. */
export interface SearchFilters {
  purpose?: Purpose;
  /** Free-text area name; matched against L3/L4/L5 case-insensitively. */
  area?: string;
  propertyType?: string;
  minBedrooms?: number;
  maxBedrooms?: number;
  minBathrooms?: number;
  minPrice?: number;
  maxPrice?: number;
  minAreaSqft?: number;
  maxAreaSqft?: number;
  floor?: FloorBucket;
  floorNum?: number;
  verifiedOnly?: boolean;
}

/** Facet data the UI needs to populate its filter controls. */
export interface Facets {
  areas: { name: string; level: number; count: number }[];
  propertyTypes: { name: string; count: number }[];
  purposes: { name: Purpose; count: number }[];
  bedrooms: { min: number; max: number };
  price: { rent: { min: number; max: number }; buy: { min: number; max: number } };
  floors: { name: string; count: number }[];
  total: number;
}
