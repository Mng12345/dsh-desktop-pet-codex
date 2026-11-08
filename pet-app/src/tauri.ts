/**
 * The Tauri command surface, declared structurally.
 *
 * The frontend has no npm dependencies — `withGlobalTauri` puts the invoke
 * bridge on `window` — so the few commands this window calls are described
 * here rather than imported. Anything the Rust half does not expose is not
 * reachable from this module, which is the point.
 *
 * @module tauri
 */

/** Where the Host half is listening. */
export type Endpoint = {
  readonly url: string
  readonly token: string | null
}

/** The interactive area inside the window, in logical pixels. */
export type HitRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

declare global {
  interface Window {
    readonly __TAURI__?: {
      readonly core?: { readonly invoke?: Invoke }
    }
  }
}

/** Invoke a Rust command, failing loudly when the bridge is absent. */
const invoke: Invoke = async (command, args) => {
  const call = window.__TAURI__?.core?.invoke
  if (call === undefined) throw new Error(`tauri invoke bridge unavailable (${command})`)
  return call(command, args)
}

/** Whether this page is running inside the Tauri window. */
export const isHosted = (): boolean => window.__TAURI__?.core?.invoke !== undefined

/** Read the endpoint this window was started with. */
export const endpoint = (): Promise<Endpoint> => invoke<Endpoint>('pet_endpoint')

/** Declare the interactive area, or `null` to stay fully click-through. */
export const setHitRect = (rect: HitRect | null): Promise<void> =>
  invoke<void>('pet_set_hit_rect', { rect })

/** Start a native window drag. */
export const startDrag = (): Promise<void> => invoke<void>('pet_start_drag')

/** Resize the character window to its measured size, in logical pixels. */
export const setSize = (width: number, height: number): Promise<void> =>
  invoke<void>('pet_set_size', { width, height })

/**
 * Resize the roster window to its measured size, in logical pixels.
 *
 * Separate from `setSize` because the roster's bottom edge is the anchor: the
 * Rust half re-hangs the window in the same call, so folding never shows the
 * list growing down over the pet for a frame.
 */
export const setRosterSize = (width: number, height: number): Promise<void> =>
  invoke<void>('roster_set_size', { width, height })

/** Keep both windows above other windows, or let them fall behind together. */
export const setAlwaysOnTop = (enabled: boolean): Promise<void> =>
  invoke<void>('pet_set_always_on_top', { enabled })

/**
 * Show or hide the pair, keeping the process alive.
 *
 * Hiding is not quitting: the bridge keeps streaming, so flipping the setting
 * back shows current data with nothing to rebuild.
 */
export const setVisible = (visible: boolean): Promise<void> =>
  invoke<void>('pet_set_visible', { visible })

/** Remember where the pair was left; the roster's place is derived from it. */
export const savePosition = (): Promise<void> => invoke<void>('pet_save_position')

/**
 * Show or hide the roster window by itself.
 *
 * `setVisible` is a command for the pair; this is the "just the pet" case of
 * `showSessionList: false`, which is now literally this window not being there.
 */
export const setRosterShown = (shown: boolean): Promise<void> =>
  invoke<void>('roster_set_shown', { shown })

/** Open the settings window, showing and focusing it. */
export const openSettings = (): Promise<void> => invoke<void>('pet_open_settings')

/** Hide the settings window without ending the process. */
export const closeSettings = (): Promise<void> => invoke<void>('pet_close_settings')

/**
 * How a request to bring the DSH window forward ended.
 *
 * `alreadyFront` and `raised` are both successes the reader should not hear
 * about; `notFound` and `refused` are the two that mean the window did not
 * come forward.
 */
export type FocusStatus = 'alreadyFront' | 'raised' | 'notFound' | 'refused'

/** The outcome of one raise attempt, with the reason the Rust half logged. */
export type FocusOutcome = {
  readonly status: FocusStatus
  readonly reason: string
  /** The process holding the foreground when a raise was refused, if any. */
  readonly foreground?: string
}

/** The statuses that mean the window is now in front. */
const FRONT: readonly FocusStatus[] = ['alreadyFront', 'raised']

/** Whether an outcome means the DSH window is in front. */
export const isFront = (outcome: FocusOutcome): boolean => FRONT.includes(outcome.status)

/**
 * Bring the DSH desktop window to the front.
 *
 * This is the pet's job and nobody else's: the Host half is a separate Node
 * process with no reach into the Electron shell, while the pet is an ordinary
 * Windows application that can raise another one's window.
 *
 * @returns how the attempt ended — see {@link FocusOutcome}.
 */
export const focusApp = (): Promise<FocusOutcome> => invoke<FocusOutcome>('pet_focus_app')
