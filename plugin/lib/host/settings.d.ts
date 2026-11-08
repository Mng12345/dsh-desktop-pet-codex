/**
 * Settings persistence: the Host half's half of the settings contract.
 *
 * The settings window is the only writer, and it writes through the bridge; the
 * Host validates the patch with `core/settings.ts` and lands the result here.
 * The file is deliberately separate from the plugin's `Config`: appearance is
 * owned by the settings window, and the row's config is about plumbing.
 *
 * Every read is total — a missing, unreadable, or corrupt file yields the
 * defaults rather than an error, because a pet that will not start is a worse
 * outcome than a pet that forgot its size.
 *
 * @module host/settings
 */
import type { PetSettings } from '../core/types.js';
import { settingsFile } from './endpoint.js';
/**
 * Read the persisted appearance settings.
 *
 * The file is treated as a patch: whatever it holds is merged over the
 * defaults, so a partially written or hand-edited file still produces a usable
 * configuration.
 *
 * Visibility is the one field deliberately not restored: closing the interface
 * is a runtime act rather than a preference, so every start shows the pair
 * again — which is also what keeps "close it" from being a one-way door.
 *
 * @returns the settings in force.
 */
export declare const loadSettings: () => PetSettings;
/**
 * Persist the appearance settings.
 *
 * Every field but `visible`; see {@link loadSettings} for why that one is left
 * out rather than written and ignored.
 *
 * @param settings - the value to store.
 * @returns whether the file was written; the caller does not depend on it.
 */
export declare const saveSettings: (settings: PetSettings) => boolean;
export { settingsFile };
