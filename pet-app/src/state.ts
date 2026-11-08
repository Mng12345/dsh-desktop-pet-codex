/**
 * The snapshot model: decoding and every derivation the panel renders.
 *
 * Mirrors the Host half's `core/types.ts` on purpose — the payload is the
 * contract between the two halves — and stays pure so the window can be
 * reasoned about without a socket.
 *
 * The tree arrives already built. Which Workspace a session belongs to, which
 * subagent hangs off which parent, and what order all of that reads in are
 * decided in the Host's pure core, where a test can reach them without a
 * screen; this module only turns them into words.
 *
 * @module state
 */

/**
 * How a session reads at a glance: four values, and no catch-all.
 *
 * Mirrors the Host's own union. A session blocked on the reader leads, live work
 * — its own or its subagents' — reads as running, a turn that ended well stays
 * completed until another turn supersedes it, and everything else reads as
 * stopped. There is deliberately no idle here: idleness is a property of a
 * Workspace, and the character's quiet pose is a scene rather than a phase.
 */
export type SessionPhase = 'waiting' | 'running' | 'completed' | 'stopped'

/** One session row as the Host publishes it. */
export type SessionView = {
  readonly id: string
  /** The conversation's own title, or `null` while it has none. */
  readonly title: string | null
  /** Directory basename when known, else `null`. */
  readonly label: string | null
  readonly phase: SessionPhase
  readonly running: boolean
  readonly isSubagent: boolean
  readonly subagentCount: number
  /**
   * Whether the Host will accept this row's removal.
   *
   * Carried rather than derived here: the window used to offer the control from
   * the phase alone, and a row it guessed wrong about showed a ✓ the Host then
   * refused.
   */
  readonly dismissible: boolean
  readonly lastTool: string | null
  /** Live answer tail, present only while the session has something to say. */
  readonly thought: string | null
  readonly thoughtKind: ThoughtKind | null
  readonly updatedAt: number
  readonly error: string | null
}

/** One session in the tree, with the subagents it spawned. */
export type SessionNode = {
  readonly session: SessionView
  readonly children: readonly SessionNode[]
}

/** One group of the tree: a DSH Workspace, or a directory when none claims it. */
export type SessionGroup = {
  readonly id: string
  /** `null` means the group has no name of its own; the window picks one. */
  readonly title: string | null
  readonly nodes: readonly SessionNode[]
  readonly updatedAt: number
}

/** Which part of a live answer a fragment came from. */
export type ThoughtKind = 'reasoning' | 'text'

/** Headline counters. */
export type PetTotals = {
  readonly sessions: number
  readonly running: number
  readonly waiting: number
  readonly subagents: number
}

/** Appearance settings, delivered with every snapshot. */
export type PetSettings = {
  readonly scale: number
  readonly fontScale: number
  readonly visible: boolean
  readonly opacity: number
  readonly showSessionList: boolean
  readonly alwaysOnTop: boolean
}

/** What to draw with when the snapshot says nothing usable. */
export const DEFAULT_SETTINGS: PetSettings = {
  scale: 1,
  fontScale: 1,
  visible: true,
  opacity: 0.94,
  showSessionList: true,
  alwaysOnTop: true,
}

/** The ranges the settings window's controls are built from. */
export const SETTINGS_RANGE = {
  scale: { min: 0.6, max: 2, step: 0.05 },
  fontScale: { min: 0.8, max: 1.6, step: 0.05 },
  opacity: { min: 0.3, max: 1, step: 0.02 },
} as const

/** The complete payload. */
export type PetSnapshot = {
  readonly version: number
  readonly revision: number
  readonly at: number
  readonly settings: PetSettings
  readonly totals: PetTotals
  readonly groups: readonly SessionGroup[]
  /**
   * The watched set the Host holds, or `null` before it has been told one.
   *
   * `null` is what makes writing this back to `localStorage` safe: the Host is
   * up before this window is, so its first snapshots describe a set nobody has
   * sent it yet — and persisting one of those would erase the reader's list on
   * every restart.
   */
  readonly watch: readonly string[] | null
}

/**
 * The character's mood order: lower wins, so attention beats activity beats
 * aftermath.
 *
 * No longer the list's sort — a group's rows are in time order — but she has one
 * face, so the roster still has to collapse to one mood. `stopped` outranking
 * `completed` is deliberate: a turn that did not finish is the thing worth
 * looking at first.
 */
export const PHASE_ORDER: Readonly<Record<SessionPhase, number>> = {
  waiting: 0,
  running: 1,
  stopped: 2,
  completed: 3,
}

const PHASES: ReadonlySet<string> = new Set(Object.keys(PHASE_ORDER))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const readNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const readBoolean = (value: unknown): boolean => value === true

