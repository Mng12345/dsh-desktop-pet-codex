/**
 * The imperative shell: the one place that owns mutable state and side effects.
 *
 * Everything above this module is pure. Here we hold the roster, the watched
 * set, the Host's Workspace table, a publication counter, and the handles of
 * four resources (event registrations, the HTTP bridge, the focus routes, the
 * pet process), and we fold every input through the reducer. `startPetRuntime`
 * is synchronous by design — Cordis effects must return their disposer
 * immediately — so the asynchronous bootstrap runs detached behind a `disposed`
 * flag that every await rechecks.
 *
 * ## What the roster holds, and what it deliberately does not
 *
 * The pet used to show every session DSH knows about — ninety-odd rows of
 * mostly-finished work. It now shows a set the reader curates, and this module
 * is where "curated" is enforced: a session's facts are kept only when the
 * session is watched, or when it is a subagent of one that is. Everything else
 * is dropped as it arrives rather than filtered at render, so the rows nobody
 * asked for cost nothing at all.
 *
 * The Host atomically persists the watched set. The pet's localStorage is a
 * mirror, imported only when migrating an installation without a Host file.
 * Reconnects never replace the authority or revive a handled conversation.
 *
 * @module host/runtime
 */
import { randomUUID } from 'node:crypto';
import { decodeFocusRequest, decodeRegistryWorkspaces, decodeSessionId, decodeSummaryList, decodeWatchRequest, } from '../core/decode.js';
import { contentKey, dismissibleRoot, snapshotOf } from '../core/derive.js';
import { emptyRegistry, reduceRegistry } from '../core/registry.js';
import { pendingOf, restoreEvents } from '../core/review.js';
import { decodeSettingsPatch, mergeSettings } from '../core/settings.js';
import { retained, seedOf } from '../core/watch.js';
import { startBridge } from './bridge.js';
import { clearEndpoint, writeEndpoint } from './endpoint.js';
import { createClientChannel, createFocusMailbox, registerFocusRoutes, } from './focus.js';
import { launchPet, resolvePetExecutable } from './pet-process.js';
import { loadPending, savePending } from './pending.js';
import { registerPresenceRoutes } from './presence.js';
import { loadSettings, saveSettings } from './settings.js';
import { subscribeSources } from './sources.js';
import { loadWatch, saveWatch } from './watch-state.js';
/** The bridge never leaves the machine. */
const LOOPBACK = '127.0.0.1';
/** SSE keep-alive; comfortably under any idle proxy timeout. */
const HEARTBEAT_MS = 20_000;
/**
 * How often clock-driven work is re-evaluated.
 *
 * Also the interval the Host's Workspace table is re-read on. That service
 * publishes no change event, so a poll is the only way to notice an archive —
 * and it is a pure in-memory read, so five seconds costs nothing and keeps the
 * lag below the threshold where a row vanishing reads as a glitch.
 */
const TICK_MS = 5_000;
/**
 * The publication window.
 *
 * The live answer stream fires per streamed fragment — tens of times a second
 * while a model is talking — and every publication fans out to every attached
 * window. Folding is cheap and always immediate; only the broadcast waits, so
 * the roster is never stale by more than this when someone looks at it, and a
 * burst of a hundred fragments costs one frame rather than a hundred.
 */
const PUBLISH_WINDOW_MS = 300;
/**
 * How long to wait before trying the window process again.
 *
 * Only reached when a launch *failed* — a missing or unstartable binary. A
 * window that merely died is retried at once, because that is the case the
 * self-heal exists for; this backstop is what keeps a hopeless one from logging
 * on every tick.
 */
const PET_RETRY_MS = 30_000;
/** Render an unknown thrown value as a message. */
const describe = (error) => error instanceof Error ? error.message : String(error);
/**
 * Activate the pet's Host half and return its teardown.
 *
 * @param ctx - the plugin's Host context.
 * @param config - the resolved configuration.
 * @param bundleDir - this bundle's root, for locating the packaged binary.
 * @returns the disposer that releases every resource this call acquired.
 */
