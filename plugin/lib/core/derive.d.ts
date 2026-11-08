/**
 * Derivations: roster in, display-ready values out.
 *
 * Everything here is pure and clock-injected. The pet asks "what does the
 * roster look like *now*", so time arrives as an option rather than being read
 * from a global — which keeps the whole module deterministic under test and
 * lets the Host half publish on a schedule it controls.
 *
 * The tree is built here rather than in the window for the same reason: which
 * Workspace a session belongs to, which subagent hangs off which parent, and
 * what order all of that reads in are decisions, and decisions belong where a
 * test can reach them without a screen.
 *
 * @module core/derive
 */
import type { PetSettings, PetSnapshot, Registry, SessionFacts, SessionId, SessionPhase, WorkspaceRef } from './types.js';
/** Inputs a derivation needs beyond the roster itself. */
export type DeriveOptions = {
    /** The instant to evaluate against, in epoch milliseconds. */
    readonly now: number;
    /** The publication counter this snapshot carries. */
    readonly revision: number;
    /** Appearance settings, carried so the window needs no second channel. */
    readonly settings: PetSettings;
    /**
     * The Host's Workspace table, or an empty list when none could be read.
     *
     * Empty is not an error: the grouping then falls back to the directory, which
     * is what a composition without `workspaceRegistry` has to work with.
     */
    readonly workspaces: readonly WorkspaceRef[];
    /**
     * The watched set, or `null` before the pet has ever sent one.
     *
     * `null` is not the same as empty, and both mean the tree is empty: a Host
     * that has not been told what to show shows nothing, rather than everything
     * for a moment and then snapping shut.
     */
    readonly watch: ReadonlySet<SessionId> | null;
};
/**
 * The last path segment, tolerating both separators and trailing slashes.
 *
 * Trailing separators are stripped first, so the rule is uniform: the label is
 * whatever follows the final separator. A drive root therefore reads as `C:`
 * — a usable label — while a separator-only path has nothing left to show.
 *
 * @param path - an absolute directory path from a session header.
 * @returns the basename, or `null` when the path has no segment to show.
 */
export declare const basename: (path: string) => string | null;
/**
 * Collapse one session's facts into its phase.
 *
 * The order is the whole point: a session blocked on the human is the thing
 * worth interrupting someone for, so it wins over one that is merely busy, and
 * live work wins over a result the row is already carrying.
 *
 * Subagents fold into `running` rather than getting a phase of their own: a
 * child working is its parent working, and the row is what tells the two apart.
 * Everything that is neither live work nor a completed turn is `stopped` — an
 * error, an interruption, a blocked turn, or a history whose end nobody
 * observed. There is no idle case: a session that is not running has a result,
 * and idleness belongs to the Workspace.
 *
 * @param facts - the session's facts.
 * @param subagentCount - its running direct children.
 * @returns the phase to display.
 */
export declare const phaseOf: (facts: SessionFacts, subagentCount: number) => SessionPhase;
/**
 * Whether the reader may take this row out of the pet.
 *
 * One predicate, read by the view that draws the control and by the Host that
 * does the removal. They were separate once, and the difference was a ✓ drawn on
 * a row the Host then refused — with nothing on screen to say why.
 *
 * It says nothing about the watched set: membership is the runtime's, and a row
 * is only drawn when it is in the set.
 *
 * @param facts - the session's facts.
 * @param busyChildren - how many of its children are running or blocked.
 * @returns whether the row can be dismissed.
 */
export declare const dismissibleRoot: (facts: SessionFacts, busyChildren: number) => boolean;
/**
 * Build the complete payload for the pet window.
 *
 * Two levels of grouping, decided here:
 *
 * - **Workspace**, ordered by newest activity, so the project you were just in
 *   leads.
 * - **Session**, ordered by activity alone: the most recently touched
 *   conversation leads, whatever its phase. The reader asked for time order, and
 *   the phase is written on the row — so nothing has to be inferred from a
 *   position in the list.
 *
 * Subagents hang under the parent that spawned them. There is no orphan case to
 * handle here, and that is a property of the layer below rather than an
 * omission: only a watched conversation and the children of one ever reach the
 * registry, so a subagent whose parent is not being watched was never retained
 * in the first place.
 *
 * @param registry - the current roster.
 * @param options - evaluation instant, settings, the Workspace table, the watched set.
 * @returns a snapshot carrying headline counters and the ordered tree.
 */
export declare const snapshotOf: (registry: Registry, options: DeriveOptions) => PetSnapshot;
/**
 * A stable key over everything a subscriber would render.
 *
 * Publication is driven by *content*, not by the roster's revision counter,
 * because the derived tree can change without any event arriving — a Workspace
 * rename, a regrouping, or a new entry in the watched set. Comparing this key is
 * what keeps an unchanged payload from re-broadcasting, and including the
 * settings is what makes a configuration edit publish once.
 *
 * The watched set is part of the key even though it is not drawn: it is what the
 * pet writes back to `localStorage`, so a change to it is a change worth sending.
 *
 * @param snapshot - the candidate snapshot.
 * @returns a string that differs only when something renderable differs.
 */
export declare const contentKey: (snapshot: PetSnapshot) => string;
