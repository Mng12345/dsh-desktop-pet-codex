/**
 * The settings window.
 *
 * It is the only writer of the appearance settings, and it writes them through
 * the bridge. Two decisions shape everything below:
 *
 *  - **The Host answers with the value in force, not an acknowledgement.** It
 *    clamps, so a slider can come back different from what was dragged. Every
 *    write therefore re-renders from the response, and the controls show what
 *    actually took effect rather than what was asked for.
 *  - **Dragging is coalesced, not debounced to the end.** A slider fires on
 *    every pixel; the pet should follow the drag rather than jump when it is
 *    released, but a write per pixel would be absurd. So writes are throttled
 *    to one in flight per interval, with the last value always sent.
 *
 * @module settings
 */

import { readSettings, writeSettings } from './bridge.js'
import { DEFAULT_SETTINGS, decodeSettings, type PetSettings } from './state.js'
import { closeSettings, endpoint, isHosted } from './tauri.js'

/** How long a burst of slider input waits before one write goes out. */
const WRITE_INTERVAL_MS = 90

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`desktop pet: settings page is missing #${id}`)
  return found as T
}

const status = element<HTMLParagraphElement>('status')
const scale = element<HTMLInputElement>('scale')
const fontScale = element<HTMLInputElement>('fontScale')
const opacity = element<HTMLInputElement>('opacity')
const visible = element<HTMLInputElement>('visible')
const showSessionList = element<HTMLInputElement>('showSessionList')
const alwaysOnTop = element<HTMLInputElement>('alwaysOnTop')

const outputs = {
  scale: element<HTMLOutputElement>('scale-value'),
  fontScale: element<HTMLOutputElement>('fontScale-value'),
  opacity: element<HTMLOutputElement>('opacity-value'),
}

const num = (input: HTMLInputElement): number => Number(input.value)

/** Paint every control from one settings value. */
const render = (settings: PetSettings): void => {
  scale.value = String(settings.scale)
  fontScale.value = String(settings.fontScale)
  opacity.value = String(settings.opacity)
  visible.checked = settings.visible
  showSessionList.checked = settings.showSessionList
  alwaysOnTop.checked = settings.alwaysOnTop
  outputs.scale.textContent = `${settings.scale.toFixed(2)}×`
  outputs.fontScale.textContent = `${settings.fontScale.toFixed(2)}×`
  outputs.opacity.textContent = settings.opacity.toFixed(2)
}

/** The settings the controls currently describe. */
const current = (): PetSettings => ({
  scale: num(scale),
  fontScale: num(fontScale),
  opacity: num(opacity),
  visible: visible.checked,
  showSessionList: showSessionList.checked,
  alwaysOnTop: alwaysOnTop.checked,
})

// --- the write path --------------------------------------------------------

/** Where to write, resolved once at boot. */
let target: Awaited<ReturnType<typeof endpoint>> | null = null
let pending: PetSettings | null = null
let inFlight = false

/**
 * Send the newest settings, at most one write per interval.
 *
 * The last value always goes out: a drag that ends while a write is in flight
 * would otherwise settle on a stale intermediate value.
 */
const flush = async (): Promise<void> => {
  if (inFlight || pending === null || target === null) return
  const next = pending
  pending = null
  inFlight = true
  const answer = await writeSettings(target, { ...next })
  inFlight = false
  if (answer === null) {
    status.dataset['state'] = 'offline'
    status.textContent = '写入失败，改动可能没有保存'
  } else {
    // Re-render from the answer: the Host clamps, so this is what took effect.
    render(decodeSettings(answer))
    status.dataset['state'] = 'live'
    status.textContent = '已连接 DSH'
  }
  if (pending !== null) void flush()
}

let timer: number | undefined

/** Queue a write, coalescing a burst into one. */
const queue = (): void => {
  pending = current()
  render(pending)
  if (timer !== undefined) return
  timer = window.setInterval(() => {
    if (pending === null && !inFlight) {
      window.clearInterval(timer)
      timer = undefined
      return
    }
    void flush()
  }, WRITE_INTERVAL_MS)
}

// --- wiring ----------------------------------------------------------------

for (const control of [scale, fontScale, opacity]) {
  control.addEventListener('input', queue)
}
for (const control of [visible, showSessionList, alwaysOnTop]) {
  control.addEventListener('change', queue)
}

element<HTMLButtonElement>('reset').addEventListener('click', () => {
  render(DEFAULT_SETTINGS)
  queue()
})

element<HTMLButtonElement>('close').addEventListener('click', () => {
  void closeSettings().catch(() => {})
})

// --- boot ------------------------------------------------------------------

const boot = async (): Promise<void> => {
  if (!isHosted()) {
    status.dataset['state'] = 'offline'
    status.textContent = '未在桌宠窗口中运行'
    return
  }
  try {
    target = await endpoint()
  } catch {
    status.dataset['state'] = 'offline'
    status.textContent = '无法获取桥接地址'
    return
  }
  if (target.url.length === 0) {
    status.dataset['state'] = 'offline'
    status.textContent = 'DSH 未在运行'
    return
  }
  const answer = await readSettings(target)
  if (answer === null) {
    status.dataset['state'] = 'offline'
    status.textContent = '读取设置失败；显示的是默认值'
    render(DEFAULT_SETTINGS)
    return
  }
  render(decodeSettings(answer))
  status.dataset['state'] = 'live'
  status.textContent = '已连接 DSH'
}

void boot()
