/**
 * The focus mailbox, the push channel, and the routes the DSH page uses.
 *
 * Bringing one session to the front needs three parties, and this module is the
 * seam between two of them:
 *
 *   the pet window  --PUT /focus-->  this mailbox  --push / poll-->  the DSH page
 *
 * The pet cannot reach the DSH window at all: the Host half is a separate Node
 * process and the window belongs to the Electron shell. But the DSH page is
 * served *by this Host* on `http://127.0.0.1:<port>`, so routes registered here
 * are **same-origin** with it — no CORS, no second token to hand around, and no
 * need for the page to know where the pet's own bridge is listening.
 *
 * ## Why push, and why it had to change
 *
 * The page used to poll. That was the bug: a `setTimeout` loop inside a
 * Chromium renderer is throttled to one second once its window is hidden, and
 * to roughly one *minute* once it has been hidden for five — and a click on the
 * pet is precisely the moment DSH is hidden, because raising it is what the
 * click is for. Measured against the old 30-second expiry, a click could be
 * dropped outright: the window came forward and the session never switched.
 *
 * Server-sent events are not timers. The page is *told* the moment a click
 * happens, whatever state its window is in, so the session is switched while
 * the window is still on its way up. Polling is kept as a fallback rather than
 * removed, because a page that has lost its stream should still work.
 *
 * ## Delivery is not completion
 *
 * Collection used to be destructive. It cannot be any more: the whole point of
 * the reader's rule is that a badge clears when the result was *actually looked
 * at*, so the Host has to be able to tell "handed to the page" from "the page
 * opened it". A request is therefore re-offered until the page reports the
 * session as selected, and only a matching report clears it.
 *
 * @module host/focus
 */
import type { ClientState, FocusRequest, SessionId } from '../core/types.js';
import type { Disposable, WebResponse, WebServerFace } from './context.js';
/** The path the browser half polls, on the DSH web server. */
export declare const FOCUS_PATH = "/desktop-pet/focus";
/** The path the browser half subscribes to, on the DSH web server. */
export declare const FOCUS_EVENTS_PATH = "/desktop-pet/focus/events";
/** The path the browser half reports its own state on. */
export declare const CLIENT_STATE_PATH = "/desktop-pet/client-state";
/** The event name a focus request is pushed under. */
export declare const FOCUS_EVENT = "focus";
/** The event name the page receives once on attach. */
export declare const FOCUS_HELLO_EVENT = "hello";
/**
 * The event name that asks the page to re-report what it is showing.
 *
 * Sent when the unread set moves, which is the one moment the Host needs an
 * answer it cannot compute. Without it, a turn finishing on the session the
 * reader is *already* looking at would leave its mark stuck until the page's
 * next heartbeat — the page has no reason of its own to speak, because neither
 * the selection nor the visibility changed.
 */
export declare const STATE_REQUEST_EVENT = "state-request";
/**
 * A single-slot mailbox for focus requests.
 *
 * One slot, one consumer, newest wins. A queue would invite the question of
 * what to do with a request nobody collected, and the answer for a pet is
 * "nothing" — the user clicks again.
 */
export type FocusMailbox = {
    /** Leave a request; the newest one wins and any earlier one is forgotten. */
    readonly put: (sessionId: SessionId, at: number) => FocusRequest;
    /**
     * The request to hand a collector right now, or `null`.
     *
     * Called by every delivery path — the push, the poll, and the retry tick — so
     * that all three share one throttle and a request is never offered twice in
     * the same window.
     */
    readonly offer: (now: number) => FocusRequest | null;
    /** Confirm a session was actually opened; clears a matching request. */
    readonly ack: (sessionId: SessionId) => boolean;
    /** The request still waiting, without consuming it. */
    readonly outstanding: () => FocusRequest | null;
};
/**
 * Create a mailbox.
 *
 * @param ttlMs - how long an uncollected request stays offerable.
 * @param redeliverMs - how often it may be offered again.
 * @returns the mailbox.
 */
export declare const createFocusMailbox: (ttlMs?: number, redeliverMs?: number) => FocusMailbox;
/**
 * The push side: every DSH page currently attached, and the two things worth
 * saying to one.
 *
 * Named for the page rather than for focus, because it carries both directions
 * of the conversation the Host cannot have any other way: a request *to* the
 * page, and a request *for* the page's own state.
 */
export type ClientChannel = {
    /** Start pushing to one attached page. */
    readonly attach: (collector: WebResponse) => void;
    /** Stop pushing to one page; idempotent, because a close and an error race. */
    readonly detach: (collector: WebResponse) => void;
    /** Hand a focus request to every attached page. */
    readonly publish: (request: FocusRequest) => void;
    /** Ask every attached page to report what it is showing. */
    readonly requestState: () => void;
    /** Keep every attached page's stream from idling out. */
    readonly keepAlive: () => void;
    /** How many pages are attached; zero means the push has nowhere to go. */
    readonly collectors: () => number;
    /** End every attached stream. */
    readonly close: () => void;
};
/**
 * Create the push channel.
 *
 * Deliberately dumb: it fans one frame out to whoever is listening and forgets
 * them when they go. Whether a request *should* be re-sent is the mailbox's
 * decision, and whether the page should be asked to speak is the runtime's, so
 * there is exactly one place that answers each question.
 *
 * @returns the channel.
 */
export declare const createClientChannel: () => ClientChannel;
/** What the routes need from the runtime that owns them. */
export type FocusRoutesOptions = {
    readonly mailbox: FocusMailbox;
    readonly channel: ClientChannel;
    /** Land one report from the DSH page. */
    readonly onClientState: (state: ClientState) => void;
};
/**
 * Register the three routes the DSH page uses.
 *
 * All three live on the DSH web server rather than the pet's bridge, because
 * the page is served from that origin: same-origin means no CORS preflight, no
 * token to distribute, and no way for the page to need to discover a port.
 *
 * @param webServer - the browser HTTP carrier.
 * @param options - the mailbox, the push channel, and the state sink.
 * @returns the registration's disposer.
 */
export declare const registerFocusRoutes: (webServer: WebServerFace, options: FocusRoutesOptions) => readonly Disposable[];
