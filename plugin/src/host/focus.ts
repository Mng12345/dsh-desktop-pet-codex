/**
 * The focus mailbox, the push channel, and the routes the DSH page uses.
 *
 * Bringing one session to the front needs three parties, and this module is the
 * seam between two of them:
 *
 *   the pet window  --PUT /focus-->  this mailbox  --push / poll-->  the DSH page
 *
 * The pet cannot reach the DSH window at all: the Host half is a separate Node
 * process and the window belongs to the Electron shell. But the DSH page is
 * served *by this Host* on `http://127.0.0.1:<port>`, so routes registered here
 * are **same-origin** with it — no CORS, no second token to hand around, and no
 * need for the page to know where the pet's own bridge is listening.
 *
 * ## Why push, and why it had to change
 *
 * The page used to poll. That was the bug: a `setTimeout` loop inside a
 * Chromium renderer is throttled to one second once its window is hidden, and
 * to roughly one *minute* once it has been hidden for five — and a click on the
 * pet is precisely the moment DSH is hidden, because raising it is what the
 * click is for. Measured against the old 30-second expiry, a click could be
 * dropped outright: the window came forward and the session never switched.
 *
 * Server-sent events are not timers. The page is *told* the moment a click
 * happens, whatever state its window is in, so the session is switched while
 * the window is still on its way up. Polling is kept as a fallback rather than
 * removed, because a page that has lost its stream should still work.
 *
 * ## Delivery is not completion
 *
 * Collection used to be destructive. It cannot be any more: the whole point of
 * the reader's rule is that a badge clears when the result was *actually looked
 * at*, so the Host has to be able to tell "handed to the page" from "the page
 * opened it". A request is therefore re-offered until the page reports the
 * session as selected, and only a matching report clears it.
 *
 * @module host/focus
 */

import { decodeClientState } from '../core/decode.js'
import type { ClientState, FocusRequest, SessionId } from '../core/types.js'
import { encodeJson, sseComment, sseFrame } from '../core/wire.js'
import type { Disposable, WebResponse, WebServerFace } from './context.js'
import { readJson, replyJson } from './http.js'

/** The path the browser half polls, on the DSH web server. */
export const FOCUS_PATH = '/desktop-pet/focus'

/** The path the browser half subscribes to, on the DSH web server. */
export const FOCUS_EVENTS_PATH = '/desktop-pet/focus/events'

/** The path the browser half reports its own state on. */
export const CLIENT_STATE_PATH = '/desktop-pet/client-state'

/** The event name a focus request is pushed under. */
export const FOCUS_EVENT = 'focus'

/** The event name the page receives once on attach. */
export const FOCUS_HELLO_EVENT = 'hello'

/**
 * The event name that asks the page to re-report what it is showing.
 *
 * Sent when the unread set moves, which is the one moment the Host needs an
 * answer it cannot compute. Without it, a turn finishing on the session the
 * reader is *already* looking at would leave its mark stuck until the page's
 * next heartbeat — the page has no reason of its own to speak, because neither
 * the selection nor the visibility changed.
 */
export const STATE_REQUEST_EVENT = 'state-request'

/**
 * How long a request stays offerable before it is treated as abandoned.
 *
 * Not the old thirty seconds. That number was chosen when delivery could
 * legitimately be a minute late; with push, a request that has not been
 * collected in five minutes is one the reader has moved on from — and
 * resurrecting it later would yank them into a session they clicked long ago.
 */
const FOCUS_TTL_MS = 300_000

/**
 * How often an unacknowledged request may be offered again.
 *
 * Re-offering is safe because opening a session is idempotent. The interval
 * exists so a page that is slow to answer is retried, without a loop that
 * hammers a page that is never going to answer.
 */
const REDELIVER_MS = 3_000

/**
 * A single-slot mailbox for focus requests.
 *
 * One slot, one consumer, newest wins. A queue would invite the question of
 * what to do with a request nobody collected, and the answer for a pet is
 * "nothing" — the user clicks again.
 */
export type FocusMailbox = {
  /** Leave a request; the newest one wins and any earlier one is forgotten. */
  readonly put: (sessionId: SessionId, at: number) => FocusRequest
  /**
   * The request to hand a collector right now, or `null`.
   *
   * Called by every delivery path — the push, the poll, and the retry tick — so
   * that all three share one throttle and a request is never offered twice in
   * the same window.
   */
  readonly offer: (now: number) => FocusRequest | null
  /** Confirm a session was actually opened; clears a matching request. */
  readonly ack: (sessionId: SessionId) => boolean
  /** The request still waiting, without consuming it. */
  readonly outstanding: () => FocusRequest | null
}

/**
 * Create a mailbox.
 *
 * @param ttlMs - how long an uncollected request stays offerable.
 * @param redeliverMs - how often it may be offered again.
 * @returns the mailbox.
 */
