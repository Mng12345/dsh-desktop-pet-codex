/**
 * Wire encoding: snapshots and server-sent events as strings.
 *
 * Encoding is a pure function of its input, so it is trivially testable and
 * carries no knowledge of sockets. The bridge owns the socket; this module
 * owns the bytes.
 *
 * @module core/wire
 */
import type { PetSnapshot } from './types.js';
/** The event name the pet window subscribes to for roster updates. */
export declare const SNAPSHOT_EVENT = "snapshot";
/** The event name sent once when a subscriber attaches, before any update. */
export declare const HELLO_EVENT = "hello";
/**
 * Serialize a snapshot.
 *
 * @param snapshot - the value to send.
 * @returns compact JSON, without a trailing newline.
 */
export declare const encodeSnapshot: (snapshot: PetSnapshot) => string;
/**
 * Frame one server-sent event.
 *
 * @param event - the event name subscribers match on.
 * @param data - a single-line payload; embedded newlines are escaped by JSON.
 * @returns a complete `text/event-stream` frame.
 */
export declare const sseFrame: (event: string, data: string) => string;
/**
 * Frame a comment, used as a keep-alive so intermediaries do not idle out.
 *
 * @param text - the comment body; must not contain a newline.
 * @returns a complete `text/event-stream` comment frame.
 */
export declare const sseComment: (text: string) => string;
/**
 * Encode a JSON response body.
 *
 * @param value - any JSON-serializable value.
 * @returns compact JSON.
 */
export declare const encodeJson: (value: unknown) => string;
