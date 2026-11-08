/**
 * Dev-only smoke test: exercises the pure core and the loopback bridge
 * without a Harness. Run with `node scripts/smoke.mjs` after `npm run build`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decodeClientState,
  decodeFocusRequest,
  decodePresencePatch,
  decodeRegistryWorkspaces,
  decodeSessionEvent,
  decodeStreamFrame,
  decodeSummaryList,
  decodeTitle,
  decodeWatchRequest,
} from '../lib/core/decode.js'
import { contentKey, basename, dismissibleRoot, phaseOf, snapshotOf } from '../lib/core/derive.js'
import { emptyRegistry, reduceRegistry } from '../lib/core/registry.js'
import { decodePendingFile, encodePendingFile, pendingOf, restoreEvents } from '../lib/core/review.js'
import {
  DEFAULT_SETTINGS,
  decodeSettingsPatch,
  mergeSettings,
  sameSettings,
} from '../lib/core/settings.js'
import { retained, seedOf, watchList, watchable } from '../lib/core/watch.js'
import { startBridge } from '../lib/host/bridge.js'
import { resolveConfig } from '../lib/host/config.js'
import {
  CLIENT_STATE_PATH,
  FOCUS_EVENTS_PATH,
  FOCUS_PATH,
  createClientChannel,
  createFocusMailbox,
  registerFocusRoutes,
} from '../lib/host/focus.js'
import { PET_PATH, registerPresenceRoutes } from '../lib/host/presence.js'
import { binaryName, buildTarget, resolvePetExecutable } from '../lib/host/pet-process.js'
import { routeOf, tokenAccepted } from '../lib/host/bridge.js'
import { sseFrame } from '../lib/core/wire.js'

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(`  ok   ${label}`)
  } catch (error) {
    results.push(`  FAIL ${label}: ${error.message}`)
    process.exitCode = 1
  }
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const SETTINGS = { ...DEFAULT_SETTINGS }

/**
 * Derivation options for a roster that is entirely watched.
 *
 * Most checks below are about the tree rather than about curation, so the
 * watched set is seeded from the roster at hand — see `optionsFor` — and this
 * base is only for the ones that pass a set explicitly.
 */
const options = {
  now: 1_000_000,
  revision: 1,
  settings: SETTINGS,
  workspaces: [],
  watch: null,
}

/** Options whose watched set is every id in a registry. */
const optionsFor = (registry, extra = {}) => ({
  ...options,
  watch: new Set(registry.byId.keys()),
  ...extra,
})

/** Every session in a snapshot's tree, groups flattened. */
const flat = (snapshot) => {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node.session)
      walk(node.children)
    }
  }
  for (const group of snapshot.groups) walk(group.nodes)
  return out
}

/** The rows of the single group a one-workspace fixture produces. */
const onlyGroup = (snapshot) => {
  assert.equal(snapshot.groups.length, 1, 'expected exactly one group')
  return snapshot.groups[0]
}

const registryOf = (items) =>
  reduceRegistry(emptyRegistry, { kind: 'snapshot', summaries: decodeSummaryList({ items }) })

/**
 * A turn that finished, on a session the Harness has also marked stopped.
 *
 * Both events are needed and the reducer is right to demand them: `running` is
 * the Host's fact about whether a turn is open, and `settled` is the log's fact
 * about how one ended. A session that finished a turn and immediately started
 * another is running, and reads that way.
 */
const settle = (state, id, at, outcome = 'completed') =>
  reduceRegistry(
    reduceRegistry(state, { kind: 'running', id, running: false }),
    { kind: 'settled', id, at, outcome },
  )

// ---------------------------------------------------------------- pure core

check('routeOf maps the routes and rejects the rest', () => {
  assert.deepEqual(routeOf('GET', '/state'), { kind: 'state' })
  assert.deepEqual(routeOf('GET', '/events'), { kind: 'events' })
  assert.deepEqual(routeOf('GET', '/health'), { kind: 'health' })
  assert.deepEqual(routeOf('GET', '/nope'), { kind: 'not-found' })
  assert.deepEqual(routeOf('POST', '/state'), { kind: 'method-not-allowed' })
  assert.deepEqual(routeOf('OPTIONS', '/state'), { kind: 'preflight' })
  assert.deepEqual(routeOf('GET', '/settings'), { kind: 'settings-read' })
  assert.deepEqual(routeOf('PUT', '/settings'), { kind: 'settings-write' })
  assert.deepEqual(routeOf('POST', '/settings'), { kind: 'method-not-allowed' })
  assert.deepEqual(routeOf('PUT', '/state'), { kind: 'method-not-allowed' })
  assert.deepEqual(routeOf('PUT', '/focus'), { kind: 'focus' })
  assert.deepEqual(routeOf('GET', '/focus'), { kind: 'method-not-allowed' })
  assert.deepEqual(routeOf('PUT', '/review'), { kind: 'review' })
  assert.deepEqual(routeOf('PUT', '/watch'), { kind: 'watch' })
  assert.deepEqual(routeOf('GET', '/watch'), { kind: 'method-not-allowed' })
  assert.deepEqual(routeOf('GET', '/review'), { kind: 'method-not-allowed' })
})

check('tokenAccepted is open only when no token is configured', () => {
  assert.equal(tokenAccepted(null, null), true)
  assert.equal(tokenAccepted(null, 'anything'), true)
  assert.equal(tokenAccepted('abc', 'abc'), true)
  assert.equal(tokenAccepted('abc', null), false)
  assert.equal(tokenAccepted('abc', 'abd'), false)
})

check('basename handles both separators and trailing slashes', () => {
  assert.equal(basename('C:\\work\\demo-app'), 'demo-app')
  assert.equal(basename('/home/me/work/'), 'work')
  assert.equal(basename('C:\\'), 'C:', 'a drive root is still a usable label')
  assert.equal(basename('/'), null)
  assert.equal(basename(''), null)
})

// -------------------------------------------------------------------- titles

check('the title is read out of the projections block, defensively', () => {
  assert.equal(
    decodeTitle({ projections: { values: { title: '检查 GIF 工具页' } } }),
    '检查 GIF 工具页',
  )
  assert.equal(decodeTitle({ projections: { values: { title: null } } }), null)
  assert.equal(decodeTitle({ projections: { values: {} } }), null, 'no title projection')
  assert.equal(decodeTitle({ projections: {} }), null, 'no values block')
  assert.equal(decodeTitle({}), null, 'no projections at all')
  assert.equal(decodeTitle({ projections: { values: { title: '' } } }), null, 'blank is no title')
  assert.equal(decodeTitle(null), null)
})

check('decodeSummaryList drops unusable rows and normalizes optionals', () => {
  const rows = decodeSummaryList({
    items: [
      {
        sessionId: 'a',
        running: true,
        cwd: 'D:\\p\\one',
        updatedAt: 5,
        projections: { values: { title: '甲' } },
      },
      { sessionId: 'b', origin: 'subagent', parentSessionId: 'a' },
      { nope: true },
      'garbage',
    ],
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    sessionId: 'a',
    updatedAt: 5,
    running: true,
    agentAvailable: false,
    blank: false,
    cwd: 'D:\\p\\one',
    parentSessionId: null,
    isSubagent: false,
    title: '甲',
  })
  assert.equal(rows[1].isSubagent, true)
  assert.equal(rows[1].parentSessionId, 'a')
  assert.equal(rows[1].cwd, null)
  assert.equal(rows[1].title, null)
})

