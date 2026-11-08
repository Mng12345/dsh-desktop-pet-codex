/**
 * Domain vocabulary for the pet's session roster.
 *
 * Every type here is plain, readonly data: no classes, no methods, no hidden
 * state. The reducer and the derivations in this directory are total functions
 * over these values, so the whole core can be reasoned about (and tested)
 * without a Harness, a clock, or a socket.
 *
 * @module core/types
 */
/** A session id. Opaque to the pet; only compared and displayed. */
export type SessionId = string;
/**
 * A request from the pet window to bring one session to the front.
 *
 * The pet cannot reach the DSH window itself — the Host half runs in a separate
 * Node process and the window belongs to the Electron shell — so a click leaves
 * this in a mailbox the plugin's browser half collects from inside that window.
 * `at` exists so two clicks on the same session are still two distinct
 * requests.
 */
export type FocusRequest = {
    readonly sessionId: SessionId;
    readonly at: number;
};
/**
 * One DSH Workspace, as the Host's own `workspaceRegistry` reports it.
 *
 * A Workspace is a first-class group with its own identity and a renameable
 * title, and it is what DSH's own sidebar groups sessions by — *not* the
 * directory. `path` is the field that makes the grouping exact: DSH's own
 * membership predicate is `session.cwd === workspace.path`, so this is that
 * comparison and nothing invented.
 *
 * It is read from the Host rather than reported by the page: `SessionSummary`
 * carries `cwd` and no workspace id, but `ctx.workspaceRegistry` holds the whole
 * table, so the grouping is right even with no DSH page open at all.
 */
export type WorkspaceRef = {
    readonly id: string;
    /** Absolute, `fs.realpath`-canonical directory; matched against `cwd`. */
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly SessionId[];
};
/**
 * What the DSH page last reported about itself.
 *
 * Only two facts, and only the page can know either: which session is selected,
 * and whether its own window is on screen. The Workspace table used to ride
 * along here; it comes from the Host's `workspaceRegistry` now, so there is one
 * source for it instead of two to reconcile.
 *
 * It arrives on selection changes and on visibility changes, so it is
 * level-triggered — the reader always has the current truth rather than an edge
 * it might have missed.
 */
export type ClientState = {
    /** The session DSH currently has selected, or `null` when none is. */
    readonly sessionId: SessionId | null;
    /** Whether that window is on screen (`document.visibilityState`). */
    readonly visible: boolean;
    /** When the page reported this, for staleness decisions. */
    readonly at: number;
    /** Actual entry into this conversation; visibility heartbeats do not renew it. */
    readonly enteredAt?: number | null;
    /** Verified pet focus request time for the currently selected conversation. */
    readonly focusAt?: number | null;
    /** Page instance and increasing sequence, used to reject out-of-order state. */
    readonly clientId?: string | null;
    readonly sequence?: number | null;
};
/**
 * The pet window's watched set, as it sends it.
 *
 * This is the whole of what the reader curates: the conversations the pet is
 * allowed to show. It lives in the pet window's own `localStorage` and nowhere
 * else, so the pet is what sends it — the Host has no way to read another
 * process' storage, and duplicating it would create a second thing to disagree
 * with the first.
 */
export type WatchRequest = {
    readonly ids: readonly SessionId[];
};
/**
 * Whether the pet's window process is up, and whether the pair is on screen.
 *
 * Read by the DSH page — whose Configure page is the one place outside the pet
 * that can ask for it back — so it is a wire shape rather than a runtime one.
 */
export type PetPresence = {
    /** The window process is alive. */
    readonly running: boolean;
    /** The pair is currently shown. */
    readonly visible: boolean;
};
/**
 * What the DSH page asks for: show the pet, or close its interface.
 *
 * Visibility only. Closing is not quitting — the process keeps the bridge and
 * the collection running, so opening again is instant — and nothing here is
 * persisted, because closing the interface is an act rather than a preference.
 */
