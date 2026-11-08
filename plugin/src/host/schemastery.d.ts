/**
 * Minimal ambient declaration for the Harness' bundled schema library.
 *
 * `@deepseek-ai/schemastery` ships with the dsh installation and is not an npm
 * dependency of this bundle, so its types are not installed beside this source.
 * Declaring only what this plugin calls keeps the bundle dependency-free while
 * still type-checking the `Config` schema's shape.
 *
 * The chainable helpers mirror the real builder surface; the concrete type
 * parameters are deliberately loose, because the value of this declaration is
 * catching a misspelled field or a broken chain, not modelling the library.
 *
 * @module host/schemastery
 */
declare module '@deepseek-ai/schemastery' {
  /** A schema value; the Host validates `config` against it at activation. */
  export interface Schema<T = unknown> {
    /** Validation failure message shown by the form. */
    description(text: string): Schema<T>
    /** Mark the field for a specific control (for example `slider`). */
    role(name: string, extra?: unknown): Schema<T>
    /** Value used when the row omits the field. */
    default(value: T): Schema<T>
    /** Whether the field must be present. */
    required(): Schema<T>
  }

  /** A numeric schema, which additionally accepts bounds and a step. */
  export interface NumberSchema extends Schema<number> {
    min(value: number): NumberSchema
    max(value: number): NumberSchema
    step(value: number): NumberSchema
    description(text: string): NumberSchema
    role(name: string, extra?: unknown): NumberSchema
    default(value: number): NumberSchema
  }

  interface Schemastery {
    object(shape: Record<string, unknown>): Schema<Record<string, unknown>>
    boolean(): Schema<boolean>
    number(): NumberSchema
    string(): Schema<string>
    array(inner: unknown): Schema<readonly unknown[]>
    const<T>(value: T): Schema<T>
    union(list: readonly unknown[]): Schema<unknown>
  }

  const z: Schemastery
  export default z
}
