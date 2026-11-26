/**
 * The roster window: the pet's status surface, and the pair's control half.
 *
 * It hangs above the character window and is positioned by the Rust half from
 * that window's place, so nothing here computes geometry. What it owns is the
 * roster itself — the tree of Workspaces and their sessions, the fold, and the
 * appearance settings that describe a surface rather than a sprite.
 *
 * The tree arrives already grouped and ordered, so this module only turns it
 * into elements. Two view states are genuinely its own: which groups the reader
 * has folded, and which rows are mid-click.
 *
 * @module roster
 */

import { connect, requestFocus, requestReview, sendWatch, type BridgeStatus } from './bridge.js'
import { installContextMenu } from './context-menu.js'
import {
  canDismiss,
  childWaiting,
  childrenLabel,
  clockMs,
  displayName,
  dominantPhase,
  elapsedTier,
  formatElapsed,
  groupCounts,
  groupName,
  groupPhase,
  headline as headlineOf,
  headlineWord,
  rowDetail,
  stepClock,
  subtitleOf,
  type Headline,
  type PetSettings,
  type PetSnapshot,
  type SessionGroup,
  type SessionNode,
  type SessionView,
  type TurnClock,
} from './state.js'
import {
  endpoint,
  focusApp,
  isFront,
  isHosted,
  savePosition,
  setAlwaysOnTop,
  setRosterShown,
  setRosterSize,
  setVisible,
  startDrag,
  type FocusOutcome,
} from './tauri.js'

/**
 * The card's own margin, from `style.css`, added back when sizing the frame.
 */
const CARD_MARGIN = 6

/**
 * Where the fold is remembered.
 *
 * Deliberately not an appearance setting. `showSessionList` decides whether this
 * window exists at all; this decides only whether its body is unfolded, and it
 * is a view of this window rather than a value the settings window has to agree
 * with. That is the one exception to "the window owns no preferences", and it
 * costs nothing: the fold is remembered locally and nothing else reads it.
 */
const FOLD_KEY = 'desktop-pet:roster-folded'

/** Where the collapsed groups are remembered, by group id. */
const GROUPS_KEY = 'desktop-pet:roster-groups'

/**
 * Where the rows whose subagents are unfolded are remembered, by session id.
 *
 * A set of *open* parents rather than collapsed ones, so a conversation the pet
 * has never seen starts folded: children are noise by default, and only an
 * explicit unfold is remembered.
 */
const OPEN_KEY = 'desktop-pet:roster-open'

/**
 * Where the watched set lives.
 *
 * This window's `localStorage` mirrors the Host's authoritative watched set.
 * It is sent when the stream attaches so the Host can recover a saved list;
 * subsequent snapshots decide which ids remain, including confirmed removals.
 */
const WATCH_KEY = 'desktop-pet:watch'

/**
 * Read the watched set.
 *
 * A missing key and an empty array both mean "nothing watched", and that is
 * deliberate rather than sloppy: an empty set is seeded from whatever is running
 * at the time, whether it is empty because this is a first run or because the
 * reader emptied it. One rule, and no bookkeeping to tell the two apart.
 *
 * @returns the ids on disk, or an empty list when there is nothing readable.
 */
const readWatch = (): readonly string[] => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(WATCH_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string' && id !== '') : []
  } catch {
    return []
  }
}

const writeWatch = (ids: readonly string[]): void => {
  try {
    window.localStorage.setItem(WATCH_KEY, JSON.stringify(ids))
  } catch {
    // Remembering is best-effort; the Host still has the set in memory.
  }
}

const card = document.getElementById('card')
const headline = document.getElementById('headline')
const subtitle = document.getElementById('subtitle')
const sessions = document.getElementById('sessions')
const listToggle = document.getElementById('list-toggle')

if (
  card === null ||
  headline === null ||
  subtitle === null ||
  sessions === null ||
  !(listToggle instanceof HTMLButtonElement)
) {
  throw new Error('desktop pet: the roster window shell is incomplete')
}

installContextMenu()

// --- the tree ---------------------------------------------------------------