export type PresencePatch = {
    readonly visible: boolean;
};
/** What a session is currently blocked on, waiting for the human. */
export type PendingInteraction = 'approval' | 'plan-review' | 'question';
/** How a finished turn ended, collapsed to the pet's vocabulary. */
export type TurnOutcome = 'completed' | 'error' | 'aborted' | 'other';
/**
 * The pet's per-session phase: what one row says at a glance.
 *
 * Four values and no catch-all. A session blocked on the human leads, because
 * that is the thing worth interrupting someone for; live work — its own, or its
 * subagents' — reads as running; a turn that ended well reads as completed and
 * stays that way until another turn supersedes it; and everything else reads as
 * stopped, whether it errored, was interrupted, was blocked, or ended at a
 * moment nobody observed.
 *
 * `completed` carries no clock and does not depend on `reviewed`: looking at a
 * result acknowledges it without changing how the turn ended. There is
 * deliberately no `idle` here — a session that is not running is not resting, it
 * has a result, and idleness is a property of a Workspace rather than of a
 * conversation.
 */
export type SessionPhase = 'waiting' | 'running' | 'completed' | 'stopped';
/** Which part of a live answer a text fragment came from. */
export type ThoughtKind = 'reasoning' | 'text';
/**
 * One session as the Harness reports it in a list baseline.
 *
 * A decoded projection of the Host's `SessionSummary`: absent optional fields
 * become explicit `null`s so the core never branches on `undefined`.
 */
export type SessionSummary = {
    readonly sessionId: SessionId;
    readonly updatedAt: number;
    readonly running: boolean;
    readonly agentAvailable: boolean;
    readonly blank: boolean;
    readonly cwd: string | null;
    readonly parentSessionId: SessionId | null;
    readonly isSubagent: boolean;
    /**
     * The conversation's own title.
     *
     * Not a field of `SessionSummary` on the wire: it rides inside the
     * `projections` hints block under the `title` key, which is the generic
     * session-projection channel the DSH client reads its list rows from. It is
     * `null` until a provider has produced one — a fresh session has none — and
     * the display chain then falls back to the directory.
     */
    readonly title: string | null;
};
/**
 * Where the live answer stream has got to for one session.
 *
 * Assistant frames are dense and process-local: each attempt numbers its
 * chunks from zero under a monotonic `revision`. A frame that does not fit the
 * cursor means frames were dropped, which is normal — the attempt is abandoned
 * until the next `start`.
 */
export type StreamCursor = {
    readonly attemptId: string | null;
    readonly revision: number;
    readonly nextIndex: number;
};
/** The cursor before any frame has been accepted. */
export declare const IDLE_CURSOR: StreamCursor;
/** One decoded assistant-stream frame. */
export type StreamFrame = {
    readonly kind: 'start';
    readonly attemptId: string;
    readonly revision: number;
} | {
    readonly kind: 'chunk';
    readonly attemptId: string;
    readonly index: number;
    readonly at: number;
    /** The fragment to append, or `null` for a chunk that carries no text. */
    readonly text: string | null;
    readonly textKind: ThoughtKind;
} | {
    readonly kind: 'end';
    readonly attemptId: string;
};
/** Everything the pet knows about one session. */
export type SessionFacts = {
    readonly id: SessionId;
    readonly cwd: string | null;
    readonly parentId: SessionId | null;
    readonly isSubagent: boolean;
    readonly updatedAt: number;
    readonly running: boolean;
    /** Start watermark of this process's current turn, for stale-end rejection. */
    readonly turnStartedAt?: number | null;
    readonly blank: boolean;
    /** The conversation's title, or `null` while it has none. */
    readonly title: string | null;
    /** Outstanding user interaction, or `null` when nothing is pending. */
    readonly pending: PendingInteraction | null;
    /**
     * The tool call the human is currently answering, or `null`.
     *
     * A question and a plan review leave no event of their own in this DSH — the
     * tool simply does not return until the reader answers — so the call id is
     * what tells "blocked on the human" from "working", and what a later
     * `tool/result` is matched against to end the wait.
     */
    readonly blockedCallId: string | null;
    /** Most recent tool the session started, for an at-a-glance "what is it doing". */
    readonly lastTool: string | null;
    readonly lastOutcome: TurnOutcome | null;
    /** When the last turn settled, including a result restored from disk. */
    readonly settledAt: number | null;
    readonly lastError: string | null;
    /**
     * Whether the last result has been acknowledged, independently of its phase.
     *
     * A root session's terminal result arms this to `false`. Reviewing it, starting
     * another turn, or dismissing the row acknowledges it without changing the
     * recorded outcome. A brand-new session has no result and starts acknowledged.
     */
    readonly reviewed: boolean;
    /** Position in the live answer stream. */
    readonly stream: StreamCursor;
    /** Tail of what the session is currently thinking or saying. */
    readonly thought: string;
    readonly thoughtKind: ThoughtKind | null;
    /** When the newest thought fragment arrived. */
    readonly thoughtAt: number;
};
/** The roster: every known session, keyed by id, plus a change counter. */
export type Registry = {
    readonly byId: ReadonlyMap<SessionId, SessionFacts>;
    /** Increments only when a value actually changed, so it can drive publication. */
    readonly revision: number;
};
/** One row the pet window renders. Presentation-free: labels, not sentences. */
export type SessionView = {
    readonly id: SessionId;
    /**
     * The conversation's title, or `null` while it has none.
     *
     * The UI's display chain is title, then {@link label}, then a short id — the
     * same precedence DSH's own sidebar uses, so a row reads the same in both
     * places.
     */
    readonly title: string | null;
    /** Directory basename when known, else `null` (the UI picks a fallback). */
    readonly label: string | null;
    readonly phase: SessionPhase;
    /** Whether the Harness still has an open turn for this session. */
    readonly running: boolean;
    readonly isSubagent: boolean;
    /** Running direct children of this session. */
    readonly subagentCount: number;
    readonly lastTool: string | null;
    /**
     * Whether the reader may remove this row, decided by the Host's own rule.
     *
     * Carried rather than recomputed: the window used to guess from the phase, and
     * a row it guessed wrong about showed a ✓ that could never work.
     */
    readonly dismissible: boolean;
    /** Live thinking tail, present only while the session has something to say. */
    readonly thought: string | null;
    readonly thoughtKind: ThoughtKind | null;
    readonly updatedAt: number;
    readonly error: string | null;
};
/** One session in the tree: a row, plus the subagents it spawned. */
export type SessionNode = {
    readonly session: SessionView;
    /** Direct children, ordered by the same rules as their siblings. */
    readonly children: readonly SessionNode[];
};
/**
 * One group of the tree — a DSH Workspace, or a directory when none claims it.
 *
 * `title` is `null` when the group has no name of its own: a directory group
 * (the UI shows the row's own {@link SessionView.label}) or a session with no
 * directory at all. The core does not speak the reader's language, so the
 * ungrouped word is the window's to choose.
 */
