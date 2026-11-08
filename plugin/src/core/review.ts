/**
 * Retained root-session results: what a restart is allowed to remember.
 *
 * Outcomes persist independently of acknowledgement. The legacy names remain
 * for Host compatibility; "pending" now denotes the persisted result records,
 * rather than only results nobody has read. Everything here is pure; `host/`
 * owns the file and the decision to write it.
 *
 * @module core/review
 */

import type { RegistryEvent } from './registry.js'
import type { SessionFacts, SessionId, TurnOutcome } from './types.js'

/** One retained root-session result, whether acknowledged or not. */
export type PendingReview = {
  readonly id: SessionId
  /** Original result time; restoration never substitutes the current clock. */
  readonly at: number
  /** Activity watermark at persistence time, so post-end activity is preserved. */
  readonly updatedAt?: number
  readonly outcome: TurnOutcome
  readonly error: string | null
  readonly reviewed: boolean
}

/** Version 1 stored only unread markers; version 2 stores actual outcomes. */
const FILE_VERSION = 2

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOutcome = (value: unknown): value is TurnOutcome =>
  value === 'completed' || value === 'error' || value === 'aborted' || value === 'other'

/**
 * Decode a result file. Missing, corrupt and future-versioned files are empty.
 *
 * Legacy v1 markers carry no evidence of success: they restore `other`, hence
 * the unknown phase. Invalid v2 outcomes are discarded rather than guessed.
 */
export const decodePendingFile = (raw: unknown): readonly PendingReview[] => {
  if (!isRecord(raw) || (raw['version'] !== 1 && raw['version'] !== FILE_VERSION)) return []
  const pending = raw['pending']
  if (!Array.isArray(pending)) return []
  return pending.flatMap((item): PendingReview[] => {
    if (!isRecord(item)) return []
    const id = item['id']
    if (typeof id !== 'string' || id === '') return []
    const valueAt = item['at']
    const at = typeof valueAt === 'number' && Number.isFinite(valueAt) && valueAt >= 0
      ? valueAt : 0
    if (raw['version'] === 1) {
      return [{ id, at, outcome: 'other', error: null, reviewed: false }]
    }
    const outcome = item['outcome']
    if (!isOutcome(outcome)) return []
    const error = item['error']
    const updatedAt = item['updatedAt']
    return [{
      id,
      at,
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0
        ? updatedAt : at,
      outcome,
      error: typeof error === 'string' ? error : null,
      reviewed: typeof item['reviewed'] === 'boolean' ? item['reviewed'] : true,
    }]
  })
}

/** Encode all retained results as a newline-terminated version 2 file. */
export const encodePendingFile = (pending: readonly PendingReview[]): string =>
  `${JSON.stringify({ version: FILE_VERSION, pending }, null, 2)}\n`

/**
 * Collect every settled root-session result currently retained in the roster.
 *
 * Running/pending work supersedes a previous result. Subagent output belongs
 * to its parent. Acknowledgement never removes an otherwise retained result.
 */
export const pendingOf = (
  byId: ReadonlyMap<SessionId, SessionFacts>,
): readonly PendingReview[] => {
  const pending: PendingReview[] = []
  for (const facts of byId.values()) {
    if (facts.isSubagent || facts.running || facts.pending !== null || facts.lastOutcome === null) continue
    pending.push({
      id: facts.id,
      at: facts.settledAt ?? 0,
      updatedAt: facts.updatedAt,
      outcome: facts.lastOutcome,
      error: facts.lastError,
      reviewed: facts.reviewed,
    })
  }
  return pending.toSorted((left, right) =>
    left.at !== right.at ? right.at - left.at : left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )
}

/**
 * Whether a persisted result can refine the current facts without rewinding
 * newer history. Shared by the event producer and reducer so delayed restore
 * events are checked again at application time.
 */
export const canRestoreResult = (
  facts: SessionFacts,
  at: number,
  updatedAt: number = at,
): boolean =>
  Number.isFinite(at) && at >= 0 && Number.isFinite(updatedAt) && updatedAt >= 0 &&
  !facts.isSubagent && !facts.running && facts.pending === null &&
  facts.updatedAt <= updatedAt &&
  (facts.turnStartedAt ?? 0) <= at &&
  (facts.settledAt === null || facts.settledAt < at)

/** Restore existing inactive roots only, without inventing a new turn end. */
export const restoreEvents = (
  pending: readonly PendingReview[],
  byId: ReadonlyMap<SessionId, SessionFacts>,
): readonly RegistryEvent[] =>
  pending.flatMap((entry) => {
    const facts = byId.get(entry.id)
    if (facts === undefined || !canRestoreResult(facts, entry.at, entry.updatedAt ?? entry.at)) return []
    return [{
      kind: 'restore-result',
      id: entry.id,
      at: entry.at,
      updatedAt: entry.updatedAt ?? entry.at,
      outcome: entry.outcome,
      error: entry.error,
      reviewed: entry.reviewed,
    }]
  })
