/**
 * Derivations: roster in, display-ready values out.
 *
 * Everything here is pure and clock-injected. The pet asks "what does the
 * roster look like *now*", so time arrives as an option rather than being read
 * from a global — which keeps the whole module deterministic under test and
 * lets the Host half publish on a schedule it controls.
 *
 * The tree is built here rather than in the window for the same reason: which
 * Workspace a session belongs to, which subagent hangs off which parent, and
 * what order all of that reads in are decisions, and decisions belong where a
 * test can reach them without a screen.
 *
 * @module core/derive
 */
import { retained, watchList } from './watch.js';
/**
 * The last path segment, tolerating both separators and trailing slashes.
 *
 * Trailing separators are stripped first, so the rule is uniform: the label is
 * whatever follows the final separator. A drive root therefore reads as `C:`
 * — a usable label — while a separator-only path has nothing left to show.
 *
 * @param path - an absolute directory path from a session header.
 * @returns the basename, or `null` when the path has no segment to show.
 */
export const basename = (path) => {
    const trimmed = path.replace(/[\\/]+$/u, '');
    if (trimmed.length === 0)
        return null;
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const name = index === -1 ? trimmed : trimmed.slice(index + 1);
    return name.length === 0 ? null : name;
};
/**
 * Collapse one session's facts into its phase.
 *
 * The order is the whole point: a session blocked on the human is the thing
 * worth interrupting someone for, so it wins over one that is merely busy, and
 * live work wins over a result the row is already carrying.
 *
 * Subagents fold into `running` rather than getting a phase of their own: a
 * child working is its parent working, and the row is what tells the two apart.
 * Everything that is neither live work nor a completed turn is `stopped` — an
 * error, an interruption, a blocked turn, or a history whose end nobody
 * observed. There is no idle case: a session that is not running has a result,
 * and idleness belongs to the Workspace.
 *
 * @param facts - the session's facts.
 * @param subagentCount - its running direct children.
 * @returns the phase to display.
 */
export const phaseOf = (facts, subagentCount) => {
    if (facts.pending !== null)
        return 'waiting';
    if (facts.running)
        return 'running';
    if (subagentCount > 0)
        return 'running';
    return facts.lastOutcome === 'completed' ? 'completed' : 'stopped';
};
/**
 * Count running direct children per parent, in one pass over the roster.
 *
 * @param byId - the roster's rows.
 * @returns parent id to running-child count, for parents that have any.
 */
const runningChildren = (byId) => {
    const counts = new Map();
    for (const facts of byId.values()) {
        if (!facts.isSubagent || !facts.running || facts.parentId === null)
            continue;
        counts.set(facts.parentId, (counts.get(facts.parentId) ?? 0) + 1);
    }
    return counts;
};
/**
 * Count the children that keep a parent in place, in one pass over the roster.
 *
 * Running *or* blocked on the human: either way the parent is not finished with
 * its children, which is what the removal rule reads.
 *
 * @param byId - the roster's rows.
 * @returns parent id to busy-child count, for parents that have any.
 */
const busyChildrenOf = (byId) => {
    const counts = new Map();
    for (const facts of byId.values()) {
        if (facts.parentId === null)
            continue;
        if (!facts.running && facts.pending === null)
            continue;
        counts.set(facts.parentId, (counts.get(facts.parentId) ?? 0) + 1);
    }
    return counts;
};
/**
 * Whether the reader may take this row out of the pet.
 *
 * One predicate, read by the view that draws the control and by the Host that
 * does the removal. They were separate once, and the difference was a ✓ drawn on
 * a row the Host then refused — with nothing on screen to say why.
 *
 * It says nothing about the watched set: membership is the runtime's, and a row
 * is only drawn when it is in the set.
 *
 * @param facts - the session's facts.
 * @param busyChildren - how many of its children are running or blocked.
 * @returns whether the row can be dismissed.
 */
export const dismissibleRoot = (facts, busyChildren) => !facts.isSubagent &&
    !facts.running &&
    facts.pending === null &&
    busyChildren === 0 &&
    !(facts.lastOutcome === null && facts.blank);
