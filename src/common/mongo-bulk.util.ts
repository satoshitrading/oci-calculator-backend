/**
 * Utilities for MongoDB bulk operations: retry on connection errors and batched inserts
 * to avoid MongoBulkWriteError (e.g. read ECONNRESET) during long-running writes.
 */

/** Default batch size for insertMany to reduce connection timeout risk. */
export const BULK_INSERT_BATCH_SIZE = 500;

function isRetryableMongoError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const name = (e as { name?: string })?.name;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    name === 'MongoNetworkError' ||
    name === 'MongoBulkWriteError'
  );
}

/**
 * Runs a MongoDB operation with retries on connection-related errors.
 * Uses exponential backoff (1s, 2s, 4s, capped at 5s).
 */
export async function withMongoRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts && isRetryableMongoError(e)) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
