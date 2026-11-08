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
import type { PetConfig } from './config.js';
import type { Disposable, HostContext } from './context.js';
/**
 * Activate the pet's Host half and return its teardown.
 *
 * @param ctx - the plugin's Host context.
 * @param config - the resolved configuration.
 * @param bundleDir - this bundle's root, for locating the packaged binary.
 * @returns the disposer that releases every resource this call acquired.
 */
export declare const startPetRuntime: (ctx: HostContext, config: PetConfig, bundleDir: string) => Disposable;
