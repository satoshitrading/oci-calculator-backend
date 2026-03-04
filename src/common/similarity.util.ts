/**
 * Text similarity for OCI SKU matching: pick the SKU whose name or part number
 * is most similar to the Source Service string.
 * Returns a score in [0, 1]; 0 = no match, 1 = identical.
 */

function normalize(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Token-set overlap: split on non-alphanumeric, then score by Jaccard-like overlap.
 * Handles empty strings and long names.
 */
function tokenSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const tokensA = new Set(na.split(/\W+/).filter((t) => t.length > 0));
  const tokensB = new Set(nb.split(/\W+/).filter((t) => t.length > 0));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Substring containment: if one string contains the other (after normalize), return high score.
 */
function containsScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return 0;
  if (na.includes(nb) || nb.includes(na)) {
    const minLen = Math.min(na.length, nb.length);
    const maxLen = Math.max(na.length, nb.length);
    return 0.5 + 0.5 * (minLen / maxLen);
  }
  return 0;
}

/**
 * Combined similarity between source text and a candidate (skuName + partNumber).
 * Returns the best score from token similarity and containment against skuName and partNumber.
 */
export function similarityToCandidate(
  sourceService: string,
  skuName: string,
  partNumber: string,
): number {
  const source = normalize(sourceService);
  if (source.length === 0) return 0;

  const scoreName = tokenSimilarity(sourceService, skuName);
  const scorePart = tokenSimilarity(sourceService, partNumber);
  const containName = containsScore(sourceService, skuName);
  const containPart = containsScore(sourceService, partNumber);

  return Math.max(scoreName, scorePart, containName, containPart);
}

/**
 * Minimum score to accept a similarity match; below this use fallback SKU.
 */
export const SIMILARITY_THRESHOLD = 0.05;
