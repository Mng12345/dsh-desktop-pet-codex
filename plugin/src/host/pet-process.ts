/**
 * The pet window process: resolve it, start it, stop it.
 *
 * The window is a separate executable (Tauri), so this module is the only
 * place that touches a child process. It is deliberately forgiving: a missing
 * or failing window degrades to "no pet visible", never to a broken Host.
 *
 * @module host/pet-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Logger } from './context.js'

/** A running pet window. */
export type PetProcess = {
  readonly stop: () => void
  /**
   * Whether the child is still running.
   *
   * The Host keeps the window alive for as long as the plugin is active, so a
   * crash has to be *noticed* — this is what the self-heal reads, and it is the
   * only reason the handle remembers anything at all.
   */
  readonly alive: () => boolean
}

/** Options for {@link launchPet}. */
export type LaunchOptions = {
  readonly executable: string
  readonly args: readonly string[]
  readonly url: string
  readonly token: string | null
  readonly log: Logger
}

/**
 * The directory a platform's binary ships in, e.g. `win32-x64`.
 *
 * The release archive carries one binary per platform, so the plugin can be
 * installed anywhere with a single download; this is how they are told apart.
 *
 * @param platform - defaults to the running platform.
 * @param arch - defaults to the running architecture.
 */
export const buildTarget = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => `${platform}-${arch}`

/**
 * The file name the window is built as.
 *
 * @param platform - defaults to the running platform.
 */
export const binaryName = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'dsh-desktop-pet.exe' : 'dsh-desktop-pet'

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
export const resolvePetExecutable = (
  configured: string,
  bundleDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => {
  if (configured.length > 0) return configured
  const target = join(bundleDir, 'bin', buildTarget(platform, arch), binaryName(platform))
  if (existsSync(target)) return target
  return join(bundleDir, 'bin', binaryName(platform))
}

/**
 * Start the pet window, passing it the bridge coordinates on the command line.
 *
 * The command line is preferred over the discovery file because it is exact:
 * the window never has to guess which Host started it.
 *
 * @param options - executable, extra arguments, endpoint, token, and logger.
 * @returns the handle, or `null` when no executable is present.
 */
export const launchPet = (options: LaunchOptions): PetProcess | null => {
  if (!existsSync(options.executable)) {
    options.log.warn(
      'pet window not started: no executable at %s (set petExecutable to override)',
      options.executable,
    )
    return null
  }
  if (process.platform !== 'win32') {
    // An archive does not necessarily preserve the executable bit, and a binary
    // without it fails as EACCES rather than as a missing file, which reads like
    // a broken install. Granting it costs one syscall; a read-only location is
    // not allowed to turn that into a failure.
    try {
      chmodSync(options.executable, 0o755)
    } catch {
      /* best effort: spawn reports the real problem if this mattered */
    }
  }
  const argv = [
    '--endpoint',
    options.url,
    ...(options.token === null ? [] : ['--token', options.token]),
    ...options.args,
  ]
  let child: ChildProcess
  try {
    child = spawn(options.executable, argv, {
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    })
  } catch (error) {
    options.log.warn('pet window failed to start: %s', describe(error))
    return null
  }
  let alive = true
  child.on('error', (error: Error) => {
    alive = false
    options.log.warn('pet window error: %s', error.message)
  })
  child.on('exit', (code, signal) => {
    alive = false
    options.log.debug('pet window exited (code=%s signal=%s)', String(code), String(signal))
  })
  options.log.info('pet window started (pid=%s)', String(child.pid))
  return {
    stop: () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    },
    alive: () => alive,
  }
}

/** Render an unknown thrown value as a message. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
