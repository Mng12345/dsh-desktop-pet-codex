/**
 * Domain vocabulary for the pet's session roster.
 *
 * Every type here is plain, readonly data: no classes, no methods, no hidden
 * state. The reducer and the derivations in this directory are total functions
 * over these values, so the whole core can be reasoned about (and tested)
 * without a Harness, a clock, or a socket.
 *
 * @module core/types
 */
/** The cursor before any frame has been accepted. */
export const IDLE_CURSOR = { attemptId: null, revision: 0, nextIndex: 0 };
//# sourceMappingURL=types.js.map