/**
 * Appearance settings: defaults, decoding, and merging.
 *
 * The window's settings window is the only writer of these values, and it
 * writes them through the bridge, so this module is the single place that
 * decides what a well-formed patch is and how it lands on the current value.
 * Everything here is pure: the file that persists the result and the route that
 * receives it live in `host/`.
 *
 * @module core/settings
 */
import type { PetSettings } from './types.js';
/**
 * What a fresh install looks like before anyone touches the settings window.
 *
 * These live here rather than in the plugin's `Config` on purpose: appearance
 * has exactly one owner, and it is the settings window. Operational settings —
 * ports, tokens, whether to launch the window at all — stay in `Config`, where
 * they belong with the rest of the plugin row.
 */
export declare const DEFAULT_SETTINGS: PetSettings;
/** The ranges each numeric setting is clamped into. */
export declare const SETTINGS_RANGE: {
    readonly scale: {
        readonly min: 0.6;
        readonly max: 2;
    };
    readonly fontScale: {
        readonly min: 0.8;
        readonly max: 1.6;
    };
    readonly opacity: {
        readonly min: 0.3;
        readonly max: 1;
    };
};
/** A partial update: only the fields the caller actually named. */
export type SettingsPatch = Partial<PetSettings>;
/**
 * Decode an untrusted settings patch.
 *
 * Absent, mistyped, and out-of-range fields are all handled the same way: the
 * field is left out of the patch, so the current value survives. A settings
 * window that sends one bad slider must not reset the other five.
 *
 * @param raw - the parsed JSON body of a settings write.
 * @returns only the fields that were present and usable.
 */
export declare const decodeSettingsPatch: (raw: unknown) => SettingsPatch;
/**
 * Land a patch on the current settings.
 *
 * @param current - the settings in force.
 * @param patch - the fields to replace.
 * @returns a new value; `current` itself when the patch is empty.
 */
export declare const mergeSettings: (current: PetSettings, patch: SettingsPatch) => PetSettings;
/**
 * Whether two settings values are indistinguishable to the window.
 *
 * Kept here beside the shape it compares so adding a field cannot silently
 * escape the check that decides whether a frame needs re-sending.
 */
export declare const sameSettings: (left: PetSettings, right: PetSettings) => boolean;