export const startPetRuntime = (ctx, config, bundleDir) => {
    const log = ctx.logger('desktop-pet-codex');
    const savedWatch = loadWatch();
    const runtime = {
        disposed: false,
        registry: emptyRegistry,
        settings: loadSettings(),
        workspaces: [],
        archived: new Set(),
        workspaceRegistry: null,
        watch: savedWatch === null ? null : new Set(savedWatch),
        seeded: false,
        hasBaseline: false,
        lastWatchKey: savedWatch === null ? '' : JSON.stringify(savedWatch),
        clientSequences: new Map(),
        sourceRevision: 0,
        initialStarts: new Set(),
        subagents: new Set(),
        lastBaseline: [],
        restored: false,
        revision: 0,
        lastKey: '',
        lastPendingKey: '',
        latest: null,
        bridge: null,
        bridgeToken: null,
        pet: null,
        petRetryAt: 0,
        mailbox: createFocusMailbox(),
        channel: createClientChannel(),
        abort: new AbortController(),
        registrations: [],
        timers: [],
        pendingPublish: null,
    };
    /** Whether a session's facts belong in the roster at all. */
    const keeps = (id, parentId, isSubagent) => retained(id, parentId, isSubagent, runtime.watch ?? runtime.initialStarts) &&
        !runtime.archived.has(parentId ?? id);
    /** Persist membership before publishing: the window is now a mirror, never a second authority. */
    const persistWatch = () => {
        if (runtime.watch === null)
            return;
        const key = JSON.stringify([...runtime.watch].sort());
        if (key === runtime.lastWatchKey)
            return;
        if (saveWatch(runtime.watch))
            runtime.lastWatchKey = key;
        else
            log.warn('watched set could not be saved; will retry');
    };
    /**
     * Re-derive the snapshot and publish it only if something renderable moved.
     *
     * The derived tree depends on more than the roster — the Workspace table
     * regroups rows, and the watched set decides which rows exist at all — so the
     * content key is what decides, not the registry's revision counter.
     */
    const publishIfChanged = () => {
        const next = snapshotOf(runtime.registry, {
            now: Date.now(),
            revision: runtime.revision + 1,
            settings: runtime.settings,
            workspaces: runtime.workspaces,
            watch: runtime.watch,
        });
        const key = contentKey(next);
        if (key === runtime.lastKey)
            return;
        runtime.lastKey = key;
        runtime.revision += 1;
        runtime.latest = next;
        runtime.bridge?.publish(next);
    };
    /**
     * Write retained results only when their content changes.
     *
     * Guarded by a key rather than a timer so the file tracks the roster exactly,
     * and so the five-second tick does not rewrite an unchanged file forever.
     *
     * The `restored` guard is load-bearing, not defensive: the tick starts before
     * the first baseline lands, and an empty roster reports an empty unread set.
     * Writing that would erase the file — and with it every badge — before the
     * file had ever been read.
     */
    const persistPending = () => {
        if (!runtime.restored)
            return;
        const pending = pendingOf(runtime.registry.byId);
        const key = JSON.stringify(pending);
        if (key === runtime.lastPendingKey)
            return;
        if (savePending(pending))
            runtime.lastPendingKey = key;
        else
            log.warn('turn results could not be saved; will retry');
    };
    /**
     * Whether an event should reach the roster at all.
     *
     * A baseline is always folded — it is what prunes, so filtering it here would
     * make removal impossible. Everything else is admitted only for a session the
     * roster already holds, which is the single gate that keeps ninety unwatched
     * sessions from costing anything.
     */
    const admits = (event) => {
        switch (event.kind) {
            case 'snapshot':
                return true;
            case 'upsert':
                return keeps(event.summary.sessionId, event.summary.parentSessionId, event.summary.isSubagent);
            default:
                return runtime.registry.byId.has(event.id);
        }
    };
    /**
     * Fold one adapted fact into the roster, then arrange for it to be published.
     *
     * Folding is immediate and unconditional; only the broadcast is coalesced.
     * Events for a session the roster does not hold are dropped here — the
     * reducer's `amend` would ignore most of them anyway, but `touch` would
     * happily invent a stub, and inventing a row for a session nobody is watching
     * is the exact thing this module exists to prevent.
     */
    const commit = (event) => {
        // The one thing worth learning from a session whose facts are dropped:
        // whether it is somebody's machinery, so a turn it starts is not mistaken
        // for a conversation the reader began.
        if (event.kind === 'upsert' && event.summary.isSubagent) {
            runtime.subagents.add(event.summary.sessionId);
        }
        if (event.kind === 'remove' && runtime.watch?.delete(event.id))
            persistWatch();
        if (!admits(event))
            return;
        runtime.registry = reduceRegistry(runtime.registry, event);
        if (event.kind === 'settled' || event.kind === 'error' || event.kind === 'remove')
            persistPending();
        if (runtime.pendingPublish === null) {
            runtime.pendingPublish = setTimeout(() => {
                runtime.pendingPublish = null;
                publishIfChanged();
                persistPending();
            }, PUBLISH_WINDOW_MS);
        }
    };
    /**
     * Land a settings patch from the settings window.
     *
     * Publishing is immediate rather than coalesced: this is a person dragging a
     * control and watching the result, so the 300 ms stream window would be felt.
     * Persistence is best-effort — a read-only home costs the setting on the next
     * start, never the current one.
     */
    const updateSettings = (patch) => {
        const next = mergeSettings(runtime.settings, decodeSettingsPatch(patch));
        if (next !== runtime.settings) {
            runtime.settings = next;
            saveSettings(next);
            publishIfChanged();
        }
        return runtime.settings;
    };
    /** Remove a settled root and all of its displayed children, synchronously. */
    const dismissSession = (id) => {
        const facts = runtime.registry.byId.get(id);
        if (facts === undefined || runtime.watch === null)
            return false;
        // The same predicate the window draws its control from, so a ✓ can never
        // appear on a row this would refuse.
        const children = [...runtime.registry.byId.values()].filter((child) => child.parentId === id);
        const busy = children.filter((child) => child.running || child.pending !== null).length;
        if (!dismissibleRoot(facts, busy))
            return false;
        if (!runtime.watch.delete(id))
            return false;
        runtime.registry = reduceRegistry(runtime.registry, { kind: 'remove', id });
        for (const child of children) {
            runtime.registry = reduceRegistry(runtime.registry, { kind: 'remove', id: child.id });
        }
        persistWatch();
        persistPending();
        publishIfChanged();
        return true;
    };
    /**
     * Only a post-result entry is a review. Heartbeats and a result completing in
     * the currently selected conversation never create a new entry timestamp.
     */
    const onClientState = (state) => {
        if (state.clientId != null && state.sequence != null) {
            const previous = runtime.clientSequences.get(state.clientId) ?? -1;
            if (state.sequence <= previous)
                return;
            runtime.clientSequences.set(state.clientId, state.sequence);
        }
        const sessionId = state.sessionId;
        if (sessionId === null || !state.visible)
            return;
        const outstanding = runtime.mailbox.outstanding();
        const focusConfirmed = outstanding !== null && outstanding.sessionId === sessionId &&
            state.focusAt === outstanding.at;
        if (focusConfirmed)
            runtime.mailbox.ack(sessionId);
        const facts = runtime.registry.byId.get(sessionId);
        if (facts === undefined)
            return;
        const after = facts.settledAt ?? facts.updatedAt;
        const entryAt = state.enteredAt ?? null;
        const enteredAfterResult = entryAt !== null && entryAt > after && entryAt <= state.at;
        const clickedAfterResult = focusConfirmed && outstanding.at > after;
        if (enteredAfterResult || clickedAfterResult)
            dismissSession(sessionId);
    };
    /**
     * Read the Host's Workspace table and archive set.
     *
     * Read from the Host rather than reported by the page, which is what makes the
     * grouping exact: a Workspace carries the canonical `path` that its sessions'
     * `cwd` equals, so membership is a comparison rather than a guess at a title.
     * It also means both facts survive with no DSH page open at all.
     *
     * `Promise.resolve` wraps the call because the shipped service is synchronous
     * and this must not break if a future one is not.
     */
    const readWorkspaces = async () => {
        const face = runtime.workspaceRegistry;
        if (face === null || runtime.disposed)
            return;
        try {
            const listed = await Promise.resolve(face.list());
            if (runtime.disposed)
                return;
            runtime.workspaces = decodeRegistryWorkspaces(listed);
            const archived = face.archivedSessionIds;
            runtime.archived = new Set(Array.isArray(archived) ? archived.filter((id) => typeof id === 'string') : []);
        }
        catch (error) {
            if (!runtime.disposed)
                log.warn('workspace registry read failed: %s', describe(error));
        }
    };
    /**
     * Drop every watched session DSH has archived.
     *
     * Permanent, by the reader's rule: an archived conversation leaves the list
     * and unarchiving does not bring it back. It can only return by starting a
     * turn again, which is the same door everything else came through.
     */
    const dropArchived = () => {
        if (runtime.watch === null || runtime.archived.size === 0)
            return;
        let dropped = false;
        for (const id of runtime.archived) {
            runtime.initialStarts.delete(id);
            if (!runtime.watch.delete(id))
                continue;
            dropped = true;
            runtime.registry = reduceRegistry(runtime.registry, { kind: 'remove', id });
            for (const facts of [...runtime.registry.byId.values()]) {
                if (facts.parentId === id)
                    runtime.registry = reduceRegistry(runtime.registry, { kind: 'remove', id: facts.id });
            }
        }
        if (dropped) {
            persistWatch();
            persistPending();
            publishIfChanged();
            void baseline();
        }
    };
    /** Seed once from a real baseline; an empty list after removal stays empty. */
    const seedIfEmpty = () => {
        if (runtime.watch === null || runtime.seeded || !runtime.hasBaseline)
            return;
        runtime.seeded = true;
        if (runtime.watch.size === 0) {
            for (const id of seedOf(runtime.lastBaseline))
                runtime.watch.add(id);
        }
        persistWatch();
    };
    /**
     * Read a fresh list baseline; also the heal path for a missed event.
     *
     * The list is read whole — it cannot be filtered, the Host's `list` discards
     * its request entirely — and everything outside the watched set is dropped on
     * the spot. Reading it is unavoidable and cheap (stored headers and
     * projection-cache rows; it never opens a cold session body), and it is the
     * only thing that can repair a missed push. What the watched set buys is that
     * none of it is *kept*.
     */
    const baseline = async () => {
        try {
            const sourceRevision = runtime.sourceRevision;
            const value = await ctx.sessionController.list({}, runtime.abort.signal);
            if (runtime.disposed)
                return;
            if (sourceRevision !== runtime.sourceRevision) {
                void baseline();
                return;
            }
            const summaries = decodeSummaryList(value);
            runtime.lastBaseline = summaries;
            runtime.hasBaseline = true;
            for (const summary of summaries) {
                if (summary.isSubagent) {
                    runtime.subagents.add(summary.sessionId);
                    runtime.initialStarts.delete(summary.sessionId);
                    runtime.watch?.delete(summary.sessionId);
                }
            }
            seedIfEmpty();
            commit({
                kind: 'snapshot',
                summaries: summaries.filter((summary) => keeps(summary.sessionId, summary.parentSessionId, summary.isSubagent)),
            });
            if (!runtime.restored && runtime.watch !== null) {
                runtime.restored = true;
                // Re-armed only once, against the first roster that exists: a later
                // baseline would resurrect a badge the reader had already cleared.
                const persisted = loadPending();
                for (const event of restoreEvents(persisted, runtime.registry.byId))
                    commit(event);
            }
            persistWatch();
            persistPending();
            publishIfChanged();
        }
        catch (error) {
            if (!runtime.disposed)
                log.warn('session baseline failed: %s', describe(error));
        }
    };
    /** Import a legacy window list once. Later attaches receive the Host's durable authority. */
    const applyWatch = (ids) => {
        if (runtime.watch === null) {
            runtime.watch = new Set([...ids, ...runtime.initialStarts]);
            runtime.initialStarts.clear();
        }
        seedIfEmpty();
        persistWatch();
        publishIfChanged();
        void baseline();
    };
    /**
     * Re-offer an unacknowledged focus request over the push channel.
     *
     * The retry lives here rather than in the channel because the *mailbox* is
     * what decides whether a request is due again; the channel only delivers.
     */
    const offerFocus = () => {
        if (runtime.channel.collectors() === 0)
            return;
        const request = runtime.mailbox.offer(Date.now());
        if (request !== null)
            runtime.channel.publish(request);
    };
    /**
     * Start the window process, and remember how to start it again.
     *
     * The command line is rebuilt from the runtime rather than kept, because a
     * relaunch has to hand the new process the *same* bridge and token: a window
     * the Host started discovers nothing on its own.
     *
     * @param reason - what asked for it, for the log line.
     */
    const launchWindow = (reason) => {
        const bridge = runtime.bridge;
        if (bridge === null)
            return;
        const launched = launchPet({
            executable: resolvePetExecutable(config.petExecutable, bundleDir),
            args: config.petArgs,
            url: bridge.url,
            token: runtime.bridgeToken,
            log,
        });
        if (launched === null) {
            runtime.petRetryAt = Date.now() + PET_RETRY_MS;
            return;
        }
        runtime.pet = launched;
        runtime.petRetryAt = 0;
        log.info('pet window started (%s)', reason);
    };
    /**
     * Keep the window alive for as long as the plugin is.
     *
     * Closing the interface does not end the process, so a missing one means it
     * crashed or was killed — neither of which the reader asked for. The only way
     * to stop it deliberately is to disable this row.
     */
    const healWindow = () => {
        if (!config.autoLaunch || runtime.disposed || runtime.bridge === null)
            return;
        if (runtime.pet !== null && runtime.pet.alive())
            return;
        if (runtime.pet !== null) {
            log.warn('pet window is gone; starting it again');
            runtime.pet = null;
        }
        if (Date.now() < runtime.petRetryAt)
            return;
        launchWindow('self-heal');
    };
    /** The presence the DSH page reads: the process, and whether the pair shows. */
    const presence = () => ({
        running: runtime.pet !== null && runtime.pet.alive(),
        visible: runtime.settings.visible,
    });
    /** Bind the bridge, advertise it, take a baseline, then start the window. */
    const bootstrap = async () => {
        const token = config.requireToken ? randomUUID().replaceAll('-', '') : null;
        try {
            runtime.bridge = await startBridge({
                host: LOOPBACK,
                port: config.port,
                portAttempts: config.portAttempts,
                token,
                latest: () => runtime.latest,
                updateSettings,
                readSettings: () => runtime.settings,
                requestFocus: (body) => {
                    // Host time is the authority for the entry/result ordering.
                    const decoded = decodeFocusRequest(body, Date.now());
                    if (decoded === null)
                        return null;
                    const request = { sessionId: decoded.sessionId, at: Date.now() };
                    runtime.mailbox.put(request.sessionId, request.at);
                    // Push immediately rather than waiting for the retry tick: the whole
                    // point of the push is that the page hears about a click at once.
                    runtime.channel.publish(request);
                    log.debug('focus requested for %s', request.sessionId);
                    return request;
                },
                reviewSession: (body) => {
                    const id = decodeSessionId(undefined, body?.['sessionId']);
                    if (id === null)
                        return false;
                    return dismissSession(id);
                },
                setWatch: (body) => {
                    const request = decodeWatchRequest(body);
                    if (request === null)
                        return false;
                    applyWatch(request.ids);
                    log.info('watched set: %d conversation(s)', request.ids.length);
                    return true;
                },
                heartbeatMs: HEARTBEAT_MS,
                log,
            });
        }
        catch (error) {
            log.error('bridge failed to start; the pet has no data source: %s', describe(error));
            return;
        }
        if (runtime.disposed) {
            await runtime.bridge.close();
            runtime.bridge = null;
            return;
        }
        log.info('bridge listening on %s (token in %s)', runtime.bridge.url, 'endpoint.json');
        writeEndpoint({
            version: 1,
            url: runtime.bridge.url,
            token,
            pid: process.pid,
            startedAt: Date.now(),
        });
        await readWorkspaces();
        if (runtime.disposed)
            return;
        // Deliberately before the pet is told anything: until the watched set
        // arrives the roster is empty rather than everything, so a restart never
        // shows ninety rows for a moment and then snaps shut.
        await baseline();
        if (runtime.disposed)
            return;
        runtime.bridgeToken = token;
        if (config.autoLaunch)
            launchWindow('activation');
    };
    runtime.registrations.push(...subscribeSources(ctx, (event) => {
        if (event.kind !== 'stream' && event.kind !== 'activity' && event.kind !== 'tool' && event.kind !== 'title') {
            runtime.sourceRevision += 1;
        }
        // A turn-start can arrive before the new list row; only that entry signal
        // permits the list-level running fact to create its watched stub.
        if (event.kind === 'running' && event.running &&
            (runtime.watch ?? runtime.initialStarts).has(event.id) &&
            !runtime.registry.byId.has(event.id)) {
            runtime.registry = reduceRegistry(runtime.registry, event);
        }
        commit(event);
    }, (id) => {
        runtime.sourceRevision += 1;
        if (runtime.subagents.has(id) || runtime.archived.has(id))
            return;
        const watch = runtime.watch ?? runtime.initialStarts;
        if (!watch.has(id)) {
            watch.add(id);
            persistWatch();
            const summary = runtime.lastBaseline.find((row) => row.sessionId === id);
            if (summary !== undefined)
                commit({ kind: 'upsert', summary: { ...summary, running: true } });
            log.debug('watching %s: a turn started', id);
        }
        void baseline();
    }));
    runtime.timers.push(setInterval(() => {
        persistWatch();
        publishIfChanged();
        persistPending();
        offerFocus();
        runtime.channel.keepAlive();
        healWindow();
        void readWorkspaces().then(dropArchived);
    }, TICK_MS));
    // The Workspace table comes from the Host rather than the page, so the
    // grouping is exact and survives with no DSH page open. Optional: a
    // composition without it falls back to grouping by directory.
    ctx.inject(['workspaceRegistry'], (scoped) => {
        const face = scoped.get('workspaceRegistry');
        if (face === undefined) {
            log.info('no workspace registry in this composition; grouping by directory');
            return;
        }
        runtime.workspaceRegistry = face;
        void readWorkspaces();
    });
    // The focus routes live on the DSH web server rather than the pet bridge, so
    // the page that uses them is same-origin. They are optional: a headless
    // composition has no page to drive, and the pet still works there.
    ctx.inject(['webServer'], (scoped) => {
        if (scoped.webServer === undefined) {
            log.info('no web server in this composition; session focus is unavailable');
            return;
        }
        runtime.registrations.push(...registerFocusRoutes(scoped.webServer, {
            mailbox: runtime.mailbox,
            channel: runtime.channel,
            onClientState,
        }), 
        // The row's Configure page, which is the one place outside the pet that
        // can ask for it back after its interface was closed.
        ...registerPresenceRoutes(scoped.webServer, {
            read: presence,
            write: (patch) => {
                updateSettings({ visible: patch.visible });
                if (patch.visible) {
                    // An explicit ask ignores the retry backoff: the reader is looking
                    // at the answer.
                    runtime.petRetryAt = 0;
                    healWindow();
                }
                return presence();
            },
        }));
    });
    if (config.resyncMs > 0) {
        runtime.timers.push(setInterval(() => {
            void baseline();
        }, config.resyncMs));
    }
    void bootstrap();
    return () => {
        runtime.disposed = true;
        runtime.abort.abort();
        if (runtime.pendingPublish !== null) {
            clearTimeout(runtime.pendingPublish);
            runtime.pendingPublish = null;
        }
        for (const timer of runtime.timers.splice(0))
            clearInterval(timer);
        for (const dispose of runtime.registrations.splice(0)) {
            try {
                void dispose();
            }
            catch (error) {
                log.debug('registration teardown failed: %s', describe(error));
            }
        }
        runtime.channel.close();
        runtime.pet?.stop();
        runtime.pet = null;
        const bridge = runtime.bridge;
        runtime.bridge = null;
        clearEndpoint();
        if (bridge !== null) {
            void bridge.close().catch((error) => {
                log.debug('bridge close failed: %s', describe(error));
            });
        }
    };
};
//# sourceMappingURL=runtime.js.map