/**
 * Decode one phase.
 *
 * A value this build does not know — an older Host's `idle`, or a phase a later
 * Host adds — reads as `stopped`: this vocabulary's "not running and not
 * finished", and the one answer that never claims work is still in flight.
 */
const readPhase = (value: unknown): SessionPhase =>
  typeof value === 'string' && PHASES.has(value) ? (value as SessionPhase) : 'stopped'

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum)

/**
 * Decode the appearance block.
 *
 * Clamped here as well as on the Host: the window is the last thing standing
 * between a hand-edited patch and an unusable frame, and a scale of 40 would
 * otherwise produce a window larger than the screen.
 *
 * @param raw - the settings member of a snapshot, or a `/settings` response.
 * @returns the settings to use; the defaults when nothing usable arrived.
 */
export const decodeSettings = (raw: unknown): PetSettings => {
  if (!isRecord(raw)) return DEFAULT_SETTINGS
  return {
    scale: clamp(readNumber(raw['scale']) || DEFAULT_SETTINGS.scale, 0.6, 2),
    fontScale: clamp(readNumber(raw['fontScale']) || DEFAULT_SETTINGS.fontScale, 0.8, 1.6),
    visible:
      typeof raw['visible'] === 'boolean' ? raw['visible'] : DEFAULT_SETTINGS.visible,
    opacity: clamp(readNumber(raw['opacity']) || DEFAULT_SETTINGS.opacity, 0.3, 1),
    showSessionList:
      typeof raw['showSessionList'] === 'boolean'
        ? raw['showSessionList']
        : DEFAULT_SETTINGS.showSessionList,
    alwaysOnTop:
      typeof raw['alwaysOnTop'] === 'boolean'
        ? raw['alwaysOnTop']
        : DEFAULT_SETTINGS.alwaysOnTop,
  }
}

const decodeThoughtKind = (value: unknown): ThoughtKind | null =>
  value === 'reasoning' || value === 'text' ? value : null

const decodeSession = (raw: unknown): SessionView | null => {
  if (!isRecord(raw)) return null
  const id = readString(raw['id'])
  if (id === null) return null
  return {
    id,
    title: readString(raw['title']),
    label: readString(raw['label']),
    phase: readPhase(raw['phase']),
    running: readBoolean(raw['running']),
    isSubagent: readBoolean(raw['isSubagent']),
    subagentCount: readNumber(raw['subagentCount']),
    // Decided by the Host, which knows the facts the window cannot see (whether
    // a result was ever recorded, whether the row is even in the watched set).
    // A missing field means a Host of another generation: no control, rather
    // than a control that cannot work.
    dismissible: readBoolean(raw['dismissible']),
    lastTool: readString(raw['lastTool']),
    thought: readString(raw['thought']),
    thoughtKind: decodeThoughtKind(raw['thoughtKind']),
    updatedAt: readNumber(raw['updatedAt']),
    error: readString(raw['error']),
  }
}

const decodeNode = (raw: unknown): SessionNode | null => {
  if (!isRecord(raw)) return null
  const session = decodeSession(raw['session'])
  if (session === null) return null
  const children = Array.isArray(raw['children']) ? raw['children'] : []
  return {
    session,
    children: children.flatMap((child) => {
      const decoded = decodeNode(child)
      return decoded === null ? [] : [decoded]
    }),
  }
}

const decodeGroup = (raw: unknown): SessionGroup | null => {
  if (!isRecord(raw)) return null
  const id = readString(raw['id'])
  if (id === null) return null
  const nodes = Array.isArray(raw['nodes']) ? raw['nodes'] : []
  return {
    id,
    title: readString(raw['title']),
    nodes: nodes.flatMap((node) => {
      const decoded = decodeNode(node)
      return decoded === null ? [] : [decoded]
    }),
    updatedAt: readNumber(raw['updatedAt']),
  }
}

/**
 * Decode a snapshot from the bridge.
 *
 * @param raw - a parsed SSE payload.
 * @returns the snapshot, or `null` when the payload is not usable.
 */
