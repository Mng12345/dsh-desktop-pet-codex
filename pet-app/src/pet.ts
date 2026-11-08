/**
 * The character window: the pet itself, and nothing else.
 *
 * It draws pose frames and nothing more — no card, no border, no text. Where the
 * window sits, how big it is and which of its pixels accept a click all belong
 * to the Rust half; this module decides which pose is playing and what a click
 * on her means.
 *
 * @module pet
 */

import { connect, type BridgeStatus } from './bridge.js'
import { installContextMenu } from './context-menu.js'
import {
  createFramePlayer,
  DOZE_AFTER_MS,
  preloadFrames,
  sceneFor,
  type FramePlayer,
} from './pet-frames.js'
import { dominantPhase, type PetSettings, type PetSnapshot, type SessionPhase } from './state.js'
import {
  endpoint,
  isHosted,
  savePosition,
  setAlwaysOnTop,
  setHitRect,
  setSize,
  setVisible,
  startDrag,
} from './tauri.js'

/**
 * Where the figure sits inside a square pose frame, as a fraction of the image.
 *
 * The frames are 256x256 and the character occupies the middle column of them,
 * so the window is mostly transparent. These bounds are the extremes across all
 * twelve poses (the cheer is the widest, the hop the shortest), which is what
 * the click-through test needs: a rectangle that covers her in every pose, and
 * as little else as possible.
 */
const FIGURE = { left: 66 / 256, right: 197 / 256, top: 0, bottom: 254 / 256 }

/** Transparent margin around the sprite, so the drift and the hop are not clipped. */
const PADDING = 12

/** Guards the hover reaction against a cursor drifting across the pet. */
const HEART_COOLDOWN_MS = 6_000

const pet = document.getElementById('pet')
const petImage = document.getElementById('pet-image')

if (pet === null || !(petImage instanceof HTMLImageElement)) {
  throw new Error('desktop pet: the character window shell is incomplete')
}

preloadFrames()
const player: FramePlayer = createFramePlayer(petImage)

// --- frame and input mechanics ---------------------------------------------

/** What the Rust half has already been told, so nothing is re-sent needlessly. */
let frame = { width: 0, height: 0 }
let hit = { x: -1, y: -1, width: 0, height: 0 }
let appliedScale: number | null = null
/** The context menu's box while it is open; `null` when it is not. */
let menuBox: DOMRect | null = null

/**
 * The rectangle this window accepts clicks in.
 *
 * The figure's own column, plus the context menu while it is open — the menu is
 * drawn beside her, which is exactly where the window is transparent, so without
 * the union its own buttons would be click-through.
 */
