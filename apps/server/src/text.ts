/**
 * Flatten a free-text field to a single safe line.
 *
 * Control characters are stripped rather than escaped because these values
 * are interpolated into text another party reads — a calendar event the
 * estate agent sees, or the results message the model reads. Without this a
 * newline could forge a convincing extra line in either.
 */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
