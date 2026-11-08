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
import type { RegistryEvent } from '../core/registry.js';
import type { SessionId } from '../core/types.js';
import type { Disposable, HostContext } from './context.js';
/** Where adapted facts go. */
export type Sink = (event: RegistryEvent) => void;
/**
 * Where "a conversation was started" goes.
 *
 * A separate channel rather than a registry event, because it is a routing fact
 * and not a roster fact: it decides whether a session's *facts* should exist at
 * all, which is a question the reducer has no business answering.
 */
export type TurnSink = (id: SessionId) => void;
/**
 * Subscribe every source this plugin reads.
 *
 * @param ctx - the plugin's Host context.
 * @param sink - the reducer's input.
 * @param onTurnStarted - the watched set's entry condition.
 * @returns one disposer per registration, in subscription order.
 */
export declare const subscribeSources: (ctx: HostContext, sink: Sink, onTurnStarted: TurnSink) => readonly Disposable[];
