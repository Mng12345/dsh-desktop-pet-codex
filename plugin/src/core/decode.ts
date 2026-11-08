/**
 * Total decoders: unknown Harness payloads in, domain values out.
 *
 * The Harness hands us `unknown` at every event boundary, and a pet must never
 * take the Host down because a payload grew a field. Each decoder therefore
 * returns a value or `null` — never throws, never mutates its input, and never
 * assumes a field is present. Fields we do not model are dropped, not stored.
 *
 * @module core/decode
 */

import type {
  ClientState,
  FocusRequest,
  PendingInteraction,
  PresencePatch,
  SessionId,
  SessionSummary,
  StreamFrame,
  ThoughtKind,
  TurnOutcome,
  WatchRequest,
  WorkspaceRef,
} from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const readBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

const readTimestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Read a nested record, or `undefined` when the field is not a record. */
export const field = (
  source: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return isRecord(value) ? value : undefined
}

/**
 * Read a conversation title out of a summary's projection hints.
 *
 * The title is not a field of `SessionSummary` on the wire. It is one key of
 * the generic `projections.values` block — the same channel the DSH client
 * reads its own list rows from — and the block is absent whenever no projection
 * source served the row. Every layer of that path is optional, so this reads
 * defensively and answers `null` rather than throwing: a row without a title
 * simply displays its directory, which is what it did before titles existed.
 *
 * @param raw - a value from `sessionController.list()` or an `api-session/*` event.
 * @returns the title, or `null` when the payload carries none.
 */
export const decodeTitle = (raw: unknown): string | null => {
  const values = field(field(raw, 'projections'), 'values')
  return values === undefined ? null : readString(values['title'])
}

/**
 * Decode one `SessionSummary` from a Host list row.
 *
 * @param raw - a value from `sessionController.list()` or an `api-session/*` event.
 * @returns the summary, or `null` when the payload carries no usable session id.
 */
export const decodeSummary = (raw: unknown): SessionSummary | null => {
  if (!isRecord(raw)) return null
  const sessionId = readString(raw['sessionId'])
  if (sessionId === null) return null
  return {
    sessionId,
    updatedAt: readTimestamp(raw['updatedAt']) ?? 0,
    running: readBoolean(raw['running']) ?? false,
    agentAvailable: readBoolean(raw['agentAvailable']) ?? false,
    blank: readBoolean(raw['blank']) ?? false,
    cwd: readString(raw['cwd']),
    parentSessionId: readString(raw['parentSessionId']),
    isSubagent: readString(raw['origin']) === 'subagent',
    title: decodeTitle(raw),
  }
}

/**
 * Decode the `{ items }` envelope of a `sessionController.list()` result.
 *
 * @param raw - the resolved `SessionListValue`.
 * @returns every row that decoded; an unusable envelope yields an empty list.
 */
export const decodeSummaryList = (raw: unknown): readonly SessionSummary[] => {
  if (!isRecord(raw)) return []
  const items = raw['items']
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    const summary = decodeSummary(item)
    return summary === null ? [] : [summary]
  })
}

/** The session-log facts the pet folds out of `session/event`. */
export type SessionEventFact =
  | { readonly kind: 'approval-asked'; readonly pending: PendingInteraction }
  | { readonly kind: 'approval-decided' }
  | {
      readonly kind: 'tool-started'
      readonly tool: string
      readonly callId: string | null
      /** What this call blocks on, when it is one the human has to answer. */
      readonly blocks: PendingInteraction | null
    }
  /** A tool call came back; a wait that was matched to it is over. */
  | { readonly kind: 'tool-finished'; readonly callId: string | null }
  | { readonly kind: 'turn-ended'; readonly at: number; readonly outcome: TurnOutcome }
  /** A turn began — which is what "a conversation was started" means. */
  | { readonly kind: 'turn-started'; readonly at?: number }
  /** The conversation was (re)named, by a provider or by hand. */
  | { readonly kind: 'title'; readonly title: string }

const PENDING_KINDS: Readonly<Record<string, PendingInteraction>> = {
  approval: 'approval',
  'plan-review': 'plan-review',
  plan: 'plan-review',
  question: 'question',
}

/**
 * The tools that block on the human, and what each one is waiting for.
 *
 * Neither of these appends a session event when it asks: the ask-user tool calls
 * `userQuestions.ask()` and returns only once the reader answers, and a plan
 * review goes through the same seam. So "the call has not come back yet" *is*
 * the signal — the only one this DSH offers a Host plugin — and the names are
 * the contract rather than a guess.
 */
const BLOCKING_TOOLS: Readonly<Record<string, PendingInteraction>> = {
  ask_user_question: 'question',
  exit_plan_mode: 'plan-review',
}

