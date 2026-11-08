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
import { createServer } from 'node:http';
import { HELLO_EVENT, SNAPSHOT_EVENT, encodeJson, encodeSnapshot, sseComment, sseFrame, } from '../core/wire.js';
/**
 * Headers every response carries.
 *
 * The window is served from its own origin (`http://tauri.localhost`), so the
 * browser treats this bridge as cross-origin and refuses to deliver a response
 * without these. The origin is not the security boundary here — the bridge is
 * loopback-only and the token is — so a permissive origin is honest about what
 * actually protects the payload.
 */
const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-pet-token, content-type',
    'access-control-allow-methods': 'GET, PUT, OPTIONS',
};
/** Largest settings body accepted, before parsing. */
const MAX_BODY_BYTES = 8 * 1024;
/**
 * Resolve a method and path into a route.
 *
 * @param method - the request method, uppercased.
 * @param pathname - the request path, without query string.
 * @returns the matching route; unknown paths and verbs never reach a handler.
 */
export const routeOf = (method, pathname) => {
    if (method === 'OPTIONS')
        return { kind: 'preflight' };
    switch (pathname) {
        case '/health':
            return method === 'GET' ? { kind: 'health' } : { kind: 'method-not-allowed' };
        case '/state':
            return method === 'GET' ? { kind: 'state' } : { kind: 'method-not-allowed' };
        case '/events':
            return method === 'GET' ? { kind: 'events' } : { kind: 'method-not-allowed' };
        case '/settings':
            if (method === 'GET')
                return { kind: 'settings-read' };
            return method === 'PUT' ? { kind: 'settings-write' } : { kind: 'method-not-allowed' };
        case '/focus':
            return method === 'PUT' ? { kind: 'focus' } : { kind: 'method-not-allowed' };
        case '/review':
            return method === 'PUT' ? { kind: 'review' } : { kind: 'method-not-allowed' };
        case '/watch':
            return method === 'PUT' ? { kind: 'watch' } : { kind: 'method-not-allowed' };
        default:
            return { kind: 'not-found' };
    }
};
/**
 * Compare a presented token against the expected one.
 *
 * @param expected - the run's token, or `null` when the bridge is open.
 * @param provided - the token the caller presented, or `null` when absent.
 * @returns whether the request may proceed.
 */
export const tokenAccepted = (expected, provided) => expected === null || provided === expected;
/**
 * Read a request body, bounded.
 *
 * @param request - the incoming request.
 * @returns the raw body text.
 * @throws when the body exceeds {@link MAX_BODY_BYTES}.
 */
const readBody = async (request) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk;
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('body too large');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
};
/** Read the token from the header first, then the query string. */
const presentedToken = (request) => {
    const header = request.headers['x-pet-token'];
    if (typeof header === 'string' && header.length > 0)
        return header;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const query = url.searchParams.get('token');
    return query !== null && query.length > 0 ? query : null;
};
/** The path of a request, without its query string. */
const pathOf = (request) => new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
/** Start listening, rejecting on the first error rather than on a timeout. */
const listen = (server, host, port) => new Promise((resolve, reject) => {
    const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
    };
    const onListening = () => {
        server.off('error', onError);
        resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
});
const isPortTaken = (error) => typeof error === 'object' &&
    error !== null &&
    error.code === 'EADDRINUSE';
/**
 * Bind the bridge, walking forward from the configured port when one is taken.
 *
 * @param options - host, port range, token, snapshot source, and logger.
 * @returns the live bridge.
 * @throws when no port in the attempted range could be bound.
 */
