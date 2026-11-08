/** Carry focus requests to DSH, report actual entries, and offer the pet back. */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-pet-codex',
  factory(require) {
    const React = require('react')
    const FOCUS_PATH = '/desktop-pet/focus'
    const FOCUS_EVENTS_PATH = '/desktop-pet/focus/events'
    const CLIENT_STATE_PATH = '/desktop-pet/client-state'
    const PET_PATH = '/desktop-pet/pet'
    const FALLBACK_POLL_MS = 15_000
    const STATE_HEARTBEAT_MS = 30_000
    const PRESENCE_POLL_MS = 5_000
    /**
     * The key this bundle's row registers its Configure page under.
     *
     * A row's configuration slot is keyed by `<package>#<rowId>`, which is the
     * pair the Plugins page builds when it looks for a page to draw.
     */
    const ROW_CONFIG_KEY = 'dsh-desktop-pet-codex#desktop-pet-codex'
    const inject = ['uiWorkspace', 'layout', 'slots']
    const isStore = (value) => value !== null && typeof value === 'object' &&
      typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function'

    const selectionOf = (workspace) => {
      const selection = workspace?.selection
      if (isStore(selection)) {
        return {
          read: () => {
            const value = selection.getSnapshot()
            return typeof value?.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null
          },
          subscribe: (listener) => selection.subscribe(listener),
        }
      }
      const list = workspace?.sessions?.list
      if (!isStore(list)) return null
      return {
        read: () => {
          const byId = list.getSnapshot()?.byId
          if (typeof byId !== 'object' || byId === null) return null
          for (const session of Object.values(byId)) {
            if ((session?.retainedBy?.mainView ?? 0) > 0 && typeof session.id === 'string') return session.id
          }
          return null
        },
        subscribe: (listener) => list.subscribe(listener),
      }
    }

    /**
     * The Host's answer about the pet, kept fresh while a component is mounted.
     *
     * `null` is "not read yet", which is also what a Host of another generation
     * answers — the route is new. Saying "未运行 / 隐藏" then would be a claim
     * the page cannot support, so the facts stay unknown until an answer
     * arrives.
     */
    function usePresence() {
      const [presence, setPresence] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      const read = React.useCallback(async () => {
        try {
          const response = await fetch(PET_PATH, { cache: 'no-store' })
          if (response.ok) setPresence(await response.json())
        } catch {
          // The next poll repeats it; a page that cannot reach the Host should
          // not shout about it.
        }
      }, [])

      React.useEffect(() => {
        void read()
        const timer = setInterval(() => { void read() }, PRESENCE_POLL_MS)
        return () => { clearInterval(timer) }
      }, [read])

      const apply = async (visible) => {
        setBusy(true)
        setFailed(false)
        try {
          const response = await fetch(PET_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ visible }),
          })
          if (!response.ok) throw new Error(String(response.status))
          setPresence(await response.json())
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }

      return {
        presence,
        busy,
        failed,
        known: presence !== null,
        running: presence?.running === true,
        visible: presence?.visible === true,
        apply,
      }
    }

    /**
     * The card this plugin contributes to the Plugins list: the truth, and the
     * switch beside it.
     *
     * Summary only. The page's detail view renders *both* views of a card —
     * `view: 'summary'` under the title and `view: 'page'` below it — so drawing
     * a second control there would show the same switch twice on one screen.
     *
     * The card's own click target is its title button, so a button here is safe:
     * clicking the switch does not open the detail page.
     */
    function PetCard(props) {
      const { busy, known, running, visible, apply } = usePresence()
      if (props?.view === 'page') return null
      return React.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
      },
        React.createElement('span', null,
          known ? `${running ? '运行中' : '未运行'} · ${visible ? '显示' : '隐藏'}` : '读取中…'),
        React.createElement('button', {
          type: 'button',
          disabled: busy || !known,
          onClick: () => { void apply(!visible) },
          style: { padding: '0 8px', fontSize: '12px' },
        }, visible ? '隐藏桌宠' : '显示桌宠'),
      )
    }

    /**
     * The row's own Configure page: the same switch, with both actions named.
     *
     * Page only, for the reason above — and because this is the surface a reader
     * reaches from the row itself, where the two named actions read better than
     * a single toggle.
     *
     * Appearance belongs to the pet's own settings window, and the process is
     * not stoppable from here — disabling the row is what stops it — so this is
     * visibility with the truth beside it, and nothing else.
     */
    function PetPage(props) {
      const { busy, failed, known, running, visible, apply } = usePresence()
      if (props?.view !== 'page') return null
      const fact = (label, value) => React.createElement('span', {
        key: label, style: { marginRight: '12px' },
      }, React.createElement('span', { style: { opacity: 0.7 } }, `${label}：`), value)
      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '8px' },
      },
        React.createElement('div', { style: { fontSize: '12px' } },
          fact('进程', known ? (running ? '运行中' : '未运行') : '读取中…'),
          fact('界面', known ? (visible ? '显示' : '隐藏') : '读取中…'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('button', {
            type: 'button',
            disabled: busy || !known || (running && visible),
            onClick: () => { void apply(true) },
          }, '打开桌宠'),
          React.createElement('button', {
            type: 'button',
            disabled: busy || !known || !visible,
            onClick: () => { void apply(false) },
          }, '关闭桌宠'),
        ),
        failed
          ? React.createElement('div', { style: { fontSize: '12px', opacity: 0.7 } },
              '没有成功。如果这是刚更新的版本，重启 DSH 让 Host 半生效后再试。')
          : null,
      )
    }

    function apply(ctx) {
      const selection = selectionOf(ctx.uiWorkspace)
      const panelInfo = isStore(ctx.layout?.panelInfo) ? ctx.layout.panelInfo : null
      const shownSession = () => panelInfo?.getSnapshot()?.activePanelId === null
        ? selection?.read() ?? null : null
      const clientId = crypto.randomUUID()
      let sequence = 0
      let stopped = false
      // Mounting/reconnecting a page is not a new entry into its current session.
      let observed = shownSession()
      let enteredAt = null
      let pendingFocus = null
      let confirmedFocus = null

      const observe = () => {
        const sessionId = shownSession()
        if (sessionId !== observed) {
          observed = sessionId
          enteredAt = sessionId === null ? null : Date.now()
          confirmedFocus = null
        }
        if (pendingFocus !== null && sessionId === pendingFocus.sessionId) {
          confirmedFocus = pendingFocus
          pendingFocus = null
        }
        return sessionId
      }

      const report = async () => {
        if (stopped) return
        const sessionId = observe()
        const body = {
          clientId, sequence: ++sequence, sessionId,
          visible: document.visibilityState === 'visible', at: Date.now(), enteredAt,
          focusAt: confirmedFocus?.sessionId === sessionId ? confirmedFocus.at : null,
        }
        try {
          await fetch(CLIENT_STATE_PATH, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        } catch {
          // The next report repeats the original entry timestamp, not a new visit.
        }
      }

      const open = async (request) => {
        if (stopped || typeof request?.sessionId !== 'string' || request.sessionId === '' ||
            !Number.isFinite(request.at)) return
        if (confirmedFocus !== null && confirmedFocus.sessionId === request.sessionId &&
            confirmedFocus.at >= request.at) {
          void report()
          return
        }
        pendingFocus = request
        try {
          // openSession also reveals the conversation panel even when its id
          // is already selected behind Settings or another main panel.
          await Promise.resolve(ctx.uiWorkspace.openSession(request.sessionId))
        } catch {
          if (pendingFocus?.sessionId === request.sessionId && pendingFocus.at === request.at) pendingFocus = null
          // Failure cannot confirm a new request, even if its id was selected already.
          return
        }
        // Selection is the proof. The subscribe callback also catches delayed switches.
        void report()
      }

      const collect = async () => {
        if (stopped) return
        try {
          const response = await fetch(FOCUS_PATH, { cache: 'no-store' })
          if (response.ok) void open(await response.json())
        } catch {}
      }

      const stream = new EventSource(FOCUS_EVENTS_PATH)
      stream.addEventListener('focus', (event) => {
        try { void open(JSON.parse(event.data)) } catch {}
      })
      stream.addEventListener('state-request', () => { void report() })
      // Avoid treating list-store updates to the current conversation as a visit.
      const onViewChange = () => {
        const shown = shownSession()
        if (shown !== observed || pendingFocus?.sessionId === shown) void report()
      }
      const unsubscribe = selection?.subscribe(onViewChange)
      const unsubscribePanel = panelInfo?.subscribe(onViewChange)
      const onVisibility = () => {
        void report()
        void collect()
      }
      document.addEventListener('visibilitychange', onVisibility)
      const poll = setInterval(() => { void collect() }, FALLBACK_POLL_MS)
      const heartbeat = setInterval(() => { void report() }, STATE_HEARTBEAT_MS)
      // Two surfaces, one switch: a card of this plugin's own in the Plugins
      // list — where a reader looks first, and one click from Settings — and the
      // row's Configure page, which is where a row's configuration is expected
      // to live. `slots.inject` waits for the page to declare either slot
      // instead of assuming an order between plugins.
      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'dsh-desktop-pet',
        // The Plugins page lists `plugins.item` cards in its **Official** group —
        // it renders the official bundles and these cards from one array — so the
        // title says which side of that line this one is on.
        label: () => '桌面宠物（第三方）',
        order: 40,
      }, PetCard))
      // The row's own Configure page. A different component, because that page
      // renders a card's summary and page views together and one switch is
      // enough: `PetCard` answers the summary, `PetPage` the page.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
      }, PetPage))
      ctx.effect(() => {
        void report()
        void collect()
        return () => {
          stopped = true
          stream.close()
          clearInterval(poll)
          clearInterval(heartbeat)
          document.removeEventListener('visibilitychange', onVisibility)
          unsubscribe?.()
          unsubscribePanel?.()
        }
      }, 'desktop-pet: session focus')
    }
    return { inject, apply }
  },
})
