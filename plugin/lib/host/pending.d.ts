/**
 * Persistence for retained root-session results, independently of review.
 *
 * `core/review.ts` owns the shape and reconciliation rules. This module owns
 * only the file, retaining the existing Host import names. Reads and writes
 * are best-effort; a same-directory rename prevents a partial write from
 * destroying the previous result file.
 *
 * @module host/pending
 */
import { type PendingReview } from '../core/review.js';
import { pendingFile } from './endpoint.js';
/** Read v1 markers or v2 results; absent/unreadable files produce an empty set. */
export declare const loadPending: () => readonly PendingReview[];
/**
 * Atomically replace the result set, including an empty set after removals.
 *
 * A unique sibling file avoids races with another writer. The previous file
 * survives failed writes/renames; callers advance their persistence key only
 * after this returns true so failures remain retryable.
 */
export declare const savePending: (pending: readonly PendingReview[]) => boolean;
export { pendingFile };