check('decodeSessionEvent classifies the event types it owns', () => {
  assert.deepEqual(decodeSessionEvent({ type: 'approval/asked', data: {} }), {
    kind: 'approval-asked',
    pending: 'approval',
  })
  assert.deepEqual(decodeSessionEvent({ type: 'approval/asked', data: { kind: 'question' } }), {
    kind: 'approval-asked',
    pending: 'question',
  })
  assert.deepEqual(decodeSessionEvent({ type: 'approval/decided', data: {} }), {
    kind: 'approval-decided',
  })
  assert.deepEqual(decodeSessionEvent({ type: 'tool/call', data: { name: 'bash' } }), {
    kind: 'tool-started',
    tool: 'bash',
    callId: null,
    blocks: null,
  })
  // The two tools that block on the reader: neither appends an event of its
  // own, so the call itself is the signal.
  assert.deepEqual(
    decodeSessionEvent({ type: 'tool/call', data: { name: 'ask_user_question', callId: 'call-1' } }),
    { kind: 'tool-started', tool: 'ask_user_question', callId: 'call-1', blocks: 'question' },
  )
  assert.deepEqual(
    decodeSessionEvent({ type: 'tool/call', data: { name: 'exit_plan_mode', callId: 'call-2' } }),
    { kind: 'tool-started', tool: 'exit_plan_mode', callId: 'call-2', blocks: 'plan-review' },
  )
  assert.deepEqual(
    decodeSessionEvent({ type: 'tool/result', data: { message: { toolCallId: 'call-1' } } }),
    { kind: 'tool-finished', callId: 'call-1' },
  )
  assert.deepEqual(
    decodeSessionEvent({ type: 'tool/result', data: { message: { source: { callId: 'call-9' } } } }),
    { kind: 'tool-finished', callId: 'call-9' },
    'an older shape keeps the id on the source',
  )
  assert.deepEqual(
    decodeSessionEvent({ type: 'tool/result', data: {} }),
    { kind: 'tool-finished', callId: null },
    'a result that lost its id still ends a wait',
  )
  assert.deepEqual(decodeSessionEvent({ type: 'session/title', data: { title: '甲' } }), {
    kind: 'title',
    title: '甲',
  })
  assert.equal(decodeSessionEvent({ type: 'session/title', data: {} }), null)
  assert.equal(decodeSessionEvent({ type: 'session/title', data: { title: '' } }), null)
  assert.deepEqual(
    decodeSessionEvent({ type: 'turn/end', time: 42, data: { reason: { kind: 'error' } } }),
    { kind: 'turn-ended', at: 42, outcome: 'error' },
  )
  assert.equal(decodeSessionEvent({ type: 'assistant/message', data: {} }), null)
  assert.equal(decodeSessionEvent(null), null)
})

check('a question is a tool call that has not come back', () => {
  const running = reduceRegistry(registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }]), {
    kind: 'tool', id: 'a', tool: 'ask_user_question', callId: 'call-1', blocks: 'question',
  })
  assert.equal(running.byId.get('a').pending, 'question')
  assert.equal(running.byId.get('a').blockedCallId, 'call-1')
  assert.equal(phaseOf(running.byId.get('a'), 0), 'waiting', 'the row says 等你 while it is open')

  const other = reduceRegistry(running, { kind: 'tool-finished', id: 'a', callId: 'call-9' })
  assert.equal(other, running, 'a different call returning changes nothing')

  const answered = reduceRegistry(running, { kind: 'tool-finished', id: 'a', callId: 'call-1' })
  assert.equal(answered.byId.get('a').pending, null)
  assert.equal(answered.byId.get('a').blockedCallId, null)
  assert.equal(phaseOf(answered.byId.get('a'), 0), 'running', 'and it is working again')

  const plan = reduceRegistry(registryOf([{ sessionId: 'a', running: true }]), {
    kind: 'tool', id: 'a', tool: 'exit_plan_mode', callId: 'call-2', blocks: 'plan-review',
  })
  assert.equal(phaseOf(plan.byId.get('a'), 0), 'waiting', 'a plan review waits the same way')

  const plain = reduceRegistry(registryOf([{ sessionId: 'a', running: true }]), {
    kind: 'tool', id: 'a', tool: 'bash', callId: 'call-3', blocks: null,
  })
  assert.equal(plain.byId.get('a').pending, null)
  assert.equal(phaseOf(plain.byId.get('a'), 0), 'running', 'an ordinary tool never blocks')

  const ended = reduceRegistry(running, { kind: 'settled', id: 'a', at: 9, outcome: 'aborted' })
  assert.equal(ended.byId.get('a').blockedCallId, null, 'a turn that ended is not waiting for anyone')
})

check('a title event names the conversation without inventing one', () => {
  const seeded = registryOf([{ sessionId: 'a', cwd: 'D:\\p\\one' }])
  const named = reduceRegistry(seeded, { kind: 'title', id: 'a', title: '甲' })
  assert.equal(named.byId.get('a').title, '甲')
  assert.equal(reduceRegistry(named, { kind: 'title', id: 'ghost', title: 'x' }), named)
  assert.equal(reduceRegistry(named, { kind: 'title', id: 'a', title: '甲' }), named, 'idempotent')
})

check('a baseline that loses the title projection does not lose the title', () => {
  const named = reduceRegistry(registryOf([{ sessionId: 'a', cwd: 'D:\\p\\one' }]), {
    kind: 'title',
    id: 'a',
    title: '甲',
  })
  const rebased = reduceRegistry(named, {
    kind: 'snapshot',
    summaries: decodeSummaryList({ items: [{ sessionId: 'a', cwd: 'D:\\p\\one' }] }),
  })
  assert.equal(rebased.byId.get('a').title, '甲', 'a cache miss must not flicker the name back')
})

check('a delayed baseline never rewinds the activity watermark of a retained result', () => {
  const settled = settle(registryOf([{ sessionId: 'a', updatedAt: 5 }]), 'a', 10)
  const touched = reduceRegistry(settled, { kind: 'activity', id: 'a', updatedAt: 20 })
  const rebased = reduceRegistry(touched, {
    kind: 'snapshot',
    summaries: decodeSummaryList({ items: [{ sessionId: 'a', updatedAt: 5 }] }),
  })
  assert.equal(rebased.byId.get('a').updatedAt, 20)
  const persisted = pendingOf(rebased.byId)
  assert.equal(persisted[0].updatedAt, 20)
  const rebooted = registryOf([{ sessionId: 'a', updatedAt: 20 }])
  assert.equal(restoreEvents(persisted, rebooted.byId).length, 1)
})

// ---------------------------------------------------------------- the roster

check('the reducer is reference-stable when an event changes nothing', () => {
  const items = [{ sessionId: 'a', running: true, updatedAt: 5, cwd: 'D:\\p\\one' }]
  const seeded = registryOf(items)
  assert.notEqual(seeded, emptyRegistry)
  const rebased = reduceRegistry(seeded, {
    kind: 'snapshot',
    summaries: decodeSummaryList({ items }),
  })
  assert.equal(rebased, seeded, 'an identical baseline must not bump the revision')
  assert.equal(reduceRegistry(seeded, { kind: 'remove', id: 'ghost' }), seeded)
  assert.equal(reduceRegistry(seeded, { kind: 'pending', id: 'ghost', pending: 'approval' }), seeded)
  assert.equal(reduceRegistry(seeded, { kind: 'reviewed', id: 'ghost' }), seeded)
})

check('a snapshot drops rows the baseline no longer lists', () => {
  const two = registryOf([{ sessionId: 'a' }, { sessionId: 'b' }])
  assert.equal(two.byId.size, 2)
  const one = registryOf([{ sessionId: 'a' }])
  assert.equal(one.byId.size, 1)
  assert.equal(one.byId.has('b'), false)
})

check('phase precedence puts the human-blocked session first', () => {
  const base = {
    id: 'x', cwd: null, parentId: null, isSubagent: false, updatedAt: 0, running: true,
    blank: false, title: null, pending: 'approval', lastTool: null, lastOutcome: null,
    settledAt: null, lastError: null, reviewed: true,
  }
  assert.equal(phaseOf(base, 0), 'waiting')
  assert.equal(phaseOf({ ...base, pending: null }, 0), 'running')
  assert.equal(
    phaseOf({ ...base, pending: null, running: false }, 2),
    'running',
    'a subagent working is its parent working',
  )
  assert.equal(
    phaseOf({ ...base, pending: null, running: false, lastOutcome: 'completed', reviewed: false }, 0),
    'completed',
  )
  assert.equal(
    phaseOf({ ...base, pending: null, running: false, lastOutcome: 'completed', reviewed: true }, 0),
    'completed',
    'reading a result does not change how the turn ended',
  )
  // Everything that is neither live work nor a completed turn gets one word.
  assert.equal(phaseOf({ ...base, pending: null, running: false, lastOutcome: 'error' }, 0), 'stopped')
  assert.equal(phaseOf({ ...base, pending: null, running: false, lastOutcome: 'aborted' }, 0), 'stopped')
  assert.equal(phaseOf({ ...base, pending: null, running: false, lastOutcome: 'other' }, 0), 'stopped')
  assert.equal(phaseOf({ ...base, pending: null, running: false, lastOutcome: null }, 0), 'stopped')
  assert.equal(
    phaseOf({ ...base, pending: null, running: false, blank: true }, 0),
    'stopped',
    'there is no idle phase: a session that is not running has a result',
  )
})

// ------------------------------------------------------- unread results

check('a completed turn arms the unread mark and a new turn clears it', () => {
  const running = registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }])
  assert.equal(running.byId.get('a').reviewed, true, 'nothing has finished yet')

  const done = settle(running, 'a', 100)
  assert.equal(done.byId.get('a').reviewed, false)
  assert.equal(snapshotOf(done, optionsFor(done)).groups[0].nodes[0].session.phase, 'completed')

  const again = reduceRegistry(done, { kind: 'running', id: 'a', running: true })
  assert.equal(again.byId.get('a').reviewed, true, 'another turn supersedes an unread result')
})

