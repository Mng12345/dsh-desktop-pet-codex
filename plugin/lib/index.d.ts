/**
 * `desktop-pet-codex` — the Host half of the desktop pet.
 *
 * Responsibilities, in order of what a reader should trust:
 *   1. `core/` derives everything renderable from a pure roster fold.
 *   2. `host/` acquires resources: event registrations, a loopback bridge, and
 *      the pet window process.
 *   3. This file is only the plugin contract: identity, dependencies, config,
 *      and the single effect that owns the runtime.
 *
 * The window itself lives in `pet-app/` (Tauri) and reads the bridge; nothing
 * here renders anything.
 *
 * @module index
 */
import type { HostContext } from './host/context.js';
import { Config } from './host/schema.js';
/** Loader identity for this bundle's row. */
export declare const name = "desktop-pet-codex";
/** The one Host service this plugin cannot run without. */
export declare const inject: string[];
export { Config };
/**
 * Activate the pet's Host half.
 *
 * @param ctx - the plugin's Host context.
 * @param config - the row's `config`, validated against {@link Config}.
 */
export declare function apply(ctx: HostContext, config: unknown): void;
