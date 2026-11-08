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
import type { RegistryEvent } from './registry.js';
import type { SessionFacts, SessionId, TurnOutcome } from './types.js';
/** One retained root-session result, whether acknowledged or not. */
export type PendingReview = {
    readonly id: SessionId;
    /** Original result time; restoration never substitutes the current clock. */
    readonly at: number;
    /** Activity watermark at persistence time, so post-end activity is preserved. */
    readonly updatedAt?: number;
    readonly outcome: TurnOutcome;
    readonly error: string | null;
    readonly reviewed: boolean;
};
/**
 * Decode a result file. Missing, corrupt and future-versioned files are empty.
 *
 * Legacy v1 markers carry no evidence of success: they restore `other`, hence
 * the unknown phase. Invalid v2 outcomes are discarded rather than guessed.
 */
export declare const decodePendingFile: (raw: unknown) => readonly PendingReview[];
/** Encode all retained results as a newline-terminated version 2 file. */
export declare const encodePendingFile: (pending: readonly PendingReview[]) => string;
/**
 * Collect every settled root-session result currently retained in the roster.
 *
 * Running/pending work supersedes a previous result. Subagent output belongs
 * to its parent. Acknowledgement never removes an otherwise retained result.
 */
export declare const pendingOf: (byId: ReadonlyMap<SessionId, SessionFacts>) => readonly PendingReview[];
/**
 * Whether a persisted result can refine the current facts without rewinding
 * newer history. Shared by the event producer and reducer so delayed restore
 * events are checked again at application time.
 */
export declare const canRestoreResult: (facts: SessionFacts, at: number, updatedAt?: number) => boolean;
/** Restore existing inactive roots only, without inventing a new turn end. */
export declare const restoreEvents: (pending: readonly PendingReview[], byId: ReadonlyMap<SessionId, SessionFacts>) => readonly RegistryEvent[];