check('all root results are unacknowledged, while children belong to the parent', () => {
  const running = registryOf([
    { sessionId: 'a', running: true, updatedAt: 0 },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'a', running: true, cwd: 'D:\\w' },
  ])
  assert.equal(settle(running, 'a', 1, 'error').byId.get('a').reviewed, false)
  assert.equal(settle(running, 'a', 1, 'aborted').byId.get('a').reviewed, false)
  assert.equal(settle(running, 'child', 1).byId.get('child').reviewed, true)
})

check('the unread mark has no clock on it', () => {
  const settled = settle(registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }]), 'a', 10)
  // Two minutes, two hours, two days: the old window would have expired all of
  // these, and the whole point of the change is that none of them do.
  for (const now of [2_000, 7_200_000, 172_800_000]) {
    assert.equal(snapshotOf(settled, optionsFor(settled, { now })).groups[0].nodes[0].session.phase, 'completed')
  }
})

check('reviewing is idempotent and preserves the completed result', () => {
  const settled = settle(registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }]), 'a', 10)
  const read = reduceRegistry(settled, { kind: 'reviewed', id: 'a' })
  assert.equal(read.byId.get('a').reviewed, true)
  assert.equal(snapshotOf(read, optionsFor(read)).groups[0].nodes[0].session.phase, 'completed')
  assert.equal(reduceRegistry(read, { kind: 'reviewed', id: 'a' }), read, 'a second report is a no-op')
})

check('an unread row keeps the last sentence it produced', () => {
  let state = reduceRegistry(registryOf([{ sessionId: 'live', running: true, updatedAt: 5 }]), {
    kind: 'stream', id: 'live', frame: { kind: 'start', attemptId: 'a1', revision: 1 },
  })
  state = reduceRegistry(state, {
    kind: 'stream', id: 'live',
    frame: decodeStreamFrame({
      type: 'chunk', attemptId: 'a1', index: 0, time: 100,
      chunk: { type: 'text-delta', text: '做完了' },
    }),
  })
  state = settle(state, 'live', 200)
  const row = snapshotOf(state, optionsFor(state)).groups[0].nodes[0].session
  assert.equal(row.phase, 'completed')
  assert.equal(row.thought, '做完了', 'the reason to go and look is the sentence it ended on')

  const read = reduceRegistry(state, { kind: 'reviewed', id: 'live' })
  assert.equal(
    snapshotOf(read, optionsFor(read)).groups[0].nodes[0].session.thought,
    '做完了',
    'acknowledgement does not change the completed result or its final sentence',
  )
})

check('a stopped session that was never unread publishes no thought', () => {
  let state = reduceRegistry(registryOf([{ sessionId: 'live', running: true, updatedAt: 5 }]), {
    kind: 'stream', id: 'live', frame: { kind: 'start', attemptId: 'a1', revision: 1 },
  })
  state = reduceRegistry(state, {
    kind: 'stream', id: 'live',
    frame: decodeStreamFrame({
      type: 'chunk', attemptId: 'a1', index: 0, time: 100,
      chunk: { type: 'reasoning-delta', text: 'mid-sentence' },
    }),
  })
  state = reduceRegistry(state, { kind: 'running', id: 'live', running: false })
  const row = snapshotOf(state, optionsFor(state)).groups[0].nodes[0].session
  assert.equal(row.phase, 'stopped')
  assert.equal(row.thought, null, 'a stopped row is not quoting anything')
  assert.equal(state.byId.get('live').thought, 'mid-sentence', 'the text is kept, only hidden')
})

// --------------------------------------------------- the unread file

check('the v2 result file round-trips; legacy markers restore unknown', () => {
  const pending = [{ id: 'a', at: 5, updatedAt: 7, outcome: 'completed', error: null, reviewed: true }]
  assert.deepEqual(decodePendingFile(JSON.parse(encodePendingFile(pending))), pending)
  assert.deepEqual(decodePendingFile(null), [])
  assert.deepEqual(decodePendingFile({ version: 99, pending }), [])
  assert.deepEqual(decodePendingFile({ version: 1 }), [])
  assert.deepEqual(decodePendingFile({ version: 1, pending: 'nope' }), [])
  assert.deepEqual(
    decodePendingFile({ version: 1, pending: [{ id: 'a', at: 5 }, { id: '' }, 7, { nope: 1 }] }),
    [{ id: 'a', at: 5, outcome: 'other', error: null, reviewed: false }],
  )
  assert.deepEqual(decodePendingFile({ version: 2, pending: [{ id: 'a', at: 5, outcome: 'made-up' }] }), [])
})

check('pendingOf persists retained results even when acknowledged and skips children', () => {
  let state = registryOf([
    { sessionId: 'old', running: true, updatedAt: 1 },
    { sessionId: 'new', running: true, updatedAt: 2 },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'new', running: true },
    { sessionId: 'quiet', updatedAt: 3 },
  ])
  state = reduceRegistry(state, { kind: 'settled', id: 'old', at: 100, outcome: 'completed' })
  state = reduceRegistry(state, { kind: 'reviewed', id: 'old' })
  state = reduceRegistry(state, { kind: 'settled', id: 'new', at: 200, outcome: 'error' })
  state = reduceRegistry(state, { kind: 'settled', id: 'child', at: 300, outcome: 'completed' })
  assert.deepEqual(pendingOf(state.byId), [
    { id: 'new', at: 200, updatedAt: 2, outcome: 'error', error: null, reviewed: false },
    { id: 'old', at: 100, updatedAt: 1, outcome: 'completed', error: null, reviewed: true },
  ])
})

check('restoring refines inactive roots without inventing success or rewinding newer history', () => {
  const state = registryOf([
    { sessionId: 'gone-soon', updatedAt: 1 },
    { sessionId: 'busy', running: true, updatedAt: 2 },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'busy', updatedAt: 3 },
    { sessionId: 'newer', updatedAt: 100 },
  ])
  const persisted = ['gone-soon', 'missing', 'busy', 'child', 'newer'].map((id) => ({
    id, at: 10, updatedAt: 10, outcome: 'other', error: null, reviewed: false,
  }))
  const events = restoreEvents(persisted, state.byId)
  assert.deepEqual(events, [{ kind: 'restore-result', id: 'gone-soon', at: 10, updatedAt: 10, outcome: 'other', error: null, reviewed: false }])
  const restored = events.reduce(reduceRegistry, state)
  assert.equal(restored.byId.get('gone-soon').reviewed, false)
  assert.equal(phaseOf(restored.byId.get('gone-soon'), 0), 'stopped')
  assert.equal(restored.byId.get('busy').lastOutcome, null)
  assert.equal(restored.byId.get('newer').lastOutcome, null)
})

// --------------------------------------------------------------- the tree

check('groups are Workspaces when the path matches, directories otherwise', () => {
  const registry = registryOf([
    { sessionId: 'a', cwd: 'D:\\work\\alpha', updatedAt: 10 },
    { sessionId: 'b', cwd: 'D:\\work\\beta', updatedAt: 20 },
  ])
  const byDirectory = snapshotOf(registry, optionsFor(registry))
  assert.deepEqual(
    byDirectory.groups.map((group) => [group.id, group.title]),
    [['dir:D:\\work\\beta', 'beta'], ['dir:D:\\work\\alpha', 'alpha']],
    'groups order by newest activity',
  )

  const byWorkspace = snapshotOf(registry, {
    ...optionsFor(registry),
    workspaces: [
      { id: 'w1', path: 'D:\\work\\alpha', title: '一个工作区', sessionIds: ['a'] },
      { id: 'w2', path: 'D:\\work\\beta', title: '另一个', sessionIds: ['b'] },
    ],
  })
  assert.deepEqual(
    byWorkspace.groups.map((group) => [group.id, group.title]),
    [['ws:w2', '另一个'], ['ws:w1', '一个工作区']],
    'both directories are claimed, and still order by newest activity',
  )
})

