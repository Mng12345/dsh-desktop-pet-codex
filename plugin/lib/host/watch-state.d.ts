import type { SessionId } from '../core/types.js';
export declare const watchFile: () => string;
/** null means a first run: import the window's legacy list once. [] is a real saved list. */
export declare const loadWatch: () => readonly SessionId[] | null;
/** Atomic replacement also records an empty list, so removal survives an immediate restart. */
export declare const saveWatch: (ids: ReadonlySet<SessionId>) => boolean;
