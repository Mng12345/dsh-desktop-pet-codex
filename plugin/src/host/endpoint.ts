/**
 * Endpoint discovery: where the pet window learns how to reach this Host.
 *
 * The pet is a separate process and may start before, after, or without the
 * Host. It therefore needs a place to look that outlives any single run, so
 * the Host publishes one small file under the Harness home and removes it on
 * shutdown. Every write is best-effort: a read-only home must never stop the
 * pet from running, it only costs the independent-start path.
 *
 * @module host/endpoint
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the pet needs to attach to a running Host half. */
export type Endpoint = {
  readonly version: 1
  readonly url: string
  readonly token: string | null
  readonly pid: number
  readonly startedAt: number
}

/** The Harness home directory, honouring an explicit `DSH_HOME`. */
export const dshHome = (): string =>
  process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

/** This plugin's private state directory. */
export const endpointDir = (): string => join(dshHome(), 'desktop-pet-codex')

/** The discovery file's absolute path. */
export const endpointFile = (): string => join(endpointDir(), 'endpoint.json')

/** The appearance settings the settings window edits. */
export const settingsFile = (): string => join(endpointDir(), 'settings.json')

/**
 * The results nobody has read yet.
 *
 * Deliberately a separate file from the settings: the two have different
 * owners, different lifetimes, and different failure modes. Losing the settings
 * costs a window size; losing this costs a badge.
 */
export const pendingFile = (): string => join(endpointDir(), 'pending.json')

/** This plugin's private state directory, creating it when needed. */
export const ensureEndpointDir = (): boolean => {
  try {
    mkdirSync(endpointDir(), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Publish the current endpoint, replacing any stale one.
 *
 * @param endpoint - the live endpoint to advertise.
 * @returns whether the file was written.
 */
export const writeEndpoint = (endpoint: Endpoint): boolean => {
  try {
    mkdirSync(endpointDir(), { recursive: true })
    writeFileSync(endpointFile(), `${JSON.stringify(endpoint, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Withdraw the endpoint advertisement.
 *
 * @returns whether a file was removed.
 */
export const clearEndpoint = (): boolean => {
  try {
    rmSync(endpointFile(), { force: true })
    return true
  } catch {
    return false
  }
}
