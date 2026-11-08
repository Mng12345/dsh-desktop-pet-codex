/**
 * The two HTTP helpers every DSH-page route shares.
 *
 * Both route modules answer a page served from this same origin, so they need
 * exactly the same two things: read a JSON body that may legitimately be empty,
 * and answer with JSON without ever leaving a socket hanging.
 *
 * @module host/http
 */
import { encodeJson } from '../core/wire.js';
/**
 * Read a JSON body, tolerating an empty one.
 *
 * @param request - the incoming request.
 * @returns the decoded body, or `{}` when there was nothing to read.
 */
export const readJson = async (request) => {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    }
    const text = chunks.join('').trim();
    return text === '' ? {} : JSON.parse(text);
};
/**
 * Answer with JSON, and never leave a socket hanging.
 *
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param body - the JSON-serializable body.
 */
export const replyJson = (response, status, body) => {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(encodeJson(body));
};
//# sourceMappingURL=http.js.map