/**
 * The bridge client: one event stream, reconnected for the life of the window.
 *
 * `EventSource` is used rather than `fetch` streaming because the browser
 * already implements exactly the retry behaviour a pet needs: a Host that
 * restarts must not require a window restart. The token travels in the query
 * string because `EventSource` cannot set headers.
 *
 * @module bridge
 */

import { decodeSnapshot, type PetSnapshot } from './state.js'
import type { Endpoint } from './tauri.js'

/** Whether the window currently has data. */
export type BridgeStatus = 'connecting' | 'live' | 'offline'

/** Options for {@link connect}. */
export type ConnectOptions = {
  readonly endpoint: Endpoint
  readonly onSnapshot: (snapshot: PetSnapshot) => void
  readonly onStatus: (status: BridgeStatus) => void
  /**
   * Called every time the stream attaches, before the first snapshot arrives.
   *
   * The window offers its legacy watched mirror for a first-run migration.
   * An existing Host file stays authoritative across reconnects and restarts.
   */
  readonly onAttach?: () => void
}

/** A live subscription. */
export type Bridge = {
  readonly close: () => void
}

/** The stream URL for one endpoint, with the token when there is one. */
export const streamUrl = (endpoint: Endpoint): string => {
  const base = `${endpoint.url.replace(/\/+$/u, '')}/events`
  return endpoint.token === null
    ? base
    : `${base}?token=${encodeURIComponent(endpoint.token)}`
}

/** The settings URL for one endpoint. */
export const settingsUrl = (endpoint: Endpoint): string =>
  `${endpoint.url.replace(/\/+$/u, '')}/settings`

/** Headers every settings request carries. */
const authHeaders = (endpoint: Endpoint): Record<string, string> =>
  endpoint.token === null ? {} : { 'x-pet-token': endpoint.token }

/**
 * Read the settings in force.
 *
 * @param endpoint - the Host half's coordinates.
 * @returns the parsed settings, or `null` when the Host is unreachable.
 */
export const readSettings = async (endpoint: Endpoint): Promise<unknown | null> => {
  try {
    const response = await fetch(settingsUrl(endpoint), { headers: authHeaders(endpoint) })
    return response.ok ? ((await response.json()) as unknown) : null
  } catch {
    return null
  }
}

/**
 * Land a settings patch.
 *
 * The Host answers with the value now in force rather than an acknowledgement,
 * because it clamps: the caller shows what actually took effect instead of what
 * it asked for.
 *
 * @param endpoint - the Host half's coordinates.
 * @param patch - the fields to replace.
 * @returns the settings now in force, or `null` when the write failed.
 */
export const writeSettings = async (
  endpoint: Endpoint,
  patch: Readonly<Record<string, unknown>>,
): Promise<unknown | null> => {
  try {
    const response = await fetch(settingsUrl(endpoint), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint) },
      body: JSON.stringify(patch),
    })
    return response.ok ? ((await response.json()) as unknown) : null
  } catch {
    return null
  }
}

/**
 * Ask DSH to bring one session to the front.
 *
 * The Host only parks the request; the plugin's browser half collects it from
 * inside the DSH window and does the switching. So a success here means
 * "accepted", not "switched" — which is why the caller also raises the window
 * itself rather than waiting for this to have done it.
 *
 * @param endpoint - the Host half's coordinates.
 * @param sessionId - the session to show.
 * @returns whether the request was accepted.
 */
export const requestFocus = async (
  endpoint: Endpoint,
  sessionId: string,
): Promise<boolean> => {
  try {
    const response = await fetch(`${endpoint.url.replace(/\/+$/u, '')}/focus`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint) },
      body: JSON.stringify({ sessionId, at: Date.now() }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Ask the Host to remove a settled parent conversation from the pet.
 *
 * The endpoint name stays `/review` for compatibility. The Host validates the
 * current state; the UI waits for its next snapshot before dropping any row.
 *
 * @param endpoint - the Host half's coordinates.
 * @param sessionId - the parent conversation to remove.
 * @returns whether the Host accepted it.
 */
export const requestReview = async (
  endpoint: Endpoint,
  sessionId: string,
): Promise<boolean> => {
  try {
    const response = await fetch(`${endpoint.url.replace(/\/+$/u, '')}/review`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint) },
      body: JSON.stringify({ sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Send this window's last mirrored watched set for Host recovery.
 *
 * It is sent on every `hello` — the frame the Host sends when a subscriber
 * attaches — covering boot and reconnects. The Host remains authoritative;
 * snapshots replace this window's local mirror once that set is available.
 *
 * @param endpoint - the Host half's coordinates.
 * @param ids - the watched sessions.
 * @returns whether the Host accepted it.
 */
export const sendWatch = async (
  endpoint: Endpoint,
  ids: readonly string[],
): Promise<boolean> => {
  try {
    const response = await fetch(`${endpoint.url.replace(/\/+$/u, '')}/watch`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(endpoint) },
      body: JSON.stringify({ ids }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Attach to the Host half's event stream.
 *
 * @param options - endpoint, snapshot sink, and status sink.
 * @returns the subscription, whose `close` stops reconnection for good.
 */
export const connect = (options: ConnectOptions): Bridge => {
  options.onStatus('connecting')
  const source = new EventSource(streamUrl(options.endpoint))

  const deliver = (event: MessageEvent<string>): void => {
    try {
      const snapshot = decodeSnapshot(JSON.parse(event.data) as unknown)
      if (snapshot !== null) options.onSnapshot(snapshot)
    } catch {
      // A malformed frame is dropped; the next one replaces the whole state.
    }
  }

  /**
   * Re-send the watched set whenever the stream (re)attaches.
   *
   * The Host holds the set in memory only, so a Host restart loses it — and this
   * frame is exactly the moment it comes back. Sending on every `hello` rather
   * than only at boot is what makes that self-healing instead of a thing the
   * reader has to fix by restarting the window too.
   */
  const hello = (event: MessageEvent<string>): void => {
    if (options.onAttach !== undefined) options.onAttach()
    deliver(event)
  }

  source.addEventListener('open', () => options.onStatus('live'))
  source.addEventListener('hello', hello as EventListener)
  source.addEventListener('snapshot', deliver as EventListener)
  source.addEventListener('error', () => {
    // EventSource reconnects on its own; report the gap and wait.
    options.onStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
  })

  return {
    close: () => source.close(),
  }
}
