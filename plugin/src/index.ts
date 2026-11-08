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

import { fileURLToPath } from 'node:url'

import { resolveConfig } from './host/config.js'
import type { HostContext } from './host/context.js'
import { startPetRuntime } from './host/runtime.js'
import { Config } from './host/schema.js'

/** Loader identity for this bundle's row. */
export const name = 'desktop-pet-codex'

/** The one Host service this plugin cannot run without. */
export const inject = ['sessionController']

export { Config }

/**
 * This bundle's root directory: `lib/` sits directly beneath it.
 *
 * Resolved lazily, from `import.meta.url` rather than the newer
 * `import.meta.dirname`, so nothing here can throw while the module is being
 * linked — an import-time failure is reported as "failed to import" with no
 * detail, which is the hardest kind to diagnose.
 */
const bundleDir = (): string => fileURLToPath(new URL('..', import.meta.url))

/**
 * Activate the pet's Host half.
 *
 * @param ctx - the plugin's Host context.
 * @param config - the row's `config`, validated against {@link Config}.
 */
export function apply(ctx: HostContext, config: unknown): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    ctx.logger(name).info('disabled by config; not starting')
    return
  }
  ctx.effect(() => startPetRuntime(ctx, resolved, bundleDir()))
}