check('membership is the path, not the sessionIds account', () => {
  // The bug this replaces: a Workspace's `sessionIds` is an ordering account and
  // does not list every session sitting in its directory, so matching on it — or
  // on the title — split one project into two identically-named groups.
  const registry = registryOf([
    { sessionId: 'listed', cwd: 'D:\\work\\alpha', updatedAt: 10 },
    { sessionId: 'unlisted', cwd: 'D:\\work\\alpha', updatedAt: 20 },
  ])
  const snapshot = snapshotOf(registry, {
    ...optionsFor(registry),
    workspaces: [{ id: 'w1', path: 'D:\\work\\alpha', title: 'alpha', sessionIds: ['listed'] }],
  })
  assert.equal(snapshot.groups.length, 1, 'one directory, one group')
  assert.equal(snapshot.groups[0].id, 'ws:w1')
  assert.deepEqual(
    snapshot.groups[0].nodes.map((node) => node.session.id).sort(),
    ['listed', 'unlisted'],
  )
})

check('a session in no Workspace still groups by its directory', () => {
  const registry = registryOf([
    { sessionId: 'a', cwd: 'D:\\work\\alpha', updatedAt: 10 },
    { sessionId: 'b', cwd: 'D:\\other\\beta', updatedAt: 20 },
  ])
  const snapshot = snapshotOf(registry, {
    ...optionsFor(registry),
    workspaces: [{ id: 'w1', path: 'D:\\work\\alpha', title: 'alpha', sessionIds: [] }],
  })
  assert.deepEqual(snapshot.groups.map((group) => group.id).sort(), [
    'dir:D:\\other\\beta',
    'ws:w1',
  ])
})

check('an unnamed Workspace falls back rather than showing a blank name', () => {
  const registry = registryOf([{ sessionId: 'a', cwd: 'D:\\work\\alpha', updatedAt: 10 }])
  const snapshot = snapshotOf(registry, {
    ...optionsFor(registry),
    workspaces: [{ id: 'w1', path: 'D:\\work\\alpha', title: '', sessionIds: ['a'] }],
  })
  assert.equal(snapshot.groups[0].id, 'ws:w1')
  assert.equal(snapshot.groups[0].title, null, 'the window supplies its own fallback')
})

check('two directories with one basename stay two groups', () => {
  const registry = registryOf([
    { sessionId: 'a', cwd: 'C:\\one\\tools', updatedAt: 10 },
    { sessionId: 'b', cwd: 'D:\\two\\tools', updatedAt: 20 },
  ])
  const snapshot = snapshotOf(registry, optionsFor(registry))
  assert.equal(snapshot.groups.length, 2)
  assert.deepEqual(snapshot.groups.map((group) => group.title), ['tools', 'tools'])
})

check('a session with no directory lands in its own group', () => {
  const snapshot = snapshotOf(registryOf([{ sessionId: 'a', updatedAt: 1 }]), optionsFor(registryOf([{ sessionId: 'a', updatedAt: 1 }])))
  assert.equal(snapshot.groups[0].id, 'none')
  assert.equal(snapshot.groups[0].title, null)
})

check('within a group, the most recently touched row leads', () => {
  const registry = registryOf([
    { sessionId: 'fresh-idle', cwd: 'D:\\w', updatedAt: 900 },
    { sessionId: 'old-blocked', cwd: 'D:\\w', updatedAt: 10 },
  ])
  const snapshot = snapshotOf(
    reduceRegistry(registry, { kind: 'pending', id: 'old-blocked', pending: 'approval' }),
    optionsFor(registry),
  )
  const group = onlyGroup(snapshot)
  assert.deepEqual(group.nodes.map((node) => node.session.id), ['fresh-idle', 'old-blocked'])
  assert.equal(
    group.nodes[1].session.phase,
    'waiting',
    'the blocked row is still labelled, it is just not lifted',
  )
  assert.equal(group.updatedAt, 900, 'the group still sorts by its newest member')
})

check('a subagent nests under its parent, and an orphan never reaches the tree', () => {
  const registry = registryOf([
    { sessionId: 'parent', cwd: 'D:\\w', running: true, updatedAt: 10 },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'parent', running: true, cwd: 'D:\\w' },
  ])
  const group = onlyGroup(snapshotOf(registry, optionsFor(registry)))
  assert.equal(group.nodes.length, 1, 'the child is not a sibling')
  assert.equal(group.nodes[0].session.id, 'parent')
  assert.equal(group.nodes[0].session.subagentCount, 1)
  assert.deepEqual(group.nodes[0].children.map((node) => node.session.id), ['child'])

  // The orphan case is no longer the tree's to handle: a subagent whose parent
  // is not watched never has its facts kept in the first place, so the derive
  // layer cannot be handed one. That rule lives in `retained`, below.
  const watch = new Set(['parent'])
  assert.equal(retained('parent', null, false, watch), true)
  assert.equal(retained('child', 'parent', true, watch), true, 'a watched parent keeps its subagents')
  assert.equal(retained('child', 'ghost', true, watch), false, 'an orphan is dropped at the source')
  assert.equal(retained('stranger', null, false, watch), false)
  assert.equal(
    retained('thread', 'parent', false, watch),
    false,
    'a conversation DSH parents but does not call a subagent is not the reader\'s choice',
  )
})

check('snapshotOf counts, groups, nests, and labels as specified', () => {
  const registry = registryOf([
    { sessionId: 'idle-1', cwd: 'D:\\work\\alpha', updatedAt: 10 },
    { sessionId: 'run-1', cwd: 'D:\\work\\beta', running: true, updatedAt: 20 },
    { sessionId: 'sub-1', origin: 'subagent', parentSessionId: 'run-1', running: true, cwd: 'D:\\work\\beta' },
  ])
  const snapshot = snapshotOf(
    reduceRegistry(registry, { kind: 'pending', id: 'idle-1', pending: 'approval' }),
    optionsFor(registry),
  )

  assert.deepEqual(snapshot.totals, { sessions: 2, running: 1, waiting: 1, subagents: 1 })
  assert.equal(flat(snapshot).length, 3, 'subagents are still published, just nested')
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.revision, 1)

  // Groups lead with the project that moved most recently, and so does the row
  // inside one — the phase is written on the row rather than implied by order.
  assert.deepEqual(snapshot.groups.map((group) => group.title), ['beta', 'alpha'])
  const beta = snapshot.groups[0]
  assert.deepEqual(beta.nodes.map((node) => node.session.id), ['run-1'])
  assert.equal(beta.nodes[0].session.phase, 'running')
  assert.equal(beta.nodes[0].session.subagentCount, 1)
  assert.deepEqual(beta.nodes[0].children.map((node) => node.session.id), ['sub-1'])
  assert.equal(beta.updatedAt, 20)

  const alpha = snapshot.groups[1]
  assert.deepEqual(alpha.nodes.map((node) => node.session.id), ['idle-1'])
  assert.equal(alpha.nodes[0].session.phase, 'waiting')
  assert.equal(alpha.nodes[0].session.label, 'alpha')
})

check('a row carries both the title and the directory it fell back from', () => {
  const registry = registryOf([
    {
      sessionId: 'a', cwd: 'D:\\work\\alpha', updatedAt: 10,
      projections: { values: { title: '标题' } },
    },
  ])
  const row = onlyGroup(snapshotOf(registry, optionsFor(registry))).nodes[0].session
  assert.equal(row.title, '标题')
  assert.equal(row.label, 'alpha', 'the directory stays available for a tooltip')
})

check('contentKey ignores revision and clock, tracks content', () => {
  const base = registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }])
  const at = (now, revision) => snapshotOf(base, { ...optionsFor(base), now, revision })
  assert.equal(contentKey(at(1, 1)), contentKey(at(999, 7)))
  const later = reduceRegistry(base, { kind: 'running', id: 'a', running: false })
  assert.notEqual(contentKey(at(1, 1)), contentKey(snapshotOf(later, optionsFor(later))))
})

check('regrouping is a content change even with the roster untouched', () => {
  const base = registryOf([{ sessionId: 'a', cwd: 'D:\\w\\alpha', updatedAt: 5 }])
  const byDirectory = snapshotOf(base, optionsFor(base))
  const byWorkspace = snapshotOf(base, {
    ...optionsFor(base),
    workspaces: [{ id: 'w1', path: 'D:\\w\\alpha', title: '一个工作区', sessionIds: ['a'] }],
  })
  assert.notEqual(
    contentKey(byDirectory),
    contentKey(byWorkspace),
    'a Workspace rename or regroup must republish',
  )
})

check('a change to the watched set is itself a content change', () => {
  const base = registryOf([{ sessionId: 'a', cwd: 'D:\\w', updatedAt: 5 }])
  const untold = snapshotOf(base, options)
  assert.equal(untold.watch, null, 'never told is not the same as told nothing')
  const told = snapshotOf(base, { ...options, watch: new Set(['a']) })
  assert.deepEqual(told.watch, ['a'])
  assert.notEqual(
    contentKey(untold),
    contentKey(told),
    'the pet mirrors this back, so a change to it must be published',
  )
  const emptied = snapshotOf(base, { ...options, watch: new Set() })
  assert.deepEqual(emptied.watch, [])
  assert.notEqual(contentKey(told), contentKey(emptied))
})

