/**
 * Pose frames: four scenes, each a series of phases that loops, plus the three
 * bits of business that belong to the idle one.
 *
 * The rework this replaces played loose poses in pairs — two independently
 * generated "typing" stills alternating, which reads as a flicker rather than a
 * keystroke. Every frame here is a *phase of one continuous motion*: `work-2` is
 * the left hand's keystroke, `wait-4` is the top of the arm's swing, `happy-4`
 * is the jump. Consecutive frames differ by one small step, and that is what
 * makes a loop read as animation.
 *
 * The frames carry the movement. `style.css` keeps only a small drift, because
 * a large transform on top of an animated series fights it.
 *
 * @module pet-frames
 */

import type { SessionPhase } from './state.js'

/** One still: the file stem under `frames/`, and how long it holds. */
export type FrameStep = {
  readonly frame: string
  readonly ms: number
}

/** A loop of stills. */
export type FrameSequence = readonly FrameStep[]

/** Terse table builder: `seq(['idle-1', 900], …)`. */
const seq = (...steps: readonly (readonly [string, number])[]): FrameSequence =>
  steps.map(([frame, ms]) => ({ frame, ms }))

/**
 * The four looping scenes.
 *
 * `idle` breathes, blinks on an uneven beat and shifts her weight — a pet that
 * blinks exactly every two seconds reads as a machine. `run` is a full stride
 * cycle drawn **in profile**, six frames at 130 ms so the legs read as a jog; a
 * stride seen head-on is a pair of knees pumping at the camera, which is why the
 * one scene that is not facing the viewer is this one. `wait` is one whole raise
 * of the arm. `happy` bounces and settles.
 */
export const SCENES = {
  idle: seq(
    ['idle-1', 900],
    ['idle-2', 900],
    ['idle-1', 700],
    ['idle-3', 130],
    ['idle-4', 150],
    ['idle-3', 130],
    ['idle-2', 500],
    ['idle-5', 700],
    ['idle-2', 400],
    ['idle-6', 700],
    ['idle-2', 400],
  ),
  run: seq(
    ['run-1', 130],
    ['run-2', 130],
    ['run-3', 130],
    ['run-4', 130],
    ['run-5', 130],
    ['run-6', 130],
  ),
  wait: seq(
    ['wait-1', 300],
    ['wait-2', 300],
    ['wait-3', 300],
    ['wait-4', 520],
    ['wait-5', 300],
    ['wait-6', 400],
  ),
  happy: seq(
    ['happy-1', 220],
    ['happy-2', 220],
    ['happy-3', 260],
    ['happy-4', 360],
    ['happy-5', 240],
    ['happy-6', 400],
  ),
} as const

/**
 * One-shot segments, played over a scene and returning to it.
 *
 * All three belong to the idle scene: a greeting when she is clicked, a heart
 * when the pointer finds her, and a nap she drifts into when nothing has
 * happened for a long while. They are segments rather than scenes because a
 * scene is a state to be in, and none of these is a state — each ends by itself.
 */
export const SEGMENTS = {
  wave: seq(
    ['wave-1', 160],
    ['wave-2', 160],
    ['wave-3', 220],
    ['wave-2', 160],
    ['wave-3', 220],
    ['wave-4', 200],
  ),
  heart: seq(['heart-1', 200], ['heart-2', 700], ['heart-3', 200]),
  doze: seq(['idle-2', 500], ['doze-1', 900], ['doze-2', 2600], ['doze-3', 500]),
} as const

/** A looping scene. */
export type Scene = keyof typeof SCENES

/** A one-shot segment of the idle scene. */
export type Segment = keyof typeof SEGMENTS

/**
 * How long the roster must sit empty before she drifts off.
 *
 * Matches the plugin row's `sleepAfterMs` default, which was reserved for
 * exactly this. The configured value is not plumbed to the window yet — that
 * crosses both halves and costs a Harness restart — so this is the default held
 * in one place until it is.
 */
export const DOZE_AFTER_MS = 300_000

/**
 * Which scene a session phase asks for.
 *
 * Four phases, three faces: `stopped` is not an emotion, so it borrows the quiet
 * one — and a subagent working already arrives as `running`, because for a pet
 * working is running on the spot.
 *
 * @param phase - the phase the roster is showing.
 * @returns the scene to loop.
 */
export const sceneFor = (phase: SessionPhase): Scene => {
  switch (phase) {
    case 'waiting':
      return 'wait'
    case 'completed':
      return 'happy'
    case 'running':
      return 'run'
    case 'stopped':
      return 'idle'
  }
}

/** Every still any scene or segment asks for, deduplicated. */
export const FRAME_FILES: readonly string[] = [
  ...new Set([
    ...Object.values(SCENES).flatMap((steps) => steps.map((step) => step.frame)),
    ...Object.values(SEGMENTS).flatMap((steps) => steps.map((step) => step.frame)),
  ]),
].sort()

/** Where a still lives, relative to the window's document. */
export const frameUrl = (frame: string): string => `frames/${frame}.png`

/** Held so the browser keeps them decoded; a dropped reference can be evicted. */
const loaded: HTMLImageElement[] = []

/**
 * Decode every still up front.
 *
 * A `src` swap to an image the browser has not decoded paints an empty frame,
 * which at 120 ms per step is a visible flicker. The whole set is about a
 * megabyte, so paying for it once at boot is cheaper than the flicker.
 */
export const preloadFrames = (): void => {
  if (loaded.length > 0) return
  for (const frame of FRAME_FILES) {
    const image = new Image()
    image.src = frameUrl(frame)
    loaded.push(image)
  }
}

/** A player bound to one image element. */
export type FramePlayer = {
  /** Loop a scene. Repeating the scene already playing restarts nothing. */
  readonly play: (scene: Scene) => void
  /** Play a segment once, then fall back to the scene that was playing. */
  readonly playSegment: (segment: Segment) => void
}

/**
 * Drive one `<img>` from the tables above.
 *
 * The queue is the only state: a segment swaps in a shorter queue, and running
 * off its end restores the scene, which is what makes a one-shot one-shot.
 *
 * @param target - the image element to keep in step.
 * @returns the player the window drives.
 */
export const createFramePlayer = (target: HTMLImageElement): FramePlayer => {
  let scene: Scene = 'idle'
  let queue: FrameSequence = SCENES.idle
  let index = 0
  let showing = ''
  let timer: number | undefined

  const show = (frame: string): void => {
    if (frame === showing) return
    showing = frame
    target.src = frameUrl(frame)
  }

  const advance = (): void => {
    if (index >= queue.length) {
      queue = SCENES[scene]
      index = 0
    }
    const step = queue[index]
    if (step === undefined) {
      // Unreachable: every table is non-empty and the index was just reset.
      return
    }
    index += 1
    show(step.frame)
    timer = window.setTimeout(advance, step.ms)
  }

  const start = (next: FrameSequence): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    queue = next
    index = 0
    advance()
  }

  // Start breathing immediately: the pet is alive while the bridge is still
  // connecting, which is exactly when a frozen sprite looks broken.
  start(SCENES.idle)

  return {
    play: (next: Scene): void => {
      // A segment owns the sprite until it finishes, so a snapshot arriving
      // mid-wave must not cut it off — only a real scene change does.
      if (next === scene) return
      scene = next
      start(SCENES[next])
    },
    playSegment: (segment: Segment): void => {
      start(SEGMENTS[segment])
    },
  }
}
