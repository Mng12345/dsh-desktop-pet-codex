/**
 * The pet's presence routes: what the DSH page reads, and how it asks for the
 * pet back.
 *
 * The Configure page lives in the DSH page, so it needs two things the pet's
 * own bridge cannot give it: the live state of the window process, and a way to
 * open or close the interface. Both are registered on the DSH web server rather
 * than on the bridge, for the same reason the focus routes are — the page is
 * served from that origin, so there is no CORS preflight, no second token, and
 * no port for the page to discover.
 *
 * Closing is not quitting. The process lives for as long as the plugin is
 * active (the runtime's tick repairs a crash), so this route only ever moves
 * visibility, and it writes nothing down: a closed interface comes back at the
 * next start, which is what keeps "close it" from being a one-way door.
 *
 * @module host/presence
 */

import { decodePresencePatch } from '../core/decode.js'
import type { PetPresence, PresencePatch } from '../core/types.js'
import type { Disposable, WebServerFace } from './context.js'
import { readJson, replyJson } from './http.js'

/** The path the DSH page reads and writes the pet's presence on. */
export const PET_PATH = '/desktop-pet/pet'

/** What the routes need from the runtime that owns them. */
export type PresenceRoutesOptions = {
  /** The presence right now. */
  readonly read: () => PetPresence
  /**
   * Apply a patch.
   *
   * Showing also makes sure the process is up: the page's "open" means the pet
   * should be *there*, and a process that died is not something the reader
   * should have to fix twice.
   */
  readonly write: (patch: PresencePatch) => PetPresence
}

/**
 * Register the presence route.
 *
 * @param webServer - the browser HTTP carrier.
 * @param options - the presence reader and writer.
 * @returns the registration's disposer.
 */
export const registerPresenceRoutes = (
  webServer: WebServerFace,
  options: PresenceRoutesOptions,
): readonly Disposable[] => [
  webServer.register({
    kind: 'exact',
    path: PET_PATH,
    handler: (request, response) => {
      const method = (request.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        replyJson(response, 200, options.read())
        return
      }
      if (method !== 'PUT') {
        replyJson(response, 405, { error: 'method-not-allowed' })
        return
      }
      void (async () => {
        let body: unknown = null
        try {
          body = await readJson(request)
        } catch {
          body = null
        }
        const patch = decodePresencePatch(body)
        if (patch === null) {
          replyJson(response, 400, { error: 'bad-request' })
          return
        }
        replyJson(response, 200, options.write(patch))
      })()
    },
  }),
]