export type SessionGroup = {
    /** Prefixed by kind (`ws:` or `dir:`), so a workspace id cannot collide with a path. */
    readonly id: string;
    readonly title: string | null;
    readonly nodes: readonly SessionNode[];
    /** Newest activity in the group, including nested subagents. Orders the groups. */
    readonly updatedAt: number;
};
/** Headline counters, computed once per publication. */
export type PetTotals = {
    readonly sessions: number;
    readonly running: number;
    readonly waiting: number;
    readonly subagents: number;
};
/**
 * Appearance settings the window applies.
 *
 * These travel with every snapshot rather than being baked in at launch, so a
 * configuration change reaches the window without restarting it — and so the
 * window has exactly one source of truth for how it should look.
 */
export type PetSettings = {
    /** Whole-card scale, 0.6–2. */
    readonly scale: number;
    /** Text size relative to the panel, 0.8–1.6. */
    readonly fontScale: number;
    /** Whether the frame is shown at all; the bridge keeps running either way. */
    readonly visible: boolean;
    /** Card opacity, 0.3–1. */
    readonly opacity: number;
    /** Whether the session list is shown beside the pet. */
    readonly showSessionList: boolean;
    readonly alwaysOnTop: boolean;
};
/** The complete payload the pet window consumes. */
export type PetSnapshot = {
    readonly version: 1;
    readonly revision: number;
    readonly at: number;
    readonly settings: PetSettings;
    readonly totals: PetTotals;
    /**
     * The roster as a tree, groups already ordered.
     *
     * Flat would have been simpler to produce and harder to get right: the group
     * order, the in-group order, and which subagent hangs off which parent are all
     * decisions, and this is the layer a test can reach without a screen.
     */
    readonly groups: readonly SessionGroup[];
    /**
     * The watched set as the Host currently holds it, or `null` before the pet
     * has ever sent one.
     *
     * The pet writes this back to `localStorage`, and the `null` is what makes
     * that safe: the Host is up before the pet is, so its first snapshots describe
     * a set it has not been told about yet — and a pet that wrote those would
     * erase the reader's list on every restart.
     */
    readonly watch: readonly SessionId[] | null;
};
