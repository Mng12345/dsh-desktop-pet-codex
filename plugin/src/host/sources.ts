/**
 * Event adapters: Harness emissions in, roster events out.
 *
 * Every listener here is a translation, not a decision: it decodes an untrusted
 * payload and hands the reducer one fact. Existence comes only from the
 * `api-session/*` family (the Host's own list-level feed); `session/event`
 * supplies refinements — approvals, tools, turn outcomes — for sessions that
 * already exist.
 *
 * @module host/sources
 */

import {
  decodeSessionEvent,
  decodeSessionId,
  decodeStreamFrame,
  decodeSummary,
} from '../core/decode.js'
import type { RegistryEvent } from '../core/registry.js'
import type { SessionId } from '../core/types.js'
import type { Disposable, HostContext } from './context.js'

/** Where adapted facts go. */
export type Sink = (event: RegistryEvent) => void

/**
 * Where "a conversation was started" goes.
 *
 * A separate channel rather than a registry event, because it is a routing fact
 * and not a roster fact: it decides whether a session's *facts* should exist at
 * all, which is a question the reducer has no business answering.
 */
export type TurnSink = (id: SessionId) => void

/**
 * Subscribe every source this plugin reads.
 *
 * @param ctx - the plugin's Host context.
 * @param sink - the reducer's input.
 * @param onTurnStarted - the watched set's entry condition.
 * @returns one disposer per registration, in subscription order.
 */
export const subscribeSources = (
  ctx: HostContext,
  sink: Sink,
  onTurnStarted: TurnSink,
): readonly Disposable[] => {
  const disposers: Disposable[] = []

  const listen = (
    event: string,
    listener: (...args: readonly unknown[]) => void,
    global = false,
  ): void => {
    disposers.push(ctx.on(event, listener, global ? { global: true } : undefined))
  }

  listen('api-session/added', (summary) => {
    const decoded = decodeSummary(summary)
    if (decoded !== null) sink({ kind: 'upsert', summary: decoded })
  })

  listen('api-session/removed', (sessionId) => {
    const id = decodeSessionId(undefined, sessionId)
    if (id !== null) sink({ kind: 'remove', id })
  })

  listen('api-session/status', (sessionId, running) => {
    const id = decodeSessionId(undefined, sessionId)
    if (id !== null && typeof running === 'boolean') {
      sink({ kind: 'running', id, running })
    }
  })

  listen('api-session/activity', (sessionId, updatedAt) => {
    const id = decodeSessionId(undefined, sessionId)
    if (id !== null && typeof updatedAt === 'number') {
      sink({ kind: 'activity', id, updatedAt })
    }
  })

  listen('api-session/error', (sessionId, message) => {
    const id = decodeSessionId(undefined, sessionId)
    if (id !== null && typeof message === 'string') {
      sink({ kind: 'error', id, message, at: Date.now() })
    }
  })

  // Session-scoped: `{ global: true }` is what lets one listener observe every
  // session's log rather than only this plugin's own scope.
  listen(
    'session/event',
    (session, event) => {
      const id = decodeSessionId(session)
      if (id === null) return
      const fact = decodeSessionEvent(event)
      if (fact === null) return
      switch (fact.kind) {
        case 'approval-asked':
          sink({ kind: 'pending', id, pending: fact.pending })
          return
        case 'approval-decided':
          sink({ kind: 'pending', id, pending: null })
          return
        case 'tool-started':
          sink({ kind: 'tool', id, tool: fact.tool, callId: fact.callId, blocks: fact.blocks })
          return
        case 'tool-finished':
          sink({ kind: 'tool-finished', id, callId: fact.callId })
          return
        case 'turn-started':
          onTurnStarted(id)
          sink({ kind: 'running', id, running: true, at: fact.at ?? Date.now() })
          return
        case 'title':
          // Existence is still the list's to decide: a title for a session the
          // list has never mentioned is ignored rather than inventing a row.
          sink({ kind: 'title', id, title: fact.title })
          return
        case 'turn-ended':
          sink({ kind: 'settled', id, at: fact.at, outcome: fact.outcome })
      }
    },
    true,
  )

  // The live answer itself. This is the highest-frequency source by far — it
  // fires per streamed fragment — so the sink it feeds must coalesce; see the
  // publication window in `runtime.ts`.
  listen(
    'agent/assistant-stream',
    (payload) => {
      const record = payload as { readonly agent?: unknown; readonly frame?: unknown } | null
      if (record === null || typeof record !== 'object') return
      const id = decodeSessionId(record.agent)
      if (id === null) return
      const frame = decodeStreamFrame(record.frame)
      if (frame !== null) sink({ kind: 'stream', id, frame })
    },
    true,
  )

  return disposers
}
