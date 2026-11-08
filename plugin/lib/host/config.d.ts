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
    readonly enabled: boolean;
    /** First port tried for the loopback bridge. */
    readonly port: number;
    /** How many consecutive ports to try when one is taken. */
    readonly portAttempts: number;
    /** Whether the bridge requires its per-run token. */
    readonly requireToken: boolean;
    /** Whether to start the pet window process with this Host. */
    readonly autoLaunch: boolean;
    /** Explicit pet executable; empty resolves the packaged binary. */
    readonly petExecutable: string;
    /** Extra arguments appended to the pet's command line. */
    readonly petArgs: readonly string[];
    /** Quiet time after which the pet may fall asleep. */
    readonly sleepAfterMs: number;
    /** Interval between roster re-baselines; `0` disables healing. */
    readonly resyncMs: number;
};
/** Fallbacks, applied field-by-field when the row omits or mistypes a value. */
export declare const DEFAULTS: PetConfig;
/**
 * Resolve a validated config record into the plugin's exact shape.
 *
 * Total by construction: every field falls back independently, so one bad
 * value never discards the user's other choices.
 *
 * @param raw - the record the Host validated against {@link Config}.
 * @returns the resolved configuration.
 */
export declare const resolveConfig: (raw: unknown) => PetConfig;
