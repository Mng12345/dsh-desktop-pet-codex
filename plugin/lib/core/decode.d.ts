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
import type { ClientState, FocusRequest, PendingInteraction, PresencePatch, SessionId, SessionSummary, StreamFrame, TurnOutcome, WatchRequest, WorkspaceRef } from './types.js';
/** Read a nested record, or `undefined` when the field is not a record. */
export declare const field: (source: unknown, key: string) => Record<string, unknown> | undefined;
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
export declare const decodeTitle: (raw: unknown) => string | null;
/**
 * Decode one `SessionSummary` from a Host list row.
 *
 * @param raw - a value from `sessionController.list()` or an `api-session/*` event.
 * @returns the summary, or `null` when the payload carries no usable session id.
 */
export declare const decodeSummary: (raw: unknown) => SessionSummary | null;
/**
 * Decode the `{ items }` envelope of a `sessionController.list()` result.
 *
 * @param raw - the resolved `SessionListValue`.
 * @returns every row that decoded; an unusable envelope yields an empty list.
 */
export declare const decodeSummaryList: (raw: unknown) => readonly SessionSummary[];
/** The session-log facts the pet folds out of `session/event`. */
export type SessionEventFact = {
    readonly kind: 'approval-asked';
    readonly pending: PendingInteraction;
} | {
    readonly kind: 'approval-decided';
} | {
    readonly kind: 'tool-started';
    readonly tool: string;
    readonly callId: string | null;
    /** What this call blocks on, when it is one the human has to answer. */
    readonly blocks: PendingInteraction | null;
}
/** A tool call came back; a wait that was matched to it is over. */
 | {
    readonly kind: 'tool-finished';
    readonly callId: string | null;
} | {
    readonly kind: 'turn-ended';
    readonly at: number;
    readonly outcome: TurnOutcome;
}
/** A turn began — which is what "a conversation was started" means. */
 | {
    readonly kind: 'turn-started';
    readonly at?: number;
}
/** The conversation was (re)named, by a provider or by hand. */
 | {
    readonly kind: 'title';
    readonly title: string;
};
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
export declare const decodeSessionEvent: (raw: unknown) => SessionEventFact | null;
/**
 * Decode a presence patch from the DSH page.
 *
 * One field, and it has to be a boolean: the page has exactly two buttons, so a
 * body that names neither of them is a bad request rather than a silent no-op.
 *
 * @param raw - the decoded JSON body.
 * @returns the patch, or `null` when it is unusable.
 */
export declare const decodePresencePatch: (raw: unknown) => PresencePatch | null;
/**
 * Collapse a `TurnEndReason` into the pet's outcome vocabulary.
 *
 * @param raw - the `reason` member of a `turn/end` payload.
 * @returns the outcome; anything unrecognized reads as `other`.
 */
export declare const decodeTurnOutcome: (raw: unknown) => TurnOutcome;
/**
 * Read the session id a `session/event` payload belongs to.
 *
 * @param session - the first listener argument (a Scoped Session).
 * @param fallback - the payload's own id, used when the session object is absent.
 * @returns the id, or `null` when neither source carries one.
 */
export declare const decodeSessionId: (session: unknown, fallback?: unknown) => SessionId | null;
/**
 * Decode a focus request from the pet window.
 *
 * @param raw - the parsed body of `PUT /focus`.
 * @param now - the timestamp to stamp it with when the caller sent none.
 * @returns the request, or `null` when it names no session.
 */
export declare const decodeFocusRequest: (raw: unknown, now: number) => FocusRequest | null;
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
export declare const decodeRegistryWorkspaces: (raw: unknown) => readonly WorkspaceRef[];
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
export declare const decodeClientState: (raw: unknown, now: number) => ClientState | null;
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
export declare const decodeWatchRequest: (raw: unknown) => WatchRequest | null;
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
export declare const decodeStreamFrame: (raw: unknown) => StreamFrame | null;
