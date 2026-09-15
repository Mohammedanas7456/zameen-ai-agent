import type { SearchFilters } from './types.js';

/**
 * Escape a value for use inside a single-quoted Vectara filter literal.
 *
 * Filter strings are assembled by us but the *values* can come from an LLM or
 * from user input, so they are untrusted. Escaping the quote (and stripping
 * backslashes that could escape our escape) keeps a crafted value inside its
 * literal instead of becoming filter syntax.
 */
function quote(value: string): string {
  const escaped = value.replace(/\\/g, '').replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Non-finite numbers would serialize as `NaN`/`Infinity` and break the filter. */
function intOrNull(value: number | undefined, { min = 0 }: { min?: number } = {}): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n < min ? null : n;
}

function cleanText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Translate structured filters into a Vectara metadata filter expression.
 *
 * Clause order is fixed so the output is deterministic and easy to assert on.
 * Returns `''` when nothing is constrained — callers should omit the filter
 * entirely in that case rather than sending an empty string.
 */
export function buildMetadataFilter(filters: SearchFilters): string {
  const clauses: string[] = [];

  if (filters.purpose === 'rent' || filters.purpose === 'buy') {
    clauses.push(`doc.purpose = ${quote(filters.purpose)}`);
  }

  // An area name can live at any of three levels of Zameen's hierarchy
  // (district / phase / project), so match it against all three.
  const area = cleanText(filters.area);
  if (area) {
    const needle = quote(area.toLowerCase());
    clauses.push(
      `(doc.area_l3_norm = ${needle} OR doc.area_l4_norm = ${needle} OR doc.area_l5_norm = ${needle})`,
    );
  }

  const propertyType = cleanText(filters.propertyType);
  if (propertyType) {
    clauses.push(`doc.property_type_norm = ${quote(propertyType.toLowerCase())}`);
  }

  const minBedrooms = intOrNull(filters.minBedrooms);
  if (minBedrooms !== null) clauses.push(`doc.bedrooms >= ${minBedrooms}`);

  const maxBedrooms = intOrNull(filters.maxBedrooms);
  if (maxBedrooms !== null) clauses.push(`doc.bedrooms <= ${maxBedrooms}`);

  const minBathrooms = intOrNull(filters.minBathrooms);
  if (minBathrooms !== null) clauses.push(`doc.bathrooms >= ${minBathrooms}`);

  const minPrice = intOrNull(filters.minPrice);
  if (minPrice !== null) clauses.push(`doc.price_pkr >= ${minPrice}`);

  const maxPrice = intOrNull(filters.maxPrice);
  if (maxPrice !== null) clauses.push(`doc.price_pkr <= ${maxPrice}`);

  const minAreaSqft = intOrNull(filters.minAreaSqft);
  if (minAreaSqft !== null) clauses.push(`doc.area_sqft >= ${minAreaSqft}`);

  const maxAreaSqft = intOrNull(filters.maxAreaSqft);
  if (maxAreaSqft !== null) clauses.push(`doc.area_sqft <= ${maxAreaSqft}`);

  if (filters.floor) clauses.push(`doc.floor = ${quote(filters.floor)}`);

  const floorNum = intOrNull(filters.floorNum);
  if (floorNum !== null) clauses.push(`doc.floor_num = ${floorNum}`);

  // `false` means "no preference", not "show me unverified listings".
  if (filters.verifiedOnly === true) clauses.push('doc.is_verified = true');

  return clauses.join(' AND ');
}
