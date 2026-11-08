/** Execute the shipped browser half with controlled selection and clock events. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const reports = [], selectionListeners = new Set(), panelListeners = new Set(), visibilityListeners = new Set(), timers = new Map()
const slotRegistrations = []
let selected = 'a', activePanelId = null, clock = 100, plugin, cleanup, source, nextTimer = 0, mode = 'normal', openCalls = 0
/** The browser module table, reduced to the one module this half imports. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useCallback: (callback) => callback,
  useEffect: () => undefined,
}
const requireModule = (id) => {
  if (id === 'react') return React
  throw new Error(`unexpected module: ${id}`)
}
const document = { visibilityState: 'visible', addEventListener(name, listener) { visibilityListeners.add(listener) }, removeEventListener(name, listener) { visibilityListeners.delete(listener) } }
const select = (id) => { selected = id; for (const listener of selectionListeners) listener() }
const panel = (id) => { activePanelId = id; for (const listener of panelListeners) listener() }
class Source {
  constructor() { this.listeners = new Map(); source = this }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  dispatch(name, body) { this.listeners.get(name)?.({ data: JSON.stringify(body) }) }
  close() { this.closed = true }
}
const context = vm.createContext({
  window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(requireModule) } } }, document,
  crypto: { randomUUID: () => 'test-page' }, EventSource: Source,
  Date: class extends Date { static now() { return clock } },
  fetch: async (path, options) => {
    if (path === '/desktop-pet/client-state') reports.push(JSON.parse(options.body))
    return { ok: true, async json() { return { sessionId: null, at: null } } }
  },
  setInterval(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id },
  clearInterval(id) { timers.delete(id) },
})
vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context)
plugin.apply({
  layout: { panelInfo: { getSnapshot: () => ({ activePanelId }), subscribe(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener) } } },
  uiWorkspace: {
    selection: { getSnapshot: () => ({ sessionId: selected }), subscribe(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener) } },
    openSession(id) {
      openCalls += 1
      if (mode === 'failure') throw new Error('unavailable')
      if (mode === 'delayed') return
      select(id)
      panel(null)
    },
  },
  effect(setup) { cleanup = setup() },
  slots: {
    inject(name, callback) { callback(); return () => {} },
    register(options) { slotRegistrations.push(options); return () => {} },
  },
})
// Serialized rather than deep-compared: the registrations are built inside the
// vm realm, so their prototypes are not this one's.
assert.equal(
  JSON.stringify(slotRegistrations.map((entry) => `${entry.name}|${entry.id ?? entry.key ?? ''}`).sort()),
  JSON.stringify([
    'plugins.item|dsh-desktop-pet',
    'plugins.row.config|dsh-desktop-pet-codex#desktop-pet-codex',
  ]),
  'the switch registers on the plugin card and on the row page',
)
console.log('PASS the pet switch registers on the plugin card and the row Configure page')
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const last = () => reports.at(-1)
await flush()
assert.equal(last().sessionId, 'a')
assert.equal(last().enteredAt, null, 'mount does not mean a new visit')
clock = 200
source.dispatch('state-request', {})
for (const timer of timers.values()) if (timer.ms === 30000) timer.callback()
await flush()
assert.equal(last().enteredAt, null)
console.log('PASS mount, state request and heartbeat do not manufacture review events')
clock = 300; select('b'); await flush()
assert.equal(last().enteredAt, 300)
clock = 400; source.dispatch('state-request', {}); await flush()
assert.equal(last().enteredAt, 300, 'heartbeat carries original entry timestamp')
console.log('PASS real selection changes stamp entry once and repeated state retains original time')
clock = 500
source.dispatch('focus', { sessionId: 'b', at: 499 }); await flush()
assert.equal(last().sessionId, 'b')
assert.equal(last().focusAt, 499)
assert.equal(last().enteredAt, 300)
assert.equal(openCalls, 1)
console.log('PASS clicking the already selected completed row really opens and confirms the focus request')
clock = 520; panel('settings'); await flush()
assert.equal(last().sessionId, null, 'selected conversation behind Settings is not displayed')
clock = 530; panel(null); await flush()
assert.equal(last().sessionId, 'b'); assert.equal(last().enteredAt, 530)
console.log('PASS natural return from Settings into the same selected conversation is a new entry')
clock = 540; panel('settings'); await flush()
source.dispatch('focus', { sessionId: 'b', at: 539 }); await flush()
assert.equal(activePanelId, null); assert.equal(last().sessionId, 'b'); assert.equal(last().focusAt, 539)
console.log('PASS pet click on same selected ID reveals actual conversation from another panel')
mode = 'failure'; clock = 550
source.dispatch('focus', { sessionId: 'b', at: 549 }); await flush()
assert.notEqual(last().focusAt, 549)
console.log('PASS rejected openSession cannot confirm even when requested ID was already selected')
mode = 'failure'; clock = 600
source.dispatch('focus', { sessionId: 'missing', at: 599 }); await flush()
assert.equal(last().sessionId, 'b')
assert.notEqual(last().focusAt, 599)
console.log('PASS failed navigation never claims the requested session was selected')
mode = 'delayed'; clock = 700
source.dispatch('focus', { sessionId: 'c', at: 699 }); await flush()
assert.equal(last().sessionId, 'b')
assert.notEqual(last().focusAt, 699)
clock = 710; select('c'); await flush()
assert.equal(last().sessionId, 'c'); assert.equal(last().focusAt, 699)
console.log('PASS asynchronous session switches confirm only after actual selection')
document.visibilityState = 'hidden'; clock = 800
for (const listener of visibilityListeners) listener()
await flush()
assert.equal(last().visible, false)
document.visibilityState = 'visible'; clock = 900
for (const listener of visibilityListeners) listener()
await flush()
assert.equal(last().visible, true); assert.equal(last().enteredAt, 710); assert.equal(last().focusAt, 699)
console.log('PASS visibility changes preserve original entry and completed focus confirmation')
for (let i = 1; i < reports.length; i++) assert(reports[i].sequence > reports[i - 1].sequence)
cleanup(); assert.equal(timers.size, 0); assert.equal(selectionListeners.size, 0); assert.equal(panelListeners.size, 0); assert(source.closed)
console.log('PASS reports have ordered sequence numbers and browser resources are disposed')
