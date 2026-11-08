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

import type { PetSettings } from './types.js'

/**
 * What a fresh install looks like before anyone touches the settings window.
 *
 * These live here rather than in the plugin's `Config` on purpose: appearance
 * has exactly one owner, and it is the settings window. Operational settings —
 * ports, tokens, whether to launch the window at all — stay in `Config`, where
 * they belong with the rest of the plugin row.
 */
export const DEFAULT_SETTINGS: PetSettings = {
  scale: 1,
  fontScale: 1,
  visible: true,
  opacity: 0.94,
  showSessionList: true,
  alwaysOnTop: true,
}

/** The ranges each numeric setting is clamped into. */
export const SETTINGS_RANGE = {
  scale: { min: 0.6, max: 2 },
  fontScale: { min: 0.8, max: 1.6 },
  opacity: { min: 0.3, max: 1 },
} as const

/** A partial update: only the fields the caller actually named. */
export type SettingsPatch = Partial<PetSettings>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A number clamped into range, or `null` when the field is absent or unusable. */
const readNumber = (
  value: unknown,
  range: { readonly min: number; readonly max: number },
): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(Math.max(value, range.min), range.max)
}

/** A boolean, or `null` when the field is absent or not a boolean. */
const readBoolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

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
export const decodeSettingsPatch = (raw: unknown): SettingsPatch => {
  if (!isRecord(raw)) return {}
  const scale = readNumber(raw['scale'], SETTINGS_RANGE.scale)
  const fontScale = readNumber(raw['fontScale'], SETTINGS_RANGE.fontScale)
  const opacity = readNumber(raw['opacity'], SETTINGS_RANGE.opacity)
  const visible = readBoolean(raw['visible'])
  const showSessionList = readBoolean(raw['showSessionList'])
  const alwaysOnTop = readBoolean(raw['alwaysOnTop'])
  return {
    ...(scale === null ? {} : { scale }),
    ...(fontScale === null ? {} : { fontScale }),
    ...(opacity === null ? {} : { opacity }),
    ...(visible === null ? {} : { visible }),
    ...(showSessionList === null ? {} : { showSessionList }),
    ...(alwaysOnTop === null ? {} : { alwaysOnTop }),
  }
}

/**
 * Land a patch on the current settings.
 *
 * @param current - the settings in force.
 * @param patch - the fields to replace.
 * @returns a new value; `current` itself when the patch is empty.
 */
export const mergeSettings = (current: PetSettings, patch: SettingsPatch): PetSettings => {
  const keys = Object.keys(patch)
  return keys.length === 0 ? current : { ...current, ...patch }
}

/**
 * Whether two settings values are indistinguishable to the window.
 *
 * Kept here beside the shape it compares so adding a field cannot silently
 * escape the check that decides whether a frame needs re-sending.
 */
export const sameSettings = (left: PetSettings, right: PetSettings): boolean =>
  left.scale === right.scale &&
  left.fontScale === right.fontScale &&
  left.visible === right.visible &&
  left.opacity === right.opacity &&
  left.showSessionList === right.showSessionList &&
  left.alwaysOnTop === right.alwaysOnTop
