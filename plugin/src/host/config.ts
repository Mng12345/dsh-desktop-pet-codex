/**
 * Plugin configuration: the row's `config` resolved to a total value.
 *
 * Deliberately free of the schema library: this module is pure and importable
 * without a Harness, which is what lets the smoke test exercise it directly.
 * The Host-facing schema that validates the row lives beside it in
 * `schema.ts`, and only the entry point imports that.
 *
 * @module host/config
 */

/**
 * The resolved configuration every other module reads.
 *
 * Operational only. Appearance —size, font size, opacity, visibility, the
 * session list, always-on-top —belongs to the settings window and is stored in
 * `settings.json`; `core/settings.ts` explains why that split exists.
 */
export type PetConfig = {
  /** Whether the pet's Host half runs at all. */
  readonly enabled: boolean
  /** First port tried for the loopback bridge. */
  readonly port: number
  /** How many consecutive ports to try when one is taken. */
  readonly portAttempts: number
  /** Whether the bridge requires its per-run token. */
  readonly requireToken: boolean
  /** Whether to start the pet window process with this Host. */
  readonly autoLaunch: boolean
  /** Explicit pet executable; empty resolves the packaged binary. */
  readonly petExecutable: string
  /** Extra arguments appended to the pet's command line. */
  readonly petArgs: readonly string[]
  /** Quiet time after which the pet may fall asleep. */
  readonly sleepAfterMs: number
  /** Interval between roster re-baselines; `0` disables healing. */
  readonly resyncMs: number
}

/** Fallbacks, applied field-by-field when the row omits or mistypes a value. */
export const DEFAULTS: PetConfig = {
  enabled: true,
  port: 47600,
  portAttempts: 20,
  requireToken: true,
  autoLaunch: true,
  petExecutable: '',
  petArgs: [],
  sleepAfterMs: 300_000,
  resyncMs: 60_000,
}

const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const readString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

const readStringList = (value: unknown, fallback: readonly string[]): readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as readonly string[])
    : fallback

/** Clamp a numeric field into an inclusive range, falling back when unusable. */
const readNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, minimum), maximum)
}

/** Clamp a numeric field into an inclusive range, rounded to an integer. */
const readInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => Math.round(readNumber(value, fallback, minimum, maximum))

/**
 * Resolve a validated config record into the plugin's exact shape.
 *
 * Total by construction: every field falls back independently, so one bad
 * value never discards the user's other choices.
 *
 * @param raw - the record the Host validated against {@link Config}.
 * @returns the resolved configuration.
 */
export const resolveConfig = (raw: unknown): PetConfig => {
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    enabled: readBoolean(record['enabled'], DEFAULTS.enabled),
    port: readInteger(record['port'], DEFAULTS.port, 1, 65_535),
    portAttempts: readInteger(record['portAttempts'], DEFAULTS.portAttempts, 1, 200),
    requireToken: readBoolean(record['requireToken'], DEFAULTS.requireToken),
    autoLaunch: readBoolean(record['autoLaunch'], DEFAULTS.autoLaunch),
    petExecutable: readString(record['petExecutable'], DEFAULTS.petExecutable).trim(),
    petArgs: readStringList(record['petArgs'], DEFAULTS.petArgs),
    sleepAfterMs: readInteger(record['sleepAfterMs'], DEFAULTS.sleepAfterMs, 0, 86_400_000),
    resyncMs: readInteger(record['resyncMs'], DEFAULTS.resyncMs, 0, 3_600_000),
  }
}