/** Project one row into the shape the window renders. */
const toView = (facts, phase, subagentCount, dismissible) => ({
    id: facts.id,
    title: facts.title,
    label: facts.cwd === null ? null : basename(facts.cwd),
    phase,
    running: facts.running,
    isSubagent: facts.isSubagent,
    subagentCount,
    dismissible,
    lastTool: facts.lastTool,
    // A successful result may keep its final sentence. Stopped rows must not
    // present an earlier thought as if it described their result.
    thought: facts.thought === '' || !['waiting', 'running', 'completed'].includes(phase)
        ? null : facts.thought,
    thoughtKind: facts.thought === '' || !['waiting', 'running', 'completed'].includes(phase)
        ? null : facts.thoughtKind,
    updatedAt: facts.updatedAt,
    error: facts.lastError,
});
/**
 * Most recently active first, then a stable id tiebreak.
 *
 * Deliberately time alone: with the phase collapsed to four values, a
 * state-first sort would push a whole group of results below a single busy row,
 * and the phase is written on every row anyway.
 */
const compareViews = (left, right) => {
    if (left.updatedAt !== right.updatedAt)
        return right.updatedAt - left.updatedAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};
/**
 * Which group a session belongs to, and what that group is called.
 *
 * Membership is **`cwd === workspace.path`** — DSH's own predicate, verbatim
 * (`ui-workspace/lib/client.js:805`), not an invention. It is also why this
 * matches on the *path* rather than the title: a Workspace's `sessionIds` is an
 * ordering account that does not necessarily list every session sitting in its
 * directory, so matching by title produced two identically-named groups for one
 * project. Matching by path puts those sessions back where they belong.
 *
 * A Workspace carrying no title is treated as unnamed rather than shown blank —
 * DSH labels those with a localized default, and this layer does not speak the
 * reader's language, so it answers `null` and lets the window fall back.
 *
 * The directory fallback keys on the whole path, so two different `...\tools`
 * directories stay two groups; only the displayed name is shortened.
 *
 * @param facts - the session's facts.
 * @param byPath - canonical directory to Workspace, built once per snapshot.
 * @returns the group key and its display name, the name being `null` for a
 *   directory group or a session with no directory at all.
 */
const groupOf = (facts, byPath) => {
    const workspace = facts.cwd === null ? undefined : byPath.get(facts.cwd);
    if (workspace !== undefined) {
        return { id: `ws:${workspace.id}`, title: workspace.title === '' ? null : workspace.title };
    }
    if (facts.cwd === null || facts.cwd === '')
        return { id: 'none', title: null };
    return { id: `dir:${facts.cwd}`, title: basename(facts.cwd) };
};
/** Canonical directory to the Workspace that owns it, first claim winning. */
const byPathOf = (workspaces) => {
    const byPath = new Map();
    for (const workspace of workspaces) {
        if (!byPath.has(workspace.path))
            byPath.set(workspace.path, workspace);
    }
    return byPath;
};
/** Newest activity anywhere in a group, including its nested subagents. */
const newestOf = (nodes) => {
    let newest = 0;
    for (const node of nodes) {
        newest = Math.max(newest, node.session.updatedAt);
        for (const child of node.children)
            newest = Math.max(newest, child.session.updatedAt);
    }
    return newest;
};
/**
 * Build the complete payload for the pet window.
 *
 * Two levels of grouping, decided here:
 *
 * - **Workspace**, ordered by newest activity, so the project you were just in
 *   leads.
 * - **Session**, ordered by activity alone: the most recently touched
 *   conversation leads, whatever its phase. The reader asked for time order, and
 *   the phase is written on the row — so nothing has to be inferred from a
 *   position in the list.
 *
 * Subagents hang under the parent that spawned them. There is no orphan case to
 * handle here, and that is a property of the layer below rather than an
 * omission: only a watched conversation and the children of one ever reach the
 * registry, so a subagent whose parent is not being watched was never retained
 * in the first place.
 *
 * @param registry - the current roster.
 * @param options - evaluation instant, settings, the Workspace table, the watched set.
 * @returns a snapshot carrying headline counters and the ordered tree.
 */