/**
 * Which groups the reader has folded.
 *
 * A set of *folded* ids rather than expanded ones, so a Workspace the pet has
 * never seen before starts open: the default is what the reader asked for, and
 * only an explicit fold is remembered.
 */
let foldedGroups = new Set<string>()
try {
  const stored = JSON.parse(window.localStorage.getItem(GROUPS_KEY) ?? '[]')
  if (Array.isArray(stored)) foldedGroups = new Set(stored.filter((id) => typeof id === 'string'))
} catch {
  // Storage can be refused, or hold something older; an open tree is a fine
  // fallback and the next fold rewrites it.
}

const rememberGroups = (): void => {
  try {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify([...foldedGroups]))
  } catch {
    // Remembering is best-effort.
  }
}

/**
 * Which parents the reader has unfolded, so their subagents show.
 *
 * Folded is the default for children and open is the default for groups, which
 * is the whole difference between the two: a Workspace is a place to look, a
 * subagent is an explanation of one row.
 */
let openParents = new Set<string>()
try {
  const stored = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? '[]')
  if (Array.isArray(stored)) openParents = new Set(stored.filter((id) => typeof id === 'string'))
} catch {
  // Storage can be refused; folded is the default anyway.
}

const rememberOpen = (): void => {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify([...openParents]))
  } catch {
    // Remembering is best-effort.
  }
}

/**
 * Build one session row.
 *
 * The head is the row's name — the conversation's title, falling back to its
 * directory and then to a short id — with the live tool or phase beside it, and
 * a second line carrying what the session is thinking or last thought. A parent
 * with a retained result carries the control to remove it from the pet.
 *
 * `data-focus` is both the click target and the drag opt-out: a row that starts
 * a window drag could never be clicked.
 */
const toRow = (node: SessionNode, nested: boolean): HTMLLIElement => {
  const session = node.session
  const row = document.createElement('li')
  row.dataset['phase'] = session.phase
  row.dataset['focus'] = session.id
  if (nested) row.dataset['nested'] = 'true'
  row.title =
    session.label === null
      ? `在 DSH 中打开 ${displayName(session)}`
      : `${displayName(session)}\n${session.label}`

  const head = document.createElement('div')
  head.className = 'row-head'

  const dot = document.createElement('span')
  dot.className = 'dot'

  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = displayName(session)

  const detail = document.createElement('span')
  detail.className = 'tool'
  detail.textContent = rowDetail(session)

  head.append(dot, name)

  const count = node.children.length
  // A row blocked on the reader itself already says so; the badge would only
  // repeat it. Below that, the badge is the one place a child's question can
  // surface, because the Host keeps a child's `waiting` to itself.
  const waiting = session.phase !== 'waiting' && childWaiting(node)
  if (count > 0) {
    const open = openParents.has(session.id)
    if (waiting) row.dataset['childWaiting'] = 'true'
    const badge = document.createElement('button')
    badge.type = 'button'
    badge.className = 'children'
    badge.dataset['toggleChildren'] = session.id
    badge.setAttribute('aria-expanded', open ? 'true' : 'false')
    badge.title = open ? '收起子代理' : `展开 ${String(count)} 个子代理`
    badge.textContent = `${childrenLabel(count)} ${open ? '▴' : '▾'}`
    head.append(badge)
  }

  head.append(detail)
  row.append(head)

  if (waiting) {
    // Its own line rather than a suffix on the status: with a badge, a status and
    // a stopwatch already on the head, one more phrase squeezed the name to a
    // few characters.
    const note = document.createElement('div')
    note.className = 'child-wait'
    note.textContent = '子代理等你'
    row.append(note)
  }

  if (session.thought !== null) {
    row.dataset['thought'] = session.thoughtKind ?? 'text'
    const thought = document.createElement('div')
    thought.className = 'thought'
    // Collapse the model's newlines so one row stays one line.
    thought.textContent = session.thought.replace(/\s+/gu, ' ').trim()
    thought.title = session.thought
    row.append(thought)
  }

  if (canDismiss(session)) {
    // The Host validates the current phase and removes the watched parent.
    // Keep the row until its authoritative snapshot confirms that removal.
    row.dataset['dismissible'] = 'true'
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'dismiss'
    dismiss.dataset['review'] = session.id
    dismiss.title = '从桌宠移除'
    dismiss.setAttribute('aria-label', `从桌宠移除 ${displayName(session)}`)
    dismiss.textContent = '✓'
    head.append(dismiss)
  }
  return row
}

