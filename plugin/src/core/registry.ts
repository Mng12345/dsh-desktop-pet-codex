/**
 * The roster reducer: one pure fold from events to the current session set.
 *
 * `reduceRegistry` is a total function of `(state, event)`. It never mutates
 * its arguments and returns the *same* state reference when an event changes
 * nothing, so a caller can drive publication off reference inequality alone.
 * That is the property the Host half relies on to avoid re-broadcasting, and it
 * is also what keeps a high-frequency event source cheap: a streamed fragment
 * that is dropped as out-of-order costs one comparison.
 *
 * @module core/registry
 */

import type {
  PendingInteraction,
  Registry,
  SessionFacts,
  SessionId,
  SessionSummary,
  StreamCursor,
  StreamFrame,
  ThoughtKind,
  TurnOutcome,
} from './types.js'
import { IDLE_CURSOR } from './types.js'
import { canRestoreResult } from './review.js'

/**
 * How much trailing thinking text one session keeps.
 *
 * The window shows a single line of it; anything longer is carried over the
 * bridge and through the reducer for nothing. Four hundred characters is
 * comfortably more than a line can display and still small enough that a full
 * roster costs a few kilobytes.
 */
export const THOUGHT_LIMIT = 400

/** Keep the tail of a growing string. */
const tail = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(text.length - limit)

/** Everything that can move the roster. Produced by the Host half's adapters. */
export type RegistryEvent =
  /** A full baseline: rows not present are dropped. */
  | { readonly kind: 'snapshot'; readonly summaries: readonly SessionSummary[] }
  /** One row appeared or changed at the list level. */
  | { readonly kind: 'upsert'; readonly summary: SessionSummary }
  | { readonly kind: 'remove'; readonly id: SessionId }
  | { readonly kind: 'running'; readonly id: SessionId; readonly running: boolean; readonly at?: number }
  | { readonly kind: 'activity'; readonly id: SessionId; readonly updatedAt: number }
  | { readonly kind: 'error'; readonly id: SessionId; readonly message: string; readonly at?: number }
  | { readonly kind: 'pending'; readonly id: SessionId; readonly pending: PendingInteraction | null }
  | {
      readonly kind: 'tool'
      readonly id: SessionId
      readonly tool: string
      /** The call's id, for matching the result that ends a wait. */
      readonly callId: string | null
      /** What the call blocks on, or `null` for a tool that just does work. */
      readonly blocks: PendingInteraction | null
    }
  /** A tool call returned, ending any wait that was matched to it. */
  | { readonly kind: 'tool-finished'; readonly id: SessionId; readonly callId: string | null }
  | { readonly kind: 'settled'; readonly id: SessionId; readonly at: number; readonly outcome: TurnOutcome }
  /** The conversation was (re)named. */
  | { readonly kind: 'title'; readonly id: SessionId; readonly title: string }
  /** A finished turn's result has been looked at. */
  | { readonly kind: 'reviewed'; readonly id: SessionId }
  /** Legacy acknowledgement marker: does not imply a successful outcome. */
  | { readonly kind: 'unreviewed'; readonly id: SessionId; readonly at: number }
  /** Restore the original result, without emitting a new turn end or time. */
  | {
      readonly kind: 'restore-result'
      readonly id: SessionId
      readonly outcome: TurnOutcome
      readonly error: string | null
      readonly at: number
      /** Activity watermark when the result was persisted; defaults to `at`. */
      readonly updatedAt?: number
      readonly reviewed?: boolean
    }
  /** One live assistant-stream frame. */
  | { readonly kind: 'stream'; readonly id: SessionId; readonly frame: StreamFrame }

/** The roster before any event: no sessions, revision zero. */
export const emptyRegistry: Registry = { byId: new Map(), revision: 0 }

/** A session we have only heard about second-hand, with every fact unknown. */
const stubFacts = (id: SessionId): SessionFacts => ({
  id,
  cwd: null,
  parentId: null,
  isSubagent: false,
  updatedAt: 0,
  running: false,
  turnStartedAt: null,
  blank: false,
  title: null,
  pending: null,
  blockedCallId: null,
  lastTool: null,
  lastOutcome: null,
  settledAt: null,
  lastError: null,
  // Nothing has finished, so there is nothing unread.
  reviewed: true,
  stream: IDLE_CURSOR,
  thought: '',
  thoughtKind: null,
  thoughtAt: 0,
})

