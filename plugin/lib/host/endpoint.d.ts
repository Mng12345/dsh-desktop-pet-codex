/**
 * Endpoint discovery: where the pet window learns how to reach this Host.
 *
 * The pet is a separate process and may start before, after, or without the
 * Host. It therefore needs a place to look that outlives any single run, so
 * the Host publishes one small file under the Harness home and removes it on
 * shutdown. Every write is best-effort: a read-only home must never stop the
 * pet from running, it only costs the independent-start path.
 *
 * @module host/endpoint
 */
/** What the pet needs to attach to a running Host half. */
export type Endpoint = {
    readonly version: 1;
    readonly url: string;
    readonly token: string | null;
    readonly pid: number;
    readonly startedAt: number;
};
/** The Harness home directory, honouring an explicit `DSH_HOME`. */
export declare const dshHome: () => string;
/** This plugin's private state directory. */
export declare const endpointDir: () => string;
/** The discovery file's absolute path. */
export declare const endpointFile: () => string;
/** The appearance settings the settings window edits. */
export declare const settingsFile: () => string;
/**
 * The results nobody has read yet.
 *
 * Deliberately a separate file from the settings: the two have different
 * owners, different lifetimes, and different failure modes. Losing the settings
 * costs a window size; losing this costs a badge.
 */
export declare const pendingFile: () => string;
/** This plugin's private state directory, creating it when needed. */
export declare const ensureEndpointDir: () => boolean;
/**
 * Publish the current endpoint, replacing any stale one.
 *
 * @param endpoint - the live endpoint to advertise.
 * @returns whether the file was written.
 */
export declare const writeEndpoint: (endpoint: Endpoint) => boolean;
/**
 * Withdraw the endpoint advertisement.
 *
 * @returns whether a file was removed.
 */
export declare const clearEndpoint: () => boolean;