/**
 * Build one node and, when the reader unfolded it, its subagents — depth first.
 *
 * Folded is the default: a delegation leaves one row per subagent behind, and a
 * finished subagent never leaves on its own, so an unfolded tree is mostly
 * history. The badge on the parent is what says the history is there.
 */
const toNode = (node: SessionNode): HTMLLIElement[] => {
  const rows = [toRow(node, false)]
  if (!openParents.has(node.session.id)) return rows
  for (const child of node.children) {
    for (const element of toNode(child)) {
      element.dataset['nested'] = 'true'
      rows.push(element)
    }
  }
  return rows
}

/**
 * Build one group: a header the reader can fold, and its rows.
 *
 * The header carries the count summary as well as the colour, because the
 * colour alone says "something needs you" without saying how much — and after
 * the sort was made time-based inside a group, a reader scanning a long tree
 * needs the number more than the hue.
 */
const toGroup = (group: SessionGroup): HTMLElement => {
  const section = document.createElement('section')
  section.className = 'group'
  section.dataset['group'] = group.id
  section.dataset['phase'] = groupPhase(group)

  const folded = foldedGroups.has(group.id)
  section.dataset['folded'] = folded ? 'true' : 'false'

  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'group-head'
  header.dataset['toggleGroup'] = group.id
  header.setAttribute('aria-expanded', folded ? 'false' : 'true')

  const dot = document.createElement('span')
  dot.className = 'dot'

  const name = document.createElement('span')
  name.className = 'group-name'
  name.textContent = groupName(group)
  name.title = groupName(group)

  const counts = document.createElement('span')
  counts.className = 'group-counts'
  counts.textContent = groupCounts(group)
  counts.title = counts.textContent

  const chevron = document.createElement('span')
  chevron.className = 'chevron'
  chevron.textContent = folded ? '▸' : '▾'

  header.append(dot, name, counts, chevron)

  const body = document.createElement('ul')
  body.className = 'group-body'
  body.append(...group.nodes.flatMap(toNode))

  section.append(header, body)
  return section
}

/**
 * Build the headline's line: one sentence while someone waits, coloured
 * segments for the results, or the quiet word when there is nothing to count.
 *
 * The waiting sentence keeps the old shape — a number and the words after it —
 * because a question reads as a sentence rather than as one more tag. Results
 * are segments so each phase can wear the colour that owns it; the middots
 * between them stay dim punctuation so the counts keep the eye.
 */
const headlineNodes = (top: Headline): readonly Node[] => {
  if (top.kind === 'waiting') {
    const number = document.createElement('span')
    number.className = 'headline-number'
    number.textContent = String(top.count)
    return [number, document.createTextNode(' 个会话在等你')]
  }
  if (top.kind === 'idle') return [document.createTextNode('全部空闲')]
  const nodes: Node[] = []
  for (const [index, segment] of top.segments.entries()) {
    if (index > 0) {
      const separator = document.createElement('span')
      separator.className = 'headline-sep'
      separator.textContent = ' · '
      nodes.push(separator)
    }
    const part = document.createElement('span')
    part.className = 'headline-seg'
    part.dataset['phase'] = segment.phase
    part.textContent = `${String(segment.count)} ${headlineWord(segment.phase)}`
    nodes.push(part)
  }
  return nodes
}

// --- the turn's stopwatch ---------------------------------------------------

/**
 * This window's clocks, by session.
 *
 * The state machine that advances them is pure and lives in `state.js`; what is
 * genuinely this window's is only the map, and the fact that it dies with the
 * process: after a restart the prompt watermark is the only seed there is.
 */
const clocks = new Map<string, TurnClock>()

/**
 * Advance one session's clock on a snapshot.
 *
 * @param session - the row this paint is about.
 * @param now - this window's clock.
 */
const paceClock = (session: SessionView, now: number): void => {
  clocks.set(session.id, stepClock(clocks.get(session.id), session, now))
}

