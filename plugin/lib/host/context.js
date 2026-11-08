/**
 * The slice of the Cordis context this plugin actually uses.
 *
 * Declared structurally rather than imported: the Harness' own type packages
 * are not installed beside this bundle (they resolve from the dsh install at
 * runtime), and a status indicator needs very little of the surface. Keeping
 * the declaration small means the plugin cannot quietly start depending on
 * Host internals — anything new must be added here first, on purpose.
 *
 * @module host/context
 */
export {};
//# sourceMappingURL=context.js.map