/**
 * Fold a list row onto the facts only the stream knows about.
 *
 * The Host list is authoritative for existence, directory, lineage, and
 * running state; it knows nothing about approvals, tools, or live text, so
 * those carry over from the previous value. A false-to-true running transition
 * starts a new turn and clears the previous outcome, error, time, tool and text.
 * Repeated running baselines preserve errors learned within the current turn.
 *
 * Two fields are deliberately *not* taken from the row when it is silent:
 *
 * - `title`, because the list's projection block is absent whenever no
 *   projection source served the row. A title already learned from the
 *   `session/title` event must not flicker back to a directory name because one
 *   baseline happened to miss the cache.
 * - `thought`, because a turn that has just finished still has a last sentence,
 *   and a row whose result nobody has read is exactly where it belongs. Whether
 *   to *show* it is the derive layer's call, not the reducer's.
 */
const factsFromSummary = (
  summary: SessionSummary,
  previous: SessionFacts | undefined,
): SessionFacts => {
  const started = summary.running && previous?.running !== true
  return {
    id: summary.sessionId,
    cwd: summary.cwd,
    parentId: summary.parentSessionId,
    isSubagent: summary.isSubagent,
    updatedAt: Math.max(summary.updatedAt, previous?.updatedAt ?? 0),
    running: summary.running,
    turnStartedAt: started ? summary.updatedAt : previous?.turnStartedAt ?? null,
    blank: summary.blank,
    title: summary.title ?? previous?.title ?? null,
    pending: started ? null : previous?.pending ?? null,
    blockedCallId: started ? null : previous?.blockedCallId ?? null,
    lastTool: started || !summary.running ? null : previous?.lastTool ?? null,
    lastOutcome: started ? null : previous?.lastOutcome ?? null,
    settledAt: started ? null : previous?.settledAt ?? null,
    lastError: started ? null : previous?.lastError ?? null,
    reviewed: started ? true : previous?.reviewed ?? true,
    stream: summary.running && !started ? previous?.stream ?? IDLE_CURSOR : IDLE_CURSOR,
    thought: started ? '' : previous?.thought ?? '',
    thoughtKind: started ? null : previous?.thoughtKind ?? null,
    thoughtAt: started ? 0 : previous?.thoughtAt ?? 0,
  }
}

const sameCursor = (left: StreamCursor, right: StreamCursor): boolean =>
  left.attemptId === right.attemptId &&
  left.revision === right.revision &&
  left.nextIndex === right.nextIndex

/** Field-wise equality; the guard that keeps unchanged state reference-stable. */
const sameFacts = (left: SessionFacts, right: SessionFacts): boolean =>
  left.id === right.id &&
  left.cwd === right.cwd &&
  left.parentId === right.parentId &&
  left.isSubagent === right.isSubagent &&
  left.updatedAt === right.updatedAt &&
  left.running === right.running &&
  left.turnStartedAt === right.turnStartedAt &&
  left.blank === right.blank &&
  left.title === right.title &&
  left.pending === right.pending &&
  left.blockedCallId === right.blockedCallId &&
  left.lastTool === right.lastTool &&
  left.lastOutcome === right.lastOutcome &&
  left.settledAt === right.settledAt &&
  left.lastError === right.lastError &&
  left.reviewed === right.reviewed &&
  sameCursor(left.stream, right.stream) &&
  left.thought === right.thought &&
  left.thoughtKind === right.thoughtKind &&
  left.thoughtAt === right.thoughtAt

/** Two rosters hold identical rows. */
const sameRegistry = (
  left: ReadonlyMap<SessionId, SessionFacts>,
  right: ReadonlyMap<SessionId, SessionFacts>,
): boolean => {
  if (left.size !== right.size) return false
  for (const [id, facts] of right) {
    const previous = left.get(id)
    if (previous === undefined || !sameFacts(previous, facts)) return false
  }
  return true
}

/** Replace one row, preserving the state reference when the row is unchanged. */
const put = (state: Registry, id: SessionId, next: SessionFacts): Registry => {
  const previous = state.byId.get(id)
  if (previous !== undefined && sameFacts(previous, next)) return state
  const byId = new Map(state.byId)
  byId.set(id, next)
  return { byId, revision: state.revision + 1 }
}

