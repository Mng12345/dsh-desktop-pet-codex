# dsh-desktop-pet-codex

A desktop pet for DeepSeek Harness. This package is the plugin half: it reads the
Harness over its host services, keeps a curated list of the conversations you
watch, and publishes a roster on a loopback bridge. The window half is a small
Tauri application that reads that bridge and draws the pet plus a status panel.

## What it shows

- The conversations you chose to watch, with their live state: running, waiting
  for input, or finished.
- Subagents as children of a watched parent; a subagent is never a row of its
  own.
- Each row's result when a turn ends, so you can see what finished without
  opening DSH.

## Requirements

- DeepSeek Harness `>= 0.2.0-rc.2`, Node `>= 22`.
- The pet window executable, which is a per-platform build product. It is not in
  the source tree; it ships in the GitHub Release tarball under `bin/`. Without
  it the plugin still loads and serves the bridge, it just cannot open a window.

## Install

Ask for the package by name — in the Web sidebar **Plugins → Add plugin**, or through the plugin manager:

```
plugin_manager  action: install_bundle  target: dsh-desktop-pet-codex
```

The tarball carries the compiled plugin and the window binary for every platform, so installing it runs no
install scripts, needs no build step, and downloads nothing at start-up. A source checkout has no window
binary; install this package or the GitHub Release tarball for the complete experience.

## Configuration

The plugin row carries the operational settings: the bridge `port`,
`portAttempts`, `requireToken`, `autoLaunch`, `petExecutable`, `petArgs`,
`sleepAfterMs` and `resyncMs`. Appearance — window size, opacity, font size,
always-on-top — is owned by the pet's own settings window and stored in
`~/.dsh/desktop-pet-codex/settings.json`, so each setting has exactly one owner.

## Licence

MIT. See `LICENSE`.