export const startBridge = async (options) => {
    const subscribers = new Set();
    const send = (subscriber, chunk) => {
        try {
            subscriber.write(chunk);
        }
        catch {
            subscribers.delete(subscriber);
        }
    };
    const handleEvents = (request, response) => {
        response.writeHead(200, {
            ...CORS_HEADERS,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        response.flushHeaders();
        subscribers.add(response);
        request.on('close', () => subscribers.delete(response));
        const current = options.latest();
        if (current !== null)
            send(response, sseFrame(HELLO_EVENT, encodeSnapshot(current)));
    };
    const json = (response, status, body) => {
        response.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8' });
        response.end(encodeJson(body));
    };
    /**
     * Replace settings fields, then answer with the value now in force.
     *
     * The response matters: a patch is clamped and may be partly ignored, and the
     * settings window shows what actually took effect rather than what it asked
     * for. Answering synchronously avoids a second round trip to discover that a
     * value came back different.
     */
    const handleSettingsWrite = async (request, response) => {
        let patch;
        try {
            const text = await readBody(request);
            patch = text.trim() === '' ? {} : JSON.parse(text);
        }
        catch {
            json(response, 400, { error: 'bad-request' });
            return;
        }
        json(response, 200, options.updateSettings(patch));
    };
    /**
     * Accept a focus request from the pet window.
     *
     * Nothing is opened here: the request is parked in the mailbox and pushed to
     * the DSH page. Answering `202` rather than `200` keeps that honest —
     * accepted, not yet acted on.
     */
    const handleFocus = async (request, response) => {
        let body;
        try {
            const text = await readBody(request);
            body = text.trim() === '' ? {} : JSON.parse(text);
        }
        catch {
            json(response, 400, { error: 'bad-request' });
            return;
        }
        const accepted = options.requestFocus(body);
        if (accepted === null) {
            json(response, 400, { error: 'no-session' });
            return;
        }
        json(response, 202, accepted);
    };
    /** Dismiss an unread result by hand. Synchronous: it is one roster fact. */
    const handleReview = async (request, response) => {
        let body;
        try {
            const text = await readBody(request);
            body = text.trim() === '' ? {} : JSON.parse(text);
        }
        catch {
            json(response, 400, { error: 'bad-request' });
            return;
        }
        if (!options.reviewSession(body)) {
            json(response, 400, { error: 'no-session' });
            return;
        }
        json(response, 200, { ok: true });
    };
    /** Replace the watched set. Synchronous: it is one set of ids. */
    const handleWatch = async (request, response) => {
        let body;
        try {
            const text = await readBody(request);
            body = text.trim() === '' ? {} : JSON.parse(text);
        }
        catch {
            json(response, 400, { error: 'bad-request' });
            return;
        }
        if (!options.setWatch(body)) {
            json(response, 400, { error: 'no-ids' });
            return;
        }
        json(response, 200, { ok: true });
    };
    const handle = (request, response) => {
        const route = routeOf(request.method ?? 'GET', pathOf(request));
        if (route.kind === 'preflight') {
            response.writeHead(204, CORS_HEADERS);
            response.end();
            return;
        }
        if (route.kind === 'not-found' || route.kind === 'method-not-allowed') {
            json(response, route.kind === 'not-found' ? 404 : 405, { error: route.kind });
            return;
        }
        if (route.kind === 'health') {
            json(response, 200, { ok: true, version: 1 });
            return;
        }
        if (!tokenAccepted(options.token, presentedToken(request))) {
            json(response, 401, { error: 'unauthorized' });
            return;
        }
        if (route.kind === 'settings-write') {
            void handleSettingsWrite(request, response);
            return;
        }
        if (route.kind === 'focus') {
            void handleFocus(request, response);
            return;
        }
        if (route.kind === 'review') {
            void handleReview(request, response);
            return;
        }
        if (route.kind === 'watch') {
            void handleWatch(request, response);
            return;
        }
        if (route.kind === 'settings-read') {
            json(response, 200, options.readSettings());
            return;
        }
        if (route.kind === 'events') {
            handleEvents(request, response);
            return;
        }
        const current = options.latest();
        if (current === null) {
            json(response, 503, { error: 'not-ready' });
            return;
        }
        response.writeHead(200, {
            ...CORS_HEADERS,
            'content-type': 'application/json; charset=utf-8',
        });
        response.end(encodeSnapshot(current));
    };
    const server = createServer(handle);
    server.on('clientError', (_error, socket) => {
        if (socket.writable)
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    let bound = -1;
    let lastError = null;
    for (let attempt = 0; attempt < options.portAttempts; attempt += 1) {
        const candidate = options.port + attempt;
        try {
            await listen(server, options.host, candidate);
            bound = candidate;
            break;
        }
        catch (error) {
            lastError = error;
            if (!isPortTaken(error))
                throw error;
            options.log.debug('bridge: port %d is taken, trying %d', candidate, candidate + 1);
        }
    }
    if (bound < 0) {
        throw new Error(`desktop-pet: no free port in ${String(options.port)}..${String(options.port + options.portAttempts - 1)}: ${String(lastError)}`);
    }
    const heartbeat = setInterval(() => {
        for (const subscriber of subscribers)
            send(subscriber, sseComment('keep-alive'));
    }, options.heartbeatMs);
    heartbeat.unref();
    return {
        port: bound,
        url: `http://${options.host}:${String(bound)}`,
        publish: (snapshot) => {
            const frame = sseFrame(SNAPSHOT_EVENT, encodeSnapshot(snapshot));
            for (const subscriber of subscribers)
                send(subscriber, frame);
        },
        close: async () => {
            clearInterval(heartbeat);
            for (const subscriber of subscribers)
                subscriber.end();
            subscribers.clear();
            await new Promise((resolve) => {
                server.close(() => {
                    resolve();
                });
                server.closeAllConnections();
            });
        },
    };
};
//# sourceMappingURL=bridge.js.map