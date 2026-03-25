import { createHash } from 'node:crypto';

/**
 * Compute a SHA-256 hash of JSON-serialized data.
 * Used to detect whether fetched data has actually changed
 * vs just having a new timestamp.
 */
export function contentHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
}
