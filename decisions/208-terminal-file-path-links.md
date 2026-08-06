# 208 — Terminal file-path links: regex + on-disk verification, Cmd/Ctrl+Click only

## Context

Agents constantly print file paths ("Draft is ready at kb-playbook-drafts/waf.md") with no way to open them. ghostty-web already linkifies URLs via its `ILinkProvider` system; file paths need custom detection, relative-path resolution, and an open action that fits both desktop and browser/remote mode.

## Investigation

Two ghostty-web 0.4.0 realities shaped the implementation (both verified in the shipped bundle, not the typings): `term.onRender` never fires (`renderEmitter` has no `.fire()` call), and `translateToString()` skips codepoint-0 cells, so its string indexes do not equal screen columns. Also, `LinkDetector.scanRow` marks a row scanned *before* awaiting providers, so an async provider answer loses the first hover/click on a fresh path; and tmux mouse mode swallows only `mousedown` — link activation rides the separate bubble-phase `click`, with the modifier policy left to each provider's `activate()`.

## Decision

`src/mainview/terminal-file-links.ts`: a permissive regex over the stitched logical line (own cell-exact `lineToText`, one UTF-16 unit per cell — blank/control/astral cells become spaces) finds candidates (absolute/`~`/relative, `:line:col` suffixes, bare filenames with extensions). Lookups answer synchronously from a resolve cache; unknown candidates go to one batched background `resolveTerminalPaths` RPC (`src/bun/rpc-handlers/terminal-paths.ts`) that stats each against the task worktree then the project dir — only existing paths become links, which is what filters regex false positives ("e.g", "types.But"). The underline overlay (`terminal-link-underlines.ts`) repaints from TerminalView's write batch (the real "content changed" signal, since `onRender` is dead), draws synchronously from the same cache, and coalesces every trigger into one clear-and-stroke pass on the next animation frame (a debounce starved under streaming output — see decision 212). Activation requires Cmd/Ctrl so plain clicks keep reaching tmux apps. Open behavior is `GlobalSettings.terminalPathOpenMode` (preview modal / OS default / reveal); browser mode always previews in-app because host-side `Utils.openPath` is invisible remotely. All three handlers take client-supplied paths, so every path they touch is gated to the home directory + registered project roots — the same exposure class as `listDirectory` behind the same auth, but bounded. Resolution is gated as well, so an out-of-scope path never becomes a link that then refuses to open, and `..` segments cannot walk a relative candidate out of its base.

## Risks

A stale-while-revalidate cache (10s TTL) can briefly linkify a deleted file or miss a just-created one until the next resolve lands. The path-scope gate does not resolve symlinks, so a symlink under $HOME can point outside it — accepted, matching `listDirectory`'s exposure.

## Alternatives considered

Linkify optimistically and verify at click time (rejected: underlines dead tokens, trains users to distrust links); OSC 8 injection by rewriting the output stream (rejected: mutating the PTY stream is invasive, see decision 066's complexity); per-row RPCs at redraw (rejected for an RPC storm — the viewport batches into one call); `translateToString` for row text (rejected: unpadded, index ≠ column — the bug class that sank earlier attempts at this feature).