export const decodeSnapshot = (raw: unknown): PetSnapshot | null => {
  if (!isRecord(raw)) return null
  const groups = Array.isArray(raw['groups']) ? raw['groups'] : []
  const totals = isRecord(raw['totals']) ? raw['totals'] : {}
  const watch = raw['watch']
  return {
    version: readNumber(raw['version']),
    revision: readNumber(raw['revision']),
    at: readNumber(raw['at']),
    settings: decodeSettings(raw['settings']),
    totals: {
      sessions: readNumber(totals['sessions']),
      running: readNumber(totals['running']),
      waiting: readNumber(totals['waiting']),
      subagents: readNumber(totals['subagents']),
    },
    groups: groups.flatMap((group) => {
      const decoded = decodeGroup(group)
      return decoded === null ? [] : [decoded]
    }),
    // Absent or unusable stays `null` rather than becoming an empty list: the
    // two mean opposite things to the write-back, and only one of them is safe.
    watch: Array.isArray(watch)
      ? watch.flatMap((id) => (typeof id === 'string' && id !== '' ? [id] : []))
      : null,
  }
}

/** Every session in the tree, parents and subagents alike. */
export const everySession = (snapshot: PetSnapshot): readonly SessionView[] => {
  const sessions: SessionView[] = []
  const walk = (nodes: readonly SessionNode[]): void => {
    for (const node of nodes) {
      sessions.push(node.session)
      walk(node.children)
    }
  }
  for (const group of snapshot.groups) walk(group.nodes)
  return sessions
}

/**
 * The phase the sprite should express: the most urgent one on screen.
 *
 * A pet has one face, so the roster has to collapse to one mood. Attention
 * beats activity beats aftermath, which is exactly `PHASE_ORDER`. Subagents are
 * excluded: a child working is its parent working, and the parent's row is what
 * carries the meaning.
 *
 * @param snapshot - the current payload.
 * @returns the phase to animate, or `null` when the roster holds nothing — her
 *   own quiet state, which is a scene rather than a phase.
 */
export const dominantPhase = (snapshot: PetSnapshot): SessionPhase | null => {
  const ranked = everySession(snapshot)
    .filter((session) => !session.isSubagent)
    .toSorted((left, right) => PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase])
  return ranked[0]?.phase ?? null
}

/**
 * A row's display name.
 *
 * The same precedence DSH's own sidebar uses — the conversation's title, then
 * the directory, then a short id — so a session reads the same in both places.
 * The directory is now only a fallback rather than the name, which is what
 * makes two sessions in one directory tellable apart.
 *
 * @param session - the row.
 * @returns the text to draw.
 */
export const displayName = (session: SessionView): string =>
  session.title ?? session.label ?? session.id.slice(0, 8)

/**
 * A group's display name.
 *
 * @param group - the group.
 * @returns the Workspace's own title, or the first row's directory, or the
 *   ungrouped word when neither exists.
 */
export const groupName = (group: SessionGroup): string => {
  if (group.title !== null) return group.title
  for (const node of group.nodes) {
    if (node.session.label !== null) return node.session.label
  }
  return '未分组'
}

/**
 * A group's colour dot: the most urgent **live** phase it holds, or `idle`.
 *
 * Activity, not results. A Workspace whose conversations have all finished is
 * idle even while their rows are still on screen, which is what lets the dot
 * answer "is anything happening in here" while the header's counts answer "what
 * happened". Subagent rows are skipped for the same reason the mood skips them:
 * a child working is its parent working, and the parent is the row that carries
 * it.
 *
 * @param group - the group.
 * @returns `waiting` or `running` while something is live, else `idle`.
 */
export const groupPhase = (group: SessionGroup): SessionPhase | 'idle' => {
  let best: SessionPhase | null = null
  const walk = (nodes: readonly SessionNode[]): void => {
    for (const node of nodes) {
      const phase = node.session.phase
      if (
        !node.session.isSubagent &&
        (phase === 'waiting' || phase === 'running') &&
        (best === null || PHASE_ORDER[phase] < PHASE_ORDER[best])
      ) {
        best = phase
      }
      walk(node.children)
    }
  }
  walk(group.nodes)
  return best ?? 'idle'
}

/** Counts of parent conversations; children belong to their parent's result. */
const countsOf = (nodes: readonly SessionNode[]): Record<SessionPhase, number> => {
  const counts: Record<SessionPhase, number> = { waiting: 0, running: 0, completed: 0, stopped: 0 }
  const walk = (rows: readonly SessionNode[]): void => {
    for (const node of rows) {
      if (!node.session.isSubagent) counts[node.session.phase] += 1
      walk(node.children)
    }
  }
  walk(nodes)
  return counts
}

const snapshotCounts = (snapshot: PetSnapshot): Record<SessionPhase, number> =>
  countsOf(snapshot.groups.flatMap((group) => group.nodes))

