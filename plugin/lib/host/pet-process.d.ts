/**
 * The pet window process: resolve it, start it, stop it.
 *
 * The window is a separate executable (Tauri), so this module is the only
 * place that touches a child process. It is deliberately forgiving: a missing
 * or failing window degrades to "no pet visible", never to a broken Host.
 *
 * @module host/pet-process
 */
import type { Logger } from './context.js';
/** A running pet window. */
export type PetProcess = {
    readonly stop: () => void;
    /**
     * Whether the child is still running.
     *
     * The Host keeps the window alive for as long as the plugin is active, so a
     * crash has to be *noticed* — this is what the self-heal reads, and it is the
     * only reason the handle remembers anything at all.
     */
    readonly alive: () => boolean;
};
/** Options for {@link launchPet}. */
export type LaunchOptions = {
    readonly executable: string;
    readonly args: readonly string[];
    readonly url: string;
    readonly token: string | null;
    readonly log: Logger;
};
/**
 * The directory a platform's binary ships in, e.g. `win32-x64`.
 *
 * The release archive carries one binary per platform, so the plugin can be
 * installed anywhere with a single download; this is how they are told apart.
 *
 * @param platform - defaults to the running platform.
 * @param arch - defaults to the running architecture.
 */
export declare const buildTarget: (platform?: NodeJS.Platform, arch?: NodeJS.Architecture) => string;
/**
 * The file name the window is built as.
 *
 * @param platform - defaults to the running platform.
 */
export declare const binaryName: (platform?: NodeJS.Platform) => string;
/**
 * Resolve which executable to start.
 *
 * An explicit path always wins, so a development build can be pointed at
 * directly; otherwise the binary packaged for this platform and architecture is
 * used. A flat `bin/` is still accepted, because that is where a build puts the
 * executable when it is copied in by hand.
 *
 * @param configured - the `petExecutable` config value, possibly empty.
 * @param bundleDir - this bundle's root directory.
 * @param platform - defaults to the running platform.
 * @param arch - defaults to the running architecture.
 * @returns the absolute path to try.
 */
export declare const resolvePetExecutable: (configured: string, bundleDir: string, platform?: NodeJS.Platform, arch?: NodeJS.Architecture) => string;
/**
 * Start the pet window, passing it the bridge coordinates on the command line.
 *
 * The command line is preferred over the discovery file because it is exact:
 * the window never has to guess which Host started it.
 *
 * @param options - executable, extra arguments, endpoint, token, and logger.
 * @returns the handle, or `null` when no executable is present.
 */
export declare const launchPet: (options: LaunchOptions) => PetProcess | null;