check('the published watched set is sorted, so equal sets serialize equally', () => {
  const base = registryOf([{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }])
  const one = snapshotOf(base, { ...options, watch: new Set(['c', 'a', 'b']) })
  const other = snapshotOf(base, { ...options, watch: new Set(['b', 'c', 'a']) })
  assert.deepEqual(one.watch, ['a', 'b', 'c'])
  assert.equal(contentKey(one), contentKey(other), 'insertion order must not look like a change')
})

check('a settings edit is itself a content change', () => {
  const base = registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }])
  const before = snapshotOf(base, optionsFor(base))
  const after = snapshotOf(base, { ...optionsFor(base), settings: { ...SETTINGS, scale: 1.4 } })
  assert.notEqual(contentKey(before), contentKey(after), 'resizing must republish')
  assert.deepEqual(before.settings, SETTINGS)
  assert.equal(after.settings.scale, 1.4)
})

// ------------------------------------------------------------ live thinking

const runningSession = () =>
  registryOf([{ sessionId: 'live', running: true, updatedAt: 5, cwd: 'D:\\work\\thing' }])

const startFrame = (attemptId, revision = 1) => ({ kind: 'start', attemptId, revision })

const textChunk = (attemptId, index, text, at = 100, type = 'reasoning-delta') =>
  decodeStreamFrame({
    type: 'chunk',
    attemptId,
    index,
    time: at,
    chunk: { type, text },
  })

check('decodeStreamFrame keeps text-bearing chunks and drops the rest', () => {
  assert.deepEqual(decodeStreamFrame({ type: 'start', attemptId: 'a1', revision: 3 }), {
    kind: 'start',
    attemptId: 'a1',
    revision: 3,
  })
  assert.deepEqual(textChunk('a1', 0, 'think'), {
    kind: 'chunk',
    attemptId: 'a1',
    index: 0,
    at: 100,
    text: 'think',
    textKind: 'reasoning',
  })
  assert.equal(decodeStreamFrame({ type: 'chunk', attemptId: 'a1', index: 1, chunk: { type: 'usage' } }).text, null)
  assert.equal(decodeStreamFrame({ type: 'chunk', attemptId: 'a1', index: 1, chunk: { type: 'block-end' } }).text, null)
  assert.equal(decodeStreamFrame({ type: 'start' }), null, 'a start without an attempt id is unusable')
  assert.equal(decodeStreamFrame({ type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', text: 'x' } }), null)
  assert.equal(decodeStreamFrame({ type: 'wat' }), null)
})

check('streamed fragments accumulate into a session thought', () => {
  let state = reduceRegistry(runningSession(), { kind: 'stream', id: 'live', frame: startFrame('a1') })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 0, '先看') })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 1, '再想') })
  const facts = state.byId.get('live')
  assert.equal(facts.thought, '先看再想')
  assert.equal(facts.thoughtKind, 'reasoning')
  assert.equal(facts.thoughtAt, 100)
  assert.equal(facts.stream.nextIndex, 2)
})

check('an out-of-order fragment abandons the attempt instead of splicing', () => {
  let state = reduceRegistry(runningSession(), { kind: 'stream', id: 'live', frame: startFrame('a1') })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 0, 'ok') })
  const before = state
  // Index 3 where 1 was expected: a dropped frame, which is normal.
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 3, 'LOST') })
  assert.equal(state.byId.get('live').stream.attemptId, null, 'the cursor is dropped')
  assert.equal(state.byId.get('live').thought, 'ok', 'what was read stays readable')
  // A still-out-of-order frame must now be a no-op, reference-stable.
  assert.equal(reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 4, 'x') }), state)
  assert.notEqual(before, state)
})

check('a fresh start re-seats the cursor, clears the thought, and ignores a stale end', () => {
  let state = reduceRegistry(runningSession(), { kind: 'stream', id: 'live', frame: startFrame('a1') })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 0, 'first step') })
  assert.equal(state.byId.get('live').thought, 'first step')
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: { kind: 'end', attemptId: 'other' } })
  assert.equal(state.byId.get('live').stream.attemptId, 'a1', 'an end for another attempt is not ours')
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: { kind: 'end', attemptId: 'a1' } })
  assert.equal(state.byId.get('live').stream.attemptId, null)
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: startFrame('a2') })
  assert.equal(state.byId.get('live').stream.attemptId, 'a2')
  assert.equal(state.byId.get('live').stream.nextIndex, 0)
  assert.equal(
    state.byId.get('live').thought,
    '',
    'a new step must not inherit the previous step sentence',
  )
})

check('the thought is trimmed to its tail', () => {
  let state = reduceRegistry(runningSession(), { kind: 'stream', id: 'live', frame: startFrame('a1') })
  const chunk = textChunk('a1', 0, 'x'.repeat(300))
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: chunk })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 1, 'y'.repeat(300)) })
  const thought = state.byId.get('live').thought
  assert.equal(thought.length, 400)
  assert.equal(thought.endsWith('y'), true)
})

check('the baseline drops stream state for a session that is no longer running', () => {
  let state = reduceRegistry(runningSession(), { kind: 'stream', id: 'live', frame: startFrame('a1') })
  state = reduceRegistry(state, { kind: 'stream', id: 'live', frame: textChunk('a1', 0, 'stale') })
  state = reduceRegistry(state, {
    kind: 'snapshot',
    summaries: decodeSummaryList({
      items: [{ sessionId: 'live', running: false, updatedAt: 9, cwd: 'D:\\work\\thing' }],
    }),
  })
  assert.equal(state.byId.get('live').stream.attemptId, null)
})

check('stream frames for an unknown session invent nothing', () => {
  const state = reduceRegistry(runningSession(), {
    kind: 'stream',
    id: 'ghost',
    frame: textChunk('a1', 0, 'x'),
  })
  assert.equal(state.byId.has('ghost'), false)
})

// ------------------------------------------------------------------ config

// ------------------------------------------------------------- the watched set

check('the seed is whatever is running right now', () => {
  const summaries = decodeSummaryList({
    items: [
      { sessionId: 'busy', running: true },
      { sessionId: 'quiet' },
      { sessionId: 'also-busy', running: true },
      { sessionId: 'child', origin: 'subagent', parentSessionId: 'busy', running: true },
    ],
  })
  // A fresh baseline can prove `running` and nothing else: approvals and unread
  // results are runtime facts that arrive as events.
  assert.deepEqual(seedOf(summaries), ['busy', 'also-busy'])
  assert.deepEqual(seedOf([]), [])
})

check('only a begun conversation may enter the watched set', () => {
  const of = (item) => decodeSummaryList({ items: [item] })[0]
  assert.equal(watchable(of({ sessionId: 'a' })), true)
  assert.equal(watchable(of({ sessionId: 'a', blank: true })), false, 'a placeholder is not a conversation')
  assert.equal(
    watchable(of({ sessionId: 'c', origin: 'subagent', parentSessionId: 'a' })),
    false,
    'nobody starts a subagent; it is dispatched',
  )
})

check('retention keeps a watched conversation and its subagents, and nothing else', () => {
  const watch = new Set(['a'])
  assert.equal(retained('a', null, false, watch), true)
  assert.equal(retained('child', 'a', true, watch), true)
  assert.equal(retained('child', 'b', true, watch), false)
  assert.equal(retained('thread', 'a', false, watch), false, 'lineage is not enough; the flag decides')
  assert.equal(retained('b', null, false, watch), false)
  assert.equal(retained('a', null, false, new Set()), false, 'an empty set keeps nothing')
})

check('the removal verdict is the Host\'s, and one rule serves both sides', () => {
  const running = registryOf([{ sessionId: 'a', running: true, updatedAt: 5 }])
  const settled = settle(running, 'a', 9)
  const row = snapshotOf(settled, optionsFor(settled)).groups[0].nodes[0].session
  assert.equal(row.phase, 'completed')
  assert.equal(row.dismissible, true, 'a watched settled root offers its removal')

  const facts = settled.byId.get('a')
  assert.equal(
    dismissibleRoot({ ...facts, lastOutcome: null, blank: true }, 0),
    false,
    'a placeholder nobody began is not removable',
  )
  assert.equal(dismissibleRoot({ ...facts, pending: 'approval' }, 0), false)
  assert.equal(dismissibleRoot({ ...facts, isSubagent: true }, 0), false)
  assert.equal(dismissibleRoot(facts, 1), false, 'a busy child keeps its parent in place')
  assert.equal(dismissibleRoot(facts, 0), true)
})

