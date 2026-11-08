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

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

import { decodePendingFile, encodePendingFile, type PendingReview } from '../core/review.js'
import { ensureEndpointDir, pendingFile } from './endpoint.js'

/** Read v1 markers or v2 results; absent/unreadable files produce an empty set. */
export const loadPending = (): readonly PendingReview[] => {
  try {
    return decodePendingFile(JSON.parse(readFileSync(pendingFile(), 'utf8')))
  } catch {
    return []
  }
}

/**
 * Atomically replace the result set, including an empty set after removals.
 *
 * A unique sibling file avoids races with another writer. The previous file
 * survives failed writes/renames; callers advance their persistence key only
 * after this returns true so failures remain retryable.
 */
export const savePending = (pending: readonly PendingReview[]): boolean => {
  let temporary: string | null = null
  try {
    if (!ensureEndpointDir()) return false
    const destination = pendingFile()
    temporary = `${destination}.${randomUUID()}.tmp`
    writeFileSync(temporary, encodePendingFile(pending), { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, destination)
    temporary = null
    return true
  } catch {
    return false
  } finally {
    if (temporary !== null) {
      try { rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    }
  }
}

export { pendingFile }