/**
 * Refine a row we already know about.
 *
 * Interaction and stream facts are refinements, not existence proofs: an
 * approval, tool, or stream frame for an unknown id is ignored rather than
 * inventing a session, because the list-level events are the only authority on
 * what exists.
 */
const amend = (
  state: Registry,
  id: SessionId,
  update: (facts: SessionFacts) => SessionFacts,
): Registry => {
  const previous = state.byId.get(id)
  return previous === undefined ? state : put(state, id, update(previous))
}

/** Upsert from a list-level fact; unknown ids are created as stubs. */
const upsert = (state: Registry, summary: SessionSummary): Registry =>
  put(
    state,
    summary.sessionId,
    factsFromSummary(summary, state.byId.get(summary.sessionId)),
  )

/** Create-or-refine from a list-level fact that carries no full row. */
const touch = (
  state: Registry,
  id: SessionId,
  update: (facts: SessionFacts) => SessionFacts,
): Registry => put(state, id, update(state.byId.get(id) ?? stubFacts(id)))

/**
 * Place one stream frame against a session's cursor.
 *
 * The sequence is dense per attempt, and frames are process-local: losing one
 * is an ordinary event, not a fault. Rather than guess at a gap, the attempt is
 * abandoned — the text simply stops growing until the next `start` re-seats the
 * cursor, which is better than splicing out-of-order fragments into a sentence
 * someone is reading.
 *
 * Each attempt is one step of a turn, and each step starts its own thought, so
 * the line always answers "what is it thinking *now*".
 */
const applyFrame = (facts: SessionFacts, frame: StreamFrame): SessionFacts => {
  switch (frame.kind) {
    case 'start':
      // A new attempt is a new thought. Steps within a turn each open one, so
      // keeping the previous step's text would glue unrelated sentences
      // together — the line is a live indicator, not a transcript.
      return {
        ...facts,
        stream: { attemptId: frame.attemptId, revision: frame.revision, nextIndex: 0 },
        thought: '',
        thoughtKind: null,
        thoughtAt: 0,
      }
    case 'end':
      return facts.stream.attemptId === frame.attemptId
        ? { ...facts, stream: IDLE_CURSOR }
        : facts
    case 'chunk': {
      const cursor = facts.stream
      if (cursor.attemptId !== frame.attemptId || frame.index !== cursor.nextIndex) {
        return sameCursor(cursor, IDLE_CURSOR) ? facts : { ...facts, stream: IDLE_CURSOR }
      }
      const stream: StreamCursor = { ...cursor, nextIndex: cursor.nextIndex + 1 }
      if (frame.text === null) return { ...facts, stream }
      const kind: ThoughtKind = frame.textKind
      return {
        ...facts,
        stream,
        thought: tail(facts.thought + frame.text, THOUGHT_LIMIT),
        thoughtKind: kind,
        thoughtAt: frame.at,
      }
    }
  }
}

/** Rebuild the roster from a baseline, keeping facts the baseline cannot carry. */
const reduceSnapshot = (
  state: Registry,
  summaries: readonly SessionSummary[],
): Registry => {
  const byId = new Map<SessionId, SessionFacts>()
  for (const summary of summaries) {
    byId.set(
      summary.sessionId,
      factsFromSummary(summary, state.byId.get(summary.sessionId)),
    )
  }
  return sameRegistry(state.byId, byId)
    ? state
    : { byId, revision: state.revision + 1 }
}

/**
 * Advance the roster by one event.
 *
 * @param state - the roster before the event.
 * @param event - the event to fold in.
 * @returns the roster after it — the same reference when nothing changed.
 */