/**
 * Classify one committed Session event into a fact the pet cares about.
 *
 * Only a handful of event types matter to a status indicator; everything else —
 * model requests, streamed deltas, message surfaces — is deliberately ignored
 * so the pet never rescans a log it does not need.
 *
 * `session/title` is here for latency, not for correctness: the title also
 * arrives inside the list projection, but that projection is only re-read on a
 * baseline (up to `resyncMs` later), while this event fires the moment the
 * title settles. A title that appears a minute after the turn ended reads as a
 * bug even though nothing is broken.
 *
 * @param raw - the `event` member of a `session/event` payload.
 * @returns the classified fact, or `null` for an event the pet ignores.
 */
export const decodeSessionEvent = (raw: unknown): SessionEventFact | null => {
  if (!isRecord(raw)) return null
  const type = readString(raw['type'])
  const data = field(raw, 'data')
  switch (type) {
    case 'approval/asked': {
      const discriminator = readString(data?.['kind']) ?? readString(data?.['type'])
      const pending = discriminator === null ? 'approval' : PENDING_KINDS[discriminator] ?? 'approval'
      return { kind: 'approval-asked', pending }
    }
    case 'approval/decided':
      return { kind: 'approval-decided' }
    case 'tool/call': {
      const tool = readString(data?.['name'])
      if (tool === null) return null
      return {
        kind: 'tool-started',
        tool,
        callId: readString(data?.['callId']),
        blocks: BLOCKING_TOOLS[tool] ?? null,
      }
    }
    case 'tool/result': {
      // The id rides in the tool message; older shapes put it on the source.
      const message = field(data, 'message')
      const callId = readString(message?.['toolCallId']) ??
        readString(field(message, 'source')?.['callId'])
      return { kind: 'tool-finished', callId }
    }
    case 'command/run':
      return { kind: 'tool-started', tool: 'command', callId: null, blocks: null }
    case 'session/title': {
      const title = readString(data?.['title'])
      return title === null ? null : { kind: 'title', title }
    }
    case 'turn/start':
      // The watched set's entry condition, and the reason it is this event
      // rather than `session/created`: DSH keeps blank "New Session"
      // placeholders around, and a placeholder is not a conversation anyone
      // started. A turn beginning is.
      return { kind: 'turn-started', ...(readTimestamp(raw['time']) === null ? {} : { at: readTimestamp(raw['time'])! }) }
    case 'turn/end': {
      const at = readTimestamp(raw['time']) ?? 0
      return { kind: 'turn-ended', at, outcome: decodeTurnOutcome(data?.['reason']) }
    }
    default:
      return null
  }
}

/**
 * Decode a presence patch from the DSH page.
 *
 * One field, and it has to be a boolean: the page has exactly two buttons, so a
 * body that names neither of them is a bad request rather than a silent no-op.
 *
 * @param raw - the decoded JSON body.
 * @returns the patch, or `null` when it is unusable.
 */
export const decodePresencePatch = (raw: unknown): PresencePatch | null => {
  const visible = isRecord(raw) ? readBoolean(raw['visible']) : null
  return visible === null ? null : { visible }
}

/**
 * Collapse a `TurnEndReason` into the pet's outcome vocabulary.
 *
 * @param raw - the `reason` member of a `turn/end` payload.
 * @returns the outcome; anything unrecognized reads as `other`.
 */
export const decodeTurnOutcome = (raw: unknown): TurnOutcome => {
  const kind = readString(isRecord(raw) ? raw['kind'] : undefined)
  switch (kind) {
    case 'completed':
      return 'completed'
    case 'error':
      return 'error'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    default:
      return 'other'
  }
}

/**
 * Read the session id a `session/event` payload belongs to.
 *
 * @param session - the first listener argument (a Scoped Session).
 * @param fallback - the payload's own id, used when the session object is absent.
 * @returns the id, or `null` when neither source carries one.
 */
export const decodeSessionId = (session: unknown, fallback?: unknown): SessionId | null =>
  readString(isRecord(session) ? session['id'] : undefined) ?? readString(fallback)

/**
 * Decode a focus request from the pet window.
 *
 * @param raw - the parsed body of `PUT /focus`.
 * @param now - the timestamp to stamp it with when the caller sent none.
 * @returns the request, or `null` when it names no session.
 */
export const decodeFocusRequest = (raw: unknown, now: number): FocusRequest | null => {
  if (!isRecord(raw)) return null
  const sessionId = readString(raw['sessionId'])
  if (sessionId === null) return null
  return { sessionId, at: readTimestamp(raw['at']) ?? now }
}

/**
 * Decode the Host's own Workspace table.
 *
 * Read from `ctx.workspaceRegistry.list()`, whose entries are entities with an
 * `id` field and `path` / `title` / `sessionIds` getters. A Workspace without an
 * id, or without a path, is dropped rather than repaired: grouping is a display
 * fact, and inventing a group from a malformed row would put a session somewhere
 * it is not. Its sessions then fall back to their directory, which is visible
 * and harmless.
 *
 * @param raw - the resolved `workspaceRegistry.list()` value.
 * @returns every workspace that decoded; an unusable value yields an empty table.
 */
