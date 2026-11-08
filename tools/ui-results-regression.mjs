// Run from any directory: node tools/ui-results-regression.mjs
// Executes the current TypeScript sources in memory; no release/dist writes or dependencies added.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(path.join(root, 'pet-app/package.json'))('typescript')
const src = path.join(root, 'pet-app/src')
const loadUi = (globals = {}) => {
  const context = vm.createContext({ console, ...globals })
  const cache = new Map()
  const load = (name) => {
    if (cache.has(name)) return cache.get(name).exports
    const filename = path.join(src, name.replace(/\.js$/u, '.ts'))
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: filename,
    }).outputText
    const module = { exports: {} }
    cache.set(name, module)
    const run = vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename })
    run((dependency) => load(path.posix.join(path.posix.dirname(name), dependency)), module, module.exports)
    return module.exports
  }
  return load
}
const load = loadUi()
const model = load('state.js')
const frames = load('pet-frames.js')
const phases = ['waiting', 'running', 'completed', 'stopped']
const labels = ['等你', '运行中', '已完成', '已停止']
const terminal = new Set(['completed', 'stopped'])
const session = (phase, id = phase, extra = {}) => ({
  id, title: `会话 ${id}`, label: 'project', phase, running: phase === 'running',
  isSubagent: false, subagentCount: 0,
  dismissible: terminal.has(phase) && extra.isSubagent !== true,
  lastTool: 'old-tool',
  thought: null, thoughtKind: null, updatedAt: 1, error: null, ...extra,
})
const node = (row, children = []) => ({ session: row, children })
const snapshot = (nodes, extra = {}) => ({
  version: 1, revision: 1, at: 1, settings: model.DEFAULT_SETTINGS,
  totals: { sessions: nodes.length, waiting: 0, running: 0, subagents: 0 },
  groups: [{ id: 'group', title: 'Workspace', nodes, updatedAt: 1 }],
  watch: nodes.map((entry) => entry.session.id), ...extra,
})
const equals = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected))

for (const [index, phase] of phases.entries()) {
  const row = session(phase, phase, { reviewed: true })
  const decoded = model.decodeSnapshot(snapshot([node(row)]))
  assert.equal(decoded.groups[0].nodes[0].session.phase, phase)
  assert.equal(model.phaseLabel(phase), labels[index])
  assert.equal(model.rowDetail(row), phase === 'running' ? 'old-tool' : labels[index])
  assert.equal(model.rowDetail({ ...row, lastTool: null }), labels[index])
  // The control comes from the Host's verdict, carried through the decode; the
  // window no longer guesses it from the phase.
  assert.equal(model.canDismiss(decoded.groups[0].nodes[0].session), terminal.has(phase))
  const withoutVerdict = model.decodeSnapshot(snapshot([node({ ...row, dismissible: undefined })]))
  assert.equal(
    model.canDismiss(withoutVerdict.groups[0].nodes[0].session),
    false,
    'a Host of another generation offers no control rather than a dead one',
  )
  assert.equal(frames.sceneFor(phase), phase === 'completed' ? 'happy' : phase === 'waiting' ? 'wait' : phase === 'running' ? 'run' : 'idle')
  if (terminal.has(phase)) {
    equals(model.headline(decoded), { kind: 'results', segments: [{ phase, count: 1 }] })
    assert.equal(model.groupCounts(decoded.groups[0]).includes('全部空闲'), false)
    assert.equal(model.subtitleOf(decoded).includes(labels[index]), true)
  }
}
const mixed = snapshot(phases.map((phase) => node(session(phase))))
equals(model.headline(mixed), { kind: 'waiting', count: 1 })
assert.equal(model.activeCount(mixed), 2)
assert.equal(model.groupCounts(mixed.groups[0]), '1 在等你 · 1 进行中 · 1 已完成 · 1 已停止')
assert.equal(model.subtitleOf(mixed), '共 4 个会话 · 1 在等你 · 1 进行中 · 1 已完成 · 1 已停止')
const mixedResults = snapshot([...terminal].map((phase) => node(session(phase))))
equals(model.headline(mixedResults), {
  kind: 'results',
  segments: [{ phase: 'completed', count: 1 }, { phase: 'stopped', count: 1 }],
})
assert.equal(model.dominantPhase(mixedResults), 'stopped', 'a turn that did not finish outranks one that did')
// The headline's own words, shorter than the rows' vocabulary, and the reading
// order of the segments: done, doing, stopped. A waiting session hides them all.
assert.equal(model.headlineWord('completed'), '完成')
assert.equal(model.headlineWord('running'), '进行')
assert.equal(model.headlineWord('stopped'), '停止')
equals(model.headline(snapshot([node(session('completed')), node(session('running'))])), {
  kind: 'results',
  segments: [{ phase: 'completed', count: 1 }, { phase: 'running', count: 1 }],
})
equals(model.headline(snapshot([node(session('completed')), node(session('waiting'))])), {
  kind: 'waiting',
  count: 1,
})
for (const phase of ['waiting', 'running']) {
  const active = snapshot([node(session('completed')), node(session(phase))])
  assert.equal(model.dominantPhase(active), phase)
}
// A group's dot answers "is anything live in here". Results keep their counts
// and their row colours, but they do not keep the Workspace awake.
const settledGroup = snapshot([node(session('completed')), node(session('stopped'))])
assert.equal(model.groupPhase(settledGroup.groups[0]), 'idle')
assert.equal(model.groupCounts(settledGroup.groups[0]), '1 已完成 · 1 已停止')
assert.equal(model.groupPhase(snapshot([node(session('completed')), node(session('waiting'))]).groups[0]), 'waiting')
assert.equal(model.groupPhase(snapshot([node(session('completed')), node(session('running'))]).groups[0]), 'running')
// A child's result belongs to its parent's row, so it never adds a count.
const onlyChildCompleted = snapshot([
  node(session('running'), [node(session('completed', 'child', { isSubagent: true }))]),
])
assert.equal(model.groupCounts(onlyChildCompleted.groups[0]), '1 进行中')
assert.equal(model.subtitleOf(onlyChildCompleted), '共 1 个会话 · 1 进行中')
const activeChildren = snapshot([node(session('running'), [node(session('running', 'child', { isSubagent: true }))])], {
  totals: { sessions: 1, running: 1, waiting: 0, subagents: 1 },
})
equals(model.headline(activeChildren), { kind: 'results', segments: [{ phase: 'running', count: 1 }] })
assert.equal(model.subtitleOf(activeChildren), '共 1 个会话 · 1 进行中 · 1 个子代理')
assert.equal(model.activeCount(activeChildren), 1, 'a child is not a second active conversation')
equals(model.headline(snapshot([])), { kind: 'idle' })
assert.equal(model.dominantPhase(snapshot([])), null, 'an empty roster has no mood to show')
for (const watch of [null, undefined, {}, 'broken']) assert.equal(model.decodeSnapshot({ ...mixed, watch }).watch, null)
equals(model.decodeSnapshot({ ...mixed, watch: ['saved', '', 7] }).watch, ['saved'])
assert.equal(
  model.decodeSnapshot({ ...mixed, groups: [{ id: 'group', nodes: [node(session('unexpected'))] }] }).groups[0].nodes[0].session.phase,
  'stopped',
  'an unrecognized phase falls back to the one answer that never claims live work',
)
console.log('PASS UI model: four phases, headline segments, waiting override, mood priority, workspace idleness, child exclusion, watch decoding')