export const reduceRegistry = (state: Registry, event: RegistryEvent): Registry => {
  switch (event.kind) {
    case 'snapshot':
      return reduceSnapshot(state, event.summaries)
    case 'upsert':
      return upsert(state, event.summary)
    case 'remove': {
      if (!state.byId.has(event.id)) return state
      const byId = new Map(state.byId)
      byId.delete(event.id)
      return { byId, revision: state.revision + 1 }
    }
    case 'running':
      return touch(state, event.id, (facts) => {
        // Untimed status heartbeats carry no evidence of a new turn. An actual
        // turn/start supplies `at`, so it can reset even while already running.
        if (event.running && facts.running && event.at === undefined) return facts
        return {
          ...facts,
          running: event.running,
          turnStartedAt: event.running ? event.at ?? facts.updatedAt : facts.turnStartedAt ?? null,
          pending: event.running ? null : facts.pending,
          blockedCallId: event.running ? null : facts.blockedCallId,
          lastOutcome: event.running ? null : facts.lastOutcome,
          settledAt: event.running ? null : facts.settledAt,
          lastError: event.running ? null : facts.lastError,
          lastTool: null,
          reviewed: event.running ? true : facts.reviewed,
          stream: IDLE_CURSOR,
          thought: event.running ? '' : facts.thought,
          thoughtKind: event.running ? null : facts.thoughtKind,
          thoughtAt: event.running ? 0 : facts.thoughtAt,
        }
      })
    case 'activity':
      return touch(state, event.id, (facts) => ({
        ...facts,
        updatedAt: Math.max(facts.updatedAt, event.updatedAt),
      }))
    case 'error':
      return touch(state, event.id, (facts) => {
        if (event.at !== undefined &&
            (event.at < (facts.turnStartedAt ?? 0) ||
             (facts.settledAt !== null && event.at < facts.settledAt))) return facts
        return {
          ...facts,
          lastOutcome: 'error',
          // Hosts should supply `at`; the pure core otherwise uses known history.
          settledAt: event.at ?? facts.settledAt ?? facts.updatedAt,
          lastError: event.message,
          lastTool: facts.running || facts.pending !== null ? facts.lastTool : null,
          reviewed: facts.isSubagent,
        }
      })
    case 'pending':
      return amend(state, event.id, (facts) => ({
        ...facts,
        pending: event.pending,
      }))
    case 'tool':
      return amend(state, event.id, (facts) => ({
        ...facts,
        lastTool: event.tool,
        // A blocking call is what "waiting for the human" looks like here: no
        // event announces a question or a plan review, so the call that has not
        // returned yet is the whole of the evidence.
        pending: event.blocks ?? facts.pending,
        blockedCallId: event.blocks === null ? facts.blockedCallId : event.callId,
      }))
    case 'tool-finished':
      return amend(state, event.id, (facts) => {
        if (facts.blockedCallId === null) return facts
        // Match on the id when both sides name one. A result that lost its id
        // still ends the wait: a call that came back cannot be blocking.
        if (event.callId !== null && facts.blockedCallId !== event.callId) return facts
        return { ...facts, pending: null, blockedCallId: null }
      })
    case 'title':
      return amend(state, event.id, (facts) => ({ ...facts, title: event.title }))
    case 'reviewed':
      // Idempotent by construction: an already-reviewed row is left untouched,
      // so a page that re-reports its selection on every visibility change does
      // not churn the roster revision.
      return amend(state, event.id, (facts) =>
        facts.reviewed ? facts : { ...facts, reviewed: true },
      )
    case 'unreviewed':
      return amend(state, event.id, (facts) =>
        facts.reviewed
          ? { ...facts, reviewed: false, settledAt: facts.settledAt ?? event.at }
          : facts,
      )
    case 'restore-result':
      return amend(state, event.id, (facts) =>
        canRestoreResult(facts, event.at, event.updatedAt ?? event.at)
          ? {
              ...facts,
              lastOutcome: event.outcome,
              settledAt: event.at,
              lastError: event.error,
              blank: false,
              lastTool: null,
              reviewed: event.reviewed ?? true,
            }
          : facts,
      )
    case 'settled':
      return amend(state, event.id, (facts) => {
        // A delayed end must not settle a newer turn or rewind a newer result.
        if (event.at < (facts.turnStartedAt ?? 0) ||
            (facts.settledAt !== null && event.at < facts.settledAt)) return facts
        return {
          ...facts,
          running: false,
          pending: null,
          blockedCallId: null,
          blank: false,
          lastTool: null,
          stream: IDLE_CURSOR,
          lastOutcome: event.outcome,
          settledAt: event.at,
          lastError: event.outcome === 'completed' ? null : facts.lastError,
          // Children belong to their parent; root results can be acknowledged
          // independently of how they ended and never derive their phase here.
          reviewed: facts.settledAt === event.at && facts.lastOutcome === event.outcome
            ? facts.reviewed : facts.isSubagent,
        }
      })
    case 'stream':
      return amend(state, event.id, (facts) => applyFrame(facts, event.frame))
  }
}