/** Walk a group tree, pacing every row and recording which ids are still here. */
const paceTree = (nodes: readonly SessionNode[], now: number, seen: Set<string>): void => {
  for (const node of nodes) {
    paceClock(node.session, now)
    seen.add(node.session.id)
    paceTree(node.children, now, seen)
  }
}

/**
 * Write every visible row's stopwatch, creating or dropping the label as needed.
 *
 * Only the label is touched, so a once-a-second repaint cannot disturb the row's
 * name, its hover state, or a fold in progress.
 *
 * @param now - this window's clock.
 */
const paintClocks = (now: number): void => {
  for (const row of sessions.querySelectorAll<HTMLElement>('[data-focus]')) {
    const tool = row.querySelector<HTMLElement>('.tool')
    const id = row.dataset['focus']
    if (tool === null || id === undefined) continue
    const clock = clocks.get(id)
    const elapsed = clock === undefined ? null : clockMs(clock, now)
    const existing = tool.querySelector<HTMLElement>('.elapsed')
    if (elapsed === null) {
      existing?.remove()
      continue
    }
    const label = existing ?? document.createElement('span')
    if (existing === null) {
      label.className = 'elapsed'
      tool.append(label)
    }
    label.textContent = ` · ${formatElapsed(elapsed)}`
    label.dataset['tier'] = elapsedTier(elapsed)
  }
}

/** The last snapshot painted, so a fold can redraw without waiting for the Host. */
let latest: PetSnapshot | null = null

/** Paint one snapshot. */
const render = (snapshot: PetSnapshot): void => {
  latest = snapshot
  const top = headlineOf(snapshot)
  applySettings(snapshot.settings)
  const phase = dominantPhase(snapshot)
  // The quiet look is a scene name rather than a phase: `null` means the roster
  // holds nothing, and the accent goes grey.
  document.body.dataset['phase'] = phase ?? 'idle'
  document.body.dataset['connected'] = 'true'
  headline.replaceChildren(...headlineNodes(top))
  subtitle.textContent = subtitleOf(snapshot)
  subtitle.title = subtitle.textContent
  const now = Date.now()
  const seen = new Set<string>()
  paceTree(snapshot.groups.flatMap((group) => group.nodes), now, seen)
  // A session that left the watched set takes its clock with it; keeping it
  // would resurrect a stale reading if the same id came back.
  for (const id of clocks.keys()) if (!seen.has(id)) clocks.delete(id)
  sessions.replaceChildren(...snapshot.groups.map(toGroup))
  paintClocks(now)
  // The Host is the authority on the set once it has one, so its answer is what
  // gets remembered — including the seed it added on a first run, which this
  // window could not have known about. `null` means it has not been told yet,
  // and writing that would erase the list on every restart.
  if (snapshot.watch !== null) writeWatch(snapshot.watch)
  syncFrame()
}

// A stopwatch has to tick without a snapshot: the Host only speaks when
// something changes, and "still working" is not a change.
window.setInterval(() => { paintClocks(Date.now()) }, 1000)

/** Paint the connection state, leaving the last roster visible while it retries. */
const applyStatus = (status: BridgeStatus): void => {
  document.body.dataset['connected'] = status === 'live' ? 'true' : 'false'
  if (status === 'live') return
  subtitle.textContent = status === 'connecting' ? '正在连接 DSH…' : '未连接 DSH'
}

// --- settings and frame mechanics ------------------------------------------

/** What the shell has already been told, so nothing is re-sent needlessly. */
let applied: PetSettings | null = null
let frame = { width: 0, height: 0 }

const sameSettings = (left: PetSettings, right: PetSettings): boolean =>
  left.fontScale === right.fontScale &&
  left.visible === right.visible &&
  left.opacity === right.opacity &&
  left.showSessionList === right.showSessionList &&
  left.alwaysOnTop === right.alwaysOnTop

/**
 * Apply the appearance settings this window owns.
 *
 * Visibility and always-on-top are applied here rather than in the character
 * window because both are commands for the *pair*: sending them from both pages
 * would be two windows racing to say the same thing.
 *
 * @param settings - the appearance block from the latest snapshot.
 */