check('watchList sorts, so equal sets serialize identically', () => {
  assert.deepEqual(watchList(new Set(['c', 'a', 'b'])), ['a', 'b', 'c'])
  assert.deepEqual(watchList(new Set()), [])
})

check('the tree shows only the watched set, and nothing at all before it is told', () => {
  const registry = registryOf([
    { sessionId: 'mine', cwd: 'D:\\w', running: true, updatedAt: 20 },
    { sessionId: 'theirs', cwd: 'D:\\w', running: true, updatedAt: 30 },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'mine', cwd: 'D:\\w' },
    { sessionId: 'orphan', origin: 'subagent', parentSessionId: 'theirs', cwd: 'D:\\w' },
  ])

  // Never told: nothing, rather than everything for a moment.
  const untold = snapshotOf(registry, options)
  assert.deepEqual(untold.groups, [])
  assert.deepEqual(untold.totals, { sessions: 0, running: 0, waiting: 0, subagents: 0 })

  const mine = snapshotOf(registry, { ...options, watch: new Set(['mine']) })
  assert.deepEqual(flat(mine).map((row) => row.id), ['mine', 'child'],
    'a watched conversation and its own child, and neither of the others')
  assert.deepEqual(mine.totals, { sessions: 1, running: 1, waiting: 0, subagents: 0 })

  const both = snapshotOf(registry, { ...options, watch: new Set(['mine', 'theirs']) })
  assert.deepEqual(flat(both).map((row) => row.id).sort(), ['child', 'mine', 'orphan', 'theirs'])
})

check('a turn starting is what the pet hears as "a conversation began"', () => {
  assert.deepEqual(decodeSessionEvent({ type: 'turn/start', data: { turn: 1 } }), {
    kind: 'turn-started',
  })
  assert.deepEqual(decodeSessionEvent({ type: 'turn/end', time: 9, data: { reason: { kind: 'completed' } } }), {
    kind: 'turn-ended',
    at: 9,
    outcome: 'completed',
  })
})

check('resolveConfig is total and clamps out-of-range values', () => {
  assert.equal(resolveConfig(undefined).port, 47600)
  assert.equal(resolveConfig({ port: -5 }).port, 1)
  assert.equal(resolveConfig({ port: 999999 }).port, 65535)
  assert.equal(resolveConfig({ port: 'nope' }).port, 47600)
  assert.equal(resolveConfig({ portAttempts: 0 }).portAttempts, 1)
  assert.deepEqual(resolveConfig({ petArgs: ['a', 'b'] }).petArgs, ['a', 'b'])
  assert.deepEqual(resolveConfig({ petArgs: ['a', 1] }).petArgs, [])
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ petExecutable: '  ' }).petExecutable, '')
})

check('the completion window is gone from the config', () => {
  const config = resolveConfig({ completionWindowMs: 5000 })
  assert.equal(
    Object.hasOwn(config, 'completionWindowMs'),
    false,
    'the unread mark has no clock, so the knob that set one had to go',
  )
})

check('appearance settings are not part of the plugin config', () => {
  const config = resolveConfig({ petScale: 1.5, petVisible: false, opacity: 0.5 })
  assert.equal(Object.hasOwn(config, 'petScale'), false)
  assert.equal(Object.hasOwn(config, 'petVisible'), false)
  assert.equal(Object.hasOwn(config, 'opacity'), false)
  assert.equal(config.port, 47600)
})

// --------------------------------------------------------------- settings

check('the settings patch clamps, ignores absent fields, and drops junk', () => {
  assert.deepEqual(decodeSettingsPatch({ scale: 9 }), { scale: 2 }, 'clamped, not rejected')
  assert.deepEqual(decodeSettingsPatch({ scale: 0.1 }), { scale: 0.6 })
  assert.deepEqual(decodeSettingsPatch({ fontScale: 1.4 }), { fontScale: 1.4 })
  assert.deepEqual(decodeSettingsPatch({ fontScale: 99 }), { fontScale: 1.6 })
  assert.deepEqual(decodeSettingsPatch({ visible: false }), { visible: false })
  assert.deepEqual(decodeSettingsPatch({ scale: 'big', opacity: null }), {}, 'unusable fields are omitted')
  assert.deepEqual(decodeSettingsPatch({ nope: 1 }), {}, 'unknown fields are not stored')
  assert.deepEqual(decodeSettingsPatch(null), {})
  assert.deepEqual(decodeSettingsPatch([1, 2]), {})
})

check('merging a patch keeps every field it did not name', () => {
  const current = { ...DEFAULT_SETTINGS, scale: 1.5, visible: false }
  assert.deepEqual(mergeSettings(current, { opacity: 0.5 }), {
    ...DEFAULT_SETTINGS,
    scale: 1.5,
    visible: false,
    opacity: 0.5,
  })
  assert.equal(mergeSettings(current, {}), current, 'an empty patch changes nothing')
})

check('sameSettings catches a difference in every field', () => {
  const base = { ...DEFAULT_SETTINGS }
  assert.equal(sameSettings(base, { ...base }), true)
  for (const key of Object.keys(base)) {
    const changed =
      typeof base[key] === 'boolean' ? !base[key] : base[key] === 1 ? 1.2 : base[key] + 0.1
    assert.equal(
      sameSettings(base, { ...base, [key]: changed }),
      false,
      `${key} must be part of the comparison`,
    )
  }
})

// ------------------------------------------------------------ focus mailbox

check('the focus mailbox offers a request and keeps it until acknowledged', () => {
  const mailbox = createFocusMailbox(300_000, 3_000)
  const at = 1_000_000
  mailbox.put('session-a', at)
  assert.deepEqual(mailbox.offer(at), { sessionId: 'session-a', at })
  assert.equal(mailbox.offer(at + 1), null, 'not re-offered inside the retry window')
  assert.deepEqual(
    mailbox.offer(at + 3_001),
    { sessionId: 'session-a', at },
    'an unacknowledged request is offered again',
  )
  assert.deepEqual(mailbox.outstanding(), { sessionId: 'session-a', at })
  assert.equal(mailbox.ack('session-b'), false, 'a different session does not clear it')
  assert.equal(mailbox.ack('session-a'), true)
  assert.equal(mailbox.offer(at + 10_000), null, 'and then it is gone')
})

check('the newest focus request wins', () => {
  const mailbox = createFocusMailbox()
  mailbox.put('first', 1_000)
  mailbox.put('second', 2_000)
  assert.equal(mailbox.offer(2_000).sessionId, 'second')
})

check('a focus request nobody collected goes stale, and stays gone', () => {
  const mailbox = createFocusMailbox(300_000, 3_000)
  mailbox.put('session-a', 1_000_000)
  assert.equal(mailbox.offer(1_000_000 + 300_001), null)
  assert.equal(mailbox.offer(1_000_000 + 300_002), null, 'and stays collected')
})

check('decodeFocusRequest needs a session and stamps its own time', () => {
  assert.deepEqual(decodeFocusRequest({ sessionId: 'x' }, 42), { sessionId: 'x', at: 42 })
  assert.deepEqual(decodeFocusRequest({ sessionId: 'x', at: 7 }, 42), { sessionId: 'x', at: 7 })
  assert.equal(decodeFocusRequest({}, 42), null)
  assert.equal(decodeFocusRequest({ sessionId: '' }, 42), null)
  assert.equal(decodeFocusRequest(null, 42), null)
})

// ------------------------------------------------------------ client state

check('the Workspace table decodes, dropping rows it cannot trust', () => {
  assert.deepEqual(
    decodeRegistryWorkspaces([
      { id: 'w1', path: 'D:\\work\\a', title: '甲', sessionIds: ['a', 'b'] },
      { id: 'w2', path: 'D:\\work\\b', sessionIds: [] },
      { id: 'w3', path: 'D:\\work\\c', title: '丙', sessionIds: ['c', 7, ''] },
      { id: 'no-path', title: 'x', sessionIds: [] },
      { path: 'D:\\work\\d', title: 'no id' },
      'garbage',
    ]),
    [
      { id: 'w1', path: 'D:\\work\\a', title: '甲', sessionIds: ['a', 'b'] },
      { id: 'w2', path: 'D:\\work\\b', title: '', sessionIds: [] },
      { id: 'w3', path: 'D:\\work\\c', title: '丙', sessionIds: ['c'] },
    ],
  )
  assert.deepEqual(decodeRegistryWorkspaces(undefined), [])
  assert.deepEqual(decodeRegistryWorkspaces('nope'), [])
})