// Minimal DOM exercises the real roster, bridge, and tauri modules together.
class MockNode {
  parent = null
  children = []
  ownText = ''
  append(...nodes) {
    for (const child of nodes) {
      if (child.parent) child.parent.children = child.parent.children.filter((entry) => entry !== child)
      child.parent = this
      this.children.push(child)
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null
    this.children = []
    this.ownText = ''
    this.append(...nodes)
  }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join('') }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value) }
  contains(target) { return this === target || this.children.some((child) => child.contains(target)) }
}
const dataKey = (value) => value.replace(/-([a-z])/gu, (_, character) => character.toUpperCase())
class MockElement extends MockNode {
  constructor(tag) { super(); this.tagName = tag; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.style = { setProperty() {} }; this.hidden = true }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return name.startsWith('data-') ? this.dataset[dataKey(name.slice(5))] ?? null : this.attributes.get(name) ?? null }
  addEventListener(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
  dispatch(name, target = this) { for (const listener of this.listeners.get(name) ?? []) listener({ target, button: 0 }) }
  matches(selector) {
    if (selector.startsWith('.')) return this.className?.split(' ').includes(selector.slice(1)) ?? false
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const match = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/u)
    if (match) { const value = this.dataset[dataKey(match[1])]; return value !== undefined && (match[2] === undefined || value === match[2]) }
    return this.tagName === selector
  }
  closest(selector) { return this.matches(selector) ? this : this.parent instanceof MockElement ? this.parent.closest(selector) : null }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => child instanceof MockElement ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : [])
  }
  getBoundingClientRect() { return { width: 280, height: 100, left: 0, top: 0 } }
}
class MockButton extends MockElement {}
const elements = new Map(['card', 'count', 'headline', 'subtitle', 'sessions', 'list-toggle', 'menu', 'menu-settings', 'menu-hide', 'menu-close'].map((id) => {
  const element = id === 'list-toggle' ? new MockButton('button') : new MockElement('div')
  element.id = id
  return [id, element]
}))
const document = {
  body: new MockElement('body'),
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => tag === 'button' ? new MockButton(tag) : new MockElement(tag),
  createTextNode: (text) => { const result = new MockNode(); result.textContent = text; return result },
}
const storage = new Map([['desktop-pet:watch', '["saved"]']])
const requests = []
let accepted = false
/** What `pet_focus_app` answers; flipped to prove both hint states. */
let focusStatus = 'raised'
/** Let the click handler's promise chain finish: two awaits are not enough. */
const settle = async () => { for (let tick = 0; tick < 6; tick += 1) await Promise.resolve() }
const streams = []
class MockEventSource {
  static CLOSED = 2
  readyState = 1
  listeners = new Map()
  constructor(url) { this.url = url; streams.push(this) }
  addEventListener(name, listener) { this.listeners.set(name, listener) }
  emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }) }
}
const window = {
  localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  addEventListener() {}, clearInterval() {}, setInterval() { return 1 }, setTimeout() { return 1 },
  __TAURI__: { core: { invoke: async (command) => command === 'pet_endpoint' ? { url: 'http://pet.test', token: 'test' } : command === 'pet_focus_app' ? { status: focusStatus, reason: 'test' } : undefined } },
}
const ui = loadUi({
  window, document, Element: MockElement, Node: MockNode, HTMLElement: MockElement,
  HTMLButtonElement: MockButton, CSS: { escape: (value) => value }, EventSource: MockEventSource,
  ResizeObserver: class { observe() {} },
  fetch: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { ok: accepted } },
})
ui('roster.js')
for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
assert.equal(streams.length, 1)
const stream = streams[0]
const roster = elements.get('sessions')
const savedWatch = () => JSON.parse(storage.get('desktop-pet:watch'))
stream.emit('hello', snapshot([], { watch: null }))
equals(savedWatch(), ['saved'])
equals(requests.at(-1).body, { ids: ['saved'] })
assert.equal(requests.at(-1).options.headers['x-pet-token'], 'test')
const uiNodes = [...terminal].map((phase) => node(session(phase), [node(session(phase, `${phase}-child`, { isSubagent: true }))]))
stream.emit('snapshot', snapshot(uiNodes))
assert.equal(elements.get('headline').textContent, '1 完成 · 1 停止')
const headlineSegments = elements.get('headline').querySelectorAll('.headline-seg')
assert.equal(headlineSegments.length, 2)
assert.equal(headlineSegments[0].dataset.phase, 'completed')
assert.equal(headlineSegments[1].dataset.phase, 'stopped')
assert.equal(elements.get('subtitle').title, elements.get('subtitle').textContent)
assert.equal(roster.querySelector('.group-counts').title, '1 已完成 · 1 已停止')
assert.equal(roster.querySelectorAll('[data-review]').length, 2)
for (const phase of terminal) {
  const row = roster.querySelector(`[data-focus="${phase}"]`)
  const button = row.querySelector('[data-review]')
  assert.equal(row.querySelector('.tool').textContent, model.phaseLabel(phase))
  assert.equal(row.dataset.dismissible, 'true')
  assert.equal(button.title, '从桌宠移除')
  assert.equal(button.getAttribute('aria-label'), `从桌宠移除 会话 ${phase}`)
  assert.equal(roster.querySelector(`[data-focus="${phase}-child"]`).querySelector('[data-review]'), null)
}
const button = roster.querySelector('[data-review="completed"]')
const beforeClick = JSON.stringify(savedWatch())
roster.dispatch('click', button)
await Promise.resolve()
assert.equal(requests.at(-1).url, 'http://pet.test/review')
equals(requests.at(-1).body, { sessionId: 'completed' })
assert.equal(JSON.stringify(savedWatch()), beforeClick)
assert.ok(roster.querySelector('[data-focus="completed"]'), 'rejected removal leaves row visible')
accepted = true
roster.dispatch('click', button)
await Promise.resolve()
assert.ok(roster.querySelector('[data-focus="completed"]'), 'accepted HTTP response alone cannot remove the row')
assert.equal(JSON.stringify(savedWatch()), beforeClick)
stream.emit('snapshot', snapshot(uiNodes.slice(1)))
assert.equal(roster.querySelector('[data-focus="completed"]'), null)
equals(savedWatch(), ['stopped'])
roster.dispatch('click', roster.querySelector('[data-focus="stopped"]'))
await settle()
assert.equal(requests.at(-1).url, 'http://pet.test/focus')
assert.equal(document.body.dataset.raiseFailed, undefined, 'a raise keeps the hint clean')
focusStatus = 'refused'
roster.dispatch('click', roster.querySelector('[data-focus="stopped"]'))
await settle()
assert.equal(document.body.dataset.raiseFailed, 'true', 'a refused raise says so')
focusStatus = 'alreadyFront'
roster.dispatch('click', roster.querySelector('[data-focus="stopped"]'))
await settle()
assert.equal(document.body.dataset.raiseFailed, undefined, 'already in front is not a failure')
assert.ok(roster.querySelector('[data-focus="stopped"]'), 'focus acceptance waits for Host snapshot too')
stream.emit('hello', snapshot([], { watch: null }))
equals(requests.at(-1).body, { ids: ['stopped'] })
equals(savedWatch(), ['stopped'])
stream.emit('snapshot', snapshot([]))
equals(savedWatch(), [])
assert.equal(elements.get('headline').textContent, '全部空闲')
console.log('PASS UI DOM: terminal labels and buttons, no child removal, rejected/accepted request waits, focus waits and its three hint states, watch attach/null/mirroring')