const countParts = (counts: Readonly<Record<SessionPhase, number>>): string[] => {
  const parts: string[] = []
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} 在等你`)
  if (counts.running > 0) parts.push(`${String(counts.running)} 进行中`)
  if (counts.completed > 0) parts.push(`${String(counts.completed)} 已完成`)
  if (counts.stopped > 0) parts.push(`${String(counts.stopped)} 已停止`)
  return parts
}

/**
 * The words after a group's name: the same counts the headline uses.
 *
 * `全部空闲` survives only as the answer for a group with no rows at all. Every
 * real row carries one of the four phases, so an idle Workspace that still holds
 * results says so with its grey dot rather than by dropping its counts.
 */
export const groupCounts = (group: SessionGroup): string => {
  const parts = countParts(countsOf(group.nodes))
  return parts.length === 0 ? '全部空闲' : parts.join(' · ')
}

/** The number of parent conversations waiting or working. */
export const activeCount = (snapshot: PetSnapshot): number => {
  const counts = snapshotCounts(snapshot)
  return counts.waiting + counts.running
}

/** A phase whose count the headline can show: waiting gets a sentence of its own. */
export type HeadlinePhase = Exclude<SessionPhase, 'waiting'>

/** One coloured segment of the headline: how many sessions, and which phase they are in. */
export type HeadlineSegment = {
  readonly phase: HeadlinePhase
  readonly count: number
}

/**
 * The headline's shape, decided as one value rather than a number plus a suffix.
 *
 * `waiting` is a sentence on its own; `results` is the finished work, one
 * segment per phase that has any; `idle` is a roster with nothing to count.
 */
export type Headline =
  | { readonly kind: 'waiting'; readonly count: number }
  | { readonly kind: 'results'; readonly segments: readonly HeadlineSegment[] }
  | { readonly kind: 'idle' }

/** The phases the result segments walk, in reading order: done, doing, stopped. */
const HEADLINE_PHASES = ['completed', 'running', 'stopped'] as const

/**
 * The short word the headline gives a phase.
 *
 * Deliberately terser than `phaseLabel`, and its own vocabulary: `完成`/`进行`/
 * `停止` are three even two-character tags that fit one line, while the rows and
 * the subtitle can afford `已完成`/`进行中`/`已停止`. No other surface uses this.
 */
export const headlineWord = (phase: HeadlinePhase): string => {
  switch (phase) {
    case 'completed':
      return '完成'
    case 'running':
      return '进行'
    case 'stopped':
      return '停止'
  }
}

/**
 * The headline: a sentence while someone waits, otherwise one segment per
 * non-zero result, and only an empty roster is idle.
 *
 * Waiting wins outright instead of joining the segments: a question blocks the
 * work behind it, so a line that led with results would bury the one thing the
 * reader can act on. With nobody waiting, every phase that has a count gets its
 * own segment and a zero drops out rather than holding an empty slot.
 */
export const headline = (snapshot: PetSnapshot): Headline => {
  const counts = snapshotCounts(snapshot)
  if (counts.waiting > 0) return { kind: 'waiting', count: counts.waiting }
  const segments: HeadlineSegment[] = []
  for (const phase of HEADLINE_PHASES) {
    if (counts[phase] > 0) segments.push({ phase, count: counts[phase] })
  }
  return segments.length === 0 ? { kind: 'idle' } : { kind: 'results', segments }
}

/** Totals and each retained outcome, without changing the Host payload shape. */
export const subtitleOf = (snapshot: PetSnapshot): string => {
  const counts = snapshotCounts(snapshot)
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const parts = [`共 ${String(total)} 个会话`, ...countParts(counts)]
  if (snapshot.totals.subagents > 0) parts.push(`${String(snapshot.totals.subagents)} 个子代理`)
  return parts.join(' · ')
}

/** The short Chinese word for a phase. */
export const phaseLabel = (phase: SessionPhase): string => {
  switch (phase) {
    case 'waiting':
      return '等你'
    case 'running':
      return '运行中'
    case 'completed':
      return '已完成'
    case 'stopped':
      return '已停止'
  }
}

/**
 * Last tools describe activity; every settled or blocked row names its phase.
 *
 * Only a *running* row gets the tool name. A row waiting on the reader says
 * "等你" whatever it is waiting for: the tool behind a question is always the
 * same `ask_user_question`, which tells the reader nothing, and a row that says
 * what it needs is worth more than one that says what it called.
 */
export const rowDetail = (session: SessionView): string =>
  session.phase === 'running'
    ? session.lastTool ?? phaseLabel(session.phase)
    : phaseLabel(session.phase)

/**
 * Whether the row offers its removal control.
 *
 * The Host's answer, verbatim. It owns the watched set and the facts behind it —
 * whether a result was ever recorded, whether a child is still busy — so the
 * control appears exactly where a click will work, and a row the Host would
 * refuse shows nothing instead of a button that does nothing.
 */
export const canDismiss = (session: SessionView): boolean => session.dismissible === true