const solidArea = (): { x: number; y: number; width: number; height: number } => {
  const art = petImage.getBoundingClientRect()
  const figure = {
    x: art.left + art.width * FIGURE.left,
    y: art.top + art.height * FIGURE.top,
    width: art.width * (FIGURE.right - FIGURE.left),
    height: art.height * (FIGURE.bottom - FIGURE.top),
  }
  if (menuBox === null) return figure
  const left = Math.min(figure.x, menuBox.left)
  const top = Math.min(figure.y, menuBox.top)
  const right = Math.max(figure.x + figure.width, menuBox.right)
  const bottom = Math.max(figure.y + figure.height, menuBox.bottom)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Resize the window to the sprite, and declare which part of it is solid.
 *
 * The frame is transparent, so an oversized window is invisible but would still
 * swallow clicks in its margin; sizing it to the artwork is what keeps the pet's
 * footprint honest. Inside that size, only the figure is solid — the empty
 * columns either side of her belong to the desktop.
 */
const syncFrame = (): void => {
  const box = pet.getBoundingClientRect()
  const width = Math.ceil(box.width)
  const height = Math.ceil(box.height)
  if (width !== frame.width || height !== frame.height) {
    frame = { width, height }
    void setSize(width, height).catch(() => {})
  }

  const nextHit = solidArea()
  if (
    Math.abs(nextHit.x - hit.x) < 0.5 &&
    Math.abs(nextHit.y - hit.y) < 0.5 &&
    Math.abs(nextHit.width - hit.width) < 0.5 &&
    Math.abs(nextHit.height - hit.height) < 0.5
  ) {
    return
  }
  hit = nextHit
  void setHitRect(nextHit).catch(() => {})
}

installContextMenu({
  onOpen: (box) => {
    menuBox = box
    syncFrame()
  },
  onClose: () => {
    menuBox = null
    syncFrame()
  },
})

/**
 * Apply the appearance settings this window cares about.
 *
 * Only the scale: the roster window owns the text, the panel's opacity and the
 * pair's visibility, and applying those twice would just be two windows racing
 * to send the same command.
 */
const applyScale = (settings: PetSettings): void => {
  if (appliedScale === settings.scale) return
  appliedScale = settings.scale
  document.body.style.setProperty('--scale', String(settings.scale))
  syncFrame()
}

let dragPoll: number | undefined

const stopDragPoll = (): void => {
  if (dragPoll !== undefined) {
    window.clearInterval(dragPoll)
    dragPoll = undefined
  }
}

/**
 * Drag the pair natively.
 *
 * The native drag loop swallows the pointerup that ends it, so the position is
 * polled while a drag is believed to be in flight and saved once more when the
 * pointer is released — whichever arrives first wins. Dragging the character
 * moves the roster too: the Rust half re-hangs it from this window's position.
 */
const beginDrag = (): void => {
  void savePosition().catch(() => {})
  void startDrag()
    .then(() => {
      stopDragPoll()
      dragPoll = window.setInterval(() => {
        void savePosition().catch(() => {})
      }, 350)
      window.setTimeout(stopDragPoll, 15_000)
    })
    .catch(() => {})
}

// --- the scene --------------------------------------------------------------

/** When the roster last went quiet, or 0 while something is happening. */
let idleSince = 0
/** The phase the last snapshot asked for, so the doze timer can re-read it. */
let lastPhase: SessionPhase | null = null
/** Whether this quiet spell has already been interrupted by a nap. */
let dozed = false

/**
 * Remember how long the roster has been empty, and play what that asks for.
 *
 * `null` is the quiet state, and an empty roster is the only way to reach it: a
 * row always carries one of the four phases, so a roster with results still on
 * it keeps her face on those results.
 */
const notePhase = (phase: SessionPhase | null): void => {
  lastPhase = phase
  if (phase === null) {
    if (idleSince === 0) idleSince = Date.now()
  } else {
    idleSince = 0
    dozed = false
  }
  player.play(phase === null ? 'idle' : sceneFor(phase))

  // The nap is time-driven, not snapshot-driven: an empty roster publishes
  // nothing, so no snapshot would ever arrive to put her to sleep. It plays once
  // per quiet spell, and running off its end leaves the idle scene looping.
  if (phase === null && !dozed && Date.now() - idleSince >= DOZE_AFTER_MS) {
    dozed = true
    player.playSegment('doze')
  }
}

// Dozing is the only thing that needs a clock of its own — everything else
// arrives with a snapshot.
window.setInterval(() => {
  notePhase(lastPhase)
}, 5_000)

// --- the bridge -------------------------------------------------------------

/** Paint one snapshot. */
const render = (snapshot: PetSnapshot): void => {
  applyScale(snapshot.settings)
  const phase = dominantPhase(snapshot)
  // `idle` is a look, not a phase: the CSS and the frame tables keep the word for
  // the quiet pose, and `null` from the mood is what selects it.
  document.body.dataset['phase'] = phase ?? 'idle'
  document.body.dataset['connected'] = 'true'
  notePhase(phase)
  syncFrame()
}

/** Paint the connection state, leaving the last pose playing while it retries. */
const applyStatus = (status: BridgeStatus): void => {
  document.body.dataset['connected'] = status === 'live' ? 'true' : 'false'
}

// --- input ------------------------------------------------------------------

let heartAt = 0

pet.addEventListener('pointerenter', () => {
  if (Date.now() - heartAt < HEART_COOLDOWN_MS) return
  heartAt = Date.now()
  player.playSegment('heart')
})

petImage.addEventListener('click', () => {
  player.playSegment('wave')
})

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (event.target instanceof Element && event.target.closest('#menu') !== null) return
  beginDrag()
})

window.addEventListener('pointerup', () => {
  void savePosition().catch(() => {})
  stopDragPoll()
})

// --- boot -------------------------------------------------------------------

const boot = async (): Promise<void> => {
  syncFrame()
  new ResizeObserver(syncFrame).observe(pet)

  if (!isHosted()) {
    applyStatus('offline')
    return
  }
  try {
    const target = await endpoint()
    if (target.url.length === 0) {
      applyStatus('offline')
      return
    }
    connect({ endpoint: target, onSnapshot: render, onStatus: applyStatus })
  } catch {
    applyStatus('offline')
  }
}

void boot()