const applySettings = (settings: PetSettings): void => {
  if (applied !== null && sameSettings(applied, settings)) return
  const previous = applied
  applied = settings
  document.body.dataset['list'] = settings.showSessionList ? 'true' : 'false'
  card.style.setProperty('--font-scale', String(settings.fontScale))
  card.style.setProperty('--opacity', String(settings.opacity))
  if (previous === null || previous.alwaysOnTop !== settings.alwaysOnTop) {
    void setAlwaysOnTop(settings.alwaysOnTop).catch(() => {})
  }
  if (previous === null || previous.visible !== settings.visible) {
    // Hiding keeps the process and the bridge alive, so the switch back is
    // instant and no state has to be rebuilt.
    void setVisible(settings.visible).catch(() => {})
  }
  // "Just the pet" is now literally this window not being there, and it must be
  // re-asserted whenever either half of that combination changes: showing the
  // pair shows this window too.
  if (
    previous === null ||
    previous.showSessionList !== settings.showSessionList ||
    previous.visible !== settings.visible
  ) {
    void setRosterShown(settings.visible && settings.showSessionList).catch(() => {})
  }
}

/**
 * Resize this window to the card, so the frame matches what is drawn.
 *
 * The card's margin is added back: `getBoundingClientRect` reports the border
 * box, and a frame sized to that alone would clip the shadow — and five pixels
 * of the card's right edge.
 *
 * The tree scrolls inside a fixed height, so this stops growing once the card
 * hits its own maximum — which is what keeps a long roster from walking off the
 * top of the screen, since the pair's anchor is the pet's position and the
 * roster grows upward from it.
 *
 * The patch is `roster_set_size`, which re-hangs the window in the same call:
 * the roster's bottom edge is the anchor, so growing downwards for a frame
 * before being moved back would be visible on every unfold.
 */
const syncFrame = (): void => {
  const box = card.getBoundingClientRect()
  const width = Math.ceil(box.width + CARD_MARGIN * 2)
  const height = Math.ceil(box.height + CARD_MARGIN * 2)
  if (width === frame.width && height === frame.height) return
  frame = { width, height }
  void setRosterSize(width, height).catch(() => {})
}

// --- the fold ---------------------------------------------------------------

let folded = false
try {
  folded = window.localStorage.getItem(FOLD_KEY) === 'true'
} catch {
  // Storage can be refused; an unfolded roster is a fine fallback.
}

const paintFold = (): void => {
  document.body.dataset['listCollapsed'] = folded ? 'true' : 'false'
  listToggle.textContent = folded ? '▸' : '▾'
  listToggle.setAttribute('aria-expanded', folded ? 'false' : 'true')
}

listToggle.addEventListener('click', () => {
  folded = !folded
  paintFold()
  try {
    window.localStorage.setItem(FOLD_KEY, String(folded))
  } catch {
    // Remembering is best-effort.
  }
  syncFrame()
})

paintFold()

// --- input ------------------------------------------------------------------

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
 * Dragging the list drags the pet with it — the Rust half keeps the two in step
 * — so this is the same gesture as dragging the character, from the other end.
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

card.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  // A session row is a button, not a handle: dragging from it would swallow
  // the click that is supposed to open that session. The same bargain covers
  // the fold arrow, the group headers, and the dismiss control — every one of
  // them is a click target first.
  if (event.target instanceof Element && event.target.closest('[data-focus]') !== null) return
  if (event.target instanceof Element && event.target.closest('[data-toggle]') !== null) return
  if (event.target instanceof Element && event.target.closest('[data-toggle-group]') !== null) return
  if (event.target instanceof Element && event.target.closest('[data-review]') !== null) return
  beginDrag()
})

window.addEventListener('pointerup', () => {
  void savePosition().catch(() => {})
  stopDragPoll()
})

// --- opening a session ------------------------------------------------------

/** Where to send focus requests, resolved once at boot. */
let host: Awaited<ReturnType<typeof endpoint>> | null = null

