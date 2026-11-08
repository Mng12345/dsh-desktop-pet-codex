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

```
plugin_manager  action: install_bundle  target: <path-to>/plugin
```

For the complete experience — plugin plus prebuilt window binary — install the
release tarball instead, and point `install_bundle` at the `.tgz` asset.

## Configuration

The plugin row carries the operational settings: the bridge `port`,
`portAttempts`, `requireToken`, `autoLaunch`, `petExecutable`, `petArgs`,
`sleepAfterMs` and `resyncMs`. Appearance — window size, opacity, font size,
always-on-top — is owned by the pet's own settings window and stored in
`~/.dsh/desktop-pet-codex/settings.json`, so each setting has exactly one owner.

## Licence

MIT. See `LICENSE`.
