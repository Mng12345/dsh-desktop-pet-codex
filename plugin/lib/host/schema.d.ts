/**
 * The Host-facing `Config` schema for this plugin's row.
 *
 * Operational only: ports, tokens, whether to launch the window. Appearance is
 * owned by the settings window and stored separately, so every setting has
 * exactly one owner and no value can silently disagree with itself.
 *
 * The shapes used here are the ones the shipped plugins already use, since this
 * schema is what the Plugin Manager renders a form from.
 *
 * `@deepseek-ai/schemastery` ships with the dsh installation. A profile bundle
 * receives such a package only when its own manifest lists it as a peer
 * dependency — that is the lookup the runtime resolver performs for a linked
 * bundle, and it is why the market's own plugins declare it too — so this
 * bundle declares the peer and imports nothing else.
 *
 * The import is dynamic and guarded for one reason: a resolution miss must
 * degrade to "no configuration form" rather than to an entry that cannot be
 * imported at all. A failed import is reported as a bare `failed to import`
 * with no detail, which is the single hardest failure to diagnose from the
 * outside; losing a form is a visible, harmless alternative.
 *
 * @module host/schema
 */
/**
 * Validated at activation; rendered as the row's configuration form.
 *
 * Appearance is deliberately absent from it — right-click the pet and choose
 * 设置. See `core/settings.ts` for why the two surfaces are kept apart.
 */
export declare const Config: unknown;
