import type { Facets, SearchFilters } from '@zameen/shared';

/**
 * Translate the metadata filter the agent wrote back into sidebar state.
 *
 * This reads the expression the agent actually sent rather than inferring from
 * its prose, so if the two ever disagree the panel shows what was really
 * searched. Anything it cannot parse is simply left unset — a partially
 * populated panel is better than a wrong one.
 */
export function filtersFromExpression(expression: string): SearchFilters {
  const filters: SearchFilters = {};
  if (!expression) return filters;

  const purpose = expression.match(/doc\.purpose\s*=\s*'(rent|buy)'/);
  if (purpose?.[1]) filters.purpose = purpose[1] as SearchFilters['purpose'];

  // Each requested area repeats across its three levels, so dedupe the
  // matches; more than one distinct name means several areas were searched
  // together.
  const areaMatches = [...expression.matchAll(/doc\.area_l[345]_norm\s*=\s*'([^']+)'/g)];
  const areaNames = [...new Set(areaMatches.map((m) => m[1]).filter((v): v is string => v !== undefined))];
  if (areaNames.length === 1) filters.area = areaNames[0];
  else if (areaNames.length > 1) filters.areas = areaNames;

  const type = expression.match(/doc\.property_type_norm\s*=\s*'([^']+)'/);
  if (type?.[1]) filters.propertyType = type[1];

  const minBeds = expression.match(/doc\.bedrooms\s*>=?\s*(\d+)/);
  if (minBeds?.[1]) filters.minBedrooms = Number.parseInt(minBeds[1], 10);

  const maxBeds = expression.match(/doc\.bedrooms\s*<=?\s*(\d+)/);
  if (maxBeds?.[1]) filters.maxBedrooms = Number.parseInt(maxBeds[1], 10);

  const maxPrice = expression.match(/doc\.price_pkr\s*<=?\s*(\d+)/);
  if (maxPrice?.[1]) filters.maxPrice = Number.parseInt(maxPrice[1], 10);

  const minPrice = expression.match(/doc\.price_pkr\s*>=?\s*(\d+)/);
  if (minPrice?.[1]) filters.minPrice = Number.parseInt(minPrice[1], 10);

  const minBaths = expression.match(/doc\.bathrooms\s*>=?\s*(\d+)/);
  if (minBaths?.[1]) filters.minBathrooms = Number.parseInt(minBaths[1], 10);

  const floor = expression.match(/doc\.floor\s*=\s*'(ground|lower|upper|top|numbered)'/);
  if (floor?.[1]) filters.floor = floor[1] as SearchFilters['floor'];

  return filters;
}

/**
 * The agent writes area names lowercase; the sidebar's options use canonical
 * casing, so map back before rendering or the select shows no selection.
 */
export function canonicalArea(value: string, facets: Facets | null): string {
  const match = facets?.areas.find((a) => a.name.toLowerCase() === value.toLowerCase());
  return match?.name ?? value;
}