/**
 * How long "the window did not come forward" stays in the hint line.
 *
 * Long enough to be read after the click, short enough that it cannot outlive
 * the moment it describes: the flag used to be cleared only by the *next*
 * successful raise, so one refused click left the hint line altered until the
 * user happened to click a row again.
 */
const RAISE_FAILED_LINGER = 8000

/** The pending expiry of the refusal message, so a second one replaces it. */
let raiseFailedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Say whether the window came forward, and let the answer expire.
 *
 * @param outcome - what `pet_focus_app` reported.
 */
const reportRaise = (outcome: FocusOutcome): void => {
  if (raiseFailedTimer !== null) {
    clearTimeout(raiseFailedTimer)
    raiseFailedTimer = null
  }
  if (isFront(outcome)) {
    delete document.body.dataset['raiseFailed']
    return
  }
  document.body.dataset['raiseFailed'] = 'true'
  raiseFailedTimer = setTimeout(() => {
    delete document.body.dataset['raiseFailed']
    raiseFailedTimer = null
  }, RAISE_FAILED_LINGER)
}

/**
 * Open one session in the DSH window.
 *
 * Two independent halves, deliberately not sequenced: raising the window is the
 * pet's job, and switching the session is the plugin's browser half reacting to
 * the push. Waiting for one to confirm the other would only add latency — the
 * window comes forward either way, and the session is selected a moment later.
 *
 * The raise's answer is no longer thrown away. `SetForegroundWindow` can be
 * refused by the shell, and when it is, the session still switches in the
 * background — so the honest thing is to say the window did not come forward
 * rather than to pretend the click did nothing.
 */
const openSession = (sessionId: string): void => {
  void focusApp().then(reportRaise).catch(() => {})
  if (host === null) return
  void requestFocus(host, sessionId).catch(() => {})
}

sessions.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  // Unfolding is a click on the badge, not on the row: the row's own click opens
  // the conversation, and the badge sits inside it.
  const toggle = event.target.closest('[data-toggle-children]')
  const toggleId = toggle?.getAttribute('data-toggle-children')
  if (typeof toggleId === 'string' && toggleId !== '') {
    if (openParents.has(toggleId)) openParents.delete(toggleId)
    else openParents.add(toggleId)
    rememberOpen()
    if (latest !== null) render(latest)
    return
  }
  const dismiss = event.target.closest('[data-review]')
  const dismissId = dismiss?.getAttribute('data-review')
  if (typeof dismissId === 'string' && dismissId !== '') {
    if (host !== null) void requestReview(host, dismissId).catch(() => {})
    return
  }
  const row = event.target.closest('[data-focus]')
  const sessionId = row?.getAttribute('data-focus')
  if (typeof sessionId === 'string' && sessionId !== '') openSession(sessionId)
})

sessions.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const toggle = event.target.closest('[data-toggle-group]')
  const groupId = toggle?.getAttribute('data-toggle-group')
  if (typeof groupId !== 'string' || groupId === '') return
  if (foldedGroups.has(groupId)) foldedGroups.delete(groupId)
  else foldedGroups.add(groupId)
  rememberGroups()
  const section = sessions.querySelector(`[data-group="${CSS.escape(groupId)}"]`)
  if (section instanceof HTMLElement) {
    const nowFolded = foldedGroups.has(groupId)
    section.dataset['folded'] = nowFolded ? 'true' : 'false'
    const chevron = section.querySelector('.chevron')
    if (chevron !== null) chevron.textContent = nowFolded ? '▸' : '▾'
    toggle?.setAttribute('aria-expanded', nowFolded ? 'false' : 'true')
  }
  syncFrame()
})

// --- boot -------------------------------------------------------------------

const boot = async (): Promise<void> => {
  syncFrame()
  new ResizeObserver(syncFrame).observe(card)

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
    host = target
    connect({
      endpoint: target,
      onSnapshot: render,
      onStatus: applyStatus,
      // Every attach, not just the first: the Host holds the watched set in
      // memory, so a Host restart loses it — and this frame is exactly when it
      // comes back.
      onAttach: () => {
        void sendWatch(target, readWatch()).catch(() => {})
      },
    })
  } catch {
    applyStatus('offline')
  }
}

void boot()
