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
/** Fallbacks, applied field-by-field when the row omits or mistypes a value. */
export const DEFAULTS = {
    enabled: true,
    port: 47600,
    portAttempts: 20,
    requireToken: true,
    autoLaunch: true,
    petExecutable: '',
    petArgs: [],
    sleepAfterMs: 300_000,
    resyncMs: 60_000,
};
const readBoolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const readString = (value, fallback) => typeof value === 'string' ? value : fallback;
const readStringList = (value, fallback) => Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : fallback;
/** Clamp a numeric field into an inclusive range, falling back when unusable. */
const readNumber = (value, fallback, minimum, maximum) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.min(Math.max(value, minimum), maximum);
};
/** Clamp a numeric field into an inclusive range, rounded to an integer. */
const readInteger = (value, fallback, minimum, maximum) => Math.round(readNumber(value, fallback, minimum, maximum));
/**
 * Resolve a validated config record into the plugin's exact shape.
 *
 * Total by construction: every field falls back independently, so one bad
 * value never discards the user's other choices.
 *
 * @param raw - the record the Host validated against {@link Config}.
 * @returns the resolved configuration.
 */
export const resolveConfig = (raw) => {
    const record = typeof raw === 'object' && raw !== null ? raw : {};
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
    };
};
//# sourceMappingURL=config.js.map