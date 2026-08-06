# 110 — Don't chdir the process; pin child cwd to DEV3_HOME instead

## Context

PR #834 (commit `64fefde6`) added `process.chdir(DEV3_HOME)` at startup in
`src/bun/index.ts` to survive a brew upgrade / in-app update deleting the `.app`
bundle dir from under a running instance (any spawn without an explicit `cwd`
would then ENOENT, since `posix_spawn` resolves the child cwd from ours). This
blanked the **desktop** window: a large grey screen, console spamming
`Resource not found` and `window.__electrobun.receiveMessageFromBun is undefined`.
The browser/remote mode was unaffected.

## Investigation

`git bisect` between a known-good 07-05 commit and `origin/main` landed squarely
on `64fefde6`. Its only runtime change is the `chdir`. electrobun resolves its
native wrapper via `join(process.cwd(), "libNativeWrapper.dylib")`
(`node_modules/electrobun/dist/api/bun/proc/native.ts:86`) and resolves the
`views://` custom protocol (which loads the renderer `index.html` + `/assets/*`)
relative to `process.cwd()` as well. The dlopen runs at module import (before the
chdir), so it survived — but the `views://` load happens later, at window
creation, after the chdir. With cwd moved to `~/.dev3.0`, electrobun could no
longer find `views/mainview/index.html` → renderer never loads → the injected
bridge never initializes.

## Decision

Never `process.chdir()` away from the bundle. Removed the chdir block from
`src/bun/index.ts`. The ENOENT hazard it targeted is handled where it belongs:
`src/bun/spawn.ts` now defaults every cwd-less child to `DEV3_HOME`
(`withDefaults()`), so children never inherit the vanishing bundle cwd while the
process itself stays put. All app spawns go through `spawn.ts`; the CLI does not
import it, so CLI git-in-user-cwd behavior is untouched.

## Risks

A child that genuinely relied on inheriting the bundle cwd would now get
DEV3_HOME — but none do (they either pass an explicit `cwd` or use absolute
paths). If electrobun itself lazily spawns a child without cwd after the bundle
is deleted, that path is outside our wrappers and unaffected by this change.

## Alternatives considered

- **Keep the chdir, pass an absolute `viewsRoot` captured pre-chdir.** Fixes
  `views://` only; leaves the process cwd off-bundle so any other cwd-relative
  electrobun resolution (new webviews, tray, native modules) stays fragile.
- **Delay the chdir until after the window's DOM is ready.** Timing-fragile:
  early spawns (existing tmux sessions) and any later-created webview would still
  break.
- **Revert #834 entirely.** Loses the brew-upgrade resilience; more than needed.
