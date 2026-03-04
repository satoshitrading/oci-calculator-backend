/**
 * Normalize product title or source service for OCI SKU mapping lookup.
 * Trim, lowercase, collapse whitespace to single space.
 */
export function normalizeProductTitle(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
