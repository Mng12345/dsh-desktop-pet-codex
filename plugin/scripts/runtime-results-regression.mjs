/** Real runtime/HTTP regression in an isolated DSH home; no user's sessions are changed. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { startPetRuntime } from '../lib/host/runtime.js'
import { resolveConfig } from '../lib/host/config.js'

const testHome = mkdtempSync(join(tmpdir(), 'desktop-pet-runtime-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = testHome
const warnings = []
const log = {
  debug() {},
  info() {},
  warn(...args) { warnings.push(args.join(' ')) },
  error(...args) { throw new Error(args.join(' ')) },
}
let summaries = ['a', 'b', 'failed', 'stopped', 'waiting', 'parent', 'unknown'].map((sessionId) => ({
  sessionId, cwd: 'D:\\test', blank: false, running: false, updatedAt: 10,
  projections: { values: { title: sessionId } },
}))
summaries.push({ sessionId: 'child', parentSessionId: 'parent', origin: 'subagent', running: false, updatedAt: 10 })
let listeners, routes, stop, base, sequence = 0, tick, listGate = null
const workspaceRegistry = { archivedSessionIds: [], list: () => [] }
const actualSetInterval = globalThis.setInterval
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (read, accept, label) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value } catch {}
    await delay(15)
  }
  throw new Error(`Timeout: ${label}`)
}
const emit = (event, ...args) => { for (const listener of listeners.get(event) ?? []) listener(...args) }
const rows = (snapshot) => snapshot.groups.flatMap((group) => group.nodes.flatMap((node) => [node.session, ...node.children.map((child) => child.session)]))
const state = async () => (await fetch(`${base}/state`)).json()
const phase = async (id, expected) => until(state, (snapshot) => rows(snapshot).find((row) => row.id === id)?.phase === expected, `${id} -> ${expected}`)
const absent = async (id) => until(state, (snapshot) => !rows(snapshot).some((row) => row.id === id), `${id} absent`)
const put = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
const report = async (body) => {
  const request = { method: 'PUT', async *[Symbol.asyncIterator]() { yield JSON.stringify({ clientId: 'test-page', sequence: ++sequence, at: Date.now(), visible: true, ...body }) }, on() {} }
  await new Promise((resolve) => routes.get('/desktop-pet/client-state')(request, { writeHead() {}, end() { resolve() } }))
}
const pollFocus = () => {
  let body
  routes.get('/desktop-pet/focus')({ method: 'GET' }, { writeHead() {}, end(value) { body = JSON.parse(value) } })
  return body
}
const activate = async (overrides = {}) => {
  listeners = new Map(); routes = new Map()
  const ctx = {
    logger: () => log,
    on(name, listener) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener) },
    effect(setup) { return setup() ?? (() => {}) }, get(key) { return key === 'workspaceRegistry' ? workspaceRegistry : undefined },
    inject(keys, callback) { callback(ctx); return () => {} },
    sessionController: { async list() {
      const items = summaries.map((row) => ({ ...row }))
      if (listGate !== null) await listGate
      return { items }
    } },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
  }
  globalThis.setInterval = (callback, ms, ...args) => {
    if (ms === 5000) { tick = callback; return actualSetInterval(callback, 3600000, ...args) }
    return actualSetInterval(callback, ms, ...args)
  }
  try {
    stop = startPetRuntime(ctx, resolveConfig({
      autoLaunch: false, requireToken: false, port: 48700, portAttempts: 100, resyncMs: 0, ...overrides,
    }), '.')
  } finally { globalThis.setInterval = actualSetInterval }
  base = await until(() => JSON.parse(readFileSync(join(testHome, 'desktop-pet-codex', 'endpoint.json'), 'utf8')).url, (url) => typeof url === 'string', 'endpoint')
  await until(state, (snapshot) => snapshot?.version === 1, 'initial snapshot')
}
const end = (id, outcome, at = Date.now()) => {
  Object.assign(summaries.find((row) => row.sessionId === id), { running: false, updatedAt: at + 5 })
  emit('session/event', { id }, { type: 'turn/end', time: at, data: { reason: { kind: outcome } } })
  emit('api-session/activity', id, at + 5)
  return at
}
const success = (text) => console.log(`PASS ${text}`)
try {
  await activate()
  summaries.push({ sessionId: 'early', cwd: 'D:\\test', blank: false, running: true, updatedAt: Date.now() })
  emit('api-session/added', summaries.at(-1))
  emit('session/event', { id: 'early' }, { type: 'turn/start', time: Date.now(), data: {} })
  end('early', 'completed')
  await put('/watch', { ids: summaries.filter((row) => !row.origin && row.sessionId !== 'early').map((row) => row.sessionId) })
  await phase('early', 'completed')
  success('a fast turn before the first pet attach remains tracked after legacy list import')
  await phase('a', 'stopped')
  success('legacy inactive history reads stopped, not assumed successful')

  let releaseList
  listGate = new Promise((resolve) => { releaseList = resolve })
  emit('session/event', { id: 'a' }, { type: 'turn/start', time: Date.now(), data: {} })
  Object.assign(summaries.find((row) => row.sessionId === 'a'), { running: true })
  await phase('a', 'running')
  workspaceRegistry.archivedSessionIds = ['early']
  tick()
  await absent('early')
  assert.equal(rows(await state()).find((row) => row.id === 'a')?.phase, 'running')
  success('archiving another root never resets running facts from a stale baseline')
  listGate = null
  releaseList()
  emit('session/event', { id: 'a' }, { type: 'tool/call', data: { name: 'todo_write' } })
  const aAt = end('a', 'completed')
  const done = await phase('a', 'completed')
  assert.equal(rows(done).find((row) => row.id === 'a').lastTool, null)
  success('normal turn/end is completed and old tool cannot replace result')

  await report({ sessionId: 'a', enteredAt: aAt - 1, focusAt: null })
  await report({ sessionId: 'a', enteredAt: aAt - 1, focusAt: null })
  assert.equal(rows(await state()).find((row) => row.id === 'a').phase, 'completed')
  success('already open at completion plus heartbeats retain completed row')

  await put('/focus', { sessionId: 'a' })
  const focus = pollFocus()
  assert.equal(typeof focus.at, 'number')
  await report({ sessionId: 'b', enteredAt: null, focusAt: focus.at })
  assert(rows(await state()).some((row) => row.id === 'a'))
  await report({ sessionId: 'a', enteredAt: null, focusAt: focus.at, visible: false })
  assert(rows(await state()).some((row) => row.id === 'a'))
  await report({ sessionId: 'a', enteredAt: null, focusAt: focus.at })
  await absent('a')
  assert.equal(pollFocus().sessionId, null)
  assert(!JSON.parse(readFileSync(join(testHome, 'desktop-pet-codex', 'watch.json'), 'utf8')).ids.includes('a'))
  success('remove only after matching selected+visible focus confirmation; durable immediately')

  const bAt = end('b', 'completed')
  end('failed', 'error'); end('stopped', 'aborted')
  // An error and an abort are one word on the row; the outcome itself is still
  // recorded per session in the result file.
  await phase('b', 'completed'); await phase('failed', 'stopped'); await phase('stopped', 'stopped')
  emit('api-session/status', 'waiting', true)
  summaries.find((row) => row.sessionId === 'waiting').running = true
  emit('session/event', { id: 'waiting' }, { type: 'approval/asked', data: {} })
  await phase('waiting', 'waiting')
  await report({ sessionId: 'waiting', enteredAt: Date.now() })
  assert.equal((await put('/review', { sessionId: 'waiting' })).status, 400)
  await phase('waiting', 'waiting')
  success('running/waiting sessions remain, including rejected manual removal')

  const staleIds = summaries.filter((row) => !row.origin).map((row) => row.sessionId)
  await put('/watch', { ids: staleIds })
  await absent('a')
  success('stale window reconnect cannot resurrect removed membership')

  // Restoration must tolerate ordinary activity written after turn/end.
  await until(() => JSON.parse(readFileSync(join(testHome, 'desktop-pet-codex', 'pending.json'), 'utf8')), (file) => file.pending.some((entry) => entry.id === 'b' && entry.updatedAt === bAt + 5), 'result/activity persisted')
  stop(); await activate()
  await phase('b', 'completed'); await phase('failed', 'stopped'); await phase('stopped', 'stopped'); await absent('a')
  success('restart restores completed and stopped results and does not revive removed row')

  await report({ sessionId: 'b', enteredAt: Date.now() })
  await absent('b')
  success('natural DSH re-entry removes completed conversation without pet click')

  Object.assign(summaries.find((row) => row.sessionId === 'a'), { running: true, updatedAt: Date.now() })
  emit('session/event', { id: 'a' }, { type: 'turn/start', time: Date.now(), data: {} })
  await phase('a', 'running')
  assert((await state()).watch.includes('a'))
  await report({ sessionId: 'a', enteredAt: Date.now() })
  await phase('a', 'running')
  success('new turn automatically re-adds removed conversation; viewing active turn retains it')

  end('a', 'completed', Date.now() + 100)
  await phase('a', 'completed')
  await report({ sessionId: 'a', enteredAt: Date.now() - 1000 })
  assert(rows(await state()).some((row) => row.id === 'a'))
  success('a visit to an earlier turn cannot clear the next result')

  await report({ sessionId: 'unknown', enteredAt: null })
  await report({ sessionId: 'a', enteredAt: Date.now() + 500, at: Date.now() + 1000, sequence: sequence - 2 })
  assert(rows(await state()).some((row) => row.id === 'a'))
  success('out-of-order older client report is ignored')

  assert.equal((await put('/review', { sessionId: 'a' })).status, 200)
  await absent('a')
  assert.equal((await put('/review', { sessionId: 'failed' })).status, 200)
  await absent('failed')
  success('manual checkmark removes terminal results without a focus request')

  // --- a question is a tool call that has not come back --------------------
  Object.assign(summaries.find((row) => row.sessionId === 'parent'), { running: true, updatedAt: Date.now() })
  emit('session/event', { id: 'parent' }, { type: 'turn/start', time: Date.now(), data: {} })
  await phase('parent', 'running')
  emit('session/event', { id: 'parent' }, {
    type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-1' },
  })
  await phase('parent', 'waiting')
  assert.equal(rows(await state()).find((row) => row.id === 'parent').lastTool, 'ask_user_question')
  emit('session/event', { id: 'parent' }, {
    type: 'tool/result', data: { message: { toolCallId: 'call-1' } },
  })
  await phase('parent', 'running')
  success('a question reads waiting until its tool call comes back')

  emit('api-session/status', 'child', true)
  summaries.find((row) => row.sessionId === 'child').running = true
  end('parent', 'completed')
  await phase('parent', 'running')
  assert.equal((await put('/review', { sessionId: 'parent' })).status, 400)
  assert.equal((await put('/review', { sessionId: 'child' })).status, 400)
  success('running children preserve parent tracking; child cannot be removed independently')

  // --- the row's Configure page: read the presence, open and close the pair ---
  const readPresence = () => {
    let body = null
    routes.get('/desktop-pet/pet')({ method: 'GET' }, {
      writeHead() {},
      end(value) { body = JSON.parse(value) },
    })
    return body
  }
  const writePresence = async (payload) => {
    const request = {
      method: 'PUT',
      async *[Symbol.asyncIterator]() { yield JSON.stringify(payload) },
      on() {},
    }
    let status = 0
    let body = null
    await new Promise((resolve) => {
      routes.get('/desktop-pet/pet')(request, {
        writeHead(code) { status = code },
        end(value) { body = JSON.parse(value); resolve() },
      })
    })
    return { status, body }
  }
  assert.deepEqual(readPresence(), { running: false, visible: true }, 'the page can always read the pair')
  assert.equal((await writePresence({})).status, 400, 'a body that names neither button is refused')
  assert.equal((await writePresence({ visible: 'yes' })).status, 400)
  assert.deepEqual(
    await writePresence({ visible: false }),
    { status: 200, body: { running: false, visible: false } },
  )
  assert.equal((await state()).settings.visible, false, 'closing reaches the published snapshot')
  assert.deepEqual(
    await writePresence({ visible: true }),
    { status: 200, body: { running: false, visible: true } },
  )
  await writePresence({ visible: false })
  const persisted = JSON.parse(readFileSync(join(testHome, 'desktop-pet-codex', 'settings.json'), 'utf8'))
  assert.equal('visible' in persisted, false, 'closing the interface is not written down')
  assert.equal(persisted.scale, 1, 'the rest of the appearance still is')
  success('the row page reads the pair; closing is an act, not a preference')

  // A conversation DSH parents but does not call a subagent — a side thread, a
  // duplicated placeholder — is not the reader's choice: the roster must drop it
  // rather than draw a root row whose removal the Host would refuse.
  summaries.push({
    sessionId: 'thread', parentSessionId: 'parent', cwd: 'D:\\test',
    blank: false, running: false, updatedAt: 10,
  })
  stop(); await activate({ autoLaunch: true, petExecutable: join(testHome, 'no-such-pet.exe') })
  assert.equal(readPresence().visible, true, 'a restart shows the pair again')
  assert(
    !rows(await state()).some((row) => row.id === 'thread'),
    'a non-subagent child of a watched session never reaches the roster',
  )
  success('a conversation DSH parents but does not call a subagent is dropped at the source')
  const attempts = () => warnings.filter((line) => line.includes('pet window not started')).length
  assert.equal(attempts(), 1, 'activation tried the window once')
  tick(); tick()
  assert.equal(readPresence().running, false, 'a missing binary leaves the pair closed rather than crashing the Host')
  assert.equal(attempts(), 1, 'and the backoff keeps a hopeless launch off every tick')
  success('a restart shows the pair again, and a hopeless launch is retried on a backoff')
  await absent('a'); await absent('failed'); await absent('b')
  success('manual and navigation removals survive another restart')
} finally {
  stop?.()
  await delay(30)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (dirname(testHome) !== tmpdir() || !testHome.startsWith(join(tmpdir(), 'desktop-pet-runtime-'))) throw new Error('Unexpected temporary path')
  rmSync(testHome, { recursive: true, force: true })
}