export const decodeRegistryWorkspaces = (raw: unknown): readonly WorkspaceRef[] => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = readString(item['id'])
    const path = readString(item['path'])
    if (id === null || path === null) return []
    const sessionIds = Array.isArray(item['sessionIds'])
      ? item['sessionIds'].flatMap((entry) => {
          const sessionId = readString(entry)
          return sessionId === null ? [] : [sessionId]
        })
      : []
    return [{ id, path, title: readString(item['title']) ?? '', sessionIds }]
  })
}

/**
 * Decode one report from the DSH page.
 *
 * Three fields, each independently optional, because the page may have news
 * about any one of them without the others. What it must not do is guess: an
 * absent `workspaces` stays `null` rather than becoming an empty table, since
 * "no news" and "no Workspaces" mean opposite things to the grouping. And
 * `visible` defaults to `false` on anything unusable, because treating an
 * unreadable report as "the reader saw it" would clear a badge nobody looked
 * at — the one mistake this channel exists to avoid.
 *
 * A body carrying none of the three is not a report at all, and is rejected
 * rather than silently read as "nothing is visible".
 *
 * @param raw - the parsed body of a client-state write.
 * @param now - the timestamp to stamp it with when the caller sent none.
 * @returns the state, or `null` when the body is not a report.
 */
export const decodeClientState = (raw: unknown, now: number): ClientState | null => {
  if (!isRecord(raw)) return null
  const hasSession = Object.hasOwn(raw, 'sessionId')
  const hasVisible = Object.hasOwn(raw, 'visible')
  if (!hasSession && !hasVisible) return null
  return {
    sessionId: readString(raw['sessionId']),
    visible: readBoolean(raw['visible']) ?? false,
    at: readTimestamp(raw['at']) ?? now,
    ...(Object.hasOwn(raw, 'enteredAt') ? { enteredAt: readTimestamp(raw['enteredAt']) } : {}),
    ...(Object.hasOwn(raw, 'focusAt') ? { focusAt: readTimestamp(raw['focusAt']) } : {}),
    ...(Object.hasOwn(raw, 'clientId') ? { clientId: readString(raw['clientId']) } : {}),
    ...(Object.hasOwn(raw, 'sequence') ? { sequence: readTimestamp(raw['sequence']) } : {}),
  }
}

/**
 * Decode the watched set the pet window sends.
 *
 * Total and lossy in the safe direction: anything that is not a non-empty
 * string is dropped rather than repaired, because an id invented here would put
 * a row in the roster that no session backs. An empty list is a legitimate
 * answer — it is what a first run sends, and what the Host seeds from.
 *
 * @param raw - the parsed body of `PUT /watch`.
 * @returns the ids, or `null` when the body is not a watched set.
 */
export const decodeWatchRequest = (raw: unknown): WatchRequest | null => {
  if (!isRecord(raw)) return null
  const ids = raw['ids']
  if (!Array.isArray(ids)) return null
  return {
    ids: ids.flatMap((entry) => {
      const id = readString(entry)
      return id === null ? [] : [id]
    }),
  }
}

/** Which stream-chunk types carry text, and which part of the answer they are. */
const TEXT_CHUNKS: Readonly<Record<string, ThoughtKind>> = {
  'reasoning-delta': 'reasoning',
  'text-delta': 'text',
}

/**
 * Classify one live assistant-stream frame.
 *
 * The stream is dense and process-local, so the frame carries its own ordering:
 * an attempt id, and a chunk index. Only text-bearing chunks are worth keeping;
 * block boundaries, usage counters, and finish markers are dropped here rather
 * than carried into the roster.
 *
 * @param raw - the `frame` member of an `agent/assistant-stream` payload.
 * @returns the frame, or `null` for one the pet does not fold.
 */
export const decodeStreamFrame = (raw: unknown): StreamFrame | null => {
  if (!isRecord(raw)) return null
  const attemptId = readString(raw['attemptId'])
  switch (readString(raw['type'])) {
    case 'start': {
      if (attemptId === null) return null
      const revision = readTimestamp(raw['revision'])
      return { kind: 'start', attemptId, revision: revision ?? 0 }
    }
    case 'end':
      return attemptId === null ? null : { kind: 'end', attemptId }
    case 'chunk': {
      if (attemptId === null) return null
      const index = readTimestamp(raw['index'])
      if (index === null) return null
      const chunk = field(raw, 'chunk')
      const chunkType = readString(chunk?.['type'])
      const textKind: ThoughtKind | null =
        chunkType === null ? null : TEXT_CHUNKS[chunkType] ?? null
      return {
        kind: 'chunk',
        attemptId,
        index,
        at: readTimestamp(raw['time']) ?? 0,
        text: textKind === null ? null : readString(chunk?.['text']),
        textKind: textKind ?? 'text',
      }
    }
    default:
      return null
  }
}
