/**
 * The loopback bridge: a read-only HTTP + SSE endpoint the pet window consumes.
 *
 * This is the effectful edge of the Host half. Route resolution, token
 * comparison, and framing are pure functions above it; the server object and
 * its client set are the only mutable state, and both live inside one closure
 * that `close()` fully releases.
 *
 * Bound to a loopback address only, and gated by a per-run token, because the
 * payload names the user's working directories.
 *
 * @module host/bridge
 */
import type { FocusRequest, PetSettings, PetSnapshot } from '../core/types.js';
import type { Logger } from './context.js';
/** What a request line resolves to, before any side effect. */
export type Route = {
    readonly kind: 'preflight';
} | {
    readonly kind: 'health';
} | {
    readonly kind: 'state';
} | {
    readonly kind: 'events';
}
/** Read the appearance settings in force. */
 | {
    readonly kind: 'settings-read';
}
/** Replace named fields of the appearance settings. */
 | {
    readonly kind: 'settings-write';
}
/** Ask DSH to bring one session to the front. */
 | {
    readonly kind: 'focus';
}
/** Mark a finished turn's result as looked at, without opening it. */
 | {
    readonly kind: 'review';
}
/** Replace the watched set the pet window curates. */
 | {
    readonly kind: 'watch';
} | {
    readonly kind: 'not-found';
} | {
    readonly kind: 'method-not-allowed';
};
/**
 * Resolve a method and path into a route.
 *
 * @param method - the request method, uppercased.
 * @param pathname - the request path, without query string.
 * @returns the matching route; unknown paths and verbs never reach a handler.
 */
export declare const routeOf: (method: string, pathname: string) => Route;
/**
 * Compare a presented token against the expected one.
 *
 * @param expected - the run's token, or `null` when the bridge is open.
 * @param provided - the token the caller presented, or `null` when absent.
 * @returns whether the request may proceed.
 */
export declare const tokenAccepted: (expected: string | null, provided: string | null) => boolean;
/** A live bridge. Everything the caller needs is a closure over one server. */
export type Bridge = {
    readonly port: number;
    readonly url: string;
    /** Fan a snapshot out to every attached subscriber. */
    readonly publish: (snapshot: PetSnapshot) => void;
    /** End every subscriber, stop listening, and release the port. */
    readonly close: () => Promise<void>;
};
/** Options for {@link startBridge}. */
export type BridgeOptions = {
    readonly host: string;
    readonly port: number;
    readonly portAttempts: number;
    readonly token: string | null;
    /** Read the newest snapshot, sent to each newly attached subscriber. */
    readonly latest: () => PetSnapshot | null;
    /**
     * Land a settings patch and return the value now in force.
     *
     * Provided by the runtime, which owns the settings and their persistence;
     * the bridge only decides whether the request may reach it.
     */
    readonly updateSettings: (patch: unknown) => PetSettings;
    /** Read the appearance settings in force. */
    readonly readSettings: () => PetSettings;
    /**
     * Leave a focus request for the DSH page to collect.
     *
     * Returns what was stored, so the pet can tell a real click from a no-op.
     */
    readonly requestFocus: (body: unknown) => FocusRequest | null;
    /**
     * Dismiss an unread result without opening it.
     *
     * The escape hatch for the one case the DSH page cannot confirm: a session
     * whose window never came forward, or a page that is not there to answer. It
     * is the reader saying "I know" rather than the Host inferring it.
     *
     * @returns whether a session was named and acknowledged.
     */
    readonly reviewSession: (body: unknown) => boolean;
    /**
     * Replace the watched set.
     *
     * The pet window owns it — it is the only party that can read the storage it
     * lives in — so this is the Host being told, not asked. An empty list is a
     * legitimate value and is what a first run sends.
     *
     * @returns whether the body was a watched set at all.
     */
    readonly setWatch: (body: unknown) => boolean;
    readonly heartbeatMs: number;
    readonly log: Logger;
};
/**
 * Bind the bridge, walking forward from the configured port when one is taken.
 *
 * @param options - host, port range, token, snapshot source, and logger.
 * @returns the live bridge.
 * @throws when no port in the attempted range could be bound.
 */
export declare const startBridge: (options: BridgeOptions) => Promise<Bridge>;