check('a client report defaults to invisible when it is unreadable', () => {
  const state = decodeClientState({ sessionId: 'a', visible: true, at: 7 }, 1)
  assert.deepEqual(state, { sessionId: 'a', visible: true, at: 7 })
  assert.equal(decodeClientState({ sessionId: 'a' }, 1).visible, false, 'absent means not seen')
  assert.equal(decodeClientState({ visible: 'yes' }, 1).visible, false, 'mistyped means not seen')
  assert.equal(decodeClientState({ sessionId: 'a' }, 1).sessionId, 'a')
  assert.equal(decodeClientState({ sessionId: null }, 1).sessionId, null, 'an explicit null is a report')
  assert.equal(decodeClientState({}, 1), null, 'a body with neither field is not a report')
  assert.equal(decodeClientState({ at: 5 }, 1), null)
  assert.equal(decodeClientState(null, 1), null)
})

check('the watched set decodes, dropping ids it cannot trust', () => {
  assert.deepEqual(decodeWatchRequest({ ids: ['a', 'b'] }), { ids: ['a', 'b'] })
  assert.deepEqual(decodeWatchRequest({ ids: [] }), { ids: [] }, 'empty is a real answer')
  assert.deepEqual(decodeWatchRequest({ ids: ['a', 7, '', null, 'b'] }), { ids: ['a', 'b'] })
  assert.equal(decodeWatchRequest({}), null, 'no list at all is not a list')
  assert.equal(decodeWatchRequest({ ids: 'a' }), null)
  assert.equal(decodeWatchRequest(null), null)
})

check('a presence patch names exactly one thing', () => {
  assert.deepEqual(decodePresencePatch({ visible: true }), { visible: true })
  assert.deepEqual(decodePresencePatch({ visible: false }), { visible: false })
  assert.deepEqual(
    decodePresencePatch({ visible: true, extra: 1 }),
    { visible: true },
    'unknown fields are dropped',
  )
  assert.equal(decodePresencePatch({ visible: 'yes' }), null, 'a mistyped switch is not a switch')
  assert.equal(decodePresencePatch({}), null, 'neither button is a bad request, not a no-op')
  assert.equal(decodePresencePatch(null), null)
})