export const createFocusMailbox = (
  ttlMs = FOCUS_TTL_MS,
  redeliverMs = REDELIVER_MS,
): FocusMailbox => {
  let pending: FocusRequest | null = null
  let offeredAt = 0
  return {
    put: (sessionId, at) => {
      pending = { sessionId, at }
      offeredAt = 0
      return pending
    },
    offer: (now) => {
      if (pending === null) return null
      if (now - pending.at > ttlMs) {
        pending = null
        return null
      }
      if (offeredAt !== 0 && now - offeredAt < redeliverMs) return null
      offeredAt = now
      return pending
    },
    ack: (sessionId) => {
      if (pending === null || pending.sessionId !== sessionId) return false
      pending = null
      offeredAt = 0
      return true
    },
    outstanding: () => pending,
  }
}

/**
 * The push side: every DSH page currently attached, and the two things worth
 * saying to one.
 *
 * Named for the page rather than for focus, because it carries both directions
 * of the conversation the Host cannot have any other way: a request *to* the
 * page, and a request *for* the page's own state.
 */
export type ClientChannel = {
  /** Start pushing to one attached page. */
  readonly attach: (collector: WebResponse) => void
  /** Stop pushing to one page; idempotent, because a close and an error race. */
  readonly detach: (collector: WebResponse) => void
  /** Hand a focus request to every attached page. */
  readonly publish: (request: FocusRequest) => void
  /** Ask every attached page to report what it is showing. */
  readonly requestState: () => void
  /** Keep every attached page's stream from idling out. */
  readonly keepAlive: () => void
  /** How many pages are attached; zero means the push has nowhere to go. */
  readonly collectors: () => number
  /** End every attached stream. */
  readonly close: () => void
}

/**
 * Create the push channel.
 *
 * Deliberately dumb: it fans one frame out to whoever is listening and forgets
 * them when they go. Whether a request *should* be re-sent is the mailbox's
 * decision, and whether the page should be asked to speak is the runtime's, so
 * there is exactly one place that answers each question.
 *
 * @returns the channel.
 */
export const createClientChannel = (): ClientChannel => {
  const collectors = new Set<WebResponse>()
  const send = (collector: WebResponse, chunk: string): void => {
    try {
      collector.write(chunk)
    } catch {
      collectors.delete(collector)
    }
  }
  const broadcast = (chunk: string): void => {
    for (const collector of collectors) send(collector, chunk)
  }
  return {
    attach: (collector) => {
      collectors.add(collector)
    },
    detach: (collector) => {
      collectors.delete(collector)
    },
    publish: (request) => {
      broadcast(sseFrame(FOCUS_EVENT, encodeJson(request)))
    },
    requestState: () => {
      broadcast(sseFrame(STATE_REQUEST_EVENT, '{}'))
    },
    keepAlive: () => {
      broadcast(sseComment('keep-alive'))
    },
    collectors: () => collectors.size,
    close: () => {
      for (const collector of collectors) {
        try {
          collector.end()
        } catch {
          // The page is already gone; nothing to end.
        }
      }
      collectors.clear()
    },
  }
}

/** What the routes need from the runtime that owns them. */
export type FocusRoutesOptions = {
  readonly mailbox: FocusMailbox
  readonly channel: ClientChannel
  /** Land one report from the DSH page. */
  readonly onClientState: (state: ClientState) => void
}

/**
 * Register the three routes the DSH page uses.
 *
 * All three live on the DSH web server rather than the pet's bridge, because
 * the page is served from that origin: same-origin means no CORS preflight, no
 * token to distribute, and no way for the page to need to discover a port.
 *
 * @param webServer - the browser HTTP carrier.
 * @param options - the mailbox, the push channel, and the state sink.
 * @returns the registration's disposer.
 */
export const registerFocusRoutes = (
  webServer: WebServerFace,
  options: FocusRoutesOptions,
): readonly Disposable[] => {
  const disposers: Disposable[] = []

  // The fallback poll. Kept after push was added: a page whose stream died —
  // a Host restart, a dropped connection — should still be able to collect.
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: FOCUS_PATH,
      handler: (_request, response) => {
        const request = options.mailbox.offer(Date.now())
        replyJson(response, 200, { sessionId: request?.sessionId ?? null, at: request?.at ?? null })
      },
    }),
  )

  // The push. Headers go out immediately, and the outstanding request — if the
  // page is attaching *after* a click — is sent at once rather than waiting for
  // the next retry.
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: FOCUS_EVENTS_PATH,
      handler: (request, response) => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        response.flushHeaders()
        options.channel.attach(response)
        response.write(sseFrame(FOCUS_HELLO_EVENT, '{}'))
        const outstanding = options.mailbox.offer(Date.now())
        if (outstanding !== null) {
          response.write(sseFrame(FOCUS_EVENT, encodeJson(outstanding)))
        }
        request.on('close', () => {
          options.channel.detach(response)
        })
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: CLIENT_STATE_PATH,
      handler: (request, response) => {
        if ((request.method ?? 'GET').toUpperCase() !== 'PUT') {
          replyJson(response, 405, { error: 'method-not-allowed' })
          return
        }
        void (async () => {
          let state: ClientState | null
          try {
            state = decodeClientState(await readJson(request), Date.now())
          } catch {
            state = null
          }
          if (state === null) {
            replyJson(response, 400, { error: 'bad-request' })
            return
          }
          options.onClientState(state)
          replyJson(response, 200, { ok: true })
        })()
      },
    }),
  )

  return disposers
}