export const snapshotOf = (registry, options) => {
    const children = runningChildren(registry.byId);
    const busy = busyChildrenOf(registry.byId);
    const byPath = byPathOf(options.workspaces);
    const groups = new Map();
    const nodeOf = new Map();
    const subagentNodes = [];
    let sessions = 0;
    let running = 0;
    let waiting = 0;
    let subagents = 0;
    for (const facts of registry.byId.values()) {
        // The gate is enforced here as well as at the source, and the duplication is
        // deliberate: the runtime drops unwatched sessions so they cost nothing, and
        // this makes "the pet shows ninety rows again" impossible to reach by any
        // route. A rule that only one layer holds is a rule one bug away from gone.
        if (options.watch === null)
            continue;
        if (!retained(facts.id, facts.parentId, facts.isSubagent, options.watch))
            continue;
        const subagentCount = children.get(facts.id) ?? 0;
        const view = toView(facts, phaseOf(facts, subagentCount), subagentCount, dismissibleRoot(facts, busy.get(facts.id) ?? 0));
        if (facts.isSubagent) {
            if (facts.running)
                subagents += 1;
        }
        else {
            sessions += 1;
            if (facts.running)
                running += 1;
            if (facts.pending !== null)
                waiting += 1;
        }
        const group = groupOf(facts, byPath);
        let bucket = groups.get(group.id);
        if (bucket === undefined) {
            bucket = { title: group.title, nodes: [] };
            groups.set(group.id, bucket);
        }
        const node = { session: view, children: [] };
        nodeOf.set(facts.id, node);
        // Every session is parked in its own group first; subagents are lifted onto
        // their parent in the pass below, once every parent is known.
        bucket.nodes.push(node);
        if (facts.isSubagent)
            subagentNodes.push({ facts, node });
    }
    for (const { facts, node } of subagentNodes) {
        const parentId = facts.parentId;
        if (parentId === null)
            continue;
        const parent = nodeOf.get(parentId);
        if (parent === undefined)
            continue;
        const bucket = groups.get(groupOf(facts, byPath).id);
        if (bucket === undefined)
            continue;
        const index = bucket.nodes.indexOf(node);
        if (index === -1)
            continue;
        bucket.nodes.splice(index, 1);
        parent.children.push(node);
    }
    const ordered = [];
    for (const [id, bucket] of groups) {
        if (bucket.nodes.length === 0)
            continue;
        for (const node of bucket.nodes) {
            node.children.sort((left, right) => compareViews(left.session, right.session));
        }
        bucket.nodes.sort((left, right) => compareViews(left.session, right.session));
        ordered.push({
            id,
            title: bucket.title,
            nodes: bucket.nodes,
            updatedAt: newestOf(bucket.nodes),
        });
    }
    ordered.sort((left, right) => left.updatedAt !== right.updatedAt
        ? right.updatedAt - left.updatedAt
        : left.id < right.id
            ? -1
            : left.id > right.id
                ? 1
                : 0);
    const totals = { sessions, running, waiting, subagents };
    return {
        version: 1,
        revision: options.revision,
        at: options.now,
        settings: options.settings,
        totals,
        groups: ordered,
        watch: options.watch === null ? null : watchList(options.watch),
    };
};
/**
 * A stable key over everything a subscriber would render.
 *
 * Publication is driven by *content*, not by the roster's revision counter,
 * because the derived tree can change without any event arriving — a Workspace
 * rename, a regrouping, or a new entry in the watched set. Comparing this key is
 * what keeps an unchanged payload from re-broadcasting, and including the
 * settings is what makes a configuration edit publish once.
 *
 * The watched set is part of the key even though it is not drawn: it is what the
 * pet writes back to `localStorage`, so a change to it is a change worth sending.
 *
 * @param snapshot - the candidate snapshot.
 * @returns a string that differs only when something renderable differs.
 */
export const contentKey = (snapshot) => JSON.stringify({
    settings: snapshot.settings,
    totals: snapshot.totals,
    groups: snapshot.groups,
    watch: snapshot.watch,
});
//# sourceMappingURL=derive.js.map