check('the presence route reads the pair, and refuses a verb it does not use', () => {
  const routes = new Map()
  let presence = { running: false, visible: true }
  const disposers = registerPresenceRoutes(
    {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    {
      read: () => presence,
      write: (patch) => {
        presence = { ...presence, visible: patch.visible }
        return presence
      },
    },
  )
  assert.deepEqual([...routes.keys()], [PET_PATH])
  assert.equal(disposers.length, 1)

  const replies = []
  const respond = {
    writeHead: (status) => replies.push({ status }),
    end: (body) => replies.push({ body }),
  }
  routes.get(PET_PATH).handler({ method: 'GET' }, respond)
  assert.equal(replies[0].status, 200)
  assert.deepEqual(JSON.parse(replies[1].body), { running: false, visible: true })

  replies.length = 0
  routes.get(PET_PATH).handler({ method: 'POST' }, respond)
  assert.equal(replies[0].status, 405, 'the page only ever reads or writes')
})

check('the focus routes answer the page, push, and accept reports', () => {
  const routes = new Map()
  const mailbox = createFocusMailbox(300_000, 3_000)
  const channel = createClientChannel()
  const reports = []
  const disposers = registerFocusRoutes(
    {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    { mailbox, channel, onClientState: (state) => reports.push(state) },
  )
  assert.deepEqual([...routes.keys()].sort(), [CLIENT_STATE_PATH, FOCUS_EVENTS_PATH, FOCUS_PATH].sort())
  assert.equal(disposers.length, 3)

  // The poll route still answers, and is throttled by the same retry window the
  // push uses — so a request is never handed out twice in the same window.
  const replies = []
  const respond = {
    writeHead: (status, headers) => replies.push({ status, headers }),
    end: (body) => replies.push({ body }),
  }
  mailbox.put('session-a', Date.now())
  routes.get(FOCUS_PATH).handler({}, respond)
  assert.equal(replies[0].status, 200)
  assert.deepEqual(JSON.parse(replies[1].body), mailbox.outstanding())
  replies.length = 0
  routes.get(FOCUS_PATH).handler({}, respond)
  assert.deepEqual(JSON.parse(replies[1].body), { sessionId: null, at: null }, 'not offered twice in a row')
})

check('the push route streams, and a request reaches every attached page', () => {
  const routes = new Map()
  const mailbox = createFocusMailbox()
  const channel = createClientChannel()
  registerFocusRoutes(
    {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    { mailbox, channel, onClientState: () => {} },
  )

  const written = []
  let closed = null
  const response = {
    writeHead: () => {},
    flushHeaders: () => {},
    write: (chunk) => written.push(chunk),
    end: () => {},
    on: () => {},
  }
  mailbox.put('session-a', Date.now())
  routes.get(FOCUS_EVENTS_PATH).handler({ on: (event, listener) => { closed = listener } }, response)
  assert.equal(channel.collectors(), 1)
  assert.match(written.join(''), /event: hello/)
  assert.match(written.join(''), /event: focus\ndata: \{"sessionId":"session-a"/)

  written.length = 0
  channel.publish({ sessionId: 'session-b', at: 1 })
  assert.match(written.join(''), /event: focus\ndata: \{"sessionId":"session-b"/)

  // The other thing worth saying to a page: "tell me again what you show".
  written.length = 0
  channel.requestState()
  assert.match(written.join(''), /event: state-request\ndata: \{\}/)

  closed()
  assert.equal(channel.collectors(), 0, 'a closed stream stops being pushed to')
  written.length = 0
  channel.requestState()
  assert.equal(written.length, 0, 'and nothing is sent to a page that left')
})

check('the client-state route refuses a verb that is not PUT', () => {
  const routes = new Map()
  registerFocusRoutes(
    {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    { mailbox: createFocusMailbox(), channel: createClientChannel(), onClientState: () => {} },
  )
  const replies = []
  routes.get(CLIENT_STATE_PATH).handler(
    { method: 'GET' },
    { writeHead: (status) => replies.push(status), end: () => {} },
  )
  assert.deepEqual(replies, [405])
})

check('sseFrame produces a well-formed frame', () => {
  assert.equal(sseFrame('snapshot', '{"a":1}'), 'event: snapshot\ndata: {"a":1}\n\n')
})

// ------------------------------------------------------------------- bridge

const TOKEN = 'smoke-token'
const PORT = 47999

const state = registryOf([
  { sessionId: 'run-1', cwd: 'D:\\work\\beta', running: true, updatedAt: 20 },
  { sessionId: 'idle-1', cwd: 'D:\\work\\alpha', updatedAt: 10 },
])
let latest = snapshotOf(state, optionsFor(state))

// The bridge does not own the settings; the runtime does. Stand in for it so
// the write path can be exercised without a Harness.
let liveSettings = { ...DEFAULT_SETTINGS }
const focusMailbox = createFocusMailbox()
let reviewed = []
let watched = []
const bridge = await startBridge({
  host: '127.0.0.1',
  port: PORT,
  portAttempts: 5,
  token: TOKEN,
  latest: () => latest,
  readSettings: () => liveSettings,
  updateSettings: (patch) => {
    liveSettings = mergeSettings(liveSettings, decodeSettingsPatch(patch))
    latest = snapshotOf(state, { ...optionsFor(state), settings: liveSettings })
    return liveSettings
  },
  requestFocus: (body) => {
    const request = decodeFocusRequest(body, Date.now())
    if (request === null) return null
    focusMailbox.put(request.sessionId, request.at)
    return request
  },
  reviewSession: (body) => {
    const id = body?.sessionId
    if (typeof id !== 'string' || id === '') return false
    reviewed.push(id)
    return true
  },
  setWatch: (body) => {
    const request = decodeWatchRequest(body)
    if (request === null) return false
    watched = request.ids
    latest = snapshotOf(state, { ...options, watch: new Set(watched), revision: 99 })
    return true
  },
  heartbeatMs: 60_000,
  log: silentLog,
})

const base = bridge.url

check('the bridge walks forward when a port is taken', () => {
  assert.equal(bridge.port, PORT)
})

const health = await fetch(`${base}/health`)
check('/health answers without a token', () => {
  assert.equal(health.status, 200)
})

const unauthorized = await fetch(`${base}/state`)
check('/state refuses a missing token', () => {
  assert.equal(unauthorized.status, 401)
})

const wrongToken = await fetch(`${base}/state?token=nope`)
check('/state refuses a wrong token', () => {
  assert.equal(wrongToken.status, 401)
})

const stateResponse = await fetch(`${base}/state`, { headers: { 'x-pet-token': TOKEN } })
const stateBody = await stateResponse.json()
check('/state returns the current snapshot with the right token', () => {
  assert.equal(stateResponse.status, 200)
  assert.equal(stateBody.version, 1)
  assert.deepEqual(stateBody.totals, { sessions: 2, running: 1, waiting: 0, subagents: 0 })
  assert.equal(stateBody.groups.length, 2, 'two directories, two groups')
  assert.equal(stateBody.groups[0].title, 'beta', 'newest activity leads')
  assert.equal(stateBody.groups[0].nodes[0].session.id, 'run-1')
})

const notFound = await fetch(`${base}/nope`, { headers: { 'x-pet-token': TOKEN } })
check('an unknown path is 404', () => {
  assert.equal(notFound.status, 404)
})

const methodNotAllowed = await fetch(`${base}/state`, { method: 'POST', headers: { 'x-pet-token': TOKEN } })
check('a non-GET verb is 405', () => {
  assert.equal(methodNotAllowed.status, 405)
})

// SSE: attach, read the hello frame, then read a published frame.
const controller = new AbortController()
const stream = await fetch(`${base}/events?token=${TOKEN}`, { signal: controller.signal })
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffered = ''

check('/state carries CORS headers so a shell on another origin may read it', () => {
  assert.equal(stateResponse.headers.get('access-control-allow-origin'), '*')
})

const preflight = await fetch(`${base}/state`, { method: 'OPTIONS' })
check('OPTIONS is answered as a preflight', () => {
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
})

// --- settings write path ---------------------------------------------------

const settingsRead = await fetch(`${base}/settings`, { headers: { 'x-pet-token': TOKEN } })
const settingsBody = await settingsRead.json()
check('GET /settings returns the settings in force', () => {
  assert.equal(settingsRead.status, 200)
  assert.deepEqual(settingsBody, DEFAULT_SETTINGS)
})

const unauthorizedWrite = await fetch(`${base}/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scale: 1.5 }),
})
check('PUT /settings refuses a missing token', () => {
  assert.equal(unauthorizedWrite.status, 401)
})

const write = await fetch(`${base}/settings`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ scale: 9, fontScale: 1.4, nope: true }),
})
const written = await write.json()
check('PUT /settings clamps, applies, and answers with the value in force', () => {
  assert.equal(write.status, 200)
  assert.equal(written.scale, 2, 'clamped on the way in')
  assert.equal(written.fontScale, 1.4)
  assert.equal(written.opacity, DEFAULT_SETTINGS.opacity, 'unnamed fields survive')
  assert.equal(Object.hasOwn(written, 'nope'), false)
})

const reread = await (await fetch(`${base}/settings`, { headers: { 'x-pet-token': TOKEN } })).json()
check('a write is visible to the next read', () => {
  assert.deepEqual(reread, written)
})

const malformed = await fetch(`${base}/settings`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: '{not json',
})
check('a malformed body is a 400, not a crash', () => {
  assert.equal(malformed.status, 400)
})

const stillAlive = await fetch(`${base}/health`)
check('the bridge survives a malformed write', () => {
  assert.equal(stillAlive.status, 200)
})

// --- focus -------------------------------------------------------------

const unauthorizedFocus = await fetch(`${base}/focus`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-a' }),
})
check('PUT /focus refuses a missing token', () => {
  assert.equal(unauthorizedFocus.status, 401)
})

const focusWrite = await fetch(`${base}/focus`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-a' }),
})
const focusBody = await focusWrite.json()
check('PUT /focus parks the request and says accepted, not done', () => {
  assert.equal(focusWrite.status, 202)
  assert.equal(focusBody.sessionId, 'session-a')
  assert.equal(typeof focusBody.at, 'number')
})

check('the parked request is what the DSH page would collect', () => {
  assert.equal(focusMailbox.outstanding().sessionId, 'session-a')
  assert.equal(focusMailbox.ack('session-a'), true)
  assert.equal(focusMailbox.outstanding(), null)
})

const focusNoSession = await fetch(`${base}/focus`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ nope: true }),
})
check('PUT /focus without a session is a 400', () => {
  assert.equal(focusNoSession.status, 400)
})

// --- review ------------------------------------------------------------

const unauthorizedReview = await fetch(`${base}/review`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'idle-1' }),
})
check('PUT /review refuses a missing token', () => {
  assert.equal(unauthorizedReview.status, 401)
})

const reviewWrite = await fetch(`${base}/review`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'idle-1' }),
})
check('PUT /review dismisses an unread result by hand', () => {
  assert.equal(reviewWrite.status, 200)
  assert.deepEqual(reviewed, ['idle-1'])
})

const reviewNoSession = await fetch(`${base}/review`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({}),
})
check('PUT /review without a session is a 400', () => {
  assert.equal(reviewNoSession.status, 400)
})

// --- watch -------------------------------------------------------------

const unauthorizedWatch = await fetch(`${base}/watch`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ids: ['run-1'] }),
})
check('PUT /watch refuses a missing token', () => {
  assert.equal(unauthorizedWatch.status, 401)
})

const watchWrite = await fetch(`${base}/watch`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ ids: ['run-1'] }),
})
check('PUT /watch replaces the watched set the pet curates', () => {
  assert.equal(watchWrite.status, 200)
  assert.deepEqual(watched, ['run-1'])
})

const watchEmpty = await fetch(`${base}/watch`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ ids: [] }),
})
check('an empty watched set is a legitimate value, not a missing one', () => {
  assert.equal(watchEmpty.status, 200)
  assert.deepEqual(watched, [], 'a first run sends exactly this')
})

const watchMalformed = await fetch(`${base}/watch`, {
  method: 'PUT',
  headers: { 'x-pet-token': TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify({ nope: true }),
})
check('PUT /watch without an id list is a 400', () => {
  assert.equal(watchMalformed.status, 400)
})

const readUntil = async (marker, limit = 40) => {
  for (let i = 0; i < limit; i += 1) {
    if (buffered.includes(marker)) return buffered
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
  }
  return buffered
}

check('/events is an event stream', () => {
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
})

await readUntil('event: hello')
check('/events opens with a hello frame carrying the current snapshot', () => {
  assert.match(buffered, /event: hello\ndata: \{"version":1/)
})

latest = snapshotOf(
  reduceRegistry(state, { kind: 'running', id: 'idle-1', running: true }),
  { ...options, revision: 2 },
)
bridge.publish(latest)
await readUntil('event: snapshot')
check('/events delivers a published snapshot frame', () => {
  assert.match(buffered, /event: snapshot\ndata: \{"version":1,"revision":2/)
})

controller.abort()
await bridge.close()

const afterClose = await fetch(`${base}/health`).then(
  () => 'still up',
  () => 'down',
)
check('close() releases the port', () => {
  assert.equal(afterClose, 'down')
})

// ------------------------------------------------------- the window process

// One release archive carries a binary per platform, so the choice of file is
// the whole installation contract: get it wrong and the plugin installs
// everywhere and opens a window nowhere.
const bundle = mkdtempSync(join(tmpdir(), 'pet-bundle-'))
const stage = (target, binary) => {
  mkdirSync(join(bundle, 'bin', target), { recursive: true })
  const file = join(bundle, 'bin', target, binary)
  writeFileSync(file, '')
  return file
}

check('a build is identified by platform-arch', () => {
  assert.equal(buildTarget('win32', 'x64'), 'win32-x64')
  assert.equal(buildTarget('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(binaryName('win32'), 'dsh-desktop-pet.exe')
  assert.equal(binaryName('linux'), 'dsh-desktop-pet')
})

check('the binary packaged for this platform is chosen', () => {
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
  ]) {
    rmSync(join(bundle, 'bin'), { recursive: true, force: true })
    const expected = stage(`${platform}-${arch}`, binaryName(platform))
    assert.equal(resolvePetExecutable('', bundle, platform, arch), expected, `${platform}-${arch}`)
  }
})

check('a flat bin/ from a hand-assembled build is still accepted', () => {
  rmSync(join(bundle, 'bin'), { recursive: true, force: true })
  mkdirSync(join(bundle, 'bin'), { recursive: true })
  const flat = join(bundle, 'bin', 'dsh-desktop-pet.exe')
  writeFileSync(flat, '')
  assert.equal(resolvePetExecutable('', bundle, 'win32', 'x64'), flat)
})

check('an explicitly configured executable wins over both', () => {
  assert.equal(resolvePetExecutable('/custom/pet', bundle, 'linux', 'x64'), '/custom/pet')
})

rmSync(bundle, { recursive: true, force: true })

console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSMOKE: FAILED' : '\nSMOKE: all checks passed')
