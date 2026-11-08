/**
 * The right-click menu, shared by both windows.
 *
 * It is installed in each window rather than in one of them because the pointer
 * that opens it lives in whichever window was clicked, and a menu cannot be
 * drawn across a window boundary. Both copies drive the same two app-level
 * commands, so there is nothing to keep in step beyond the markup itself.
 *
 * There is deliberately no "close" beside "hide": closing the interface *is*
 * hiding it, and the process is meant to outlive the interface — the Host
 * restarts it if it ever dies, and the DSH row's Configure page is where it is
 * asked for again.
 *
 * @module context-menu
 */

import { openSettings, setVisible } from './tauri.js'

/** How the owning window wants to hear about the menu opening and closing. */
export type MenuObserver = {
  /** The menu is on screen, at this box in viewport coordinates. */
  readonly onOpen: (box: DOMRect) => void
  /** The menu is gone. */
  readonly onClose: () => void
}

/**
 * Wire the menu markup in this document.
 *
 * @param observer - told when the menu appears and disappears. The character
 * window needs this: it is click-through everywhere except the figure, so a menu
 * drawn beside her would land in the transparent margin and be unclickable.
 * @throws when the page shell is missing the menu, which is a build mistake
 * rather than a runtime condition.
 */
export const installContextMenu = (observer?: MenuObserver): void => {
  const menu = document.getElementById('menu')
  const menuSettings = document.getElementById('menu-settings')
  const menuHide = document.getElementById('menu-hide')

  if (menu === null || menuSettings === null || menuHide === null) {
    throw new Error('desktop pet: the context menu is incomplete')
  }

  const hideMenu = (): void => {
    if (menu.hidden) return
    menu.hidden = true
    observer?.onClose()
  }

  /** Place the menu at the pointer, kept inside the window. */
  const showMenu = (x: number, y: number): void => {
    menu.hidden = false
    const box = menu.getBoundingClientRect()
    menu.style.left = `${String(Math.max(2, Math.min(x, window.innerWidth - box.width - 2)))}px`
    menu.style.top = `${String(Math.max(2, Math.min(y, window.innerHeight - box.height - 2)))}px`
    observer?.onOpen(menu.getBoundingClientRect())
  }

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    showMenu(event.clientX, event.clientY)
  })

  menuSettings.addEventListener('click', () => {
    hideMenu()
    void openSettings().catch(() => {})
  })

  // Hiding goes through the same command the settings switch uses, so the menu
  // and the setting can never disagree about whether the pet is showing. It is
  // not written down: a hidden pair comes back at the next start, and the DSH
  // row's Configure page can always ask for it sooner.
  menuHide.addEventListener('click', () => {
    hideMenu()
    void setVisible(false).catch(() => {})
  })

  window.addEventListener('pointerdown', (event) => {
    // `event.target` is not a Node when the event was synthesised on the window,
    // and `contains` throws rather than answering false for it.
    const target = event.target
    if (!menu.hidden && (!(target instanceof Node) || !menu.contains(target))) hideMenu()
  })
  window.addEventListener('blur', hideMenu)
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu()
  })
}
