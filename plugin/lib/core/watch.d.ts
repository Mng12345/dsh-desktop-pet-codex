/**
 * The watched set: which conversations the pet is allowed to show.
 *
 * The roster used to be "every session DSH knows about", which on a real
 * install is ninety-odd rows of mostly-finished work — useless as an ambient
 * indicator. It is now a list the reader curates, and this module owns the
 * rules for what enters it and what leaves.
 *
 * Three rules, and nothing else:
 *
 * - **Seed.** An empty set is filled from what is happening right now, so a
 *   first run is not a blank window.
 * - **Enter.** A conversation that starts a turn joins, including one that was
 *   resumed after sitting idle. A *subagent* never joins: nobody starts a
 *   subagent, it is dispatched, and treating one as a conversation the reader
 *   chose is a category error that also buries the tree in child rows.
 * - **Leave.** A settled conversation leaves after a confirmed post-result visit
 *   or manual dismissal; archiving also removes an entry.
 *
 * There is no expiry. Starting a new turn is what re-adds a handled conversation.
 * Membership is persisted by the Host; the window mirrors its snapshots.
 *
 * Everything here is pure; the set itself is owned by `host/runtime.ts`.
 *
 * @module core/watch
 */
import type { SessionId, SessionSummary } from './types.js';
/**
 * Which sessions a first-run seed should take.
 *
 * "Happening right now" is the only thing a fresh baseline can actually prove:
 * it reports `running`, and it reports nothing about approvals or unread
 * results — those are runtime facts that arrive as events, and one that
 * happened before the pet launched is simply not knowable from the list.
 *
 * Subagents are excluded for the same reason they can never *enter* the set: a
 * seed is an entry, and nobody starts a subagent. Without this a fresh run would
 * open with somebody's dispatched child sitting at the top of the tree as if the
 * reader had chosen it.
 *
 * @param summaries - a decoded baseline.
 * @returns the ids worth seeding with, in baseline order.
 */
export declare const seedOf: (summaries: readonly SessionSummary[]) => readonly SessionId[];
/**
 * Whether a session may enter the watched set.
 *
 * Only a conversation, and only one that has actually begun: a blank session is
 * the "New Session" placeholder DSH keeps around before anything is typed, and
 * a subagent is a conversation's own machinery. DSH's sidebar draws both lines
 * in the same place (`if (session.blank && session.id !== current) return false`
 * and an `origin === 'subagent'` filter), so this is its rule rather than a new
 * one.
 *
 * @param summary - the session that started a turn.
 * @returns whether it should join the watched set.
 */
export declare const watchable: (summary: SessionSummary) => boolean;
/**
 * Whether a session's facts are worth keeping at all.
 *
 * A watched conversation, or a *subagent* hanging off one — because the tree
 * shows a watched parent's children, and a child's facts have to exist for that
 * to be possible. Everything else is dropped at the source rather than filtered
 * at render: the point of the watched set is that the ninety-odd rows nobody
 * asked for cost nothing, not that they cost nothing to *draw*.
 *
 * Lineage alone is not enough to tell those two apart. DSH also parents
 * conversations that are nobody's machinery — a side thread, a duplicated
 * placeholder — and keeping those drew rows the reader never chose, at root
 * level, which could not even be dismissed because they were never in the set.
 * `isSubagent` is the flag DSH itself uses for the machinery, so it is the one
 * that decides.
 *
 * @param id - the session in question.
 * @param parentId - its parent, when it has one.
 * @param isSubagent - whether DSH reports it as a subagent.
 * @param watch - the watched set.
 * @returns whether to keep its facts.
 */
export declare const retained: (id: SessionId, parentId: SessionId | null, isSubagent: boolean, watch: ReadonlySet<SessionId>) => boolean;
/**
 * The watched set as a sorted list, for publication and for the file the pet
 * mirrors it into.
 *
 * Sorted so that two equal sets always serialize identically — the content key
 * that decides whether to republish compares this, and an unstable order would
 * make every tick look like a change.
 *
 * @param watch - the set.
 * @returns its members, sorted.
 */
export declare const watchList: (watch: ReadonlySet<SessionId>) => readonly SessionId[];
