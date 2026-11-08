/**
 * The slice of the Cordis context this plugin actually uses.
 *
 * Declared structurally rather than imported: the Harness' own type packages
 * are not installed beside this bundle (they resolve from the dsh install at
 * runtime), and a status indicator needs very little of the surface. Keeping
 * the declaration small means the plugin cannot quietly start depending on
 * Host internals — anything new must be added here first, on purpose.
 *
 * @module host/context
 */
/** A registration's teardown. Cordis disposers are single-shot and idempotent. */
export type Disposable = () => void;
/** The Host logger this plugin is handed. */
export type Logger = {
    debug(message: string, ...args: readonly unknown[]): void;
    info(message: string, ...args: readonly unknown[]): void;
    warn(message: string, ...args: readonly unknown[]): void;
    error(message: string, ...args: readonly unknown[]): void;
};
/** Options accepted by `ctx.on`; `global` escapes the listener's own scope. */
export type ListenerOptions = {
    readonly global?: boolean;
    readonly prepend?: boolean;
};
/** The Host service backing the generated `ctx.remote.session` namespace. */
export type SessionController = {
    list(request: {
        readonly cursor?: string;
    }, signal: AbortSignal): Promise<unknown>;
};
/**
 * The slice of a Node HTTP request the focus routes read.
 *
 * Declared structurally for the same reason as everything else here: the
 * Harness' own type packages resolve at runtime, not at build time.
 */
export type WebRequest = {
    readonly method?: string;
    readonly url?: string;
    on(event: 'close', listener: () => void): void;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
};
/**
 * The slice of a Node HTTP response the focus routes write.
 *
 * `flushHeaders` is the load-bearing member: a server-sent event stream is
 * worthless until its headers are on the wire, and the web server hands the
 * handler the raw response precisely so it can own that lifecycle.
 */
export type WebResponse = {
    writeHead(status: number, headers?: Record<string, string>): void;
    flushHeaders(): void;
    write(chunk: string): void;
    end(body?: string): void;
    on(event: 'close', listener: () => void): void;
};
/** The slice of the browser HTTP carrier this plugin registers on. */
export type WebServerFace = {
    register(route: {
        readonly kind: 'exact';
        readonly path: string;
        readonly handler: (request: WebRequest, response: WebResponse) => void;
    }): Disposable;
};
/**
 * The context members this plugin calls.
 *
 * `on` and `effect` are the only registration channels used, which is what the
 * Harness requires: every resource a plugin owns must be torn down with the
 * fiber that created it.
 */
export type HostContext = {
    logger(name: string): Logger;
    effect(setup: () => Disposable | void): Disposable;
    on(event: string, listener: (...args: readonly unknown[]) => void, options?: ListenerOptions): Disposable;
    get<T = unknown>(key: string): T | undefined;
    /** Reach an optional service without making this plugin depend on it. */
    inject(keys: readonly string[], callback: (ctx: HostContext) => void): Disposable;
    readonly sessionController: SessionController;
    /**
     * The browser HTTP carrier, used to serve the focus route to the DSH page.
     *
     * Optional on purpose: a headless composition may not mount it, and the pet
     * should still run there — a click then opens the app without switching.
     */
    readonly webServer?: WebServerFace;
};
