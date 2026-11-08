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
import type { PendingInteraction, Registry, SessionId, SessionSummary, StreamFrame, TurnOutcome } from './types.js';
/**
 * How much trailing thinking text one session keeps.
 *
 * The window shows a single line of it; anything longer is carried over the
 * bridge and through the reducer for nothing. Four hundred characters is
 * comfortably more than a line can display and still small enough that a full
 * roster costs a few kilobytes.
 */
export declare const THOUGHT_LIMIT = 400;
/** Everything that can move the roster. Produced by the Host half's adapters. */
export type RegistryEvent = 
/** A full baseline: rows not present are dropped. */
{
    readonly kind: 'snapshot';
    readonly summaries: readonly SessionSummary[];
}
/** One row appeared or changed at the list level. */
 | {
    readonly kind: 'upsert';
    readonly summary: SessionSummary;
} | {
    readonly kind: 'remove';
    readonly id: SessionId;
} | {
    readonly kind: 'running';
    readonly id: SessionId;
    readonly running: boolean;
    readonly at?: number;
} | {
    readonly kind: 'activity';
    readonly id: SessionId;
    readonly updatedAt: number;
} | {
    readonly kind: 'error';
    readonly id: SessionId;
    readonly message: string;
    readonly at?: number;
} | {
    readonly kind: 'pending';
    readonly id: SessionId;
    readonly pending: PendingInteraction | null;
} | {
    readonly kind: 'tool';
    readonly id: SessionId;
    readonly tool: string;
    /** The call's id, for matching the result that ends a wait. */
    readonly callId: string | null;
    /** What the call blocks on, or `null` for a tool that just does work. */
    readonly blocks: PendingInteraction | null;
}
/** A tool call returned, ending any wait that was matched to it. */
 | {
    readonly kind: 'tool-finished';
    readonly id: SessionId;
    readonly callId: string | null;
} | {
    readonly kind: 'settled';
    readonly id: SessionId;
    readonly at: number;
    readonly outcome: TurnOutcome;
}
/** The conversation was (re)named. */
 | {
    readonly kind: 'title';
    readonly id: SessionId;
    readonly title: string;
}
/** A finished turn's result has been looked at. */
 | {
    readonly kind: 'reviewed';
    readonly id: SessionId;
}
/** Legacy acknowledgement marker: does not imply a successful outcome. */
 | {
    readonly kind: 'unreviewed';
    readonly id: SessionId;
    readonly at: number;
}
/** Restore the original result, without emitting a new turn end or time. */
 | {
    readonly kind: 'restore-result';
    readonly id: SessionId;
    readonly outcome: TurnOutcome;
    readonly error: string | null;
    readonly at: number;
    /** Activity watermark when the result was persisted; defaults to `at`. */
    readonly updatedAt?: number;
    readonly reviewed?: boolean;
}
/** One live assistant-stream frame. */
 | {
    readonly kind: 'stream';
    readonly id: SessionId;
    readonly frame: StreamFrame;
};
/** The roster before any event: no sessions, revision zero. */
export declare const emptyRegistry: Registry;
/**
 * Advance the roster by one event.
 *
 * @param state - the roster before the event.
 * @param event - the event to fold in.
 * @returns the roster after it — the same reference when nothing changed.
 */
export declare const reduceRegistry: (state: Registry, event: RegistryEvent) => Registry;
