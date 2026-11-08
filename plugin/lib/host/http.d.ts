/**
 * The two HTTP helpers every DSH-page route shares.
 *
 * Both route modules answer a page served from this same origin, so they need
 * exactly the same two things: read a JSON body that may legitimately be empty,
 * and answer with JSON without ever leaving a socket hanging.
 *
 * @module host/http
 */
import type { WebRequest, WebResponse } from './context.js';
/**
 * Read a JSON body, tolerating an empty one.
 *
 * @param request - the incoming request.
 * @returns the decoded body, or `{}` when there was nothing to read.
 */
export declare const readJson: (request: WebRequest) => Promise<unknown>;
/**
 * Answer with JSON, and never leave a socket hanging.
 *
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param body - the JSON-serializable body.
 */
export declare const replyJson: (response: WebResponse, status: number, body: unknown) => void;
